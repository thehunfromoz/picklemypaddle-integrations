/**
 * Private order status (SCRUM-70): what a status link shows, and fresh links by email.
 *
 * The view is deliberately minimal: no name, address, phone, email or photos, because anyone
 * holding the link can see it.
 */
import type { Db } from '../db/db.js';
import {
  hashToken,
  linkIsLive,
  newStatusToken,
  normaliseEmail,
  STATUS_LABELS,
  TOKEN_RE,
  type OrderStatus,
} from './model.js';
import { paddlesAhead, promiseOf } from './queue.js';

export interface StatusView {
  reference: string;
  status: OrderStatus;
  statusLabel: string;
  history: { status: OrderStatus; label: string; at: string }[];
  paddles: { brand: string; model: string | null }[];
  /** Once Posted back. */
  trackingNumber: string | null;
  /** SCRUM-73: the promise date (YYYY-MM-DD, Sydney), while In queue or Re-gritted. */
  backInPostBy: string | null;
  /** SCRUM-73: paddles in orders ahead of this one, while In queue. */
  paddlesAhead: number | null;
  /** Reserved before SCRUM-73 and never filled; always null (older site builds read it). */
  queuePosition: null;
  /** A TEST order (taken outside production). */
  test: boolean;
  /**
   * The review form (SCRUM-33): 'open' once the paddles are on their way back, 'received' once
   * a review has been left, null before then.
   */
  review: 'open' | 'received' | null;
}

/** Every bad link (unknown, malformed, revoked, expired) gets exactly this, by design. */
export const INVALID_LINK = { error: 'invalid_link', message: 'This link isn’t valid or has expired.' } as const;

/** Never valid; hashed for malformed tokens so they cost the same as real lookups. */
const DUMMY_TOKEN = 'x'.repeat(43);

export interface TokenOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  status_changed_at: Date;
  is_test: boolean;
  tracking_number: string | null;
  has_review: boolean;
  /** YYYY-MM-DD, read as text so no driver turns a calendar date into a moment in time. */
  arrived_on: string | null;
  promise_on: string | null;
}

/** The order a live status link opens, or null for any bad link (all treated alike). */
export async function orderForToken(db: Db, token: unknown, now: Date): Promise<TokenOrder | null> {
  const wellFormed = typeof token === 'string' && TOKEN_RE.test(token);
  const { rows } = await db.query<TokenOrder>(
    `SELECT o.id, o.reference, o.status, o.status_changed_at, o.is_test, o.tracking_number,
            o.arrived_on::text AS arrived_on, o.promise_on::text AS promise_on,
            EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id) AS has_review
       FROM status_tokens t JOIN orders o ON o.id = t.order_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hashToken(wellFormed ? token : DUMMY_TOKEN)],
  );
  const order = wellFormed ? rows[0] : undefined;
  if (!order || !linkIsLive(order.status, new Date(order.status_changed_at), now)) return null;
  return order;
}

/** Statuses at which a customer may leave a review (SCRUM-33). */
export const REVIEW_STATUSES: ReadonlySet<OrderStatus> = new Set(['posted_back', 'completed']);

export async function lookupStatus(db: Db, token: unknown, now: Date): Promise<StatusView | null> {
  const order = await orderForToken(db, token, now);
  if (!order) return null;

  const [history, paddles] = await Promise.all([
    db.query<{ status: OrderStatus; at: Date }>('SELECT status, at FROM status_history WHERE order_id = $1 ORDER BY at, id', [order.id]),
    db.query<{ brand: string; model: string | null }>('SELECT brand, model FROM paddles WHERE order_id = $1 ORDER BY position', [order.id]),
  ]);
  return {
    reference: order.reference,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status],
    history: history.rows.map((h) => ({ status: h.status, label: STATUS_LABELS[h.status], at: new Date(h.at).toISOString() })),
    paddles: paddles.rows.map((p) => ({ brand: p.brand, model: p.model })),
    trackingNumber: order.status === 'posted_back' || order.status === 'completed' ? order.tracking_number : null,
    backInPostBy: order.status === 'in_queue' || order.status === 'regritted' ? promiseOf(order) : null,
    paddlesAhead:
      order.status === 'in_queue' && order.arrived_on
        ? await paddlesAhead(db, { id: order.id, reference: order.reference, arrived_on: order.arrived_on, is_test: order.is_test })
        : null,
    queuePosition: null,
    test: order.is_test,
    review: order.has_review ? 'received' : REVIEW_STATUSES.has(order.status) ? 'open' : null,
  };
}

/**
 * Sends the "your links" email (SCRUM-69). Resolves true once delivered to the provider, false
 * if it was deliberately not sent (an address outside the staging allow-list, or no provider in
 * development); throws if sending failed.
 */
export interface LinksMailer {
  sendLinks(to: string, links: { reference: string; token: string }[], isTest: boolean): Promise<boolean>;
}

export type LinksOutcome = { orders: number; sent: boolean };

/**
 * "Email me my links": a fresh link for each of the address's orders still inside its link
 * window, in one email, replacing the older links for those orders. The caller always gives the
 * same answer whatever this finds. Without a mailer (until SCRUM-69) nothing is changed, so no
 * working link is ever revoked without its replacement being delivered.
 */
export async function requestLinks(db: Db, email: string, now: Date, mailer: LinksMailer | null): Promise<LinksOutcome> {
  const { rows } = await db.query<{ id: string; reference: string; status: OrderStatus; status_changed_at: Date; is_test: boolean }>(
    'SELECT id, reference, status, status_changed_at, is_test FROM orders WHERE email_norm = $1 ORDER BY created_at',
    [normaliseEmail(email)],
  );
  const live = rows.filter((o) => linkIsLive(o.status, new Date(o.status_changed_at), now));
  if (live.length === 0 || !mailer) return { orders: live.length, sent: false };

  // New links first; the old ones are revoked only once the email carrying the new ones has gone,
  // so a failed send never leaves the customer with no working link.
  const fresh = live.map((o) => ({ order: o, token: newStatusToken() }));
  const ids = await db.tx(async (q) => {
    const out: string[] = [];
    for (const f of fresh) {
      const { rows: r } = await q.query<{ id: string }>(
        'INSERT INTO status_tokens (order_id, token_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
        [f.order.id, hashToken(f.token), now],
      );
      out.push(String(r[0]!.id));
    }
    return out;
  });
  let delivered: boolean;
  try {
    delivered = await mailer.sendLinks(email.trim(), fresh.map((f) => ({ reference: f.order.reference, token: f.token })), live.some((o) => o.is_test));
  } catch (err) {
    await db.query('DELETE FROM status_tokens WHERE id = ANY($1::bigint[])', [ids]);
    throw err;
  }
  if (!delivered) {
    // Not sent on purpose: keep the customer's existing links working.
    await db.query('DELETE FROM status_tokens WHERE id = ANY($1::bigint[])', [ids]);
    return { orders: live.length, sent: false };
  }
  await db.query(
    'UPDATE status_tokens SET revoked_at = $2 WHERE order_id = ANY($1::uuid[]) AND revoked_at IS NULL AND NOT (id = ANY($3::bigint[]))',
    [live.map((o) => o.id), now, ids],
  );
  return { orders: live.length, sent: true };
}
