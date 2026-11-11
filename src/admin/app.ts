/**
 * The order admin (SCRUM-71 and SCRUM-72), served ONLY on the admin listener (ADMIN_PORT).
 * The public app (src/app.ts) has no admin routes at all, so /admin through the public gateway
 * is a 404 whatever headers it carries.
 *
 *   GET  /admin                              → /admin/orders
 *   GET  /admin/orders?status=…              the list (default: waiting on Attila)
 *   GET  /admin/orders/:ref                  one order
 *   POST /admin/orders/:ref/status           move it (to, reason, trackingNumber, arrivedOn, amount, note)
 *   POST /admin/orders/:ref/reinstate        Lapsed/Withdrawn with a late payment → Paid, with a note (SCRUM-83)
 *   POST /admin/orders/:ref/review-reminder-test  staging only: the one review reminder now (404 in production)
 *   POST /admin/orders/:ref/notes            an internal note
 *   POST /admin/outbox/:id/retry             put a failed email or HubSpot sync back in the queue
 *   POST /admin/orders/:ref/retention        extend (until, reason) or clear an order's retention (SCRUM-75)
 *   GET  /admin/retention                    due for deletion soon, extensions, runs, erasures (SCRUM-75)
 *   GET  /admin/erase · POST /admin/erase/preview · POST /admin/erase/confirm   erasure on request (SCRUM-75)
 *   GET  /admin/codes · POST /admin/codes       discount codes: list, create or generate (SCRUM-63)
 *   GET  /admin/codes/:id · POST /admin/codes/:id/active · POST /admin/codes/:id/note   one code: uses, (de)activate, note
 *   GET  /admin/clubs · POST /admin/clubs      clubs: list, add (SCRUM-85)
 *   GET  /admin/clubs/:id · POST /admin/clubs/:id · POST /admin/clubs/:id/active   one club: batches, edit, (de)activate
 *   POST /admin/clubs/:id/stage · /meeting    the club pipeline: move a lead along, set its meeting date (SCRUM-93)
 *   POST /admin/clubs/:id/agreement/send · /accept   send the club agreement; record the "I agree" reply (SCRUM-94)
 *   POST /admin/clubs/:id/batches             record a batch collected
 *   GET  /admin/batches?all=1                 open (or all) batches
 *   GET  /admin/batches/:ref · POST …/return · POST …/cancel · POST …/notes   one batch: return and invoice, cancel, notes
 *   GET  /admin/photos/:id                   a paddle photo (authorised, never cached)
 *   GET  /admin/admin.css
 */
import type { TaxSettings } from '../pricing/terms.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { retryCrmJob, type CrmDeps } from '../crm/sync.js';
import { ErasureError, eraseCustomer, planErasure, recentErasures } from '../orders/erasure.js';
import { activeExtensions, recentRuns, RetentionError, setExtension, upcomingDeletions } from '../orders/retention.js';
import { erasePage, erasePreviewPage, eraseDonePage, orderRetentionSection, retentionPage } from './retention-pages.js';
import type { Db } from '../db/db.js';
import { retryEmail } from '../email/outbox.js';
import { log, logError } from '../log.js';
import type { TrustedProxies } from '../orders/abuse.js';
import { REFERENCE_RE, STATUSES, type OrderStatus } from '../orders/model.js';
import type { PhotoStore } from '../orders/photos.js';
import { queueReviewReminder } from '../orders/review-reminder.js';
import { TransitionError, transitionOrder, type TransitionRequest } from '../orders/transitions.js';
import { codePage, codesPage } from './codes-pages.js';
import { reinstateLatePayment } from '../payments/payments.js';
import { DEFAULT_SELLER, documentByNumber, documentsOf, listDocuments, type Seller } from '../documents/documents.js';
import { DOCUMENT_NUMBER_RE } from '../orders/status.js';
import { documentListPage, documentPage, documentsSection } from './document-pages.js';
import { html } from './html.js';
import { CODE_STATES, codePrefixes, createCodes, DiscountCodeError, findCode, listCodes, setCodeActive, setCodeNote, usesOf, type CodeState } from '../orders/discounts.js';
import type { DiscountKind } from '../orders/rules.js';
import { sydneyDate } from '../orders/dates.js';
import { addNote, listOrders, loadOrder, MAX_NOTE, outboxRow, photoPath } from './data.js';
import { adminGuard, type AdminIdentity } from './guard.js';
import { detailPage, filterStatuses, listPage, notFoundPage, parseFilter, type Flash, type PageContext } from './pages.js';
import { ADMIN_CSS } from './style.js';
import { batchesPage, batchPage, clubPage, clubsPage } from './club-pages.js';
import { liveAgreement } from '../clubs/agreement-versions.js';
import { agreementsOfClub, recordAcceptance, sendAgreement } from '../clubs/agreements.js';
import { moveClub, setFulfilmentOverride, setMeeting } from '../clubs/leads.js';
import { flaggedCardPayments, paymentsOfInvoice, recordClubPayment } from '../clubs/payments.js';
import {
  batchEmails, cancelBatch, clubCrmSync, ClubError, createBatch, createClub, findBatch, findClub, invoiceBatch, listBatches, listClubs, returnBatch, setBatchNote, setClubActive, updateClub, validateClub,
  type Club, type ClubInput,
} from '../clubs/clubs.js';

