/**
 * Club leads (SCRUM-93): the "Talk to us about your club" form on the Clubs page, and the pipeline
 * Attila moves a club along: Lead → Meeting arranged → Agreement sent → Active → Inactive.
 *
 *  - A lead is a club record (status lead), not a table of its own. Billing details are only
 *    needed from Active on (a database check), so they are empty until Attila adds them.
 *  - Only what the one contact tells us about the club is kept: never members' names or emails, and
 *    no street address (decided 6 Oct 2026). A club's members are the club's to look after.
 *  - Submitting queues an acknowledgement to the contact and an alert to Attila (club name and the
 *    admin link only). Outside production the contact's address must be allow-listed or a test
 *    domain, like a club's billing email, so a real person's address never reaches staging.
 */
import type { Db, Queryable } from '../db/db.js';
import { enqueueClubCrmSync } from '../crm/sync.js';
import { enqueueClubEmail } from '../email/outbox.js';
import { ISO_DATE_RE } from '../orders/dates.js';
import { allowedHere, ClubError, type ClubStatus, type EmailGuard } from './clubs.js';
import { CLUB_STATUSES, STATUS_LABELS } from './model.js';

export const MAX_LEAD_MESSAGE = 2000;
export const MAX_PREFERRED_TIMES = 300;
export const MAX_MEMBERS = 100_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9 +()\-.]{6,25}$/;

export { STATUS_LABELS };

/** The form's fields, as strings. */
export type LeadForm = Partial<Record<'clubName' | 'suburb' | 'contactName' | 'contactEmail' | 'contactPhone' | 'memberCount' | 'message' | 'preferredTimes', string | null | undefined>>;

export interface LeadInput {
  clubName: string;
  suburb: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  memberCount: number;
  message: string | null;
  preferredTimes: string | null;
}

/** Field → message, for the form to show beside the field. */
export type LeadErrors = Partial<Record<keyof LeadInput | 'form', string>>;

const clean = (v: string | null | undefined) => (v ?? '').trim();

export function validateLead(form: LeadForm, guard: EmailGuard): { ok: true; input: LeadInput } | { ok: false; errors: LeadErrors } {
  const errors: LeadErrors = {};
  const clubName = clean(form.clubName);
  const suburb = clean(form.suburb);
  const contactName = clean(form.contactName);
  const contactEmail = clean(form.contactEmail).toLowerCase();
  const phone = clean(form.contactPhone);
  const members = clean(form.memberCount);
  const message = clean(form.message).replace(/\r\n/g, '\n');
  const preferredTimes = clean(form.preferredTimes).replace(/\r\n/g, '\n');
  if (!clubName || clubName.length > 120) errors.clubName = 'Tell us the club’s name (up to 120 characters).';
  if (!suburb || suburb.length > 80) errors.suburb = 'Tell us the suburb (up to 80 characters).';
  if (!contactName || contactName.length > 120) errors.contactName = 'Tell us your name (up to 120 characters).';
  if (!EMAIL_RE.test(contactEmail) || contactEmail.length > 254) errors.contactEmail = 'Enter a valid email address.';
  else if (!allowedHere(contactEmail, guard)) {
    errors.contactEmail = 'This is a test site, so only the test email addresses work here.';
  }
  if (phone && !PHONE_RE.test(phone)) errors.contactPhone = 'Enter a phone number, or leave it empty.';
  const count = /^\d{1,6}$/.test(members) ? Number(members) : NaN;
  if (!(count >= 1 && count <= MAX_MEMBERS)) errors.memberCount = 'Roughly how many members play? A number, like 40.';
  if (message.length > MAX_LEAD_MESSAGE) errors.message = `Your message can be up to ${MAX_LEAD_MESSAGE} characters.`;
  if (preferredTimes.length > MAX_PREFERRED_TIMES) errors.preferredTimes = `Up to ${MAX_PREFERRED_TIMES} characters, please.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: { clubName, suburb, contactName, contactEmail, contactPhone: phone || null, memberCount: count, message: message || null, preferredTimes: preferredTimes || null } };
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

/**
 * Saves a lead, and queues its acknowledgement, Attila's alert and the CRM sync, in one
 * transaction. A club that's already on file (same name) gets no new record and no acknowledgement
 * (so a form can't be used to make us email a stranger on someone else's behalf), but Attila is
 * still alerted: a second enquiry from a club is never dropped silently.
 */
export async function createLead(
  db: Db,
  input: LeadInput,
  opts: { isProduction: boolean; now: Date },
): Promise<{ clubId: string; created: boolean }> {
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO clubs (name, status, is_test, suburb, contact_name, contact_email, contact_phone, club_size, lead_message, preferred_times, created_at, updated_at, last_activity_at)
         VALUES ($1, 'lead', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10) RETURNING id`,
        [input.clubName, !opts.isProduction, input.suburb, input.contactName, input.contactEmail, input.contactPhone, input.memberCount, input.message, input.preferredTimes, opts.now],
      );
      const id = rows[0]!.id;
      await enqueueClubEmail(q, id, 'club_lead_ack', opts.now);
      await enqueueClubEmail(q, id, 'alert_club_lead', opts.now);
      await enqueueClubCrmSync(q, id, opts.now);
      return { clubId: id, created: true };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const { rows } = await db.query<{ id: string }>('SELECT id FROM clubs WHERE lower(name) = lower($1)', [input.clubName]);
    const id = rows[0]?.id;
    if (!id) throw err;
    // No last_activity_at bump: anyone can type a club's name, so a repeat enquiry must not keep a
    // lead from its 12-month deletion. Attila acting on it (any move or edit) does.
    await enqueueClubEmail(db, id, 'alert_club_lead', opts.now, { duplicate: true });
    return { clubId: id, created: false };
  }
}

