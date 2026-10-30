/**
 * The order admin (SCRUM-71 and SCRUM-72), served ONLY on the admin listener (ADMIN_PORT).
 * The public app (src/app.ts) has no admin routes at all, so /admin through the public gateway
 * is a 404 whatever headers it carries.
 *
 *   GET  /admin                              → /admin/orders
 *   GET  /admin/orders?status=…              the list (default: waiting on Attila)
 *   GET  /admin/orders/:ref                  one order
 *   POST /admin/orders/:ref/status           move it (to, reason, trackingNumber, arrivedOn, amount, note)
 *   POST /admin/orders/:ref/mark-paid-test   staging only: Accepted → Paid without Stripe (404 in production)
 *   POST /admin/orders/:ref/review-reminder-test  staging only: the one review reminder now (404 in production)
 *   POST /admin/orders/:ref/notes            an internal note
 *   POST /admin/outbox/:id/retry             put a failed email or HubSpot sync back in the queue
 *   POST /admin/orders/:ref/retention        extend (until, reason) or clear an order's retention (SCRUM-75)
 *   GET  /admin/retention                    due for deletion soon, extensions, runs, erasures (SCRUM-75)
 *   GET  /admin/erase · POST /admin/erase/preview · POST /admin/erase/confirm   erasure on request (SCRUM-75)
 *   GET  /admin/photos/:id                   a paddle photo (authorised, never cached)
 *   GET  /admin/admin.css
 */
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
import { addNote, listOrders, loadOrder, MAX_NOTE, outboxRow, photoPath } from './data.js';
import { adminGuard, type AdminIdentity } from './guard.js';
import { detailPage, filterStatuses, listPage, notFoundPage, parseFilter, type Flash, type PageContext } from './pages.js';
import { ADMIN_CSS } from './style.js';

export interface AdminDeps {
  db: Db;
  photos: PhotoStore;
  isProduction: boolean;
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

  const ctx = (c: Context<Env>): PageContext => ({ admin: c.get('admin'), isProduction: deps.isProduction, now: now() });
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
    return c.html(listPage(ctx(c), filter, await listOrders(deps.db, filterStatuses(filter), now())));
  });

  const showOrder = async (c: Context<Env>, reference: string, flash?: Flash, status: 200 | 400 | 404 | 409 = 200) => {
    const order = REFERENCE_RE.test(reference) ? await loadOrder(deps.db, reference, now()) : null;
    if (!order) return c.html(notFoundPage(ctx(c), `No order ${reference}.`), 404);
    return c.html(detailPage(ctx(c), order, flash, orderRetentionSection(ctx(c), order)), status);
  };

  app.get('/admin/orders/:ref', async (c) => {
    const done = DONE[c.req.query('done') ?? ''];
    return showOrder(c, c.req.param('ref'), done ? { kind: 'done', text: done } : undefined);
  });

  const move = async (c: Context<Env>, req: TransitionRequest) => {
    try {
      const result = await transitionOrder({ db: deps.db, isProduction: deps.isProduction, now: now() }, req);
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
    // Paid has its own route (staging's test shortcut); Stripe sets it for real (SCRUM-9).
    if (!to || !(STATUSES as readonly string[]).includes(to) || to === 'paid') {
      return showOrder(c, reference, { kind: 'error', text: 'That isn’t a status this form can set.' }, 400);
    }
    const amount = field(body, 'amount');
    let amountCents: number | undefined;
    if (to === 'accepted' && amount !== undefined) {
      amountCents = parseAmount(amount.replace(/^A?\$/, ''));
      if (amountCents === undefined) return showOrder(c, reference, { kind: 'error', text: 'The amount must be dollars, like 60 or 60.50.' }, 400);
    }
    return move(c, {
      reference,
      to: to as OrderStatus,
      actor: 'admin',
      reason: field(body, 'reason'),
      trackingNumber: field(body, 'trackingNumber'),
      arrivedOn: field(body, 'arrivedOn'),
      amountCents,
      note: field(body, 'note'),
    });
  });

  // SCRUM-72 AC6: the route only exists outside production (and the transition rule refuses
  // admin-set Paid in production anyway).
  if (!deps.isProduction) {
    app.post('/admin/orders/:ref/mark-paid-test', async (c) => {
      const reference = c.req.param('ref');
      if (!REFERENCE_RE.test(reference)) return showOrder(c, reference);
      return move(c, { reference, to: 'paid', actor: 'admin', note: 'Marked paid by hand (test shortcut, not a real payment).' });
    });

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
    if (!retried) {
      return showOrder(c, row.reference, { kind: 'error', text: 'Only a failed email or sync can be retried (it may already be queued again).' }, 409);
    }
    log('admin_retry', { outbox: Number(c.req.param('id')), kind: row.kind });
    return back(c, row.reference, 'retry');
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
