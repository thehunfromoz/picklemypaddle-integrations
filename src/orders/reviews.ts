/**
 * Reviews from customers (SCRUM-33, decided 28 Oct 2026).
 *
 * The Posted back email links to a short form on the private status page. A review needs a live
 * status link for an order that is Posted back or Completed, and each order takes one review.
 * Permission to quote is an explicit yes or no, recorded with its time; a review without
 * permission is still kept (it's feedback) but must never be published. Attila is alerted, and
 * adds the ones he wants, with permission, to the site's testimonials file by PR.
 *
 * First name and suburb are typed by the customer rather than pre-filled: the status page never
 * shows a name or address, because anyone holding the link can see it (SCRUM-70).
 */
import type { Db } from '../db/db.js';
import { isUniqueViolation } from '../db/db.js';
import { enqueueCrmSync } from '../crm/sync.js';
import { enqueueOrderEmail } from '../email/outbox.js';
import { orderForToken, REVIEW_STATUSES } from './status.js';

export const REVIEW_LIMITS = { quoteMin: 10, quoteMax: 600, firstNameMax: 40, suburbMax: 60 } as const;

export interface ReviewInput {
  token: unknown;
  quote: unknown;
  firstName: unknown;
  suburb: unknown;
  permission: unknown;
}

export type ReviewOutcome =
  | { ok: true; reference: string; permission: boolean }
  | { ok: false; reason: 'invalid_link' | 'not_yet' | 'already_received' }
  | { ok: false; reason: 'invalid'; errors: Record<string, string> };

const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
/** Letters (any language), spaces, apostrophes, hyphens and full stops. */
const NAME_RE = /^[\p{L}][\p{L}\p{M} '’.-]*$/u;

export function validateReview(input: ReviewInput): { errors: Record<string, string> } | { quote: string; firstName: string; suburb: string; permission: boolean } {
  const quote = typeof input.quote === 'string' ? input.quote.trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n') : '';
  const firstName = text(input.firstName);
  const suburb = text(input.suburb);
  const errors: Record<string, string> = {};
  if (quote.length < REVIEW_LIMITS.quoteMin) errors.quote = 'Tell us a little more (a sentence or two).';
  else if (quote.length > REVIEW_LIMITS.quoteMax) errors.quote = `Please keep it under ${REVIEW_LIMITS.quoteMax} characters.`;
  if (!firstName) errors.firstName = 'Enter your first name.';
  else if (firstName.length > REVIEW_LIMITS.firstNameMax || !NAME_RE.test(firstName)) errors.firstName = 'Enter just your first name.';
  if (!suburb) errors.suburb = 'Enter your suburb or town.';
  else if (suburb.length > REVIEW_LIMITS.suburbMax || !NAME_RE.test(suburb)) errors.suburb = 'Enter just your suburb or town.';
  if (typeof input.permission !== 'boolean') errors.permission = 'Choose whether we may quote you.';
  return Object.keys(errors).length ? { errors } : { quote, firstName, suburb, permission: input.permission as boolean };
}

export async function submitReview(db: Db, input: ReviewInput, now: Date): Promise<ReviewOutcome> {
  const order = await orderForToken(db, input.token, now);
  if (!order) return { ok: false, reason: 'invalid_link' };
  if (!REVIEW_STATUSES.has(order.status)) return { ok: false, reason: 'not_yet' };
  if (order.has_review) return { ok: false, reason: 'already_received' };
  const r = validateReview(input);
  if ('errors' in r) return { ok: false, reason: 'invalid', errors: r.errors };
  try {
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO reviews (order_id, quote, first_name, suburb, permission, permission_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, r.quote, r.firstName, r.suburb, r.permission, r.permission ? now : null, now],
      );
      await enqueueOrderEmail(q, order.id, 'alert_review', now, { permission: r.permission });
      // SCRUM-80: the deal's and the contact's "reviewed" flags.
      await enqueueCrmSync(q, order.id, now);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'already_received' };
    throw err;
  }
  return { ok: true, reference: order.reference, permission: r.permission };
}
