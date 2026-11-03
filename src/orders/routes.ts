/**
 * Public order endpoints (SCRUM-65 to 67, SCRUM-70). Everything here sits behind the gateway at
 * /api/*, on the same origin as the site.
 *
 *   GET  /api/orders/form    a signed "form loaded at" token; also tells the site ordering is open
 *   POST /api/orders         submit an order (multipart)  → 201 { reference, statusToken, test? }
 *   POST /api/orders/status  { token }                    → the minimal status view, or 404
 *   POST /api/orders/document { token, number }          → a receipt or credit note (SCRUM-84), or 404
 *   POST /api/orders/links   { email }                    → 202, always the same answer
 *   POST /api/orders/review  { token, quote, firstName, suburb, permission } → 201 (SCRUM-33)
 *   POST /api/orders/pay     { token }                    → { url } of a fresh Stripe Checkout page (SCRUM-82)
 *   POST /api/orders/paid    { sessionId }                → { paid, reference? } after Checkout's return (SCRUM-82)
 *   POST /api/discount-codes/check  { code, email? } → { valid, … } (SCRUM-63; discountRoutes below)
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/db.js';
import { log, logError } from '../log.js';
import {
  checkFormToken,
  checkLimit,
  clientIp,
  hashKey,
  issueFormToken,
  recordEvent,
  type AbuseKeys,
  type Limit,
  type TrustedProxies,
} from './abuse.js';
import { checkCode } from './discounts.js';
import { BadFormError, createOrder, DiscountRefusedError, fakeOrder, findReplayOrder, parseOrderForm, validateAndProcess } from './intake.js';
import { normaliseEmail } from './model.js';
import type { PhotoStore } from './photos.js';
import { describeDiscount, DISCOUNT_REFUSED, MAX_REQUEST_BYTES } from './rules.js';
import { submitReview } from './reviews.js';
import { INVALID_LINK, lookupDocument, lookupStatus, orderForToken, requestLinks, type LinksMailer } from './status.js';
import { applyEvent, applySession, PaymentError, startPayment, verifyWebhook, type PaymentDeps } from '../payments/payments.js';
import { StripeError, type StripeEvent } from '../payments/stripe.js';

export interface OrderRouteDeps {
  db: Db;
  photos: PhotoStore;
  keys: AbuseKeys;
  trusted: TrustedProxies;
  mailer: LinksMailer | null;
  isProduction: boolean;
  /** SCRUM-82: Stripe, when a key is set here; null hides Pay now. */
  payments?: PaymentDeps | null;
  /** Site origins Stripe may send the customer back to (PUBLIC_SITE_ORIGIN); the first is the default. */
  siteOrigins?: readonly string[];
  limits: {
    orderPerIpHour: number;
    orderPerEmailDay: number;
    linksPerEmailDay: number;
    linksPerIpHour: number;
    minFillSeconds: number;
    /** SCRUM-63: discount-code checks per IP per hour (form checks and codes on submit). */
    discountChecksPerIpHour: number;
  };
  now?: () => Date;
  /** The TCP peer's address (the gateway, behind Compose). Overridable for tests. */
  peer?: (c: Context) => string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const RATE_MESSAGE = 'We’ve received a lot of requests from you recently. Please try again later, or email sales@picklemypaddle.com.';

const nodePeer = (c: Context): string =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? '';

