/**
 * Receipts, invoices and credit notes (SCRUM-84, decided 30 Oct and 3 Nov 2026).
 *
 *  - One gapless sequence, PMP-INV-0001 upward, for receipts (direct orders) and invoices (club
 *    batches, SCRUM-85); credit notes have their own, PMP-CN-0001 upward. A number is taken in
 *    the transaction that issues the document, so it is never skipped or reused.
 *  - A document is a frozen snapshot: every word and amount it shows is decided when it is
 *    issued and stored as canonical JSON text with its SHA-256. A database trigger refuses any
 *    edit; only the paid state may be added later, once. A mistake is fixed with a credit note.
 *  - Wording follows the issue date (SCRUM-81): before GST_REGISTERED_FROM, "Invoice" and "No
 *    GST has been charged", never "tax invoice"; from it, "Tax invoice", the ABN and the GST
 *    included. A credit note follows the document it refers to: an "Adjustment note" for a tax
 *    invoice (Attila's accountant confirms the format), a "Credit note" otherwise.
 *  - Personal data: the buyer's name only (a club's name and billing details for SCRUM-85).
 *    Never an address, email or phone, and no paddle brands, so erasure leaves documents as
 *    they are (the name, the discount code and the amounts are the tax record).
 *  - A direct order's receipt is issued when it is Paid (by Stripe, or a reinstated late
 *    payment) with the "Payment received" email; each refund issues a credit note with the
 *    "Refund issued" email.
 */
import { createHash } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import { enqueueOrderEmail } from '../email/outbox.js';
import { sydneyDate } from '../orders/dates.js';
import { gstIncluded, taxWording, termsOn, type TaxTreatment } from '../pricing/terms.js';

export type DocumentKind = 'receipt' | 'invoice' | 'credit_note';
export type DocumentHeading = 'Invoice' | 'Tax invoice' | 'Credit note' | 'Adjustment note';

/** Who issues documents, as configured (BUSINESS_NAME, BUSINESS_ABN, GST_REGISTERED_FROM). */
export interface Seller {
  name: string;
  /** Null until the ABN exists: documents then show ABN_PLACEHOLDER (production refuses that). */
  abn: string | null;
  email: string;
  website: string;
  gstRegisteredFrom: string | null;
}

export const ABN_PLACEHOLDER = '[To confirm: ABN]';

export const DEFAULT_SELLER: Seller = {
  name: 'PickleMyPaddle',
  abn: null,
  email: 'info@picklemypaddle.com',
  website: 'www.picklemypaddle.com',
  gstRegisteredFrom: null,
};

/** A$1,000 or more, GST-inclusive: a tax invoice must also identify the buyer (ATO). */
export const BUYER_ID_THRESHOLD_CENTS = 100_000;

export interface DocumentLine {
  description: string;
  quantity: number;
  /** Each, GST-inclusive once registered. Negative for a discount. */
  unitCents: number;
  amountCents: number;
}

/** Everything a document shows, fixed at issue. `v` is the snapshot format. */
export interface DocumentSnapshot {
  v: 1;
  number: string;
  kind: DocumentKind;
  heading: DocumentHeading;
  /** Sydney calendar day, YYYY-MM-DD. */
  issuedOn: string;
  treatment: TaxTreatment;
  /** Taken outside production: the page says it isn't a real document. */
  test: boolean;
  seller: { name: string; abn: string; email: string; website: string };
  buyer: { name: string; abn?: string; address?: string };
  /** The order (or batch) it is for. */
  reference: string;
  /** Credit notes: the document they adjust. */
  refersTo?: { number: string; issuedOn: string };
  lines: DocumentLine[];
  totalCents: number;
  gstCents: number;
  /** "No GST has been charged" or "Total includes GST of A$x" (credit notes: "Credit includes …"). */
  gstLine: string;
  /** Plain sentences printed under the totals. */
  notes: string[];
}

/** A document as shown: the snapshot plus its paid (or refunded) state. */
export interface DocumentView {
  snapshot: DocumentSnapshot;
  sha256: string;
  paid: { on: string; method: string } | null;
}

export class DocumentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

// ── Wording ───────────────────────────────────────────────────────────────────

const money = (cents: number) => `${cents < 0 ? '−' : ''}A$${(Math.abs(cents) / 100).toFixed(2)}`;

/** "123 456 789 01" → "12 345 678 901": the ABN as the ATO prints it. */
export const formatAbn = (abn: string) => abn.replace(/\s/g, '').replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');

/** What a heading reads once the document is paid (AC3: "Invoice: paid"). */
export function displayHeading(heading: DocumentHeading, paid: boolean): string {
  return paid && (heading === 'Invoice' || heading === 'Tax invoice') ? `${heading}: paid` : heading;
}

