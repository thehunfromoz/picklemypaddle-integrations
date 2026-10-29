/**
 * What the admin pages read (SCRUM-72). Smoke-test orders (SCRUM-68) never appear: they are the
 * staging updater's, and are deleted within a day.
 */
import type { Db } from '../db/db.js';
import { addBusinessDays, promiseState, sydneyDate } from '../orders/dates.js';
import type { OrderStatus } from '../orders/model.js';
import { promiseOf } from '../orders/queue.js';

/** Statuses that carry a "back in the post by" promise (SCRUM-73). */
const PROMISED: ReadonlySet<OrderStatus> = new Set(['in_queue', 'regritted']);

/** The default list: everything waiting on Attila (AC1). */
export const WAITING: readonly OrderStatus[] = ['submitted', 'questions', 'paid', 'in_queue', 'regritted'];

/** Short names for the admin (the customer's wording lives in STATUS_LABELS). */
export const ADMIN_LABELS: Record<OrderStatus, string> = {
  submitted: 'Submitted',
  questions: 'Questions',
  accepted: 'Accepted',
  paid: 'Paid',
  in_queue: 'In queue',
  regritted: 'Re-gritted',
  posted_back: 'Posted back',
  completed: 'Completed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  lapsed: 'Lapsed',
};

const DAY = 24 * 60 * 60 * 1000;

export interface ListedOrder {
  reference: string;
  createdAt: Date;
  status: OrderStatus;
  statusChangedAt: Date;
  isTest: boolean;
  paddles: number;
  daysInStatus: number;
  /** Past the 1-business-day reply promise (Submitted and not answered yet). */
  overdue: boolean;
  /** SCRUM-73: In queue or Re-gritted: the promise date, and whether it is close or past. */
  promise: { on: string; state: 'ok' | 'soon' | 'late' } | null;
}

function promiseFor(status: OrderStatus, order: { promise_on: string | null; arrived_on: string | null }, now: Date) {
  const on = PROMISED.has(status) ? promiseOf(order) : null;
  return on ? { on, state: promiseState(on, now) } : null;
}

/** The reply promise: answered by the end of the next business day in Sydney. */
export function replyOverdue(status: OrderStatus, createdAt: Date, now: Date): boolean {
  return status === 'submitted' && sydneyDate(now) > addBusinessDays(sydneyDate(createdAt), 1);
}

export async function listOrders(db: Db, statuses: readonly OrderStatus[], now: Date): Promise<ListedOrder[]> {
  const { rows } = await db.query<{
    reference: string;
    created_at: Date;
    status: OrderStatus;
    status_changed_at: Date;
    is_test: boolean;
    paddles: number | string;
    arrived_on: string | null;
    promise_on: string | null;
  }>(
    `SELECT o.reference, o.created_at, o.status, o.status_changed_at, o.is_test,
            o.arrived_on::text AS arrived_on, o.promise_on::text AS promise_on,
            (SELECT count(*) FROM paddles p WHERE p.order_id = o.id)::int AS paddles
       FROM orders o
      WHERE NOT o.is_smoke AND o.status = ANY($1::text[])
      ORDER BY o.created_at`,
    [statuses],
  );
  return rows.map((r) => {
    const createdAt = new Date(r.created_at);
    const statusChangedAt = new Date(r.status_changed_at);
    return {
      reference: r.reference,
      createdAt,
      status: r.status,
      statusChangedAt,
      isTest: r.is_test,
      paddles: Number(r.paddles),
      daysInStatus: Math.max(0, Math.floor((now.getTime() - statusChangedAt.getTime()) / DAY)),
      overdue: replyOverdue(r.status, createdAt, now),
      promise: promiseFor(r.status, r, now),
    };
  });
}

export interface OrderDetail {
  id: string;
  reference: string;
  status: OrderStatus;
  statusChangedAt: Date;
  createdAt: Date;
  isTest: boolean;
  name: string;
  email: string;
  phone: string | null;
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  trackingNumber: string | null;
  arrivedOn: string | null;
  promise: { on: string; state: 'ok' | 'soon' | 'late' } | null;
  crmDealId: string | null;
  paddles: { position: number; brand: string; model: string | null; photos: { id: string; side: 'front' | 'back' }[] }[];
  history: { status: string; at: Date; actor: string | null; note: string | null }[];
  notes: { at: Date; author: string; note: string }[];
  outbox: {
    id: string;
    kind: 'email' | 'crm';
    template: string;
    state: string;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    doneAt: Date | null;
  }[];
  review: { quote: string; firstName: string; suburb: string; permission: boolean; createdAt: Date } | null;
}

