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
import { enqueueBatchEmail, enqueueOrderEmail } from '../email/outbox.js';
import { sydneyDate } from '../orders/dates.js';
import { clubInvoiceAmounts, clubTreatment, GST_PERCENT, gstIncluded, taxWording, termsOn, type TaxTreatment } from '../pricing/terms.js';

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
  /** SCRUM-85: where clubs pay invoices by PayID (BUSINESS_PAYID). Null shows PAYID_PLACEHOLDER. */
  payId?: string | null;
}

export const ABN_PLACEHOLDER = '[To confirm: ABN]';
export const PAYID_PLACEHOLDER = '[To confirm: PayID]';

export const DEFAULT_SELLER: Seller = {
  name: 'PickleMyPaddle',
  abn: null,
  email: 'info@picklemypaddle.com',
  website: 'www.picklemypaddle.com',
  gstRegisteredFrom: null,
  payId: null,
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
  /** GST-exclusive documents (club invoices once registered): the lines' sum before GST. */
  subtotalCents?: number;
  totalCents: number;
  gstCents: number;
  /** Club invoices (SCRUM-85): the Sydney day it is due, and the PayID it asks clubs to pay to. */
  dueOn?: string;
  payId?: string;
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

/** The facts a club batch's invoice is made from (SCRUM-85). */
export interface ClubInvoiceFacts {
  batchReference: string;
  clubName: string;
  clubAbn: string | null;
  billingName: string;
  billingAddress: string;
  test: boolean;
  /** Paddles re-gritted (collected less any returned unchanged). */
  paddles: number;
  /** The club price a paddle on the issue date (GST-exclusive once registered). */
  remitPerPaddleCents: number;
  collectedOn: string;
  returnedOn: string;
  dueOn: string;
}

/**
 * A club batch's invoice (SCRUM-85), worded for its issue date. Before GST registration: the
 * paddles at the club price, "Invoice", "No GST has been charged". From it (decided 4 Nov 2026):
 * "Tax invoice", the subtotal excluding GST, GST at 10% as its own line, then the total.
 */
export function clubInvoiceSnapshot(number: string, issuedOn: string, f: ClubInvoiceFacts, seller: Seller): DocumentSnapshot {
  const treatment = clubTreatment(issuedOn, { gstRegisteredFrom: seller.gstRegisteredFrom });
  const amounts = clubInvoiceAmounts(f.paddles, f.remitPerPaddleCents, treatment);
  const exclusive = treatment === 'gst_exclusive';
  const payId = seller.payId?.trim() || PAYID_PLACEHOLDER;
  return finish({
    number,
    kind: 'invoice',
    issuedOn,
    treatment,
    test: f.test,
    seller,
    buyer: { name: f.clubName, ...(f.clubAbn ? { abn: formatAbn(f.clubAbn) } : {}), address: `Attn: ${f.billingName}\n${f.billingAddress}` },
    reference: f.batchReference,
    lines: [{
      description: `Paddle re-grit, both faces: club batch collected ${documentDate(f.collectedOn)}, returned ${documentDate(f.returnedOn)}${exclusive ? ' (excluding GST)' : ''}`,
      quantity: f.paddles,
      unitCents: f.remitPerPaddleCents,
      amountCents: amounts.subtotalCents,
    }],
    ...(exclusive ? { subtotalCents: amounts.subtotalCents } : {}),
    totalCents: amounts.totalCents,
    dueOn: f.dueOn,
    payId,
    notes: [
      `Due by ${documentDate(f.dueOn)}.`,
      `How to pay: PayID or bank transfer to ${payId}, with ${number} as the reference; by card, with the "Pay by card" button on this invoice's page; or in cash at your club’s next pickup or delivery.`,
      'Part payments are fine: we show what is still owing.',
    ],
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
  const credit = d.kind === 'credit_note';
  const registered = d.treatment !== 'not_registered';
  // GST-exclusive: an invoice's GST is the total less its subtotal (10% added on top); a credit
  // note against one carries the same one-eleventh share of what it credits, shown with its subtotal.
  let gst = gstIncluded(d.totalCents, d.treatment);
  let subtotal = d.subtotalCents;
  if (d.treatment === 'gst_exclusive') {
    if (subtotal === undefined) subtotal = d.totalCents - gst;
    gst = d.totalCents - subtotal;
  }
  const heading: DocumentHeading = credit
    ? registered ? 'Adjustment note' : 'Credit note'
    : taxWording(d.treatment, d.totalCents).heading;
  const gstLine = d.treatment === 'gst_inclusive'
    ? `${credit ? 'Credit' : 'Total'} includes GST of ${money(gst)}`
    : d.treatment === 'gst_exclusive'
      ? `GST (${GST_PERCENT}%) ${money(gst)}`
      : taxWording(d.treatment, d.totalCents).gstLine;
  const notes = [...d.notes];
  if (registered) notes.unshift(credit ? 'This adjusts a taxable sale.' : 'All items are taxable sales.');
  // ATO: a tax invoice of A$1,000 or more must identify the buyer (name or ABN).
  if (registered && d.totalCents >= BUYER_ID_THRESHOLD_CENTS && !d.buyer.name.trim() && !d.buyer.abn) {
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
    ...(subtotal !== undefined ? { subtotalCents: subtotal } : {}),
    totalCents: d.totalCents,
    gstCents: gst,
    gstLine,
    ...(d.dueOn ? { dueOn: d.dueOn } : {}),
    ...(d.payId ? { payId: d.payId } : {}),
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
  row: { orderId: string | null; batchId?: string | null; paymentId: string | null; refersTo: string | null; now: Date; paid: { on: string; method: string } | null },
): Promise<string> {
  const text = canonicalJson(snap);
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO documents (number, kind, order_id, batch_id, payment_id, refers_to, issued_on, issued_at, total_cents, gst_cents, snapshot, snapshot_sha256, paid_on, paid_method, due_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13::date, $14, $15::date) RETURNING id`,
    [snap.number, snap.kind, row.orderId, row.batchId ?? null, row.paymentId, row.refersTo, snap.issuedOn, row.now, snap.totalCents, snap.gstCents, text, sha256(text),
      row.paid?.on ?? null, row.paid?.method ?? null, snap.dueOn ?? null],
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
 * Issues a club batch's invoice, once, inside the caller's transaction (the one that marks the
 * batch Returned), and queues the invoice email to the club's billing contact. Returns the
 * invoice's id; a batch that already has one gets that one back and nothing new is queued.
 * Production refuses to issue one while the PayID isn't set (it would print a placeholder).
 */
export async function issueClubInvoice(
  q: Queryable,
  args: { batchId: string; seller: Seller; isProduction: boolean; paymentTermsDays: number; now: Date },
): Promise<string> {
  const { rows: existing } = await q.query<{ id: string }>(`SELECT id FROM documents WHERE batch_id = $1 AND kind = 'invoice'`, [args.batchId]);
  if (existing[0]) return String(existing[0].id);
  if (args.isProduction && !args.seller.payId?.trim()) throw new DocumentError('payid_missing', 'Set BUSINESS_PAYID before invoicing clubs: invoices tell clubs where to pay.');
  const { rows } = await q.query<{
    reference: string; paddle_count: number; unchanged_count: number; collected_on: string; returned_on: string | null;
    name: string; abn: string | null; billing_name: string; billing_address: string; is_test: boolean;
  }>(
    `SELECT b.reference, b.paddle_count, b.unchanged_count, b.collected_on::text AS collected_on, b.returned_on::text AS returned_on,
            c.name, c.abn, c.billing_name, c.billing_address, c.is_test
       FROM batches b JOIN clubs c ON c.id = b.club_id WHERE b.id = $1`,
    [args.batchId],
  );
  const b = rows[0];
  if (!b) throw new DocumentError('not_found', 'No such batch.');
  if (!b.returned_on) throw new DocumentError('not_returned', 'A batch is invoiced when it is returned.');
  const paddles = Number(b.paddle_count) - Number(b.unchanged_count);
  if (paddles < 1) throw new DocumentError('nothing_to_invoice', 'Every paddle came back unchanged: there is nothing to invoice.');
  const issuedOn = sydneyDate(args.now);
  const terms = termsOn(issuedOn, { gstRegisteredFrom: args.seller.gstRegisteredFrom });
  const number = await nextNumber(q, 'INV');
  const snap = clubInvoiceSnapshot(number, issuedOn, {
    batchReference: b.reference,
    clubName: b.name,
    clubAbn: b.abn,
    billingName: b.billing_name,
    billingAddress: b.billing_address,
    test: b.is_test,
    paddles,
    remitPerPaddleCents: terms.clubRemitPerPaddleCents,
    collectedOn: b.collected_on,
    returnedOn: b.returned_on,
    dueOn: addDays(issuedOn, args.paymentTermsDays),
  }, args.seller);
  const id = await insert(q, snap, { orderId: null, batchId: args.batchId, paymentId: null, refersTo: null, now: args.now, paid: null });
  await enqueueBatchEmail(q, args.batchId, 'club_invoice', args.now, { documentId: id });
  return id;
}

/** YYYY-MM-DD plus n calendar days. */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
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
    `SELECT d.id, d.number, d.kind, d.issued_on::text AS issued_on, d.total_cents, d.gst_cents, COALESCE(o.reference, b.reference) AS reference, r.number AS refers_to
       FROM documents d LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN batches b ON b.id = d.batch_id LEFT JOIN documents r ON r.id = d.refers_to
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

/** SCRUM-85: a club invoice's private link stays valid this long after the email that carried it. */
export const CLUB_LINK_DAYS = 365;

/**
 * SCRUM-85: a club document opened with the private link from its email (a token minted for that
 * send, only its hash kept). Null for anything else, so a wrong token and a wrong number look alike.
 */
export async function clubDocumentForToken(q: Queryable, token: unknown, number: unknown, now: Date): Promise<DocumentView | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (typeof number !== 'string' || !/^PMP-(INV|CN)-\d{4,}$/.test(number)) return null;
  const { rows } = await q.query<DocumentRow>(
    `SELECT d.id, d.snapshot, d.snapshot_sha256, d.paid_on::text AS paid_on, d.paid_method
       FROM document_tokens t JOIN documents d ON d.id = t.document_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.created_at > $2 AND d.number = $3 AND d.batch_id IS NOT NULL`,
    [createHash('sha256').update(token, 'utf8').digest(), new Date(now.getTime() - CLUB_LINK_DAYS * 86_400_000), number],
  );
  return rows[0] ? view(rows[0]) : null;
}
