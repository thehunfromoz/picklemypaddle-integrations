/**
 * The email outbox (SCRUM-69 AC2 and AC7).
 *
 * Emails are queued in the same database transaction as the change that causes them, and a
 * background worker sends them, retrying with backoff. So a Resend outage never fails an order
 * or a status change, and a send that keeps failing is left as `failed` for the admin page.
 *
 * Nothing secret is queued. Each email is rendered from the order as it is when the email goes
 * out, and an email that carries a status link mints a fresh token for that send (only its hash
 * is stored); if the send fails, that token is deleted again.
 *
 * Outside production, mail reaches only EMAIL_ALLOWLIST; anything else is recorded as
 * `suppressed` and never sent. Smoke-test orders queue nothing at all.
 */
import type { TaxTreatment } from '../pricing/terms.js';
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { log, logError } from '../log.js';
import { hashToken, newStatusToken } from '../orders/model.js';
import type { LinksMailer } from '../orders/status.js';
import { ALERT_TO, CLUB_REPLY_TO, SendError, type EmailSender } from './sender.js';
import type { DocumentSnapshot } from '../documents/documents.js';
import { render, type TemplateContext, type TemplateName } from './templates.js';
import type { DiscountKind } from '../orders/rules.js';

export interface MailSettings {
  isProduction: boolean;
  /** Outside production, the only recipients allowed (lower-case). Ignored in production. */
  allowList: readonly string[];
  /** The site, e.g. https://www.picklemypaddle.com (status links and footer). */
  siteUrl: string;
  /** Tailnet admin base address, e.g. https://pmp-prod.tail8bc7ae.ts.net; null until SCRUM-71. */
  adminUrl: string | null;
}

/** Templates that carry the order's private status link. */
const NEEDS_STATUS_LINK: ReadonlySet<TemplateName> = new Set([
  'customer_submitted', 'accepted', 'in_queue', 'posted_back', 'review_reminder', 'payment_reminder', 'payment_received', 'refund_issued',
]);

/**
 * SCRUM-84: templates that link a document. The link opens the printable page with the same
 * fresh status token, so it works as long as the order's status links do (and "Email me my links"
 * renews it). The payload names the document; In queue links the order's latest receipt.
 */
const NEEDS_DOCUMENT: ReadonlySet<TemplateName> = new Set(['payment_received', 'refund_issued', 'in_queue']);

/** Minutes to wait after each failed attempt; after the last one the email is marked failed. */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720] as const;
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A claimed email that isn't settled within this long (a crash mid-send) is tried again. */
const LEASE_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Extra facts a template needs that aren't columns on the order. */
export interface EmailPayload {
  /** Accepted (SCRUM-81): the frozen total and how it was made up. */
  amountCents?: number;
  subtotalCents?: number;
  /** SCRUM-63: the discount off the re-grit, and the code that gave it. */
  discountCents?: number;
  discountCode?: string;
  postageCents?: number;
  gstCents?: number;
  taxTreatment?: TaxTreatment;
  backInPostBy?: string;
  reason?: string;
  /** Payment reminder (SCRUM-83): the Sydney day the order lapses. */
  lapsesOn?: string;
  /** Payment alert (SCRUM-83): what wasn't right with a payment. */
  problem?: string;
  /** Payment alert for a club batch: a card payment was refunded in Stripe. */
  refund?: boolean;
  /** Review alert: whether the customer allowed quoting (SCRUM-33). */
  permission?: boolean;
  /** SCRUM-84: the receipt or credit note the email links (documents.id). */
  documentId?: string;
  /** Refund issued (SCRUM-84): the amount of this refund, and whether the payment is now refunded in full. */
  refundCents?: number;
  refundFull?: boolean;
  /** Club enquiry alert (SCRUM-93): the club was already on file. */
  duplicate?: boolean;
}

// ── Allow-list ────────────────────────────────────────────────────────────────

