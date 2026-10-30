/**
 * Retention (SCRUM-75, decided 26 Oct 2026; privacy policy, "How long we keep it").
 *
 * A daily job applies three rules, each counted from the day (in Sydney) the order reached the
 * status the rule starts from:
 *
 *   photos     12 months after Completed: the paddle photos (files and rows) go.
 *   enquiries  12 months after Rejected, Withdrawn or Lapsed, for orders that were never paid:
 *              the whole order goes, with its HubSpot deal, and its contact if no other order of
 *              that customer is left.
 *   paid       5 years after a paid order's end status (Completed, or Withdrawn after paying): the
 *              whole order goes, the tax record included. The ATO's 5 years run from when the
 *              record was made or the transaction completed, whichever is later (checked 30 Oct
 *              2026); not tied to the financial year.
 *
 * Smoke-test orders are deleted 24 hours after they're placed (src/jobs.ts). Attila's own TEST
 * orders on staging follow the same rules as real ones (decided 30 Oct 2026).
 *
 * An extension (`retain_until`, with a reason) holds an order back from every rule until that
 * date; afterwards the rules apply again. HubSpot is cleaned up before the order's rows go: if
 * that fails, the order waits for the next run, so no personal data is left behind in HubSpot.
 *
 * Idempotent: a second run finds nothing more to do. Logs and the `retention_runs` table hold
 * counts only, never who.
 */
import { checkPortal, type CrmDeps } from '../crm/sync.js';
import type { Db } from '../db/db.js';
import { log, logError } from '../log.js';
import { sydneyDate } from './dates.js';
import type { OrderStatus } from './model.js';
import type { PhotoStore } from './photos.js';

export const RULES = {
  photos: { months: 12, label: 'Photos of completed orders', what: 'the paddle photos' },
  enquiries: { months: 12, label: 'Orders that never went ahead', what: 'the whole order' },
  paid: { months: 60, label: 'Paid orders (5-year tax record)', what: 'the whole order' },
} as const;
export type Rule = keyof typeof RULES;
export const RULE_NAMES = Object.keys(RULES) as Rule[];

/** Days ahead the admin's heads-up list looks (AC6). */
export const HEADS_UP_DAYS = 14;

/** Statuses an order ends in (nothing moves on from them). */
export const END_STATUSES: ReadonlySet<OrderStatus> = new Set(['completed', 'rejected', 'withdrawn', 'lapsed']);
const NOT_GONE_AHEAD: ReadonlySet<OrderStatus> = new Set(['rejected', 'withdrawn', 'lapsed']);

/** YYYY-MM-DD plus whole calendar months (31 Jan + 1 month → 3 Mar, as Date.UTC rolls over). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** What the rules need to know about an order. */
export interface RetentionFacts {
  status: OrderStatus;
  statusChangedAt: Date;
  everPaid: boolean;
  hasPhotos: boolean;
  /** YYYY-MM-DD or null. */
  retainUntil: string | null;
}

/** Each rule that applies to this order, and the Sydney date it is due on. */
export function dueDates(o: RetentionFacts): Partial<Record<Rule, string>> {
  const from = sydneyDate(o.statusChangedAt);
  const out: Partial<Record<Rule, string>> = {};
  if (o.status === 'completed' && o.hasPhotos) out.photos = addMonths(from, RULES.photos.months);
  if (NOT_GONE_AHEAD.has(o.status) && !o.everPaid) out.enquiries = addMonths(from, RULES.enquiries.months);
  if (END_STATUSES.has(o.status) && o.everPaid) out.paid = addMonths(from, RULES.paid.months);
  return out;
}

/** Held back by an extension today? (It ends after its date.) */
export const isExtended = (o: Pick<RetentionFacts, 'retainUntil'>, today: string) => o.retainUntil !== null && o.retainUntil >= today;

/** The rules due today or earlier, unless an extension holds the order back. */
export function rulesDue(o: RetentionFacts, now: Date): Rule[] {
  const today = sydneyDate(now);
  if (isExtended(o, today)) return [];
  const due = dueDates(o);
  return RULE_NAMES.filter((r) => due[r] !== undefined && due[r]! <= today);
}

// ── Reading orders ────────────────────────────────────────────────────────────

export interface RetentionOrder extends RetentionFacts {
  id: string;
  reference: string;
  isTest: boolean;
  erased: boolean;
  emailNorm: string;
  crmContactId: string | null;
  crmDealId: string | null;
  retainReason: string | null;
}

