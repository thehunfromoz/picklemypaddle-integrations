/**
 * Paying club invoices (SCRUM-85, part 2).
 *
 *  - PayID or cash: Attila records each payment in the admin (amount, date, method, reference).
 *  - Card: "Pay by card" on the invoice's private page makes a Stripe Checkout Session for what is
 *    still owing, the same way as orders (SCRUM-82). The payment is recognised from the Checkout
 *    return, the events poller or (production) the webhook, all through applyClubSession, which is
 *    idempotent on the session id.
 *  - Part payments are fine. Once the payments reach the invoice's total, the invoice gets its paid
 *    state (once, as the documents trigger allows) and the batch moves to Paid. A payment that
 *    would take it past the total is refused (by hand) or recorded with a problem (by card).
 */
import type { Db, Queryable } from '../db/db.js';
import { log } from '../log.js';
import { sydneyDate, ISO_DATE_RE } from '../orders/dates.js';
import { hashToken, TOKEN_RE } from '../orders/model.js';
import type { CheckoutSession, FormValue } from '../payments/stripe.js';
import { PaymentError, SESSION_MINUTES, type ApplyOutcome, type PaymentDeps, type PaymentSource } from '../payments/payments.js';
import { CLUB_LINK_DAYS } from '../documents/documents.js';
import { ClubError } from './clubs.js';
import { enqueueClubCrmSync } from '../crm/sync.js';

export type ClubPaymentMethod = 'payid' | 'cash' | 'card';
export const METHOD_LABELS: Record<ClubPaymentMethod, string> = { payid: 'PayID', cash: 'cash', card: 'card' };

export interface ClubPayment {
  id: string;
  method: ClubPaymentMethod;
  amountCents: number;
  paidOn: string;
  reference: string | null;
  recordedBy: string;
  recordedAt: Date;
}

/** The prefix of client_reference_id on a club invoice's Checkout Session. */
export const CLUB_SESSION_PREFIX = 'club-inv-';

