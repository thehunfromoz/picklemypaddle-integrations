/**
 * Clubs that post their paddles (SCRUM-94/96 UAT, 10 Nov 2026): a batch can be received by post
 * instead of picked up, with one tracking number to us and one back, and a note.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cancelBatch, ClubError, cleanTracking, createBatch, createClub, findBatch, invoiceBatch, returnBatch } from '../src/clubs/clubs.js';
import { recordClubPayment } from '../src/clubs/payments.js';
import { quotePostage } from '../src/pricing/postage.js';
import { DEFAULT_SELLER } from '../src/documents/documents.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => t?.close());

const club = () =>
  createClub(t.db, { name: 'Far Away PC', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
const deps = () => ({ db: t.db, seller: DEFAULT_SELLER, isProduction: false, now: t.clock.now });
const today = () => t.clock.now.toISOString().slice(0, 10);
const pay = (reference: string, amountCents: number) =>
  recordClubPayment(t.db, { batchReference: reference, method: 'cash', amountCents, paidOn: today(), reference: null, by: 'attila@test.picklemypaddle.com', now: t.clock.now });


describe('batches received by post', () => {
  it('records the method, the tracking number to us and a note; a batch is a pickup unless said otherwise', async () => {
    t = await makeApp();
    const c = await club();
    const posted = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 8, notes: 'Box 1 of 2', now: t.clock.now, method: 'post', inboundTracking: 'AP 123-456' });
    expect(posted).toMatchObject({ method: 'post', inboundTracking: 'AP 123-456', notes: 'Box 1 of 2', returnTracking: null });
    const picked = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 3, notes: null, now: t.clock.now });
    expect(picked).toMatchObject({ method: 'pickup', inboundTracking: null });
  });

  it('refuses an unknown method, a tracking number on a pickup, and a malformed tracking number', async () => {
    t = await makeApp();
    const c = await club();
    const base = { clubId: c.id, collectedOn: today(), paddleCount: 6, notes: null, now: t.clock.now };
    await expect(createBatch(t.db, { ...base, method: 'courier' })).rejects.toMatchObject({ code: 'bad_method' });
    await expect(createBatch(t.db, { ...base, method: 'pickup', inboundTracking: 'ABC123' })).rejects.toMatchObject({ code: 'bad_tracking' });
    await expect(createBatch(t.db, { ...base, method: 'post', inboundTracking: '<script>' })).rejects.toMatchObject({ code: 'bad_tracking' });
    expect(() => cleanTracking('x'.repeat(61))).toThrow(ClubError);
    expect(cleanTracking('  ')).toBe('');
  });

  it('the club pays before the batch goes back: invoiced, paid, then returned with its return tracking number', async () => {
    t = await makeApp();
    const c = await club();
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 4, notes: null, now: t.clock.now, method: 'post', inboundTracking: 'AP 1' });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: today() })).rejects.toMatchObject({ code: 'not_paid' });
    await invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0 });
    expect(await findBatch(t.db, b.reference)).toMatchObject({ status: 'invoiced', returnedOn: null, returnTracking: null });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: today() })).rejects.toMatchObject({ code: 'not_paid' }); // not yet paid
    await pay(b.reference, 4 * 5400);
    expect((await findBatch(t.db, b.reference))!.status).toBe('paid');
    await returnBatch(deps(), { reference: b.reference, returnedOn: today(), returnTracking: 'AP 999' });
    expect(await findBatch(t.db, b.reference)).toMatchObject({ status: 'returned', returnedOn: today(), returnTracking: 'AP 999', inboundTracking: 'AP 1' });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: today() })).rejects.toMatchObject({ code: 'not_returnable' });
  });

  it('a return tracking number on a pickup batch is refused, and the batch stays paid', async () => {
    t = await makeApp();
    const c = await club();
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 2, notes: null, now: t.clock.now });
    await invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0 });
    await pay(b.reference, 2 * 5400);
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: today(), returnTracking: 'X1' })).rejects.toMatchObject({ code: 'bad_tracking' });
    expect((await findBatch(t.db, b.reference))!.status).toBe('paid');
  });

  it('a posted batch of 6 or more: the standard return postage is its own negative line, GST (once registered) is on the net, and the club pays that', async () => {
    t = await makeApp();
    const c = await club();
    await t.db.query(`UPDATE clubs SET venue_postcode = '2560', suburb = 'Campbelltown' WHERE id = $1`, [c.id]);
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 8, notes: null, now: t.clock.now, method: 'post' });
    const quote = quotePostage(8, '2560', today());
    if (!quote.ok) throw new Error('fixture: no quote');
    const r = await invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0 });
    expect(r.postageAllowanceCents).toBe(quote.postageCents);
    const inv = (await t.db.query<{ snapshot: string; total_cents: number }>(`SELECT snapshot, total_cents FROM documents WHERE batch_id = $1`, [b.id])).rows[0]!;
    const snap = JSON.parse(inv.snapshot) as { lines: { description: string; quantity: number; unitCents: number; amountCents: number }[] };
    expect(snap.lines).toHaveLength(2);
    expect(snap.lines[0]).toMatchObject({ quantity: 8, unitCents: 5400, amountCents: 8 * 5400 });
    expect(snap.lines[1]).toMatchObject({ description: 'Return postage allowance (standard cost, batch of 6 or more paddles)', quantity: 1, unitCents: -quote.postageCents, amountCents: -quote.postageCents });
    expect(Number(inv.total_cents)).toBe(8 * 5400 - quote.postageCents);
    expect((await findBatch(t.db, b.reference))!.invoice?.totalCents).toBe(8 * 5400 - quote.postageCents);
  });

  it('the allowance is entered when it can not be worked out, may be overridden, and is refused when silly', async () => {
    t = await makeApp();
    const c = await club(); // no venue postcode on file
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 6, notes: null, now: t.clock.now, method: 'post' });
    await expect(invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0 })).rejects.toMatchObject({ code: 'postage_needed' });
    await expect(invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0, postageAllowanceCents: 0 })).rejects.toMatchObject({ code: 'bad_postage' });
    await expect(invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0, postageAllowanceCents: 99_999 })).rejects.toMatchObject({ code: 'bad_postage' });
    expect((await findBatch(t.db, b.reference))!.status).toBe('collected'); // nothing issued
    expect((await invoiceBatch(deps(), { reference: b.reference, unchangedCount: 0, postageAllowanceCents: 1850 })).postageAllowanceCents).toBe(1850);
    expect((await findBatch(t.db, b.reference))!.invoice?.totalCents).toBe(6 * 5400 - 1850);
  });

  it('no allowance for fewer than 6 paddles, or for a pickup batch', async () => {
    t = await makeApp();
    const c = await club();
    const five = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 5, notes: null, now: t.clock.now, method: 'post' });
    const pickup = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 9, notes: null, now: t.clock.now });
    expect((await invoiceBatch(deps(), { reference: five.reference, unchangedCount: 0 })).postageAllowanceCents).toBe(0);
    expect((await invoiceBatch(deps(), { reference: pickup.reference, unchangedCount: 0 })).postageAllowanceCents).toBe(0);
    expect((await findBatch(t.db, five.reference))!.invoice?.totalCents).toBe(5 * 5400);
    expect((await findBatch(t.db, pickup.reference))!.invoice?.totalCents).toBe(9 * 5400);
  });

  it('once GST-registered the GST is on the invoice after the postage allowance', async () => {
    t = await makeApp();
    const c = await club();
    const seller = { ...DEFAULT_SELLER, abn: '51824753556', gstRegisteredFrom: '2026-01-01', payId: 'payments@picklemypaddle.com' };
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 6, notes: null, now: t.clock.now, method: 'post' });
    await invoiceBatch({ ...deps(), seller }, { reference: b.reference, unchangedCount: 0, postageAllowanceCents: 2000 });
    const d = (await t.db.query<{ total_cents: number; gst_cents: number }>(`SELECT total_cents, gst_cents FROM documents WHERE batch_id = $1`, [b.id])).rows[0]!;
    const net = 6 * 5400 - 2000; // 30400
    expect({ gst: Number(d.gst_cents), total: Number(d.total_cents) }).toEqual({ gst: 3040, total: net + 3040 });
  });

  it('the database refuses a method it does not know', async () => {
    t = await makeApp();
    const c = await club();
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 2, notes: null, now: t.clock.now });
    await expect(t.db.query(`UPDATE batches SET method = 'drone' WHERE reference = $1`, [b.reference])).rejects.toThrow();
  });
});

describe('the admin for postal batches', () => {
  it('the club page says "received", offers pickup or post and a tracking field; the batch page shows both tracking numbers and the return-postage rule', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const c = await club();
    const page = await (await admin.get(`/admin/clubs/${c.id}`)).text();
    expect(page).toContain('Record a batch received');
    expect(page).toContain('It arrived by post');
    expect(page).toContain('name="inboundTracking"');
    const res = await admin.post(`/admin/clubs/${c.id}/batches`, { collectedOn: today(), paddleCount: '7', method: 'post', inboundTracking: 'AP 55', notes: 'Two boxes' });
    expect(res.status).toBe(303);
    const ref = /\/admin\/batches\/(PMPB-[0-9A-Z]{5})/.exec(res.headers.get('location')!)![1]!;
    const bp = await (await admin.get(`/admin/batches/${ref}`)).text();
    expect(bp).toContain('Received by post');
    expect(bp).toContain('AP 55');
    expect(bp).toContain('name="postageAllowance"');
    expect(bp).toContain('7 paddles is 6 or more, so agreement 5.3 takes the standard cost');
    // No venue postcode on this club, so the standard cost can't be worked out: it is entered.
    const noQuote = await admin.post(`/admin/batches/${ref}/invoice`, { unchangedCount: '0' });
    expect(noQuote.status).toBe(400);
    expect(await noQuote.text()).toContain('no venue postcode on file');
    const inv = await admin.post(`/admin/batches/${ref}/invoice`, { unchangedCount: '0', postageAllowance: '18.50' });
    expect(inv.status).toBe(303);
    let bpage = await (await admin.get(`/admin/batches/${ref}`)).text();
    expect(bpage).toContain('Waiting for payment');
    const doc = await (await admin.get('/admin/documents/PMP-INV-0001')).text();
    expect(doc).toContain('Return postage allowance (standard cost, batch of 6 or more paddles)');
    expect(bpage).toContain(`A$${(7 * 54 - 18.5).toFixed(2).replace(/\.00$/, '')}`);
    await pay(ref, 7 * 5400 - 1850);
    bpage = await (await admin.get(`/admin/batches/${ref}`)).text();
    expect(bpage).toContain('Paid: mark returned');
    expect(bpage).toContain('name="returnTracking"');
    const ret = await admin.post(`/admin/batches/${ref}/return`, { returnedOn: today(), returnTracking: 'AP 77' });
    expect(ret.status).toBe(303);
    const done = await (await admin.get(`/admin/batches/${ref}`)).text();
    expect(done).toContain('Tracking back to the club');
    expect(done).toContain('AP 77');
  });

  it('a posted batch of fewer than 6 paddles shows that no postage is taken off the invoice', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const c = await club();
    const res = await admin.post(`/admin/clubs/${c.id}/batches`, { collectedOn: today(), paddleCount: '5', method: 'post' });
    const ref = /\/admin\/batches\/(PMPB-[0-9A-Z]{5})/.exec(res.headers.get('location')!)![1]!;
    expect(await (await admin.get(`/admin/batches/${ref}`)).text()).toContain('Fewer than 6 paddles: no postage is taken off');
  });

  it('a pickup batch has no return tracking field', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const c = await club();
    const res = await admin.post(`/admin/clubs/${c.id}/batches`, { collectedOn: today(), paddleCount: '4' });
    const ref = /\/admin\/batches\/(PMPB-[0-9A-Z]{5})/.exec(res.headers.get('location')!)![1]!;
    const bp = await (await admin.get(`/admin/batches/${ref}`)).text();
    expect(bp).toContain('Picked up');
    expect(bp).not.toContain('name="returnTracking"');
  });

  it('the meeting form takes a time and length after the date, and the lead list shows them', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const r = await t.db.query<{ id: string }>(`INSERT INTO clubs (name, status, is_test, contact_email, contact_name) VALUES ('Lead PC', 'lead', true, 'jo@test.picklemypaddle.com', 'Jo') RETURNING id`);
    const id = r.rows[0]!.id;
    expect((await admin.post(`/admin/clubs/${id}/meeting`, { meetingOn: '2026-11-14', meetingTime: '', meetingMinutes: '' })).status).toBe(303);
    expect((await admin.post(`/admin/clubs/${id}/meeting`, { meetingOn: '2026-11-14', meetingTime: '18:30', meetingMinutes: '60' })).status).toBe(303);
    expect(await (await admin.get(`/admin/clubs/${id}`)).text()).toContain('Sat 14 Nov 2026, 18:30, 60 min');
    expect(await (await admin.get('/admin/clubs')).text()).toContain('meeting Sat 14 Nov 2026, 18:30, 60 min');
    const bad = await admin.post(`/admin/clubs/${id}/meeting`, { meetingOn: '2026-11-14', meetingTime: '99:99' });
    expect(bad.status).toBe(400);
  });
});

describe('pickup or post in the admin (SCRUM-102)', () => {
  it('shows the service area’s method, lets Attila override it (recorded), and the batch form follows it', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const r = await t.db.query<{ id: string }>(
      `INSERT INTO clubs (name, status, is_test, billing_name, billing_email, billing_address, suburb, venue_postcode, fulfilment_default, area_version)
       VALUES ('Far PC', 'active', true, 'Jo', 'jo@test.picklemypaddle.com', '1 St', 'Campbelltown', '2560', 'postal', '2026-11-10') RETURNING id`,
    );
    const id = r.rows[0]!.id;
    let page = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(page).toContain('Pickup or post');
    expect(page).toContain('<strong>Post</strong> (from the service area)');
    expect(page).toContain('list 2026-11-10');
    expect(page).toMatch(/<option value="post" selected>/); // the batch form starts on post
    expect((await admin.post(`/admin/clubs/${id}/fulfilment`, { fulfilment: 'local' })).status).toBe(303);
    page = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(page).toContain('<strong>Local pickup and drop-off</strong> (your override');
    expect(page).toMatch(/<option value="pickup" selected>/);
    expect((await admin.post(`/admin/clubs/${id}/fulfilment`, { fulfilment: 'courier' })).status).toBe(400);
    expect((await admin.post(`/admin/clubs/${id}/fulfilment`, { fulfilment: '' })).status).toBe(303);
    expect(await (await admin.get(`/admin/clubs/${id}`)).text()).toContain('<strong>Post</strong> (from the service area)');
  });

  it('a suburb listed with a different postcode is flagged on the club page', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    const r = await t.db.query<{ id: string }>(
      `INSERT INTO clubs (name, status, is_test, contact_email, suburb, venue_postcode, fulfilment_default, area_version, area_review) VALUES ('Odd PC', 'lead', true, 'jo@test.picklemypaddle.com', 'Milperra', '2560', 'postal', 'v', true) RETURNING id`,
    );
    expect(await (await admin.get(`/admin/clubs/${r.rows[0]!.id}`)).text()).toContain('different postcode');
  });
});