/** `me+anything@x` matches `me@x`; everything compared lower-case. */
const canonical = (address: string): string => {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at < 0) return a;
  return a.slice(0, at).replace(/\+.*$/, '') + a.slice(at);
};

export function isAllowed(recipient: string, settings: Pick<MailSettings, 'isProduction' | 'allowList'>): boolean {
  if (settings.isProduction) return true;
  const c = canonical(recipient);
  return settings.allowList.some((a) => canonical(a) === c);
}

// ── Queueing ──────────────────────────────────────────────────────────────────

/**
 * Queues one of an order's emails inside the caller's transaction. The customer's templates go
 * to the order's email address; the alert goes to sales@.
 */
export async function enqueueOrderEmail(
  q: Queryable,
  orderId: string,
  template: TemplateName,
  now: Date,
  payload: EmailPayload = {},
): Promise<void> {
  // Every parameter is typed: Postgres can't infer types in a SELECT list.
  await q.query(
    `INSERT INTO outbox (kind, order_id, template, recipient, payload, next_attempt_at, created_at, updated_at)
     SELECT 'email', o.id, $2::text, CASE WHEN $2::text IN ('alert_submitted', 'alert_review', 'alert_payment') THEN $4::text ELSE o.email END,
            $3::jsonb, $5::timestamptz, $5::timestamptz, $5::timestamptz
       FROM orders o WHERE o.id = $1::uuid`,
    [orderId, template, JSON.stringify(payload), ALERT_TO, now],
  );
}

/**
 * SCRUM-85: queues a club batch's email inside the caller's transaction, to the club's billing
 * contact. Rendered from the batch, the club and its document when it is sent.
 */
export async function enqueueBatchEmail(
  q: Queryable,
  batchId: string,
  template: TemplateName,
  now: Date,
  payload: EmailPayload = {},
): Promise<void> {
  await q.query(
    `INSERT INTO outbox (kind, batch_id, template, recipient, payload, next_attempt_at, created_at, updated_at)
     SELECT 'email', b.id, $2::text, CASE WHEN $2::text = 'alert_payment' THEN $5::text ELSE c.billing_email END,
            $3::jsonb, $4::timestamptz, $4::timestamptz, $4::timestamptz
       FROM batches b JOIN clubs c ON c.id = b.club_id WHERE b.id = $1::uuid`,
    [batchId, template, JSON.stringify(payload), now, ALERT_TO],
  );
}

/**
 * SCRUM-93: queues an email about a club itself (not one of its batches): the acknowledgement to
 * the contact who wrote to us, or Attila's alert. A club's emails go to its contact (a lead's) or
 * its billing contact.
 */
export async function enqueueClubEmail(
  q: Queryable,
  clubId: string,
  template: TemplateName,
  now: Date,
  payload: EmailPayload = {},
): Promise<void> {
  await q.query(
    `INSERT INTO outbox (kind, club_id, template, recipient, payload, next_attempt_at, created_at, updated_at)
     SELECT 'email', c.id, $2::text, CASE WHEN left($2::text, 6) = 'alert_' THEN $5::text ELSE COALESCE(c.contact_email, c.billing_email) END,
            $3::jsonb, $4::timestamptz, $4::timestamptz, $4::timestamptz
       FROM clubs c WHERE c.id = $1::uuid`,
    [clubId, template, JSON.stringify(payload), now, ALERT_TO],
  );
}

// ── Sending ───────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  order_id: string | null;
  batch_id: string | null;
  club_id: string | null;
  template: TemplateName;
  recipient: string | null;
  payload: EmailPayload | string;
  attempts: number;
}

