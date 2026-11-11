/**
 * The club agreement (SCRUM-94): numbered, dated versions that are never edited once sent; the live
 * version rule; sending (one email with the full text, the club moves to Agreement sent); the
 * printable page; recording the "I agree" reply (the club becomes Active); the gate for pickups; and
 * the production guards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AGREEMENT_VERSIONS, agreementLines, agreementProblems, agreementSha, liveAgreement, placeholdersInAgreement, type AgreementVersion } from '../src/clubs/agreement-versions.js';
import { acceptedVersion, agreementsOfClub, editedAfterSending, hasAcceptedAgreement, recordAcceptance, requireAcceptedAgreement, sendAgreement } from '../src/clubs/agreements.js';
import { findClub } from '../src/clubs/clubs.js';
import { createLead, moveClub, validateLead } from '../src/clubs/leads.js';
import { processOutbox } from '../src/email/outbox.js';
import type { EmailMessage } from '../src/email/sender.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, SITE, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => t?.close());

/** The live (newest) version: tests that send an agreement use it, whatever its number. */
const LIVE = AGREEMENT_VERSIONS.at(-1)!;

const draft = (over: Partial<AgreementVersion> = {}): AgreementVersion => ({
  version: 1, label: '0.1', dated: '2026-11-04', approvedOn: null, title: 'Club agreement',
  sections: [{ heading: '1. Who', blocks: [{ p: '1.1 Between us and the club.' }] }], ...over,
});