export interface AdminDeps {
  db: Db;
  photos: PhotoStore;
  isProduction: boolean;
  /** EMAIL_ALLOWLIST: outside production a club's billing email has to be on it (or a test domain). */
  emailAllowList: readonly string[];
  /** ADMIN_LOGINS: the Tailscale logins allowed in. Empty or unset = the admin answers 503. */
  logins: readonly string[] | undefined;
  /** ADMIN_TRUSTED_PROXIES: who may connect and vouch for the identity headers. */
  trusted: TrustedProxies;
  /** Keys the CSRF tokens (a service secret kept in the database). */
  csrfKey: Buffer;
  now?: () => Date;
  /** The TCP peer's address. Overridable for tests. */
  peer?: (c: Context) => string;
  /** SCRUM-75: HubSpot, for erasure. Null when it isn't configured here. */
  crm?: CrmDeps | null;
  /** SCRUM-81: GST_REGISTERED_FROM. Default: not registered. */
  tax?: TaxSettings;
  /** SCRUM-82: whether a Stripe key is set here (otherwise "Payments not configured"). */
  paymentsConfigured?: boolean;
  /** SCRUM-84: who issues receipts (a reinstated late payment issues one), and SCRUM-85's club invoices. */
  seller?: Seller;
  /** SCRUM-85: CLUB_PAYMENT_TERMS_DAYS, days a club has to pay an invoice. Unused while payment is due before return; review after going to production. */
  clubPaymentTermsDays?: number;
}

type Env = { Variables: { admin: AdminIdentity } };

const nodePeer = (c: Context): string =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? '';

/** The admin's CSP: no scripts at all, styles and images from itself only, never framed. */
export const ADMIN_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Status flash messages carried across the redirect after a POST (fixed texts only). */
const DONE: Record<string, string> = {
  moved: 'Done. The order has moved on.',
  note: 'Note saved.',
  retry: 'Queued again; it will be sent within a minute.',
  reminder: 'Review reminder queued; it goes out within a minute.',
  extended: 'Extension saved: the retention rules wait for it.',
  cleared: 'Extension removed: the retention rules apply again.',
  created: 'Code created. Copy it from the heading.',
  deactivated: 'Deactivated: new orders can’t use it.',
  reactivated: 'Reactivated.',
  generated: 'Codes created: the list shows just this prefix.',
  noted: 'Note saved.',
  reinstated: 'Reinstated: the order is Paid, with the late payment as its payment.',
  club_created: 'Club added.',
  club_saved: 'Club details saved.',
  stage_moved: 'Moved along the pipeline.',
  agreement_sent: 'The agreement is queued: its email goes out within a minute.',
  agreement_accepted: 'Acceptance recorded.',
  agreement_accepted_active: 'Acceptance recorded: the club is now Active.',
  meeting_saved: 'Meeting saved.',
  fulfilment_saved: 'Saved how this club’s batches travel.',
  club_inactive: 'The club is now inactive.',
  club_active: 'The club is active again.',
  batch_created: 'Batch recorded.',
  batch_invoiced: 'Invoiced: the invoice email goes out within a minute. The batch goes back once the club has paid.',
  batch_returned: 'Marked returned.',
  batch_cancelled: 'Batch cancelled.',
  batch_noted: 'Notes saved.',
  payment_recorded: 'Payment recorded.',
  payment_paid: 'Payment recorded: the invoice is paid in full and the batch is Paid.',
};

