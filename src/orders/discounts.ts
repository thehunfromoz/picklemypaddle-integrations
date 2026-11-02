/**
 * Discount codes (SCRUM-63, decided 30 Oct and 2 Nov 2026).
 *
 *  - Two kinds of use: a shared code (e.g. LAUNCH10, capped at N uses) or a one-person code
 *    generated in admin (FREE- plus 8 easy-read characters).
 *  - Direct orders only; always off the re-grit, never off return postage, so every order still
 *    pays something through Stripe.
 *  - Checked here, never trusted from the browser: once for the form's estimate and again at
 *    submit. Every refusal gets the same message, whatever the reason.
 *  - A use is reserved at submit (inside the order's transaction, with the code row locked so two
 *    orders can't both take the last use), consumed at Paid, and released when the order is
 *    Rejected, Withdrawn or Lapsed before paying. What the code gives is saved on the order at
 *    submit, so changing or deactivating the code afterwards never changes the order.
 */
import { randomInt } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import { isUniqueViolation } from '../db/db.js';
import { sydneyDate } from './dates.js';
import { REFERENCE_ALPHABET, type OrderStatus } from './model.js';
import { DISCOUNT_CODE_RE, normaliseDiscountCode, type DiscountBenefit, type DiscountKind } from './rules.js';

export interface DiscountCode {
  id: string;
  code: string;
  kind: DiscountKind;
  value: number;
  maxUses: number;
  /** Last day it can be used (Sydney, YYYY-MM-DD), or null for no expiry. */
  expiresOn: string | null;
  onePerEmail: boolean;
  note: string | null;
  active: boolean;
  createdAt: Date;
  /** Uses reserved by open orders plus uses consumed by paid ones. */
  used: number;
}

interface CodeRow {
  id: string;
  code: string;
  kind: DiscountKind;
  value: number;
  max_uses: number;
  expires_on: string | null;
  one_per_email: boolean;
  note: string | null;
  active: boolean;
  created_at: Date;
  used: number;
}

/** Counts towards the cap: consumed uses, and reserved ones whose order still exists. */
const USED_SQL = `(SELECT count(*)::int FROM discount_uses u
                    WHERE u.code_id = c.id AND (u.state = 'consumed' OR (u.state = 'reserved' AND u.order_id IS NOT NULL)))`;

const SELECT_CODES = `SELECT c.id, c.code, c.kind, c.value, c.max_uses, c.expires_on::text AS expires_on, c.one_per_email,
                             c.note, c.active, c.created_at, ${USED_SQL} AS used
                        FROM discount_codes c`;

const toCode = (r: CodeRow): DiscountCode => ({
  id: String(r.id),
  code: r.code,
  kind: r.kind,
  value: Number(r.value),
  maxUses: Number(r.max_uses),
  expiresOn: r.expires_on,
  onePerEmail: r.one_per_email,
  note: r.note,
  active: r.active,
  createdAt: new Date(r.created_at),
  used: Number(r.used),
});

export type CheckResult = { ok: true; code: DiscountCode; benefit: DiscountBenefit } | { ok: false; reason: RefusalReason };
/** For tests and counts only: customers always see the same message. */
export type RefusalReason = 'malformed' | 'unknown' | 'inactive' | 'expired' | 'used_up' | 'used_by_email';

/**
 * Can `code` be used today (by `emailNorm`, when known)? With `lock`, the code's row is locked
 * until the transaction ends, so a reservation made next can't race another order's.
 */
export async function checkCode(
  q: Queryable,
  rawCode: string,
  opts: { now: Date; emailNorm?: string | null; lock?: boolean },
): Promise<CheckResult> {
  const code = normaliseDiscountCode(rawCode);
  if (!DISCOUNT_CODE_RE.test(code)) return { ok: false, reason: 'malformed' };
  if (opts.lock) await q.query('SELECT id FROM discount_codes WHERE code = $1 FOR UPDATE', [code]);
  const { rows } = await q.query<CodeRow>(`${SELECT_CODES} WHERE c.code = $1`, [code]);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  const found = toCode(row);
  if (!found.active) return { ok: false, reason: 'inactive' };
  if (found.expiresOn !== null && sydneyDate(opts.now) > found.expiresOn) return { ok: false, reason: 'expired' };
  if (found.used >= found.maxUses) return { ok: false, reason: 'used_up' };
  if (found.onePerEmail && opts.emailNorm) {
    const { rows: mine } = await q.query(
      `SELECT 1 FROM discount_uses u JOIN orders o ON o.id = u.order_id
        WHERE u.code_id = $1 AND u.state IN ('reserved', 'consumed') AND o.email_norm = $2 LIMIT 1`,
      [found.id, opts.emailNorm],
    );
    if (mine.length > 0) return { ok: false, reason: 'used_by_email' };
  }
  return { ok: true, code: found, benefit: { kind: found.kind, value: found.value } };
}

/**
 * Reserves a use for a new order, inside the order's transaction. Re-checks everything with the
 * code locked; returns the refusal reason if it can't be used any more.
 */
export async function reserveCode(
  q: Queryable,
  order: { id: string; reference: string; emailNorm: string },
  rawCode: string,
  now: Date,
): Promise<CheckResult> {
  const checked = await checkCode(q, rawCode, { now, emailNorm: order.emailNorm, lock: true });
  if (!checked.ok) return checked;
  await q.query(
    `INSERT INTO discount_uses (code_id, order_id, reference, state, reserved_at) VALUES ($1, $2, $3, 'reserved', $4)`,
    [checked.code.id, order.id, order.reference, now],
  );
  await q.query('UPDATE orders SET discount_code = $2, discount_kind = $3, discount_value = $4 WHERE id = $1', [
    order.id, checked.code.code, checked.benefit.kind, checked.benefit.value,
  ]);
  return checked;
}

