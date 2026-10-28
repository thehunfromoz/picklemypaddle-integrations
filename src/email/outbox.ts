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
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { log, logError } from '../log.js';
import { hashToken, newStatusToken } from '../orders/model.js';
import type { LinksMailer } from '../orders/status.js';
import { ALERT_TO, SendError, type EmailSender } from './sender.js';
import { render, type TemplateContext, type TemplateName } from './templates.js';

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
const NEEDS_STATUS_LINK: ReadonlySet<TemplateName> = new Set(['customer_submitted', 'accepted', 'in_queue', 'posted_back']);

/** Minutes to wait after each failed attempt; after the last one the email is marked failed. */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720] as const;
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A claimed email that isn't settled within this long (a crash mid-send) is tried again. */
const LEASE_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Extra facts a template needs that aren't columns on the order. */
export interface EmailPayload {
  amountCents?: number;
  paymentUrl?: string;
  backInPostBy?: string;
  reason?: string;
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
     SELECT 'email', o.id, $2::text, CASE WHEN $2::text = 'alert_submitted' THEN $4::text ELSE o.email END,
            $3::jsonb, $5::timestamptz, $5::timestamptz, $5::timestamptz
       FROM orders o WHERE o.id = $1::uuid`,
    [orderId, template, JSON.stringify(payload), ALERT_TO, now],
  );
}

// ── Sending ───────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  order_id: string | null;
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
      RETURNING id, order_id, template, recipient, payload, attempts`,
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

  const { rows: orders } = await db.query<OrderFacts>(
    'SELECT id, reference, name, tracking_number, arrived_on::text AS arrived_on FROM orders WHERE id = $1',
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

  let tokenId: string | null = null;
  let statusUrl: string | undefined;
  if (NEEDS_STATUS_LINK.has(row.template)) {
    const token = newStatusToken();
    const { rows: t } = await db.query<{ id: string }>(
      'INSERT INTO status_tokens (order_id, token_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
      [order.id, hashToken(token), now],
    );
    tokenId = String(t[0]!.id);
    statusUrl = `${settings.siteUrl}/order/status#${token}`;
  }

  const ctx: TemplateContext = {
    test: !settings.isProduction,
    siteUrl: settings.siteUrl,
    reference: order.reference,
    firstName: firstName(order.name),
    paddles,
    statusUrl,
    adminUrl: settings.adminUrl ? `${settings.adminUrl}/admin/orders/${order.reference}` : null,
    trackingNumber: order.tracking_number ?? undefined,
    arrivedOn: order.arrived_on ?? undefined,
    ...payload,
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