const dollars = (cents: number) => `A$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

// ── Reading ───────────────────────────────────────────────────────────────────

export async function paymentsOfInvoice(q: Queryable, documentId: string): Promise<ClubPayment[]> {
  const { rows } = await q.query<{ id: string; method: ClubPaymentMethod; amount_cents: number; paid_on: string; reference: string | null; recorded_by: string; recorded_at: Date }>(
    `SELECT id, method, amount_cents, paid_on::text AS paid_on, reference, recorded_by, recorded_at FROM club_payments WHERE document_id = $1 ORDER BY paid_on, id`,
    [documentId],
  );
  return rows.map((r) => ({
    id: String(r.id), method: r.method, amountCents: Number(r.amount_cents), paidOn: r.paid_on, reference: r.reference, recordedBy: r.recorded_by, recordedAt: new Date(r.recorded_at),
  }));
}

/** What is still owing on a club invoice. */
export async function invoiceBalance(q: Queryable, documentId: string): Promise<{ totalCents: number; paidCents: number; balanceCents: number }> {
  const { rows } = await q.query<{ total: number; paid: number }>(
    `SELECT d.total_cents AS total, COALESCE((SELECT sum(amount_cents) FROM club_payments p WHERE p.document_id = d.id), 0)::int AS paid
       FROM documents d WHERE d.id = $1`,
    [documentId],
  );
  const r = rows[0];
  if (!r) throw new ClubError('no_invoice', 'No such invoice.');
  const totalCents = Number(r.total);
  const paidCents = Number(r.paid);
  return { totalCents, paidCents, balanceCents: totalCents - paidCents };
}

/** How the paid state reads on the invoice: "PayID", "card", or e.g. "PayID and card". */
function methodWords(methods: ClubPaymentMethod[]): string {
  const unique = [...new Set(methods)].map((m) => METHOD_LABELS[m]);
  return unique.length <= 1 ? unique[0] ?? 'payment' : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** Once the payments reach the total: the invoice's paid state (set once) and the batch to Paid. */
async function settle(q: Queryable, documentId: string, batchId: string, now: Date): Promise<boolean> {
  const { balanceCents } = await invoiceBalance(q, documentId);
  if (balanceCents > 0) return false;
  const pays = await paymentsOfInvoice(q, documentId);
  const lastDay = pays.reduce((d, p) => (p.paidOn > d ? p.paidOn : d), pays[0]?.paidOn ?? sydneyDate(now));
  await q.query(`UPDATE documents SET paid_on = $2::date, paid_method = $3 WHERE id = $1 AND paid_on IS NULL`, [documentId, lastDay, methodWords(pays.map((p) => p.method))]);
  const { rows } = await q.query<{ club_id: string }>(
    `UPDATE batches SET status = 'paid', status_changed_at = $2, updated_at = $2 WHERE id = $1 AND status = 'invoiced' RETURNING club_id`,
    [batchId, now],
  );
  if (rows[0]) await enqueueClubCrmSync(q, rows[0].club_id, now);
  return true;
}

// ── PayID and cash, by hand ───────────────────────────────────────────────────

export const MAX_PAYMENT_REFERENCE = 100;

/**
 * Records a PayID or cash payment against a batch's invoice (SCRUM-85 AC5). Part payments are
 * fine; more than is owing is refused. Returns whether the invoice is now paid in full.
 */
export async function recordClubPayment(
  db: Db,
  args: { batchReference: string; method: string; amountCents: number; paidOn: string; reference: string | null; by: string; now: Date },
): Promise<{ paidInFull: boolean; balanceCents: number }> {
  if (args.method !== 'payid' && args.method !== 'cash') throw new ClubError('bad_method', 'Choose PayID or cash (card payments come in from Stripe by themselves).');
  if (!Number.isInteger(args.amountCents) || args.amountCents < 1) throw new ClubError('bad_amount', 'Give the amount received, like 270 or 270.50.');
  if (!ISO_DATE_RE.test(args.paidOn) || !new Date(`${args.paidOn}T00:00:00Z`).toISOString().startsWith(args.paidOn)) throw new ClubError('bad_date', 'Give the date it was received.');
  if (args.paidOn > sydneyDate(args.now)) throw new ClubError('future_date', 'The date received can’t be in the future.');
  const reference = (args.reference ?? '').trim();
  if (reference.length > MAX_PAYMENT_REFERENCE) throw new ClubError('bad_reference', `The reference can be up to ${MAX_PAYMENT_REFERENCE} characters.`);
  return db.tx(async (q) => {
    const { rows } = await q.query<{ batch_id: string; document_id: string | null; status: string; collected_on: string }>(
      `SELECT b.id AS batch_id, d.id AS document_id, b.status, b.collected_on::text AS collected_on
         FROM batches b LEFT JOIN documents d ON d.batch_id = b.id AND d.kind = 'invoice'
        WHERE b.reference = $1 FOR UPDATE OF b`,
      [args.batchReference],
    );
    const b = rows[0];
    if (!b) throw new ClubError('no_batch', 'No such batch.');
    if (!b.document_id || b.status !== 'invoiced') throw new ClubError('not_owing', 'Only an invoiced batch that isn’t paid yet can take a payment.');
    if (args.paidOn < b.collected_on) throw new ClubError('bad_date', 'The date received can’t be before the batch was collected.');
    const { balanceCents } = await invoiceBalance(q, b.document_id);
    if (args.amountCents > balanceCents) throw new ClubError('too_much', `That’s more than is owing (${dollars(balanceCents)}).`);
    await q.query(
      `INSERT INTO club_payments (document_id, method, amount_cents, paid_on, reference, recorded_at, recorded_by) VALUES ($1, $2, $3, $4::date, $5, $6, $7)`,
      [b.document_id, args.method, args.amountCents, args.paidOn, reference || null, args.now, args.by],
    );
    const paidInFull = await settle(q, b.document_id, b.batch_id, args.now);
    log('club_payment_recorded', { batch: args.batchReference, method: args.method, paidInFull });
    return { paidInFull, balanceCents: balanceCents - args.amountCents };
  });
}

// ── Card, through Stripe Checkout ─────────────────────────────────────────────

interface PayableInvoice {
  id: string;
  number: string;
  batchId: string;
  batchReference: string;
  billingEmail: string;
}

/** The club invoice a private link opens (the same rule as viewing it), with what Checkout needs. */
export async function invoiceForToken(q: Queryable, token: unknown, number: unknown, now: Date): Promise<PayableInvoice | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token) || typeof number !== 'string' || !/^PMP-INV-\d{4,}$/.test(number)) return null;
  const { rows } = await q.query<{ id: string; number: string; batch_id: string; reference: string; billing_email: string }>(
    `SELECT d.id, d.number, b.id AS batch_id, b.reference, c.billing_email
       FROM document_tokens t JOIN documents d ON d.id = t.document_id JOIN batches b ON b.id = d.batch_id JOIN clubs c ON c.id = b.club_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.created_at > $2 AND d.number = $3 AND d.kind = 'invoice'`,
    [hashToken(token), new Date(now.getTime() - CLUB_LINK_DAYS * 86_400_000), number],
  );
  const r = rows[0];
  return r ? { id: String(r.id), number: r.number, batchId: r.batch_id, batchReference: r.reference, billingEmail: r.billing_email } : null;
}

export function clubCheckoutParams(
  inv: PayableInvoice & { balanceCents: number },
  urls: { success: string; cancel: string },
  now: Date,
): Record<string, FormValue> {
  return {
    mode: 'payment',
    client_reference_id: `${CLUB_SESSION_PREFIX}${inv.id}`,
    customer_email: inv.billingEmail,
    line_items: [{ quantity: 1, price_data: { currency: 'aud', unit_amount: inv.balanceCents, product_data: { name: `Club invoice ${inv.number} (batch ${inv.batchReference})` } } }],
    metadata: { invoice: inv.number, batch: inv.batchReference },
    payment_intent_data: { description: `PickleMyPaddle ${inv.number}`, metadata: { invoice: inv.number, batch: inv.batchReference } },
    success_url: urls.success,
    cancel_url: urls.cancel,
    submit_type: 'pay',
    expires_at: Math.floor(now.getTime() / 1000) + SESSION_MINUTES * 60,
  };
}

/**
 * Pay by card: a fresh Checkout Session for what is still owing on the invoice. Earlier open
 * sessions are expired first (one completed meanwhile is applied instead), so only one can be paid.
 */
export async function startClubPayment(deps: PaymentDeps, inv: PayableInvoice, origin: string): Promise<{ url: string }> {
  const now = deps.now();
  const { rows: open } = await deps.db.query<{ id: string }>('SELECT id FROM stripe_sessions WHERE document_id = $1 AND expired_at IS NULL AND expires_at > $2', [inv.id, now]);
  for (const s of open) {
    try {
      const expired = await deps.stripe.expireCheckoutSession(s.id);
      if (expired.status === 'complete') await applyClubSession(deps, expired, 'return');
    } catch {
      const session = await deps.stripe.getCheckoutSession(s.id).catch(() => null);
      if (session?.status === 'complete' && session.payment_status === 'paid') await applyClubSession(deps, session, 'return');
    }
    await deps.db.query('UPDATE stripe_sessions SET expired_at = $2 WHERE id = $1', [s.id, now]);
  }
  const { balanceCents } = await invoiceBalance(deps.db, inv.id);
  if (balanceCents <= 0) throw new PaymentError(409, 'already_paid', 'This invoice has been paid in full. Thank you!');
  const params = clubCheckoutParams(
    { ...inv, balanceCents },
    { success: `${origin}/club/paid?session_id={CHECKOUT_SESSION_ID}`, cancel: `${origin}/club/invoice?n=${inv.number}&payment=cancelled` },
    now,
  );
  const session = await deps.stripe.createCheckoutSession(params, `pmp-club-pay-${inv.id}-${now.getTime()}`);
  if (!session.url) throw new PaymentError(502, 'no_url', 'We couldn’t start the payment. Please try again in a minute.');
  await deps.db.query(
    'INSERT INTO stripe_sessions (id, document_id, amount_cents, created_at, expires_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
    [session.id, inv.id, balanceCents, now, new Date(session.expires_at * 1000)],
  );
  log('club_payment_started', { invoice: inv.number, session: session.id.slice(0, 16) });
  return { url: session.url };
}

/**
 * Applies a completed Checkout Session for a club invoice, once. More than is owing (or a
 * payment for an invoice already paid) is recorded with a problem and not applied, for Attila to
 * refund in the Stripe dashboard.
 */
export async function applyClubSession(deps: PaymentDeps, session: CheckoutSession, source: PaymentSource): Promise<ApplyOutcome> {
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || !session.payment_intent) return 'not_paid';
  const documentId = session.client_reference_id?.slice(CLUB_SESSION_PREFIX.length) ?? '';
  if (!session.client_reference_id?.startsWith(CLUB_SESSION_PREFIX) || !/^\d{1,18}$/.test(documentId)) return 'not_ours';
  const { rows: seen } = await deps.db.query('SELECT 1 FROM payments WHERE checkout_session_id = $1', [session.id]);
  if (seen.length > 0) return 'already';
  const pi = await deps.stripe.getPaymentIntent(session.payment_intent);
  const charge = pi.latest_charge;
  const paidAt = new Date((charge?.created ?? pi.created) * 1000);
  const now = deps.now();
  return deps.db.tx(async (q) => {
    const { rows } = await q.query<{ batch_id: string; reference: string; status: string }>(
      `SELECT b.id AS batch_id, b.reference, b.status FROM documents d JOIN batches b ON b.id = d.batch_id WHERE d.id = $1 AND d.kind = 'invoice' FOR UPDATE OF b`,
      [documentId],
    );
    const b = rows[0];
    const amount = session.amount_total ?? 0;
    const balance = b ? (await invoiceBalance(q, documentId)).balanceCents : 0;
    const problem = !b ? 'invoice_missing' : session.currency !== 'aud' ? 'amount_mismatch' : balance <= 0 ? 'invoice_paid' : amount > balance ? 'amount_mismatch' : null;
    const { rows: inserted } = await q.query<{ id: string }>(
      `INSERT INTO payments (document_id, checkout_session_id, payment_intent_id, amount_cents, currency, fee_cents, paid_at, recorded_at, source, livemode, problem, refunded_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (checkout_session_id) DO NOTHING RETURNING id`,
      [b ? documentId : null, session.id, pi.id, amount, session.currency ?? '', charge?.balance_transaction?.fee ?? null, paidAt, now, source, session.livemode, problem, charge?.amount_refunded ?? 0],
    );
    if (inserted.length === 0) return 'already';
    if (problem) {
      log('club_payment_flagged', { batch: b?.reference ?? null, problem, source });
      return 'flagged';
    }
    await q.query(
      `INSERT INTO club_payments (document_id, method, amount_cents, paid_on, reference, payment_id, recorded_at, recorded_by) VALUES ($1, 'card', $2, $3::date, $4, $5, $6, 'stripe')`,
      [documentId, amount, sydneyDate(paidAt), pi.id, inserted[0]!.id, now],
    );
    await settle(q, documentId, b!.batch_id, now);
    log('club_payment_applied', { batch: b!.reference, source });
    return 'paid';
  });
}

/** Card payments on a batch's invoice that weren't applied (too much, or already paid): for the admin. */
export async function flaggedCardPayments(q: Queryable, documentId: string): Promise<{ paymentIntentId: string | null; amountCents: number; problem: string; refundedCents: number; livemode: boolean }[]> {
  const { rows } = await q.query<{ payment_intent_id: string | null; amount_cents: number; problem: string; refunded_cents: number; livemode: boolean }>(
    `SELECT payment_intent_id, amount_cents, problem, refunded_cents, livemode FROM payments WHERE document_id = $1 AND problem IS NOT NULL ORDER BY paid_at`,
    [documentId],
  );
  return rows.map((r) => ({ paymentIntentId: r.payment_intent_id, amountCents: Number(r.amount_cents), problem: r.problem, refundedCents: Number(r.refunded_cents), livemode: r.livemode }));
}
