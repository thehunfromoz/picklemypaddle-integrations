/**
 * Sending and recording the club agreement (SCRUM-94).
 *
 *  - Send: from a club in admin, "Send agreement" emails the live version (full text, a printable
 *    page, and a request to reply "I agree") to the club's contact, and a club at Meeting arranged
 *    moves to Agreement sent. A version already sent is shown again, not edited; a change is a new
 *    version. A newer version can be sent to an Active club; the version it accepted stays on record.
 *  - Record: replies are read by hand from Gmail. Attila records the version, the date of the reply
 *    and who replied; the club then becomes Active (it needs its billing details first).
 *  - Gate: pickups (SCRUM-96) can't be requested until the club has accepted a version:
 *    `requireAcceptedAgreement`.
 */
import type { Db, Queryable } from '../db/db.js';
import { enqueueClubCrmSync } from '../crm/sync.js';
import { CLUB_LINK_DAYS } from '../documents/documents.js';
import { enqueueClubEmail } from '../email/outbox.js';
import { ISO_DATE_RE, sydneyDate } from '../orders/dates.js';
import { hashToken, TOKEN_RE } from '../orders/model.js';
import { agreementSha, AGREEMENT_VERSIONS, liveAgreement, versionByNumber, type AgreementSection, type AgreementVersion } from './agreement-versions.js';
import { ClubError } from './clubs.js';

export const MAX_ACCEPTED_BY = 120;
export const MAX_ACCEPTED_NOTE = 1000;

/** The Schedule: the club's details, filled in from its record when the agreement is sent. */
export type ScheduleRow = [item: string, details: string];

