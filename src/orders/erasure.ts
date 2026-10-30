/**
 * Erasure on request (SCRUM-75 AC7 and AC8; privacy policy, "Your rights").
 *
 * Attila looks the customer up by email address in the admin, sees exactly what will go, and
 * confirms. For each of that address's orders:
 *
 *   never paid                 deleted entirely (rows, photo files, status links, emails, notes);
 *   paid, inside its 5 years   minimised to the tax record: reference, name, dates, statuses,
 *                              amount (and, with SCRUM-9, the payment reference). Photos,
 *                              address, phone, email, paddle details, the review, notes, history
 *                              notes, status links and queued emails go now. The paid rule
 *                              deletes the rest when its 5 years are up.
 *
 * HubSpot first: the contact is deleted with HubSpot's GDPR delete (permanent), and each deal is
 * deleted, or stripped to reference and amount for a minimised order. If HubSpot can't be reached
 * nothing at all is changed, so a retry starts clean. Refused while any of the orders is still
 * open (Submitted to Posted back): erasing a return address would strand the paddle.
 *
 * Each erasure writes an audit row: when, how many orders of each kind, and which categories of
 * data went. Never the email, name or references.
 */
import { createHash } from 'node:crypto';
import { checkPortal } from '../crm/sync.js';
import { log } from '../log.js';
import { sydneyDate } from './dates.js';
import { normaliseEmail, type OrderStatus } from './model.js';
import { addMonths, END_STATUSES, RULES, type RetentionDeps } from './retention.js';

export type ErasureAction = 'delete' | 'minimise';

export interface ErasurePlanOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  createdAt: Date;
  action: ErasureAction;
  /** Minimise: the day the paid rule deletes the rest. */
  keptUntil: string | null;
  crmContactId: string | null;
  crmDealId: string | null;
}

export interface ErasurePlan {
  email: string;
  orders: ErasurePlanOrder[];
  /** References of orders still open: erasure is refused while there are any. */
  open: string[];
  /** Ties the confirmation to exactly this plan: if anything changes, the confirm is refused. */
  fingerprint: string;
}

/** The categories an erasure removes, as the audit row and the preview list them. */
export const DELETED_CATEGORIES = [
  'photos',
  'email address',
  'phone',
  'return address',
  'paddle details',
  'review',
  'internal notes',
  'history notes',
  'status links',
  'queued emails',
  'HubSpot contact',
] as const;

export async function planErasure(deps: Pick<RetentionDeps, 'db'>, email: string, now: Date): Promise<ErasurePlan> {
  const emailNorm = normaliseEmail(email);
  const { rows } = await deps.db.query<{
    id: string;
    reference: string;
    status: OrderStatus;
    created_at: Date;
    status_changed_at: Date;
    crm_contact_id: string | null;
    crm_deal_id: string | null;
    ever_paid: boolean;
  }>(
    `SELECT o.id, o.reference, o.status, o.created_at, o.status_changed_at, o.crm_contact_id, o.crm_deal_id,
            EXISTS (SELECT 1 FROM status_history h WHERE h.order_id = o.id AND h.status = 'paid') AS ever_paid
       FROM orders o WHERE o.email_norm = $1 AND o.email_norm <> '' AND NOT o.is_smoke AND o.erased_at IS NULL
      ORDER BY o.created_at, o.reference`,
    [emailNorm],
  );
  const today = sydneyDate(now);
  const orders: ErasurePlanOrder[] = rows.map((r) => {
    const keptUntil = r.ever_paid ? addMonths(sydneyDate(new Date(r.status_changed_at)), RULES.paid.months) : null;
    const minimise = keptUntil !== null && keptUntil > today;
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      createdAt: new Date(r.created_at),
      action: minimise ? 'minimise' : 'delete',
      keptUntil: minimise ? keptUntil : null,
      crmContactId: r.crm_contact_id,
      crmDealId: r.crm_deal_id,
    };
  });
  const fingerprint = createHash('sha256')
    .update(emailNorm)
    .update(orders.map((o) => `${o.id}:${o.action}:${o.status}`).join('|'))
    .digest('base64url');
  return { email: emailNorm, orders, open: orders.filter((o) => !END_STATUSES.has(o.status)).map((o) => o.reference), fingerprint };
}

export class ErasureError extends Error {
  constructor(
    readonly code: 'nothing' | 'open_orders' | 'changed' | 'crm_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ErasureError';
  }
}

export interface ErasureResult {
  deleted: number;
  minimised: number;
  crm: 'deleted' | 'not configured';
}

