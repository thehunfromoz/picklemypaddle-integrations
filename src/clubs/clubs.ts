/**
 * Clubs and their batches (SCRUM-85, the minimum SCRUM-10 builds on).
 *
 *  - A club holds its name and billing details only. Club members' details are never held: the
 *    club keeps them (decided 6 Oct 2026). SCRUM-85 uses the statuses active and inactive; the
 *    pipeline before them (lead, meeting, agreement sent) is SCRUM-93's.
 *  - A batch is one pickup's (or posted box's) paddles: Collected → Invoiced → Paid → Returned, or
 *    Cancelled before it is invoiced (the club pays before its batch goes back, SCRUM-102). Invoicing
 *    issues the invoice in one transaction (paddles re-gritted × the club price on the issue date,
 *    less the standard cost of the club's postage to us for a posted batch of 6+, GST added on top once registered) and
 *    queues the invoice email to the billing contact. Paddles unchanged aren't charged; a batch with
 *    every paddle unchanged goes Collected → Returned, with nothing to invoice.
 *  - Clubs never get discount codes (decided 30 Oct 2026): nothing here applies one.
 */
import type { Fulfilment } from './service-area.js';
import { randomInt } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { DocumentError, issueClubInvoice, type Seller } from '../documents/documents.js';
import { quotePostage } from '../pricing/postage.js';
import { isAllowed } from '../email/outbox.js';
import { ISO_DATE_RE, sydneyDate } from '../orders/dates.js';
import { REFERENCE_ALPHABET } from '../orders/model.js';
import { isValidAbn } from '../pricing/terms.js';
import { enqueueClubCrmSync } from '../crm/sync.js';

import { type BatchStatus, type ClubStatus } from './model.js';
export { BATCH_STATUSES, CLUB_STATUSES, type BatchStatus, type ClubStatus } from './model.js';
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
  /** Null until the club is a customer (SCRUM-93): a lead has a contact, not billing details yet. */
  billingName: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  abn: string | null;
  notes: string | null;
  status: ClubStatus;
  isTest: boolean;
  createdAt: Date;
  /** SCRUM-93: what the club told us in the "Talk to us" form. Never members' details. */
  suburb: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  memberCount: number | null;
  leadMessage: string | null;
  preferredTimes: string | null;
  meetingOn: string | null;
  /** HH:MM (Sydney) and length in minutes: both optional, and only with a date. */
  meetingTime: string | null;
  meetingMinutes: number | null;
  /** The service area (SCRUM-102): the venue's postcode (`suburb` is the venue suburb), the default method it gave, any admin override, the list version used. */
  venuePostcode: string | null;
  fulfilmentDefault: Fulfilment | null;
  fulfilmentOverride: Fulfilment | null;
  fulfilmentOverrideAt: Date | null;
  areaVersion: string | null;
  /** The suburb matched with a different postcode: worth a look. */
  areaReview: boolean;
  lastActivityAt: Date;
}

export interface ClubInput {
  name: string;
  billingName: string;
  billingEmail: string;
  billingAddress: string;
  abn: string | null;
  notes: string | null;
}

export const BATCH_METHODS = ['pickup', 'post'] as const;
export type BatchMethod = (typeof BATCH_METHODS)[number];
export const isBatchMethod = (v: string): v is BatchMethod => (BATCH_METHODS as readonly string[]).includes(v);
export const MAX_TRACKING = 60;
/** A posted batch of at least this many paddles gets the standard cost of the club's postage to us taken off its invoice (agreement 5.3). */
export const POSTAGE_ALLOWANCE_MIN = 6;

export interface Batch {
  id: string;
  reference: string;
  clubId: string;
  clubName: string;
  status: BatchStatus;
  statusChangedAt: Date;
  /** The day the batch came into our hands: picked up, or received by post. */
  collectedOn: string;
  method: BatchMethod;
  inboundTracking: string | null;
  returnTracking: string | null;
  paddleCount: number;
  returnedOn: string | null;
  unchangedCount: number;
  notes: string | null;
  /** The invoice issued when the batch was re-gritted, if any, and what is still owing on it. */
  invoice: { id: string; number: string; totalCents: number; dueOn: string | null; balanceCents: number } | null;
}

