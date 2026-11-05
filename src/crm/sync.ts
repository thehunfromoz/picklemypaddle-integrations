/**
 * One-way CRM sync through the outbox (SCRUM-74 AC6 and AC7).
 *
 * Every order creation and status change queues a `crm` job in the same transaction. At most
 * one job per order waits at a time, because a sync always pushes the order's current state.
 * A worker runs the jobs with the same backoff as emails, so HubSpot being down never blocks an
 * order or a status change; a job that keeps failing is left `failed` for the admin page.
 *
 * Before its first write, the worker checks which portal the key belongs to. Outside
 * production it must be the test portal (AC8), so a production key pasted into staging by
 * mistake writes nothing.
 */
import type { Db, Queryable } from '../db/db.js';
import { BACKOFF_MINUTES, MAX_ATTEMPTS } from '../email/outbox.js';
import { log, logError } from '../log.js';
import { sydneyDate } from '../orders/dates.js';
import type { TaxSettings } from '../pricing/terms.js';
import { mapClub, mapOrder, type ClubForCrm, type CrmAdapter, type OrderForCrm } from './crm.js';
import { HubSpotError } from './hubspot.js';

const MINUTE = 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

/** Queues a sync of this order, inside the caller's transaction. Smoke-test orders are skipped. */
export async function enqueueCrmSync(q: Queryable, orderId: string, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO outbox (kind, order_id, template, next_attempt_at, created_at, updated_at)
     SELECT 'crm', o.id, 'sync', $2::timestamptz, $2::timestamptz, $2::timestamptz FROM orders o
      WHERE o.id = $1::uuid AND NOT o.is_smoke AND o.erased_at IS NULL
     ON CONFLICT (order_id) WHERE kind = 'crm' AND state = 'pending' DO NOTHING`,
    [orderId, now],
  );
}

/** SCRUM-85: queues a sync of a club (its company, billing contact and batches), inside the caller's transaction. */
export async function enqueueClubCrmSync(q: Queryable, clubId: string, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO outbox (kind, club_id, template, next_attempt_at, created_at, updated_at)
     VALUES ('crm', $1::uuid, 'club_sync', $2::timestamptz, $2::timestamptz, $2::timestamptz)
     ON CONFLICT (club_id) WHERE kind = 'crm' AND state = 'pending' DO NOTHING`,
    [clubId, now],
  );
}

export interface CrmDeps {
  db: Db;
  adapter: CrmAdapter | null;
  /** Resolves the portal the key belongs to (checked once, before the first write). */
  portalId: (() => Promise<string>) | null;
  /** The portal this environment may write to (the test portal outside production). */
  expectedPortalId: string | null;
  now: () => Date;
  /** GST_REGISTERED_FROM, for a batch deal's estimate before it is invoiced (SCRUM-85). */
  tax?: TaxSettings;
}

export interface CrmRun {
  synced: number;
  retrying: number;
  failed: number;
  skipped: number;
}

interface Job {
  id: string;
  order_id: string | null;
  club_id: string | null;
  attempts: number;
}

/** Remembers a successful portal check for the life of the process. */
const verified = new WeakSet<CrmDeps>();

export async function checkPortal(deps: CrmDeps): Promise<'ok' | 'mismatch'> {
  if (verified.has(deps) || !deps.portalId || !deps.expectedPortalId) return 'ok';
  const actual = await deps.portalId();
  if (actual !== deps.expectedPortalId) return 'mismatch';
  verified.add(deps);
  return 'ok';
}

async function settle(db: Db, id: string, state: string, error: string | null, now: Date, nextAt?: Date) {
  await db.query(
    `UPDATE outbox SET state = $2::text, last_error = $3::text, updated_at = $4::timestamptz,
            next_attempt_at = COALESCE($5::timestamptz, next_attempt_at),
            done_at = CASE WHEN $2::text IN ('sent', 'failed', 'suppressed') THEN $4::timestamptz ELSE NULL END
      WHERE id = $1`,
    [id, state, error, now, nextAt ?? null],
  );
}