/** What the status page and admin call each kind. */
export const KIND_TITLE: Record<DocumentKind, string> = { receipt: 'Receipt', invoice: 'Invoice', credit_note: 'Credit note' };

/** Canonical JSON: keys in a fixed (sorted) order, so the same snapshot is always the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const sellerBlock = (s: Seller) => ({ name: s.name, abn: s.abn ? formatAbn(s.abn) : ABN_PLACEHOLDER, email: s.email, website: s.website });

/** The facts a direct order's receipt is made from. */
export interface ReceiptFacts {
  reference: string;
  buyerName: string;
  test: boolean;
  paddles: number;
  subtotalCents: number;
  discountCents: number;
  /** SCRUM-63: the code that gave the discount, shown on its line. */
  discountCode: string | null;
  postageCents: number;
  /** What was paid: the order's total saved at Accept. */
  totalCents: number;
}

/** A direct order's receipt, worded for its issue date. Pure: the tests drive it directly. */
export function receiptSnapshot(number: string, issuedOn: string, f: ReceiptFacts, seller: Seller): DocumentSnapshot {
  const treatment = termsOn(issuedOn, { gstRegisteredFrom: seller.gstRegisteredFrom }).treatment;
  const lines: DocumentLine[] = [];
  const each = f.paddles > 0 ? Math.round(f.subtotalCents / f.paddles) : f.subtotalCents;
  lines.push({ description: 'Paddle re-grit, both faces', quantity: f.paddles, unitCents: each, amountCents: f.subtotalCents });
  if (f.discountCents > 0) lines.push({ description: f.discountCode ? `Discount (code ${f.discountCode})` : 'Discount', quantity: 1, unitCents: -f.discountCents, amountCents: -f.discountCents });
  if (f.postageCents > 0) lines.push({ description: 'Return postage', quantity: 1, unitCents: f.postageCents, amountCents: f.postageCents });
  const sum = lines.reduce((a, l) => a + l.amountCents, 0);
  if (sum !== f.totalCents) throw new DocumentError('lines_dont_add_up', `The lines add up to ${money(sum)}, not the ${money(f.totalCents)} paid.`);
  return finish({
    number,
    kind: 'receipt',
    issuedOn,
    treatment,
    test: f.test,
    seller,
    buyer: { name: f.buyerName },
    reference: f.reference,
    lines,
    totalCents: f.totalCents,
    notes: [],
  });
}

/** A credit note for `cents` refunded against `original`. Follows the original's GST treatment. */
export function creditNoteSnapshot(number: string, issuedOn: string, original: DocumentSnapshot, cents: number, seller: Seller): DocumentSnapshot {
  if (!Number.isInteger(cents) || cents <= 0) throw new DocumentError('bad_amount', 'A credit note is for a positive amount.');
  return finish({
    number,
    kind: 'credit_note',
    issuedOn,
    treatment: original.treatment,
    test: original.test,
    seller,
    buyer: original.buyer,
    reference: original.reference,
    refersTo: { number: original.number, issuedOn: original.issuedOn },
    lines: [{ description: `Refund against ${original.number}`, quantity: 1, unitCents: cents, amountCents: cents }],
    totalCents: cents,
    notes: ['Refunded to the card used for payment.'],
  });
}

type Draft = Omit<DocumentSnapshot, 'v' | 'heading' | 'seller' | 'gstCents' | 'gstLine'> & { seller: Seller };

function finish(d: Draft): DocumentSnapshot {
  const gst = gstIncluded(d.totalCents, d.treatment);
  const credit = d.kind === 'credit_note';
  const heading: DocumentHeading = credit
    ? d.treatment === 'gst_inclusive' ? 'Adjustment note' : 'Credit note'
    : taxWording(d.treatment, d.totalCents).heading;
  const gstLine = d.treatment === 'gst_inclusive'
    ? `${credit ? 'Credit' : 'Total'} includes GST of ${money(gst)}`
    : taxWording(d.treatment, d.totalCents).gstLine;
  const notes = [...d.notes];
  if (d.treatment === 'gst_inclusive') notes.unshift(credit ? 'This adjusts a taxable sale.' : 'All items are taxable sales.');
  // ATO: a tax invoice of A$1,000 or more must identify the buyer (name or ABN).
  if (d.treatment === 'gst_inclusive' && d.totalCents >= BUYER_ID_THRESHOLD_CENTS && !d.buyer.name.trim() && !d.buyer.abn) {
    throw new DocumentError('buyer_required', 'A tax invoice of A$1,000 or more needs the buyer’s name or ABN.');
  }
  return {
    v: 1,
    number: d.number,
    kind: d.kind,
    heading,
    issuedOn: d.issuedOn,
    treatment: d.treatment,
    test: d.test,
    seller: sellerBlock(d.seller),
    buyer: d.buyer,
    reference: d.reference,
    ...(d.refersTo ? { refersTo: d.refersTo } : {}),
    lines: d.lines,
    totalCents: d.totalCents,
    gstCents: gst,
    gstLine,
    notes,
  };
}

