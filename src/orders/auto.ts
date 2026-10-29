/**
 * The automatic status changes (SCRUM-72 AC5), run daily by the service's jobs:
 *
 *   - Posted back → Completed, 10 days after the order was posted back;
 *   - Questions  → Lapsed, after 30 days in Questions with no status change.
 *
 * Each change goes through transitionOrder as actor "system", so it is checked against the
 * transition table, recorded in the history as "system" and synced to HubSpot like any other.
 * Idempotent: an order already moved on (by Attila, or another run) is simply skipped.
 */
import type { Db } from '../db/db.js';
import { logError } from '../log.js';
import type { OrderStatus } from './model.js';
import { TransitionError, transitionOrder } from './transitions.js';

export const AUTO_COMPLETE_DAYS = 10;
export const AUTO_LAPSE_DAYS = 30;

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

export async function runAutoTransitions(db: Db, now: Date, isProduction: boolean): Promise<AutoRun> {
  const run: AutoRun = { completed: 0, lapsed: 0 };
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