/** An invoiced batch past its due date with something still owing (SCRUM-85 AC6: flagged, never chased). */
export const isOverdue = (b: Batch, today: string) =>
  b.status === 'invoiced' && !!b.invoice?.dueOn && b.invoice.dueOn < today && b.invoice.balanceCents > 0;

// ── Validation ────────────────────────────────────────────────────────────────

const clean = (v: string | null | undefined) => (v ?? '').trim();

/** Domains reserved for tests (RFC 2606 and 6761): nobody real is ever at these. */
const RESERVED_DOMAIN = /(^|\.)(example\.(com|org|net)|test|invalid|example|localhost)$/;

/**
 * Outside production a club's billing email must be one of Attila's own (EMAIL_ALLOWLIST) or at a
 * reserved test domain, so a real club's address never gets into staging: it would reach the
 * outbox, the HubSpot test portal and Stripe's Checkout. Production takes any valid address.
 */
export interface EmailGuard {
  isProduction: boolean;
  allowList: readonly string[];
}

export function allowedHere(email: string, guard: EmailGuard): boolean {
  // The same test the outbox applies before sending (plus-addressing of an allowed address counts).
  if (isAllowed(email, guard)) return true;
  return RESERVED_DOMAIN.test(email.slice(email.lastIndexOf('@') + 1));
}

/** Checks and tidies a club form. Throws ClubError with a message for Attila. */
/** `guard` is required on purpose: a caller that wants no email rule has to say so (`isProduction: true`). */
export function validateClub(input: Partial<Record<keyof ClubInput, string | null>>, guard: EmailGuard): ClubInput {
  const name = clean(input.name);
  const billingName = clean(input.billingName);
  const billingEmail = clean(input.billingEmail).toLowerCase();
  const billingAddress = clean(input.billingAddress).replace(/\r\n/g, '\n');
  const abn = clean(input.abn).replace(/\s/g, '');
  const notes = clean(input.notes);
  if (!name || name.length > 120) throw new ClubError('bad_name', 'Give the club’s name (up to 120 characters).');
  if (!billingName || billingName.length > 120) throw new ClubError('bad_billing_name', 'Give the billing contact’s name (up to 120 characters).');
  if (!EMAIL_RE.test(billingEmail) || billingEmail.length > 254) throw new ClubError('bad_billing_email', 'Give a valid billing email address.');
  if (!allowedHere(billingEmail, guard)) {
    throw new ClubError(
      'email_not_allowed',
      'This isn’t production, so a club’s billing email must be one of your own allow-listed addresses (EMAIL_ALLOWLIST) or an example.com or .test address. A real club’s address is never saved here.',
    );
  }
  if (!billingAddress || billingAddress.length > 400) throw new ClubError('bad_billing_address', 'Give the billing address (up to 400 characters).');
  if (abn && !isValidAbn(abn)) throw new ClubError('bad_abn', 'That ABN isn’t valid: 11 digits, as on the ABN Lookup.');
  if (notes.length > MAX_CLUB_NOTE) throw new ClubError('bad_notes', `Notes can be up to ${MAX_CLUB_NOTE} characters.`);
  return { name, billingName, billingEmail, billingAddress, abn: abn || null, notes: notes || null };
}

// ── Clubs ─────────────────────────────────────────────────────────────────────

interface ClubRow {
  id: string;
  name: string;
  billing_name: string | null;
  billing_email: string | null;
  billing_address: string | null;
  abn: string | null;
  notes: string | null;
  status: ClubStatus;
  is_test: boolean;
  created_at: Date;
  suburb: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  club_size: number | null;
  lead_message: string | null;
  preferred_times: string | null;
  meeting_on: string | null;
  meeting_time: string | null;
  meeting_minutes: number | null;
  venue_postcode: string | null;
  fulfilment_default: Fulfilment | null;
  fulfilment_override: Fulfilment | null;
  fulfilment_override_at: Date | null;
  area_version: string | null;
  area_review: boolean;
  last_activity_at: Date;
}

/** Every column the Club type reads, with the meeting date as text (no driver makes a moment of it). */
export const CLUB_COLUMNS = `id, name, billing_name, billing_email, billing_address, abn, notes, status, is_test, created_at,
  suburb, contact_name, contact_email, contact_phone, club_size, lead_message, preferred_times, meeting_on::text AS meeting_on, meeting_time, meeting_minutes,
  venue_postcode, fulfilment_default, fulfilment_override, fulfilment_override_at, area_version, area_review, last_activity_at`;
