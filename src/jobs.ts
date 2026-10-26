/**
 * Housekeeping that runs inside the service:
 *  - smoke-test orders (SCRUM-68) are deleted 24 hours after they were placed, photos included;
 *  - rate-limit history older than two days is deleted (SCRUM-67).
 * Order retention for real orders is SCRUM-75, not here.
 */
import type { Db } from './db/db.js';
import { pruneRateLimitEvents } from './orders/abuse.js';
import type { PhotoStore } from './orders/photos.js';
import { log, logError } from './log.js';

export async function deleteOldSmokeOrders(db: Db, photos: PhotoStore, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Delete rows first (one transaction), then their files: a crash in between leaves at worst
  // a few unreferenced files, never rows pointing at missing photos.
  const paths = await db.tx(async (q) => {
    const { rows } = await q.query<{ path: string }>(
      `SELECT ph.path FROM photos ph JOIN paddles p ON p.id = ph.paddle_id JOIN orders o ON o.id = p.order_id
        WHERE o.is_smoke AND o.created_at < $1`,
      [cutoff],
    );
    const { rows: gone } = await q.query('DELETE FROM orders WHERE is_smoke AND created_at < $1 RETURNING id', [cutoff]);
    return { files: rows.map((r) => r.path), orders: gone.length };
  });
  for (const p of paths.files) await photos.remove(p).catch((err) => logError('smoke_photo_delete_failed', err));
  return paths.orders;
}

export function startJobs(db: Db, photos: PhotoStore, now: () => Date = () => new Date()): () => void {
  const hourly = async () => {
    try {
      const n = await deleteOldSmokeOrders(db, photos, now());
      if (n > 0) log('smoke_orders_deleted', { orders: n });
    } catch (err) {
      logError('job_failed', err, { job: 'smoke_cleanup' });
    }
  };
  const daily = async () => {
    try {
      log('rate_limit_pruned', { rows: await pruneRateLimitEvents(db, now()) });
    } catch (err) {
      logError('job_failed', err, { job: 'rate_limit_prune' });
    }
  };
  void hourly();
  void daily();
  const timers = [setInterval(hourly, 60 * 60 * 1000), setInterval(daily, 24 * 60 * 60 * 1000)];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}
