/**
 * The clubs' public API (SCRUM-85):
 *
 *   POST /api/clubs/invoice { token, number } → a club invoice (with what's owing), for its printable page, or 404
 *   POST /api/clubs/pay     { token, number } → { url } of a fresh Stripe Checkout page for what's owing
 *   POST /api/clubs/agreement { token }       → the club agreement as it was sent, for its printable page, or 404 (SCRUM-94)
 *   POST /api/clubs/paid    { sessionId }      → { paid, number } once back from Checkout
 *   GET  /api/clubs/lead/form                  → { open, formToken } when the "Talk to us" form loads (SCRUM-93)
 *   POST /api/clubs/lead    { …form fields }   → 201 { ok: true } and a lead in admin, or 400 { errors }
 *
 * The token is the private link from the invoice email; a wrong token and a wrong number get the
 * same answer. Guessing is hopeless (256-bit tokens), but each address is still limited per hour,
 * like every other public route.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/db.js';
import { clubDocumentForToken } from '../documents/documents.js';
import { applySession, PaymentError, type PaymentDeps } from '../payments/payments.js';
import { StripeError } from '../payments/stripe.js';
import { invoiceBalance, invoiceForToken, paymentsOfInvoice, startClubPayment, METHOD_LABELS } from './payments.js';
import { log } from '../log.js';
import { checkFormToken, checkLimit, clientIp, hashKey, issueFormToken, recordEvent, type AbuseKeys, type Limit, type TrustedProxies } from '../orders/abuse.js';
import { agreementForToken } from './agreements.js';
import { createLead, MAX_LEAD_MESSAGE, validateLead, type LeadForm } from './leads.js';

export interface ClubRouteDeps {
  db: Db;
  keys: AbuseKeys;
  trusted: TrustedProxies;
  /** Invoice lookups allowed per address per hour. */
  lookupsPerIpHour?: number;
  /** SCRUM-85: Stripe, when configured: card payments on club invoices. */
  payments?: PaymentDeps | null;
  /** The site's origins, for Checkout's return addresses. */
  siteOrigins?: readonly string[];
  /**
   * SCRUM-93: the "Talk to us" form. The same abuse protections as the order form (honeypot,
   * minimum fill time, per-address and per-email limits). Without it the routes aren't mounted.
   */
  lead?: { isProduction: boolean; emailAllowList: readonly string[]; perIpHour: number; perEmailDay: number; minFillSeconds: number };
  /** Whether this is production (a test page banner otherwise). Defaults to production: the safe side. */
  isProduction?: boolean;
  now?: () => Date;
  peer?: (c: Context) => string;
}

export const CLUB_INVOICE_LOOKUPS_PER_IP_HOUR = 120;
const HOUR = 60 * 60 * 1000;
const nodePeer = (c: Context): string =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? '';

const INVALID_LINK = { error: 'invalid_link', message: 'This invoice link isn’t valid. Use the link in the latest invoice email, or reply to it and we’ll send a new one.' };
const NOT_SET_UP = { error: 'payments_unavailable', message: 'Card payment isn’t available yet. Please pay by PayID or cash, or email attila@picklemypaddle.com.' };
const RATE_MESSAGE = 'We’ve received a lot of requests from you recently. Please try again later, or email attila@picklemypaddle.com.';

