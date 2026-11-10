/**
 * The local pickup and drop-off service area (SCRUM-102). One list of suburbs
 * (`service-area-suburbs.json`) is the single source of truth: never copy suburbs into code.
 *
 * COPIED BYTE-FOR-BYTE into the site (`src/lib/service-area.ts`, with the JSON beside it), like
 * `src/orders/rules.ts`: change this one first. It imports nothing but the JSON, so it runs in
 * both. It only ever answers "is this venue inside the area?", which sets a club's DEFAULT method
 * (local pickup or post); an admin can override it per club.
 */
import data from './service-area-suburbs.json' with { type: 'json' };

export type Fulfilment = 'local' | 'postal';

/** The list's own version (its date): stored on each club, so a later list change doesn't silently change existing clubs. */
export const SERVICE_AREA_VERSION: string = data.version;

/** The suburbs, as the Clubs page lists them. */
export const SERVICE_AREA_SUBURBS: readonly { suburb: string; state: string; postcodes: readonly string[] }[] = data.suburbs;

/** Lower case, trimmed, spaces collapsed; punctuation dropped; "St"/"Saint" and "Mt"/"Mount" alike; a trailing "NSW" ignored. */
export function normaliseSuburb(raw: string): string {
  let s = raw.normalize('NFKC').toLowerCase().replace(/[.’'`]/g, '').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(?:^| )nsw$/, '').trim();
  return s
    .split(' ')
    .map((w) => (w === 'st' ? 'saint' : w === 'mt' ? 'mount' : w))
    .join(' ');
}

const normalisePostcode = (raw: string | null | undefined) => (raw ?? '').replace(/\s+/g, '');

const BY_NAME: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const s of data.suburbs) {
    const key = normaliseSuburb(s.suburb);
    const set = m.get(key) ?? new Set<string>();
    for (const p of s.postcodes) set.add(p);
    m.set(key, set);
  }
  return m;
})();

export interface VenueCheck {
  inside: boolean;
  /** Why: the suburb is on the list (and the postcode, if given, fits), isn't on it, or is on it with a different postcode. */
  reason: 'match' | 'unknown_suburb' | 'postcode_mismatch';
  /** True when a person should look: several NSW suburb names exist in more than one place. */
  needsReview: boolean;
}

/**
 * Inside = the suburb name matches AND (no postcode given OR the postcode is one of that suburb's).
 * A suburb that matches with a postcode that doesn't is outside and flagged for review. An unknown suburb is outside.
 */
export function checkServiceArea(venue: { suburb: string; postcode?: string | null }): VenueCheck {
  const postcodes = BY_NAME.get(normaliseSuburb(venue.suburb ?? ''));
  if (!postcodes) return { inside: false, reason: 'unknown_suburb', needsReview: false };
  const postcode = normalisePostcode(venue.postcode);
  if (!postcode || postcodes.has(postcode)) return { inside: true, reason: 'match', needsReview: false };
  return { inside: false, reason: 'postcode_mismatch', needsReview: true };
}

export const isInServiceArea = (venue: { suburb: string; postcode?: string | null }): boolean => checkServiceArea(venue).inside;

/** The default method for a club at this venue: local pickup and drop-off inside the area, post outside. */
export const defaultFulfilment = (venue: { suburb: string; postcode?: string | null }): Fulfilment => (isInServiceArea(venue) ? 'local' : 'postal');

export const FULFILMENT_LABELS: Record<Fulfilment, string> = { local: 'Local pickup and drop-off', postal: 'Post' };