export async function loadOrder(db: Db, reference: string, now: Date = new Date()): Promise<OrderDetail | null> {
  const { rows } = await db.query<{
    id: string;
    reference: string;
    status: OrderStatus;
    status_changed_at: Date;
    created_at: Date;
    is_test: boolean;
    is_smoke: boolean;
    name: string;
    email: string;
    phone: string | null;
    street: string;
    suburb: string;
    state: string;
    postcode: string;
    tracking_number: string | null;
    arrived_on: string | null;
    promise_on: string | null;
    crm_deal_id: string | null;
  }>(
    `SELECT id, reference, status, status_changed_at, created_at, is_test, is_smoke, name, email, phone,
            street, suburb, state, postcode, tracking_number, arrived_on::text AS arrived_on,
            promise_on::text AS promise_on, crm_deal_id
       FROM orders WHERE reference = $1`,
    [reference],
  );
  const o = rows[0];
  if (!o || o.is_smoke) return null;

  const [paddles, photos, history, notes, outbox, reviews] = await Promise.all([
    db.query<{ id: string; position: number; brand: string; model: string | null }>(
      'SELECT id, position, brand, model FROM paddles WHERE order_id = $1 ORDER BY position',
      [o.id],
    ),
    db.query<{ id: string; paddle_id: string; side: 'front' | 'back' }>(
      `SELECT ph.id, ph.paddle_id, ph.side FROM photos ph JOIN paddles p ON p.id = ph.paddle_id
        WHERE p.order_id = $1 ORDER BY p.position, ph.side DESC`,
      [o.id],
    ),
    db.query<{ status: string; at: Date; actor: string | null; note: string | null }>(
      'SELECT status, at, actor, note FROM status_history WHERE order_id = $1 ORDER BY at, id',
      [o.id],
    ),
    db.query<{ at: Date; author: string; note: string }>('SELECT at, author, note FROM order_notes WHERE order_id = $1 ORDER BY at, id', [o.id]),
    db.query<{
      id: string;
      kind: 'email' | 'crm';
      template: string;
      state: string;
      attempts: number;
      last_error: string | null;
      created_at: Date;
      done_at: Date | null;
    }>(
      `SELECT id, kind, template, state, attempts, last_error, created_at, done_at FROM outbox
        WHERE order_id = $1 ORDER BY created_at, id`,
      [o.id],
    ),
    db.query<{ quote: string; first_name: string; suburb: string; permission: boolean; created_at: Date }>(
      'SELECT quote, first_name, suburb, permission, created_at FROM reviews WHERE order_id = $1',
      [o.id],
    ),
  ]);

  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    statusChangedAt: new Date(o.status_changed_at),
    createdAt: new Date(o.created_at),
    isTest: o.is_test,
    name: o.name,
    email: o.email,
    phone: o.phone,
    street: o.street,
    suburb: o.suburb,
    state: o.state,
    postcode: o.postcode,
    trackingNumber: o.tracking_number,
    arrivedOn: o.arrived_on,
    promise: promiseFor(o.status, o, now),
    crmDealId: o.crm_deal_id,
    paddles: paddles.rows.map((p) => ({
      position: p.position,
      brand: p.brand,
      model: p.model,
      photos: photos.rows.filter((ph) => ph.paddle_id === p.id).map((ph) => ({ id: ph.id, side: ph.side })),
    })),
    history: history.rows.map((h) => ({ ...h, at: new Date(h.at) })),
    notes: notes.rows.map((n) => ({ ...n, at: new Date(n.at) })),
    outbox: outbox.rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      template: r.template,
      state: r.state,
      attempts: Number(r.attempts),
      lastError: r.last_error,
      createdAt: new Date(r.created_at),
      doneAt: r.done_at ? new Date(r.done_at) : null,
    })),
    review: reviews.rows[0]
      ? {
          quote: reviews.rows[0].quote,
          firstName: reviews.rows[0].first_name,
          suburb: reviews.rows[0].suburb,
          permission: reviews.rows[0].permission,
          createdAt: new Date(reviews.rows[0].created_at),
        }
      : null,
  };
}

export const MAX_NOTE = 4000;

export async function addNote(db: Db, reference: string, author: string, note: string, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO order_notes (order_id, at, author, note)
     SELECT id, $2, $3, $4 FROM orders WHERE reference = $1 AND NOT is_smoke RETURNING id`,
    [reference, now, author, note],
  );
  return rows.length === 1;
}

/** Which order an outbox row belongs to, and what kind it is (the retry button). */
export async function outboxRow(db: Db, id: string): Promise<{ kind: 'email' | 'crm'; reference: string } | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const { rows } = await db.query<{ kind: 'email' | 'crm'; reference: string }>(
    'SELECT ob.kind, o.reference FROM outbox ob JOIN orders o ON o.id = ob.order_id WHERE ob.id = $1',
    [id],
  );
  return rows[0] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function photoPath(db: Db, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<{ path: string }>('SELECT path FROM photos WHERE id = $1', [id]);
  return rows[0]?.path ?? null;
}