export function orderRoutes(deps: OrderRouteDeps) {
  const now = deps.now ?? (() => new Date());
  const peer = deps.peer ?? nodePeer;
  const L = deps.limits;
  const limits = {
    orderIp: { bucket: 'order-ip', max: L.orderPerIpHour, windowMs: HOUR },
    orderEmail: { bucket: 'order-email', max: L.orderPerEmailDay, windowMs: DAY },
    linksIp: { bucket: 'links-ip', max: L.linksPerIpHour, windowMs: HOUR },
    linksEmail: { bucket: 'links-email', max: L.linksPerEmailDay, windowMs: DAY },
    reviewIp: { bucket: 'review-ip', max: L.linksPerIpHour, windowMs: HOUR },
    discountIp: { bucket: 'discount-ip', max: L.discountChecksPerIpHour, windowMs: HOUR },
    payIp: { bucket: 'pay-ip', max: L.linksPerIpHour, windowMs: HOUR },
  } satisfies Record<string, Limit>;
  const app = new Hono();

  // Nothing from these endpoints may be cached, and status pages never leak via Referer.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
  });

  const ipHash = async (c: Context) =>
    hashKey(deps.keys.pepper, await clientIp(peer(c), c.req.header('x-forwarded-for'), deps.trusted));

  const limited = (c: Context, retryAfterSeconds: number, bucket: string, keyHash: string) => {
    log('rate_limited', { bucket, key: keyHash.slice(0, 12) });
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json({ error: 'rate_limited', message: RATE_MESSAGE, retryAfter: retryAfterSeconds }, 429);
  };

  app.get('/form', (c) => c.json({ open: true, formToken: issueFormToken(deps.keys.formKey, now()) }));

  app.post(
    '/',
    // Cheap refusals first: wrong type, too big (refused from Content-Length or while streaming).
    async (c, next) => {
      const type = c.req.header('content-type') ?? '';
      if (!/^multipart\/form-data;\s*boundary=/i.test(type)) {
        return c.json({ error: 'unsupported_media_type', message: 'Send the order as multipart/form-data.' }, 415);
      }
      await next();
    },
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (c) =>
        c.json({ error: 'too_large', message: 'Your photos are too large to send together (60 MB at most). Please use smaller photos.' }, 413),
    }),
    async (c) => {
      const started = Date.now();
      const at = now();
      const ipKey = await ipHash(c);
      const ipCheck = await checkLimit(deps.db, limits.orderIp, ipKey, at);
      if (!ipCheck.ok) return limited(c, ipCheck.retryAfterSeconds, limits.orderIp.bucket, ipKey);

      let form;
      try {
        form = parseOrderForm(await c.req.formData());
      } catch (err) {
        if (err instanceof BadFormError || err instanceof TypeError || (err as Error)?.name === 'BodyLimitError') {
          return c.json({ error: 'bad_request', message: 'We couldn’t read that order. Please reload the page and try again.' }, 400);
        }
        throw err;
      }

      // Bots: a filled honeypot or an implausibly fast submit gets a normal-looking answer.
      const token = checkFormToken(deps.keys.formKey, form.formToken, at);
      const tooFast = token.ok && token.ageMs < L.minFillSeconds * 1000;
      if (form.honeypot.trim() !== '' || tooFast) {
        await recordEvent(deps.db, limits.orderIp.bucket, ipKey, at);
        log('order_bot_suspected', { reason: tooFast ? 'too_fast' : 'honeypot', ip: ipKey.slice(0, 12) });
        const fake = fakeOrder(deps.isProduction);
        return c.json({ reference: fake.reference, statusToken: fake.statusToken, ...(fake.isTest ? { test: true } : {}) }, 201);
      }
      if (!token.ok) {
        return c.json({ errors: { form: 'This page has been open a long time. Please reload it and submit your order again.' } }, 400);
      }

      const replay = await findReplayOrder({ db: deps.db, photos: deps.photos, isProduction: deps.isProduction, now }, form.idempotencyKey);
      if (replay) {
        log('order_replayed', { reference: replay.reference });
        return c.json({ reference: replay.reference, statusToken: replay.statusToken, ...(replay.isTest ? { test: true } : {}) }, 201);
      }

      const emailKey = hashKey(deps.keys.pepper, normaliseEmail(form.input.email));
      const emailCheck = await checkLimit(deps.db, limits.orderEmail, emailKey, at);
      if (!emailCheck.ok) return limited(c, emailCheck.retryAfterSeconds, limits.orderEmail.bucket, emailKey);

      // SCRUM-63: a code on the order counts as a check, so submitting can't be used to guess codes.
      if (form.discountCode) {
        const r = await checkLimit(deps.db, limits.discountIp, ipKey, at);
        if (!r.ok) return limited(c, r.retryAfterSeconds, limits.discountIp.bucket, ipKey);
        await recordEvent(deps.db, limits.discountIp.bucket, ipKey, at);
      }

      const checked = await validateAndProcess(form);
      if (checked.errors) return c.json({ errors: checked.errors }, 400);

      let order;
      try {
        order = await createOrder(
          { db: deps.db, photos: deps.photos, isProduction: deps.isProduction, now },
          form.input,
          checked.photos,
          form.idempotencyKey,
          form.discountCode,
        );
      } catch (err) {
        if (!(err instanceof DiscountRefusedError)) throw err;
        // Counted, never the code itself (SCRUM-63 AC8).
        log('discount_refused', { at: 'submit', reason: err.reason });
        return c.json({ errors: { discountCode: DISCOUNT_REFUSED } }, 400);
      }
      if (!order.replay) {
        await recordEvent(deps.db, limits.orderIp.bucket, ipKey, at);
        await recordEvent(deps.db, limits.orderEmail.bucket, emailKey, at);
      }
      log(order.replay ? 'order_replayed' : 'order_created', {
        reference: order.reference,
        paddles: form.input.paddles.length,
        ms: Date.now() - started,
        test: order.isTest,
      });
      return c.json({ reference: order.reference, statusToken: order.statusToken, ...(order.isTest ? { test: true } : {}) }, 201);
    },
  );

  app.post('/status', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const view = await lookupStatus(deps.db, body?.token, now(), { paymentsOn: !!deps.payments });
    return view ? c.json(view) : c.json(INVALID_LINK, 404);
  });

  // SCRUM-84: a receipt or credit note, for its printable page on the site.
  app.post('/document', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; number?: unknown } | null;
    const doc = await lookupDocument(deps.db, body?.token, body?.number, now());
    return doc ? c.json(doc) : c.json(INVALID_LINK, 404);
  });

  app.post('/links', async (c) => {
    const at = now();
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
    const email = typeof body?.email === 'string' ? body.email : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254) {
      return c.json({ errors: { email: 'Enter a valid email address.' } }, 400);
    }
    const ipKey = await ipHash(c);
    const emailKey = hashKey(deps.keys.pepper, normaliseEmail(email));
    for (const [limit, key] of [[limits.linksIp, ipKey], [limits.linksEmail, emailKey]] as const) {
      const r = await checkLimit(deps.db, limit, key, at);
      if (!r.ok) return limited(c, r.retryAfterSeconds, limit.bucket, key);
    }
    await recordEvent(deps.db, limits.linksIp.bucket, ipKey, at);
    await recordEvent(deps.db, limits.linksEmail.bucket, emailKey, at);
    try {
      const outcome = await requestLinks(deps.db, email, at, deps.mailer);
      log('links_requested', { orders: outcome.orders, sent: outcome.sent, mailer: deps.mailer ? 'on' : 'off' });
    } catch (err) {
      // Still the same answer: whether the address has orders must never show.
      logError('links_failed', err);
    }
    return c.json({ message: 'If we have orders for that address, we’ve emailed the links.' }, 202);
  });

  // SCRUM-82: Pay now. The token proves it's the customer's order; the service makes a fresh
  // Checkout Session for the total saved at Accept and the browser goes to Stripe's page.
  const NOT_SET_UP = { error: 'payments_unavailable', message: 'Online payment isn’t available yet. Please email sales@picklemypaddle.com and we’ll sort it out.' };
  app.post('/pay', async (c) => {
    const at = now();
    const ipKey = await ipHash(c);
    const r = await checkLimit(deps.db, limits.payIp, ipKey, at);
    if (!r.ok) return limited(c, r.retryAfterSeconds, limits.payIp.bucket, ipKey);
    await recordEvent(deps.db, limits.payIp.bucket, ipKey, at);
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const order = await orderForToken(deps.db, body?.token, at);
    if (!order) return c.json(INVALID_LINK, 404);
    if (!deps.payments) return c.json(NOT_SET_UP, 503);
    const origins = deps.siteOrigins ?? [];
    const origin = origins.find((o) => o === c.req.header('origin')) ?? origins[0];
    if (!origin) return c.json(NOT_SET_UP, 503);
    try {
      const { url } = await startPayment(deps.payments, order.id, origin);
      return c.json({ url });
    } catch (err) {
      if (err instanceof PaymentError) return c.json({ error: err.code, message: err.message }, err.httpStatus);
      if (err instanceof StripeError) {
        log('payment_start_failed', { code: err.code });
        return c.json({ error: 'stripe_unavailable', message: 'We couldn’t start the payment just now. Please try again in a minute.' }, 502);
      }
      throw err;
    }
  });

  // SCRUM-82: back from Checkout. The service asks Stripe itself (server to server) and applies
  // the session, so the customer sees "Paid" at once; the poller and webhook would get there too.
  app.post('/paid', async (c) => {
    const at = now();
    const ipKey = await ipHash(c);
    const r = await checkLimit(deps.db, limits.payIp, ipKey, at);
    if (!r.ok) return limited(c, r.retryAfterSeconds, limits.payIp.bucket, ipKey);
    await recordEvent(deps.db, limits.payIp.bucket, ipKey, at);
    if (!deps.payments) return c.json(NOT_SET_UP, 503);
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === 'string' && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(body.sessionId) ? body.sessionId : null;
    if (!sessionId) return c.json({ paid: false }, 404);
    try {
      const session = await deps.payments.stripe.getCheckoutSession(sessionId);
      const outcome = await applySession(deps.payments, session, 'return');
      const { rows } = await deps.db.query<{ reference: string }>(
        'SELECT o.reference FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.checkout_session_id = $1 AND p.problem IS NULL',
        [sessionId],
      );
      return c.json(rows[0] ? { paid: true, reference: rows[0].reference } : { paid: false, ...(outcome === 'flagged' ? { review: true } : {}) });
    } catch (err) {
      if (err instanceof StripeError) {
        log('payment_return_failed', { code: err.code });
        return c.json({ paid: false }, err.status === 404 ? 404 : 502);
      }
      throw err;
    }
  });

  // SCRUM-33: a review from the private status page. Needs the order's live link, and the
  // paddles on their way back; one per order.
  app.post(
    '/review',
    bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'too_large', message: 'That review is too long.' }, 413) }),
    async (c) => {
      const at = now();
      const ipKey = await ipHash(c);
      const r = await checkLimit(deps.db, limits.reviewIp, ipKey, at);
      if (!r.ok) return limited(c, r.retryAfterSeconds, limits.reviewIp.bucket, ipKey);
      await recordEvent(deps.db, limits.reviewIp.bucket, ipKey, at);

      const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const outcome = await submitReview(deps.db, {
        token: body.token, quote: body.quote, firstName: body.firstName, suburb: body.suburb, permission: body.permission,
      }, at);
      if (outcome.ok) {
        log('review_received', { reference: outcome.reference, permission: outcome.permission });
        return c.json({ message: 'Thanks! We’ve got your review.' }, 201);
      }
      if (outcome.reason === 'invalid_link') return c.json(INVALID_LINK, 404);
      if (outcome.reason === 'invalid') return c.json({ errors: outcome.errors }, 400);
      if (outcome.reason === 'not_yet') {
        return c.json({ error: 'not_yet', message: 'You can leave a review once your paddle is on its way back to you.' }, 409);
      }
      return c.json({ error: 'already_received', message: 'We’ve already got a review for this order. Thank you!' }, 409);
    },
  );

  return app;
}

