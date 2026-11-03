/**
 * Receipts and credit notes (SCRUM-84): one gapless sequence, frozen snapshots, wording by issue
 * date, the A$1,000 buyer rule, a receipt at Paid, a credit note per refund, Refunded on a full
 * refund, the private printable page, the admin, and erasure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  creditNoteSnapshot,
  DEFAULT_SELLER,
  displayHeading,
  documentByNumber,
  DocumentError,
  nextNumber,
  receiptSnapshot,
  sha256,
  type DocumentView,
  type ReceiptFacts,
  type Seller,
} from '../src/documents/documents.js';
import { processOutbox } from '../src/email/outbox.js';
import type { EmailMessage, EmailSender } from '../src/email/sender.js';
import { eraseCustomer, planErasure } from '../src/orders/erasure.js';
import { createCode } from '../src/orders/discounts.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { pollEvents, reinstateLatePayment } from '../src/payments/payments.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';
import { fakeStripe, type FakeStripe } from './helpers/fake-stripe.js';

const GST_FROM = '2027-03-01';
const registered: Seller = { ...DEFAULT_SELLER, abn: '51824753556', gstRegisteredFrom: GST_FROM };
const facts: ReceiptFacts = { reference: 'PMP-ABCDE', buyerName: 'Sam Player', test: false, paddles: 2, subtotalCents: 12000, discountCents: 0, discountCode: null, postageCents: 1800, totalCents: 13800 };

describe('wording by issue date (SCRUM-81)', () => {
  it('before the GST date: "Invoice" ("Invoice: paid" once paid), no GST, never the words "tax invoice"', () => {
    const s = receiptSnapshot('PMP-INV-0001', '2027-02-28', facts, registered);
    expect(s).toMatchObject({ heading: 'Invoice', treatment: 'not_registered', gstCents: 0, gstLine: 'No GST has been charged', notes: [] });
    expect(displayHeading(s.heading, true)).toBe('Invoice: paid');
    expect(canonicalJson(s).toLowerCase()).not.toContain('tax invoice');
    expect(s.seller).toEqual({ name: 'PickleMyPaddle', abn: '51 824 753 556', email: 'info@picklemypaddle.com', website: 'www.picklemypaddle.com' });
  });

  it('from the GST date: "Tax invoice", the ABN, the GST included and that every item is taxable', () => {
    const s = receiptSnapshot('PMP-INV-0002', GST_FROM, facts, registered);
    expect(s).toMatchObject({ heading: 'Tax invoice', treatment: 'gst_inclusive', gstCents: 1255, gstLine: 'Total includes GST of A$12.55' });
    expect(s.notes).toEqual(['All items are taxable sales.']);
    expect(s.seller.abn).toBe('51 824 753 556');
    expect(s.buyer).toEqual({ name: 'Sam Player' });
  });

  it('shows the lines that make up what was paid: re-grit, discount with its code, return postage', () => {
    const s = receiptSnapshot('PMP-INV-0003', '2026-11-03', { ...facts, paddles: 1, subtotalCents: 6000, discountCents: 6000, discountCode: 'FREE-ABCDEFGH', totalCents: 1800 }, DEFAULT_SELLER);
    expect(s.lines).toEqual([
      { description: 'Paddle re-grit, both faces', quantity: 1, unitCents: 6000, amountCents: 6000 },
      { description: 'Discount (code FREE-ABCDEFGH)', quantity: 1, unitCents: -6000, amountCents: -6000 },
      { description: 'Return postage', quantity: 1, unitCents: 1800, amountCents: 1800 },
    ]);
    expect(s.seller.abn).toBe('[To confirm: ABN]');
    expect(() => receiptSnapshot('PMP-INV-0004', '2026-11-03', { ...facts, totalCents: 99 }, DEFAULT_SELLER)).toThrow(DocumentError);
  });

  it('a tax invoice of A$1,000 or more must name the buyer; under it, or before GST, it needn’t', () => {
    const big = { ...facts, paddles: 17, subtotalCents: 102_000, postageCents: 0, totalCents: 102_000 };
    expect(() => receiptSnapshot('PMP-INV-0005', GST_FROM, { ...big, buyerName: ' ' }, registered)).toThrow(/A\$1,000 or more/);
    expect(receiptSnapshot('PMP-INV-0005', GST_FROM, big, registered).buyer.name).toBe('Sam Player');
    expect(() => receiptSnapshot('PMP-INV-0006', GST_FROM, { ...facts, buyerName: '' }, registered)).not.toThrow();
    expect(() => receiptSnapshot('PMP-INV-0007', '2027-02-28', { ...big, buyerName: '' }, registered)).not.toThrow();
  });

  it('a credit note follows the document it adjusts: an adjustment note for a tax invoice, a credit note otherwise', () => {
    const before = receiptSnapshot('PMP-INV-0001', '2027-02-28', facts, registered);
    const after = receiptSnapshot('PMP-INV-0002', GST_FROM, facts, registered);
    const cn1 = creditNoteSnapshot('PMP-CN-0001', '2027-03-05', before, 1800, registered);
    expect(cn1).toMatchObject({ heading: 'Credit note', gstCents: 0, gstLine: 'No GST has been charged', refersTo: { number: 'PMP-INV-0001', issuedOn: '2027-02-28' }, totalCents: 1800 });
    const cn2 = creditNoteSnapshot('PMP-CN-0002', '2027-03-05', after, 13800, registered);
    expect(cn2).toMatchObject({ heading: 'Adjustment note', gstCents: 1255, gstLine: 'Credit includes GST of A$12.55' });
    expect(cn2.lines).toEqual([{ description: 'Refund against PMP-INV-0002', quantity: 1, unitCents: 13800, amountCents: 13800 }]);
    expect(() => creditNoteSnapshot('PMP-CN-0003', '2027-03-05', after, 0, registered)).toThrow(DocumentError);
  });

  it('canonical JSON is the same bytes whatever order the keys were written in', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 'é' } })).toBe(canonicalJson({ a: { c: 'é', d: [2, { x: 2, y: 1 }] }, b: 1 }));
  });
});

describe('documents in the database', () => {
  let t: TestApp;
  let stripe: FakeStripe;
  afterEach(async () => t?.close());

  const setup = async () => {
    const opts: { clock?: { now: Date } } = {};
    stripe = fakeStripe(opts);
    t = await makeApp({ stripe });
    opts.clock = t.clock;
  };
  const deps = () => ({ db: t.db, isProduction: false, now: t.clock.now });
  const api = (path: string, body: unknown) =>
    t.app.request(`/api/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { Origin: SITE, 'Content-Type': 'application/json' } });
  const status = async (reference: string) => (await t.db.query<{ status: string }>('SELECT status FROM orders WHERE reference = $1', [reference])).rows[0]!.status;
  const docs = async () =>
    (await t.db.query<{ id: string; number: string; kind: string; total_cents: number; snapshot: string; snapshot_sha256: string; paid_method: string | null }>(
      'SELECT id, number, kind, total_cents, snapshot, snapshot_sha256, paid_method FROM documents ORDER BY id',
    )).rows;
  const emails = async () =>
    (await t.db.query<{ template: string; payload: Record<string, unknown> | string }>(`SELECT template, payload FROM outbox WHERE kind = 'email' ORDER BY id`)).rows.map((r) => ({
      template: r.template, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    }));
  const accepted = async (email?: string, code?: string) => {
    const fd = await orderForm(t, { email, overrides: { name: 'Sam Player', street: '1 Secret St', ...(code ? { discountCode: code } : {}) } });
    const { reference, statusToken } = (await (await post(t, fd)).json()) as { reference: string; statusToken: string };
    await transitionOrder(deps(), { reference, to: 'accepted', actor: 'admin' });
    return { reference, token: statusToken };
  };
  const pay = async (token: string) => {
    const r = await api('orders/pay', { token });
    const { url } = (await r.json()) as { url: string };
    const s = [...stripe.sessions.values()].find((x) => x.url === url)!;
    stripe.pay(s.id);
    return s.id;
  };
  const paymentIntent = async () => (await t.db.query<{ payment_intent_id: string }>('SELECT payment_intent_id FROM payments')).rows[0]!.payment_intent_id;

  it('numbers are consecutive under concurrency, and a rolled-back issue gives its number back', async () => {
    await setup();
    const got = await Promise.all([t.db.tx((q) => nextNumber(q, 'INV')), t.db.tx((q) => nextNumber(q, 'INV'))]);
    expect(got.sort()).toEqual(['PMP-INV-0001', 'PMP-INV-0002']);
    await expect(t.db.tx(async (q) => {
      await nextNumber(q, 'INV');
      throw new Error('issue failed');
    })).rejects.toThrow('issue failed');
    expect(await t.db.tx((q) => nextNumber(q, 'INV'))).toBe('PMP-INV-0003');
    expect(await t.db.tx((q) => nextNumber(q, 'CN'))).toBe('PMP-CN-0001');
  });

  it('a paid order gets exactly one receipt, however many times Paid is recognised, with its email', async () => {
    await setup();
    const { reference, token } = await accepted();
    await pollEvents(t.payments!);
    const session = await pay(token);
    await Promise.all([api('orders/paid', { sessionId: session }), pollEvents(t.payments!), api('orders/paid', { sessionId: session })]);
    expect(await status(reference)).toBe('paid');
    const [receipt, ...more] = await docs();
    expect(more).toEqual([]);
    expect(receipt).toMatchObject({ number: 'PMP-INV-0001', kind: 'receipt', total_cents: 7170, paid_method: 'card' });
    expect(sha256(receipt!.snapshot)).toBe(receipt!.snapshot_sha256);
    // Only the name: never the address, email or paddle brand.
    expect(receipt!.snapshot).toContain('Sam Player');
    expect(receipt!.snapshot).not.toMatch(/Secret St|@test\.picklemypaddle|Selkirk|JOOLA/);
    expect((await emails()).filter((e) => e.template === 'payment_received')).toEqual([
      { template: 'payment_received', payload: { documentId: String(receipt!.id), amountCents: 7170 } },
    ]);
  });

  it('a coded order’s receipt shows the code on its discount line', async () => {
    await setup();
    await createCode(t.db, { code: 'FREE-ABCDEFGH', kind: 'free', value: 1, maxUses: 1, expiresOn: null, onePerEmail: true, note: null }, 'test', t.clock.now);
    const { token } = await accepted(undefined, 'FREE-ABCDEFGH');
    await api('orders/paid', { sessionId: await pay(token) });
    const snap = JSON.parse((await docs())[0]!.snapshot) as { lines: { description: string; amountCents: number }[]; totalCents: number };
    expect(snap.lines.map((l) => [l.description, l.amountCents])).toEqual([
      ['Paddle re-grit, both faces', 6000], ['Discount (code FREE-ABCDEFGH)', -6000], ['Return postage', 1170],
    ]);
    expect(snap.totalCents).toBe(1170);
  });

  it('the status page lists the receipt, and its link opens it; nothing else opens it', async () => {
    await setup();
    const { token } = await accepted();
    await api('orders/paid', { sessionId: await pay(token) });
    const view = (await (await api('orders/status', { token })).json()) as { documents: unknown[] };
    expect(view.documents).toEqual([{ number: 'PMP-INV-0001', title: 'Receipt', issuedOn: '2026-10-26' }]);
    const r = await api('orders/document', { token, number: 'PMP-INV-0001' });
    expect(r.status).toBe(200);
    const doc = (await r.json()) as DocumentView;
    expect(doc.snapshot).toMatchObject({ number: 'PMP-INV-0001', heading: 'Invoice', reference: expect.stringMatching(/^PMP-/), test: true });
    expect(doc.paid).toEqual({ on: '2026-10-26', method: 'card' });

    // Another order's link can't open it, nor can a bad token or number.
    const other = await accepted('other@test.picklemypaddle.com');
    for (const body of [{ token: other.token, number: 'PMP-INV-0001' }, { token: 'x'.repeat(43), number: 'PMP-INV-0001' }, { token, number: 'PMP-INV-0002' }, { token, number: '../x' }]) {
      const bad = await api('orders/document', body);
      expect(bad.status).toBe(404);
      expect(await bad.json()).toEqual({ error: 'invalid_link', message: 'This link isn’t valid or has expired.' });
    }
  });

  it('the payment email links the receipt with a fresh status token; the In-queue email links it again', async () => {
    await setup();
    const { reference, token } = await accepted();
    await api('orders/paid', { sessionId: await pay(token) });
    await transitionOrder(deps(), { reference, to: 'in_queue', actor: 'admin' });
    const sent: EmailMessage[] = [];
    const sender: EmailSender = { name: 'fake', send: async (m) => (sent.push(m), { id: `e${sent.length}` }) };
    await processOutbox({ db: t.db, sender, settings: { isProduction: false, allowList: ['player@test.picklemypaddle.com'], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
    const paid = sent.find((m) => m.subject.includes('Payment received'))!;
    const link = /http:\/\/localhost:4321\/order\/document\?n=PMP-INV-0001#([A-Za-z0-9_-]{43})/.exec(paid.text);
    expect(link).not.toBeNull();
    expect((await api('orders/document', { token: link![1], number: 'PMP-INV-0001' })).status).toBe(200);
    expect(sent.find((m) => m.subject.includes('arrived'))!.text).toContain('Your receipt (PMP-INV-0001)');
  });

  it('a partial refund issues a credit note and keeps the status; refunding the rest issues another and moves it to Refunded', async () => {
    await setup();
    const { reference, token } = await accepted();
    await api('orders/paid', { sessionId: await pay(token) });
    await transitionOrder(deps(), { reference, to: 'in_queue', actor: 'admin' });
    await pollEvents(t.payments!);
    const pi = await paymentIntent();

    stripe.refund(pi, 1170);
    await pollEvents(t.payments!);
    await pollEvents(t.payments!); // the same event again changes nothing
    expect(await status(reference)).toBe('in_queue');
    let all = await docs();
    expect(all.map((d) => [d.number, d.kind, d.total_cents])).toEqual([['PMP-INV-0001', 'receipt', 7170], ['PMP-CN-0001', 'credit_note', 1170]]);
    expect(JSON.parse(all[1]!.snapshot)).toMatchObject({ heading: 'Credit note', refersTo: { number: 'PMP-INV-0001' } });

    stripe.refund(pi, 6000);
    await pollEvents(t.payments!);
    expect(await status(reference)).toBe('refunded');
    all = await docs();
    expect(all.map((d) => [d.number, d.total_cents])).toEqual([['PMP-INV-0001', 7170], ['PMP-CN-0001', 1170], ['PMP-CN-0002', 6000]]);
    const refunds = (await emails()).filter((e) => e.template === 'refund_issued').map((e) => e.payload);
    expect(refunds).toEqual([
      { documentId: String(all[1]!.id), refundCents: 1170, refundFull: false },
      { documentId: String(all[2]!.id), refundCents: 6000, refundFull: true },
    ]);
    const view = (await (await api('orders/status', { token })).json()) as { statusLabel: string; payment: { refundedCents: number }; documents: { number: string }[] };
    expect(view.statusLabel).toBe('Refunded: see our email for details');
    expect(view.payment.refundedCents).toBe(7170);
    expect(view.documents.map((d) => d.number)).toEqual(['PMP-INV-0001', 'PMP-CN-0001', 'PMP-CN-0002']);
  });

  it('a refund of a payment that was never applied issues nothing and moves nothing', async () => {
    await setup();
    const { reference, token } = await accepted();
    await pollEvents(t.payments!);
    const s = await pay(token);
    await transitionOrder(deps(), { reference, to: 'lapsed', actor: 'system' });
    await api('orders/paid', { sessionId: s }); // late: flagged
    stripe.refund(await paymentIntent(), 7170);
    await pollEvents(t.payments!);
    expect(await status(reference)).toBe('lapsed');
    expect(await docs()).toEqual([]);
  });

  it('a reinstated late payment gets its receipt', async () => {
    await setup();
    const { reference, token } = await accepted();
    const s = await pay(token);
    await transitionOrder(deps(), { reference, to: 'lapsed', actor: 'system' });
    await api('orders/paid', { sessionId: s });
    expect(await docs()).toEqual([]);
    await reinstateLatePayment(t.db, reference, 'attila', 'Paid a day late; fine.', { isProduction: false, now: t.clock.now });
    expect((await docs()).map((d) => d.number)).toEqual(['PMP-INV-0001']);
    expect((await emails()).some((e) => e.template === 'payment_received')).toBe(true);
  });

  it('issued documents never change: the database refuses edits, and a new GST date leaves them byte-identical', async () => {
    await setup();
    const { token } = await accepted();
    await api('orders/paid', { sessionId: await pay(token) });
    const [before] = await docs();
    await expect(t.db.query(`UPDATE documents SET snapshot = '{}' WHERE id = $1`, [before!.id])).rejects.toThrow(/never edited/);
    await expect(t.db.query(`UPDATE documents SET total_cents = 1 WHERE id = $1`, [before!.id])).rejects.toThrow(/never edited/);
    await expect(t.db.query(`UPDATE documents SET paid_on = '2026-12-01' WHERE id = $1`, [before!.id])).rejects.toThrow(/set once/);

    // Registered for GST from today, with an ABN: a credit note issued now uses the new terms…
    t.payments!.seller = { ...registered, gstRegisteredFrom: '2026-10-01' };
    stripe.refund(await paymentIntent(), 1170);
    await pollEvents(t.payments!);
    const [after, cn] = await docs();
    // …but the receipt is byte-for-byte what was issued.
    expect(after!.snapshot).toBe(before!.snapshot);
    expect(after!.snapshot_sha256).toBe(before!.snapshot_sha256);
    expect(sha256(after!.snapshot)).toBe(before!.snapshot_sha256);
    expect(JSON.parse(cn!.snapshot)).toMatchObject({ heading: 'Credit note', seller: { abn: '51 824 753 556' } });
  });

  it('the admin lists every document and shows each one printable', async () => {
    await setup();
    const { reference, token } = await accepted();
    await api('orders/paid', { sessionId: await pay(token) });
    const admin = await makeAdmin(t, { paymentsConfigured: true });
    const list = await (await admin.get('/admin/documents')).text();
    expect(list).toContain('PMP-INV-0001');
    expect(list).toContain(reference);
    const page = await (await admin.get('/admin/documents/PMP-INV-0001')).text();
    expect(page).toContain('Invoice: paid');
    expect(page).toContain('No GST has been charged');
    expect(page).toContain('ABN [To confirm: ABN]');
    expect(page).toContain('TEST DOCUMENT');
    expect(page).toContain((await documentByNumber(t.db, 'PMP-INV-0001'))!.sha256);
    expect((await admin.get('/admin/documents/PMP-INV-0099')).status).toBe(404);
    expect(await (await admin.get(`/admin/orders/${reference}`)).text()).toContain('Receipts and credit notes');
  });

  it('erasure keeps documents as issued (name and amounts only) and their links stop working', async () => {
    await setup();
    const email = 'erase.me@test.picklemypaddle.com';
    const { reference, token } = await accepted(email);
    await api('orders/paid', { sessionId: await pay(token) });
    for (const to of ['in_queue', 'regritted', 'posted_back', 'completed'] as const) {
      await transitionOrder(deps(), { reference, to, actor: 'admin', ...(to === 'posted_back' ? { trackingNumber: 'AP1' } : {}) });
    }
    const [before] = await docs();
    const plan = await planErasure({ db: t.db }, email, t.clock.now);
    expect(plan.orders.map((o) => o.action)).toEqual(['minimise']);
    await eraseCustomer({ db: t.db, photos: t.photos, crm: null }, email, plan.fingerprint, t.clock.now);
    const [after] = await docs();
    expect(after!.snapshot).toBe(before!.snapshot);
    expect((await api('orders/document', { token, number: 'PMP-INV-0001' })).status).toBe(404);
  });
});