/** "60", "60.5", "60.50" → cents. Anything else → undefined (bad input). */
export function parseAmount(value: string): number | undefined {
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, frac = ''] = value.split('.') as [string, string?];
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function createAdminApp(deps: AdminDeps) {
  const now = deps.now ?? (() => new Date());
  const app = new Hono<Env>();

  // Headers on everything the admin sends, refusals included (SCRUM-71 AC5).
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', ADMIN_CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
  });
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Too large.', 413) }));
  app.use('*', adminGuard({ logins: deps.logins, trusted: deps.trusted, peer: deps.peer ?? nodePeer, csrfKey: deps.csrfKey }));

  const tax: TaxSettings = deps.tax ?? { gstRegisteredFrom: null };
  const ctx = (c: Context<Env>): PageContext => ({
    admin: c.get('admin'), isProduction: deps.isProduction, now: now(), tax, paymentsConfigured: deps.paymentsConfigured ?? false,
  });
  const back = (c: Context<Env>, reference: string, done: keyof typeof DONE) => c.redirect(`/admin/orders/${reference}?done=${done}`, 303);

  app.get('/admin/admin.css', (c) => {
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(ADMIN_CSS);
  });

  app.get('/admin', (c) => c.redirect('/admin/orders', 302));
  app.get('/admin/', (c) => c.redirect('/admin/orders', 302));

  app.get('/admin/orders', async (c) => {
    const filter = parseFilter(c.req.query('status'));
    if (!filter) return c.html(notFoundPage(ctx(c), 'There is no such status.'), 404);
    // SCRUM-83: "Waiting on you" also lists orders with a payment to check, whatever their status.
    return c.html(listPage(ctx(c), filter, await listOrders(deps.db, filterStatuses(filter), now(), { withPaymentProblems: filter === 'waiting' })));
  });

  const showOrder = async (c: Context<Env>, reference: string, flash?: Flash, status: 200 | 400 | 404 | 409 = 200) => {
    const order = REFERENCE_RE.test(reference) ? await loadOrder(deps.db, reference, now()) : null;
    if (!order) return c.html(notFoundPage(ctx(c), `No order ${reference}.`), 404);
    const docs = await documentsOf(deps.db, order.id);
    return c.html(detailPage(ctx(c), order, flash, html`${documentsSection(docs)}${orderRetentionSection(ctx(c), order)}`), status);
  };

  app.get('/admin/orders/:ref', async (c) => {
    const done = DONE[c.req.query('done') ?? ''];
    return showOrder(c, c.req.param('ref'), done ? { kind: 'done', text: done } : undefined);
  });

  const move = async (c: Context<Env>, req: TransitionRequest) => {
    try {
      const result = await transitionOrder({ db: deps.db, isProduction: deps.isProduction, now: now(), tax }, req);
      log('admin_status_changed', { reference: result.reference, from: result.from, to: result.to });
      return back(c, req.reference, 'moved');
    } catch (err) {
      if (err instanceof TransitionError) {
        if (err.httpStatus === 404) return showOrder(c, req.reference);
        return showOrder(c, req.reference, { kind: 'error', text: err.message }, err.httpStatus);
      }
      throw err;
    }
  };

  const field = (body: Record<string, unknown>, name: string): string | undefined => {
    const v = body[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };

  app.post('/admin/orders/:ref/status', async (c) => {
    const reference = c.req.param('ref');
    if (!REFERENCE_RE.test(reference)) return showOrder(c, reference);
    const body = await c.req.parseBody();
    const to = field(body, 'to');
    // Only Stripe sets Paid (SCRUM-82).
    if (!to || !(STATUSES as readonly string[]).includes(to) || to === 'paid') {
      return showOrder(c, reference, { kind: 'error', text: 'That isn’t a status this form can set.' }, 400);
    }
    // SCRUM-81: the form arrives with the calculated postage filled in; a different amount needs a reason.
    const postage = field(body, 'postage');
    let postageCents: number | undefined;
    if (to === 'accepted' && postage !== undefined) {
      postageCents = parseAmount(postage.replace(/^A?\$/, ''));
      if (postageCents === undefined) return showOrder(c, reference, { kind: 'error', text: 'The postage must be dollars, like 20 or 22.25.' }, 400);
    }
    return move(c, {
      reference,
      to: to as OrderStatus,
      actor: 'admin',
      reason: field(body, 'reason'),
      trackingNumber: field(body, 'trackingNumber'),
      arrivedOn: field(body, 'arrivedOn'),
      postageCents,
      postageReason: to === 'accepted' ? field(body, 'postageReason') : undefined,
      note: field(body, 'note'),
    });
  });

  // SCRUM-83: reinstate a late payment (Lapsed or Withdrawn → Paid), with a note.
  app.post('/admin/orders/:ref/reinstate', async (c) => {
    const reference = c.req.param('ref');
    if (!REFERENCE_RE.test(reference)) return showOrder(c, reference);
    try {
      await reinstateLatePayment(deps.db, reference, c.get('admin').login, field(await c.req.parseBody(), 'note') ?? '', {
        isProduction: deps.isProduction, now: now(), seller: deps.seller ?? DEFAULT_SELLER,
      });
    } catch (err) {
      if (err instanceof TransitionError) {
        if (err.httpStatus === 404) return showOrder(c, reference);
        return showOrder(c, reference, { kind: 'error', text: err.message }, err.httpStatus);
      }
      throw err;
    }
    log('admin_payment_reinstated', { reference });
    return back(c, reference, 'reinstated');
  });

  // ── Documents (SCRUM-84) ──────────────────────────────────────────────────
  app.get('/admin/documents', async (c) => c.html(documentListPage(ctx(c), await listDocuments(deps.db))));
  app.get('/admin/documents/:number', async (c) => {
    const number = c.req.param('number');
    const doc = DOCUMENT_NUMBER_RE.test(number) ? await documentByNumber(deps.db, number) : null;
    return doc ? c.html(documentPage(ctx(c), doc)) : c.html(notFoundPage(ctx(c), `No document ${number}.`), 404);
  });

  // SCRUM-82 removed "Mark paid (test)": Stripe test cards pay staging orders.
  if (!deps.isProduction) {
    // SCRUM-80: send the one review reminder now rather than 10 days after posting back.
    app.post('/admin/orders/:ref/review-reminder-test', async (c) => {
      const reference = c.req.param('ref');
      if (!REFERENCE_RE.test(reference)) return showOrder(c, reference);
      const { rows } = await deps.db.query<{ id: string }>('SELECT id FROM orders WHERE reference = $1 AND NOT is_smoke', [reference]);
      if (!rows[0]) return showOrder(c, reference);
      const queued = await deps.db.tx((q) => queueReviewReminder(q, rows[0]!.id, now()));
      if (!queued) {
        return showOrder(c, reference, { kind: 'error', text: 'Only an order that has been posted back, with no review and no reminder yet, can get one.' }, 409);
      }
      log('admin_review_reminder_test', { reference });
      return back(c, reference, 'reminder');
    });
  }

  // ── Retention (SCRUM-75) ──────────────────────────────────────────────────
  const retentionDeps = { db: deps.db, photos: deps.photos, crm: deps.crm ?? null };

  app.post('/admin/orders/:ref/retention', async (c) => {
    const reference = c.req.param('ref');
    if (!REFERENCE_RE.test(reference)) return showOrder(c, reference);
    const body = await c.req.parseBody();
    const clear = field(body, 'action') === 'clear';
    try {
      await setExtension(deps.db, reference, clear ? null : { until: field(body, 'until') ?? '', reason: field(body, 'reason') ?? '' }, now());
    } catch (err) {
      if (err instanceof RetentionError) {
        if (err.httpStatus === 404) return showOrder(c, reference);
        return showOrder(c, reference, { kind: 'error', text: err.message }, 400);
      }
      throw err;
    }
    log('admin_retention_extension', { reference, cleared: clear });
    return back(c, reference, clear ? 'cleared' : 'extended');
  });

  app.get('/admin/retention', async (c) =>
    c.html(
      retentionPage(ctx(c), {
        upcoming: await upcomingDeletions(deps.db, now()),
        extensions: await activeExtensions(deps.db, now()),
        runs: await recentRuns(deps.db),
        erasures: await recentErasures(retentionDeps),
      }),
    ),
  );

  app.get('/admin/erase', (c) => c.html(erasePage(ctx(c))));

  const emailField = (body: Record<string, unknown>) => {
    const email = field(body, 'email');
    return email && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
  };

  app.post('/admin/erase/preview', async (c) => {
    const email = emailField(await c.req.parseBody());
    if (!email) return c.html(erasePage(ctx(c), { kind: 'error', text: 'Enter the customer’s email address.' }), 400);
    return c.html(erasePreviewPage(ctx(c), await planErasure(retentionDeps, email, now()), !!deps.crm?.adapter));
  });

  app.post('/admin/erase/confirm', async (c) => {
    const body = await c.req.parseBody();
    const email = emailField(body);
    if (!email) return c.html(erasePage(ctx(c), { kind: 'error', text: 'Enter the customer’s email address.' }), 400);
    if (field(body, 'confirm') !== 'erase') {
      return c.html(erasePreviewPage(ctx(c), await planErasure(retentionDeps, email, now()), !!deps.crm?.adapter, { kind: 'error', text: 'Tick the box to confirm.' }), 400);
    }
    try {
      const result = await eraseCustomer(retentionDeps, email, field(body, 'fingerprint') ?? '', now());
      return c.html(eraseDonePage(ctx(c), result));
    } catch (err) {
      if (err instanceof ErasureError) {
        const status = err.code === 'crm_unavailable' ? 502 : 409;
        return c.html(erasePreviewPage(ctx(c), await planErasure(retentionDeps, email, now()), !!deps.crm?.adapter, { kind: 'error', text: err.message }), status);
      }
      throw err;
    }
  });

  app.post('/admin/orders/:ref/notes', async (c) => {
    const reference = c.req.param('ref');
    if (!REFERENCE_RE.test(reference)) return showOrder(c, reference);
    const note = field(await c.req.parseBody(), 'note');
    if (!note) return showOrder(c, reference, { kind: 'error', text: 'Write the note first.' }, 400);
    if (note.length > MAX_NOTE) return showOrder(c, reference, { kind: 'error', text: `Keep notes under ${MAX_NOTE} characters.` }, 400);
    if (!(await addNote(deps.db, reference, c.get('admin').login, note, now()))) return showOrder(c, reference);
    return back(c, reference, 'note');
  });

  app.post('/admin/outbox/:id/retry', async (c) => {
    const row = await outboxRow(deps.db, c.req.param('id'));
    if (!row) return c.html(notFoundPage(ctx(c), 'No such email or sync.'), 404);
    const retried = row.kind === 'email' ? await retryEmail(deps.db, c.req.param('id'), now()) : await retryCrmJob(deps.db, c.req.param('id'), now());
    const isBatch = row.reference.startsWith('PMPB-');
    const clubId = row.reference.startsWith('club:') ? row.reference.slice(5) : null;
    if (clubId) {
      const club = await findClub(deps.db, clubId);
      if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
      if (!retried) return clubPageFor(c, club, { kind: 'error', text: 'Only a failed sync can be retried (it may already be queued again).' }, 400);
      log('admin_retry', { outbox: Number(c.req.param('id')), kind: row.kind });
      return c.redirect(`/admin/clubs/${clubId}?done=retry`, 303);
    }
    if (!retried) {
      const text = 'Only a failed email or sync can be retried (it may already be queued again).';
      return isBatch ? batchPageFor(c, row.reference, { kind: 'error', text }, 409) : showOrder(c, row.reference, { kind: 'error', text }, 409);
    }
    log('admin_retry', { outbox: Number(c.req.param('id')), kind: row.kind });
    return isBatch ? c.redirect(`/admin/batches/${row.reference}?done=retry`, 303) : back(c, row.reference, 'retry');
  });

  // ── Discount codes (SCRUM-63) ─────────────────────────────────────────────
  const codesList = async (c: Context<Env>, flash?: Flash, status: 200 | 400 = 200) => {
    const today = sydneyDate(now());
    const prefix = (c.req.query('prefix') ?? '').toUpperCase();
    const st = c.req.query('state') ?? '';
    const filter = { prefix: /^[A-Z0-9]{1,20}$/.test(prefix) ? prefix : '', state: (CODE_STATES as readonly string[]).includes(st) ? (st as CodeState) : ('' as const) };
    const codes = await listCodes(deps.db, { prefix: filter.prefix, state: filter.state || undefined, today });
    return c.html(codesPage(ctx(c), codes, today, filter, await codePrefixes(deps.db), flash), status);
  };

  app.get('/admin/codes', (c) => {
    const done = DONE[c.req.query('done') ?? ''];
    return codesList(c, done ? { kind: 'done', text: done } : undefined);
  });

  // SCRUM-63, redesigned 3 Nov 2026: one form for one-per-person batches and shared codes.
  app.post('/admin/codes', async (c) => {
    const body = await c.req.parseBody();
    const mode = field(body, 'mode') === 'shared' ? 'shared' : 'personal';
    const kind = field(body, 'kind');
    if (kind !== 'free' && kind !== 'amount' && kind !== 'percent') return codesList(c, { kind: 'error', text: 'Choose what the code gives.' }, 400);
    const rawValue = field(body, 'value') ?? '';
    const value = kind === 'amount' ? parseAmount(rawValue.replace(/^A?\$/, '')) : /^\d{1,5}$/.test(rawValue) ? Number(rawValue) : undefined;
    if (value === undefined) {
      return codesList(c, { kind: 'error', text: kind === 'amount' ? 'The amount must be dollars, like 10 or 12.50.' : 'How much must be a whole number.' }, 400);
    }
    const whole = (name: string, fallback: number) => {
      const v = field(body, name);
      return v === undefined ? fallback : /^\d{1,5}$/.test(v) ? Number(v) : NaN;
    };
    try {
      const made = await createCodes(
        deps.db,
        {
          mode,
          prefix: field(body, 'prefix') ?? '',
          count: whole('count', 1),
          kind,
          value,
          maxUses: whole('maxUses', 1),
          onePerEmail: field(body, 'onePerEmail') === 'yes',
          expiresOn: field(body, 'expiresOn') ?? null,
          note: field(body, 'note') ?? null,
        },
        c.get('admin').login,
        now(),
      );
      log('admin_discount_codes_created', { mode, count: made.length, kind });
      if (made.length === 1) return c.redirect(`/admin/codes/${made[0]!.id}?done=created`, 303);
      const prefix = made[0]!.code.split('-')[0]!;
      return c.redirect(`/admin/codes?prefix=${encodeURIComponent(prefix)}&done=generated`, 303);
    } catch (err) {
      if (err instanceof DiscountCodeError) return codesList(c, { kind: 'error', text: err.message }, 400);
      throw err;
    }
  });

  app.get('/admin/codes/:id', async (c) => {
    const code = await findCode(deps.db, c.req.param('id'));
    if (!code) return c.html(notFoundPage(ctx(c), 'No such code.'), 404);
    const done = DONE[c.req.query('done') ?? ''];
    return c.html(codePage(ctx(c), code, await usesOf(deps.db, code.id), sydneyDate(now()), done ? { kind: 'done', text: done } : undefined));
  });

  app.post('/admin/codes/:id/active', async (c) => {
    const active = field(await c.req.parseBody(), 'active') === 'yes';
    if (!(await setCodeActive(deps.db, c.req.param('id'), active))) return c.html(notFoundPage(ctx(c), 'No such code.'), 404);
    log('admin_discount_code_active', { id: Number(c.req.param('id')), active });
    return c.redirect(`/admin/codes/${c.req.param('id')}?done=${active ? 'reactivated' : 'deactivated'}`, 303);
  });

  app.post('/admin/codes/:id/note', async (c) => {
    try {
      if (!(await setCodeNote(deps.db, c.req.param('id'), field(await c.req.parseBody(), 'note') ?? null))) {
        return c.html(notFoundPage(ctx(c), 'No such code.'), 404);
      }
    } catch (err) {
      if (!(err instanceof DiscountCodeError)) throw err;
      const code = await findCode(deps.db, c.req.param('id'));
      if (!code) return c.html(notFoundPage(ctx(c), 'No such code.'), 404);
      return c.html(codePage(ctx(c), code, await usesOf(deps.db, code.id), sydneyDate(now()), { kind: 'error', text: err.message }), 400);
    }
    return c.redirect(`/admin/codes/${c.req.param('id')}?done=noted`, 303);
  });

  // ── Clubs and batches (SCRUM-85) ──────────────────────────────────────────
  const flashOf = (c: Context<Env>): Flash | undefined => {
    const done = DONE[c.req.query('done') ?? ''];
    return done ? { kind: 'done', text: done } : undefined;
  };
  const clubForm = (body: Record<string, unknown>): Partial<Record<keyof ClubInput, string | null>> => ({
    name: field(body, 'name') ?? '',
    billingName: field(body, 'billingName') ?? '',
    billingEmail: field(body, 'billingEmail') ?? '',
    billingAddress: field(body, 'billingAddress') ?? '',
    abn: field(body, 'abn') ?? null,
    notes: field(body, 'notes') ?? null,
  });
  const clubPageFor = async (c: Context<Env>, club: Club, flash?: Flash, status: 200 | 400 = 200, form?: Partial<Club>) =>
    c.html(clubPage(ctx(c), club, await listBatches(deps.db, { clubId: club.id }), sydneyDate(now()), flash, form, await clubCrmSync(deps.db, club.id), await agreementsOfClub(deps.db, club.id), liveAgreement(deps.isProduction)), status);
  const seller = deps.seller ?? DEFAULT_SELLER;

  app.get('/admin/clubs', async (c) => c.html(clubsPage(ctx(c), await listClubs(deps.db), flashOf(c))));
  app.post('/admin/clubs', async (c) => {
    const raw = clubForm(await c.req.parseBody());
    try {
      const club = await createClub(deps.db, validateClub(raw, { isProduction: deps.isProduction, allowList: deps.emailAllowList }), { isProduction: deps.isProduction, now: now() });
      log('admin_club_created', { club: club.id });
      return c.redirect(`/admin/clubs/${club.id}?done=club_created`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return c.html(clubsPage(ctx(c), await listClubs(deps.db), { kind: 'error', text: err.message }, raw as Partial<Club>), 400);
    }
  });
  app.get('/admin/clubs/:id', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    return clubPageFor(c, club, flashOf(c));
  });
  app.post('/admin/clubs/:id', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    const raw = clubForm(await c.req.parseBody());
    try {
      await updateClub(deps.db, club.id, validateClub(raw, { isProduction: deps.isProduction, allowList: deps.emailAllowList }), now());
      log('admin_club_saved', { club: club.id });
      return c.redirect(`/admin/clubs/${club.id}?done=club_saved`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400, raw as Partial<Club>);
    }
  });
  app.post('/admin/clubs/:id/active', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    const active = field(await c.req.parseBody(), 'active') === 'yes';
    if (!(await setClubActive(deps.db, club.id, active, now()))) {
      return clubPageFor(c, club, { kind: 'error', text: active ? 'A club becomes Active when you record its “I agree” reply, and it needs its billing details first.' : 'Only an Active club can be made inactive here.' }, 400);
    }
    log('admin_club_active', { club: club.id, active });
    return c.redirect(`/admin/clubs/${club.id}?done=${active ? 'club_active' : 'club_inactive'}`, 303);
  });
  // SCRUM-93: the pipeline. Moves that aren't allowed come back with the reason.
  app.post('/admin/clubs/:id/stage', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    try {
      const moved = await moveClub(deps.db, club.id, field(await c.req.parseBody(), 'to') ?? '', now());
      log('admin_club_moved', { club: club.id, from: moved.from, to: moved.to });
      return c.redirect(`/admin/clubs/${club.id}?done=stage_moved`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400);
    }
  });
  app.post('/admin/clubs/:id/meeting', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    try {
      const body = await c.req.parseBody();
      await setMeeting(deps.db, club.id, { meetingOn: field(body, 'meetingOn') ?? '', meetingTime: field(body, 'meetingTime') ?? '', meetingMinutes: field(body, 'meetingMinutes') ?? '' }, now());
      return c.redirect(`/admin/clubs/${club.id}?done=meeting_saved`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400);
    }
  });
  app.post('/admin/clubs/:id/fulfilment', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    try {
      const value = field(await c.req.parseBody(), 'fulfilment') ?? '';
      await setFulfilmentOverride(deps.db, club.id, value, now());
      log('admin_club_fulfilment', { club: club.id, override: value || 'default' });
      return c.redirect(`/admin/clubs/${club.id}?done=fulfilment_saved`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400);
    }
  });
  // SCRUM-94: send the agreement, and record the "I agree" reply.
  app.post('/admin/clubs/:id/agreement/send', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    try {
      const sent = await sendAgreement(deps.db, { clubId: club.id, isProduction: deps.isProduction, now: now() });
      log('admin_agreement_sent', { club: club.id, version: sent.label, resent: sent.resent });
      return c.redirect(`/admin/clubs/${club.id}?done=agreement_sent`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400);
    }
  });
  app.post('/admin/clubs/:id/agreement/accept', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    const body = await c.req.parseBody();
    try {
      const r = await recordAcceptance(deps.db, {
        clubId: club.id, version: field(body, 'version') ?? '', acceptedOn: field(body, 'acceptedOn') ?? '', acceptedBy: field(body, 'acceptedBy') ?? '', note: field(body, 'note') ?? '', now: now(),
      });
      log('admin_agreement_accepted', { club: club.id, active: r.becameActive });
      return c.redirect(`/admin/clubs/${club.id}?done=${r.becameActive ? 'agreement_accepted_active' : 'agreement_accepted'}`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400);
    }
  });
  app.post('/admin/clubs/:id/batches', async (c) => {
    const club = await findClub(deps.db, c.req.param('id'));
    if (!club) return c.html(notFoundPage(ctx(c), 'No such club.'), 404);
    const body = await c.req.parseBody();
    const count = field(body, 'paddleCount') ?? '';
    try {
      const batch = await createBatch(deps.db, {
        clubId: club.id,
        collectedOn: field(body, 'collectedOn') ?? '',
        method: field(body, 'method') ?? 'pickup',
        inboundTracking: field(body, 'inboundTracking') ?? null,
        paddleCount: /^\d{1,3}$/.test(count) ? Number(count) : NaN,
        notes: field(body, 'notes') ?? null,
        now: now(),
      });
      log('admin_batch_created', { batch: batch.reference, paddles: batch.paddleCount });
      return c.redirect(`/admin/batches/${batch.reference}?done=batch_created`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return clubPageFor(c, club, { kind: 'error', text: err.message }, 400);
    }
  });

  app.get('/admin/batches', async (c) => {
    const all = c.req.query('all') === '1';
    return c.html(batchesPage(ctx(c), await listBatches(deps.db, { open: !all }), all, sydneyDate(now())));
  });
  const batchPageFor = async (c: Context<Env>, reference: string, flash?: Flash, status: 200 | 400 | 409 = 200) => {
    const batch = await findBatch(deps.db, reference);
    if (!batch) return c.html(notFoundPage(ctx(c), 'No such batch.'), 404);
    const pays = batch.invoice
      ? { payments: await paymentsOfInvoice(deps.db, batch.invoice.id), flagged: await flaggedCardPayments(deps.db, batch.invoice.id) }
      : undefined;
    return c.html(batchPage(ctx(c), batch, sydneyDate(now()), flash, await batchEmails(deps.db, batch.id), pays), status);
  };
  app.get('/admin/batches/:ref', async (c) => batchPageFor(c, c.req.param('ref'), flashOf(c)));
  // SCRUM-102: the club pays before its batch goes back, so a batch is invoiced when re-gritted ...
  app.post('/admin/batches/:ref/invoice', async (c) => {
    const reference = c.req.param('ref');
    if (!(await findBatch(deps.db, reference))) return c.html(notFoundPage(ctx(c), 'No such batch.'), 404);
    const body = await c.req.parseBody();
    const unchanged = field(body, 'unchangedCount') ?? '0';
    const allowanceRaw = (field(body, 'postageAllowance') ?? '').replace(/^A?\$/, '').replace(/,/g, '');
    const allowance = allowanceRaw ? parseAmount(allowanceRaw) : undefined;
    try {
      const r = await invoiceBatch(
        { db: deps.db, seller, isProduction: deps.isProduction, now: now(), payByCard: deps.paymentsConfigured ?? false },
        { reference, unchangedCount: /^\d{1,3}$/.test(unchanged) ? Number(unchanged) : NaN, postageAllowanceCents: allowanceRaw ? (allowance ?? NaN) : null },
      );
      log('admin_batch_invoiced', { batch: reference, postageAllowanceCents: r.postageAllowanceCents });
      return c.redirect(`/admin/batches/${reference}?done=batch_invoiced`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return batchPageFor(c, reference, { kind: 'error', text: err.message }, 400);
    }
  });
  // ... and goes back once paid (or at once when every paddle was unchanged and there is nothing to invoice).
  app.post('/admin/batches/:ref/return', async (c) => {
    const reference = c.req.param('ref');
    if (!(await findBatch(deps.db, reference))) return c.html(notFoundPage(ctx(c), 'No such batch.'), 404);
    const body = await c.req.parseBody();
    const unchanged = field(body, 'unchangedCount');
    try {
      await returnBatch(
        { db: deps.db, now: now() },
        {
          reference,
          returnedOn: field(body, 'returnedOn') ?? '',
          returnTracking: field(body, 'returnTracking') ?? null,
          ...(unchanged !== undefined ? { unchangedCount: /^\d{1,3}$/.test(unchanged) ? Number(unchanged) : NaN } : {}),
        },
      );
      log('admin_batch_returned', { batch: reference });
      return c.redirect(`/admin/batches/${reference}?done=batch_returned`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return batchPageFor(c, reference, { kind: 'error', text: err.message }, 400);
    }
  });
  app.post('/admin/batches/:ref/payments', async (c) => {
    const reference = c.req.param('ref');
    if (!(await findBatch(deps.db, reference))) return c.html(notFoundPage(ctx(c), 'No such batch.'), 404);
    const body = await c.req.parseBody();
    const amount = parseAmount((field(body, 'amount') ?? '').replace(/^A?\$/, '').replace(/,/g, ''));
    try {
      const { paidInFull } = await recordClubPayment(deps.db, {
        batchReference: reference,
        method: field(body, 'method') ?? '',
        amountCents: amount ?? NaN,
        paidOn: field(body, 'paidOn') ?? '',
        reference: field(body, 'reference') ?? null,
        by: c.get('admin').login,
        now: now(),
      });
      return c.redirect(`/admin/batches/${reference}?done=${paidInFull ? 'payment_paid' : 'payment_recorded'}`, 303);
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return batchPageFor(c, reference, { kind: 'error', text: err.message }, 400);
    }
  });
  app.post('/admin/batches/:ref/cancel', async (c) => {
    const reference = c.req.param('ref');
    if (!(await findBatch(deps.db, reference))) return c.html(notFoundPage(ctx(c), 'No such batch.'), 404);
    try {
      await cancelBatch(deps.db, reference, now());
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return batchPageFor(c, reference, { kind: 'error', text: err.message }, 400);
    }
    log('admin_batch_cancelled', { batch: reference });
    return c.redirect(`/admin/batches/${reference}?done=batch_cancelled`, 303);
  });
  app.post('/admin/batches/:ref/notes', async (c) => {
    const reference = c.req.param('ref');
    try {
      if (!(await setBatchNote(deps.db, reference, field(await c.req.parseBody(), 'notes') ?? null, now()))) {
        return c.html(notFoundPage(ctx(c), 'No such batch.'), 404);
      }
    } catch (err) {
      if (!(err instanceof ClubError)) throw err;
      return batchPageFor(c, reference, { kind: 'error', text: err.message }, 400);
    }
    return c.redirect(`/admin/batches/${reference}?done=batch_noted`, 303);
  });

  app.get('/admin/photos/:id', async (c) => {
    const rel = await photoPath(deps.db, c.req.param('id'));
    const data = rel ? await deps.photos.read(rel) : null;
    if (!data) return c.text('Not found', 404);
    c.header('Content-Type', 'image/jpeg');
    c.header('Content-Disposition', 'inline');
    return c.body(new Uint8Array(data));
  });

  app.notFound((c) => c.text('Not found', 404));
  app.onError((err, c) => {
    logError('admin_request_failed', err, { path: c.req.path });
    return c.text('Sorry, something went wrong. The error is in the service log.', 500);
  });
  return app;
}
