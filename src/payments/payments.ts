/**
 * Paying for an accepted order with Stripe Checkout (SCRUM-82, decided 30 Oct and 2 Nov 2026).
 *
 *  - Emails never carry a Stripe URL (Checkout links expire). The status page's Pay now posts the
 *    status token; startPayment makes a fresh Checkout Session for the total saved at Accept and
 *    expires the order's earlier open ones.
 *  - A coded order shows a net re-grit line ("…(code FREE-…: A$60 off)", possibly A$0) and the
 *    return postage: Checkout can't show a negative line, and no Stripe coupons are made.
 *  - A payment is recognised three ways, all through applySession, which is idempotent on the
 *    session id: the return from Checkout, the webhook (production only) and the events poller.
 *  - Paid is set through transitionWith (actor "stripe") in the same transaction as the payment
 *    row. A payment whose amount doesn't match the saved total, or that arrives for an order no
 *    longer Accepted, is recorded with a problem for Attila and the status doesn't move.
 *  - SCRUM-84: Paid issues the order's receipt (and its email) in the same transaction; each
 *    refund issues a credit note, and a refund in full moves the order to Refunded.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { log } from '../log.js';
import { TransitionError, transitionWith } from '../orders/transitions.js';
import { enqueueOrderEmail } from '../email/outbox.js';
import type { OrderStatus } from '../orders/model.js';
import { DEFAULT_SELLER, issueCreditNote, issueReceipt, type Seller } from '../documents/documents.js';
import type { Charge, CheckoutSession, FormValue, StripeApi, StripeEvent } from './stripe.js';
import { applyClubSession, CLUB_SESSION_PREFIX } from '../clubs/payments.js';

export interface PaymentDeps {
  db: Db;
  stripe: StripeApi;
  isProduction: boolean;
  now: () => Date;
  /** SCRUM-84: who issues receipts and credit notes. Default: DEFAULT_SELLER (no ABN yet). */
  seller?: Seller;
}

export type PaymentSource = 'return' | 'webhook' | 'poller' | 'test';

/** How long a Checkout Session stays open (Stripe allows 30 minutes to 24 hours). */
export const SESSION_MINUTES = 120;

