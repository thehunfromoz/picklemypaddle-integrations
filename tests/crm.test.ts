/**
 * HubSpot mirror (SCRUM-74): mapping, the sync worker against a fake HubSpot, and setup as code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mapOrder, splitName, STAGE_ORDER, STAGES } from '../src/crm/crm.js';
import { submitReview } from '../src/orders/reviews.js';
import { applySetup, CONTACT_PROPERTIES, DEAL_PROPERTIES, describeChange, hubspotAdapter, hubspotClient, planSetup, portalIdOf } from '../src/crm/hubspot.js';
import { processCrm, resyncAll, retryCrmJob, type CrmDeps } from '../src/crm/sync.js';
import { BACKOFF_MINUTES } from '../src/email/outbox.js';
import { STATUSES } from '../src/orders/model.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { fakeHubSpot, type FakeHubSpot } from './helpers/fake-hubspot.js';
import { DB_BACKEND } from './helpers/db.js';
import { makeApp, orderForm, post, type TestApp } from './helpers/app.js';

// Assembled at runtime so secret scanners don't take a dummy for a real key.
const KEY = ['pat', 'ap1', '0'.repeat(8), '0'.repeat(4), '0'.repeat(4), '0'.repeat(4), '0'.repeat(12)].join('-');

describe('mapping', () => {
  it('has one stage per status, with unique labels, closed-won only for Completed', () => {
    expect([...STAGE_ORDER]).toEqual([...STATUSES]);
    expect(new Set(STATUSES.map((s) => STAGES[s].label)).size).toBe(STATUSES.length);
    expect(STATUSES.filter((s) => STAGES[s].probability === 1)).toEqual(['completed']);
    expect(STATUSES.filter((s) => STAGES[s].probability === 0)).toEqual(['rejected', 'withdrawn', 'lapsed']);
  });

  it('splits names into first and last', () => {
    expect(splitName('  Sam   de la Cruz ')).toEqual({ firstName: 'Sam', lastName: 'de la Cruz' });
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('prices the deal at A$60 a paddle and marks TEST orders', () => {
    const { deal } = mapOrder({
      reference: 'PMP-7K3QX', status: 'accepted', is_test: true, name: 'Sam Lee', email: 'sam@example.org', phone: null,
      suburb: 'Newtown', state: 'NSW', postcode: '2042', paddle_count: 3, has_review: false, contact_has_review: false, crm_contact_id: null, crm_deal_id: null,
    });
    expect(deal).toEqual({ reference: 'PMP-7K3QX', name: '[TEST] PMP-7K3QX', amountCents: 18000, paddleCount: 3, isTest: true, status: 'accepted', reviewed: false });
  });

  it('carries the "reviewed" flags: the order’s own on the deal, any order’s on the contact (SCRUM-80)', () => {
    const base = {
      reference: 'PMP-7K3QX', status: 'completed', is_test: false, name: 'Sam Lee', email: 'sam@example.org', phone: null,
      suburb: 'Newtown', state: 'NSW', postcode: '2042', paddle_count: 1, crm_contact_id: null, crm_deal_id: null,
    } as const;
    const a = mapOrder({ ...base, has_review: false, contact_has_review: true });
    expect([a.deal.reviewed, a.contact.hasReviewed]).toEqual([false, true]);
    const b = mapOrder({ ...base, has_review: true, contact_has_review: true });
    expect([b.deal.reviewed, b.contact.hasReviewed]).toEqual([true, true]);
  });
});

describe(`HubSpot sync (${DB_BACKEND})`, () => {
  let t: TestApp;
  let hs: FakeHubSpot;
  afterEach(async () => t?.close());

  async function setup(portalId = '111'): Promise<CrmDeps> {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    hs = fakeHubSpot({ portalId });
    const client = hubspotClient(KEY, 'https://api.hubapi.test', hs.fetch);
    await applySetup(client, await planSetup(client));
    hs.calls.length = 0;
    return { db: t.db, adapter: hubspotAdapter(client), portalId: () => portalIdOf(client), expectedPortalId: '111', now: () => t.clock.now };
  }
  const order = async (email = 'player@test.picklemypaddle.com', paddles = 1) =>
    ((await (await post(t, await orderForm(t, { email, paddles }))).json()) as { reference: string; statusToken: string });
  const stageLabel = (dealId: string) => hs.stages.find((s) => s.id === hs.deals.get(dealId)!.properties.dealstage)!.label;
  const jobs = async () =>
    (await t.db.query<{ state: string; last_error: string | null; attempts: number }>(`SELECT state, last_error, attempts FROM outbox WHERE kind = 'crm' ORDER BY id`)).rows;

  it('a review sets the deal’s "reviewed" and the contact’s "has reviewed"; a later order keeps the contact’s (SCRUM-80)', async () => {
    const deps = await setup();
    const first = await order('reviewer@test.picklemypaddle.com');
    for (const [to, extra] of [['accepted', {}], ['paid', {}], ['in_queue', {}], ['regritted', {}], ['posted_back', { trackingNumber: 'AP1' }]] as const) {
      await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference: first.reference, to, actor: 'admin', ...extra });
    }
    const review = await submitReview(t.db, { token: first.statusToken, quote: 'Plays like new again.', firstName: 'Sam', suburb: 'Newtown', permission: true }, t.clock.now);
    expect(review.ok).toBe(true);
    await processCrm(deps);
    const contact = hs.contacts.get('reviewer@test.picklemypaddle.com')!;
    const firstDeal = [...hs.deals.values()].find((d) => d.properties.pmp_reference === first.reference)!;
    expect(firstDeal.properties.pmp_reviewed).toBe('true');
    expect(contact.properties.pmp_has_reviewed).toBe('true');

    const second = await order('reviewer@test.picklemypaddle.com');
    await processCrm(deps);
    const secondDeal = [...hs.deals.values()].find((d) => d.properties.pmp_reference === second.reference)!;
    expect(secondDeal.properties.pmp_reviewed).toBe('false');
    expect(hs.contacts.get('reviewer@test.picklemypaddle.com')!.properties.pmp_has_reviewed).toBe('true');
  });

  it('an order creates one contact and one associated deal, without the street address, token or paddle details', async () => {
    const deps = await setup();
    const { reference, statusToken } = await order('player@test.picklemypaddle.com', 2);
    expect(await processCrm(deps)).toEqual({ synced: 1, retrying: 0, failed: 0, skipped: 0 });

    expect(hs.contacts.size).toBe(1);
    const contact = hs.contacts.get('player@test.picklemypaddle.com')!;
    expect(contact.properties).toEqual({
      email: 'player@test.picklemypaddle.com', firstname: 'Test', lastname: 'Player', phone: '0412 345 678', city: 'Sydney', state: 'NSW', zip: '2000', pmp_has_reviewed: 'false',
    });
    expect(hs.deals.size).toBe(1);
    const [dealId, deal] = [...hs.deals][0]!;
    expect(deal.properties).toMatchObject({ dealname: `[TEST] ${reference}`, amount: '120.00', pipeline: 'default', pmp_reference: reference, pmp_paddle_count: '2', pmp_is_test: 'true', pmp_reviewed: 'false' });
    expect(stageLabel(dealId)).toBe('Submitted');
    expect([...deal.contacts]).toEqual([contact.id]);

    const everything = JSON.stringify(hs.calls);
    for (const never of ['1 Court St', statusToken, 'Selkirk', 'Vanguard', '.jpg', '.webp']) expect(everything).not.toContain(never);

    const { rows } = await t.db.query<{ crm_contact_id: string; crm_deal_id: string }>('SELECT crm_contact_id, crm_deal_id FROM orders');
    expect(rows[0]).toEqual({ crm_contact_id: contact.id, crm_deal_id: dealId });
  });

  it('a second order from the same email reuses the contact', async () => {
    const deps = await setup();
    await order();
    await order('PLAYER@test.picklemypaddle.com');
    await processCrm(deps);
    expect(hs.contacts.size).toBe(1);
    expect(hs.deals.size).toBe(2);
  });

  it('a status change moves the deal to the matching stage', async () => {
    const deps = await setup();
    const { reference } = await order();
    await processCrm(deps);
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to: 'accepted', actor: 'admin' });
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to: 'paid', actor: 'admin' });
    // Two changes before the worker ran: one job, carrying the latest state.
    expect((await jobs()).filter((j) => j.state === 'pending')).toHaveLength(1);
    await processCrm(deps);
    expect(hs.deals.size).toBe(1);
    expect(stageLabel([...hs.deals.keys()][0]!)).toBe('Paid');
  });

  it('retries rate limits and server errors with backoff, and never blocks the order', async () => {
    const deps = await setup();
    await order('player+first@test.picklemypaddle.com');
    await processCrm(deps); // checks the portal once
    hs.failNext.push(429);
    expect((await post(t, await orderForm(t))).status).toBe(201);
    expect(await processCrm(deps)).toMatchObject({ retrying: 1 });
    expect((await jobs())[1]).toMatchObject({ state: 'pending', last_error: 'http:429' });

    t.clock.now = new Date(t.clock.now.getTime() + BACKOFF_MINUTES[0] * 60_000);
    hs.failNext.push(503);
    expect(await processCrm(deps)).toMatchObject({ retrying: 1 });
    t.clock.now = new Date(t.clock.now.getTime() + BACKOFF_MINUTES[1] * 60_000);
    expect(await processCrm(deps)).toMatchObject({ synced: 1 });
    expect(hs.deals.size).toBe(2);
  });

  it('keeps retrying while the portal can’t be checked, and writes nothing meanwhile', async () => {
    const deps = await setup();
    hs.failNext.push(503);
    await order();
    expect(await processCrm(deps)).toMatchObject({ retrying: 1 });
    expect((await jobs())[0]).toMatchObject({ state: 'pending', last_error: 'portal_unverified' });
    expect(hs.contacts.size).toBe(0);
  });

  it('a deal deleted in HubSpot is found again or recreated, never duplicated', async () => {
    const deps = await setup();
    const { reference } = await order();
    await processCrm(deps);
    hs.deals.clear();
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to: 'accepted', actor: 'admin' });
    await processCrm(deps);
    expect(hs.deals.size).toBe(1);
    expect(stageLabel([...hs.deals.keys()][0]!)).toBe('Accepted');

    // A crash after creating the deal but before saving its ID: the next sync finds it by reference.
    await t.db.query('UPDATE orders SET crm_deal_id = NULL');
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to: 'paid', actor: 'admin' });
    await processCrm(deps);
    expect(hs.deals.size).toBe(1);
  });

  it('writes nothing if the key belongs to another portal', async () => {
    const deps = await setup('999');
    await order();
    expect(await processCrm(deps)).toMatchObject({ failed: 1 });
    expect((await jobs())[0]).toMatchObject({ state: 'failed', last_error: 'portal_mismatch' });
    expect(hs.contacts.size + hs.deals.size).toBe(0);
    expect(hs.calls.map((c) => c.path)).toEqual(['/account-info/v3/details']);
  });

  it('fails at once if the setup script hasn’t been run, and the admin retry puts it back', async () => {
    const deps = await setup();
    hs.stages = hs.stages.filter((s) => s.label !== 'Submitted');
    await order();
    expect(await processCrm(deps)).toMatchObject({ failed: 1 });
    const [job] = (await t.db.query<{ id: string; last_error: string }>(`SELECT id, last_error FROM outbox WHERE kind = 'crm'`)).rows;
    expect(job!.last_error).toBe('stage_missing');
    expect(await retryCrmJob(t.db, job!.id, t.clock.now)).toBe(true);
    expect((await jobs())[0]!.state).toBe('pending');
  });

  it('skips smoke-test orders, and marks jobs skipped when HubSpot isn’t configured', async () => {
    const deps = await setup();
    await order('smoke+r1@example.com');
    expect(await jobs()).toEqual([]);
    await order();
    expect(await processCrm({ ...deps, adapter: null })).toMatchObject({ skipped: 1 });
    expect((await jobs())[0]).toMatchObject({ state: 'suppressed', last_error: 'no_crm' });
  });

  it('resync queues every real order once', async () => {
    const deps = await setup();
    await order();
    await order('player+2@test.picklemypaddle.com');
    await order('smoke+r2@example.com');
    await processCrm(deps);
    expect(await resyncAll(t.db, t.clock.now)).toBe(2);
    expect(await resyncAll(t.db, t.clock.now)).toBe(2);
    expect((await jobs()).filter((j) => j.state === 'pending')).toHaveLength(2);
    expect(await processCrm(deps)).toMatchObject({ synced: 2 });
    expect(hs.deals.size).toBe(2);
  });
});

describe('HubSpot network errors', () => {
  it('names the reason a request got no answer, not just "TypeError"', async () => {
    const failing = (cause: unknown) => (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }) as unknown as typeof fetch;
    const client = (f: typeof fetch) => hubspotClient(KEY, 'https://api.hubapi.test', f);
    await expect(client(failing({ code: 'ENOTFOUND' })).request('GET', '/x')).rejects.toMatchObject({ code: 'network:ENOTFOUND', permanent: false });
    await expect(client(failing({ code: 'UND_ERR_CONNECT_TIMEOUT' })).request('GET', '/x')).rejects.toMatchObject({ code: 'network:UND_ERR_CONNECT_TIMEOUT' });
    await expect(client(failing(undefined)).request('GET', '/x')).rejects.toMatchObject({ code: 'network:TypeError' });
    const timeout = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    await expect(client(timeout).request('GET', '/x')).rejects.toMatchObject({ code: 'network:timeout' });
  });
});

describe('HubSpot setup as code', () => {
  const client = (hs: FakeHubSpot) => hubspotClient(KEY, 'https://api.hubapi.test', hs.fetch);

  it('plans the group, properties and every stage on a new portal, then has nothing left to do', async () => {
    const hs = fakeHubSpot();
    const c = client(hs);
    const plan = await planSetup(c);
    expect(plan.changes.map((x) => x.kind)).toEqual([
      'create_group', ...DEAL_PROPERTIES.map(() => 'create_property'),
      'create_group', ...CONTACT_PROPERTIES.map(() => 'create_property'),
      ...STATUSES.map(() => 'create_stage'),
    ]);
    // SCRUM-80: the "reviewed" flags, on the deal and on the contact.
    expect(plan.changes.filter((x) => x.kind === 'create_property').map((x) => `${(x as { object: string }).object}.${(x as { property: { name: string } }).property.name}`))
      .toEqual(expect.arrayContaining(['deals.pmp_reviewed', 'contacts.pmp_has_reviewed']));
    expect(plan.changes.map(describeChange)).toContain('create contact property pmp_has_reviewed ("Has reviewed", bool)');
    expect(plan.unusedStages).toContain('Appointment scheduled');
    const before = hs.calls.filter((x) => x.method !== 'GET').length;
    expect(before).toBe(0); // planning (the dry run) changes nothing

    await applySetup(c, plan);
    expect((await planSetup(c)).changes).toEqual([]);
    const submitted = hs.stages.find((s) => s.label === 'Submitted')!;
    expect(submitted.metadata.probability).toBe('0.1');
  });

  it('accepts HubSpot numbering our stages after its own, as long as the order is right', async () => {
    const hs = fakeHubSpot();
    const c = client(hs);
    await applySetup(c, await planSetup(c));
    // What the real test portal did on 29 Oct: ours at 1..11 (a default stage kept position 0).
    const ours = STATUSES.map((st) => hs.stages.find((s) => s.label === STAGES[st].label)!);
    ours.forEach((s, i) => (s.displayOrder = i + 1));
    expect((await planSetup(c)).changes).toEqual([]);

    // Out of order is still corrected.
    [ours[0]!.displayOrder, ours[1]!.displayOrder] = [ours[1]!.displayOrder, ours[0]!.displayOrder];
    expect((await planSetup(c)).changes.map((x) => x.kind)).toContain('update_stage');
  });

  it('corrects a stage someone edited by hand', async () => {
    const hs = fakeHubSpot();
    const c = client(hs);
    await applySetup(c, await planSetup(c));
    hs.stages.find((s) => s.label === 'Completed')!.metadata.probability = '0.5';
    const plan = await planSetup(c);
    expect(plan.changes).toEqual([expect.objectContaining({ kind: 'update_stage', status: 'completed', differences: ['probability 0.5 → 1'] })]);
    await applySetup(c, plan);
    expect((await planSetup(c)).changes).toEqual([]);
  });
});
