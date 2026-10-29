/**
 * The queue (SCRUM-73 AC1, AC3, AC4, AC5): the stored promise, "paddles ahead of yours", what the
 * status API shows when, and the admin's flags.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { paddlesAhead } from '../src/orders/queue.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

let n = 0;
async function place(paddles = 1, env: 'test' | 'real' = 'test'): Promise<{ reference: string; token: string }> {
  const res = await post(t, await orderForm(t, { paddles, email: `q${++n}@test.picklemypaddle.com` }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { reference: string; statusToken: string };
  if (env === 'real') await t.db.query('UPDATE orders SET is_test = false WHERE reference = $1', [body.reference]);
  return { reference: body.reference, token: body.statusToken };
}

/** Accepted → Paid → In queue, arriving on `arrivedOn`. */
async function queue(reference: string, arrivedOn: string) {
  for (const [to, extra] of [['accepted', {}], ['paid', {}], ['in_queue', { arrivedOn }]] as const) {
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to, actor: 'admin', ...extra });
  }
}

const status = async (token: string) => {
  const res = await t.app.request('/api/orders/status', {
    method: 'POST',
    body: JSON.stringify({ token }),
    headers: { 'Content-Type': 'application/json', Origin: SITE },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; backInPostBy: string | null; paddlesAhead: number | null; queuePosition: null };
};

const row = async (reference: string) =>
  (
    await t.db.query<{ id: string; reference: string; arrived_on: string; promise_on: string | null; is_test: boolean }>(
      'SELECT id, reference, arrived_on::text AS arrived_on, promise_on::text AS promise_on, is_test FROM orders WHERE reference = $1',
      [reference],
    )
  ).rows[0]!;

describe('the promise (AC1, AC4)', () => {
  it('is stored when the order enters In queue, and the In queue email carries the same date', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-12-21T01:00:00Z'); // Monday 21 Dec in Sydney
    const o = await place();
    await queue(o.reference, '2026-12-18');
    expect((await row(o.reference)).promise_on).toBe('2027-01-06'); // Christmas, the additional day and New Year skipped
    const { rows } = await t.db.query<{ payload: { backInPostBy?: string } }>(
      `SELECT ob.payload FROM outbox ob JOIN orders o ON o.id = ob.order_id WHERE o.reference = $1 AND ob.template = 'in_queue'`,
      [o.reference],
    );
    expect(rows[0]!.payload.backInPostBy).toBe('2027-01-06');
  });
});

describe('paddles ahead of yours (AC3)', () => {
  it('counts the paddles of orders queued earlier, ties broken by reference', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-10T01:00:00Z');
    const a = await place(2);
    const b = await place(3);
    const c = await place(1);
    await queue(a.reference, '2026-11-02');
    await queue(b.reference, '2026-11-03');
    await queue(c.reference, '2026-11-03');
    expect(await paddlesAhead(t.db, await row(a.reference))).toBe(0);
    // b and c arrived the same day: the lower reference goes first.
    const [first, second] = b.reference < c.reference ? [b, c] : [c, b];
    const firstPaddles = first === b ? 3 : 1;
    expect(await paddlesAhead(t.db, await row(first.reference))).toBe(2);
    expect(await paddlesAhead(t.db, await row(second.reference))).toBe(2 + firstPaddles);
  });

  it('stops counting orders once they leave the queue', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-10T01:00:00Z');
    const a = await place(2);
    const b = await place(1);
    await queue(a.reference, '2026-11-02');
    await queue(b.reference, '2026-11-03');
    expect((await status(b.token)).paddlesAhead).toBe(2);
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference: a.reference, to: 'regritted', actor: 'admin' });
    expect((await status(b.token)).paddlesAhead).toBe(0);
  });

  it('counts TEST orders only among TEST orders, and real orders only among real ones', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-10T01:00:00Z');
    const testEarly = await place(4, 'test');
    const realEarly = await place(2, 'real');
    const testLate = await place(1, 'test');
    const realLate = await place(1, 'real');
    await queue(testEarly.reference, '2026-11-02');
    await queue(realEarly.reference, '2026-11-02');
    await queue(testLate.reference, '2026-11-04');
    await queue(realLate.reference, '2026-11-04');
    expect((await status(testLate.token)).paddlesAhead).toBe(4);
    expect((await status(realLate.token)).paddlesAhead).toBe(2);
  });
});

describe('what the status API shows when (AC3)', () => {
  it('gives the date for In queue and Re-gritted, the position for In queue only', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-10T01:00:00Z');
    const o = await place();
    const step = (to: string, extra: Record<string, string> = {}) =>
      transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference: o.reference, to: to as never, actor: 'admin', ...extra });

    for (const to of ['submitted', 'accepted', 'paid'] as const) {
      if (to !== 'submitted') await step(to);
      const v = await status(o.token);
      expect(v, to).toMatchObject({ backInPostBy: null, paddlesAhead: null, queuePosition: null });
    }
    await step('in_queue', { arrivedOn: '2026-11-06' });
    expect(await status(o.token)).toMatchObject({ status: 'in_queue', backInPostBy: '2026-11-20', paddlesAhead: 0 });
    await step('regritted');
    expect(await status(o.token)).toMatchObject({ status: 'regritted', backInPostBy: '2026-11-20', paddlesAhead: null });
    await step('posted_back', { trackingNumber: 'AP1' });
    expect(await status(o.token)).toMatchObject({ backInPostBy: null, paddlesAhead: null });
  });

  it('works out the date for an order queued before promises were stored', async () => {
    t = await makeApp();
    t.clock.now = new Date('2026-11-10T01:00:00Z');
    const o = await place();
    await queue(o.reference, '2026-11-06');
    await t.db.query('UPDATE orders SET promise_on = NULL WHERE reference = $1', [o.reference]);
    expect((await status(o.token)).backInPostBy).toBe('2026-11-20');
  });
});

describe('the admin shows and flags promises (AC5)', () => {
  it('lists the date, and flags orders within 2 business days of it or past it', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    t.clock.now = new Date('2026-11-09T01:00:00Z');
    const o = await place();
    await queue(o.reference, '2026-11-06'); // promised Fri 20 Nov

    let list = await (await a.get('/admin/orders')).text();
    expect(list).toContain('back in the post by Fri, 20 Nov');
    expect(list).not.toContain('Due soon');

    t.clock.now = new Date('2026-11-18T01:00:00Z'); // Wed 18 Nov
    list = await (await a.get('/admin/orders')).text();
    expect(list).toContain('<span class="badge due">Due soon</span>');
    expect(list).toContain('1 order due back in the post within 2 business days.');

    t.clock.now = new Date('2026-11-23T01:00:00Z'); // Mon 23 Nov
    list = await (await a.get('/admin/orders')).text();
    expect(list).toContain('Past promise');
    expect(list).toContain('1 order past the “back in the post by” date.');
    const page = await (await a.get(`/admin/orders/${o.reference}`)).text();
    expect(page).toContain('<dt>Back in the post by</dt><dd>20 Nov 2026');
  });
});