const dollars = (cents: number) => `A$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export interface PayableOrder {
  id: string;
  reference: string;
  email: string;
  paddles: number;
  subtotalCents: number;
  discountCents: number;
  discountCode: string | null;
  postageCents: number;
  amountCents: number;
}

/** The Checkout Session for an order: line items that add up to the saved total, in AUD. */
export function checkoutParams(o: PayableOrder, urls: { success: string; cancel: string }, now: Date): Record<string, FormValue> {
  const regrit = o.subtotalCents - o.discountCents;
  const paddles = `${o.paddles} ${o.paddles === 1 ? 'paddle' : 'paddles'}`;
  const regritName = o.discountCents > 0 && o.discountCode
    ? `Re-grit, ${paddles}, both faces (code ${o.discountCode}: ${dollars(o.discountCents)} off)`
    : `Re-grit, ${paddles}, both faces`;
  const line = (name: string, cents: number) => ({ quantity: 1, price_data: { currency: 'aud', unit_amount: cents, product_data: { name } } });
  const items = [line(regritName, regrit), ...(o.postageCents > 0 ? [line('Return postage', o.postageCents)] : [])];
  if (items.reduce((sum, i) => sum + i.price_data.unit_amount, 0) !== o.amountCents) {
    throw new Error('line items do not add up to the saved total');
  }
  return {
    mode: 'payment',
    client_reference_id: o.id,
    customer_email: o.email,
    line_items: items,
    metadata: { reference: o.reference, order_id: o.id },
    payment_intent_data: { description: `PickleMyPaddle ${o.reference}`, metadata: { reference: o.reference, order_id: o.id } },
    success_url: urls.success,
    cancel_url: urls.cancel,
    submit_type: 'pay',
    expires_at: Math.floor(now.getTime() / 1000) + SESSION_MINUTES * 60,
  };
}

export class PaymentError extends Error {
  constructor(
    readonly httpStatus: 404 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * Pay now: a fresh Checkout Session for an Accepted order, returning Stripe's page to send the
 * browser to. Older open sessions for the order are expired first, so only one can be paid.
 */
export async function startPayment(deps: PaymentDeps, orderId: string, origin: string): Promise<{ url: string; reference: string }> {
  const now = deps.now();
  const { rows } = await deps.db.query<{
    id: string; reference: string; status: OrderStatus; email: string; paddles: number; subtotal_cents: number | null;
    discount_cents: number; discount_code: string | null; postage_cents: number | null; amount_cents: number | null;
  }>(
    `SELECT o.id, o.reference, o.status, o.email, (SELECT count(*)::int FROM paddles p WHERE p.order_id = o.id) AS paddles,
            o.subtotal_cents, o.discount_cents, o.discount_code, o.postage_cents, o.amount_cents
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  const o = rows[0];
  if (!o) throw new PaymentError(404, 'not_found', 'This link isn’t valid or has expired.');
  if (o.status === 'paid' || (await paidPayment(deps.db, o.id))) {
    throw new PaymentError(409, 'already_paid', 'This order has already been paid. Thank you!');
  }
  if (o.status !== 'accepted' || o.amount_cents === null || o.subtotal_cents === null || o.postage_cents === null) {
    throw new PaymentError(409, 'not_payable', 'This order can’t be paid at the moment. If you think it should be, email sales@picklemypaddle.com.');
  }

  const { rows: open } = await deps.db.query<{ id: string }>(
    'SELECT id FROM stripe_sessions WHERE order_id = $1 AND expired_at IS NULL AND expires_at > $2',
    [o.id, now],
  );
  for (const s of open) {
    try {
      const expired = await deps.stripe.expireCheckoutSession(s.id);
      // Completed meanwhile? Then it's paid: apply it rather than taking a second payment.
      if (expired.status === 'complete') {
        await applySession(deps, expired, 'return');
        throw new PaymentError(409, 'already_paid', 'This order has already been paid. Thank you!');
      }
    } catch (err) {
      if (err instanceof PaymentError) throw err;
      // Already expired or completed on Stripe's side: check it, so a completed one is never missed.
      const session = await deps.stripe.getCheckoutSession(s.id).catch(() => null);
      if (session?.status === 'complete' && session.payment_status === 'paid') {
        await applySession(deps, session, 'return');
        throw new PaymentError(409, 'already_paid', 'This order has already been paid. Thank you!');
      }
    }
    await deps.db.query('UPDATE stripe_sessions SET expired_at = $2 WHERE id = $1', [s.id, now]);
  }

  const params = checkoutParams(
    {
      id: o.id, reference: o.reference, email: o.email, paddles: Number(o.paddles), subtotalCents: Number(o.subtotal_cents),
      discountCents: Number(o.discount_cents), discountCode: o.discount_code, postageCents: Number(o.postage_cents), amountCents: Number(o.amount_cents),
    },
    { success: `${origin}/order/paid?session_id={CHECKOUT_SESSION_ID}`, cancel: `${origin}/order/status?payment=cancelled` },
    now,
  );
  const session = await deps.stripe.createCheckoutSession(params, `pmp-pay-${o.id}-${now.getTime()}`);
  if (!session.url) throw new PaymentError(502, 'no_url', 'We couldn’t start the payment. Please try again in a minute.');
  await deps.db.query(
    'INSERT INTO stripe_sessions (id, order_id, amount_cents, created_at, expires_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
    [session.id, o.id, Number(o.amount_cents), now, new Date(session.expires_at * 1000)],
  );
  log('payment_started', { reference: o.reference, session: session.id.slice(0, 16) });
  return { url: session.url, reference: o.reference };
}

async function paidPayment(q: Queryable, orderId: string): Promise<boolean> {
  const { rows } = await q.query('SELECT 1 FROM payments WHERE order_id = $1 AND problem IS NULL LIMIT 1', [orderId]);
  return rows.length > 0;
}

export type ApplyOutcome = 'paid' | 'already' | 'not_paid' | 'flagged' | 'not_ours';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies a completed Checkout Session once, however it arrived. Returns what happened.
 * The fee comes from the charge's balance transaction (null if Stripe hasn't made it yet).
 */
