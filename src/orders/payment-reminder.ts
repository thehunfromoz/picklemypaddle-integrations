/**
 * The one payment reminder (SCRUM-83): day 14 after acceptance, still unpaid, one email saying
 * when the order lapses (day 30) with the status page's Pay now. Never a second one:
 * `orders.payment_reminder_at` is set in the same transaction that queues it, and only while
 * empty. Days are Sydney calendar days from the Accepted time in the history. Smoke orders never
 * get one. Outside production the email reaches only the allow-list, like every other.
 */
import type { Db } from '../db/db.js';
import { enqueueOrderEmail } from '../email/outbox.js';
import { logError } from '../log.js';
import { unpaidLapsesOn } from './auto.js';
import { sydneyDate } from './dates.js';
import { addDays } from './retention.js';

export const PAYMENT_REMINDER_DAYS = 14;

/** Daily: queues the reminder for every Accepted order now on or past day 14. Returns how many. */
export async function runPaymentReminders(db: Db, now: Date): Promise<number> {
  const today = sydneyDate(now);
  const { rows } = await db.query<{ id: string; reference: string; amount_cents: number | null; accepted_at: Date }>(
    `SELECT o.id, o.reference, o.amount_cents,
            (SELECT max(h.at) FROM status_history h WHERE h.order_id = o.id AND h.status = 'accepted') AS accepted_at
       FROM orders o
      WHERE o.status = 'accepted' AND o.payment_reminder_at IS NULL AND NOT o.is_smoke
      ORDER BY o.status_changed_at`,
  );
  let queued = 0;
  for (const o of rows) {
    if (!o.accepted_at) continue;
    const acceptedOn = sydneyDate(new Date(o.accepted_at));
    const lapsesOn = unpaidLapsesOn(acceptedOn);
    // From day 14 until the day before it lapses (a job that missed day 14 still sends it once).
    if (today < addDays(acceptedOn, PAYMENT_REMINDER_DAYS) || today >= lapsesOn) continue;
    try {
      const sent = await db.tx(async (q) => {
        const { rows: claimed } = await q.query(
          `UPDATE orders SET payment_reminder_at = $2 WHERE id = $1 AND status = 'accepted' AND payment_reminder_at IS NULL RETURNING id`,
          [o.id, now],
        );
        if (claimed.length === 0) return false;
        await enqueueOrderEmail(q, o.id, 'payment_reminder', now, { lapsesOn, ...(o.amount_cents !== null ? { amountCents: Number(o.amount_cents) } : {}) });
        return true;
      });
      if (sent) queued++;
    } catch (err) {
      logError('payment_reminder_failed', err, { reference: o.reference });
    }
  }
  return queued;
}