export async function processCrm(deps: CrmDeps, batch = 10): Promise<CrmRun> {
  const run: CrmRun = { synced: 0, retrying: 0, failed: 0, skipped: 0 };
  const now = deps.now();
  const { rows } = await deps.db.query<Job>(
    `UPDATE outbox SET state = 'sending', attempts = attempts + 1, next_attempt_at = $2, updated_at = $1
      WHERE id IN (SELECT id FROM outbox
                    WHERE kind = 'crm' AND state IN ('pending', 'sending') AND next_attempt_at <= $1
                    ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id, order_id, club_id, attempts`,
    [now, new Date(now.getTime() + LEASE_MS), batch],
  );
  if (rows.length === 0) return run;

  if (!deps.adapter) {
    for (const job of rows) await settle(deps.db, job.id, 'suppressed', 'no_crm', now);
    run.skipped = rows.length;
    return run;
  }

  let portal: 'ok' | 'mismatch' | 'unknown';
  try {
    portal = await checkPortal(deps);
  } catch (err) {
    logError('crm_portal_check_failed', err);
    portal = 'unknown';
  }

  for (const job of rows) {
    const ref = { outbox: Number(job.id) };
    try {
      if (portal === 'mismatch') throw new HubSpotError(null, 'portal_mismatch', true);
      if (portal === 'unknown') throw new HubSpotError(null, 'portal_unverified', false);
      if (job.club_id) {
        const club = await loadClub(deps.db, job.club_id);
        if (!club || !deps.adapter.syncClub) {
          await settle(deps.db, job.id, 'suppressed', club ? 'no_club_sync' : 'club_missing', now);
          run.skipped++;
          continue;
        }
        const { company, contact, deals } = mapClub(club, { tax: deps.tax, today: sydneyDate(now) });
        const ids = await deps.adapter.syncClub(company, contact, deals, {
          companyId: club.crm_company_id ?? undefined,
          contactId: club.crm_contact_id ?? undefined,
          dealIds: Object.fromEntries(club.batches.filter((b) => b.crm_deal_id).map((b) => [b.reference, b.crm_deal_id!])),
        });
        await deps.db.query('UPDATE clubs SET crm_company_id = $2, crm_contact_id = $3 WHERE id = $1', [club.id, ids.companyId, ids.contactId]);
        for (const [reference, dealId] of Object.entries(ids.dealIds)) {
          await deps.db.query('UPDATE batches SET crm_deal_id = $2 WHERE reference = $1', [reference, dealId]);
        }
        await settle(deps.db, job.id, 'sent', null, now);
        log('crm_club_synced', { ...ref, batches: deals.length });
        run.synced++;
        continue;
      }
      const order = await loadOrder(deps.db, job.order_id!);
      if (!order) {
        await settle(deps.db, job.id, 'suppressed', 'order_missing', now);
        run.skipped++;
        continue;
      }
      const { contact, deal } = mapOrder(order);
      const ids = await deps.adapter.sync(contact, deal, {
        contactId: order.crm_contact_id ?? undefined,
        dealId: order.crm_deal_id ?? undefined,
      });
      await deps.db.query('UPDATE orders SET crm_contact_id = $2, crm_deal_id = $3 WHERE id = $1', [job.order_id!, ids.contactId, ids.dealId]);
      await settle(deps.db, job.id, 'sent', null, now);
      log('crm_synced', { ...ref, reference: order.reference, status: order.status });
      run.synced++;
    } catch (err) {
      const code = err instanceof HubSpotError ? err.code : `error:${(err as Error)?.name ?? 'error'}`;
      const permanent = err instanceof HubSpotError ? err.permanent : false;
      if (permanent || job.attempts >= MAX_ATTEMPTS) {
        await settle(deps.db, job.id, 'failed', code, now);
        logError('crm_failed', err, { ...ref, code, attempt: job.attempts });
        run.failed++;
      } else {
        const wait: number = BACKOFF_MINUTES[job.attempts - 1] ?? 720;
        try {
          await settle(deps.db, job.id, 'pending', code, now, new Date(now.getTime() + wait * MINUTE));
          log('crm_retrying', { ...ref, code, attempt: job.attempts, inMinutes: wait });
          run.retrying++;
        } catch (e) {
          // Something changed again while this job was in flight, so a newer job is already pending
          // (one pending job per order or club). It will sync everything this one would have.
          if ((e as { code?: string }).code !== '23505') throw e;
          await settle(deps.db, job.id, 'suppressed', 'superseded', now);
          log('crm_superseded', { ...ref, code, attempt: job.attempts });
          run.skipped++;
        }
      }
    }
  }
  return run;
}

