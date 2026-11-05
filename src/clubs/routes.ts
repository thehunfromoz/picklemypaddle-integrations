/**
 * The clubs' public API (SCRUM-85):
 *
 *   POST /api/clubs/invoice { token, number } → a club invoice (with what's owing), for its printable page, or 404
 *   POST /api/clubs/pay     { token, number } → { url } of a fresh Stripe Checkout page for what's owing
 *   POST /api/clubs/paid    { sessionId }      → { paid, number } once back from Checkout
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
import { checkLimit, clientIp, hashKey, recordEvent, type AbuseKeys, type Limit, type TrustedProxies } from '../orders/abuse.js';

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