/** Every order the rules can apply to (end statuses), smoke orders aside. */
export async function retentionOrders(db: Db, where = 'TRUE', params: unknown[] = []): Promise<RetentionOrder[]> {
  const { rows } = await db.query<{
    id: string;
    reference: string;
    status: OrderStatus;
    status_changed_at: Date;
    is_test: boolean;
    erased_at: Date | null;
    email_norm: string;
    crm_contact_id: string | null;
    crm_deal_id: string | null;
    retain_until: string | null;
    retain_reason: string | null;
    ever_paid: boolean;
    has_photos: boolean;
  }>(
    `SELECT o.id, o.reference, o.status, o.status_changed_at, o.is_test, o.erased_at, o.email_norm,
            o.crm_contact_id, o.crm_deal_id, o.retain_until::text AS retain_until, o.retain_reason,
            EXISTS (SELECT 1 FROM status_history h WHERE h.order_id = o.id AND h.status = 'paid') AS ever_paid,
            EXISTS (SELECT 1 FROM photos ph JOIN paddles p ON p.id = ph.paddle_id WHERE p.order_id = o.id) AS has_photos
       FROM orders o
      WHERE NOT o.is_smoke AND o.status IN ('completed', 'rejected', 'withdrawn', 'lapsed') AND (${where})
      ORDER BY o.status_changed_at, o.reference`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    statusChangedAt: new Date(r.status_changed_at),
    isTest: r.is_test,
    erased: r.erased_at !== null,
    emailNorm: r.email_norm,
    crmContactId: r.crm_contact_id,
    crmDealId: r.crm_deal_id,
    retainUntil: r.retain_until,
    retainReason: r.retain_reason,
    everPaid: r.ever_paid,
    hasPhotos: r.has_photos,
  }));
}

// ── Deleting ──────────────────────────────────────────────────────────────────

export interface RetentionDeps {
  db: Db;
  photos: PhotoStore;
  /** Null: HubSpot isn't configured here, so there is nothing to clean up there. */
  crm: CrmDeps | null;
}

/** Removes files after their rows are gone; a file that won't go is logged, never fatal. */
async function removeFiles(photos: PhotoStore, paths: string[]) {
  for (const p of paths) await photos.remove(p).catch((err) => logError('retention_photo_delete_failed', err));
}

export async function deletePhotos(deps: RetentionDeps, orderId: string): Promise<number> {
  const paths = await deps.db.tx(async (q) => {
    const { rows } = await q.query<{ path: string }>(
      `DELETE FROM photos ph USING paddles p WHERE ph.paddle_id = p.id AND p.order_id = $1 RETURNING ph.path`,
      [orderId],
    );
    return rows.map((r) => r.path);
  });
  await removeFiles(deps.photos, paths);
  return paths.length;
}

/**
 * HubSpot for an order about to be deleted: its deal, and its contact when no other order of
 * that customer is left. Throws if HubSpot can't be reached (the order then waits).
 */
