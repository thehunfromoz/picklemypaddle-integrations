/** Smoke-test orders are deleted after 24 hours, photos included (SCRUM-68). */
import { afterEach, describe, expect, it } from 'vitest';
import { deleteOldSmokeOrders } from '../src/jobs.js';
import { pruneRateLimitEvents } from '../src/orders/abuse.js';
import { count, makeApp, orderForm, photoFiles, post, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => t?.close());

describe('housekeeping jobs', () => {
  it('deletes smoke orders older than 24 h and their photo files, and nothing else', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t, { email: 'smoke+old@example.com' }));
    await post(t, await orderForm(t, { email: 'real@test.picklemypaddle.com' }));
    t.clock.now = new Date(t.clock.now.getTime() + 20 * 60 * 60 * 1000);
    await post(t, await orderForm(t, { email: 'smoke+new@example.com' }));
    expect(await photoFiles(t.photoDir)).toHaveLength(6);

    const deleted = await deleteOldSmokeOrders(t.db, t.photos, new Date(t.clock.now.getTime() + 5 * 60 * 60 * 1000));
    expect(deleted).toBe(1);
    const { rows } = await t.db.query<{ email_norm: string }>('SELECT email_norm FROM orders ORDER BY 1');
    expect(rows.map((r) => r.email_norm)).toEqual(['real@test.picklemypaddle.com', 'smoke+new@example.com']);
    expect(await count(t.db, 'photos')).toBe(4);
    expect(await photoFiles(t.photoDir)).toHaveLength(4);
  });

  it('prunes rate-limit history older than two days', async () => {
    t = await makeApp();
    await post(t, await orderForm(t));
    expect(await count(t.db, 'rate_limit_events')).toBe(2);
    expect(await pruneRateLimitEvents(t.db, new Date(t.clock.now.getTime() + 47 * 60 * 60 * 1000))).toBe(0);
    expect(await pruneRateLimitEvents(t.db, new Date(t.clock.now.getTime() + 49 * 60 * 60 * 1000))).toBe(2);
  });
});