export async function applySession(deps: PaymentDeps, session: CheckoutSession, source: PaymentSource): Promise<ApplyOutcome> {
  // SCRUM-85: a club invoice's Checkout Session.
  if (session.client_reference_id?.startsWith(CLUB_SESSION_PREFIX)) return applyClubSession(deps, session, source);
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || !session.payment_intent) return 'not_paid';
  const orderId = session.client_reference_id;
  if (!orderId || !UUID_RE.test(orderId)) return 'not_ours';
  const { rows: seen } = await deps.db.query('SELECT 1 FROM payments WHERE checkout_session_id = $1', [session.id]);
  if (seen.length > 0) return 'already';

  const pi = await deps.stripe.getPaymentIntent(session.payment_intent);
  const charge = pi.latest_charge;
  const fee = charge?.balance_transaction?.fee ?? null;
  const paidAt = new Date((charge?.created ?? pi.created) * 1000);
  const now = deps.now();

  return deps.db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; reference: string; status: OrderStatus; amount_cents: number | null }>(
      'SELECT id, reference, status, amount_cents FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    const order = rows[0];
    const amount = session.amount_total ?? 0;
    const problem = !order
      ? 'order_missing'
      : session.currency !== 'aud' || order.amount_cents === null || amount !== Number(order.amount_cents)
        ? 'amount_mismatch'
        : order.status !== 'accepted'
          ? `order_${order.status}`
          : null;
    const { rows: inserted } = await q.query<{ id: string }>(
      `INSERT INTO payments (order_id, checkout_session_id, payment_intent_id, amount_cents, currency, fee_cents, paid_at,
                             recorded_at, source, livemode, problem, refunded_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (checkout_session_id) DO NOTHING RETURNING id`,
      [order ? order.id : null, session.id, pi.id, amount, session.currency ?? '', fee, paidAt, now, source, session.livemode, problem,
        charge?.amount_refunded ?? 0],
    );
    if (inserted.length === 0) return 'already';
    if (problem) {
      // Attila sorts it out in the Stripe dashboard; the admin shows it on the order.
      log('payment_flagged', { reference: order?.reference ?? null, problem, source });
      if (order) {
        await q.query('INSERT INTO order_notes (order_id, at, author, note) VALUES ($1, $2, $3, $4)', [
          order.id, now, 'stripe',
          `Stripe payment ${pi.id} of ${dollars(amount)} wasn’t applied: ${problemText(problem)}. ${
            REINSTATABLE.has(problem) ? 'Reinstate the order as paid, or refund it in Stripe.' : 'Check it in the Stripe dashboard; refund it there if needed.'
          }`,
        ]);
        // SCRUM-83: Attila hears about it (reference and admin link only).
        await enqueueOrderEmail(q, order.id, 'alert_payment', now, { problem: problemText(problem) });
      }
      return 'flagged';
    }
    await transitionWith(q, { isProduction: deps.isProduction, now }, {
      reference: order!.reference,
      to: 'paid',
      actor: 'stripe',
      note: `Paid ${dollars(amount)} by card (Stripe ${pi.id}, via ${source}).`,
    });
    // SCRUM-84: the receipt and its email, with the Paid.
    await issueReceipt(q, { orderId: order!.id, paymentId: String(inserted[0]!.id), seller: deps.seller ?? DEFAULT_SELLER, now });
    log('payment_applied', { reference: order!.reference, source });
    return 'paid';
  });
}

/** Statuses a refund in full moves to Refunded (an order with a receipt: it was paid). */
const REFUNDABLE: ReadonlySet<OrderStatus> = new Set(['paid', 'in_queue', 'regritted', 'posted_back', 'completed', 'withdrawn']);

/**
 * charge.refunded: records the refunded total against the payment. SCRUM-84: the newly refunded
 * part gets a credit note against the receipt (and the "Refund issued" email); refunded in full,
 * the order moves to Refunded. A flagged payment that was never applied has no receipt, so only
 * the amount is recorded.
 */