/**
 * SCRUM-63: the form's check of a discount code, for the estimate. Rate-limited per IP; refusals
 * all get the same message and are logged by reason only, never with the code.
 */
export function discountRoutes(deps: Pick<OrderRouteDeps, 'db' | 'keys' | 'trusted' | 'now' | 'peer'> & { checksPerIpHour: number }) {
  const now = deps.now ?? (() => new Date());
  const peer = deps.peer ?? nodePeer;
  const limit: Limit = { bucket: 'discount-ip', max: deps.checksPerIpHour, windowMs: HOUR };
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.post(
    '/check',
    bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }),
    async (c) => {
      const at = now();
      const ipKey = hashKey(deps.keys.pepper, await clientIp(peer(c), c.req.header('x-forwarded-for'), deps.trusted));
      const r = await checkLimit(deps.db, limit, ipKey, at);
      if (!r.ok) {
        log('rate_limited', { bucket: limit.bucket, key: ipKey.slice(0, 12) });
        c.header('Retry-After', String(r.retryAfterSeconds));
        return c.json({ error: 'rate_limited', message: RATE_MESSAGE, retryAfter: r.retryAfterSeconds }, 429);
      }
      await recordEvent(deps.db, limit.bucket, ipKey, at);
      const body = (await c.req.json().catch(() => null)) as { code?: unknown; email?: unknown } | null;
      const code = typeof body?.code === 'string' ? body.code.slice(0, 64) : '';
      const email = typeof body?.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ? normaliseEmail(body.email) : null;
      const result = await checkCode(deps.db, code, { now: at, emailNorm: email });
      if (!result.ok) {
        log('discount_refused', { at: 'check', reason: result.reason });
        return c.json({ valid: false, message: DISCOUNT_REFUSED });
      }
      return c.json({ valid: true, code: result.code.code, kind: result.benefit.kind, value: result.benefit.value, label: describeDiscount(result.benefit) });
    },
  );
  return app;
}

/**
 * SCRUM-82: Stripe's webhook, production only (Stripe can't reach home-server). Raw body, signature
 * checked with STRIPE_WEBHOOK_SECRET; a bad signature is 400 and changes nothing.
 */
export function stripeWebhookRoutes(deps: { payments: PaymentDeps; secret: string }) {
  const app = new Hono();
  app.post(
    '/webhook',
    bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }),
    async (c) => {
      const raw = await c.req.text();
      if (!verifyWebhook(deps.secret, c.req.header('stripe-signature'), raw, deps.payments.now())) {
        log('stripe_webhook_refused', { reason: 'signature' });
        return c.json({ error: 'bad_signature' }, 400);
      }
      let event: StripeEvent;
      try {
        event = JSON.parse(raw) as StripeEvent;
      } catch {
        return c.json({ error: 'bad_json' }, 400);
      }
      if (typeof event?.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) return c.json({ error: 'bad_event' }, 400);
      const outcome = await applyEvent(deps.payments, event, 'webhook');
      log('stripe_webhook', { type: event.type, outcome });
      return c.json({ received: true });
    },
  );
  return app;
}

/** Exposed for /api/status. */
export type { Db };
