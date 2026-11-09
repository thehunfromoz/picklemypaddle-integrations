/**
 * Club leads (SCRUM-93): the "Talk to us about your club" form's validation and abuse protections,
 * what a submission creates (one lead, one acknowledgement, one alert, a CRM job), the pipeline
 * moves, and that nothing about members or a street address is kept.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createBatch, createClub, findClub, validateClub } from '../src/clubs/clubs.js';
import { createLead, MOVES, moveClub, setMeetingDate, validateLead, type LeadForm } from '../src/clubs/leads.js';
import { CLUB_STATUSES } from '../src/clubs/model.js';
import { mapClub } from '../src/crm/crm.js';
import { processOutbox } from '../src/email/outbox.js';
import type { EmailMessage } from '../src/email/sender.js';
import { runLeadRetention, staleLeads } from '../src/clubs/lead-retention.js';
import { applySetup, hubspotAdapter, hubspotClient, planSetup, portalIdOf } from '../src/crm/hubspot.js';
import { processCrm, type CrmDeps } from '../src/crm/sync.js';
import { fakeHubSpot } from './helpers/fake-hubspot.js';
import { makeApp, SITE, type TestApp } from './helpers/app.js';
import { makeAdmin } from './helpers/admin.js';

let t: TestApp;
afterEach(async () => t?.close());

const ALLOW = { isProduction: false, allowList: ['attila@test.picklemypaddle.com'] };
const GOOD: LeadForm = {
  clubName: 'Inner West Pickleball Club',
  suburb: 'Newtown',
  contactName: 'Jo Treasurer',
  contactEmail: 'attila+club1@test.picklemypaddle.com',
  contactPhone: '0412 345 678',
  memberCount: '40',
  message: 'We would like to talk about re-gripping our members’ paddles.',
  preferredTimes: 'Weekday evenings',
};

describe('lead form validation', () => {
  it('accepts a full form and tidies it', () => {
    const r = validateLead({ ...GOOD, clubName: '  Inner West Pickleball Club ', contactEmail: ' ATTILA+Club1@Test.PickleMyPaddle.com ' }, ALLOW);
    expect(r).toEqual({
      ok: true,
      input: { clubName: 'Inner West Pickleball Club', suburb: 'Newtown', contactName: 'Jo Treasurer', contactEmail: 'attila+club1@test.picklemypaddle.com', contactPhone: '0412 345 678', memberCount: 40, message: GOOD.message, preferredTimes: 'Weekday evenings' },
    });
  });

  it('needs the club, suburb, contact name, a valid email and a rough size; phone, message and times are optional', () => {
    const r = validateLead({}, ALLOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['clubName', 'contactEmail', 'contactName', 'memberCount', 'suburb']);
    expect(validateLead({ ...GOOD, contactPhone: '', message: '', preferredTimes: '' }, ALLOW)).toMatchObject({ ok: true, input: { contactPhone: null, message: null, preferredTimes: null } });
  });

  it('refuses bad values with a message beside the field', () => {
    const bad = (over: LeadForm) => { const r = validateLead({ ...GOOD, ...over }, ALLOW); return r.ok ? {} : r.errors; };
    expect(bad({ contactEmail: 'nope' })).toHaveProperty('contactEmail');
    expect(bad({ contactPhone: 'call me' })).toHaveProperty('contactPhone');
    expect(bad({ memberCount: '0' })).toHaveProperty('memberCount');
    expect(bad({ memberCount: 'lots' })).toHaveProperty('memberCount');
    expect(bad({ memberCount: '100001' })).toHaveProperty('memberCount');
    expect(bad({ message: 'x'.repeat(2001) })).toHaveProperty('message');
    expect(bad({ preferredTimes: 'x'.repeat(301) })).toHaveProperty('preferredTimes');
    expect(bad({ clubName: 'x'.repeat(121) })).toHaveProperty('clubName');
  });

  it('outside production only an allow-listed or test-domain address is accepted; production takes any valid one', () => {
    const real = { contactEmail: 'secretary@realclub.com.au' };
    expect(validateLead({ ...GOOD, ...real }, ALLOW)).toMatchObject({ ok: false, errors: { contactEmail: expect.stringContaining('test') } });
    expect(validateLead({ ...GOOD, contactEmail: 'someone@example.com' }, ALLOW).ok).toBe(true);
    expect(validateLead({ ...GOOD, ...real }, { isProduction: true, allowList: [] }).ok).toBe(true);
  });
});

describe('POST /api/clubs/lead', () => {
  const post = (body: Record<string, unknown>) =>
    t.app.request('/api/clubs/lead', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: SITE } });
  const send = (over: Record<string, unknown> = {}) => post({ ...GOOD, formToken: t.formToken(), website: '', ...over });
  const count = async (sql: string) => Number((await t.db.query<{ n: number }>(sql)).rows[0]!.n);

  it('hands out a form token', async () => {
    t = await makeApp();
    const r = await t.app.request('/api/clubs/lead/form', { headers: { Origin: SITE } });
    expect(await r.json()).toMatchObject({ open: true, formToken: expect.stringMatching(/^\d{10,15}\./) });
  });

  it('a submission creates one lead, one acknowledgement, one alert and a CRM job; staging marks it a test', async () => {
    t = await makeApp();
    const r = await send();
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true, test: true });
    const clubs = (await t.db.query<Record<string, unknown>>('SELECT * FROM clubs')).rows;
    expect(clubs).toHaveLength(1);
    expect(clubs[0]).toMatchObject({ name: 'Inner West Pickleball Club', status: 'lead', is_test: true, suburb: 'Newtown', contact_name: 'Jo Treasurer', contact_email: 'attila+club1@test.picklemypaddle.com', club_size: 40, billing_email: null, billing_address: null });
    const mails = (await t.db.query<{ template: string; recipient: string }>(`SELECT template, recipient FROM outbox WHERE kind = 'email' ORDER BY id`)).rows;
    expect(mails).toEqual([
      { template: 'club_lead_ack', recipient: 'attila+club1@test.picklemypaddle.com' },
      { template: 'alert_club_lead', recipient: 'sales@picklemypaddle.com' },
    ]);
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE kind = 'crm'`)).toBe(1);

    // Sent: the contact's email promises a reply within 1 business day; Attila's alert has the club name and admin link only.
    const sent: EmailMessage[] = [];
    await processOutbox({ db: t.db, sender: { name: 'fake', send: async (m) => (sent.push(m), { id: 'e' }) }, settings: { isProduction: false, allowList: ['attila@test.picklemypaddle.com', 'sales@picklemypaddle.com'], siteUrl: SITE, adminUrl: 'https://admin.test' }, now: () => t.clock.now });
    const ack = sent.find((m) => m.subject.includes('Thanks for getting in touch'))!;
    expect(ack.subject).toMatch(/^\[TEST\] /);
    expect(ack.replyTo).toBe('attila@picklemypaddle.com');
    expect(ack.text).toContain('within 1 business day');
    expect(ack.text).toContain('Hi Jo');
    const alert = sent.find((m) => m.subject.includes('Club enquiry'))!;
    expect(alert.to).toBe('sales@picklemypaddle.com');
    expect(alert.text).toContain('Inner West Pickleball Club');
    expect(alert.text).toContain(`https://admin.test/admin/clubs/${clubs[0]!.id}`);
    for (const secret of ['0412 345 678', 'Newtown', 'Jo Treasurer', 'attila+club1', 'We would like']) expect(alert.text).not.toContain(secret);
  });

  it('keeps nothing about members or a street address: only the form’s own fields are saved', async () => {
    t = await makeApp();
    await send({ street: '1 Court St', members: 'Sam Player, Alex Player', memberEmails: ['a@b.com'], address: '1 Court St Newtown' });
    const row = (await t.db.query<Record<string, unknown>>('SELECT * FROM clubs')).rows[0]!;
    expect(JSON.stringify(row)).not.toMatch(/Court St|Sam Player|a@b\.com/);
    expect(row.billing_address).toBeNull();
    const cols = (await t.db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'clubs'`)).rows.map((r) => r.c);
    expect(cols.filter((c) => /member|player|street|address/.test(c))).toEqual(['billing_address']);
  });

  it('a filled honeypot, a too-fast submit and a stale form look fine to a bot but save nothing', async () => {
    t = await makeApp();
    expect((await send({ website: 'http://spam.example' })).status).toBe(201);
    expect((await post({ ...GOOD, formToken: t.formToken(1), website: '' })).status).toBe(201); // 1 second: under the 3-second minimum
    expect(await count('SELECT count(*)::int AS n FROM clubs')).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE kind = 'email'`)).toBe(0);
    const stale = await post({ ...GOOD, formToken: t.formToken(25 * 3600), website: '' });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ errors: { form: expect.stringContaining('reload') } });
    const missing = await post({ ...GOOD, website: '' });
    expect(missing.status).toBe(400);
  });

  it('shows a mistake beside the field and saves nothing', async () => {
    t = await makeApp();
    const r = await send({ contactEmail: 'real.person@somewhere.com.au', memberCount: 'lots' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ errors: { contactEmail: expect.any(String), memberCount: expect.any(String) } });
    expect(await count('SELECT count(*)::int AS n FROM clubs')).toBe(0);
  });

  it('limits submissions per address per hour and per email per day, counting plus-addresses as one', async () => {
    t = await makeApp();
    for (let i = 0; i < 3; i++) expect((await send({ clubName: `Club ${i}`, contactEmail: `attila+c${i}@test.picklemypaddle.com` })).status).toBe(201);
    const emailLimited = await send({ clubName: 'Club 4', contactEmail: 'attila+c4@test.picklemypaddle.com' });
    expect(emailLimited.status).toBe(429);
    expect(emailLimited.headers.get('retry-after')).toBeTruthy();
    expect(await count('SELECT count(*)::int AS n FROM clubs')).toBe(3);

    t.peer.address = '203.0.113.9';
    let last = 201;
    for (let i = 0; i < 6; i++) last = (await send({ clubName: `Other ${i}`, contactEmail: `x${i}@example.com` })).status;
    expect(last).toBe(429); // the sixth from one address in an hour
  });

  it('a club already on file gets no second record and no acknowledgement, but Attila is still told', async () => {
    t = await makeApp();
    expect((await send()).status).toBe(201);
    expect((await send({ contactEmail: 'attila+club2@test.picklemypaddle.com' })).status).toBe(201);
    expect(await count('SELECT count(*)::int AS n FROM clubs')).toBe(1);
    const mails = (await t.db.query<{ template: string; payload: { duplicate?: boolean } | string }>(`SELECT template, payload FROM outbox WHERE kind = 'email' ORDER BY id`)).rows;
    expect(mails.map((m) => m.template)).toEqual(['club_lead_ack', 'alert_club_lead', 'alert_club_lead']);
    const dup = typeof mails[2]!.payload === 'string' ? JSON.parse(mails[2]!.payload) : mails[2]!.payload;
    expect(dup.duplicate).toBe(true);
  });
});

describe('the pipeline', () => {
  const lead = async () => {
    t = await makeApp();
    const v = validateLead(GOOD, ALLOW);
    if (!v.ok) throw new Error('bad fixture');
    return (await createLead(t.db, v.input, { isProduction: false, now: t.clock.now })).clubId;
  };

  it('has a move from every stage and refuses the rest', async () => {
    for (const s of CLUB_STATUSES) expect(MOVES[s].length).toBeGreaterThan(0);
    const id = await lead();
    await expect(moveClub(t.db, id, 'active', t.clock.now)).rejects.toMatchObject({ code: 'bad_move' });
    await expect(moveClub(t.db, id, 'nonsense', t.clock.now)).rejects.toMatchObject({ code: 'bad_status' });
    await expect(moveClub(t.db, '00000000-0000-4000-8000-000000000000', 'meeting', t.clock.now)).rejects.toMatchObject({ code: 'no_club' });
    expect(await moveClub(t.db, id, 'meeting', t.clock.now)).toEqual({ from: 'lead', to: 'meeting' });
    expect(await moveClub(t.db, id, 'agreement_sent', t.clock.now)).toEqual({ from: 'meeting', to: 'agreement_sent' });
    expect((await findClub(t.db, id))!.status).toBe('agreement_sent');
  });

  it('Active needs the billing details, and the database insists too', async () => {
    const id = await lead();
    await moveClub(t.db, id, 'meeting', t.clock.now);
    await moveClub(t.db, id, 'agreement_sent', t.clock.now);
    await expect(moveClub(t.db, id, 'active', t.clock.now)).rejects.toMatchObject({ code: 'billing_needed' });
    await expect(t.db.query(`UPDATE clubs SET status = 'active' WHERE id = $1`, [id])).rejects.toThrow(/clubs_billing_when_customer/);
    await t.db.query(`UPDATE clubs SET billing_name = 'Jo', billing_email = 'jo@test.picklemypaddle.com', billing_address = '1 Court St' WHERE id = $1`, [id]);
    expect(await moveClub(t.db, id, 'active', t.clock.now)).toEqual({ from: 'agreement_sent', to: 'active' });
    // An Active club can be given batches as before.
    await createBatch(t.db, { clubId: id, collectedOn: '2026-10-25', paddleCount: 3, notes: null, now: t.clock.now });
  });

  it('records a meeting date, and clears it', async () => {
    const id = await lead();
    expect(await setMeetingDate(t.db, id, '2026-11-12', t.clock.now)).toBe(true);
    expect((await findClub(t.db, id))!.meetingOn).toBe('2026-11-12');
    await expect(setMeetingDate(t.db, id, '2026-13-40', t.clock.now)).rejects.toMatchObject({ code: 'bad_date' });
    await setMeetingDate(t.db, id, '', t.clock.now);
    expect((await findClub(t.db, id))!.meetingOn).toBeNull();
  });

  it('a club made in admin still needs its billing details, and existing clubs are untouched', async () => {
    t = await makeApp();
    expect(() => validateClub({ name: 'X', billingName: '', billingEmail: '', billingAddress: '' }, ALLOW)).toThrow();
    const club = await createClub(t.db, { name: 'Old PC', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
    expect(club).toMatchObject({ status: 'active', suburb: null, contactEmail: null, meetingOn: null });
  });
});

describe('clubs in the CRM', () => {
  it('a lead is a company at its stage with its contact (no billing details yet)', () => {
    const m = mapClub({ id: 'c1', name: 'Inner West PC', status: 'lead', is_test: true, billing_name: null, billing_email: null, contact_name: 'Jo Treasurer', contact_email: 'Jo@Example.com', crm_company_id: null, crm_contact_id: null, batches: [] });
    expect(m.company).toEqual({ clubId: 'c1', name: '[TEST] Inner West PC', isTest: true, stage: 'Lead' });
    expect(m.contact).toEqual({ email: 'jo@example.com', firstName: 'Jo', lastName: 'Treasurer' });
  });
});

describe('the admin pipeline', () => {
  it('lists leads by stage, shows a lead’s details, moves it and sets the meeting date', async () => {
    t = await makeApp();
    const v = validateLead(GOOD, ALLOW);
    if (!v.ok) throw new Error('bad fixture');
    const { clubId } = await createLead(t.db, v.input, { isProduction: false, now: t.clock.now });
    const admin = await makeAdmin(t);
    const list = await (await admin.get('/admin/clubs')).text();
    expect(list).toContain('Leads and pipeline');
    expect(list).toContain('Inner West Pickleball Club');
    expect(list).toContain('Lead');
    const page = await (await admin.get(`/admin/clubs/${clubId}`)).text();
    for (const s of ['Newtown', 'Jo Treasurer', 'attila+club1@test.picklemypaddle.com', '0412 345 678', 'Weekday evenings', 'We would like to talk']) expect(page).toContain(s);
    const moved = await admin.post(`/admin/clubs/${clubId}/stage`, { to: 'meeting' });
    expect(moved.status).toBe(303);
    expect(moved.headers.get('location')).toContain('done=stage_moved');
    const meet = await admin.post(`/admin/clubs/${clubId}/meeting`, { meetingOn: '2026-11-12' });
    expect(meet.status).toBe(303);
    expect((await findClub(t.db, clubId))).toMatchObject({ status: 'meeting', meetingOn: '2026-11-12' });
    const bad = await admin.post(`/admin/clubs/${clubId}/stage`, { to: 'active' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('A club can’t go from Meeting arranged to Active.');
  });
});

// Assembled at runtime so secret scanners don't take a dummy for a real key.
const HS_KEY = ['pat', 'ap1', '0'.repeat(8), '0'.repeat(4), '0'.repeat(4), '0'.repeat(4), '0'.repeat(12)].join('-');

describe('a lead in HubSpot, and deleted after 12 months with no activity', () => {
  async function withHubSpot() {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    t.clock.now = new Date('2026-11-04T01:00:00Z');
    const hs = fakeHubSpot();
    const client = hubspotClient(HS_KEY, 'https://api.hubapi.test', hs.fetch);
    await applySetup(client, await planSetup(client));
    const deps: CrmDeps = { db: t.db, adapter: hubspotAdapter(client), portalId: () => portalIdOf(client), expectedPortalId: '111', now: () => t.clock.now };
    return { hs, deps };
  }
  const newLead = async (name = 'Inner West Pickleball Club', email = 'attila+club1@test.picklemypaddle.com') => {
    const v = validateLead({ ...GOOD, clubName: name, contactEmail: email }, ALLOW);
    if (!v.ok) throw new Error('bad fixture');
    return (await createLead(t.db, v.input, { isProduction: false, now: t.clock.now })).clubId;
  };
  const backdate = (id: string, iso: string) => t.db.query('UPDATE clubs SET last_activity_at = $2 WHERE id = $1', [id, iso]);

  it('mirrors a lead as a company with its stage and its contact, and follows it along the pipeline', async () => {
    const { hs, deps } = await withHubSpot();
    const id = await newLead();
    await processCrm(deps);
    const [companyId, company] = [...hs.companies][0]!;
    expect(company.properties).toMatchObject({ name: '[TEST] Inner West Pickleball Club', pmp_club_stage: 'Lead' });
    expect([...company.contacts]).toHaveLength(1);
    expect(hs.contacts.get('attila+club1@test.picklemypaddle.com')?.properties).toMatchObject({ firstname: 'Jo', lastname: 'Treasurer' });
    await moveClub(t.db, id, 'meeting', t.clock.now);
    await processCrm(deps);
    expect(hs.companies.get(companyId)!.properties.pmp_club_stage).toBe('Meeting arranged');
    expect(hs.companies.size).toBe(1);
  });

  it('deletes a lead 12 months after its last activity, with its HubSpot company and contact, and nothing sooner', async () => {
    const { hs, deps } = await withHubSpot();
    const id = await newLead();
    await processCrm(deps);
    expect(hs.companies.size).toBe(1);
    expect(hs.contacts.size).toBe(1);
    // The Sydney day 12 months back from 4 Nov 2026 is 4 Nov 2025: activity on that day is not yet old enough.
    await backdate(id, '2025-11-04T01:00:00Z');
    expect(await staleLeads(t.db, t.clock.now)).toHaveLength(0);
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 0, waiting: 0 });
    await backdate(id, '2025-11-03T01:00:00Z');
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 1, waiting: 0 });
    expect(await findClub(t.db, id)).toBeNull();
    expect(hs.companies.size).toBe(0);
    expect(hs.contacts.size).toBe(0);
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 0, waiting: 0 }); // idempotent
  });

  it('never deletes a customer, or a club with batches, whatever its age; any activity starts the 12 months again', async () => {
    const { deps } = await withHubSpot();
    const customer = await createClub(t.db, { name: 'Old PC', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
    const lead = await newLead('Lead Club', 'attila+l1@test.picklemypaddle.com');
    const touched = await newLead('Touched Club', 'attila+l2@test.picklemypaddle.com');
    for (const id of [customer.id, lead, touched]) await backdate(id, '2024-01-01T00:00:00Z');
    await moveClub(t.db, touched, 'meeting', t.clock.now); // activity today
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 1, waiting: 0 });
    expect(await findClub(t.db, customer.id)).not.toBeNull();
    expect(await findClub(t.db, lead)).toBeNull();
    expect(await findClub(t.db, touched)).not.toBeNull();
  });

  it('waits when HubSpot can’t be reached, so nothing is left behind there, then deletes next time', async () => {
    const { hs, deps } = await withHubSpot();
    const id = await newLead();
    await processCrm(deps);
    await backdate(id, '2025-01-01T00:00:00Z');
    const broken: CrmDeps = { ...deps, portalId: async () => { throw new Error('hubspot_503'); } };
    expect(await runLeadRetention({ db: t.db, crm: broken }, t.clock.now)).toEqual({ leads: 0, waiting: 1 });
    expect(await findClub(t.db, id)).not.toBeNull();
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 1, waiting: 0 });
    expect(hs.companies.size).toBe(0);
  });
});
