/**
 * Housekeeping that runs inside the service:
 *  - smoke-test orders (SCRUM-68) are deleted 24 hours after they were placed, photos included;
 *  - rate-limit history older than two days is deleted (SCRUM-67).
 *  - the email outbox (SCRUM-69) is worked every 10 seconds, the CRM sync (SCRUM-74) every 30.
 *  - daily: Posted back → Completed after 10 days, Questions → Lapsed after 30 (SCRUM-72).
 * Order retention for real orders is SCRUM-75, not here.
 */
import type { Db } from './db/db.js';
import { runAutoTransitions } from './orders/auto.js';
import { processCrm, type CrmDeps } from './crm/sync.js';
import { processOutbox, type OutboxDeps } from './email/outbox.js';
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

export function startJobs(
  db: Db,
  photos: PhotoStore,
  outbox: OutboxDeps | null,
  crm: CrmDeps | null = null,
  now: () => Date = () => new Date(),
  isProduction = outbox?.settings.isProduction ?? false,
): () => void {
  let syncing = false;
  const syncCrm = async () => {
    if (!crm || syncing) return;
    syncing = true;
    try {
      const run = await processCrm(crm);
      if (run.synced + run.retrying + run.failed + run.skipped > 0) log('crm_run', { ...run });
    } catch (err) {
      logError('job_failed', err, { job: 'crm' });
    } finally {
      syncing = false;
    }
  };
  let sending = false;
  const sendEmails = async () => {
    if (!outbox || sending) return;
    sending = true;
    try {
      const run = await processOutbox(outbox);
      if (run.sent + run.retrying + run.failed + run.suppressed > 0) log('outbox_run', { ...run });
    } catch (err) {
      logError('job_failed', err, { job: 'outbox' });
    } finally {
      sending = false;
    }
  };
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
    try {
      const run = await runAutoTransitions(db, now(), isProduction);
      log('auto_transitions', { ...run });
    } catch (err) {
      logError('job_failed', err, { job: 'auto_transitions' });
    }
  };
  void hourly();
  void daily();
  void sendEmails();
  void syncCrm();
  const timers = [
    setInterval(hourly, 60 * 60 * 1000),
    setInterval(daily, 24 * 60 * 60 * 1000),
    setInterval(sendEmails, 10_000),
    setInterval(syncCrm, 30_000),
  ];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}