const CLUB_COLUMNS_C = CLUB_COLUMNS.split(',').map((c) => (c.trim().startsWith('meeting_on::') ? 'c.meeting_on::text AS meeting_on' : `c.${c.trim()}`)).join(', ');

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
  suburb: r.suburb,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  memberCount: r.club_size === null ? null : Number(r.club_size),
  leadMessage: r.lead_message,
  preferredTimes: r.preferred_times,
  meetingOn: r.meeting_on,
  meetingTime: r.meeting_time,
  meetingMinutes: r.meeting_minutes === null ? null : Number(r.meeting_minutes),
  venuePostcode: r.venue_postcode,
  fulfilmentDefault: r.fulfilment_default,
  fulfilmentOverride: r.fulfilment_override,
  fulfilmentOverrideAt: r.fulfilment_override_at ? new Date(r.fulfilment_override_at) : null,
  areaVersion: r.area_version,
  areaReview: r.area_review,
  lastActivityAt: new Date(r.last_activity_at),
});

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

export async function createClub(db: Db, input: ClubInput, opts: { isProduction: boolean; now: Date }): Promise<Club> {
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query<ClubRow>(
        `INSERT INTO clubs (name, billing_name, billing_email, billing_address, abn, notes, status, is_test, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8) RETURNING ${CLUB_COLUMNS}`,
        [input.name, input.billingName, input.billingEmail, input.billingAddress, input.abn, input.notes, !opts.isProduction, opts.now],
      );
      await enqueueClubCrmSync(q, rows[0]!.id, opts.now);
      return toClub(rows[0]!);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClubError('duplicate_name', 'There’s already a club with that name.');
    throw err;
  }
}

export async function updateClub(db: Db, id: string, input: ClubInput, now: Date): Promise<Club | null> {
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query<ClubRow>(
        `UPDATE clubs SET name = $2, billing_name = $3, billing_email = $4, billing_address = $5, abn = $6, notes = $7, updated_at = $8, last_activity_at = $8
          WHERE id = $1 RETURNING ${CLUB_COLUMNS}`,
        [id, input.name, input.billingName, input.billingEmail, input.billingAddress, input.abn, input.notes, now],
      );
      if (rows[0]) await enqueueClubCrmSync(q, id, now);
      return rows[0] ? toClub(rows[0]) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClubError('duplicate_name', 'There’s already a club with that name.');
    throw err;
  }
}

/**
 * A club that may be Active: it has accepted an agreement (SCRUM-94), or it is a customer from
 * before agreements (it was made in admin, so it has no enquiry contact, or it already had batches).
 * A club that came in through the form becomes Active by recording its "I agree".
 */
export const CUSTOMER_SQL = `(clubs.contact_email IS NULL OR EXISTS (SELECT 1 FROM club_agreements a WHERE a.club_id = clubs.id AND a.accepted_on IS NOT NULL)
  OR EXISTS (SELECT 1 FROM batches b WHERE b.club_id = clubs.id))`;

