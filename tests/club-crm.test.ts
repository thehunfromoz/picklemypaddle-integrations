/**
 * Clubs in HubSpot (SCRUM-85 AC8): a club is a company with its billing contact, each batch a deal
 * in the "Club batch:" stages, linked to both. One CRM job per club syncs all of it, and it
 * recovers when HubSpot loses a record or a sync crashes before saving the IDs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cancelBatch, createBatch, createClub, returnBatch, updateClub, type ClubInput } from '../src/clubs/clubs.js';
import { recordClubPayment } from '../src/clubs/payments.js';
import { CLUB_STAGES } from '../src/crm/crm.js';
import { applySetup, hubspotAdapter, hubspotClient, planSetup, portalIdOf } from '../src/crm/hubspot.js';
import { processCrm, resyncAll, retryCrmJob, type CrmDeps } from '../src/crm/sync.js';
import { DEFAULT_SELLER } from '../src/documents/documents.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, type TestApp } from './helpers/app.js';
import { DB_BACKEND } from './helpers/db.js';
import { fakeHubSpot, type FakeHubSpot } from './helpers/fake-hubspot.js';

// Assembled at runtime so secret scanners don't take a dummy for a real key.
const KEY = ['pat', 'ap1', '0'.repeat(8), '0'.repeat(4), '0'.repeat(4), '0'.repeat(4), '0'.repeat(12)].join('-');
const seller = { ...DEFAULT_SELLER, payId: 'payments@picklemypaddle.com' };
const CLUB: ClubInput = { name: 'Inner West PC', billingName: 'Jo Treasurer', billingEmail: 'Jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null };

let t: TestApp;
let hs: FakeHubSpot;
let deps: CrmDeps;
afterEach(async () => t?.close());

async function setup(): Promise<void> {
  t = await makeApp({ env: { APP_ENV: 'staging' } });
  t.clock.now = new Date('2026-11-04T01:00:00Z');
  hs = fakeHubSpot();
  const client = hubspotClient(KEY, 'https://api.hubapi.test', hs.fetch);
  await applySetup(client, await planSetup(client));
  hs.calls.length = 0;
  deps = { db: t.db, adapter: hubspotAdapter(client), portalId: () => portalIdOf(client), expectedPortalId: '111', now: () => t.clock.now };
}
const jobs = async () => (await t.db.query<{ id: string; state: string; last_error: string | null }>("SELECT id, state, last_error FROM outbox WHERE kind = 'crm' AND club_id IS NOT NULL ORDER BY id")).rows;
const stageLabel = (id: string) => hs.stages.find((s) => s.id === id)?.label;
const clubRow = async (id: string) => (await t.db.query<{ crm_company_id: string | null; crm_contact_id: string | null }>('SELECT crm_company_id, crm_contact_id FROM clubs WHERE id = $1', [id])).rows[0]!;
const writes = () => hs.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/search'));

describe(`Clubs in HubSpot (${DB_BACKEND})`, () => {
  it('creates the company and contact, then a deal per batch that follows it from collected to paid', async () => {
    await setup();
    const club = await createClub(t.db, CLUB, { isProduction: false, now: t.clock.now });
    expect(await jobs()).toMatchObject([{ state: 'pending' }]);
    expect(await processCrm(deps)).toMatchObject({ synced: 1 });

    const [companyId, company] = [...hs.companies][0]!;
    expect(company.properties).toEqual({ name: '[TEST] Inner West PC', pmp_club_id: club.id, pmp_is_test: 'true' });
    const contact = hs.contacts.get('jo@test.picklemypaddle.com')!;
    expect(contact.properties).toEqual({ email: 'jo@test.picklemypaddle.com', firstname: 'Jo', lastname: 'Treasurer' });
    expect([...company.contacts]).toEqual([contact.id]);
    expect(await clubRow(club.id)).toEqual({ crm_company_id: companyId, crm_contact_id: contact.id });

    // Collected: estimated at A$54 a paddle.
    const batch = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 5, notes: null, now: t.clock.now });
    await processCrm(deps);
    const [dealId, deal] = [...hs.deals][0]!;
    expect(deal.properties).toMatchObject({ dealname: `[TEST] ${batch.reference} (Inner West PC)`, amount: '270.00', pmp_reference: batch.reference, pmp_paddle_count: '5', pmp_is_test: 'true' });
    expect(stageLabel(deal.properties.dealstage!)).toBe(CLUB_STAGES.collected.label);
    expect([...deal.companies, ...deal.contacts]).toEqual([companyId, contact.id]);

    // Returned with one unchanged → invoiced at the invoice's total (4 × A$54).
    await returnBatch({ db: t.db, seller, isProduction: false, paymentTermsDays: 14, now: t.clock.now }, { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 1 });
    await processCrm(deps);
    expect(stageLabel(hs.deals.get(dealId)!.properties.dealstage!)).toBe(CLUB_STAGES.invoiced.label);
    expect(hs.deals.get(dealId)!.properties.amount).toBe('216.00');

    // Paid. Several changes before the worker runs make one job, not several.
    await recordClubPayment(t.db, { batchReference: batch.reference, method: 'payid', amountCents: 10000, paidOn: '2026-11-04', reference: null, by: 'a', now: t.clock.now });
    await recordClubPayment(t.db, { batchReference: batch.reference, method: 'cash', amountCents: 11600, paidOn: '2026-11-04', reference: null, by: 'a', now: t.clock.now });
    expect((await jobs()).filter((j) => j.state === 'pending')).toHaveLength(1);
    hs.calls.length = 0;
    await processCrm(deps);
    expect(stageLabel(hs.deals.get(dealId)!.properties.dealstage!)).toBe(CLUB_STAGES.paid.label);
    expect(hs.deals.size).toBe(1);
    expect(hs.companies.size).toBe(1);
    // Nothing new: updates only, no new links.
    expect(writes().filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('prices a cancelled batch at nothing and keeps a second batch separate', async () => {
    await setup();
    const club = await createClub(t.db, CLUB, { isProduction: false, now: t.clock.now });
    const a = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 3, notes: null, now: t.clock.now });
    await processCrm(deps);
    const b = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-03', paddleCount: 2, notes: null, now: t.clock.now });
    await cancelBatch(t.db, a.reference, t.clock.now);
    await processCrm(deps);
    const byRef = (r: string) => [...hs.deals.values()].find((d) => d.properties.pmp_reference === r)!;
    expect(byRef(a.reference).properties).toMatchObject({ amount: '0.00' });
    expect(stageLabel(byRef(a.reference).properties.dealstage!)).toBe(CLUB_STAGES.cancelled.label);
    expect(byRef(b.reference).properties).toMatchObject({ amount: '108.00' });
    expect(hs.deals.size).toBe(2);
  });

  it('links a new billing contact to the company and its deals when the treasurer changes', async () => {
    await setup();
    const club = await createClub(t.db, CLUB, { isProduction: false, now: t.clock.now });
    await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 3, notes: null, now: t.clock.now });
    await processCrm(deps);
    await updateClub(t.db, club.id, { ...CLUB, billingName: 'Sam New', billingEmail: 'sam@test.picklemypaddle.com' }, t.clock.now);
    await processCrm(deps);
    const sam = hs.contacts.get('sam@test.picklemypaddle.com')!;
    expect([...hs.companies.values()][0]!.contacts).toContain(sam.id);
    expect([...hs.deals.values()][0]!.contacts).toContain(sam.id);
    expect((await clubRow(club.id)).crm_contact_id).toBe(sam.id);
  });

  it('finds its records again after a crash before the IDs were saved, and recreates ones deleted in HubSpot', async () => {
    await setup();
    const club = await createClub(t.db, CLUB, { isProduction: false, now: t.clock.now });
    const batch = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: 3, notes: null, now: t.clock.now });
    await processCrm(deps);

    // As if the sync had crashed before saving: found by pmp_club_id / pmp_reference, not duplicated.
    await t.db.query('UPDATE clubs SET crm_company_id = NULL, crm_contact_id = NULL');
    await t.db.query('UPDATE batches SET crm_deal_id = NULL');
    expect(await resyncAll(t.db, t.clock.now)).toBe(1);
    await processCrm(deps);
    expect([hs.companies.size, hs.deals.size]).toEqual([1, 1]);
    expect((await clubRow(club.id)).crm_company_id).toBe([...hs.companies.keys()][0]);

    // Deleted in HubSpot: recreated, and the new deal linked to the new company.
    hs.companies.clear();
    hs.deals.clear();
    await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-03', paddleCount: 1, notes: null, now: t.clock.now });
    await processCrm(deps);
    expect([hs.companies.size, hs.deals.size]).toEqual([1, 2]);
    const companyId = [...hs.companies.keys()][0]!;
    for (const d of hs.deals.values()) expect([...d.companies]).toEqual([companyId]);
    expect([...hs.deals.values()].map((d) => d.properties.pmp_reference)).toContain(batch.reference);
  });

  it('retries a failed sync from the club’s admin page', async () => {
    await setup();
    const club = await createClub(t.db, CLUB, { isProduction: false, now: t.clock.now });
    hs.failNext = [0, 400]; // the portal check passes; then a permanent refusal
    await processCrm(deps);
    expect(await jobs()).toMatchObject([{ state: 'failed' }]);
    expect(hs.companies.size).toBe(0);

    const admin = await makeAdmin(t);
    const page = await (await admin.get(`/admin/clubs/${club.id}`)).text();
    expect(page).toMatch(/HubSpot: <strong>Failed<\/strong>/);
    const res = await admin.post(`/admin/outbox/${(await jobs())[0]!.id}/retry`, {});
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/clubs/${club.id}?done=retry`);
    expect(await retryCrmJob(t.db, (await jobs())[0]!.id, t.clock.now)).toBe(false); // already queued again
    await processCrm(deps);
    expect(hs.companies.size).toBe(1);
    expect(await (await admin.get(`/admin/clubs/${club.id}`)).text()).toMatch(/HubSpot: <strong>Up to date<\/strong>/);
  });

  it('syncs two clubs in the same pass, each to its own company', async () => {
    await setup();
    const a = await createClub(t.db, CLUB, { isProduction: false, now: t.clock.now });
    const b = await createClub(t.db, { ...CLUB, name: 'Harbour PC', billingEmail: 'h@test.picklemypaddle.com' }, { isProduction: false, now: t.clock.now });
    expect(await processCrm(deps)).toMatchObject({ synced: 2 });
    expect(new Set([(await clubRow(a.id)).crm_company_id, (await clubRow(b.id)).crm_company_id]).size).toBe(2);
  });
});