export function clubRoutes(deps: ClubRouteDeps) {
  const now = deps.now ?? (() => new Date());
  const peer = deps.peer ?? nodePeer;
  const limit: Limit = { bucket: 'club-invoice-ip', max: deps.lookupsPerIpHour ?? CLUB_INVOICE_LOOKUPS_PER_IP_HOUR, windowMs: HOUR };
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  /** Counts the request against the address's hourly limit; a Response when it's over. */
  const limited = async (c: Context, at: Date) => {
    const ipKey = hashKey(deps.keys.pepper, await clientIp(peer(c), c.req.header('x-forwarded-for'), deps.trusted));
    const r = await checkLimit(deps.db, limit, ipKey, at);
    if (!r.ok) {
      log('rate_limited', { bucket: limit.bucket, key: ipKey.slice(0, 12) });
      c.header('Retry-After', String(r.retryAfterSeconds));
      return c.json({ error: 'rate_limited', message: RATE_MESSAGE, retryAfter: r.retryAfterSeconds }, 429);
    }
    await recordEvent(deps.db, limit.bucket, ipKey, at);
    return null;
  };
  const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

  if (deps.lead) mountLeadRoutes(app, deps, deps.lead, now, peer);

  app.post('/invoice', small, async (c) => {
    const at = now();
    const over = await limited(c, at);
    if (over) return over;
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; number?: unknown } | null;
    const doc = await clubDocumentForToken(deps.db, body?.token, body?.number, at);
    if (!doc) return c.json(INVALID_LINK, 404);
    const inv = await invoiceForToken(deps.db, body?.token, body?.number, at);
    if (!inv) return c.json(doc); // a credit note: nothing to pay
    const balance = await invoiceBalance(deps.db, inv.id);
    const payments = (await paymentsOfInvoice(deps.db, inv.id)).map((p) => ({ method: METHOD_LABELS[p.method], amountCents: p.amountCents, paidOn: p.paidOn }));
    return c.json({ ...doc, balanceCents: balance.balanceCents, payments, canPayByCard: !!deps.payments && balance.balanceCents > 0 });
  });

  // SCRUM-94: the printable page of the agreement a club was emailed. A wrong, revoked or old link gets the same answer.
  app.post('/agreement', small, async (c) => {
    const at = now();
    const over = await limited(c, at);
    if (over) return over;
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const view = await agreementForToken(deps.db, body?.token, at, { isProduction: deps.isProduction ?? true });
    return view ? c.json(view) : c.json({ ...INVALID_LINK, message: 'This agreement link isn’t valid. Use the link in the latest agreement email, or reply to it and we’ll send a new one.' }, 404);
  });

  app.post('/pay', small, async (c) => {
    const at = now();
    const over = await limited(c, at);
    if (over) return over;
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; number?: unknown } | null;
    const inv = await invoiceForToken(deps.db, body?.token, body?.number, at);
    if (!inv) return c.json(INVALID_LINK, 404);
    const origins = deps.siteOrigins ?? [];
    const origin = origins.find((o) => o === c.req.header('origin')) ?? origins[0];
    if (!deps.payments || !origin) return c.json(NOT_SET_UP, 503);
    try {
      return c.json(await startClubPayment(deps.payments, inv, origin));
    } catch (err) {
      if (err instanceof PaymentError) return c.json({ error: err.code, message: err.message }, err.httpStatus);
      if (err instanceof StripeError) {
        log('club_payment_start_failed', { code: err.code });
        return c.json({ error: 'stripe_unavailable', message: 'We couldn’t start the payment just now. Please try again in a minute.' }, 502);
      }
      throw err;
    }
  });

  // Back from Checkout: the service asks Stripe itself and applies the session at once (the
  // poller and webhook would get there too).
  app.post('/paid', small, async (c) => {
    const at = now();
    const over = await limited(c, at);
    if (over) return over;
    if (!deps.payments) return c.json(NOT_SET_UP, 503);
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === 'string' && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(body.sessionId) ? body.sessionId : null;
    if (!sessionId) return c.json({ paid: false }, 404);
    try {
      const session = await deps.payments.stripe.getCheckoutSession(sessionId);
      const outcome = await applySession(deps.payments, session, 'return');
      const { rows } = await deps.db.query<{ number: string }>(
        `SELECT d.number FROM payments p JOIN documents d ON d.id = p.document_id WHERE p.checkout_session_id = $1 AND p.problem IS NULL`,
        [sessionId],
      );
      return c.json(rows[0] ? { paid: true, number: rows[0].number } : { paid: false, ...(outcome === 'flagged' ? { review: true } : {}) });
    } catch (err) {
      if (err instanceof StripeError) {
        log('club_payment_return_failed', { code: err.code });
        return c.json({ paid: false }, err.status === 404 ? 404 : 502);
      }
      throw err;
    }
  });
  return app;
}

