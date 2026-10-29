/**
 * The one review reminder (SCRUM-80, decided 29 Oct 2026).
 *
 * The Posted back email asks for a review before the customer has played with the paddle, so
 * most never come back to it. One reminder goes 10 days after Posted back (the same moment the
 * order auto-completes) if no review has come in. Never a second one: `orders.review_reminder_at`
 * is set in the same transaction that queues it, and only while it is still empty.
 *
 * Only for orders that were actually posted back (Posted back or Completed), never for smoke
 * orders. Outside production the email reaches only the allow-list, like every other.
 */
import type { Db, Queryable } from '../db/db.js';
import { enqueueOrderEmail } from '../email/outbox.js';
import { logError } from '../log.js';

export const REVIEW_REMINDER_DAYS = 10;
const DAY = 24 * 60 * 60 * 1000;

/** The orders a reminder may still go to, as SQL conditions on `orders o`. */
const ELIGIBLE = `o.status IN ('posted_back', 'completed') AND NOT o.is_smoke AND o.review_reminder_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id)`;

/**
 * Queues the reminder for one order inside the caller's transaction, if it may still have one.
 * Returns false (and queues nothing) otherwise: reviewed, reminded already, not posted back, smoke.
 */
export async function queueReviewReminder(q: Queryable, orderId: string, now: Date): Promise<boolean> {
  const { rows } = await q.query(`UPDATE orders o SET review_reminder_at = $2 WHERE o.id = $1 AND ${ELIGIBLE} RETURNING o.id`, [orderId, now]);
  if (rows.length === 0) return false;
  await enqueueOrderEmail(q, orderId, 'review_reminder', now);
  return true;
}

/** Daily: every eligible order posted back at least 10 days ago. Returns how many were queued. */
export async function runReviewReminders(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - REVIEW_REMINDER_DAYS * DAY);
  const { rows } = await db.query<{ id: string; reference: string }>(
    `SELECT o.id, o.reference FROM orders o
      WHERE ${ELIGIBLE}
        AND (SELECT max(h.at) FROM status_history h WHERE h.order_id = o.id AND h.status = 'posted_back') <= $1
      ORDER BY o.created_at`,
    [cutoff],
  );
  let queued = 0;
  for (const o of rows) {
    try {
      if (await db.tx((q) => queueReviewReminder(q, o.id, now))) queued++;
    } catch (err) {
      logError('review_reminder_failed', err, { reference: o.reference });
    }
  }
  return queued;
}