export async function eraseCustomer(deps: RetentionDeps, email: string, fingerprint: string, now: Date): Promise<ErasureResult> {
  const plan = await planErasure(deps, email, now);
  if (plan.orders.length === 0) throw new ErasureError('nothing', 'There are no orders for that address.');
  if (plan.fingerprint !== fingerprint) throw new ErasureError('changed', 'The orders for this address changed since the preview. Look again before confirming.');
  if (plan.open.length) throw new ErasureError('open_orders', `Finish or withdraw these orders first: ${plan.open.join(', ')}.`);

  // ── HubSpot first: if it fails, nothing here has changed yet. ──
  let crm: ErasureResult['crm'] = 'not configured';
  const adapter = deps.crm?.adapter;
  if (adapter && deps.crm) {
    try {
      if ((await checkPortal(deps.crm)) === 'mismatch') throw new Error('crm_portal_mismatch');
      const contacts = new Set(plan.orders.map((o) => o.crmContactId).filter((id): id is string => !!id));
      const found = await adapter.findContactId(plan.email);
      if (found) contacts.add(found);
      for (const o of plan.orders) {
        if (!o.crmDealId) continue;
        if (o.action === 'delete') await adapter.deleteDeal(o.crmDealId);
        else await adapter.stripDeal(o.crmDealId);
      }
      for (const id of contacts) await adapter.deleteContact(id);
      crm = 'deleted';
    } catch (err) {
      throw new ErasureError('crm_unavailable', `HubSpot couldn’t be updated (${(err as Error).message ?? 'error'}), so nothing was erased. Try again shortly.`);
    }
  }

  // ── Then the order database, in one transaction. ──
  const deleteIds = plan.orders.filter((o) => o.action === 'delete').map((o) => o.id);
  const minimiseIds = plan.orders.filter((o) => o.action === 'minimise').map((o) => o.id);
  const paths = await deps.db.tx(async (q) => {
    const all = [...deleteIds, ...minimiseIds];
    const { rows: files } = await q.query<{ path: string }>(
      `SELECT ph.path FROM photos ph JOIN paddles p ON p.id = ph.paddle_id WHERE p.order_id = ANY($1::uuid[])`,
      [all],
    );
    if (deleteIds.length) await q.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [deleteIds]);
    if (minimiseIds.length) {
      const ids = [minimiseIds];
      await q.query('DELETE FROM photos ph USING paddles p WHERE ph.paddle_id = p.id AND p.order_id = ANY($1::uuid[])', ids);
      await q.query(`UPDATE paddles SET brand = '[erased]', model = NULL WHERE order_id = ANY($1::uuid[])`, ids);
      for (const table of ['status_tokens', 'outbox', 'order_notes', 'reviews']) {
        await q.query(`DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`, ids);
      }
      await q.query('UPDATE status_history SET note = NULL WHERE order_id = ANY($1::uuid[])', ids);
      await q.query(
        `UPDATE orders SET email = '', email_norm = '', phone = NULL, street = '', suburb = '', state = '', postcode = '',
                tracking_number = NULL, idempotency_key = NULL, crm_contact_id = NULL,
                -- SCRUM-81: the amounts and terms are the tax record and stay; the postage working
                -- (its zone comes from the address) and Attila's free-text reason go.
                postage_detail = NULL, postage_override_reason = NULL,
                review_reminder_at = COALESCE(review_reminder_at, $2), erased_at = $2, updated_at = $2
          WHERE id = ANY($1::uuid[])`,
        [minimiseIds, now],
      );
    }
    await q.query(
      'INSERT INTO erasures (at, orders_deleted, orders_minimised, categories, crm) VALUES ($1, $2, $3, $4, $5)',
      [now, deleteIds.length, minimiseIds.length, DELETED_CATEGORIES.filter((c) => c !== 'HubSpot contact' || crm === 'deleted').join(', '), crm],
    );
    return files.map((f) => f.path);
  });
  for (const p of paths) await deps.photos.remove(p).catch(() => undefined);
  log('erasure', { deleted: deleteIds.length, minimised: minimiseIds.length, crm });
  return { deleted: deleteIds.length, minimised: minimiseIds.length, crm };
}

export async function recentErasures(deps: Pick<RetentionDeps, 'db'>, limit = 20) {
  const { rows } = await deps.db.query<{ at: Date; orders_deleted: number; orders_minimised: number; categories: string; crm: string }>(
    'SELECT at, orders_deleted, orders_minimised, categories, crm FROM erasures ORDER BY at DESC LIMIT $1',
    [limit],
  );
  return rows.map((r) => ({ ...r, at: new Date(r.at) }));
}