interface OrderFacts {
  id: string;
  reference: string;
  name: string;
  tracking_number: string | null;
  /** YYYY-MM-DD, read as text so no driver turns the calendar date into a moment in time. */
  arrived_on: string | null;
  /** SCRUM-63: the code on the order and what it gives, saved at submit. */
  discount_code: string | null;
  discount_kind: DiscountKind | null;
  discount_value: number | null;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name.trim();

export interface OutboxDeps {
  db: Db;
  sender: EmailSender | null;
  settings: MailSettings;
  now: () => Date;
}

export interface OutboxRun {
  sent: number;
  retrying: number;
  failed: number;
  suppressed: number;
}

/** Sends every email that is due. Safe to run from several containers at once. */
export async function processOutbox(deps: OutboxDeps, batch = 20): Promise<OutboxRun> {
  const run: OutboxRun = { sent: 0, retrying: 0, failed: 0, suppressed: 0 };
  const now = deps.now();
  const { rows } = await deps.db.query<OutboxRow>(
    `UPDATE outbox SET state = 'sending', attempts = attempts + 1, next_attempt_at = $2, updated_at = $1
      WHERE id IN (SELECT id FROM outbox
                    WHERE kind = 'email' AND state IN ('pending', 'sending') AND next_attempt_at <= $1
                    ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id, order_id, batch_id, club_id, template, recipient, payload, attempts`,
    [now, new Date(now.getTime() + LEASE_MS), batch],
  );
  for (const row of rows) {
    const outcome = await sendOne(deps, row, now).catch((err) => {
      logError('outbox_row_failed', err, { outbox: Number(row.id), template: row.template });
      return 'retrying' as const;
    });
    run[outcome]++;
  }
  return run;
}

async function settle(db: Db, id: string, fields: { state: string; error?: string | null; providerId?: string | null; nextAt?: Date }, now: Date) {
  await db.query(
    `UPDATE outbox SET state = $2::text, last_error = $3::text, provider_id = COALESCE($4::text, provider_id), updated_at = $5::timestamptz,
            next_attempt_at = COALESCE($6::timestamptz, next_attempt_at),
            done_at = CASE WHEN $2::text IN ('sent', 'failed', 'suppressed') THEN $5::timestamptz ELSE NULL END
      WHERE id = $1`,
    [id, fields.state, fields.error ?? null, fields.providerId ?? null, now, fields.nextAt ?? null],
  );
}

async function sendOne(deps: OutboxDeps, row: OutboxRow, now: Date): Promise<keyof OutboxRun> {
  const { db, settings } = deps;
  const ref = { outbox: Number(row.id), template: row.template };

  if (!row.recipient || !isAllowed(row.recipient, settings)) {
    await settle(db, row.id, { state: 'suppressed', error: 'not_allow_listed' }, now);
    log('email_suppressed', { ...ref, reason: 'not_allow_listed' });
    return 'suppressed';
  }
  if (!deps.sender) {
    // Development without a Resend key: nothing leaves the machine.
    await settle(db, row.id, { state: 'suppressed', error: 'no_provider' }, now);
    log('email_suppressed', { ...ref, reason: 'no_provider' });
    return 'suppressed';
  }

  if (row.batch_id) return sendBatchEmail(deps, row, now);
  if (row.club_id) return sendClubEmail(deps, row, now);

  const { rows: orders } = await db.query<OrderFacts>(
    `SELECT id, reference, name, tracking_number, arrived_on::text AS arrived_on, discount_code, discount_kind, discount_value
       FROM orders WHERE id = $1`,
    [row.order_id],
  );
  const order = orders[0];
  if (!order) {
    await settle(db, row.id, { state: 'failed', error: 'order_missing' }, now);
    return 'failed';
  }
  const { rows: paddles } = await db.query<{ brand: string; model: string | null }>(
    'SELECT brand, model FROM paddles WHERE order_id = $1 ORDER BY position',
    [order.id],
  );
  const payload: EmailPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  // `permission` is bookkeeping for the review alert; the template reads it from the review itself.
  const { permission: _permission, documentId: _documentId, ...extras } = payload;

  let tokenId: string | null = null;
  let statusUrl: string | undefined;
  let reviewUrl: string | undefined;
  let document: TemplateContext['document'];
  if (NEEDS_STATUS_LINK.has(row.template)) {
    const token = newStatusToken();
    const { rows: t } = await db.query<{ id: string }>(
      'INSERT INTO status_tokens (order_id, token_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
      [order.id, hashToken(token), now],
    );
    tokenId = String(t[0]!.id);
    statusUrl = `${settings.siteUrl}/order/status#${token}`;
    reviewUrl = `${settings.siteUrl}/order/status?review=1#${token}`;
    if (NEEDS_DOCUMENT.has(row.template)) {
      const { rows: docs } = await db.query<{ number: string }>(
        payload.documentId
          ? 'SELECT number FROM documents WHERE id = $2 AND order_id = $1'
          : `SELECT number FROM documents WHERE order_id = $1 AND kind = 'receipt' ORDER BY issued_at DESC, id DESC LIMIT 1`,
        payload.documentId ? [order.id, payload.documentId] : [order.id],
      );
      if (docs[0]) document = { number: docs[0].number, url: `${settings.siteUrl}/order/document?n=${docs[0].number}#${token}` };
    }
  }
  let review: TemplateContext['review'];
  if (row.template === 'alert_review') {
    const { rows: rv } = await db.query<{ quote: string; first_name: string; suburb: string; permission: boolean }>(
      'SELECT quote, first_name, suburb, permission FROM reviews WHERE order_id = $1',
      [order.id],
    );
    if (rv[0]) review = { quote: rv[0].quote, firstName: rv[0].first_name, suburb: rv[0].suburb, permission: rv[0].permission };
  }

  const ctx: TemplateContext = {
    test: !settings.isProduction,
    siteUrl: settings.siteUrl,
    reference: order.reference,
    firstName: firstName(order.name),
    paddles,
    statusUrl,
    reviewUrl,
    review,
    document,
    adminUrl: settings.adminUrl ? `${settings.adminUrl}/admin/orders/${order.reference}` : null,
    trackingNumber: order.tracking_number ?? undefined,
    arrivedOn: order.arrived_on ?? undefined,
    ...(order.discount_code && order.discount_kind && order.discount_value !== null
      ? { discountOffer: { code: order.discount_code, kind: order.discount_kind, value: Number(order.discount_value) } }
      : {}),
    ...extras,
  };

  try {
    const email = render(row.template, ctx);
    const { id } = await deps.sender.send({ to: row.recipient, ...email, idempotencyKey: `pmp-outbox-${row.id}` });
    await settle(db, row.id, { state: 'sent', providerId: id }, now);
    log('email_sent', { ...ref, reference: order.reference, attempt: row.attempts });
    return 'sent';
  } catch (err) {
    if (tokenId) await db.query('DELETE FROM status_tokens WHERE id = $1', [tokenId]).catch(() => undefined);
    const code = err instanceof SendError ? err.code : `render:${(err as Error)?.name ?? 'error'}`;
    // A template that can't render won't render next time either.
    const permanent = err instanceof SendError ? err.permanent : true;
    if (permanent || row.attempts >= MAX_ATTEMPTS) {
      await settle(db, row.id, { state: 'failed', error: code }, now);
      logError('email_failed', err, { ...ref, reference: order.reference, code, attempt: row.attempts });
      return 'failed';
    }
    const wait: number = BACKOFF_MINUTES[row.attempts - 1] ?? 720;
    await settle(db, row.id, { state: 'pending', error: code, nextAt: new Date(now.getTime() + wait * MINUTE) }, now);
    log('email_retrying', { ...ref, reference: order.reference, code, attempt: row.attempts, inMinutes: wait });
    return 'retrying';
  }
}

/** The private link to a club document: a fresh token per send, only its hash kept. */
export const clubDocumentUrl = (siteUrl: string, number: string, token: string) => `${siteUrl}/club/invoice?n=${number}#${token}`;

async function sendBatchEmail(deps: OutboxDeps, row: OutboxRow, now: Date): Promise<keyof OutboxRun> {
  const { db, settings } = deps;
  const ref = { outbox: Number(row.id), template: row.template };
  const { rows: batches } = await db.query<{ reference: string; name: string; billing_name: string }>(
    'SELECT b.reference, c.name, c.billing_name FROM batches b JOIN clubs c ON c.id = b.club_id WHERE b.id = $1',
    [row.batch_id],
  );
  const batch = batches[0];
  if (!batch) {
    await settle(db, row.id, { state: 'failed', error: 'batch_missing' }, now);
    return 'failed';
  }
  const payload: EmailPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  let tokenId: string | null = null;
  let invoice: TemplateContext['invoice'];
  if (payload.documentId) {
    const { rows: docs } = await db.query<{ id: string; number: string; snapshot: string }>(
      'SELECT id, number, snapshot FROM documents WHERE id = $1 AND batch_id = $2',
      [payload.documentId, row.batch_id],
    );
    const doc = docs[0];
    if (!doc) {
      await settle(db, row.id, { state: 'failed', error: 'document_missing' }, now);
      return 'failed';
    }
    const token = newStatusToken();
    const { rows: t } = await db.query<{ id: string }>(
      'INSERT INTO document_tokens (document_id, token_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
      [doc.id, hashToken(token), now],
    );
    tokenId = String(t[0]!.id);
    const snap = JSON.parse(doc.snapshot) as DocumentSnapshot;
    invoice = {
      number: doc.number,
      url: clubDocumentUrl(settings.siteUrl, doc.number, token),
      paddles: snap.lines[0]?.quantity ?? 0,
      subtotalCents: snap.subtotalCents,
      gstCents: snap.gstCents,
      totalCents: snap.totalCents,
      dueOn: snap.dueOn ?? snap.issuedOn,
      treatment: snap.treatment,
      payId: snap.payId ?? '',
      payByCard: snap.payByCard === true,
    };
  }
  const ctx: TemplateContext = {
    test: !settings.isProduction,
    siteUrl: settings.siteUrl,
    reference: batch.reference,
    firstName: firstName(batch.billing_name),
    club: { name: batch.name },
    invoice,
    problem: payload.problem,
    refund: payload.refund,
    adminUrl: settings.adminUrl ? `${settings.adminUrl}/admin/batches/${batch.reference}` : null,
  };
  try {
    const email = render(row.template, ctx);
    const { id } = await deps.sender!.send({ to: row.recipient!, ...email, replyTo: CLUB_REPLY_TO, idempotencyKey: `pmp-outbox-${row.id}` });
    await settle(db, row.id, { state: 'sent', providerId: id }, now);
    log('email_sent', { ...ref, reference: batch.reference, attempt: row.attempts });
    return 'sent';
  } catch (err) {
    const code = err instanceof SendError ? err.code : `render:${(err as Error)?.name ?? 'error'}`;
    const permanent = err instanceof SendError ? err.permanent : true;
    // Delete the link's token only when the email certainly didn't go (a render error or a refusal).
    // A temporary failure (a timeout, say) may still have been delivered, and the retry reuses the
    // idempotency key, so the provider drops it: that delivered email's link must keep working.
    if (tokenId && permanent) await db.query('DELETE FROM document_tokens WHERE id = $1', [tokenId]).catch(() => undefined);
    if (permanent || row.attempts >= MAX_ATTEMPTS) {
      await settle(db, row.id, { state: 'failed', error: code }, now);
      logError('email_failed', err, { ...ref, reference: batch.reference, code, attempt: row.attempts });
      return 'failed';
    }
    const wait: number = BACKOFF_MINUTES[row.attempts - 1] ?? 720;
    await settle(db, row.id, { state: 'pending', error: code, nextAt: new Date(now.getTime() + wait * MINUTE) }, now);
    log('email_retrying', { ...ref, reference: batch.reference, code, attempt: row.attempts, inMinutes: wait });
    return 'retrying';
  }
}

/** An email about a club itself: an enquiry's acknowledgement and alert (SCRUM-93). */
async function sendClubEmail(deps: OutboxDeps, row: OutboxRow, now: Date): Promise<keyof OutboxRun> {
  const { db, settings } = deps;
  const ref = { outbox: Number(row.id), template: row.template };
  const { rows: clubs } = await db.query<{ name: string; contact_name: string | null; billing_name: string | null }>(
    'SELECT name, contact_name, billing_name FROM clubs WHERE id = $1',
    [row.club_id],
  );
  const club = clubs[0];
  if (!club) {
    await settle(db, row.id, { state: 'failed', error: 'club_missing' }, now);
    return 'failed';
  }
  const payload: EmailPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const ctx: TemplateContext = {
    test: !settings.isProduction,
    siteUrl: settings.siteUrl,
    firstName: firstName(club.contact_name ?? club.billing_name ?? club.name),
    club: { name: club.name },
    enquiry: true,
    duplicate: payload.duplicate,
    adminUrl: settings.adminUrl ? `${settings.adminUrl}/admin/clubs/${row.club_id}` : null,
  };
  try {
    const email = render(row.template, ctx);
    const { id } = await deps.sender!.send({ to: row.recipient!, ...email, replyTo: CLUB_REPLY_TO, idempotencyKey: `pmp-outbox-${row.id}` });
    await settle(db, row.id, { state: 'sent', providerId: id }, now);
    log('email_sent', { ...ref, attempt: row.attempts });
    return 'sent';
  } catch (err) {
    const code = err instanceof SendError ? err.code : `render:${(err as Error)?.name ?? 'error'}`;
    const permanent = err instanceof SendError ? err.permanent : true;
    if (permanent || row.attempts >= MAX_ATTEMPTS) {
      await settle(db, row.id, { state: 'failed', error: code }, now);
      logError('email_failed', err, { ...ref, code, attempt: row.attempts });
      return 'failed';
    }
    const wait: number = BACKOFF_MINUTES[row.attempts - 1] ?? 720;
    await settle(db, row.id, { state: 'pending', error: code, nextAt: new Date(now.getTime() + wait * MINUTE) }, now);
    log('email_retrying', { ...ref, code, attempt: row.attempts, inMinutes: wait });
    return 'retrying';
  }
}

/**
 * Puts a failed email back in the queue (the admin page's retry button, SCRUM-72). Returns
 * false if the row isn't a failed email.
 */
export async function retryEmail(db: Db, outboxId: string, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = $2, last_error = NULL, done_at = NULL, updated_at = $2
      WHERE id = $1 AND kind = 'email' AND state = 'failed' RETURNING id`,
    [outboxId, now],
  );
  return rows.length === 1;
}

// ── "Email me my links" ───────────────────────────────────────────────────────

/**
 * Sends the links email at once rather than through the queue: `requestLinks` revokes the old
 * links only after this reports the new ones were delivered. The row records only the outcome
 * (no recipient, no links), because it isn't tied to a single order.
 */
export function linksMailer(deps: OutboxDeps): LinksMailer {
  return {
    async sendLinks(to, links) {
      const now = deps.now();
      const record = (state: string, error: string | null) =>
        deps.db.query(
          `INSERT INTO outbox (kind, template, state, attempts, last_error, created_at, updated_at, done_at)
           VALUES ('email', 'links', $1, 1, $2, $3, $3, $3)`,
          [state, error, now],
        );
      if (!isAllowed(to, deps.settings) || !deps.sender) {
        const reason = deps.sender ? 'not_allow_listed' : 'no_provider';
        await record('suppressed', reason);
        log('email_suppressed', { template: 'links', reason });
        return false;
      }
      const email = render('links', {
        test: !deps.settings.isProduction,
        siteUrl: deps.settings.siteUrl,
        links: links.map((l) => ({ reference: l.reference, url: `${deps.settings.siteUrl}/order/status#${l.token}` })),
      });
      try {
        await deps.sender.send({ to, ...email, idempotencyKey: `pmp-links-${randomUUID()}` });
      } catch (err) {
        await record('failed', err instanceof SendError ? err.code : 'error');
        throw err;
      }
      await record('sent', null);
      log('email_sent', { template: 'links', orders: links.length });
      return true;
    },
  };
}