interface ClubFacts {
  name: string;
  abn: string | null;
  status: string;
  billing_name: string | null;
  billing_email: string | null;
  billing_address: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

/** The club's contact for pickups and for this agreement: the enquiry's contact, else the billing contact. */
export const agreementRecipient = (c: Pick<ClubFacts, 'contact_email' | 'billing_email'>): string | null => c.contact_email ?? c.billing_email;

export function scheduleFor(c: ClubFacts): ScheduleRow[] {
  const pickupName = c.contact_name ?? c.billing_name;
  const pickup = [pickupName, c.contact_email ?? c.billing_email, c.contact_phone].filter(Boolean).join(', ');
  return [
    ['Club name', c.name],
    ['Club ABN (if any)', c.abn ?? 'None given'],
    ['Contact for pickups (name, email, phone)', pickup || 'To be agreed by email'],
    ['Billing contact (name, email)', c.billing_name && c.billing_email ? `${c.billing_name}, ${c.billing_email}` : 'To be given before the first invoice'],
    ['Billing address', c.billing_address ?? 'To be given before the first invoice'],
    ['Pickup and return location', 'To be agreed by email'],
    ['Pickup arrangement', 'On request (default), or recurring: to be agreed by email'],
    ['Tagging method', 'Agreed with us before the first pickup'],
    ['Usual way of paying', 'PayID, card or cash'],
  ];
}

export interface ClubAgreement {
  id: string;
  version: number;
  label: string;
  sentAt: Date;
  sentTo: string;
  acceptedOn: string | null;
  acceptedBy: string | null;
  acceptedNote: string | null;
}

interface AgreementRow {
  id: string;
  version: number;
  sent_at: Date;
  sent_to: string;
  accepted_on: string | null;
  accepted_by: string | null;
  accepted_note: string | null;
}

const labelOf = (n: number, versions: readonly AgreementVersion[]) => versionByNumber(n, versions)?.label ?? `v${n}`;

/** A club's agreements, newest version first. */
export async function agreementsOfClub(q: Queryable, clubId: string, versions: readonly AgreementVersion[] = AGREEMENT_VERSIONS): Promise<ClubAgreement[]> {
  const { rows } = await q.query<AgreementRow>(
    `SELECT id, version, sent_at, sent_to, accepted_on::text AS accepted_on, accepted_by, accepted_note
       FROM club_agreements WHERE club_id = $1::uuid ORDER BY version DESC`,
    [clubId],
  );
  return rows.map((r) => ({
    id: String(r.id), version: Number(r.version), label: labelOf(Number(r.version), versions), sentAt: new Date(r.sent_at), sentTo: r.sent_to,
    acceptedOn: r.accepted_on, acceptedBy: r.accepted_by, acceptedNote: r.accepted_note,
  }));
}

/** The highest version this club has accepted, or null. */
export async function acceptedVersion(q: Queryable, clubId: string): Promise<number | null> {
  const { rows } = await q.query<{ v: number | null }>('SELECT max(version) AS v FROM club_agreements WHERE club_id = $1::uuid AND accepted_on IS NOT NULL', [clubId]);
  const v = rows[0]?.v;
  return v === null || v === undefined ? null : Number(v);
}

export async function hasAcceptedAgreement(q: Queryable, clubId: string): Promise<boolean> {
  return (await acceptedVersion(q, clubId)) !== null;
}

/** The gate for pickups (SCRUM-96): a club that hasn't accepted a version can't request one. */
export async function requireAcceptedAgreement(q: Queryable, clubId: string): Promise<number> {
  const v = await acceptedVersion(q, clubId);
  if (v === null) throw new ClubError('agreement_needed', 'This club hasn’t accepted the club agreement yet, so pickups can’t be requested.');
  return v;
}

// ── Sending ───────────────────────────────────────────────────────────────────

export async function sendAgreement(
  db: Db,
  args: { clubId: string; isProduction: boolean; now: Date; versions?: readonly AgreementVersion[] },
): Promise<{ agreementId: string; label: string; sentTo: string; resent: boolean }> {
  const versions = args.versions ?? AGREEMENT_VERSIONS;
  const live = liveAgreement(args.isProduction, versions);
  if (!live) throw new ClubError('no_live_agreement', 'There’s no approved club agreement to send yet.');
  const sha = agreementSha(live);
  return db.tx(async (q) => {
    const { rows } = await q.query<ClubFacts & { id: string }>(
      `SELECT id, name, abn, status, billing_name, billing_email, billing_address, contact_name, contact_email, contact_phone
         FROM clubs WHERE id = $1::uuid FOR UPDATE`,
      [args.clubId],
    );
    const club = rows[0];
    if (!club) throw new ClubError('no_club', 'No such club.');
    if (!['meeting', 'agreement_sent', 'active'].includes(club.status)) {
      throw new ClubError('bad_status', 'Move the lead to Meeting arranged before sending the agreement.');
    }
    const to = agreementRecipient(club);
    if (!to) throw new ClubError('no_contact', 'The club has no contact email to send it to.');
    // A version, once sent to anyone, is never edited: the text must still be the one that was sent.
    const { rows: seen } = await q.query<{ sha256: string }>('SELECT DISTINCT sha256 FROM club_agreements WHERE version = $1', [live.version]);
    if (seen.some((r) => r.sha256 !== sha)) {
      throw new ClubError('version_edited', `Agreement ${live.label} was edited after it was sent. Put the change in a new version instead.`);
    }
    const { rows: mine } = await q.query<{ id: string; accepted_on: string | null }>(
      'SELECT id, accepted_on::text AS accepted_on FROM club_agreements WHERE club_id = $1::uuid AND version = $2',
      [club.id, live.version],
    );
    if (mine[0]?.accepted_on) throw new ClubError('already_accepted', `This club has already accepted agreement ${live.label}.`);
    let agreementId = mine[0]?.id;
    const resent = !!agreementId;
    if (!agreementId) {
      const { rows: ins } = await q.query<{ id: string }>(
        `INSERT INTO club_agreements (club_id, version, sha256, sent_at, sent_to, schedule) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [club.id, live.version, sha, args.now, to, JSON.stringify(scheduleFor(club))],
      );
      agreementId = String(ins[0]!.id);
    }
    await enqueueClubEmail(q, club.id, 'club_agreement', args.now, { agreementId });
    if (club.status === 'meeting') {
      await q.query(`UPDATE clubs SET status = 'agreement_sent', updated_at = $2, last_activity_at = $2 WHERE id = $1::uuid`, [club.id, args.now]);
      await enqueueClubCrmSync(q, club.id, args.now);
    } else {
      await q.query('UPDATE clubs SET last_activity_at = $2 WHERE id = $1::uuid', [club.id, args.now]);
    }
    return { agreementId, label: live.label, sentTo: to, resent };
  });
}

// ── Recording the reply ───────────────────────────────────────────────────────

export async function recordAcceptance(
  db: Db,
  args: { clubId: string; version: unknown; acceptedOn: string; acceptedBy: string; note: string; now: Date },
): Promise<{ becameActive: boolean }> {
  const version = typeof args.version === 'string' && /^\d{1,4}$/.test(args.version) ? Number(args.version) : typeof args.version === 'number' ? args.version : NaN;
  if (!Number.isInteger(version)) throw new ClubError('bad_version', 'Choose the version the club replied to.');
  const acceptedBy = args.acceptedBy.trim();
  const note = args.note.trim();
  if (!acceptedBy || acceptedBy.length > MAX_ACCEPTED_BY) throw new ClubError('bad_accepted_by', `Say who replied (up to ${MAX_ACCEPTED_BY} characters).`);
  if (note.length > MAX_ACCEPTED_NOTE) throw new ClubError('bad_note', `The note can be up to ${MAX_ACCEPTED_NOTE} characters.`);
  const parsed = new Date(`${args.acceptedOn}T00:00:00Z`);
  if (!ISO_DATE_RE.test(args.acceptedOn) || Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(args.acceptedOn)) throw new ClubError('bad_date', 'Give the date of the reply.');
  if (args.acceptedOn > sydneyDate(args.now)) throw new ClubError('future_date', 'The date of the reply can’t be in the future.');
  return db.tx(async (q) => {
    const { rows: c } = await q.query<{ status: string; billing_name: string | null; billing_email: string | null; billing_address: string | null }>(
      'SELECT status, billing_name, billing_email, billing_address FROM clubs WHERE id = $1::uuid FOR UPDATE',
      [args.clubId],
    );
    const club = c[0];
    if (!club) throw new ClubError('no_club', 'No such club.');
    const { rows: a } = await q.query<{ id: string; sent_at: Date; accepted_on: string | null }>(
      'SELECT id, sent_at, accepted_on::text AS accepted_on FROM club_agreements WHERE club_id = $1::uuid AND version = $2 FOR UPDATE',
      [args.clubId, version],
    );
    const row = a[0];
    if (!row) throw new ClubError('not_sent', 'That version hasn’t been sent to this club.');
    if (row.accepted_on) throw new ClubError('already_accepted', 'That version’s acceptance is already recorded.');
    if (args.acceptedOn < sydneyDate(new Date(row.sent_at))) throw new ClubError('bad_date', 'The reply can’t be dated before the agreement was sent.');
    const becomesActive = club.status === 'agreement_sent';
    if (!becomesActive && club.status !== 'active') throw new ClubError('bad_status', 'Only a club with the agreement sent (or an Active club) can accept it.');
    if (becomesActive && !(club.billing_name && club.billing_email && club.billing_address)) {
      throw new ClubError('billing_needed', 'Add the club’s billing details (Edit the club) first: the club becomes Active when you record this, and invoices go there.');
    }
    await q.query(
      'UPDATE club_agreements SET accepted_on = $2::date, accepted_by = $3, accepted_note = $4, accepted_recorded_at = $5 WHERE id = $1',
      [row.id, args.acceptedOn, acceptedBy, note || null, args.now],
    );
    if (becomesActive) await q.query(`UPDATE clubs SET status = 'active', updated_at = $2, last_activity_at = $2 WHERE id = $1::uuid`, [args.clubId, args.now]);
    else await q.query('UPDATE clubs SET last_activity_at = $2 WHERE id = $1::uuid', [args.clubId, args.now]);
    await enqueueClubCrmSync(q, args.clubId, args.now);
    return { becameActive: becomesActive };
  });
}

// ── The printable page ────────────────────────────────────────────────────────

export interface AgreementView {
  title: string;
  label: string;
  dated: string;
  sections: AgreementSection[];
  schedule: ScheduleRow[];
  sentOn: string;
  acceptedOn: string | null;
  /** Outside production: a draft or a trial, not a real agreement. */
  test: boolean;
}

/** The agreement a private link opens, as it was sent, or null (the same answer for every kind of wrong link). */
export async function agreementForToken(
  q: Queryable,
  token: unknown,
  now: Date,
  opts: { isProduction: boolean; versions?: readonly AgreementVersion[] },
): Promise<AgreementView | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const { rows } = await q.query<{ version: number; schedule: ScheduleRow[] | string; sent_at: Date; accepted_on: string | null }>(
    `SELECT a.version, a.schedule, a.sent_at, a.accepted_on::text AS accepted_on
       FROM club_agreement_tokens t JOIN club_agreements a ON a.id = t.agreement_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.created_at > $2`,
    [hashToken(token), new Date(now.getTime() - CLUB_LINK_DAYS * 86_400_000)],
  );
  const r = rows[0];
  const v = r ? versionByNumber(Number(r.version), opts.versions ?? AGREEMENT_VERSIONS) : null;
  if (!r || !v) return null;
  return {
    title: v.title, label: v.label, dated: v.dated, sections: v.sections,
    schedule: typeof r.schedule === 'string' ? (JSON.parse(r.schedule) as ScheduleRow[]) : r.schedule,
    sentOn: sydneyDate(new Date(r.sent_at)), acceptedOn: r.accepted_on, test: !opts.isProduction,
  };
}

/** Versions whose text no longer matches the hash kept at their first send (production refuses to start). */
export async function editedAfterSending(db: Queryable, versions: readonly AgreementVersion[] = AGREEMENT_VERSIONS): Promise<string[]> {
  const { rows } = await db.query<{ version: number; sha256: string }>('SELECT DISTINCT version, sha256 FROM club_agreements');
  const bad = new Set<string>();
  for (const r of rows) {
    const v = versionByNumber(Number(r.version), versions);
    if (!v || agreementSha(v) !== r.sha256) bad.add(v?.label ?? `v${r.version}`);
  }
  return [...bad];
}