describe('versions', () => {
  it('v0.1 is a numbered, dated draft: not approved, with the club’s payment-in-full rule and its own number and date', () => {
    const v = AGREEMENT_VERSIONS[0]!;
    expect(v).toMatchObject({ version: 1, label: '0.1', dated: '2026-11-04', approvedOn: null });
    const text = agreementLines(v).join('\n');
    expect(text).toContain('this is version 0.1, dated 4 November 2026');
    expect(text).toContain('Payment is in full for each invoice. Part payments aren’t accepted.');
    expect(text).not.toMatch(/part payments are allowed/i);
    expect(text).toContain('replies to our email with the words “I agree”');
    // The draft still has wording to settle: it can't be live in production until Attila approves it.
    expect(placeholdersInAgreement(v).length).toBeGreaterThan(0);
  });

  it('the live version is the newest Attila approved; outside production the newest, so a draft can be tried', () => {
    const v1 = draft({ approvedOn: '2026-11-10' });
    const v2 = draft({ version: 2, label: '0.2' });
    expect(liveAgreement(true, [v1, v2])?.label).toBe('0.1');
    expect(liveAgreement(false, [v1, v2])?.label).toBe('0.2');
    expect(liveAgreement(true, [v2])).toBeNull();
    expect(liveAgreement(true, [])).toBeNull();
  });

  it('production refuses a live agreement that still has a [To confirm: …], but not an unapproved draft', () => {
    const settled = draft({ approvedOn: '2026-11-10' });
    expect(agreementProblems([settled])).toEqual([]);
    const open = draft({ approvedOn: '2026-11-10', sections: [{ heading: '1', blocks: [{ list: ['a', '[To confirm: number]'] }] }] });
    expect(agreementProblems([open])).toEqual(['club agreement 0.1 still needs wording']);
    expect(agreementProblems([draft({ sections: open.sections })])).toEqual([]); // unapproved: never sent in production
    // The real draft today: not approved, so production starts and sends nothing.
    expect(agreementProblems()).toEqual([]);
  });

  it('a hash of the text changes with any edit', () => {
    const a = draft();
    expect(agreementSha(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(agreementSha(draft())).toBe(agreementSha(a));
    expect(agreementSha(draft({ sections: [{ heading: '1. Who', blocks: [{ p: '1.1 Between us and the club!' }] }] }))).not.toBe(agreementSha(a));
  });
});

async function meetingClub(over: { contactEmail?: string } = {}) {
  t = await makeApp();
  t.clock.now = new Date('2026-11-09T01:00:00Z');
  const v = validateLead({ clubName: 'Inner West Pickleball Club', suburb: 'Newtown', postcode: '2042', contactName: 'Jo Treasurer', contactEmail: over.contactEmail ?? 'attila+club1@test.picklemypaddle.com', contactPhone: '0412 345 678', memberCount: '40' }, { isProduction: false, allowList: ['attila@test.picklemypaddle.com'] });
  if (!v.ok) throw new Error('bad fixture');
  const { clubId } = await createLead(t.db, v.input, { isProduction: false, now: t.clock.now });
  await moveClub(t.db, clubId, 'meeting', t.clock.now);
  return clubId;
}
const addBilling = (id: string) => t.db.query(`UPDATE clubs SET billing_name = 'Jo Treasurer', billing_email = 'jo@test.picklemypaddle.com', billing_address = '1 Court St' WHERE id = $1`, [id]);
const send = (id: string, over: Partial<Parameters<typeof sendAgreement>[1]> = {}) => sendAgreement(t.db, { clubId: id, isProduction: false, now: t.clock.now, ...over });
const sendMail = async () => {
  const sent: EmailMessage[] = [];
  await processOutbox({ db: t.db, sender: { name: 'fake', send: async (m) => (sent.push(m), { id: 'e' }) }, settings: { isProduction: false, allowList: ['attila@test.picklemypaddle.com'], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
  return sent;
};

describe('sending', () => {
  it('emails the live version with its full text and an "I agree" request, and the club moves to Agreement sent', async () => {
    const id = await meetingClub();
    const r = await send(id);
    expect(r).toMatchObject({ label: LIVE.label, sentTo: 'attila+club1@test.picklemypaddle.com', resent: false });
    expect((await findClub(t.db, id))!.status).toBe('agreement_sent');
    const mails = (await t.db.query<{ template: string; recipient: string }>(`SELECT template, recipient FROM outbox WHERE kind = 'email' AND template = 'club_agreement'`)).rows;
    expect(mails).toEqual([{ template: 'club_agreement', recipient: 'attila+club1@test.picklemypaddle.com' }]);

    const sent = (await sendMail()).filter((m) => m.subject.includes('Club agreement'));
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.subject).toBe(`[TEST] Club agreement ${LIVE.label} for Inner West Pickleball Club: please reply “I agree”`);
    expect(m.replyTo).toBe('attila@picklemypaddle.com');
    expect(m.text).toContain('reply to this email with the words “I agree”');
    expect(m.text).toContain('TEST AGREEMENT');
    // The full text, in the body, and the Schedule filled in from the club's record.
    expect(m.text).toContain('1.3 Accepting it.');
    expect(m.text).toContain('9.5 Contact. Attila Madarasz');
    expect(m.text).toContain('Payment is in full for each invoice. Part payments aren’t accepted.');
    expect(m.text).toContain('Inner West Pickleball Club');
    expect(m.text).toMatch(/Jo Treasurer, attila\+club1@test\.picklemypaddle\.com, 0412 345 678/);
    expect(m.text).toMatch(/\/club\/agreement#[A-Za-z0-9_-]{43}/);
    expect(m.html).not.toMatch(/<img|<script|src=/i);
  });

  it('is refused for a lead that hasn’t reached Meeting arranged, with no live version, or with no one to send to', async () => {
    t = await makeApp();
    const v = validateLead({ clubName: 'Lead Club', suburb: 'Newtown', postcode: '2042', contactName: 'Jo', contactEmail: 'attila+l@test.picklemypaddle.com', memberCount: '10' }, { isProduction: false, allowList: ['attila@test.picklemypaddle.com'] });
    if (!v.ok) throw new Error('bad fixture');
    const { clubId } = await createLead(t.db, v.input, { isProduction: false, now: t.clock.now });
    await expect(send(clubId)).rejects.toMatchObject({ code: 'bad_status' });
    await moveClub(t.db, clubId, 'meeting', t.clock.now);
    await expect(send(clubId, { isProduction: true })).rejects.toMatchObject({ code: 'no_live_agreement' }); // v0.1 isn't approved
    await t.db.query('UPDATE clubs SET contact_email = NULL WHERE id = $1', [clubId]);
    await expect(send(clubId)).rejects.toMatchObject({ code: 'no_contact' });
    await expect(send('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'no_club' });
    expect(Number((await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM club_agreements')).rows[0]!.n)).toBe(0);
  });

  it('an unsent club made in admin sends to its billing contact; sending again re-sends the same version', async () => {
    const id = await meetingClub();
    await t.db.query('UPDATE clubs SET contact_email = NULL WHERE id = $1', [id]);
    await addBilling(id);
    expect((await send(id)).sentTo).toBe('jo@test.picklemypaddle.com');
    expect(await send(id)).toMatchObject({ resent: true });
    expect(await agreementsOfClub(t.db, id)).toHaveLength(1);
    expect(Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE template = 'club_agreement'`)).rows[0]!.n)).toBe(2);
  });

  it('a re-send to a corrected address goes there and records it, with the Schedule as it now is; once accepted nothing about it changes', async () => {
    const id = await meetingClub({ contactEmail: 'attila+typo@test.picklemypaddle.com' });
    await send(id);
    await t.db.query(`UPDATE clubs SET contact_email = 'attila+fixed@test.picklemypaddle.com' WHERE id = $1`, [id]);
    await addBilling(id);
    expect(await send(id)).toMatchObject({ resent: true, sentTo: 'attila+fixed@test.picklemypaddle.com' });
    const [row] = await agreementsOfClub(t.db, id);
    expect(row!.sentTo).toBe('attila+fixed@test.picklemypaddle.com');
    const mails = (await sendMail()).filter((m) => m.subject.includes('Club agreement'));
    expect(mails.map((m) => m.to)).toEqual(['attila+typo@test.picklemypaddle.com', 'attila+fixed@test.picklemypaddle.com']);
    expect(mails[1]!.text).toContain('Jo Treasurer, jo@test.picklemypaddle.com');
    expect(mails[1]!.text).not.toContain('To be given before the first invoice');
    await recordAcceptance(t.db, { clubId: id, version: String(LIVE.version), acceptedOn: '2026-11-09', acceptedBy: 'Jo', note: '', now: t.clock.now });
    await expect(t.db.query(`UPDATE club_agreements SET sent_to = 'x@y.com'`)).rejects.toThrow(/accepted agreement is never edited/);
  });

  it('a version is never edited once sent: a changed text is refused, the database freezes the row, and production would not start', async () => {
    const id = await meetingClub();
    const v1 = AGREEMENT_VERSIONS.at(-1)!;
    await send(id);
    expect(await editedAfterSending(t.db)).toEqual([]);
    const edited = { ...v1, sections: [{ heading: '1. Changed', blocks: [{ p: 'Something else.' }] }] };
    // Another club, the same version number, but the text was edited since the first send.
    const other = await t.db.query<{ id: string }>(`INSERT INTO clubs (name, status, is_test, contact_email, contact_name) VALUES ('Other Club', 'meeting', true, 'attila+o@test.picklemypaddle.com', 'Sam') RETURNING id`);
    await expect(send(other.rows[0]!.id, { versions: [edited] })).rejects.toMatchObject({ code: 'version_edited' });
    expect(await editedAfterSending(t.db, [edited])).toEqual([LIVE.label]);
    await expect(t.db.query(`UPDATE club_agreements SET sha256 = repeat('a', 64)`)).rejects.toThrow(/never edited/);
    await expect(t.db.query(`UPDATE club_agreements SET sent_at = now()`)).rejects.toThrow(/never edited/);
  });
});

describe('v0.2 (postage, SCRUM-94 UAT 10 Nov 2026)', () => {
  const v = AGREEMENT_VERSIONS[1]!;
  const text = agreementLines(v).join('\n');
  it('is the next numbered draft, and v0.1 (never sent) is untouched', () => {
    expect(v).toMatchObject({ version: 2, label: '0.2', dated: '2026-11-10', approvedOn: null });
    expect(text).toContain('this is version 0.2, dated 10 November 2026');
  });
  it('3.2 vetting includes the dead-spot check, front and back', () => {
    expect(text).toMatch(/no dead spots: the sound is the same across the whole of each face, front and back/);
  });
  it('has a postage section (box, tracking, receipt, return) and local pickup stays its own section', () => {
    expect(text).toContain('4. Pickups and returns (for clubs we can visit)');
    expect(text).toContain('5. Pickups and returns by post');
    expect(text).toContain('We supply a cardboard box');
    expect(text).toContain('We pay the return postage for a batch of 6 or more paddles');
    expect(text).toContain('emails us the tracking number');
    expect(text).toContain('return tracking number');
  });
  it('custody and price wording cover post, and nothing still says postage never applies', () => {
    expect(text).toContain('6.6 Paddles in the post');
    expect(text).not.toContain('no postage applies to club batches');
    expect(text).toContain('5.1 Choosing');
  });
  it('cross-references point at sections that exist', () => {
    const heads = new Set(v.sections.map((s) => s.heading.split('.')[0]));
    for (const m of text.matchAll(/section (\d)/g)) expect(heads.has(m[1]!)).toBe(true);
    const nums = new Set(agreementLines(v).map((l) => /^(\d\.\d)/.exec(l)?.[1]).filter(Boolean));
    for (const m of text.matchAll(/\((\d\.\d)[,)]/g)) expect(nums.has(m[1]!)).toBe(true);
  });
});

describe('v0.3 (Attila’s UAT of 0.2, 10 Nov 2026)', () => {
  const v = AGREEMENT_VERSIONS[2]!;
  const text = agreementLines(v).join('\n');
  it('is the next numbered draft: not approved, and 0.2 (sent to a staging test club) is left as it was', () => {
    expect(v).toMatchObject({ version: 3, label: '0.3', dated: '2026-11-10', approvedOn: null });
    expect(text).toContain('this is version 0.3, dated 10 November 2026');
    expect(agreementLines(AGREEMENT_VERSIONS[1]!).join('\n')).toContain('no dead spots: the sound is the same across the whole of each face');
  });
  it('3.2: the dead-spot sentence as written, the tournament standard, and no brand list', () => {
    expect(text).toContain('no dead spots: when a ball is bounced on it or it is knocked with a hard object such as a coin or the handle of another paddle, the sound made is consistent with the sound an undamaged paddle makes, louder in the centre, tapering off towards the sides in a consistent way;');
    expect(text).toContain('once usable in sanctioned tournament play');
    expect(text).toContain('asks us before including it in a shipment');
    expect(text).not.toContain('any brands, surfaces or materials we don’t accept');
  });
  it('4: the service area, post by agreement, 3 business days ahead, at least 5 paddles', () => {
    expect(text).toContain('inside our local pickup and drop-off area');
    expect(text).toContain('map, with its list of suburbs, on the Clubs page');
    expect(text).toContain('a club inside it can too by agreement with PickleMyPaddle');
    expect(text).not.toContain('any club that prefers it');
    expect(text).toContain('at least 3 business days ahead');
    expect(text).toContain('A batch has at least 5 paddles, to justify a pickup');
  });
  it('5: the box, who pays postage, and 2 business days to report a difference', () => {
    expect(text).toContain('430 mm × 300 mm × 300 mm, which holds 8 to 10 paddles');
    expect(text).toContain('For a batch of 6 or more paddles, we take the standard cost of that postage off the club’s invoice, as its own line');
    expect(text).toContain('The club pays the postage of the box to us.');
    expect(text).toContain('We pay the postage back to the club, for every batch.');
    expect(text).not.toContain('who pays the postage back');
    expect(text).toContain('the Australia Post price for posting that batch from the club’s venue postcode on the invoice date; if the club’s postage costs more, the club bears the difference');
    expect(text).toContain('within 2 business days of the return delivery');
  });
  it('6: second-hand value up to A$100 a paddle, and insured in the post', () => {
    expect(text).toContain('we pay its reasonable second-hand value, up to A$100 a paddle');
    expect(text).toContain('is covered by our insurance up to a second-hand value of A$100 a paddle');
  });
  it('7: member price up to A$66, payment before return, 5 and 10 business days', () => {
    expect(text).toContain('shouldn’t charge a member more than A$66 a paddle');
    expect(text).toContain('option of sending the paddle directly to us');
    expect(text).toContain('The club pays the invoice in full before we drop the batch off or post it back, and we return the batch once we have the payment');
    expect(text).toContain('still unpaid 5 business days after we send it');
    expect(text).toContain('in cash, by arrangement with us before the batch is returned');
    // Everything that returns a batch waits for the payment.
    for (const clause of ['2.2', '4.4', '5.5', '9.3']) expect(agreementLines(v).find((l) => l.startsWith(`${clause} `)), clause).toContain('(7.3)');
    expect(text).toContain('at least 10 business days’ notice of any price change');
  });
  it('the items Attila settled are no longer [To confirm]; the rest still are', () => {
    const left = placeholdersInAgreement(v).join(' | ');
    for (const settled of ['service area', 'minimum number', 'box size', 'cap', 'repair it']) expect(left).not.toContain(settled);
    expect(left).toContain('legal name');
    expect(left).toContain('business address');
  });
  it('cross-references point at sections that exist', () => {
    const heads = new Set(v.sections.map((s) => s.heading.split('.')[0]));
    for (const m of text.matchAll(/section (\d)/g)) expect(heads.has(m[1]!)).toBe(true);
    const nums = new Set(agreementLines(v).map((l) => /^(\d\.\d)/.exec(l)?.[1]).filter(Boolean));
    for (const m of text.matchAll(/\((\d\.\d)[,)]/g)) expect(nums.has(m[1]!)).toBe(true);
  });
  it('the Schedule says how batches travel, the venue and the service-area list used', async () => {
    t = await makeApp();
    const id = await meetingClub();
    await t.db.query(`UPDATE clubs SET suburb = 'Hornsby', venue_postcode = '2077', fulfilment_default = 'local', area_version = '2026-11-10' WHERE id = $1`, [id]);
    await send(id);
    const rows = (await t.db.query<{ schedule: [string, string][] | string }>(`SELECT schedule FROM club_agreements`)).rows[0]!.schedule;
    const sch = typeof rows === 'string' ? (JSON.parse(rows) as [string, string][]) : rows;
    expect(sch).toContainEqual(['Venue (suburb and postcode)', 'Hornsby 2077']);
    expect(sch).toContainEqual(['How batches travel', 'Local pickup and drop-off']);
    expect(sch).toContainEqual(['Service area list used', '2026-11-10']);
  });
});

describe('the printable page', () => {
  it('opens from the email’s private link with the text as sent; a wrong link gets the same answer as an old one', async () => {
    const id = await meetingClub();
    await send(id);
    const mail = (await sendMail()).find((m) => m.subject.includes('Club agreement'))!;
    const token = /\/club\/agreement#([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    const post = (body: unknown) => t.app.request('/api/clubs/agreement', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: SITE } });
    const ok = await post({ token });
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as { label: string; dated: string; sections: unknown[]; schedule: [string, string][]; sentOn: string; acceptedOn: string | null; test: boolean };
    expect(view).toMatchObject({ label: LIVE.label, dated: LIVE.dated, sentOn: '2026-11-09', acceptedOn: null, test: true });
    expect(view.sections.length).toBe(AGREEMENT_VERSIONS.at(-1)!.sections.length);
    expect(view.schedule[0]).toEqual(['Club name', 'Inner West Pickleball Club']);
    expect((await post({ token: 'x'.repeat(43) })).status).toBe(404);
    expect((await post({ token: 12 })).status).toBe(404);
    expect((await post({})).status).toBe(404);
    t.clock.now = new Date('2027-11-10T01:00:00Z'); // past the link's life (a year)
    expect((await post({ token })).status).toBe(404);
  });
});

describe('recording the reply', () => {
  const accept = (id: string, over: Partial<Parameters<typeof recordAcceptance>[1]> = {}) =>
    recordAcceptance(t.db, { clubId: id, version: String(LIVE.version), acceptedOn: '2026-11-09', acceptedBy: 'Jo Treasurer', note: 'Replied from the committee address', now: t.clock.now, ...over });

  it('records the version, the date and who replied; the club becomes Active; the gate for pickups opens', async () => {
    const id = await meetingClub();
    await send(id);
    await addBilling(id);
    expect(await hasAcceptedAgreement(t.db, id)).toBe(false);
    await expect(requireAcceptedAgreement(t.db, id)).rejects.toMatchObject({ code: 'agreement_needed' });
    expect(await accept(id)).toEqual({ becameActive: true });
    expect((await findClub(t.db, id))!.status).toBe('active');
    expect(await agreementsOfClub(t.db, id)).toMatchObject([{ label: LIVE.label, acceptedOn: '2026-11-09', acceptedBy: 'Jo Treasurer', acceptedNote: 'Replied from the committee address' }]);
    expect(await requireAcceptedAgreement(t.db, id)).toBe(LIVE.version);
    expect(await acceptedVersion(t.db, id)).toBe(LIVE.version);
    // The page says so, too.
    const mail = (await sendMail()).find((m) => m.subject.includes('Club agreement'))!;
    const token = /#([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    const r = await t.app.request('/api/clubs/agreement', { method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json' } });
    expect(((await r.json()) as { acceptedOn: string }).acceptedOn).toBe('2026-11-09');
  });

  it('needs the billing details first, and refuses a bad date, a future or earlier date, no name, an unsent version or a second recording', async () => {
    const id = await meetingClub();
    await send(id);
    await expect(accept(id)).rejects.toMatchObject({ code: 'billing_needed' });
    expect((await findClub(t.db, id))!.status).toBe('agreement_sent');
    await addBilling(id);
    await expect(accept(id, { acceptedOn: '2026-13-01' })).rejects.toMatchObject({ code: 'bad_date' });
    await expect(accept(id, { acceptedOn: '2026-11-10' })).rejects.toMatchObject({ code: 'future_date' });
    await expect(accept(id, { acceptedOn: '2026-11-08' })).rejects.toMatchObject({ code: 'bad_date' }); // before it was sent on the 9th
    await expect(accept(id, { acceptedBy: ' ' })).rejects.toMatchObject({ code: 'bad_accepted_by' });
    await expect(accept(id, { note: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'bad_note' });
    await expect(accept(id, { version: String(LIVE.version + 1) })).rejects.toMatchObject({ code: 'not_sent' });
    await expect(accept(id, { version: 'one' })).rejects.toMatchObject({ code: 'bad_version' });
    await accept(id);
    await expect(accept(id)).rejects.toMatchObject({ code: 'already_accepted' });
    await expect(t.db.query(`UPDATE club_agreements SET accepted_by = 'Someone else'`)).rejects.toThrow(/recorded once/);
    await expect(send(id)).rejects.toMatchObject({ code: 'already_accepted' });
  });

  it('a newer version can be sent to an Active club; the accepted version stays on record until the new one is accepted', async () => {
    const id = await meetingClub();
    await addBilling(id);
    await send(id);
    await accept(id);
    const v1 = AGREEMENT_VERSIONS.at(-1)!;
    const v2 = { ...v1, version: LIVE.version + 1, label: '9.9', dated: '2026-12-01', sections: [{ heading: '1. New', blocks: [{ p: 'Changed terms.' }] }] };
    await sendAgreement(t.db, { clubId: id, isProduction: false, now: t.clock.now, versions: [v1, v2] });
    expect((await findClub(t.db, id))!.status).toBe('active'); // stays Active
    expect(await acceptedVersion(t.db, id)).toBe(LIVE.version);
    expect((await agreementsOfClub(t.db, id, [v1, v2])).map((a) => [a.label, a.acceptedOn])).toEqual([['9.9', null], [LIVE.label, '2026-11-09']]);
    expect(await accept(id, { version: String(LIVE.version + 1) })).toEqual({ becameActive: false });
    expect(await acceptedVersion(t.db, id)).toBe(LIVE.version + 1);
  });
});

describe('in the admin', () => {
  it('sends the agreement and records the reply; mistakes come back with the reason', async () => {
    const id = await meetingClub();
    const admin = await makeAdmin(t);
    const page = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(page).toContain(`Send agreement ${LIVE.label}`);
    expect(page).toContain('only staging sends it');
    const sent = await admin.post(`/admin/clubs/${id}/agreement/send`, {});
    expect(sent.status).toBe(303);
    expect(sent.headers.get('location')).toContain('done=agreement_sent');
    const after = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(after).toContain('Waiting for “I agree”');
    expect(after).toContain(`Send agreement ${LIVE.label} again`);
    expect(after).toContain('Record an “I agree” reply');

    const noBilling = await admin.post(`/admin/clubs/${id}/agreement/accept`, { version: String(LIVE.version), acceptedOn: '2026-11-09', acceptedBy: 'Jo' });
    expect(noBilling.status).toBe(400);
    expect(await noBilling.text()).toContain('billing details');
    await addBilling(id);
    const ok = await admin.post(`/admin/clubs/${id}/agreement/accept`, { version: String(LIVE.version), acceptedOn: '2026-11-09', acceptedBy: 'Jo Treasurer', note: 'by email' });
    expect(ok.headers.get('location')).toContain('done=agreement_accepted_active');
    const done = await (await admin.get(`/admin/clubs/${id}`)).text();
    expect(done).toContain('Jo Treasurer');
    expect(done).not.toContain('Record an “I agree” reply');
  });
});

describe('v0.4 (artwork and logos, SCRUM-104, 11 Nov 2026)', () => {
  const v = AGREEMENT_VERSIONS[3]!;
  const text = agreementLines(v).join('\n');
  it('is the next numbered draft: not approved, and 0.3 (sent to a staging test club) is exactly as it was sent', () => {
    expect(v).toMatchObject({ version: 4, label: '0.4', dated: '2026-11-11', approvedOn: null });
    expect(text).toContain('this is version 0.4, dated 11 November 2026');
    // The hash recorded when 0.3 was sent on staging: an edit to 0.3 would change it (and a re-send be refused).
    expect(agreementSha(AGREEMENT_VERSIONS[2]!)).toBe('e501b150ab8ea78a8d98e15472f71010bfefc9146c57c1e2fcacd5384f52cc95');
  });
  it('2.5: the new grit is black and not see-through, logos and artwork are hidden, and the club tells its members (3.1 lists it)', () => {
    expect(text).toMatch(/2\.5 Artwork and logos\. The new grit is black and not see-through, so any logo or artwork on the paddle faces is hidden/);
    expect(text).toMatch(/2\.5 [^\n]*The club tells its members this before taking their paddles/);
    expect(text).toContain('(2.3, 2.5, 6.4 and the price)');
  });
  it('adds nothing else: the rest of the text is 0.3’s, and no new [To confirm]', () => {
    const old = agreementLines(AGREEMENT_VERSIONS[2]!).filter((l) => !l.includes('this is version 0.3') && !l.includes('(2.3, 6.4 and the price)'));
    for (const l of old) expect(text, l.slice(0, 40)).toContain(l);
    expect(placeholdersInAgreement(v)).toEqual(placeholdersInAgreement(AGREEMENT_VERSIONS[2]!));
  });
});
