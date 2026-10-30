/**
 * Moving an order through its statuses (the server-side core of SCRUM-72; the admin pages that
 * call it come with that story).
 *
 * Only the transitions below are allowed, and only by the right actor; anything else is refused
 * (409). Each change is one transaction: the order's status, its history row (who, when, from,
 * to) and the work it causes (the customer's key-moment email, SCRUM-69, and the CRM sync,
 * SCRUM-74) are written together,
 * so a change is never recorded without its email being queued, or the other way round.
 *
 * Statuses (decided 26 Oct 2026): Submitted → Questions → Accepted → Paid → In queue →
 * Re-gritted → Posted back → Completed, plus the end states Rejected, Withdrawn and Lapsed.
 */
import { enqueueCrmSync } from '../crm/sync.js';
import type { Db } from '../db/db.js';
import { enqueueOrderEmail, type EmailPayload } from '../email/outbox.js';
import type { TemplateName } from '../email/templates.js';
import { backInPostBy, ISO_DATE_RE, sydneyDate } from './dates.js';
import { quotePostage } from '../pricing/postage.js';
import { gstIncluded, termsOn, type TaxSettings } from '../pricing/terms.js';
import type { OrderStatus } from './model.js';

/** Who made a change. */
export type Actor = 'admin' | 'system' | 'stripe';

/** Allowed moves, and who may make each one. */
export const TRANSITIONS: Readonly<Record<OrderStatus, Readonly<Partial<Record<OrderStatus, readonly Actor[]>>>>> = {
  submitted: { questions: ['admin'], accepted: ['admin'], rejected: ['admin'], withdrawn: ['admin'] },
  questions: { accepted: ['admin'], rejected: ['admin'], withdrawn: ['admin'], lapsed: ['system'] },
  // Paid is set by Stripe (SCRUM-9); outside production, admin's "Mark paid (test)" too (see below).
  accepted: { paid: ['stripe'], withdrawn: ['admin'], lapsed: ['system'] },
  paid: { in_queue: ['admin'], withdrawn: ['admin'] },
  in_queue: { regritted: ['admin'] },
  regritted: { posted_back: ['admin'] },
  posted_back: { completed: ['admin', 'system'] },
  completed: {},
  rejected: {},
  withdrawn: {},
  lapsed: {},
};

/** The customer's email for each status that has one (SCRUM-69 AC5; Questions sends nothing). */
export const EMAIL_ON: Readonly<Partial<Record<OrderStatus, TemplateName>>> = {
  accepted: 'accepted',
  in_queue: 'in_queue',
  posted_back: 'posted_back',
  rejected: 'rejected',
};

export class TransitionError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

export interface TransitionRequest {
  reference: string;
  to: OrderStatus;
  actor: Actor;
  /** Rejected: required, and sent to the customer as typed. */
  reason?: string;
  /** Posted back: required. */
  trackingNumber?: string;
  /** In queue: the day the paddles arrived (YYYY-MM-DD); defaults to today in Sydney. */
  arrivedOn?: string;
  /**
   * Accepted: the return postage to charge, if not the calculated one (SCRUM-81). Needs
   * postageReason when it differs from the calculation, or when nothing could be calculated.
   */
  postageCents?: number;
  /** Accepted: why the postage differs from the calculation (kept in the history). */
  postageReason?: string;
  /** An internal note for the history, never shown to the customer. */
  note?: string;
}

export interface TransitionDeps {
  db: Db;
  isProduction: boolean;
  now: Date;
  /** GST settings (SCRUM-81). Default: not registered. */
  tax?: TaxSettings;
}

const NOT_REGISTERED: TaxSettings = { gstRegisteredFrom: null };

const dollars = (cents: number) => `A$${(cents / 100).toFixed(2)}`;

/** May `actor` move an order from `from` to `to`? */
export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor, isProduction: boolean): boolean {
  const actors = TRANSITIONS[from][to];
  if (!actors) return false;
  if (actors.includes(actor)) return true;
  // Staging's "Mark paid (test)" (SCRUM-72 AC6): never in production.
  return !isProduction && from === 'accepted' && to === 'paid' && actor === 'admin';
}

const MAX_REASON = 2000;
const MAX_TRACKING = 64;