export async function cleanCrmForDeletion(deps: RetentionDeps, o: Pick<RetentionOrder, 'id' | 'emailNorm' | 'crmContactId' | 'crmDealId'>) {
  const crm = deps.crm;
  if (!crm?.adapter || (!o.crmContactId && !o.crmDealId)) return;
  if ((await checkPortal(crm)) === 'mismatch') throw new Error('crm_portal_mismatch');
  if (o.crmDealId) await crm.adapter.deleteDeal(o.crmDealId);
  if (o.crmContactId) {
    const { rows } = await deps.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM orders WHERE email_norm = $1 AND id <> $2 AND NOT is_smoke AND erased_at IS NULL`,
      [o.emailNorm, o.id],
    );
    if (Number(rows[0]?.n ?? 0) === 0) await crm.adapter.deleteContact(o.crmContactId);
  }
}

/** The whole order: rows (photos, paddles, history, tokens, outbox, notes, review cascade) and files. */
export async function deleteOrder(deps: RetentionDeps, orderId: string): Promise<void> {
  const paths = await deps.db.tx(async (q) => {
    const { rows } = await q.query<{ path: string }>(
      `SELECT ph.path FROM photos ph JOIN paddles p ON p.id = ph.paddle_id WHERE p.order_id = $1`,
      [orderId],
    );
    await q.query('DELETE FROM orders WHERE id = $1', [orderId]);
    return rows.map((r) => r.path);
  });
  await removeFiles(deps.photos, paths);
}

export interface RetentionRun {
  photos: number;
  enquiries: number;
  paid: number;
  /** Due, but waiting for HubSpot (unreachable, or the portal check failed). */
  waiting: number;
}

/** The daily job. */
export async function runRetention(deps: RetentionDeps, now: Date): Promise<RetentionRun> {
  const run: RetentionRun = { photos: 0, enquiries: 0, paid: 0, waiting: 0 };
  for (const o of await retentionOrders(deps.db)) {
    const due = rulesDue(o, now);
    if (due.length === 0) continue;
    try {
      if (due.includes('paid') || due.includes('enquiries')) {
        await cleanCrmForDeletion(deps, o);
        await deleteOrder(deps, o.id);
        run[due.includes('paid') ? 'paid' : 'enquiries']++;
      } else if (due.includes('photos')) {
        if ((await deletePhotos(deps, o.id)) > 0) run.photos++;
      }
    } catch (err) {
      run.waiting++;
      // Type and code only; never the order or the customer.
      logError('retention_order_waiting', err);
    }
  }
  await deps.db.query(
    `INSERT INTO retention_runs (at, rule, count) VALUES ($1, 'photos', $2), ($1, 'enquiries', $3), ($1, 'paid', $4), ($1, 'waiting', $5)`,
    [now, run.photos, run.enquiries, run.paid, run.waiting],
  );
  log('retention_run', { ...run });
  return run;
}

// ── Heads-up (AC6) ────────────────────────────────────────────────────────────

export interface Upcoming {
  rule: Rule;
  due: string;
  reference: string;
  isTest: boolean;
  erased: boolean;
}

/** What the rules will delete in the next 14 days (extended orders aside), soonest first. */
export async function upcomingDeletions(db: Db, now: Date): Promise<Upcoming[]> {
  const today = sydneyDate(now);
  const horizon = addDays(today, HEADS_UP_DAYS);
  const out: Upcoming[] = [];
  for (const o of await retentionOrders(db)) {
    if (isExtended(o, today)) continue;
    const due = dueDates(o);
    for (const rule of RULE_NAMES) {
      const d = due[rule];
      if (d && d <= horizon) out.push({ rule, due: d, reference: o.reference, isTest: o.isTest, erased: o.erased });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.reference.localeCompare(b.reference));
}

// ── Extensions (AC6) ──────────────────────────────────────────────────────────

export const MAX_EXTENSION_REASON = 500;

export class RetentionError extends Error {
  constructor(
    readonly httpStatus: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'RetentionError';
  }
}

/** Holds one order back until `until` (a Sydney date after today, at most 5 years on). Null clears it. */
export async function setExtension(db: Db, reference: string, ext: { until: string; reason: string } | null, now: Date): Promise<void> {
  const today = sydneyDate(now);
  let until: string | null = null;
  let reason: string | null = null;
  if (ext) {
    reason = ext.reason.trim();
    until = ext.until;
    if (!reason) throw new RetentionError(400, 'Give a reason for keeping it longer (a dispute, say).');
    if (reason.length > MAX_EXTENSION_REASON) throw new RetentionError(400, `Keep the reason under ${MAX_EXTENSION_REASON} characters.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= today) throw new RetentionError(400, 'The new date must be after today.');
    if (until > addMonths(today, 60)) throw new RetentionError(400, 'An extension can run at most 5 years.');
  }
  const { rows } = await db.query(
    `UPDATE orders SET retain_until = $2::date, retain_reason = $3, retain_set_at = $4 WHERE reference = $1 AND NOT is_smoke RETURNING id`,
    [reference, until, reason, ext ? now : null],
  );
  if (rows.length === 0) throw new RetentionError(404, 'No such order.');
}

/** Extensions still in force, soonest ending first. */
export async function activeExtensions(db: Db, now: Date): Promise<{ reference: string; until: string; reason: string }[]> {
  const { rows } = await db.query<{ reference: string; until: string; reason: string }>(
    `SELECT reference, retain_until::text AS until, retain_reason AS reason FROM orders
      WHERE retain_until IS NOT NULL AND retain_until >= $1::date AND NOT is_smoke ORDER BY retain_until, reference`,
    [sydneyDate(now)],
  );
  return rows;
}

/** The last runs' counts, newest first (for the admin). */
export async function recentRuns(db: Db, limit = 7): Promise<{ at: Date; counts: Record<string, number> }[]> {
  const { rows } = await db.query<{ at: Date; rule: string; count: number }>(
    `SELECT at, rule, count FROM retention_runs WHERE at IN (SELECT DISTINCT at FROM retention_runs ORDER BY at DESC LIMIT $1)
      ORDER BY at DESC, rule`,
    [limit],
  );
  const byAt = new Map<number, { at: Date; counts: Record<string, number> }>();
  for (const r of rows) {
    const at = new Date(r.at);
    const entry = byAt.get(at.getTime()) ?? { at, counts: {} };
    entry.counts[r.rule] = Number(r.count);
    byAt.set(at.getTime(), entry);
  }
  return [...byAt.values()];
}