// ── Issuing ───────────────────────────────────────────────────────────────────

/** The next number in a series, inside the caller's transaction (the row stays locked until it ends). */
export async function nextNumber(q: Queryable, series: 'INV' | 'CN'): Promise<string> {
  const { rows } = await q.query<{ last: number }>('UPDATE document_counters SET last = last + 1 WHERE series = $1 RETURNING last', [series]);
  if (!rows[0]) throw new DocumentError('no_counter', `No ${series} counter.`);
  return `PMP-${series}-${String(rows[0].last).padStart(4, '0')}`;
}

async function insert(
  q: Queryable,
  snap: DocumentSnapshot,
  row: { orderId: string | null; paymentId: string | null; refersTo: string | null; now: Date; paid: { on: string; method: string } | null },
): Promise<string> {
  const text = canonicalJson(snap);
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO documents (number, kind, order_id, payment_id, refers_to, issued_on, issued_at, total_cents, gst_cents, snapshot, snapshot_sha256, paid_on, paid_method)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12::date, $13) RETURNING id`,
    [snap.number, snap.kind, row.orderId, row.paymentId, row.refersTo, snap.issuedOn, row.now, snap.totalCents, snap.gstCents, text, sha256(text),
      row.paid?.on ?? null, row.paid?.method ?? null],
  );
  return String(rows[0]!.id);
}

/**
 * Issues the receipt for an order's payment, once (inside the caller's transaction, with the
 * Paid that caused it), and queues the "Payment received" email. Returns the receipt's id;
 * a payment that already has one gets that one back and nothing new is queued.
 */
export async function issueReceipt(q: Queryable, args: { orderId: string; paymentId: string; seller: Seller; now: Date }): Promise<string> {
  const { rows: existing } = await q.query<{ id: string }>(`SELECT id FROM documents WHERE payment_id = $1 AND kind = 'receipt'`, [args.paymentId]);
  if (existing[0]) return String(existing[0].id);
  const { rows } = await q.query<{
    reference: string; name: string; is_test: boolean; is_smoke: boolean; paddles: number; subtotal_cents: number | null; discount_cents: number;
    postage_cents: number | null; amount_cents: number | null; paid_amount: number; paid_at: Date; discount_code: string | null;
  }>(
    `SELECT o.reference, o.name, o.is_test, o.is_smoke, (SELECT count(*)::int FROM paddles p WHERE p.order_id = o.id) AS paddles,
            o.subtotal_cents, o.discount_cents, o.discount_code, o.postage_cents, o.amount_cents, pm.amount_cents AS paid_amount, pm.paid_at
       FROM orders o JOIN payments pm ON pm.order_id = o.id
      WHERE o.id = $1 AND pm.id = $2`,
    [args.orderId, args.paymentId],
  );
  const o = rows[0];
  if (!o) throw new DocumentError('not_found', 'No such order payment.');
  const total = Number(o.paid_amount);
  // Orders accepted before SCRUM-81 have no breakdown: the whole amount is the re-grit.
  const subtotal = o.subtotal_cents === null ? total : Number(o.subtotal_cents);
  const postage = o.postage_cents === null ? 0 : Number(o.postage_cents);
  const issuedOn = sydneyDate(args.now);
  const number = await nextNumber(q, 'INV');
  const snap = receiptSnapshot(number, issuedOn, {
    reference: o.reference,
    buyerName: o.name,
    test: o.is_test,
    paddles: Number(o.paddles),
    subtotalCents: subtotal,
    discountCents: Number(o.discount_cents),
    discountCode: Number(o.discount_cents) > 0 ? o.discount_code : null,
    postageCents: postage,
    totalCents: total,
  }, args.seller);
  const id = await insert(q, snap, { orderId: args.orderId, paymentId: args.paymentId, refersTo: null, now: args.now, paid: { on: sydneyDate(new Date(o.paid_at)), method: 'card' } });
  if (!o.is_smoke) await enqueueOrderEmail(q, args.orderId, 'payment_received', args.now, { documentId: id, amountCents: total });
  return id;
}

/**
 * Issues a credit note for `cents` refunded against a payment's receipt, and queues the "Refund
 * issued" email. Returns null when the payment has no receipt (a flagged payment that was never
 * applied: nothing was issued, so there is nothing to credit).
 */
export async function issueCreditNote(
  q: Queryable,
  args: { paymentId: string; cents: number; full: boolean; seller: Seller; now: Date },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string; order_id: string | null; snapshot: string; is_smoke: boolean | null }>(
    `SELECT d.id, d.order_id, d.snapshot, o.is_smoke FROM documents d LEFT JOIN orders o ON o.id = d.order_id
      WHERE d.payment_id = $1 AND d.kind = 'receipt'`,
    [args.paymentId],
  );
  const receipt = rows[0];
  if (!receipt) return null;
  const issuedOn = sydneyDate(args.now);
  const number = await nextNumber(q, 'CN');
  const snap = creditNoteSnapshot(number, issuedOn, JSON.parse(receipt.snapshot) as DocumentSnapshot, args.cents, args.seller);
  const id = await insert(q, snap, {
    orderId: receipt.order_id, paymentId: args.paymentId, refersTo: String(receipt.id), now: args.now, paid: { on: issuedOn, method: 'card refund' },
  });
  if (receipt.order_id && !receipt.is_smoke) {
    await enqueueOrderEmail(q, receipt.order_id, 'refund_issued', args.now, { documentId: id, refundCents: args.cents, refundFull: args.full });
  }
  return id;
}

// ── Reading ───────────────────────────────────────────────────────────────────

interface DocumentRow {
  id: string;
  snapshot: string;
  snapshot_sha256: string;
  paid_on: string | null;
  paid_method: string | null;
}

const view = (r: DocumentRow): DocumentView => ({
  snapshot: JSON.parse(r.snapshot) as DocumentSnapshot,
  sha256: r.snapshot_sha256,
  paid: r.paid_on && r.paid_method ? { on: r.paid_on, method: r.paid_method } : null,
});

const SELECT = `SELECT id, snapshot, snapshot_sha256, paid_on::text AS paid_on, paid_method FROM documents`;

export async function documentByNumber(q: Queryable, number: string): Promise<DocumentView | null> {
  const { rows } = await q.query<DocumentRow>(`${SELECT} WHERE number = $1`, [number]);
  return rows[0] ? view(rows[0]) : null;
}

/** A document of this order (the status page's links), or null. */
export async function orderDocument(q: Queryable, orderId: string, number: string): Promise<DocumentView | null> {
  const { rows } = await q.query<DocumentRow>(`${SELECT} WHERE order_id = $1 AND number = $2`, [orderId, number]);
  return rows[0] ? view(rows[0]) : null;
}

export interface DocumentSummary {
  id: string;
  number: string;
  kind: DocumentKind;
  issuedOn: string;
  totalCents: number;
  gstCents: number;
  reference: string | null;
  refersTo: string | null;
}

export async function documentsOf(q: Queryable, orderId: string): Promise<DocumentSummary[]> {
  return listDocuments(q, { orderId });
}

export async function listDocuments(q: Queryable, filter: { orderId?: string; limit?: number } = {}): Promise<DocumentSummary[]> {
  const { rows } = await q.query<{ id: string; number: string; kind: DocumentKind; issued_on: string; total_cents: number; gst_cents: number; reference: string | null; refers_to: string | null }>(
    `SELECT d.id, d.number, d.kind, d.issued_on::text AS issued_on, d.total_cents, d.gst_cents, o.reference, r.number AS refers_to
       FROM documents d LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN documents r ON r.id = d.refers_to
      WHERE ($1::uuid IS NULL OR d.order_id = $1::uuid)
      ORDER BY d.issued_at DESC, d.id DESC LIMIT $2`,
    [filter.orderId ?? null, filter.limit ?? 500],
  );
  return rows.map((r) => ({
    id: String(r.id), number: r.number, kind: r.kind, issuedOn: r.issued_on, totalCents: Number(r.total_cents), gstCents: Number(r.gst_cents),
    reference: r.reference, refersTo: r.refers_to,
  }));
}

/** "3 November 2026" from YYYY-MM-DD. */
export function documentDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The paid line under the totals: "Paid in full by card on 3 November 2026." */
export function paidLine(v: DocumentView): string | null {
  if (!v.paid) return null;
  if (v.snapshot.kind === 'credit_note') return `Refunded to the card on ${documentDate(v.paid.on)}.`;
  return `Paid in full by ${v.paid.method} on ${documentDate(v.paid.on)}.`;
}

export { money as documentMoney };