export async function recordRefund(deps: PaymentDeps, charge: Charge): Promise<boolean> {
  if (!charge.payment_intent) return false;
  const now = deps.now();
  return deps.db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; order_id: string | null; amount_cents: number; refunded_cents: number }>(
      'SELECT id, order_id, amount_cents, refunded_cents FROM payments WHERE payment_intent_id = $1 FOR UPDATE',
      [charge.payment_intent],
    );
    const payment = rows[0];
    if (!payment || Number(payment.refunded_cents) === charge.amount_refunded) return false;
    const before = Number(payment.refunded_cents);
    await q.query('UPDATE payments SET refunded_cents = $2, refunded_at = $3 WHERE id = $1', [payment.id, charge.amount_refunded, now]);
    const full = charge.refunded || charge.amount_refunded >= Number(payment.amount_cents);
    if (payment.order_id) {
      await q.query('INSERT INTO order_notes (order_id, at, author, note) VALUES ($1, $2, $3, $4)', [
        payment.order_id, now, 'stripe',
        `Refund recorded from Stripe: ${dollars(charge.amount_refunded)} refunded in total${full ? ' (in full)' : ''}.`,
      ]);
    }
    const added = charge.amount_refunded - before;
    const note = added > 0 ? await issueCreditNote(q, { paymentId: String(payment.id), cents: added, full, seller: deps.seller ?? DEFAULT_SELLER, now }) : null;
    if (note && full && payment.order_id) {
      const { rows: o } = await q.query<{ reference: string; status: OrderStatus }>('SELECT reference, status FROM orders WHERE id = $1', [payment.order_id]);
      if (o[0] && REFUNDABLE.has(o[0].status)) {
        await transitionWith(q, { isProduction: deps.isProduction, now }, {
          reference: o[0].reference, to: 'refunded', actor: 'stripe', note: `Refunded in full in Stripe (${dollars(charge.amount_refunded)}).`,
        });
      }
    }
    log('payment_refund_recorded', { full, creditNote: !!note });
    return true;
  });
}

/** One Stripe event (from the webhook or the poller), applied once. */
export async function applyEvent(deps: PaymentDeps, event: StripeEvent, source: 'webhook' | 'poller'): Promise<string> {
  if (event.livemode !== deps.stripe.livemode) return 'wrong_mode';
  const { rows: seen } = await deps.db.query('SELECT 1 FROM stripe_events WHERE id = $1', [event.id]);
  if (seen.length > 0) return 'already';
  let outcome = 'ignored';
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    outcome = await applySession(deps, event.data.object as CheckoutSession, source);
  } else if (event.type === 'charge.refunded') {
    outcome = (await recordRefund(deps, event.data.object as Charge)) ? 'refund' : 'refund_unknown';
  }
  await deps.db.query('INSERT INTO stripe_events (id, type, source, received_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [
    event.id, event.type, source, deps.now(),
  ]);
  return outcome;
}

/** Why a payment wasn't applied, in plain words (admin, notes, Attila's alert). */
export const PROBLEM_TEXT: Record<string, string> = {
  amount_mismatch: 'the amount paid isn’t the order’s total',
  order_missing: 'there is no such order',
  order_lapsed: 'it arrived after the order lapsed',
  order_withdrawn: 'it arrived after the order was withdrawn',
  order_paid: 'the order was already paid (a second payment)',
};
export const problemText = (problem: string) => PROBLEM_TEXT[problem] ?? `the order was ${problem.replace(/^order_/, '').replace('_', ' ')}`;

/** SCRUM-83: late payments Attila may reinstate (the order moves to Paid). */
export const REINSTATABLE: ReadonlySet<string> = new Set(['order_lapsed', 'order_withdrawn']);

/**
 * SCRUM-83: Attila accepts a late payment: the Lapsed or Withdrawn order moves to Paid (admin,
 * with his note), the payment is marked reinstated, and a discount code use given back at the
 * lapse is taken again. Refused unless a late payment, not refunded in full, is on the order.
 */
