/**
 * Order rules shared by the website's form and the integrations service (SCRUM-65).
 *
 * ONE SOURCE OF TRUTH: this file is the original. The site carries a byte-identical copy at
 * picklemypaddle-site/src/lib/order-rules.ts, and the site's unit tests fail if the copy differs
 * from this file on main. Change it here first, then copy it to the site in the same breath.
 *
 * No imports and no runtime dependencies, so it compiles unchanged in both repos.
 * The browser uses it for fast, friendly feedback; the service re-checks everything with it.
 */

export const MAX_PADDLES = 10;
/** Per photo, after the browser has shrunk it (SCRUM-66). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Per request: 10 paddles × 2 photos would never all be 10 MB after shrinking (SCRUM-66). */
export const MAX_REQUEST_BYTES = 60 * 1024 * 1024;
/** Longest edge kept, in pixels, in the browser and on the server (SCRUM-66). */
export const MAX_PHOTO_EDGE = 2560;
/** HEIC/HEIF are left to iOS, which hands over a JPEG when the input doesn't accept HEIC. */
export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const;

/** Longest accepted value per text field (characters). Generous; stops junk, not people. */
export const MAX_LENGTHS = {
  name: 120,
  email: 254,
  phone: 30,
  street: 200,
  suburb: 80,
  brand: 60,
  model: 80,
} as const;

export interface PhotoInfo {
  name: string;
  size: number;
  type: string;
}

export interface PaddleInput {
  brand: string;
  model?: string;
  front?: PhotoInfo | null;
  back?: PhotoInfo | null;
}

export interface OrderInput {
  name: string;
  email: string;
  phone?: string;
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  consent: boolean;
  /** Accepts that a re-gritted paddle can't be used in sanctioned competitions. */
  tournamentAck: boolean;
  paddles: PaddleInput[];
}

/** Map of field key → message. Paddle keys use the paddle's position: `paddles.0.front`. */
export type OrderErrors = Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTCODE_RE = /^\d{4}$/;
const PHONE_RE = /^[+\d][\d\s()-]{7,}$/;

const text = (v: string | undefined | null): string => (v ?? '').trim();

export function validatePhoto(photo: PhotoInfo | null | undefined, label: string): string | null {
  if (!photo || photo.size === 0) return `Add a photo of the ${label} of the paddle.`;
  if (!ACCEPTED_PHOTO_TYPES.includes(photo.type.toLowerCase())) {
    return `The ${label} photo must be a JPEG, PNG or WebP image.`;
  }
  if (photo.size > MAX_PHOTO_BYTES) return `The ${label} photo must be 10 MB or smaller.`;
  return null;
}

export function validateOrder(input: OrderInput): OrderErrors {
  const errors: OrderErrors = {};
  const tooLong = (key: keyof typeof MAX_LENGTHS, value: string | undefined): boolean =>
    text(value).length > MAX_LENGTHS[key];

  if (!text(input.name)) errors.name = 'Enter your name.';
  else if (tooLong('name', input.name)) errors.name = 'Please shorten your name.';
  if (!EMAIL_RE.test(text(input.email)) || tooLong('email', input.email)) errors.email = 'Enter a valid email address.';
  if (text(input.phone) && (!PHONE_RE.test(text(input.phone)) || tooLong('phone', input.phone))) {
    errors.phone = 'Enter a valid phone number, or leave it blank.';
  }
  if (!text(input.street)) errors.street = 'Enter your street address.';
  else if (tooLong('street', input.street)) errors.street = 'Please shorten the street address.';
  if (!text(input.suburb)) errors.suburb = 'Enter your suburb.';
  else if (tooLong('suburb', input.suburb)) errors.suburb = 'Please shorten the suburb.';
  if (!(AU_STATES as readonly string[]).includes(input.state)) errors.state = 'Choose your state or territory.';
  if (!POSTCODE_RE.test(text(input.postcode))) errors.postcode = 'Enter a 4-digit postcode.';
  if (!input.consent) errors.consent = 'Please agree so we can store your details and photos to process your order.';
  if (!input.tournamentAck) errors.tournamentAck = 'Please confirm you understand a re-gritted paddle can\'t be used in sanctioned competitions or tournaments.';

  if (input.paddles.length === 0) errors.paddles = 'Add at least one paddle.';
  if (input.paddles.length > MAX_PADDLES) errors.paddles = `You can send up to ${MAX_PADDLES} paddles per order.`;

  input.paddles.slice(0, MAX_PADDLES).forEach((p, i) => {
    if (!text(p.brand)) errors[`paddles.${i}.brand`] = 'Enter the paddle brand.';
    else if (tooLong('brand', p.brand)) errors[`paddles.${i}.brand`] = 'Please shorten the brand.';
    if (tooLong('model', p.model)) errors[`paddles.${i}.model`] = 'Please shorten the model.';
    const front = validatePhoto(p.front, 'front');
    if (front) errors[`paddles.${i}.front`] = front;
    const back = validatePhoto(p.back, 'back');
    if (back) errors[`paddles.${i}.back`] = back;
  });

  return errors;
}
