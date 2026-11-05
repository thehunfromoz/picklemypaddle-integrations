/**
 * Clubs and their batches (SCRUM-85, the minimum SCRUM-10 builds on).
 *
 *  - A club holds its name and billing details only. Club members' details are never held: the
 *    club keeps them (decided 6 Oct 2026). SCRUM-85 uses the statuses active and inactive; the
 *    pipeline before them (lead, meeting, agreement sent) is SCRUM-93's.
 *  - A batch is one pickup's paddles: Collected → Returned → Invoiced → Paid, or Cancelled before
 *    it is returned. Marking it returned issues the invoice in the same transaction (paddles
 *    re-gritted × the club price on the issue date, GST added on top once registered) and queues
 *    the invoice email to the billing contact. Paddles returned unchanged aren't charged; a batch
 *    returned entirely unchanged stays Returned, with nothing to invoice.
 *  - Clubs never get discount codes (decided 30 Oct 2026): nothing here applies one.
 */
import { randomInt } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { DocumentError, issueClubInvoice, type Seller } from '../documents/documents.js';
import { ISO_DATE_RE, sydneyDate } from '../orders/dates.js';
import { REFERENCE_ALPHABET } from '../orders/model.js';
import { isValidAbn } from '../pricing/terms.js';

export const CLUB_STATUSES = ['lead', 'meeting', 'agreement_sent', 'active', 'inactive'] as const;
export type ClubStatus = (typeof CLUB_STATUSES)[number];

export const BATCH_STATUSES = ['collected', 'returned', 'invoiced', 'paid', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  collected: 'Collected',
  returned: 'Returned',
  invoiced: 'Invoiced',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export const BATCH_REFERENCE_RE = new RegExp(`^PMPB-[${REFERENCE_ALPHABET}]{5}$`);
export const MAX_BATCH_PADDLES = 500;
export const MAX_CLUB_NOTE = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ClubError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ClubError';
  }
}

export interface Club {
  id: string;
  name: string;
  billingName: string;
  billingEmail: string;
  billingAddress: string;
  abn: string | null;
  notes: string | null;
  status: ClubStatus;
  isTest: boolean;
  createdAt: Date;
}

export interface ClubInput {
  name: string;
  billingName: string;
  billingEmail: string;
  billingAddress: string;
  abn: string | null;
  notes: string | null;
}

export interface Batch {
  id: string;
  reference: string;
  clubId: string;
  clubName: string;
  status: BatchStatus;
  statusChangedAt: Date;
  collectedOn: string;
  paddleCount: number;
  returnedOn: string | null;
  unchangedCount: number;
  notes: string | null;
  /** The invoice issued on return, if any, and what is still owing on it. */
  invoice: { id: string; number: string; totalCents: number; dueOn: string | null; balanceCents: number } | null;
}

/** An invoiced batch past its due date with something still owing (SCRUM-85 AC6: flagged, never chased). */
export const isOverdue = (b: Batch, today: string) =>
  b.status === 'invoiced' && !!b.invoice?.dueOn && b.invoice.dueOn < today && b.invoice.balanceCents > 0;

// ── Validation ────────────────────────────────────────────────────────────────

const clean = (v: string | null | undefined) => (v ?? '').trim();

/** Checks and tidies a club form. Throws ClubError with a message for Attila. */
export function validateClub(input: Partial<Record<keyof ClubInput, string | null>>): ClubInput {
  const name = clean(input.name);
  const billingName = clean(input.billingName);
  const billingEmail = clean(input.billingEmail).toLowerCase();
  const billingAddress = clean(input.billingAddress).replace(/\r\n/g, '\n');
  const abn = clean(input.abn).replace(/\s/g, '');
  const notes = clean(input.notes);
  if (!name || name.length > 120) throw new ClubError('bad_name', 'Give the club’s name (up to 120 characters).');
  if (!billingName || billingName.length > 120) throw new ClubError('bad_billing_name', 'Give the billing contact’s name (up to 120 characters).');
  if (!EMAIL_RE.test(billingEmail) || billingEmail.length > 254) throw new ClubError('bad_billing_email', 'Give a valid billing email address.');
  if (!billingAddress || billingAddress.length > 400) throw new ClubError('bad_billing_address', 'Give the billing address (up to 400 characters).');
  if (abn && !isValidAbn(abn)) throw new ClubError('bad_abn', 'That ABN isn’t valid: 11 digits, as on the ABN Lookup.');
  if (notes.length > MAX_CLUB_NOTE) throw new ClubError('bad_notes', `Notes can be up to ${MAX_CLUB_NOTE} characters.`);
  return { name, billingName, billingEmail, billingAddress, abn: abn || null, notes: notes || null };
}

