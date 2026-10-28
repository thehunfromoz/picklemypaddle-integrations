/**
 * Order intake (SCRUM-65): turn the form's multipart fields into an order and store it as the
 * order of record, all or nothing.
 */
import { enqueueOrderEmail } from '../email/outbox.js';
import type { Db, Queryable } from '../db/db.js';
import { isUniqueViolation } from '../db/db.js';
import { hashToken, newReference, newStatusToken, normaliseEmail } from './model.js';
import { PhotoError, processPhoto, type PhotoStore, type ProcessedPhoto } from './photos.js';
import { MAX_PADDLES, validateOrder, type OrderErrors, type OrderInput, type PhotoInfo } from './rules.js';

/** Most form fields we'll look at: 9 order fields + 4 per paddle + a few control fields. */
export const MAX_FORM_ENTRIES = 9 + 4 * MAX_PADDLES + 6;

export interface ParsedForm {
  input: OrderInput;
  /** Photo files by paddle position. */
  files: { front: File | null; back: File | null }[];
  idempotencyKey: string | null;
  formToken: string | undefined;
  /** The hidden field people never see; anything in it means a bot. */
  honeypot: string;
}

/** Thrown when the multipart body itself is unusable (as opposed to invalid order details). */
export class BadFormError extends Error {}

const str = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v : '');
const isFile = (v: FormDataEntryValue | null | undefined): v is File => typeof v === 'object' && v !== null;
const info = (f: File | null): PhotoInfo | null => (f ? { name: f.name, size: f.size, type: f.type } : null);

/**
 * The form names paddles by a stable index (`paddles[3][brand]`) that survives removing a paddle
 * in the middle, so indices can have gaps. Positions (0, 1, 2…) follow index order, and errors
 * are reported by position, exactly as the site's form expects.
 */
export function parseOrderForm(fd: FormData): ParsedForm {
  let entries = 0;
  const indices = new Set<number>();
  for (const [key] of fd.entries()) {
    if (++entries > MAX_FORM_ENTRIES) throw new BadFormError('too many form fields');
    const m = /^paddles\[(\d{1,3})\]\[(brand|model|front|back)\]$/.exec(key);
    if (m) indices.add(Number(m[1]));
  }
  const ordered = [...indices].sort((a, b) => a - b);
  const paddles = ordered.map((i) => {
    const front = fd.get(`paddles[${i}][front]`);
    const back = fd.get(`paddles[${i}][back]`);
    return {
      brand: str(fd.get(`paddles[${i}][brand]`)),
      model: str(fd.get(`paddles[${i}][model]`)),
      front: isFile(front) && front.size > 0 ? front : null,
      back: isFile(back) && back.size > 0 ? back : null,
    };
  });
  const key = str(fd.get('idempotencyKey')).trim();
  return {
    input: {
      name: str(fd.get('name')),
      email: str(fd.get('email')),
      phone: str(fd.get('phone')),
      street: str(fd.get('street')),
      suburb: str(fd.get('suburb')),
      state: str(fd.get('state')),
      postcode: str(fd.get('postcode')),
      consent: str(fd.get('consent')) === 'yes',
      tournamentAck: str(fd.get('tournamentAck')) === 'yes',
      paddles: paddles.map((p) => ({ brand: p.brand, model: p.model, front: info(p.front), back: info(p.back) })),
    },
    files: paddles.map((p) => ({ front: p.front, back: p.back })),
    idempotencyKey: /^[A-Za-z0-9_-]{16,64}$/.test(key) ? key : null,
    formToken: str(fd.get('formToken')) || undefined,
    honeypot: str(fd.get('website')),
  };
}

export interface ProcessedPaddlePhotos {
  front: ProcessedPhoto;
  back: ProcessedPhoto;
}

/**
 * Checks the details with the shared rules, then decodes and re-encodes every photo. Returns the
 * field errors (by position) or the processed photos. Photos are processed one at a time to keep
 * memory bounded on the small VPS.
 */
export async function validateAndProcess(
  form: ParsedForm,
): Promise<{ errors: OrderErrors } | { errors: null; photos: ProcessedPaddlePhotos[] }> {
  const errors = validateOrder(form.input);
  if (Object.keys(errors).length > 0) return { errors };
  const photos: ProcessedPaddlePhotos[] = [];
  const photoErrors: OrderErrors = {};
  for (const [i, f] of form.files.entries()) {
    const out: Partial<ProcessedPaddlePhotos> = {};
    for (const side of ['front', 'back'] as const) {
      try {
        out[side] = await processPhoto(new Uint8Array(await f[side]!.arrayBuffer()), side);
      } catch (err) {
        if (!(err instanceof PhotoError)) throw err;
        photoErrors[`paddles.${i}.${side}`] = err.message;
      }
    }
    if (out.front && out.back) photos.push(out as ProcessedPaddlePhotos);
  }
  return Object.keys(photoErrors).length > 0 ? { errors: photoErrors } : { errors: null, photos };
}

export interface CreateOrderDeps {
  db: Db;
  photos: PhotoStore;
  isProduction: boolean;
  now: () => Date;
  /** Overridable so tests can force a reference clash. */
  newReference?: () => string;
}

export interface CreatedOrder {
  reference: string;
  /** The private status link's secret; only its hash is stored. */
  statusToken: string;
  /** True when an earlier submission with the same idempotency key was found. */
  replay: boolean;
  isTest: boolean;
}

/** Smoke-test orders (SCRUM-68) use @example.com addresses and are deleted after 24 hours. */
export const SMOKE_EMAIL_DOMAIN = '@example.com';