async function loadClub(db: Db, clubId: string): Promise<ClubForCrm | null> {
  const { rows } = await db.query<Omit<ClubForCrm, 'batches'>>(
    'SELECT id, name, is_test, billing_name, billing_email, crm_company_id, crm_contact_id FROM clubs WHERE id = $1',
    [clubId],
  );
  const club = rows[0];
  if (!club) return null;
  const { rows: batches } = await db.query<ClubForCrm['batches'][number]>(
    `SELECT b.reference, b.status, b.collected_on::text AS collected_on, b.paddle_count, b.unchanged_count, d.total_cents AS invoice_total, b.crm_deal_id
       FROM batches b LEFT JOIN documents d ON d.batch_id = b.id AND d.kind = 'invoice' WHERE b.club_id = $1 ORDER BY b.created_at`,
    [clubId],
  );
  return { ...club, batches: batches.map((b) => ({ ...b, paddle_count: Number(b.paddle_count), unchanged_count: Number(b.unchanged_count) })) };
}

async function loadOrder(db: Db, orderId: string): Promise<OrderForCrm | null> {
  const { rows } = await db.query<OrderForCrm>(
    `SELECT o.reference, o.status, o.is_test, o.name, o.email, o.phone, o.suburb, o.state, o.postcode,
            o.crm_contact_id, o.crm_deal_id, o.amount_cents, o.discount_kind, o.discount_value, o.discount_code,
            o.subtotal_cents, o.discount_cents, o.postage_cents, o.gst_cents, (SELECT count(*)::int FROM paddles p WHERE p.order_id = o.id) AS paddle_count,
            EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id) AS has_review,
            EXISTS (SELECT 1 FROM reviews r JOIN orders o2 ON o2.id = r.order_id
                     WHERE o2.email_norm = o.email_norm AND NOT o2.is_smoke) AS contact_has_review
       FROM orders o WHERE o.id = $1 AND o.erased_at IS NULL`,
    [orderId],
  );
  const row = rows[0];
  return row ? { ...row, paddle_count: Number(row.paddle_count) } : null;
}

/**
 * Queues a sync of every order (AC7): after an outage, and after production switches to its own
 * portal. The worker then pushes them at its usual pace. Returns how many were queued.
 */
export async function resyncAll(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM orders WHERE NOT is_smoke AND erased_at IS NULL ORDER BY created_at');
  for (const r of rows) await enqueueCrmSync(db, r.id, now);
  const { rows: clubs } = await db.query<{ id: string }>('SELECT id FROM clubs ORDER BY created_at');
  for (const c of clubs) await enqueueClubCrmSync(db, c.id, now);
  return rows.length + clubs.length;
}

/** Puts a failed CRM job back in the queue (the admin page's retry button, SCRUM-72). */
export async function retryCrmJob(db: Db, outboxId: string, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = $2, last_error = NULL, done_at = NULL, updated_at = $2
      WHERE id = $1 AND kind = 'crm' AND state = 'failed'
        AND NOT EXISTS (SELECT 1 FROM outbox o2 WHERE (o2.order_id = outbox.order_id OR o2.club_id = outbox.club_id) AND o2.kind = 'crm' AND o2.state = 'pending')
      RETURNING id`,
    [outboxId, now],
  );
  return rows.length === 1;
}
