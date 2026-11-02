/**
 * The automatic status changes (SCRUM-72 AC5), run daily by the service's jobs:
 *
 *   - Posted back → Completed, 10 days after the order was posted back;
 *   - Questions  → Lapsed, after 30 days in Questions with no status change;
 *   - Accepted   → Lapsed, unpaid 30 days after acceptance (SCRUM-83), counted on Sydney dates
 *     from the Accepted time in the history; its open Stripe Checkout Sessions are expired.
 *
 * Each change goes through transitionOrder as actor "system", so it is checked against the
 * transition table, recorded in the history as "system" and synced to HubSpot like any other.
 * Idempotent: an order already moved on (by Attila, or another run) is simply skipped.
 */
import type { Db } from '../db/db.js';
import { logError } from '../log.js';
import type { OrderStatus } from './model.js';
import { TransitionError, transitionOrder } from './transitions.js';
import { sydneyDate } from './dates.js';
import { addDays } from './retention.js';
import type { PaymentDeps } from '../payments/payments.js';
import { log } from '../log.js';

export const AUTO_COMPLETE_DAYS = 10;
export const AUTO_LAPSE_DAYS = 30;
/** SCRUM-83: an Accepted order still unpaid this many Sydney days after acceptance lapses. */
export const UNPAID_LAPSE_DAYS = 30;
export const UNPAID_LAPSE_NOTE = `Automatic: unpaid ${UNPAID_LAPSE_DAYS} days after acceptance.`;

/** The Sydney day an Accepted order lapses if still unpaid. */
export const unpaidLapsesOn = (acceptedOn: string) => addDays(acceptedOn, UNPAID_LAPSE_DAYS);

const DAY = 24 * 60 * 60 * 1000;

interface Rule {
  from: OrderStatus;
  to: OrderStatus;
  days: number;
  note: string;
}

const RULES: readonly Rule[] = [
  { from: 'posted_back', to: 'completed', days: AUTO_COMPLETE_DAYS, note: `Automatic: ${AUTO_COMPLETE_DAYS} days after posting back.` },
  { from: 'questions', to: 'lapsed', days: AUTO_LAPSE_DAYS, note: `Automatic: no reply within ${AUTO_LAPSE_DAYS} days.` },
];

export interface AutoRun {
  completed: number;
  lapsed: number;
}

export async function runAutoTransitions(db: Db, now: Date, isProduction: boolean, payments: PaymentDeps | null = null): Promise<AutoRun> {
  const run: AutoRun = { completed: 0, lapsed: 0 };
  run.lapsed += await lapseUnpaid(db, now, isProduction, payments);
  for (const rule of RULES) {
    const cutoff = new Date(now.getTime() - rule.days * DAY);
    const { rows } = await db.query<{ reference: string }>(
      'SELECT reference FROM orders WHERE status = $1 AND status_changed_at <= $2 ORDER BY status_changed_at',
      [rule.from, cutoff],
    );
    for (const { reference } of rows) {
      try {
        await transitionOrder({ db, isProduction, now }, { reference, to: rule.to, actor: 'system', note: rule.note });
        if (rule.to === 'completed') run.completed++;
        else run.lapsed++;
      } catch (err) {
        // Moved on or deleted since the query: nothing to do. Anything else is logged, and the
        // order is tried again on the next run.
        if (err instanceof TransitionError && (err.httpStatus === 409 || err.httpStatus === 404)) continue;
        logError('auto_transition_failed', err, { reference, to: rule.to });
      }
    }
  }
  return run;
}

/**
 * SCRUM-83: Accepted → Lapsed for orders still unpaid on day 30 (Sydney dates from the Accepted
 * time in the history). No email: the day-14 reminder gave the date. Any open Checkout Session is
 * expired so it can't be paid afterwards (a payment that still arrives is flagged, not applied).
 */
async function lapseUnpaid(db: Db, now: Date, isProduction: boolean, payments: PaymentDeps | null): Promise<number> {
  const today = sydneyDate(now);
  const { rows } = await db.query<{ id: string; reference: string; accepted_at: Date }>(
    `SELECT o.id, o.reference,
            (SELECT max(h.at) FROM status_history h WHERE h.order_id = o.id AND h.status = 'accepted') AS accepted_at
       FROM orders o WHERE o.status = 'accepted' ORDER BY o.status_changed_at`,
  );
  let lapsed = 0;
  for (const o of rows) {
    if (!o.accepted_at || today < unpaidLapsesOn(sydneyDate(new Date(o.accepted_at)))) continue;
    try {
      await transitionOrder({ db, isProduction, now }, { reference: o.reference, to: 'lapsed', actor: 'system', note: UNPAID_LAPSE_NOTE });
      lapsed++;
    } catch (err) {
      if (err instanceof TransitionError && (err.httpStatus === 409 || err.httpStatus === 404)) continue; // paid meanwhile
      logError('auto_transition_failed', err, { reference: o.reference, to: 'lapsed' });
      continue;
    }
    await expireOpenSessions(db, o.id, now, payments);
  }
  return lapsed;
}

async function expireOpenSessions(db: Db, orderId: string, now: Date, payments: PaymentDeps | null): Promise<void> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM stripe_sessions WHERE order_id = $1 AND expired_at IS NULL AND expires_at > $2', [orderId, now]);
  for (const s of rows) {
    if (payments) {
      try {
        await payments.stripe.expireCheckoutSession(s.id);
      } catch {
        // Already completed or expired on Stripe's side: a completed one arrives as a flagged late payment.
        log('stripe_session_expire_skipped', { session: s.id.slice(0, 16) });
      }
    }
    await db.query('UPDATE stripe_sessions SET expired_at = $2 WHERE id = $1', [s.id, now]);
  }
}