/**
 * An order placed with this idempotency key in the last 24 h, if any. A replay gets a fresh
 * status link for the same order (only the submitter knows the key), and nothing else is created.
 */
async function findReplay(q: Queryable, key: string, now: Date): Promise<{ id: string; reference: string; is_test: boolean } | null> {
  const { rows } = await q.query<{ id: string; reference: string; is_test: boolean; created_at: Date }>(
    'SELECT id, reference, is_test, created_at FROM orders WHERE idempotency_key = $1',
    [key],
  );
  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - new Date(row.created_at).getTime() <= 24 * 60 * 60 * 1000) return row;
  // Older than a day: the key no longer counts, so free it for this new order.
  await q.query('UPDATE orders SET idempotency_key = NULL WHERE id = $1', [row.id]);
  return null;
}

export async function findReplayOrder(deps: CreateOrderDeps, key: string | null): Promise<CreatedOrder | null> {
  if (!key) return null;
  return deps.db.tx(async (q) => {
    const row = await findReplay(q, key, deps.now());
    if (!row) return null;
    const statusToken = newStatusToken();
    await q.query('INSERT INTO status_tokens (order_id, token_hash) VALUES ($1, $2)', [row.id, hashToken(statusToken)]);
    return { reference: row.reference, statusToken, replay: true, isTest: row.is_test };
  });
}

/**
 * Stores the order, its paddles, photos, first status and a status-link token in ONE transaction.
 * Photo files are written inside it and deleted again if anything fails, so a failure leaves no
 * rows and no orphan files. A clash on the random reference is retried with a new one.
 */
export async function createOrder(
  deps: CreateOrderDeps,
  input: OrderInput,
  photos: ProcessedPaddlePhotos[],
  idempotencyKey: string | null,
): Promise<CreatedOrder> {
  const now = deps.now();
  const emailNorm = normaliseEmail(input.email);
  const isTest = !deps.isProduction;
  const isSmoke = isTest && emailNorm.endsWith(SMOKE_EMAIL_DOMAIN);
  const t = (v: string | undefined) => (v ?? '').trim();

  for (let attempt = 1; ; attempt++) {
    const written: string[] = [];
    try {
      return await deps.db.tx(async (q) => {
        if (idempotencyKey) {
          const replay = await findReplay(q, idempotencyKey, now);
          if (replay) {
            const statusToken = newStatusToken();
            await q.query('INSERT INTO status_tokens (order_id, token_hash) VALUES ($1, $2)', [replay.id, hashToken(statusToken)]);
            return { reference: replay.reference, statusToken, replay: true, isTest: replay.is_test };
          }
        }
        const reference = (deps.newReference ?? newReference)();
        const { rows } = await q.query<{ id: string }>(
          `INSERT INTO orders (reference, status, status_changed_at, is_test, is_smoke, name, email, email_norm, phone,
             street, suburb, state, postcode, consent_at, tournament_ack_at, idempotency_key, created_at, updated_at)
           VALUES ($1, 'submitted', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $2, $2, $13, $2, $2)
           RETURNING id`,
          [reference, now, isTest, isSmoke, t(input.name), t(input.email), emailNorm, t(input.phone) || null,
            t(input.street), t(input.suburb), input.state, t(input.postcode), idempotencyKey],
        );
        const orderId = rows[0]!.id;
        await q.query('INSERT INTO status_history (order_id, status, at, actor) VALUES ($1, $2, $3, $4)', [orderId, 'submitted', now, 'customer']);
        for (const [position, p] of input.paddles.entries()) {
          const { rows: pr } = await q.query<{ id: string }>(
            'INSERT INTO paddles (order_id, position, brand, model) VALUES ($1, $2, $3, $4) RETURNING id',
            [orderId, position, t(p.brand), t(p.model) || null],
          );
          for (const side of ['front', 'back'] as const) {
            const photo = photos[position]![side];
            const rel = await deps.photos.save(photo.data);
            written.push(rel);
            await q.query(
              'INSERT INTO photos (paddle_id, side, path, bytes, width, height) VALUES ($1, $2, $3, $4, $5, $6)',
              [pr[0]!.id, side, rel, photo.data.length, photo.width, photo.height],
            );
          }
        }
        const statusToken = newStatusToken();
        await q.query('INSERT INTO status_tokens (order_id, token_hash, created_at) VALUES ($1, $2, $3)', [
          orderId, hashToken(statusToken), now,
        ]);
        // SCRUM-69: the customer's confirmation and Attila's alert, queued with the order so they
        // go out exactly when it exists. Smoke-test orders send nothing.
        if (!isSmoke) {
          await enqueueOrderEmail(q, orderId, 'customer_submitted', now);
          await enqueueOrderEmail(q, orderId, 'alert_submitted', now);
        }
        return { reference, statusToken, replay: false, isTest };
      });
    } catch (err) {
      await Promise.all(written.map((rel) => deps.photos.remove(rel).catch(() => undefined)));
      if (attempt < 5 && isUniqueViolation(err, 'orders_reference_key')) continue;
      // Two identical submissions racing: the other one won, so answer as its replay.
      if (idempotencyKey && isUniqueViolation(err, 'orders_idempotency_key')) {
        const replay = await findReplayOrder(deps, idempotencyKey);
        if (replay) return replay;
      }
      throw err;
    }
  }
}

/** A believable reference for bots (honeypot, too fast): nothing is stored or sent. */
export function fakeOrder(isProduction: boolean): CreatedOrder {
  return { reference: newReference(), statusToken: newStatusToken(), replay: false, isTest: !isProduction };
}