const DAY = 24 * HOUR;

/** The Clubs page's form (SCRUM-93). */
function mountLeadRoutes(
  app: Hono,
  deps: ClubRouteDeps,
  cfg: NonNullable<ClubRouteDeps['lead']>,
  now: () => Date,
  peer: (c: Context) => string,
) {
  const ipLimit: Limit = { bucket: 'lead-ip', max: cfg.perIpHour, windowMs: HOUR };
  const emailLimit: Limit = { bucket: 'lead-email', max: cfg.perEmailDay, windowMs: DAY };
  const limitedResponse = (c: Context, retryAfterSeconds: number, bucket: string, keyHash: string) => {
    log('rate_limited', { bucket, key: keyHash.slice(0, 12) });
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json({ error: 'rate_limited', message: RATE_MESSAGE, retryAfter: retryAfterSeconds }, 429);
  };
  const FIELDS = ['clubName', 'suburb', 'contactName', 'contactEmail', 'contactPhone', 'memberCount', 'message', 'preferredTimes'] as const;

  app.get('/lead/form', (c) => c.json({ open: true, formToken: issueFormToken(deps.keys.formKey, now()) }));

  // The longest text is the message; the rest of the fields are short.
  const maxBytes = (MAX_LEAD_MESSAGE + 1200) * 4 + 2048;
  app.post('/lead', bodyLimit({ maxSize: maxBytes, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const at = now();
    const ipKey = hashKey(deps.keys.pepper, await clientIp(peer(c), c.req.header('x-forwarded-for'), deps.trusted));
    const ipCheck = await checkLimit(deps.db, ipLimit, ipKey, at);
    if (!ipCheck.ok) return limitedResponse(c, ipCheck.retryAfterSeconds, ipLimit.bucket, ipKey);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'bad_request', errors: { form: 'We couldn’t read that. Please reload the page and try again.' } }, 400);
    const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : typeof body[k] === 'number' ? String(body[k]) : '');

    // Bots: a filled honeypot or an implausibly fast submit gets a normal-looking answer and nothing is saved.
    const token = checkFormToken(deps.keys.formKey, text('formToken') || undefined, at);
    const tooFast = token.ok && token.ageMs < cfg.minFillSeconds * 1000;
    if (text('website').trim() !== '' || tooFast) {
      await recordEvent(deps.db, ipLimit.bucket, ipKey, at);
      log('club_lead_bot_suspected', { reason: tooFast ? 'too_fast' : 'honeypot', ip: ipKey.slice(0, 12) });
      return c.json({ ok: true, ...(cfg.isProduction ? {} : { test: true }) }, 201);
    }
    if (!token.ok) return c.json({ errors: { form: 'This page has been open a long time. Please reload it and send your details again.' } }, 400);

    const form: LeadForm = Object.fromEntries(FIELDS.map((k) => [k, text(k)]));
    const checked = validateLead(form, { isProduction: cfg.isProduction, allowList: cfg.emailAllowList });
    if (!checked.ok) return c.json({ errors: checked.errors }, 400);

    const emailKey = hashKey(deps.keys.pepper, checked.input.contactEmail.replace(/\+.*@/, '@'));
    const emailCheck = await checkLimit(deps.db, emailLimit, emailKey, at);
    if (!emailCheck.ok) return limitedResponse(c, emailCheck.retryAfterSeconds, emailLimit.bucket, emailKey);

    const lead = await createLead(deps.db, checked.input, { isProduction: cfg.isProduction, now: at });
    await recordEvent(deps.db, ipLimit.bucket, ipKey, at);
    await recordEvent(deps.db, emailLimit.bucket, emailKey, at);
    log(lead.created ? 'club_lead_created' : 'club_lead_repeated', { test: !cfg.isProduction });
    return c.json({ ok: true, ...(cfg.isProduction ? {} : { test: true }) }, 201);
  });
}
