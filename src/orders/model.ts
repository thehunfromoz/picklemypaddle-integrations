/**
 * Order statuses, references and private status-link tokens (SCRUM-65, SCRUM-70).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

/** The workflow decided on 26 Oct 2026 (docs/working-with-claude.md in infra). */
export const STATUSES = [
  'submitted',
  'questions',
  'accepted',
  'paid',
  'in_queue',
  'regritted',
  'posted_back',
  'completed',
  'rejected',
  'withdrawn',
  'lapsed',
] as const;
export type OrderStatus = (typeof STATUSES)[number];

/** What the customer reads on the status page. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  submitted: 'Received: we’re checking your photos',
  questions: 'We have a question: please check your email',
  accepted: 'Accepted: payment link sent',
  paid: 'Paid: waiting for your paddle to arrive',
  in_queue: 'Arrived: in the re-grit queue',
  regritted: 'Re-gritted: getting ready to post back',
  posted_back: 'Posted back to you',
  completed: 'Completed',
  rejected: 'Not accepted: see our email for why',
  withdrawn: 'Withdrawn',
  lapsed: 'Closed: no reply received',
};

// ── References ────────────────────────────────────────────────────────────────

/** No 0/O, 1/I/L: easy to read out over the phone or copy from a parcel label. */
export const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERENCE_RE = new RegExp(`^PMP-[${REFERENCE_ALPHABET}]{5}$`);

export function newReference(): string {
  let out = 'PMP-';
  for (let i = 0; i < 5; i++) out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return out;
}

// ── Status-link tokens ────────────────────────────────────────────────────────

/** 32 random bytes = 256 bits (the story asks for at least 128), as 43 URL-safe characters. */
export const TOKEN_BYTES = 32;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newStatusToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Only this goes in the database, so a leaked copy of it opens nothing. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

const DAY = 24 * 60 * 60 * 1000;

/** How long a link keeps working after the order reaches each closing status (SCRUM-70). */
export const LINK_GRACE_DAYS: Partial<Record<OrderStatus, number>> = {
  completed: 90,
  rejected: 30,
  lapsed: 30,
  withdrawn: 0,
};

/**
 * When an order's status links stop working: null while the order is open (no expiry yet),
 * otherwise the moment they expire. Deleted or erased orders have no row, so no link works.
 */
export function linkExpiresAt(status: OrderStatus, statusChangedAt: Date): Date | null {
  const grace = LINK_GRACE_DAYS[status];
  return grace === undefined ? null : new Date(statusChangedAt.getTime() + grace * DAY);
}

export function linkIsLive(status: OrderStatus, statusChangedAt: Date, now: Date): boolean {
  const expires = linkExpiresAt(status, statusChangedAt);
  return expires === null || now.getTime() < expires.getTime();
}

/** Lower-cased, trimmed: the form used for lookups and rate limits. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A$60 per paddle, both faces (decided 6 Oct 2026). Return postage is added by SCRUM-9. */
export const PRICE_PER_PADDLE_CENTS = 6000;