export async function reinstateLatePayment(
  db: Db, reference: string, by: string, note: string, deps: { isProduction: boolean; now: Date; seller?: Seller },
): Promise<void> {
  const text = note.trim();
  if (!text) throw new TransitionError(400, 'note_required', 'Say why you’re reinstating it (kept in the history).');
  if (text.length > 2000) throw new TransitionError(400, 'reason_too_long', 'Keep the note under 2000 characters.');
  await db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; status: OrderStatus }>('SELECT id, status FROM orders WHERE reference = $1 FOR UPDATE', [reference]);
    const order = rows[0];
    if (!order) throw new TransitionError(404, 'not_found', 'No such order.');
    const { rows: late } = await q.query<{ id: string; payment_intent_id: string | null; amount_cents: number }>(
      `SELECT id, payment_intent_id, amount_cents FROM payments
        WHERE order_id = $1 AND problem = ANY($2::text[]) AND refunded_cents < amount_cents ORDER BY paid_at LIMIT 1`,
      [order.id, [...REINSTATABLE]],
    );
    const payment = late[0];
    if (!payment || (order.status !== 'lapsed' && order.status !== 'withdrawn')) {
      throw new TransitionError(409, 'nothing_to_reinstate', 'Only a Lapsed or Withdrawn order with a late payment (not refunded) can be reinstated.');
    }
    await transitionWith(q, { isProduction: deps.isProduction, now: deps.now }, {
      reference, to: 'paid', actor: 'admin', reinstate: true,
      note: `Reinstated as paid by ${by} (Stripe ${payment.payment_intent_id ?? 'payment'}, ${dollars(Number(payment.amount_cents))}): ${text}`,
    });
    await q.query('UPDATE payments SET problem = NULL, reinstated_at = $2, reinstated_by = $3 WHERE id = $1', [payment.id, deps.now, by]);
    await q.query(`UPDATE discount_uses SET state = 'consumed', settled_at = $2 WHERE order_id = $1 AND state = 'released'`, [order.id, deps.now]);
    // SCRUM-84: the receipt and its email, as for any Paid.
    await issueReceipt(q, { orderId: order.id, paymentId: String(payment.id), seller: deps.seller ?? DEFAULT_SELLER, now: deps.now });
  });
  log('payment_reinstated', { reference });
}

// ── Events poller ─────────────────────────────────────────────────────────────

const CURSOR = 'stripe-events-cursor';
/** On the very first run, look back this far (Stripe keeps events 30 days). */
export const FIRST_LOOKBACK_DAYS = 7;

/**
 * Asks Stripe for payment events since the last one seen (staging's only feed; production's
 * backstop for a missed webhook). Outbound only. Events are applied oldest first.
 */