export async function transitionOrder(deps: TransitionDeps, req: TransitionRequest): Promise<{ reference: string; from: OrderStatus; to: OrderStatus }> {
  const reason = req.reason?.trim();
  const tracking = req.trackingNumber?.trim();
  if (req.to === 'rejected' && !reason) throw new TransitionError(400, 'reason_required', 'Give the customer a reason for rejecting the order.');
  if (reason && reason.length > MAX_REASON) throw new TransitionError(400, 'reason_too_long', `Keep the reason under ${MAX_REASON} characters.`);
  if (req.to === 'posted_back' && !tracking) throw new TransitionError(400, 'tracking_required', 'Enter the tracking number.');
  if (tracking && (tracking.length > MAX_TRACKING || !/^[A-Za-z0-9 -]+$/.test(tracking))) {
    throw new TransitionError(400, 'tracking_invalid', 'Tracking numbers are letters, digits, spaces and dashes.');
  }
  const postageReason = req.postageReason?.trim();
  if (req.postageCents !== undefined && (!Number.isInteger(req.postageCents) || req.postageCents < 0 || req.postageCents > 100_000)) {
    throw new TransitionError(400, 'postage_invalid', 'The postage must be between A$0 and A$1,000.');
  }
  if (postageReason && postageReason.length > MAX_REASON) throw new TransitionError(400, 'reason_too_long', `Keep the reason under ${MAX_REASON} characters.`);
  const arrivedOn = req.to === 'in_queue' ? (req.arrivedOn ?? sydneyDate(deps.now)) : undefined;
  if (arrivedOn !== undefined && (!ISO_DATE_RE.test(arrivedOn) || arrivedOn > sydneyDate(deps.now))) {
    throw new TransitionError(400, 'arrival_invalid', 'The arrival date must be today or earlier (YYYY-MM-DD).');
  }

  return deps.db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; status: OrderStatus }>(
      'SELECT id, status FROM orders WHERE reference = $1 FOR UPDATE',
      [req.reference],
    );
    const order = rows[0];
    if (!order) throw new TransitionError(404, 'not_found', 'No such order.');
    if (!canTransition(order.status, req.to, req.actor, deps.isProduction)) {
      throw new TransitionError(409, 'transition_not_allowed', `An order that is ${order.status} can’t be moved to ${req.to} by ${req.actor}.`);
    }

    // SCRUM-73: the promise is fixed when the order enters the queue, and the email says the same.
    const promiseOn = arrivedOn ? backInPostBy(arrivedOn) : undefined;
    // SCRUM-75/81: what the customer is asked to pay, and the terms it was worked out on, are
    // frozen on the order at Accept (the tax record), not only written into the email.
    let priceNote: string | undefined;
    let payloadPrice: Pick<EmailPayload, 'amountCents' | 'subtotalCents' | 'postageCents' | 'gstCents' | 'taxTreatment'> = {};
    if (req.to === 'accepted') {
      const { rows: facts } = await q.query<{ paddles: number; postcode: string }>(
        'SELECT (SELECT count(*)::int FROM paddles p WHERE p.order_id = o.id) AS paddles, o.postcode FROM orders o WHERE o.id = $1',
        [order.id],
      );
      const { paddles, postcode } = facts[0]!;
      const today = sydneyDate(deps.now);
      const terms = termsOn(today, deps.tax ?? NOT_REGISTERED);
      const quote = quotePostage(paddles, postcode, today);
      let postage: number;
      if (req.postageCents === undefined || (quote.ok && req.postageCents === quote.cents)) {
        if (!quote.ok) throw new TransitionError(400, 'postage_required', `${quote.reason} Give a reason too.`);
        postage = quote.cents;
      } else {
        if (!postageReason) {
          throw new TransitionError(400, 'postage_reason_required', quote.ok
            ? `Say why the postage isn’t the calculated ${dollars(quote.cents)}.`
            : 'Say how you worked out the postage.');
        }
        postage = req.postageCents;
        priceNote = quote.ok
          ? `Postage overridden: ${dollars(quote.cents)} → ${dollars(postage)}. Reason: ${postageReason}`
          : `Postage entered by hand: ${dollars(postage)} (${quote.reason}) Reason: ${postageReason}`;
      }
      const subtotal = paddles * terms.pricePerPaddleCents;
      const discount = 0; // SCRUM-63
      const total = subtotal - discount + postage;
      const gst = gstIncluded(total, terms.treatment);
      const detail = quote.ok
        ? `${quote.packing}; ${quote.actualKg} kg actual, ${quote.cubicKg} kg cubic, charged on ${quote.chargeableKg} kg (${quote.basis})${quote.zone ? `, zone ${quote.zone}` : ''}; Australia Post ${dollars(quote.postageCents)} + packaging ${dollars(quote.packagingCents)}; table ${quote.table}`
        : quote.reason;
      await q.query(
        `UPDATE orders SET amount_cents = $2, subtotal_cents = $3, discount_cents = $4, postage_cents = $5,
                postage_quoted_cents = $6, postage_override_reason = $7, postage_detail = $8, gst_cents = $9,
                tax_treatment = $10, terms_version = $11, terms_date = $12::date
          WHERE id = $1`,
        [order.id, total, subtotal, discount, postage, quote.ok ? quote.cents : null, priceNote ? postageReason : null, detail, gst,
          terms.treatment, terms.version, today],
      );
      payloadPrice = { amountCents: total, subtotalCents: subtotal, postageCents: postage, gstCents: gst, taxTreatment: terms.treatment };
    }
    await q.query(
      `UPDATE orders SET status = $2, status_changed_at = $3, updated_at = $3,
              tracking_number = COALESCE($4, tracking_number), arrived_on = COALESCE($5::date, arrived_on),
              promise_on = COALESCE($6::date, promise_on)
        WHERE id = $1`,
      [order.id, req.to, deps.now, tracking ?? null, arrivedOn ?? null, promiseOn ?? null],
    );
    const note = [req.note?.trim(), priceNote, reason ? `Reason sent to the customer: ${reason}` : undefined].filter(Boolean).join('\n') || null;
    await q.query('INSERT INTO status_history (order_id, status, at, actor, note) VALUES ($1, $2, $3, $4, $5)', [
      order.id, req.to, deps.now, req.actor, note,
    ]);

    const template = EMAIL_ON[req.to];
    if (template) {
      const payload: EmailPayload = { ...payloadPrice };
      if (reason) payload.reason = reason;
      if (promiseOn) payload.backInPostBy = promiseOn;
      // Smoke-test orders (SCRUM-68) never send anything.
      const { rows: smoke } = await q.query<{ is_smoke: boolean }>('SELECT is_smoke FROM orders WHERE id = $1', [order.id]);
      if (!smoke[0]?.is_smoke) await enqueueOrderEmail(q, order.id, template, deps.now, payload);
    }
    // SCRUM-74: the deal's stage follows the status.
    await enqueueCrmSync(q, order.id, deps.now);
    return { reference: req.reference, from: order.status, to: req.to };
  });
}
