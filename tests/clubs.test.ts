/**
 * Clubs, batches and club invoices (SCRUM-85, first part).
 *
 *  - The club invoice's amounts and wording: before GST registration, and from it with GST added on
 *    top as its own line (decided 4 Nov 2026), with rounding and a credit note; direct orders unchanged.
 *  - Clubs: validation, unique names, active/inactive; no member data anywhere.
 *  - Batches: Collected → Returned → Invoiced, or Cancelled before return; unchanged paddles aren't
 *    charged; returning issues exactly one invoice and one email, all or nothing.
 *  - The invoice email: to the billing contact, Reply-To attila@, a private link (only its hash kept)
 *    that opens the invoice through the public API, and nothing else.
 *  - The admin pages: add a club, record a batch, return it, see the invoice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelBatch, ClubError, createBatch, createClub, findBatch, returnBatch, setClubActive, validateClub, type ClubInput,
} from '../src/clubs/clubs.js';
import {
  clubInvoiceSnapshot, creditNoteSnapshot, DEFAULT_SELLER, PAYID_PLACEHOLDER, receiptSnapshot, type ClubInvoiceFacts, type Seller,
} from '../src/documents/documents.js';
import { processOutbox } from '../src/email/outbox.js';
import { CLUB_REPLY_TO, type EmailMessage, type EmailSender } from '../src/email/sender.js';
import { render, sampleContext } from '../src/email/templates.js';
import { clubInvoiceAmounts } from '../src/pricing/terms.js';
import { loadConfig } from '../src/config.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, SITE, type TestApp } from './helpers/app.js';

const GST_FROM = '2027-03-01';
const registered: Seller = { ...DEFAULT_SELLER, abn: '51824753556', gstRegisteredFrom: GST_FROM, payId: 'payments@picklemypaddle.com' };
const facts: ClubInvoiceFacts = {
  batchReference: 'PMPB-4K7QX',
  clubName: 'Inner West Pickleball Club',
  clubAbn: '51824753556',
  billingName: 'Jo Treasurer',
  billingAddress: '1 Court St\nNewtown NSW 2042',
  test: false,
  paddles: 23,
  remitPerPaddleCents: 5400,
  collectedOn: '2027-02-20',
  returnedOn: '2027-03-02',
  dueOn: '2027-03-16',
  payByCard: false,
};

describe('club invoice amounts (GST on top for clubs, decided 4 Nov 2026)', () => {
  it('before registration: paddles × A$54, no GST', () => {
    expect(clubInvoiceAmounts(23, 5400, 'not_registered')).toEqual({ subtotalCents: 124200, gstCents: 0, totalCents: 124200 });
  });
  it('once registered: GST at 10% of the subtotal is added', () => {
    expect(clubInvoiceAmounts(23, 5400, 'gst_exclusive')).toEqual({ subtotalCents: 124200, gstCents: 12420, totalCents: 136620 });
    expect(clubInvoiceAmounts(1, 5400, 'gst_exclusive')).toEqual({ subtotalCents: 5400, gstCents: 540, totalCents: 5940 });
  });
  it('rounds the GST to the nearest cent (half up) on odd amounts', () => {
    expect(clubInvoiceAmounts(3, 5455, 'gst_exclusive')).toEqual({ subtotalCents: 16365, gstCents: 1637, totalCents: 18002 });
    expect(clubInvoiceAmounts(7, 5401, 'gst_exclusive')).toEqual({ subtotalCents: 37807, gstCents: 3781, totalCents: 41588 });
  });
  it('refuses nonsense: no paddles, or a GST-inclusive club invoice', () => {
    expect(() => clubInvoiceAmounts(0, 5400, 'not_registered')).toThrow();
    expect(() => clubInvoiceAmounts(2, 5400, 'gst_inclusive')).toThrow();
  });
});

describe('club invoice wording by issue date', () => {
  it('before the GST date: "Invoice", no GST, the club as buyer, due date and how to pay', () => {
    const s = clubInvoiceSnapshot('PMP-INV-0042', '2027-02-28', facts, registered);
    expect(s).toMatchObject({ kind: 'invoice', heading: 'Invoice', treatment: 'not_registered', totalCents: 124200, gstCents: 0, gstLine: 'No GST has been charged', dueOn: '2027-03-16' });
    expect(s.subtotalCents).toBeUndefined();
    expect(s.buyer).toEqual({ name: 'Inner West Pickleball Club', abn: '51 824 753 556', address: 'Attn: Jo Treasurer\n1 Court St\nNewtown NSW 2042' });
    expect(s.lines).toEqual([{ description: 'Paddle re-grit, both faces: club batch collected 20 February 2027, returned 2 March 2027', quantity: 23, unitCents: 5400, amountCents: 124200 }]);
    expect(s.notes[0]).toBe('Due by 16 March 2027.');
    expect(s.notes[1]).toBe('How to pay: PayID or bank transfer to payments@picklemypaddle.com, with PMP-INV-0042 as the reference; or in cash at your club’s next pickup or delivery.');
    expect(s.payId).toBe('payments@picklemypaddle.com');
    expect(s.payByCard).toBeUndefined();
    expect(JSON.stringify(s).toLowerCase()).not.toContain('tax invoice');
  });

  it('from the GST date: "Tax invoice", the subtotal excluding GST, GST at 10% as its own line, the total', () => {
    const s = clubInvoiceSnapshot('PMP-INV-0043', GST_FROM, facts, registered);
    expect(s).toMatchObject({ heading: 'Tax invoice', treatment: 'gst_exclusive', subtotalCents: 124200, gstCents: 12420, totalCents: 136620, gstLine: 'GST (10%) A$124.20' });
    expect(s.lines[0]!.description).toContain('(excluding GST)');
    expect(s.notes[0]).toBe('All items are taxable sales.');
    expect(s.seller.abn).toBe('51 824 753 556');
  });

  it('offers card only once the invoice page takes card payments', () => {
    const s = clubInvoiceSnapshot('PMP-INV-0047', '2027-02-28', { ...facts, payByCard: true }, registered);
    expect(s.notes[1]).toContain('by card, with the "Pay by card" button on this invoice\'s page');
    expect(s.payByCard).toBe(true);
  });

  it('shows "[To confirm: PayID]" until BUSINESS_PAYID is set', () => {
    const s = clubInvoiceSnapshot('PMP-INV-0044', '2027-02-28', facts, { ...registered, payId: null });
    expect(s.notes[1]).toContain(PAYID_PLACEHOLDER);
  });

  it('a credit note on a GST-exclusive invoice is an adjustment note carrying its share of GST', () => {
    const inv = clubInvoiceSnapshot('PMP-INV-0045', GST_FROM, facts, registered);
    const cn = creditNoteSnapshot('PMP-CN-0001', GST_FROM, inv, 5940, registered);
    expect(cn).toMatchObject({ heading: 'Adjustment note', treatment: 'gst_exclusive', totalCents: 5940, gstCents: 540, subtotalCents: 5400, gstLine: 'GST (10%) A$5.40' });
    expect(cn.refersTo).toEqual({ number: 'PMP-INV-0045', issuedOn: GST_FROM });
  });

  it('direct orders are unchanged: A$60 includes GST of A$5.45', () => {
    const r = receiptSnapshot('PMP-INV-0046', GST_FROM, { reference: 'PMP-ABCDE', buyerName: 'Sam', test: false, paddles: 1, subtotalCents: 6000, discountCents: 0, discountCode: null, postageCents: 0, totalCents: 6000 }, registered);
    expect(r).toMatchObject({ treatment: 'gst_inclusive', totalCents: 6000, gstCents: 545, gstLine: 'Total includes GST of A$5.45' });
    expect(r.subtotalCents).toBeUndefined();
  });
});

describe('the club invoice email template', () => {
  it('renders the GST lines once registered, and no GST before', () => {
    const before = render('club_invoice', sampleContext('club_invoice', true));
    expect(before.subject).toBe('[TEST] Invoice PMP-INV-0042 for Inner West Pickleball Club: 23 paddles re-gritted');
    expect(before.text).toContain('No GST has been charged.');
    expect(before.text).toContain('PayID or bank transfer to payments@picklemypaddle.com, with PMP-INV-0042 as the reference');
    expect(before.text).toContain('You’re getting this as the billing contact for Inner West Pickleball Club.');
    expect(before.text).not.toMatch(/card/i);
    const withCard = render('club_invoice', { ...sampleContext('club_invoice', true), invoice: { ...sampleContext('club_invoice', true).invoice!, payByCard: true } });
    expect(withCard.text).toContain('View, print or pay by card');
    expect(withCard.text).toContain('By card, with the button above');
    const ctx = sampleContext('club_invoice', false);
    const after = render('club_invoice', { ...ctx, invoice: { ...ctx.invoice!, treatment: 'gst_exclusive', subtotalCents: 124200, gstCents: 12420, totalCents: 136620 } });
    expect(after.text).toContain('Subtotal (excluding GST): A$1242');
    expect(after.text).toContain('GST (10%): A$124.20');
    expect(after.text).toContain('Total: A$1366.20');
    expect(after.subject.startsWith('[TEST]')).toBe(false);
  });
});

describe('club invoice settings', () => {
  const base = { APP_ENV: 'development', PUBLIC_SITE_ORIGIN: 'http://localhost:4321', DATABASE_URL: 'postgres://u:p@localhost:5432/test', EMAIL_ALLOWLIST: 'a@b.co' };
  it('payment terms default to 14 days, take 1 to 90, and an empty setting means the default', () => {
    expect(loadConfig(base).CLUB_PAYMENT_TERMS_DAYS).toBe(14);
    expect(loadConfig({ ...base, CLUB_PAYMENT_TERMS_DAYS: '' }).CLUB_PAYMENT_TERMS_DAYS).toBe(14);
    expect(loadConfig({ ...base, CLUB_PAYMENT_TERMS_DAYS: '30' }).CLUB_PAYMENT_TERMS_DAYS).toBe(30);
    expect(() => loadConfig({ ...base, CLUB_PAYMENT_TERMS_DAYS: '0' })).toThrow(/CLUB_PAYMENT_TERMS_DAYS/);
  });
  it('the PayID is optional, but never a placeholder', () => {
    expect(loadConfig({ ...base, BUSINESS_PAYID: '' }).BUSINESS_PAYID).toBeUndefined();
    expect(loadConfig({ ...base, BUSINESS_PAYID: 'payments@picklemypaddle.com' }).BUSINESS_PAYID).toBe('payments@picklemypaddle.com');
    expect(() => loadConfig({ ...base, BUSINESS_PAYID: '[To confirm: PayID]' })).toThrow(/BUSINESS_PAYID/);
  });
});

describe('club details', () => {
  const good = { name: ' Inner West PC ', billingName: 'Jo', billingEmail: 'Jo@Example.com', billingAddress: '1 Court St\r\nNewtown', abn: '51 824 753 556', notes: '' };
  it('tidies a valid form', () => {
    expect(validateClub(good)).toEqual({ name: 'Inner West PC', billingName: 'Jo', billingEmail: 'jo@example.com', billingAddress: '1 Court St\nNewtown', abn: '51824753556', notes: null });
  });
  it.each([
    ['name', { name: '' }, 'bad_name'],
    ['email', { billingEmail: 'not-an-email' }, 'bad_billing_email'],
    ['address', { billingAddress: ' ' }, 'bad_billing_address'],
    ['ABN', { abn: '12 345 678 901' }, 'bad_abn'],
  ])('refuses a bad %s', (_what, patch, code) => {
    expect(() => validateClub({ ...good, ...patch })).toThrow(expect.objectContaining({ code }));
  });
});

describe('clubs and batches in the database', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  const input: ClubInput = { name: 'Inner West PC', billingName: 'Jo Treasurer', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St, Newtown NSW 2042', abn: null, notes: null };
  const setup = async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-04T01:00:00Z'); // 4 Nov 2026, Sydney
    const club = await createClub(t.db, input, { isProduction: false, now: t.clock.now });
    return club;
  };
  const deps = (over: Partial<Parameters<typeof returnBatch>[0]> = {}) => ({
    db: t.db, seller: { ...DEFAULT_SELLER, payId: 'payments@picklemypaddle.com' }, isProduction: false, paymentTermsDays: 14, now: t.clock.now, ...over,
  });
  const count = async (sql: string, params: unknown[] = []) => Number((await t.db.query<{ n: number }>(sql, params)).rows[0]!.n);

  it('club names are unique, whatever the case; a test club is marked as one', async () => {
    const club = await setup();
    expect(club.isTest).toBe(true);
    await expect(createClub(t.db, { ...input, name: 'INNER WEST pc' }, { isProduction: false, now: t.clock.now })).rejects.toMatchObject({ code: 'duplicate_name' });
  });

  it('records a batch only for an active club, with a real collection date and at least one paddle', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-03', paddleCount: 12, notes: null, now: t.clock.now });
    expect(b).toMatchObject({ status: 'collected', paddleCount: 12, collectedOn: '2026-11-03', invoice: null });
    expect(b.reference).toMatch(/^PMPB-[A-Z2-9]{5}$/);
    await expect(createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-05', paddleCount: 1, notes: null, now: t.clock.now })).rejects.toMatchObject({ code: 'future_date' });
    await expect(createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-03', paddleCount: 0, notes: null, now: t.clock.now })).rejects.toMatchObject({ code: 'bad_count' });
    await expect(createBatch(t.db, { clubId: club.id, collectedOn: '2026-02-30', paddleCount: 1, notes: null, now: t.clock.now })).rejects.toMatchObject({ code: 'bad_date' });
    await setClubActive(t.db, club.id, false, t.clock.now);
    await expect(createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-03', paddleCount: 1, notes: null, now: t.clock.now })).rejects.toMatchObject({ code: 'club_inactive' });
  });

  it('returning a batch issues exactly one invoice and one email, and moves it to Invoiced', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-10-28', paddleCount: 12, notes: null, now: t.clock.now });
    const { invoiceId } = await returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 2 });
    expect(invoiceId).not.toBeNull();
    const after = (await findBatch(t.db, b.reference))!;
    expect(after).toMatchObject({ status: 'invoiced', returnedOn: '2026-11-04', unchangedCount: 2 });
    // 10 re-gritted × A$54, numbered in the shared sequence, due 14 days after issue.
    expect(after.invoice).toEqual({ id: invoiceId, number: 'PMP-INV-0001', totalCents: 54000, dueOn: '2026-11-18' });
    expect(await count(`SELECT count(*)::int AS n FROM documents WHERE batch_id = $1`, [b.id])).toBe(1);
    const emails = await t.db.query<{ recipient: string; template: string; order_id: string | null }>(`SELECT recipient, template, order_id FROM outbox WHERE batch_id = $1`, [b.id]);
    expect(emails.rows).toEqual([{ recipient: 'jo@test.picklemypaddle.com', template: 'club_invoice', order_id: null }]);
    // Twice: refused, and nothing new issued or queued.
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 0 })).rejects.toMatchObject({ code: 'not_collected' });
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE batch_id = $1`, [b.id])).toBe(1);
    await expect(cancelBatch(t.db, b.reference, t.clock.now)).rejects.toMatchObject({ code: 'not_cancellable' });
  });

  it('a batch returned entirely unchanged is Returned with nothing invoiced or emailed', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-01', paddleCount: 3, notes: null, now: t.clock.now });
    expect((await returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 3 })).invoiceId).toBeNull();
    expect(await findBatch(t.db, b.reference)).toMatchObject({ status: 'returned', invoice: null });
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE batch_id = $1`, [b.id])).toBe(0);
  });

  it('refuses a return before collection, in the future, or with more unchanged than collected', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 3, notes: null, now: t.clock.now });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-01', unchangedCount: 0 })).rejects.toMatchObject({ code: 'before_collection' });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-05', unchangedCount: 0 })).rejects.toMatchObject({ code: 'future_date' });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 4 })).rejects.toMatchObject({ code: 'bad_count' });
    expect(await findBatch(t.db, b.reference)).toMatchObject({ status: 'collected', returnedOn: null });
  });

  it('cancels a batch that hasn’t been returned', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 3, notes: null, now: t.clock.now });
    await cancelBatch(t.db, b.reference, t.clock.now);
    expect(await findBatch(t.db, b.reference)).toMatchObject({ status: 'cancelled' });
  });

  it('production refuses to invoice without a PayID: the batch stays Collected and no number is used', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 3, notes: null, now: t.clock.now });
    await expect(returnBatch(deps({ isProduction: true, seller: DEFAULT_SELLER }), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 0 }))
      .rejects.toSatisfy((e: unknown) => e instanceof ClubError && e.code === 'payid_missing');
    expect(await findBatch(t.db, b.reference)).toMatchObject({ status: 'collected', returnedOn: null });
    expect(await count(`SELECT last AS n FROM document_counters WHERE series = 'INV'`)).toBe(0);
  });

  it('the invoice email goes to the billing contact, replies to attila@, and its private link opens the invoice', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 2, notes: null, now: t.clock.now });
    await returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 0 });
    const sent: EmailMessage[] = [];
    const sender: EmailSender = { name: 'fake', send: async (m) => (sent.push(m), { id: `e${sent.length}` }) };
    await processOutbox({ db: t.db, sender, settings: { isProduction: false, allowList: ['jo@test.picklemypaddle.com'], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m).toMatchObject({ to: 'jo@test.picklemypaddle.com', replyTo: CLUB_REPLY_TO });
    expect(m.subject).toBe('[TEST] Invoice PMP-INV-0001 for Inner West PC: 2 paddles re-gritted');
    expect(m.text).toContain('Hi Jo,');
    expect(m.text).toContain('Due by: Wednesday 18 November 2026');
    const link = /http:\/\/localhost:4321\/club\/invoice\?n=PMP-INV-0001#([A-Za-z0-9_-]{43})/.exec(m.text);
    expect(link).not.toBeNull();
    const token = link![1]!;
    // Only the token's hash is kept.
    const stored = await t.db.query<{ token_hash: Buffer }>('SELECT token_hash FROM document_tokens');
    expect(stored.rows).toHaveLength(1);
    expect(Buffer.from(stored.rows[0]!.token_hash).toString('utf8')).not.toContain(token);

    const api = (body: unknown) => t.app.request('/api/clubs/invoice', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const ok = await api({ token, number: 'PMP-INV-0001' });
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as { snapshot: { reference: string; totalCents: number; buyer: { name: string } }; paid: unknown };
    expect(view.snapshot).toMatchObject({ reference: b.reference, totalCents: 10800, buyer: { name: 'Inner West PC' } });
    expect(view.paid).toBeNull();
    for (const bad of [{ token, number: 'PMP-INV-0002' }, { token: 'x'.repeat(43), number: 'PMP-INV-0001' }, { token }, {}]) {
      const r = await api(bad);
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: 'invalid_link' });
    }
    // A year later the link has expired.
    t.clock.now = new Date('2027-11-05T01:00:00Z');
    expect((await api({ token, number: 'PMP-INV-0001' })).status).toBe(404);
  });

  it('a failed send deletes the token it minted, so no live link exists that nobody received', async () => {
    const club = await setup();
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 2, notes: null, now: t.clock.now });
    await returnBatch(deps(), { reference: b.reference, returnedOn: '2026-11-04', unchangedCount: 0 });
    const sender: EmailSender = { name: 'fake', send: async () => { throw new Error('boom'); } };
    await processOutbox({ db: t.db, sender, settings: { isProduction: false, allowList: ['jo@test.picklemypaddle.com'], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
    expect(await count('SELECT count(*)::int AS n FROM document_tokens')).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE batch_id = $1 AND state = 'failed'`, [b.id])).toBe(1);
  });
});

describe('club batches: all-or-nothing, GST end to end, settings and email edge cases', () => {
  let t: TestApp;
  afterEach(async () => t?.close());
  const input: ClubInput = { name: 'Inner West PC', billingName: 'Jo Treasurer', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St, Newtown NSW 2042', abn: null, notes: null };
  const setup = async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-04T01:00:00Z');
    const club = await createClub(t.db, input, { isProduction: false, now: t.clock.now });
    const batch = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 4, notes: null, now: t.clock.now });
    return { club, batch };
  };
  const deps = (over: Partial<Parameters<typeof returnBatch>[0]> = {}) => ({
    db: t.db, seller: { ...DEFAULT_SELLER, payId: 'payments@picklemypaddle.com' }, isProduction: false, paymentTermsDays: 14, now: t.clock.now, ...over,
  });
  const n = async (sql: string, params: unknown[] = []) => Number((await t.db.query<{ n: number }>(sql, params)).rows[0]!.n);
  const mail = (sender: EmailSender, allow = ['jo@test.picklemypaddle.com']) =>
    processOutbox({ db: t.db, sender, settings: { isProduction: false, allowList: allow, siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });

  it('a failure after the invoice number is taken rolls everything back: no number used, no document, no email, still Collected', async () => {
    const { batch } = await setup();
    // Make queueing the email fail, after nextNumber and the document insert have run.
    await t.db.exec('ALTER TABLE outbox RENAME TO outbox_gone');
    await expect(returnBatch(deps(), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 0 })).rejects.toThrow();
    await t.db.exec('ALTER TABLE outbox_gone RENAME TO outbox');
    expect(await n(`SELECT last AS n FROM document_counters WHERE series = 'INV'`)).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM documents')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM outbox')).toBe(0);
    expect(await findBatch(t.db, batch.reference)).toMatchObject({ status: 'collected', returnedOn: null, unchangedCount: 0 });
  });

  it('two returns at once: one invoice and one email; the other is refused', async () => {
    const { batch } = await setup();
    const results = await Promise.allSettled([
      returnBatch(deps(), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 0 }),
      returnBatch(deps(), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'not_collected' } });
    expect(await n('SELECT count(*)::int AS n FROM documents')).toBe(1);
    expect(await n('SELECT count(*)::int AS n FROM outbox')).toBe(1);
  });

  it('once GST-registered, a returned batch is invoiced with GST on top, in the database and the email', async () => {
    const { batch } = await setup();
    const seller = { ...DEFAULT_SELLER, abn: '51824753556', gstRegisteredFrom: '2026-11-01', payId: 'payments@picklemypaddle.com' };
    await returnBatch(deps({ seller, paymentTermsDays: 30 }), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 1 });
    const doc = (await t.db.query<{ total_cents: number; gst_cents: number; due_on: string; snapshot: string }>('SELECT total_cents, gst_cents, due_on::text AS due_on, snapshot FROM documents')).rows[0]!;
    // 3 × A$54 = A$162, plus GST A$16.20.
    expect({ total: Number(doc.total_cents), gst: Number(doc.gst_cents), due: doc.due_on }).toEqual({ total: 17820, gst: 1620, due: '2026-12-04' });
    expect(JSON.parse(doc.snapshot)).toMatchObject({ heading: 'Tax invoice', treatment: 'gst_exclusive', subtotalCents: 16200 });
    const sent: EmailMessage[] = [];
    await mail({ name: 'fake', send: async (m) => (sent.push(m), { id: 'e1' }) });
    expect(sent[0]!.text).toContain('Subtotal (excluding GST): A$162');
    expect(sent[0]!.text).toContain('GST (10%): A$16.20');
    expect(sent[0]!.text).toContain('Total: A$178.20');
    expect(sent[0]!.text).toContain('Due by: Friday 4 December 2026');
  });

  it('outside production, a billing email not on the allow-list is never sent (and no link is made)', async () => {
    const { batch } = await setup();
    await returnBatch(deps(), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 0 });
    const sent: EmailMessage[] = [];
    await mail({ name: 'fake', send: async (m) => (sent.push(m), { id: 'e1' }) }, ['someone-else@test.picklemypaddle.com']);
    expect(sent).toHaveLength(0);
    expect(await n(`SELECT count(*)::int AS n FROM outbox WHERE state = 'suppressed' AND last_error = 'not_allow_listed'`)).toBe(1);
    expect(await n('SELECT count(*)::int AS n FROM document_tokens')).toBe(0);
  });

  it('a temporary failure keeps the link (it may have been delivered) and retries; the admin can retry a failed one', async () => {
    const { batch } = await setup();
    await returnBatch(deps(), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 0 });
    const { SendError } = await import('../src/email/sender.js');
    await mail({ name: 'fake', send: async () => { throw new SendError('timeout', false); } });
    expect(await n('SELECT count(*)::int AS n FROM document_tokens')).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM outbox WHERE state = 'pending' AND attempts = 1`)).toBe(1);

    await t.db.query(`UPDATE outbox SET state = 'failed'`);
    const admin = await makeAdmin(t);
    const id = (await t.db.query<{ id: string }>('SELECT id FROM outbox')).rows[0]!.id;
    const retry = await admin.post(`/admin/outbox/${id}/retry`);
    expect(retry.status).toBe(303);
    expect(retry.headers.get('location')).toBe(`/admin/batches/${batch.reference}?done=retry`);
    expect(await n(`SELECT count(*)::int AS n FROM outbox WHERE state = 'pending' AND attempts = 0`)).toBe(1);
  });

  it('an issued club invoice can’t be moved to another batch or have its due date changed', async () => {
    const { batch } = await setup();
    await returnBatch(deps(), { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 0 });
    await expect(t.db.query(`UPDATE documents SET due_on = '2027-01-01'`)).rejects.toThrow(/never edited/);
    await expect(t.db.query(`UPDATE documents SET batch_id = NULL`)).rejects.toThrow(/never edited/);
  });

  it('holds no member details or discount codes for clubs: the tables have no such columns', async () => {
    await setup();
    const cols = async (table: string) => (await t.db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map((r) => r.c);
    for (const table of ['clubs', 'batches']) {
      expect((await cols(table)).filter((c) => /member|player|discount|code/.test(c)), table).toEqual([]);
    }
  });

  it('limits invoice lookups per address', async () => {
    await setup();
    const api = () => t.app.request('/api/clubs/invoice', { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(43), number: 'PMP-INV-0001' }), headers: { 'Content-Type': 'application/json' } });
    for (let i = 0; i < 120; i++) expect((await api()).status).toBe(404);
    const limited = await api();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});

describe('the admin club pages', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  it('adds a club, records a batch, returns it and shows the invoice', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-04T01:00:00Z');
    const admin = await makeAdmin(t);
    expect((await admin.get('/admin/clubs')).status).toBe(200);

    const bad = await admin.post('/admin/clubs', { name: 'Inner West PC', billingName: 'Jo', billingEmail: 'nope', billingAddress: '1 Court St' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Give a valid billing email address.');

    const made = await admin.post('/admin/clubs', { name: 'Inner West PC', billingName: 'Jo Treasurer', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: '', notes: '' });
    expect(made.status).toBe(303);
    const clubUrl = made.headers.get('location')!.replace(/\?.*$/, '');
    expect(await (await admin.get(clubUrl)).text()).toContain('Record a batch collected');

    const batch = await admin.post(`${clubUrl}/batches`, { collectedOn: '2026-11-02', paddleCount: '5', notes: '' });
    expect(batch.status).toBe(303);
    const batchUrl = batch.headers.get('location')!.replace(/\?.*$/, '');
    expect(batchUrl).toMatch(/^\/admin\/batches\/PMPB-[A-Z2-9]{5}$/);

    const returned = await admin.post(`${batchUrl}/return`, { returnedOn: '2026-11-04', unchangedCount: '1' });
    expect(returned.status).toBe(303);
    expect(returned.headers.get('location')).toContain('done=batch_returned');
    const page = await (await admin.get(batchUrl)).text();
    expect(page).toContain('PMP-INV-0001');
    expect(page).toContain('A$216'); // 4 × A$54
    expect(page).toContain('Invoice email');

    const docs = await (await admin.get('/admin/documents')).text();
    expect(docs).toContain(`href="${batchUrl}"`);
    const doc = await (await admin.get('/admin/documents/PMP-INV-0001')).text();
    expect(doc).toContain('Club batch');
    expect(doc).toContain('Due by');
  });

  it('edits a club, escapes what’s typed, and makes it inactive and active again', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const made = await admin.post('/admin/clubs', { name: 'Club', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St' });
    const url = made.headers.get('location')!.replace(/\?.*$/, '');
    const saved = await admin.post(url, { name: '<script>alert(1)</script> PC', billingName: 'Jo "Quotes"', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '2 Net Rd', abn: '51 824 753 556', notes: '<b>hi</b>' });
    expect(saved.status).toBe(303);
    const page = await (await admin.get(url)).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt; PC');
    expect(page).not.toContain('<b>hi</b>');
    expect(page).toContain('value="51824753556"');

    expect((await admin.post(`${url}/active`, { active: 'no' })).headers.get('location')).toContain('done=club_inactive');
    expect(await (await admin.get(url)).text()).toContain('This club is inactive');
    expect((await admin.post(`${url}/batches`, { collectedOn: '2026-10-26', paddleCount: '2' })).status).toBe(400);
    expect((await admin.post(`${url}/active`, { active: 'yes' })).headers.get('location')).toContain('done=club_active');
    expect(await (await admin.get(url)).text()).toContain('Record a batch collected');
  });
});