/** Statuses that give a reserved use back (the order never paid). */
export const RELEASE_ON: ReadonlySet<OrderStatus> = new Set(['rejected', 'withdrawn', 'lapsed']);

/**
 * Follows an order's status change: Paid consumes its reserved use; Rejected, Withdrawn or Lapsed
 * release it. A use already consumed (the order paid) stays consumed. No code, nothing to do.
 */
export async function settleUseForStatus(q: Queryable, orderId: string, to: OrderStatus, now: Date): Promise<void> {
  if (to === 'paid') {
    await q.query(`UPDATE discount_uses SET state = 'consumed', settled_at = $2 WHERE order_id = $1 AND state = 'reserved'`, [orderId, now]);
  } else if (RELEASE_ON.has(to)) {
    await q.query(`UPDATE discount_uses SET state = 'released', settled_at = $2 WHERE order_id = $1 AND state = 'reserved'`, [orderId, now]);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export class DiscountCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscountCodeError';
  }
}

export interface NewCode {
  /** Empty or missing: generate a one-person code. */
  code?: string;
  kind: DiscountKind;
  value: number;
  maxUses: number;
  expiresOn: string | null;
  onePerEmail: boolean;
  note: string | null;
}

export const GENERATED_PREFIX = 'FREE-';
export const GENERATED_LENGTH = 8;
export const MAX_CODE_NOTE = 500;

/** FREE- plus 8 characters from the reference alphabet (no 0/O, 1/I/L): about 40 bits. */
export function generateCode(): string {
  let out = GENERATED_PREFIX;
  for (let i = 0; i < GENERATED_LENGTH; i++) out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return out;
}

function validateNew(c: NewCode, today: string): void {
  if (c.kind === 'free' && (!Number.isInteger(c.value) || c.value < 1 || c.value > 10)) {
    throw new DiscountCodeError('A free re-grit covers 1 to 10 paddles.');
  }
  if (c.kind === 'amount' && (!Number.isInteger(c.value) || c.value < 1 || c.value > 60_000)) {
    throw new DiscountCodeError('The amount off must be between A$0.01 and A$600.');
  }
  if (c.kind === 'percent' && (!Number.isInteger(c.value) || c.value < 1 || c.value > 100)) {
    throw new DiscountCodeError('The percentage must be a whole number from 1 to 100.');
  }
  if (!Number.isInteger(c.maxUses) || c.maxUses < 1 || c.maxUses > 10_000) throw new DiscountCodeError('Total uses must be 1 to 10,000.');
  if (c.expiresOn !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(c.expiresOn) || c.expiresOn < today)) {
    throw new DiscountCodeError('The expiry date must be today or later.');
  }
  if (c.note && c.note.length > MAX_CODE_NOTE) throw new DiscountCodeError(`Keep the note under ${MAX_CODE_NOTE} characters.`);
}

export async function createCode(q: Queryable, c: NewCode, by: string, now: Date): Promise<DiscountCode> {
  validateNew(c, sydneyDate(now));
  const typed = c.code?.trim() ? normaliseDiscountCode(c.code) : null;
  if (typed !== null && !DISCOUNT_CODE_RE.test(typed)) {
    throw new DiscountCodeError('Codes are 3 to 32 letters, digits and hyphens, starting and ending with a letter or digit.');
  }
  for (let attempt = 1; ; attempt++) {
    const code = typed ?? generateCode();
    try {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO discount_codes (code, kind, value, max_uses, expires_on, one_per_email, note, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9) RETURNING id`,
        [code, c.kind, c.value, c.maxUses, c.expiresOn, c.onePerEmail, c.note?.trim() || null, now, by],
      );
      return (await findCode(q, rows[0]!.id))!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (typed !== null) throw new DiscountCodeError(`There is already a code ${typed}.`);
      if (attempt >= 5) throw err;
    }
  }
}

export async function findCode(q: Queryable, id: string): Promise<DiscountCode | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const { rows } = await q.query<CodeRow>(`${SELECT_CODES} WHERE c.id = $1`, [id]);
  return rows[0] ? toCode(rows[0]) : null;
}

export async function listCodes(q: Queryable): Promise<DiscountCode[]> {
  const { rows } = await q.query<CodeRow>(`${SELECT_CODES} ORDER BY c.active DESC, c.created_at DESC`);
  return rows.map(toCode);
}

export async function setCodeActive(q: Queryable, id: string, active: boolean): Promise<boolean> {
  if (!/^\d{1,18}$/.test(id)) return false;
  const { rows } = await q.query('UPDATE discount_codes SET active = $2 WHERE id = $1 RETURNING id', [id, active]);
  return rows.length > 0;
}

export interface CodeUse {
  reference: string;
  state: 'reserved' | 'consumed' | 'released';
  /** False once the order has been deleted (retention or erasure). */
  orderExists: boolean;
  reservedAt: Date;
  settledAt: Date | null;
}

/** A code's uses, references only (AC7). */
export async function usesOf(q: Queryable, codeId: string): Promise<CodeUse[]> {
  const { rows } = await q.query<{ reference: string; state: CodeUse['state']; order_id: string | null; reserved_at: Date; settled_at: Date | null }>(
    'SELECT reference, state, order_id, reserved_at, settled_at FROM discount_uses WHERE code_id = $1 ORDER BY reserved_at DESC',
    [codeId],
  );
  return rows.map((r) => ({
    reference: r.reference,
    state: r.state,
    orderExists: r.order_id !== null,
    reservedAt: new Date(r.reserved_at),
    settledAt: r.settled_at ? new Date(r.settled_at) : null,
  }));
}
