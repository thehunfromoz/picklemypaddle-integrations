/**
 * Clubs that post their paddles (SCRUM-94/96 UAT, 10 Nov 2026): a batch can be received by post
 * instead of picked up, with one tracking number to us and one back, and a note.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cancelBatch, ClubError, cleanTracking, createBatch, createClub, findBatch, returnBatch } from '../src/clubs/clubs.js';
import { DEFAULT_SELLER } from '../src/documents/documents.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => t?.close());

const club = () =>
  createClub(t.db, { name: 'Far Away PC', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
const deps = () => ({ db: t.db, seller: DEFAULT_SELLER, isProduction: false, paymentTermsDays: 14, now: t.clock.now });
const today = () => t.clock.now.toISOString().slice(0, 10);

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

  it('records the return tracking number when the batch goes back, and invoices as for a pickup', async () => {
    t = await makeApp();
    const c = await club();
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 6, notes: null, now: t.clock.now, method: 'post' });
    await returnBatch(deps(), { reference: b.reference, returnedOn: today(), unchangedCount: 0, returnTracking: 'AP 999' });
    const after = (await findBatch(t.db, b.reference))!;
    expect(after).toMatchObject({ status: 'invoiced', returnTracking: 'AP 999', inboundTracking: null });
    expect(after.invoice?.totalCents).toBe(6 * 5400);
  });

  it('a return tracking number on a pickup batch is refused, and nothing is invoiced', async () => {
    t = await makeApp();
    const c = await club();
    const b = await createBatch(t.db, { clubId: c.id, collectedOn: today(), paddleCount: 2, notes: null, now: t.clock.now });
    await expect(returnBatch(deps(), { reference: b.reference, returnedOn: today(), unchangedCount: 0, returnTracking: 'X1' })).rejects.toMatchObject({ code: 'bad_tracking' });
    expect((await findBatch(t.db, b.reference))!.status).toBe('collected');
    await cancelBatch(t.db, b.reference, t.clock.now);
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
    expect(bp).toContain('name="returnTracking"');
    expect(bp).toContain('7 paddles is 6 or more: agreement 5.3 takes the standard postage cost off');
    const ret = await admin.post(`/admin/batches/${ref}/return`, { returnedOn: today(), unchangedCount: '0', returnTracking: 'AP 77' });
    expect(ret.status).toBe(303);
    const done = await (await admin.get(`/admin/batches/${ref}`)).text();
    expect(done).toContain('Tracking back to the club');
    expect(done).toContain('AP 77');
  });

  it('a posted batch of fewer than 6 paddles shows that return postage is not automatic', async () => {
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
