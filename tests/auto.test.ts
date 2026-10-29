/**
 * Automatic status changes (SCRUM-72 AC5): Posted back → Completed after 10 days, Questions →
 * Lapsed after 30 days without a status change. Daily and idempotent; recorded as "system".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runAutoTransitions } from '../src/orders/auto.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { makeApp, orderForm, post, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const DAY = 24 * 60 * 60 * 1000;

async function placeOrder(email: string): Promise<string> {
  const res = await post(t, await orderForm(t, { email }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { reference: string }).reference;
}

/** Moves an order along as admin, at the test clock's time. */
async function walk(reference: string, ...steps: [string, Record<string, string>?][]) {
  for (const [to, extra] of steps) {
    await transitionOrder(
      { db: t.db, isProduction: false, now: t.clock.now },
      { reference, to: to as never, actor: 'admin', ...(extra ?? {}) },
    );
  }
}

const statusOf = async (reference: string) =>
  (await t.db.query<{ status: string }>('SELECT status FROM orders WHERE reference = $1', [reference])).rows[0]!.status;

const lastHistory = async (reference: string) =>
  (
    await t.db.query<{ status: string; actor: string; note: string | null }>(
      'SELECT h.status, h.actor, h.note FROM status_history h JOIN orders o ON o.id = h.order_id WHERE o.reference = $1 ORDER BY h.at DESC, h.id DESC LIMIT 1',
      [reference],
    )
  ).rows[0]!;

describe('automatic status changes', () => {
  it('completes an order 10 days after it was posted back, as "system", and not a moment before', async () => {
    t = await makeApp();
    const ref = await placeOrder('a@test.picklemypaddle.com');
    await walk(ref, ['accepted'], ['paid'], ['in_queue'], ['regritted'], ['posted_back', { trackingNumber: 'AP123' }]);
    const postedAt = t.clock.now.getTime();

    expect(await runAutoTransitions(t.db, new Date(postedAt + 10 * DAY - 60_000), false)).toEqual({ completed: 0, lapsed: 0 });
    expect(await statusOf(ref)).toBe('posted_back');

    expect(await runAutoTransitions(t.db, new Date(postedAt + 10 * DAY), false)).toEqual({ completed: 1, lapsed: 0 });
    expect(await statusOf(ref)).toBe('completed');
    expect(await lastHistory(ref)).toMatchObject({ status: 'completed', actor: 'system', note: 'Automatic: 10 days after posting back.' });
  });

  it('lapses an order after 30 days in Questions with no status change', async () => {
    t = await makeApp();
    const ref = await placeOrder('b@test.picklemypaddle.com');
    await walk(ref, ['questions']);
    const askedAt = t.clock.now.getTime();

    expect((await runAutoTransitions(t.db, new Date(askedAt + 29 * DAY), false)).lapsed).toBe(0);
    expect((await runAutoTransitions(t.db, new Date(askedAt + 30 * DAY), false)).lapsed).toBe(1);
    expect(await statusOf(ref)).toBe('lapsed');
    expect(await lastHistory(ref)).toMatchObject({ status: 'lapsed', actor: 'system' });
  });

  it('is idempotent: a second run changes nothing and queues nothing', async () => {
    t = await makeApp();
    const ref = await placeOrder('c@test.picklemypaddle.com');
    await walk(ref, ['questions']);
    const later = new Date(t.clock.now.getTime() + 31 * DAY);
    await runAutoTransitions(t.db, later, false);
    const count = async () => Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM status_history')).rows[0]!.n);
    const before = await count();
    expect(await runAutoTransitions(t.db, later, false)).toEqual({ completed: 0, lapsed: 0 });
    expect(await count()).toBe(before);
  });

  it('leaves other statuses alone however old they are (Accepted lapsing is Stripe’s job, SCRUM-9)', async () => {
    t = await makeApp();
    const submitted = await placeOrder('d@test.picklemypaddle.com');
    const accepted = await placeOrder('e@test.picklemypaddle.com');
    await walk(accepted, ['accepted']);
    expect(await runAutoTransitions(t.db, new Date(t.clock.now.getTime() + 400 * DAY), true)).toEqual({ completed: 0, lapsed: 0 });
    expect(await statusOf(submitted)).toBe('submitted');
    expect(await statusOf(accepted)).toBe('accepted');
  });

  it('counts each order from when it entered Questions, not from when it was placed', async () => {
    t = await makeApp();
    const ref = await placeOrder('f@test.picklemypaddle.com');
    await walk(ref, ['questions']);
    t.clock.now = new Date(t.clock.now.getTime() + 20 * DAY);
    const ref2 = await placeOrder('g@test.picklemypaddle.com');
    await walk(ref2, ['questions']);
    const day31 = new Date(t.clock.now.getTime() + 11 * DAY);
    expect((await runAutoTransitions(t.db, day31, false)).lapsed).toBe(1);
    expect(await statusOf(ref)).toBe('lapsed');
    expect(await statusOf(ref2)).toBe('questions');
  });
});
