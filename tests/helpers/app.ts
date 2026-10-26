/** Builds the app over a fresh database and a temporary photo folder. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/db.js';
import { issueFormToken, loadAbuseKeys, TrustedProxies } from '../../src/orders/abuse.js';
import { fsPhotoStore, type PhotoStore } from '../../src/orders/photos.js';
import type { LinksMailer } from '../../src/orders/status.js';
import { testDb } from './db.js';
import { jpeg } from './images.js';

export const SITE = 'http://localhost:4321';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  photoDir: string;
  photos: PhotoStore;
  clock: { now: Date };
  /** A form token issued `secondsAgo` before the clock's current time. */
  formToken(secondsAgo?: number): string;
  peer: { address: string };
  close(): Promise<void>;
}

export async function makeApp(
  opts: { env?: Record<string, string>; photos?: (dir: string) => PhotoStore; mailer?: LinksMailer; db?: Db } = {},
): Promise<TestApp> {
  const db = opts.db ?? (await testDb());
  const photoDir = await mkdtemp(path.join(tmpdir(), 'pmp-photos-'));
  const photos = opts.photos ? opts.photos(photoDir) : fsPhotoStore(photoDir);
  const config = loadConfig({
    APP_ENV: 'development',
    PUBLIC_SITE_ORIGIN: SITE,
    DATABASE_URL: 'postgres://u:p@localhost:5432/test',
    PHOTO_DIR: photoDir,
    ...opts.env,
  });
  const keys = await loadAbuseKeys(db);
  const clock = { now: new Date('2026-10-26T01:00:00Z') };
  const peer = { address: '203.0.113.7' };
  let closed = false;
  const app = createApp(config, {
    db,
    photos,
    keys,
    trusted: new TrustedProxies(config.TRUSTED_PROXIES),
    mailer: opts.mailer ?? null,
    now: () => clock.now,
    peer: () => peer.address,
  });
  return {
    app,
    db,
    photoDir,
    photos,
    clock,
    peer,
    formToken: (secondsAgo = 30) => issueFormToken(keys.formKey, new Date(clock.now.getTime() - secondsAgo * 1000)),
    async close() {
      if (closed) return;
      closed = true;
      await db.close();
      await rm(photoDir, { recursive: true, force: true });
    },
  };
}

/** Every file under the photo folder (relative paths). */
export async function photoFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of await readdir(dir).catch(() => [] as string[])) {
    for (const f of await readdir(path.join(dir, sub)).catch(() => [] as string[])) out.push(path.join(sub, f));
  }
  return out;
}

let cachedJpeg: Buffer | undefined;
export async function smallJpeg(): Promise<Buffer> {
  cachedJpeg ??= await jpeg();
  return cachedJpeg;
}

export interface OrderFormOptions {
  paddles?: number;
  email?: string;
  formToken?: string;
  idempotencyKey?: string;
  honeypot?: string;
  photo?: Buffer;
  photoType?: string;
  overrides?: Record<string, string>;
  /** Paddle indices to use (the form's stable indices can have gaps). */
  indices?: number[];
}

/** A valid multipart order, as the site's form sends it. */
export async function orderForm(t: TestApp, o: OrderFormOptions = {}): Promise<FormData> {
  const fd = new FormData();
  const fields: Record<string, string> = {
    name: 'Test Player',
    email: o.email ?? 'player@test.picklemypaddle.com',
    phone: '0412 345 678',
    street: '1 Court St',
    suburb: 'Sydney',
    state: 'NSW',
    postcode: '2000',
    consent: 'yes',
    tournamentAck: 'yes',
    formToken: o.formToken ?? t.formToken(),
    website: o.honeypot ?? '',
    ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}),
    ...o.overrides,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const photo = o.photo ?? (await smallJpeg());
  const indices = o.indices ?? Array.from({ length: o.paddles ?? 1 }, (_, i) => i);
  for (const i of indices) {
    fd.set(`paddles[${i}][brand]`, 'Selkirk');
    fd.set(`paddles[${i}][model]`, 'Vanguard Power Air');
    fd.set(`paddles[${i}][front]`, new File([new Uint8Array(photo)], 'front.jpg', { type: o.photoType ?? 'image/jpeg' }));
    fd.set(`paddles[${i}][back]`, new File([new Uint8Array(photo)], 'back.jpg', { type: o.photoType ?? 'image/jpeg' }));
  }
  return fd;
}

export const post = (t: TestApp, fd: FormData, headers: Record<string, string> = {}) =>
  t.app.request('/api/orders', { method: 'POST', body: fd, headers: { Origin: SITE, ...headers } });

export const count = async (db: Db, table: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