// ── The pipeline ──────────────────────────────────────────────────────────────

/**
 * Where a club can be moved from each status: forward one step, back one step to correct a
 * mistake, or out to Inactive. Active clubs only go to Inactive, and an Inactive club comes back
 * as Active (it had been one) or as a Lead (it never became one).
 */
export const MOVES: Readonly<Record<ClubStatus, readonly ClubStatus[]>> = {
  lead: ['meeting', 'inactive'],
  meeting: ['lead', 'agreement_sent', 'inactive'],
  agreement_sent: ['meeting', 'active', 'inactive'],
  active: ['inactive'],
  inactive: ['lead', 'active'],
};

export const isClubStatus = (v: unknown): v is ClubStatus => typeof v === 'string' && (CLUB_STATUSES as readonly string[]).includes(v);

/** Moves a club along the pipeline. Active needs the billing details first (the database insists too). */
export async function moveClub(db: Db, id: string, to: unknown, now: Date): Promise<{ from: ClubStatus; to: ClubStatus }> {
  if (!isClubStatus(to)) throw new ClubError('bad_status', 'That isn’t a stage in the pipeline.');
  return db.tx(async (q) => {
    const { rows } = await q.query<{ status: ClubStatus; billing_name: string | null; billing_email: string | null; billing_address: string | null }>(
      'SELECT status, billing_name, billing_email, billing_address FROM clubs WHERE id = $1::uuid FOR UPDATE',
      [id],
    );
    const c = rows[0];
    if (!c) throw new ClubError('no_club', 'No such club.');
    if (!MOVES[c.status].includes(to)) throw new ClubError('bad_move', `A club can’t go from ${STATUS_LABELS[c.status]} to ${STATUS_LABELS[to]}.`);
    if (to === 'active' && !(c.billing_name && c.billing_email && c.billing_address)) {
      throw new ClubError('billing_needed', 'Add the club’s billing details (Edit the club) before making it Active: invoices go there.');
    }
    await q.query('UPDATE clubs SET status = $2, updated_at = $3, last_activity_at = $3 WHERE id = $1::uuid', [id, to, now]);
    await enqueueClubCrmSync(q, id, now);
    return { from: c.status, to };
  });
}

/** The meeting date for a lead (empty clears it). Notes are the club's notes, saved with the club form. */
export async function setMeetingDate(db: Queryable, id: string, meetingOn: string, now: Date): Promise<boolean> {
  const day = meetingOn.trim();
  if (day) {
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!ISO_DATE_RE.test(day) || Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(day)) throw new ClubError('bad_date', 'Give the meeting date.');
  }
  const { rows } = await db.query(
    `UPDATE clubs SET meeting_on = $2::date, updated_at = $3, last_activity_at = $3 WHERE id = $1::uuid RETURNING id`,
    [id, day || null, now],
  );
  return rows.length === 1;
}

/** A pipeline summary for the admin: clubs by status, leads first. */
export async function pipelineCounts(db: Queryable): Promise<Record<ClubStatus, number>> {
  const { rows } = await db.query<{ status: ClubStatus; n: number }>('SELECT status, count(*)::int AS n FROM clubs GROUP BY status');
  const out = Object.fromEntries(CLUB_STATUSES.map((s) => [s, 0])) as Record<ClubStatus, number>;
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