/** Active or inactive (SCRUM-85 AC1). An inactive club keeps its batches; new ones can't be added. */
export async function setClubActive(db: Queryable, id: string, active: boolean, now: Date): Promise<boolean> {
  // Reactivating needs the billing details (a lead that never had any can't become Active this way).
  const { rows } = await db.query(
    `UPDATE clubs SET status = $2, updated_at = $3, last_activity_at = $3
      WHERE id = $1 AND status IN ('active', 'inactive')
        AND ($2 = 'inactive' OR (billing_name IS NOT NULL AND billing_email IS NOT NULL AND billing_address IS NOT NULL AND ${CUSTOMER_SQL})) RETURNING id`,
    [id, active ? 'active' : 'inactive', now],
  );
  return rows.length === 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findClub(db: Queryable, id: string): Promise<Club | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<ClubRow>(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE id = $1`, [id]);
  return rows[0] ? toClub(rows[0]) : null;
}

export async function listClubs(db: Queryable): Promise<(Club & { openBatches: number })[]> {
  const { rows } = await db.query<ClubRow & { open_batches: number }>(
    `SELECT ${CLUB_COLUMNS_C}, (SELECT count(*)::int FROM batches b WHERE b.club_id = c.id AND (b.status IN ('collected', 'invoiced') OR (b.status = 'paid' AND b.returned_on IS NULL))) AS open_batches
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
         b.method, b.inbound_tracking, b.return_tracking, b.paddle_count, b.returned_on::text AS returned_on, b.unchanged_count, b.notes,
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
  method: BatchMethod;
  inbound_tracking: string | null;
  return_tracking: string | null;
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
  method: r.method,
  inboundTracking: r.inbound_tracking,
  returnTracking: r.return_tracking,
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
        AND (NOT $2::boolean OR (b.status IN ('collected', 'invoiced') OR (b.status = 'paid' AND b.returned_on IS NULL)))
      ORDER BY b.collected_on DESC, b.created_at DESC LIMIT 500`,
    [filter.clubId ?? null, filter.open ?? false],
  );
  return rows.map(toBatch);
}

const isDate = (v: string) => ISO_DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function checkCount(n: number, what: string, max = MAX_BATCH_PADDLES): void {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ClubError('bad_count', `${what} must be a whole number from 0 to ${max}.`);
}

/** A tracking number: letters, digits, spaces and dashes, up to 60. Empty means none. */
export function cleanTracking(v: string | null | undefined): string {
  const t = clean(v);
  if (t.length > MAX_TRACKING || (t && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(t))) throw new ClubError('bad_tracking', `A tracking number is letters, digits and dashes, up to ${MAX_TRACKING} characters.`);
  return t;
}

/** Records a batch collected from, or received by post from, an active club (SCRUM-85 AC2). */
export async function createBatch(
  db: Db,
  args: { clubId: string; collectedOn: string; paddleCount: number; notes: string | null; now: Date; method?: string; inboundTracking?: string | null },
): Promise<Batch> {
  if (!isDate(args.collectedOn)) throw new ClubError('bad_date', 'Give the collection date.');
  if (args.collectedOn > sydneyDate(args.now)) throw new ClubError('future_date', 'The collection date can’t be in the future.');
  checkCount(args.paddleCount, 'The paddle count');
  if (args.paddleCount < 1) throw new ClubError('bad_count', 'A batch has at least one paddle.');
  const notes = clean(args.notes);
  if (notes.length > MAX_CLUB_NOTE) throw new ClubError('bad_notes', `Notes can be up to ${MAX_CLUB_NOTE} characters.`);
  const method = args.method ?? 'pickup';
  if (!isBatchMethod(method)) throw new ClubError('bad_method', 'Choose picked up or received by post.');
  const inbound = cleanTracking(args.inboundTracking);
  if (inbound && method !== 'post') throw new ClubError('bad_tracking', 'A tracking number only goes with a batch received by post.');
  const club = await findClub(db, args.clubId);
  if (!club) throw new ClubError('no_club', 'No such club.');
  if (club.status !== 'active') throw new ClubError('club_inactive', 'This club isn’t active: reactivate it before recording a batch.');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reference = newBatchReference();
      await db.tx(async (q) => {
        await q.query(
          `INSERT INTO batches (reference, club_id, status, status_changed_at, collected_on, paddle_count, notes, method, inbound_tracking, created_at, updated_at)
           VALUES ($1, $2, 'collected', $3, $4::date, $5, $6, $7, $8, $3, $3)`,
          [reference, club.id, args.now, args.collectedOn, args.paddleCount, notes || null, method, inbound || null],
        );
        await enqueueClubCrmSync(q, club.id, args.now);
      });
      return (await findBatch(db, reference))!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new ClubError('reference_clash', 'Couldn’t make a unique batch reference; try again.');
}

/** Cancels a batch that hasn't been returned (SCRUM-85 AC2). */
export async function cancelBatch(db: Db, reference: string, now: Date): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ club_id: string }>(
      `UPDATE batches SET status = 'cancelled', status_changed_at = $2, updated_at = $2 WHERE reference = $1 AND status = 'collected' RETURNING club_id`,
      [reference, now],
    );
    if (rows.length !== 1) throw new ClubError('not_cancellable', 'Only a batch that hasn’t been returned can be cancelled.');
    await enqueueClubCrmSync(q, rows[0]!.club_id, now);
  });
}

export interface ReturnDeps {
  db: Db;
  seller: Seller;
  isProduction: boolean;
  now: Date;
  /** Whether card payments are set up here (Stripe): the invoice then offers "Pay by card". */
  payByCard?: boolean;
}

/**
 * The standard cost of the club posting a batch to us (SCRUM-102, agreement 5.3): Australia Post's
 * price for that many paddles at the club's venue postcode, on the day (the same table that prices
 * return postage on individual orders; the route is taken as the same either way). A reason instead when it can't be
 * worked out (no postcode on file, or a size the packing table doesn't cover): then it is entered.
 */
export function standardPostage(paddles: number, postcode: string | null, date: string): { cents: number } | { reason: string } {
  if (!postcode) return { reason: 'This club has no venue postcode on file: enter the standard postage.' };
  const q = quotePostage(paddles, postcode, date);
  return q.ok ? { cents: q.postageCents } : { reason: q.reason };
}

export const MAX_POSTAGE_ALLOWANCE_CENTS = 20_000;

/**
 * A batch is re-gritted: in one transaction its invoice is issued (re-gritted paddles only, with
 * the standard cost of the club's postage to us taken off a posted batch of 6 or more) and queued by email, and the
 * batch moves to Invoiced. The club pays before the batch goes back (agreement 7.3). All of it, or
 * none of it. A batch where every paddle came back unchanged has nothing to invoice: it goes back
 * with `returnBatch` instead.
 */
export async function invoiceBatch(
  deps: ReturnDeps,
  args: { reference: string; unchangedCount: number; postageAllowanceCents?: number | null },
): Promise<{ invoiceId: string; postageAllowanceCents: number }> {
  const { now } = deps;
  checkCount(args.unchangedCount, 'Paddles returned unchanged');
  try {
    return await deps.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; club_id: string; paddle_count: number; status: BatchStatus; method: BatchMethod; venue_postcode: string | null }>(
        `SELECT b.id, b.club_id, b.paddle_count, b.status, b.method, c.venue_postcode
           FROM batches b JOIN clubs c ON c.id = b.club_id WHERE b.reference = $1 FOR UPDATE OF b`,
        [args.reference],
      );
      const b = rows[0];
      if (!b) throw new ClubError('no_batch', 'No such batch.');
      if (b.status !== 'collected') throw new ClubError('not_collected', 'Only a collected batch can be invoiced.');
      if (args.unchangedCount >= Number(b.paddle_count)) throw new ClubError('nothing_to_invoice', 'Every paddle is unchanged, so there is nothing to invoice: return the batch without an invoice instead.');
      let allowance = 0;
      if (b.method === 'post' && Number(b.paddle_count) >= POSTAGE_ALLOWANCE_MIN) {
        if (args.postageAllowanceCents != null) {
          allowance = args.postageAllowanceCents;
        } else {
          const std = standardPostage(Number(b.paddle_count), b.venue_postcode, sydneyDate(now));
          if ('reason' in std) throw new ClubError('postage_needed', std.reason);
          allowance = std.cents;
        }
        if (!Number.isInteger(allowance) || allowance < 1 || allowance > MAX_POSTAGE_ALLOWANCE_CENTS) {
          throw new ClubError('bad_postage', `The postage allowance is between A$0.01 and A$${MAX_POSTAGE_ALLOWANCE_CENTS / 100}.`);
        }
      }
      await q.query(`UPDATE batches SET unchanged_count = $2, updated_at = $3 WHERE id = $1`, [b.id, args.unchangedCount, now]);
      const invoiceId = await issueClubInvoice(q, {
        batchId: b.id, seller: deps.seller, isProduction: deps.isProduction, now, payByCard: deps.payByCard ?? false, postageAllowanceCents: allowance,
      });
      await q.query(`UPDATE batches SET status = 'invoiced', status_changed_at = $2, updated_at = $2 WHERE id = $1`, [b.id, now]);
      await enqueueClubCrmSync(q, b.club_id, now);
      return { invoiceId, postageAllowanceCents: allowance };
    });
  } catch (err) {
    if (err instanceof DocumentError) throw new ClubError(err.code, err.message);
    throw err;
  }
}

/**
 * The batch goes back to the club (dropped off, or posted with a tracking number): its return date is
 * recorded and it is Returned. Only once the invoice is paid (agreement 7.3), or when every paddle came
 * back unchanged and there was nothing to invoice (`unchangedCount` = all of them).
 */
export async function returnBatch(
  deps: { db: Db; now: Date },
  args: { reference: string; returnedOn: string; returnTracking?: string | null; unchangedCount?: number },
): Promise<void> {
  const { now } = deps;
  if (!isDate(args.returnedOn)) throw new ClubError('bad_date', 'Give the return date.');
  if (args.returnedOn > sydneyDate(now)) throw new ClubError('future_date', 'The return date can’t be in the future.');
  const returnTracking = cleanTracking(args.returnTracking);
  await deps.db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; club_id: string; collected_on: string; paddle_count: number; status: BatchStatus; method: BatchMethod }>(
      `SELECT id, club_id, collected_on::text AS collected_on, paddle_count, status, method FROM batches WHERE reference = $1 FOR UPDATE`,
      [args.reference],
    );
    const b = rows[0];
    if (!b) throw new ClubError('no_batch', 'No such batch.');
    if (b.status === 'collected') {
      // Nothing to invoice: only when every paddle came back unchanged.
      if (args.unchangedCount === undefined) throw new ClubError('not_paid', 'The club pays before the batch goes back: invoice it first.');
      checkCount(args.unchangedCount, 'Paddles returned unchanged');
      if (args.unchangedCount !== Number(b.paddle_count)) throw new ClubError('not_paid', 'Only a batch with every paddle unchanged goes back without an invoice: invoice this one first.');
      await q.query(`UPDATE batches SET unchanged_count = $2 WHERE id = $1`, [b.id, args.unchangedCount]);
    } else if (b.status === 'invoiced') {
      throw new ClubError('not_paid', 'The invoice isn’t paid yet: the club pays before the batch goes back.');
    } else if (b.status !== 'paid') {
      throw new ClubError('not_returnable', 'This batch can’t be returned.');
    }
    if (args.returnedOn < b.collected_on) throw new ClubError('before_collection', 'The return date can’t be before the collection date.');
    if (returnTracking && b.method !== 'post') throw new ClubError('bad_tracking', 'A tracking number only goes with a batch sent back by post.');
    await q.query(
      `UPDATE batches SET status = 'returned', returned_on = $2::date, return_tracking = $4, status_changed_at = $3, updated_at = $3 WHERE id = $1`,
      [b.id, args.returnedOn, now, returnTracking || null],
    );
    await enqueueClubCrmSync(q, b.club_id, now);
  });
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
/** The club's latest HubSpot sync (SCRUM-85 AC8), for its admin page; null before the first or with no CRM. */
export async function clubCrmSync(db: Queryable, clubId: string): Promise<BatchEmail | null> {
  const { rows } = await db.query<{ id: string; template: string; state: BatchEmail['state']; attempts: number; last_error: string | null; created_at: Date }>(
    `SELECT id, template, state, attempts, last_error, created_at FROM outbox WHERE club_id = $1 AND kind = 'crm' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [clubId],
  );
  const r = rows[0];
  return r ? { id: String(r.id), template: r.template, state: r.state, attempts: Number(r.attempts), lastError: r.last_error, createdAt: new Date(r.created_at) } : null;
}

export async function batchEmails(db: Queryable, batchId: string): Promise<BatchEmail[]> {
  const { rows } = await db.query<{ id: string; template: string; state: BatchEmail['state']; attempts: number; last_error: string | null; created_at: Date }>(
    `SELECT id, template, state, attempts, last_error, created_at FROM outbox WHERE batch_id = $1 AND kind = 'email' ORDER BY created_at DESC, id DESC`,
    [batchId],
  );
  return rows.map((r) => ({ id: String(r.id), template: r.template, state: r.state, attempts: Number(r.attempts), lastError: r.last_error, createdAt: new Date(r.created_at) }));
}

/** How this club's batches travel: the admin's override, else the service area's default; null when neither is known (a club made before the service area). */
export const effectiveFulfilment = (c: Pick<Club, 'fulfilmentDefault' | 'fulfilmentOverride'>): Fulfilment | null => c.fulfilmentOverride ?? c.fulfilmentDefault;