// ── Clubs ─────────────────────────────────────────────────────────────────────

interface ClubRow {
  id: string;
  name: string;
  billing_name: string;
  billing_email: string;
  billing_address: string;
  abn: string | null;
  notes: string | null;
  status: ClubStatus;
  is_test: boolean;
  created_at: Date;
}

const toClub = (r: ClubRow): Club => ({
  id: r.id,
  name: r.name,
  billingName: r.billing_name,
  billingEmail: r.billing_email,
  billingAddress: r.billing_address,
  abn: r.abn,
  notes: r.notes,
  status: r.status,
  isTest: r.is_test,
  createdAt: new Date(r.created_at),
});

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

export async function createClub(db: Queryable, input: ClubInput, opts: { isProduction: boolean; now: Date }): Promise<Club> {
  try {
    const { rows } = await db.query<ClubRow>(
      `INSERT INTO clubs (name, billing_name, billing_email, billing_address, abn, notes, status, is_test, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8) RETURNING *`,
      [input.name, input.billingName, input.billingEmail, input.billingAddress, input.abn, input.notes, !opts.isProduction, opts.now],
    );
    return toClub(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClubError('duplicate_name', 'There’s already a club with that name.');
    throw err;
  }
}

export async function updateClub(db: Queryable, id: string, input: ClubInput, now: Date): Promise<Club | null> {
  try {
    const { rows } = await db.query<ClubRow>(
      `UPDATE clubs SET name = $2, billing_name = $3, billing_email = $4, billing_address = $5, abn = $6, notes = $7, updated_at = $8
        WHERE id = $1 RETURNING *`,
      [id, input.name, input.billingName, input.billingEmail, input.billingAddress, input.abn, input.notes, now],
    );
    return rows[0] ? toClub(rows[0]) : null;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClubError('duplicate_name', 'There’s already a club with that name.');
    throw err;
  }
}

/** Active or inactive (SCRUM-85 AC1). An inactive club keeps its batches; new ones can't be added. */
export async function setClubActive(db: Queryable, id: string, active: boolean, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE clubs SET status = $2, updated_at = $3 WHERE id = $1 AND status IN ('active', 'inactive') RETURNING id`,
    [id, active ? 'active' : 'inactive', now],
  );
  return rows.length === 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findClub(db: Queryable, id: string): Promise<Club | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<ClubRow>('SELECT * FROM clubs WHERE id = $1', [id]);
  return rows[0] ? toClub(rows[0]) : null;
}

export async function listClubs(db: Queryable): Promise<(Club & { openBatches: number })[]> {
  const { rows } = await db.query<ClubRow & { open_batches: number }>(
    `SELECT c.*, (SELECT count(*)::int FROM batches b WHERE b.club_id = c.id AND b.status IN ('collected', 'returned', 'invoiced')) AS open_batches
       FROM clubs c ORDER BY (c.status = 'inactive'), lower(c.name)`,
  );
  return rows.map((r) => ({ ...toClub(r), openBatches: Number(r.open_batches) }));
}

// ── Batches ───────────────────────────────────────────────────────────────────

export function newBatchReference(): string {
  let s = 'PMPB-';
  for (let i = 0; i < 5; i++) s += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return s;
}

const BATCH_SELECT = `
  SELECT b.id, b.reference, b.club_id, c.name AS club_name, b.status, b.status_changed_at, b.collected_on::text AS collected_on,
         b.paddle_count, b.returned_on::text AS returned_on, b.unchanged_count, b.notes,
         d.id AS invoice_id, d.number AS invoice_number, d.total_cents AS invoice_total, d.due_on::text AS invoice_due,
         (SELECT COALESCE(sum(p.amount_cents), 0)::int FROM club_payments p WHERE p.document_id = d.id) AS invoice_paid
    FROM batches b JOIN clubs c ON c.id = b.club_id
    LEFT JOIN documents d ON d.batch_id = b.id AND d.kind = 'invoice'`;

interface BatchRow {
  id: string;
  reference: string;
  club_id: string;
  club_name: string;
  status: BatchStatus;
  status_changed_at: Date;
  collected_on: string;
  paddle_count: number;
  returned_on: string | null;
  unchanged_count: number;
  notes: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_total: number | null;
  invoice_due: string | null;
  invoice_paid: number | null;
}

const toBatch = (r: BatchRow): Batch => ({
  id: r.id,
  reference: r.reference,
  clubId: r.club_id,
  clubName: r.club_name,
  status: r.status,
  statusChangedAt: new Date(r.status_changed_at),
  collectedOn: r.collected_on,
  paddleCount: Number(r.paddle_count),
  returnedOn: r.returned_on,
  unchangedCount: Number(r.unchanged_count),
  notes: r.notes,
  invoice: r.invoice_id && r.invoice_number
    ? { id: String(r.invoice_id), number: r.invoice_number, totalCents: Number(r.invoice_total), dueOn: r.invoice_due, balanceCents: Number(r.invoice_total) - Number(r.invoice_paid ?? 0) }
    : null,
});

export async function findBatch(db: Queryable, reference: string): Promise<Batch | null> {
  if (!BATCH_REFERENCE_RE.test(reference)) return null;
  const { rows } = await db.query<BatchRow>(`${BATCH_SELECT} WHERE b.reference = $1`, [reference]);
  return rows[0] ? toBatch(rows[0]) : null;
}

export async function listBatches(db: Queryable, filter: { clubId?: string; open?: boolean } = {}): Promise<Batch[]> {
  const { rows } = await db.query<BatchRow>(
    `${BATCH_SELECT}
      WHERE ($1::uuid IS NULL OR b.club_id = $1::uuid)
        AND (NOT $2::boolean OR b.status IN ('collected', 'returned', 'invoiced'))
      ORDER BY b.collected_on DESC, b.created_at DESC LIMIT 500`,
    [filter.clubId ?? null, filter.open ?? false],
  );
  return rows.map(toBatch);
}

const isDate = (v: string) => ISO_DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function checkCount(n: number, what: string, max = MAX_BATCH_PADDLES): void {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ClubError('bad_count', `${what} must be a whole number from 0 to ${max}.`);
}

/** Records a batch collected from an active club (SCRUM-85 AC2). */
export async function createBatch(
  db: Db,
  args: { clubId: string; collectedOn: string; paddleCount: number; notes: string | null; now: Date },
): Promise<Batch> {
  if (!isDate(args.collectedOn)) throw new ClubError('bad_date', 'Give the collection date.');
  if (args.collectedOn > sydneyDate(args.now)) throw new ClubError('future_date', 'The collection date can’t be in the future.');
  checkCount(args.paddleCount, 'The paddle count');
  if (args.paddleCount < 1) throw new ClubError('bad_count', 'A batch has at least one paddle.');
  const notes = clean(args.notes);
  if (notes.length > MAX_CLUB_NOTE) throw new ClubError('bad_notes', `Notes can be up to ${MAX_CLUB_NOTE} characters.`);
  const club = await findClub(db, args.clubId);
  if (!club) throw new ClubError('no_club', 'No such club.');
  if (club.status !== 'active') throw new ClubError('club_inactive', 'This club isn’t active: reactivate it before recording a batch.');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reference = newBatchReference();
      await db.query(
        `INSERT INTO batches (reference, club_id, status, status_changed_at, collected_on, paddle_count, notes, created_at, updated_at)
         VALUES ($1, $2, 'collected', $3, $4::date, $5, $6, $3, $3)`,
        [reference, club.id, args.now, args.collectedOn, args.paddleCount, notes || null],
      );
      return (await findBatch(db, reference))!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new ClubError('reference_clash', 'Couldn’t make a unique batch reference; try again.');
}

/** Cancels a batch that hasn't been returned (SCRUM-85 AC2). */
export async function cancelBatch(db: Queryable, reference: string, now: Date): Promise<void> {
  const { rows } = await db.query(
    `UPDATE batches SET status = 'cancelled', status_changed_at = $2, updated_at = $2 WHERE reference = $1 AND status = 'collected' RETURNING id`,
    [reference, now],
  );
  if (rows.length !== 1) throw new ClubError('not_cancellable', 'Only a batch that hasn’t been returned can be cancelled.');
}

export interface ReturnDeps {
  db: Db;
  seller: Seller;
  isProduction: boolean;
  paymentTermsDays: number;
  now: Date;
  /** Whether card payments are set up here (Stripe): the invoice then offers "Pay by card". */
  payByCard?: boolean;
}

/**
 * Marks a collected batch returned (SCRUM-85 AC3): in one transaction, the batch is Returned,
 * its invoice is issued (re-gritted paddles only) and the invoice email is queued, and the batch
 * moves on to Invoiced. All of it, or none of it: a failure leaves the batch Collected and no
 * invoice number used.
 */
export async function returnBatch(
  deps: ReturnDeps,
  args: { reference: string; returnedOn: string; unchangedCount: number },
): Promise<{ invoiceId: string | null }> {
  const { now } = deps;
  if (!isDate(args.returnedOn)) throw new ClubError('bad_date', 'Give the return date.');
  if (args.returnedOn > sydneyDate(now)) throw new ClubError('future_date', 'The return date can’t be in the future.');
  checkCount(args.unchangedCount, 'Paddles returned unchanged');
  try {
    return await deps.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; collected_on: string; paddle_count: number; status: BatchStatus }>(
        `SELECT id, collected_on::text AS collected_on, paddle_count, status FROM batches WHERE reference = $1 FOR UPDATE`,
        [args.reference],
      );
      const b = rows[0];
      if (!b) throw new ClubError('no_batch', 'No such batch.');
      if (b.status !== 'collected') throw new ClubError('not_collected', 'Only a collected batch can be returned.');
      if (args.returnedOn < b.collected_on) throw new ClubError('before_collection', 'The return date can’t be before the collection date.');
      if (args.unchangedCount > Number(b.paddle_count)) throw new ClubError('bad_count', 'More paddles unchanged than were collected.');
      await q.query(
        `UPDATE batches SET status = 'returned', returned_on = $2::date, unchanged_count = $3, status_changed_at = $4, updated_at = $4 WHERE id = $1`,
        [b.id, args.returnedOn, args.unchangedCount, now],
      );
      if (args.unchangedCount === Number(b.paddle_count)) return { invoiceId: null };
      const invoiceId = await issueClubInvoice(q, {
        batchId: b.id, seller: deps.seller, isProduction: deps.isProduction, paymentTermsDays: deps.paymentTermsDays, now, payByCard: deps.payByCard ?? false,
      });
      await q.query(`UPDATE batches SET status = 'invoiced', status_changed_at = $2, updated_at = $2 WHERE id = $1`, [b.id, now]);
      return { invoiceId };
    });
  } catch (err) {
    if (err instanceof DocumentError) throw new ClubError(err.code, err.message);
    throw err;
  }
}

/** Saves a batch's internal note. */
export async function setBatchNote(db: Queryable, reference: string, note: string | null, now: Date): Promise<boolean> {
  const n = clean(note);
  if (n.length > MAX_CLUB_NOTE) throw new ClubError('bad_notes', `Notes can be up to ${MAX_CLUB_NOTE} characters.`);
  const { rows } = await db.query('UPDATE batches SET notes = $2, updated_at = $3 WHERE reference = $1 RETURNING id', [reference, n || null, now]);
  return rows.length === 1;
}

export interface BatchEmail {
  id: string;
  template: string;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'suppressed';
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

/** A batch's emails, newest first, for its admin page (and the retry button on a failed one). */
export async function batchEmails(db: Queryable, batchId: string): Promise<BatchEmail[]> {
  const { rows } = await db.query<{ id: string; template: string; state: BatchEmail['state']; attempts: number; last_error: string | null; created_at: Date }>(
    `SELECT id, template, state, attempts, last_error, created_at FROM outbox WHERE batch_id = $1 AND kind = 'email' ORDER BY created_at DESC, id DESC`,
    [batchId],
  );
  return rows.map((r) => ({ id: String(r.id), template: r.template, state: r.state, attempts: Number(r.attempts), lastError: r.last_error, createdAt: new Date(r.created_at) }));
}
