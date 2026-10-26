/** POST /api/orders end to end over a real Postgres engine (SCRUM-65, SCRUM-66). */
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createOrder } from '../src/orders/intake.js';
import { fsPhotoStore, processPhoto } from '../src/orders/photos.js';
import { REFERENCE_RE, TOKEN_RE } from '../src/orders/model.js';
import { count, makeApp, orderForm, photoFiles, post, type TestApp } from './helpers/app.js';
import { DB_BACKEND } from './helpers/db.js';
import * as img from './helpers/images.js';

let t: TestApp;
afterEach(async () => t?.close());

type Created = { reference: string; statusToken: string; test?: boolean };

describe(`POST /api/orders (${DB_BACKEND})`, () => {
  it('stores a 1-paddle order as Submitted and returns its reference and status token', async () => {
    t = await makeApp();
    const res = await post(t, await orderForm(t));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.reference).toMatch(REFERENCE_RE);
    expect(body.statusToken).toMatch(TOKEN_RE);
    expect(body.test).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['reference', 'statusToken', 'test']); // nothing personal

    const { rows } = await t.db.query<Record<string, unknown>>('SELECT * FROM orders');
    expect(rows).toHaveLength(1);
    const o = rows[0]!;
    expect(o.reference).toBe(body.reference);
    expect(o.status).toBe('submitted');
    expect(o.is_test).toBe(true);
    expect(o.email_norm).toBe('player@test.picklemypaddle.com');
    expect(o.consent_at).toBeTruthy();
    expect(o.tournament_ack_at).toBeTruthy();
    expect(await count(t.db, 'status_history')).toBe(1);
    expect(await count(t.db, 'paddles')).toBe(1);
    expect(await count(t.db, 'photos')).toBe(2);
    expect(await count(t.db, 'status_tokens')).toBe(1);
    // Only the token's hash is stored.
    const tok = await t.db.query<{ token_hash: Uint8Array }>('SELECT token_hash FROM status_tokens');
    expect(Buffer.from(tok.rows[0]!.token_hash).toString('base64url')).not.toBe(body.statusToken);
  });

  it('stores the processed photos on the private volume, metadata-free, under random names', async () => {
    t = await makeApp();
    const fd = await orderForm(t, { photo: await img.jpegWithGps(3000, 2000) });
    expect((await post(t, fd)).status).toBe(201);
    const files = await photoFiles(t.photoDir);
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(path.basename(f)).toMatch(/^[0-9a-f]{32}\.jpg$/);
      const meta = await sharp(await readFile(path.join(t.photoDir, f))).metadata();
      expect(meta.exif).toBeUndefined();
      expect(Math.max(meta.width!, meta.height!)).toBe(2560);
    }
    const { rows } = await t.db.query<{ path: string; side: string; width: number }>('SELECT path, side, width FROM photos ORDER BY side');
    expect(rows.map((r) => r.side)).toEqual(['back', 'front']);
    expect(rows.map((r) => r.path).sort()).toEqual([...files].sort());
  });

  it('takes 10 paddles, keeps their order and accepts gaps in the form\'s paddle indices', async () => {
    t = await makeApp();
    const indices = [0, 2, 3, 5, 6, 7, 9, 11, 12, 20];
    expect((await post(t, await orderForm(t, { indices }))).status).toBe(201);
    const { rows } = await t.db.query<{ position: number }>('SELECT position FROM paddles ORDER BY position');
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('refuses an 11th paddle with 400 and stores nothing', async () => {
    t = await makeApp();
    const res = await post(t, await orderForm(t, { paddles: 11 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Record<string, string> }).errors.paddles).toMatch(/up to 10/);
    expect(await count(t.db, 'orders')).toBe(0);
    expect(await photoFiles(t.photoDir)).toEqual([]);
  });

  it('refuses a missing photo with the form\'s field key', async () => {
    t = await makeApp();
    const fd = await orderForm(t, { paddles: 2 });
    fd.delete('paddles[1][back]');
    const res = await post(t, fd);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: { 'paddles.1.back': 'Add a photo of the back of the paddle.' } });
    expect(await count(t.db, 'orders')).toBe(0);
  });

  it('re-validates every field the browser checks (400 with keys the form can show)', async () => {
    t = await makeApp();
    const fd = await orderForm(t, { overrides: { email: 'nope', postcode: '20', state: 'XX', consent: '', tournamentAck: 'no' } });
    const res = await post(t, fd);
    expect(res.status).toBe(400);
    const { errors } = (await res.json()) as { errors: Record<string, string> };
    expect(Object.keys(errors).sort()).toEqual(['consent', 'email', 'postcode', 'state', 'tournamentAck']);
  });

  it('refuses a disguised file by its content, as a field error', async () => {
    t = await makeApp();
    const res = await post(t, await orderForm(t, { photo: img.svgPretendingToBeJpeg() }));
    expect(res.status).toBe(400);
    const { errors } = (await res.json()) as { errors: Record<string, string> };
    expect(errors['paddles.0.front']).toMatch(/JPEG, PNG or WebP/);
    expect(await photoFiles(t.photoDir)).toEqual([]);
  });

  it('answers a repeat with the same idempotency key with the same reference, creating nothing', async () => {
    t = await makeApp();
    const idem = 'k'.repeat(10) + Date.now();
    const first = (await (await post(t, await orderForm(t, { idempotencyKey: idem }))).json()) as Created;
    const res = await post(t, await orderForm(t, { idempotencyKey: idem }));
    expect(res.status).toBe(201);
    const again = (await res.json()) as Created;
    expect(again.reference).toBe(first.reference);
    expect(again.statusToken).toMatch(TOKEN_RE); // a fresh link to the same order
    expect(await count(t.db, 'orders')).toBe(1);
    expect(await count(t.db, 'photos')).toBe(2);
    expect(await photoFiles(t.photoDir)).toHaveLength(2);
  });

  it('treats the same key after 24 hours as a new order', async () => {
    t = await makeApp();
    const idem = 'resubmit-after-a-day-0001';
    const first = (await (await post(t, await orderForm(t, { idempotencyKey: idem }))).json()) as Created;
    t.clock.now = new Date(t.clock.now.getTime() + 25 * 60 * 60 * 1000);
    const second = (await (await post(t, await orderForm(t, { idempotencyKey: idem }))).json()) as Created;
    expect(second.reference).not.toBe(first.reference);
    expect(await count(t.db, 'orders')).toBe(2);
  });

  it('leaves no rows and no files when storing fails part-way (one transaction)', async () => {
    let saves = 0;
    t = await makeApp({
      photos: (dir) => {
        const real = fsPhotoStore(dir);
        return {
          ...real,
          async save(data) {
            if (++saves === 3) throw new Error('disk full (simulated)');
            return real.save(data);
          },
        };
      },
    });
    const res = await post(t, await orderForm(t, { paddles: 2 }));
    expect(res.status).toBe(500);
    for (const table of ['orders', 'paddles', 'photos', 'status_history', 'status_tokens']) {
      expect(await count(t.db, table)).toBe(0);
    }
    expect(await photoFiles(t.photoDir)).toEqual([]);
  });

  it('marks orders as TEST outside production only', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    expect(((await (await post(t, await orderForm(t))).json()) as Created).test).toBe(true);
    await t.close();

    t = await makeApp({ env: { APP_ENV: 'production' } });
    const res = await post(t, await orderForm(t));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Created).test).toBeUndefined();
    const { rows } = await t.db.query<{ is_test: boolean; is_smoke: boolean }>('SELECT is_test, is_smoke FROM orders');
    expect(rows[0]).toEqual({ is_test: false, is_smoke: false });
  });

  it('tags smoke-test orders (@example.com, outside production) for deletion after 24 h', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t, { email: 'smoke+run1@example.com' }));
    await post(t, await orderForm(t, { email: 'real@test.picklemypaddle.com' }));
    const { rows } = await t.db.query<{ email_norm: string; is_smoke: boolean }>('SELECT email_norm, is_smoke FROM orders ORDER BY email_norm');
    expect(rows).toEqual([
      { email_norm: 'real@test.picklemypaddle.com', is_smoke: false },
      { email_norm: 'smoke+run1@example.com', is_smoke: true },
    ]);
  });

  it('retries with a new reference when the random one is already taken', async () => {
    t = await makeApp();
    const first = (await (await post(t, await orderForm(t))).json()) as Created;
    const photo = await processPhoto(await img.jpeg(), 'front');
    let calls = 0;
    const order = await createOrder(
      { db: t.db, photos: t.photos, isProduction: false, now: () => t.clock.now, newReference: () => (++calls === 1 ? first.reference : 'PMP-ZZZZZ') },
      { name: 'B', email: 'b@test.picklemypaddle.com', street: 's', suburb: 's', state: 'NSW', postcode: '2000', consent: true, tournamentAck: true, paddles: [{ brand: 'X' }] },
      [{ front: photo, back: photo }],
      null,
    );
    expect(calls).toBe(2);
    expect(order.reference).toBe('PMP-ZZZZZ');
    expect(await count(t.db, 'orders')).toBe(2);
    expect(await photoFiles(t.photoDir)).toHaveLength(4); // the clashing attempt's files were removed
  });
});