export async function pollEvents(deps: PaymentDeps): Promise<{ events: number; applied: number }> {
  const { rows } = await deps.db.query<{ value: string }>('SELECT value FROM job_state WHERE name = $1', [CURSOR]);
  let cursor = rows[0]?.value ?? null;
  const batch: StripeEvent[] = [];
  if (cursor === null) {
    const since = Math.floor(deps.now().getTime() / 1000) - FIRST_LOOKBACK_DAYS * 24 * 60 * 60;
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await deps.stripe.listEvents({ createdGte: since, startingAfter: after });
      batch.push(...res.data);
      if (!res.has_more || res.data.length === 0) break;
      after = res.data[res.data.length - 1]!.id;
    }
    batch.reverse(); // Stripe lists newest first
  } else {
    for (let page = 0; page < 20; page++) {
      const res = await deps.stripe.listEvents({ endingBefore: cursor });
      if (res.data.length === 0) break;
      batch.push(...[...res.data].reverse());
      cursor = res.data[0]!.id;
      if (!res.has_more) break;
    }
  }
  let applied = 0;
  for (const event of batch) {
    const outcome = await applyEvent(deps, event, 'poller');
    if (outcome === 'paid' || outcome === 'refund') applied++;
    // Saved after each event, so a failure resumes from the last one done.
    await deps.db.query(
      `INSERT INTO job_state (name, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [CURSOR, event.id, deps.now()],
    );
  }
  await fillMissingFees(deps);
  return { events: batch.length, applied };
}

/** How long after a payment to keep asking Stripe for its fee. */
export const FEE_BACKFILL_DAYS = 7;

/**
 * Stripe may not have made a charge's balance transaction (which carries the fee) when the
 * customer comes straight back from Checkout, so the payment is saved without a fee. Each poll
 * asks again for recent payments still missing one (found 3 Nov 2026 on staging).
 */
export async function fillMissingFees(deps: PaymentDeps): Promise<number> {
  const since = new Date(deps.now().getTime() - FEE_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await deps.db.query<{ id: string; payment_intent_id: string }>(
    'SELECT id, payment_intent_id FROM payments WHERE fee_cents IS NULL AND payment_intent_id IS NOT NULL AND recorded_at > $1 ORDER BY id LIMIT 20',
    [since],
  );
  let filled = 0;
  for (const p of rows) {
    try {
      const fee = (await deps.stripe.getPaymentIntent(p.payment_intent_id)).latest_charge?.balance_transaction?.fee;
      if (typeof fee === 'number') {
        await deps.db.query('UPDATE payments SET fee_cents = $2 WHERE id = $1 AND fee_cents IS NULL', [p.id, fee]);
        filled++;
      }
    } catch {
      log('payment_fee_lookup_failed', { payment: Number(p.id) });
    }
  }
  if (filled) log('payment_fees_filled', { payments: filled });
  return filled;
}

// ── Webhook signature ─────────────────────────────────────────────────────────

/** Stripe's default tolerance for the signature timestamp. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Checks a `Stripe-Signature` header (`t=…,v1=…[,v1=…]`) against the raw body: HMAC-SHA256 of
 * `<t>.<body>` with the endpoint secret, and a timestamp within 5 minutes.
 */
export function verifyWebhook(secret: string, header: string | undefined, rawBody: string, now: Date): boolean {
  if (!header) return false;
  let t: number | null = null;
  const sigs: Buffer[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d{1,12}$/.test(v)) t = Number(v);
    if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) sigs.push(Buffer.from(v, 'hex'));
  }
  if (t === null || sigs.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

/** A header Stripe would send, for tests (and nothing else). */
export function signWebhook(secret: string, rawBody: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex')}`;
}

// ── Reading payments (status page, admin) ─────────────────────────────────────

export interface PaymentRecord {
  checkoutSessionId: string;
  paymentIntentId: string | null;
  amountCents: number;
  feeCents: number | null;
  paidAt: Date;
  source: PaymentSource;
  livemode: boolean;
  problem: string | null;
  refundedCents: number;
  refundedAt: Date | null;
  reinstatedAt: Date | null;
  reinstatedBy: string | null;
}

export async function paymentsOf(q: Queryable, orderId: string): Promise<PaymentRecord[]> {
  const { rows } = await q.query<{
    checkout_session_id: string; payment_intent_id: string | null; amount_cents: number; fee_cents: number | null; paid_at: Date;
    source: PaymentSource; livemode: boolean; problem: string | null; refunded_cents: number; refunded_at: Date | null;
    reinstated_at: Date | null; reinstated_by: string | null;
  }>(
    `SELECT checkout_session_id, payment_intent_id, amount_cents, fee_cents, paid_at, source, livemode, problem, refunded_cents, refunded_at,
            reinstated_at, reinstated_by
       FROM payments WHERE order_id = $1 ORDER BY paid_at`,
    [orderId],
  );
  return rows.map((r) => ({
    checkoutSessionId: r.checkout_session_id,
    paymentIntentId: r.payment_intent_id,
    amountCents: Number(r.amount_cents),
    feeCents: r.fee_cents === null ? null : Number(r.fee_cents),
    paidAt: new Date(r.paid_at),
    source: r.source,
    livemode: r.livemode,
    problem: r.problem,
    refundedCents: Number(r.refunded_cents),
    refundedAt: r.refunded_at ? new Date(r.refunded_at) : null,
    reinstatedAt: r.reinstated_at ? new Date(r.reinstated_at) : null,
    reinstatedBy: r.reinstated_by,
  }));
}

/** The Stripe dashboard page for a payment. */
export function dashboardUrl(p: Pick<PaymentRecord, 'paymentIntentId' | 'livemode'>): string | null {
  return p.paymentIntentId ? `https://dashboard.stripe.com/${p.livemode ? '' : 'test/'}payments/${p.paymentIntentId}` : null;
}
