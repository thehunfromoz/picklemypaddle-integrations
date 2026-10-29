/**
 * The re-grit queue (SCRUM-73): when an order is promised back, and how many paddles are ahead
 * of it. No capacity model (decided 26 Oct): the promise is arrival + 10 NSW business days.
 *
 * Queue order: arrival day, then reference (ties broken by reference). TEST orders queue only
 * among TEST orders, so staging traffic never shows up in a real customer's position, and smoke
 * orders never count at all.
 */
import type { Queryable } from '../db/db.js';
import { backInPostBy } from './dates.js';

/** The stored promise, or (for orders queued before it was stored) the one worked out from arrival. */
export function promiseOf(order: { promise_on: string | null; arrived_on: string | null }): string | null {
  return order.promise_on ?? (order.arrived_on ? backInPostBy(order.arrived_on) : null);
}

/** Paddles in orders that are In queue ahead of this one. */
export async function paddlesAhead(
  q: Queryable,
  order: { id: string; reference: string; arrived_on: string; is_test: boolean },
): Promise<number> {
  const { rows } = await q.query<{ n: number | string | null }>(
    `SELECT COALESCE(sum((SELECT count(*) FROM paddles p WHERE p.order_id = o.id)), 0) AS n
       FROM orders o
      WHERE o.status = 'in_queue' AND o.is_test = $2 AND NOT o.is_smoke AND o.id <> $1::uuid
        AND (o.arrived_on < $3::date OR (o.arrived_on = $3::date AND o.reference < $4))`,
    [order.id, order.is_test, order.arrived_on, order.reference],
  );
  return Number(rows[0]?.n ?? 0);
}
