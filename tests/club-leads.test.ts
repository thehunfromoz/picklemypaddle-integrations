/**
 * Club leads (SCRUM-93): the "Talk to us about your club" form's validation and abuse protections,
 * what a submission creates (one lead, one acknowledgement, one alert, a CRM job), the pipeline
 * moves, and that nothing about members or a street address is kept.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createBatch, createClub, effectiveFulfilment, findClub, setClubActive, validateClub } from '../src/clubs/clubs.js';
import { meetingText } from '../src/clubs/model.js';
import { SERVICE_AREA_VERSION } from '../src/clubs/service-area.js';
import { createLead, MOVES, moveClub, setFulfilmentOverride, setMeeting, validateLead, type LeadForm } from '../src/clubs/leads.js';
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
  postcode: '2042',
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
      input: { clubName: 'Inner West Pickleball Club', suburb: 'Newtown', postcode: '2042', contactName: 'Jo Treasurer', contactEmail: 'attila+club1@test.picklemypaddle.com', contactPhone: '0412 345 678', memberCount: 40, message: GOOD.message, preferredTimes: 'Weekday evenings' },
    });
  });

  it('needs the club, suburb, contact name, a valid email and a rough size; phone, message and times are optional', () => {
    const r = validateLead({}, ALLOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['clubName', 'contactEmail', 'contactName', 'memberCount', 'postcode', 'suburb']);
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
    // Nothing the submitter typed but their first name: anyone can enter someone else's address.
    expect(ack.subject).toBe('[TEST] Thanks for getting in touch about your club');
    expect(ack.text).not.toContain('Inner West');
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
    // A repeat enquiry is not activity: anyone can type a club's name, so it can't keep a lead from deletion.
    await t.db.query(`UPDATE clubs SET last_activity_at = '2025-01-01T00:00:00Z'`);
    t.clock.now = new Date('2026-11-09T01:00:00Z');
    expect((await send({ contactEmail: 'attila+club3@test.picklemypaddle.com' })).status).toBe(201);
    expect(Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM clubs WHERE last_activity_at < '2026-01-01'`)).rows[0]!.n)).toBe(1);
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

  it('Active needs the billing details and an accepted agreement (recording the reply is how a club becomes Active); the database insists on billing too', async () => {
    const id = await lead();
    await moveClub(t.db, id, 'meeting', t.clock.now);
    await moveClub(t.db, id, 'agreement_sent', t.clock.now);
    // Not by a move: acceptance is the way in.
    await expect(moveClub(t.db, id, 'active', t.clock.now)).rejects.toMatchObject({ code: 'bad_move' });
    await moveClub(t.db, id, 'inactive', t.clock.now);
    await expect(moveClub(t.db, id, 'active', t.clock.now)).rejects.toMatchObject({ code: 'billing_needed' });
    await t.db.query(`UPDATE clubs SET billing_name = 'Jo', billing_email = 'jo@test.picklemypaddle.com', billing_address = '1 Court St' WHERE id = $1`, [id]);
    await expect(moveClub(t.db, id, 'active', t.clock.now)).rejects.toMatchObject({ code: 'agreement_needed' });
    expect(await setClubActive(t.db, id, true, t.clock.now)).toBe(false);
    expect((await findClub(t.db, id))!.status).toBe('inactive');
    await t.db.query(`UPDATE clubs SET billing_name = NULL WHERE id = $1`, [id]);
    await expect(t.db.query(`UPDATE clubs SET status = 'active' WHERE id = $1`, [id])).rejects.toThrow(/clubs_billing_when_active/);
  });

  it('a club made in admin (no enquiry) is a customer already: it can be made inactive and active again; one with batches too', async () => {
    t = await makeApp();
    const c = await createClub(t.db, { name: 'Old PC', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
    expect(await setClubActive(t.db, c.id, false, t.clock.now)).toBe(true);
    expect(await moveClub(t.db, c.id, 'active', t.clock.now)).toEqual({ from: 'inactive', to: 'active' });
    // A club that came in through the form, with batches (an earlier customer), may be reactivated too.
    const id = await lead();
    await t.db.query(`UPDATE clubs SET billing_name = 'Jo', billing_email = 'jo@test.picklemypaddle.com', billing_address = '1 Court St', status = 'active' WHERE id = $1`, [id]);
    await createBatch(t.db, { clubId: id, collectedOn: '2026-10-25', paddleCount: 3, notes: null, now: t.clock.now });
    expect(await setClubActive(t.db, id, false, t.clock.now)).toBe(true);
    expect(await setClubActive(t.db, id, true, t.clock.now)).toBe(true);
  });

  it('a lead that isn’t going ahead can be closed without billing details, and reopened; it can’t be made Active without them', async () => {
    const id = await lead();
    expect(await moveClub(t.db, id, 'inactive', t.clock.now)).toEqual({ from: 'lead', to: 'inactive' });
    expect((await findClub(t.db, id))!.status).toBe('inactive');
    // The old Reactivate control can't skip the billing details either.
    expect(await setClubActive(t.db, id, true, t.clock.now)).toBe(false);
    await expect(moveClub(t.db, id, 'active', t.clock.now)).rejects.toMatchObject({ code: 'billing_needed' });
    expect(await moveClub(t.db, id, 'lead', t.clock.now)).toEqual({ from: 'inactive', to: 'lead' });
    // From each open stage too.
    await moveClub(t.db, id, 'meeting', t.clock.now);
    expect(await moveClub(t.db, id, 'inactive', t.clock.now)).toMatchObject({ to: 'inactive' });
  });

  it('the admin shows no Active/Reactivate control on a lead, reports a refused reactivation, and closes a lead without an error', async () => {
    const id = await lead();
    const admin = await makeAdmin(t);
    const page = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(page).not.toContain('Reactivate');
    expect(page).not.toContain('Make inactive');
    expect((await admin.post(`/admin/clubs/${id}/active`, { active: 'yes' })).status).toBe(400);
    expect((await admin.post(`/admin/clubs/${id}/stage`, { to: 'inactive' })).status).toBe(303);
    const closed = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(closed).toContain('Reopen as a lead');
    const refused = await admin.post(`/admin/clubs/${id}/active`, { active: 'yes' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('billing details');
  });

  it('records a meeting date, and clears it', async () => {
    const id = await lead();
    expect(await setMeeting(t.db, id, { meetingOn: '2026-11-12' }, t.clock.now)).toBe(true);
    expect((await findClub(t.db, id))!.meetingOn).toBe('2026-11-12');
    await expect(setMeeting(t.db, id, { meetingOn: '2026-13-40' }, t.clock.now)).rejects.toMatchObject({ code: 'bad_date' });
    await setMeeting(t.db, id, { meetingOn: '' }, t.clock.now);
    expect((await findClub(t.db, id))!.meetingOn).toBeNull();
  });

  it('a meeting time and length can be added after the date, and need a date; a bad time or length is refused', async () => {
    t = await makeApp();
    const id = await lead();
    await setMeeting(t.db, id, { meetingOn: '2026-11-14' }, t.clock.now);
    expect(meetingText((await findClub(t.db, id))!)).toBe('Sat 14 Nov 2026');
    await setMeeting(t.db, id, { meetingOn: '2026-11-14', meetingTime: '18:30', meetingMinutes: '45' }, t.clock.now);
    expect(await findClub(t.db, id)).toMatchObject({ meetingOn: '2026-11-14', meetingTime: '18:30', meetingMinutes: 45 });
    await expect(setMeeting(t.db, id, { meetingOn: '2026-11-14', meetingTime: '25:00' }, t.clock.now)).rejects.toMatchObject({ code: 'bad_time' });
    await expect(setMeeting(t.db, id, { meetingOn: '2026-11-14', meetingMinutes: '2' }, t.clock.now)).rejects.toMatchObject({ code: 'bad_duration' });
    // Clearing the date clears the rest, even when the form still sends the saved time and length.
    await setMeeting(t.db, id, { meetingOn: '', meetingTime: '18:30', meetingMinutes: '45' }, t.clock.now);
    expect(await findClub(t.db, id)).toMatchObject({ meetingOn: null, meetingTime: null, meetingMinutes: null });
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
    const m = mapClub({ id: 'c1', name: 'Inner West PC', status: 'lead', is_test: true, billing_name: null, billing_email: null, contact_name: 'Jo Treasurer', contact_email: 'Jo@Example.com', crm_company_id: null, crm_contact_id: null, meeting_on: null, meeting_time: null, meeting_minutes: null, fulfilment_default: null, fulfilment_override: null, batches: [] });
    expect(m.company).toEqual({ clubId: 'c1', name: '[TEST] Inner West PC', isTest: true, stage: 'Lead', meeting: '', fulfilment: '' });
    expect(m.contact).toEqual({ email: 'jo@example.com', firstName: 'Jo', lastName: 'Treasurer', fromPublicForm: true });
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
  const newLead = async (name = 'Inner West Pickleball Club', email = 'attila+club1@test.picklemypaddle.com', over: Partial<LeadForm> = {}) => {
    const v = validateLead({ ...GOOD, clubName: name, contactEmail: email, ...over }, ALLOW);
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

  it('the meeting date, time and length go to the company in HubSpot, so there is somewhere to see them (UAT 10 Nov 2026)', async () => {
    const { hs, deps } = await withHubSpot();
    const id = await newLead();
    await processCrm(deps);
    const [, company] = [...hs.companies][0]!;
    expect(company.properties.pmp_club_meeting).toBe('');
    await setMeeting(t.db, id, { meetingOn: '2026-11-14' }, t.clock.now);
    await processCrm(deps);
    expect([...hs.companies][0]![1].properties.pmp_club_meeting).toBe('Sat 14 Nov 2026');
    await setMeeting(t.db, id, { meetingOn: '2026-11-14', meetingTime: '18:30', meetingMinutes: '60' }, t.clock.now);
    await processCrm(deps);
    expect([...hs.companies][0]![1].properties.pmp_club_meeting).toBe('Sat 14 Nov 2026, 18:30, 60 min');
  });

  it('the method is on the company in HubSpot, following an override', async () => {
    const { hs, deps } = await withHubSpot();
    const id = await newLead('Hornsby PC', 'attila+m@test.picklemypaddle.com', { suburb: 'Hornsby', postcode: '2077' });
    await processCrm(deps);
    expect([...hs.companies][0]![1].properties.pmp_club_fulfilment).toBe('Local pickup and drop-off');
    await setFulfilmentOverride(t.db, id, 'postal', t.clock.now);
    await processCrm(deps);
    expect([...hs.companies][0]![1].properties.pmp_club_fulfilment).toBe('Post');
  });

  it('an inactive lead (not going ahead) is deleted after 12 months too; an inactive customer never is', async () => {
    const { deps } = await withHubSpot();
    const lead = await newLead('Closed Lead', 'attila+c1@test.picklemypaddle.com');
    await moveClub(t.db, lead, 'inactive', t.clock.now);
    const customer = await createClub(t.db, { name: 'Old PC', billingName: 'Jo', billingEmail: 'jo@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
    await setClubActive(t.db, customer.id, false, t.clock.now);
    for (const id of [lead, customer.id]) await backdate(id, '2024-01-01T00:00:00Z');
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 1, waiting: 0 });
    expect(await findClub(t.db, lead)).toBeNull();
    expect(await findClub(t.db, customer.id)).not.toBeNull();
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

  it('keeps a HubSpot contact another club or an order still uses, and deletes only the lead’s own company', async () => {
    const { hs, deps } = await withHubSpot();
    const lead = await newLead('Lead Club', 'attila+shared@test.picklemypaddle.com');
    // The same person is also the billing contact of a customer club.
    await createClub(t.db, { name: 'Customer PC', billingName: 'Jo', billingEmail: 'attila+shared@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
    await processCrm(deps);
    expect(hs.contacts.size).toBe(1); // one HubSpot contact for the one address
    await backdate(lead, '2025-01-01T00:00:00Z');
    expect(await runLeadRetention({ db: t.db, crm: deps }, t.clock.now)).toEqual({ leads: 1, waiting: 0 });
    expect(hs.contacts.size).toBe(1);
    expect(hs.companies.size).toBe(1); // the customer's
  });

  it('a name typed into the public form never overwrites a HubSpot contact that already exists', async () => {
    const { hs, deps } = await withHubSpot();
    // A customer's billing contact is already in HubSpot under their own name.
    await createClub(t.db, { name: 'Customer PC', billingName: 'Real Treasurer', billingEmail: 'attila+shared@test.picklemypaddle.com', billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
    await processCrm(deps);
    // Someone else types that address and a different name into the lead form.
    await newLead('Other Club', 'attila+shared@test.picklemypaddle.com');
    await processCrm(deps);
    const contact = hs.contacts.get('attila+shared@test.picklemypaddle.com')!;
    expect(contact.properties).toMatchObject({ firstname: 'Real', lastname: 'Treasurer' });
    expect(hs.companies.size).toBe(2);
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

describe('the service area on a lead (SCRUM-102)', () => {
  const lead = async (over: Partial<LeadForm>) => {
    const v = validateLead({ ...GOOD, ...over }, ALLOW);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    return (await createLead(t.db, v.input, { isProduction: false, now: t.clock.now })).clubId;
  };

  it('needs a 4-digit venue postcode, separate from the suburb', () => {
    for (const postcode of ['', '204', '20421', 'abcd']) {
      const r = validateLead({ ...GOOD, postcode }, ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['postcode']);
    }
    expect(validateLead({ ...GOOD, postcode: ' 2 0 4 2 ' }, ALLOW).ok).toBe(true);
  });

  it('a venue inside the area defaults to local pickup, with the list version recorded', async () => {
    t = await makeApp();
    const id = await lead({ clubName: 'Hornsby PC', suburb: 'Hornsby', postcode: '2077', contactEmail: 'attila+m@test.picklemypaddle.com' });
    expect(await findClub(t.db, id)).toMatchObject({ suburb: 'Hornsby', venuePostcode: '2077', fulfilmentDefault: 'local', fulfilmentOverride: null, areaVersion: SERVICE_AREA_VERSION, areaReview: false });
  });

  it('a venue outside the area, or an unknown suburb, defaults to post', async () => {
    t = await makeApp();
    const a = await lead({ clubName: 'Campbelltown PC', suburb: 'Campbelltown', postcode: '2560', contactEmail: 'attila+c@test.picklemypaddle.com' });
    const b = await lead({ clubName: 'Nowhere PC', suburb: 'Nowhereville', postcode: '2999', contactEmail: 'attila+n@test.picklemypaddle.com' });
    expect(await findClub(t.db, a)).toMatchObject({ fulfilmentDefault: 'postal', areaReview: false });
    expect(await findClub(t.db, b)).toMatchObject({ fulfilmentDefault: 'postal', areaReview: false });
  });

  it('a listed suburb with the wrong postcode is postal and flagged for review', async () => {
    t = await makeApp();
    const id = await lead({ clubName: 'Odd PC', suburb: 'Hornsby', postcode: '2560', contactEmail: 'attila+o@test.picklemypaddle.com' });
    expect(await findClub(t.db, id)).toMatchObject({ fulfilmentDefault: 'postal', areaReview: true });
  });

  it('an override is recorded with its time and wins over the default; clearing it goes back; the default and version stay', async () => {
    t = await makeApp();
    const id = await lead({ clubName: 'Campbelltown PC', suburb: 'Campbelltown', postcode: '2560', contactEmail: 'attila+c@test.picklemypaddle.com' });
    await setFulfilmentOverride(t.db, id, 'local', t.clock.now);
    const c = (await findClub(t.db, id))!;
    expect(c).toMatchObject({ fulfilmentDefault: 'postal', fulfilmentOverride: 'local', areaVersion: SERVICE_AREA_VERSION });
    expect(c.fulfilmentOverrideAt).toEqual(t.clock.now);
    expect(effectiveFulfilment(c)).toBe('local');
    await expect(setFulfilmentOverride(t.db, id, 'courier', t.clock.now)).rejects.toMatchObject({ code: 'bad_fulfilment' });
    await setFulfilmentOverride(t.db, id, '', t.clock.now);
    const back = (await findClub(t.db, id))!;
    expect(back).toMatchObject({ fulfilmentOverride: null, fulfilmentOverrideAt: null });
    expect(effectiveFulfilment(back)).toBe('postal');
  });

  it('the public API takes the postcode and refuses a missing one beside its field', async () => {
    t = await makeApp();
    const res = await t.app.request('/api/clubs/lead', { method: 'POST', body: JSON.stringify({ ...GOOD, postcode: '', formToken: t.formToken(), website: '' }), headers: { 'Content-Type': 'application/json', Origin: SITE } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Record<string, string> }).errors.postcode).toBeTruthy();
  });
});
