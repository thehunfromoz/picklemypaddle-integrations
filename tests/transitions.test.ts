/**
 * Status transitions (the server-side core of SCRUM-72) and the emails they queue (SCRUM-69).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addBusinessDays, backInPostBy, sydneyDate } from '../src/orders/dates.js';
import { STATUSES, type OrderStatus } from '../src/orders/model.js';
import { canTransition, EMAIL_ON, TRANSITIONS, TransitionError, transitionOrder, type Actor } from '../src/orders/transitions.js';
import { DB_BACKEND } from './helpers/db.js';
import { makeApp, orderForm, post, type TestApp } from './helpers/app.js';

const ACTORS: Actor[] = ['admin', 'system', 'stripe'];

describe('transition table', () => {
  const allowed: [OrderStatus, OrderStatus, Actor][] = [
    ['submitted', 'questions', 'admin'], ['submitted', 'accepted', 'admin'], ['submitted', 'rejected', 'admin'], ['submitted', 'withdrawn', 'admin'],
    ['questions', 'accepted', 'admin'], ['questions', 'rejected', 'admin'], ['questions', 'withdrawn', 'admin'], ['questions', 'lapsed', 'system'],
    ['accepted', 'paid', 'stripe'], ['accepted', 'withdrawn', 'admin'], ['accepted', 'lapsed', 'system'],
    ['paid', 'in_queue', 'admin'], ['paid', 'withdrawn', 'admin'],
    ['in_queue', 'regritted', 'admin'],
    ['regritted', 'posted_back', 'admin'],
    ['posted_back', 'completed', 'admin'], ['posted_back', 'completed', 'system'],
  ];
  const key = (f: string, to: string, a: string) => `${f}>${to}>${a}`;
  const allowedKeys = new Set(allowed.map(([f, to, a]) => key(f, to, a)));

  it('allows exactly the agreed moves, by the agreed actor, in production', () => {
    for (const from of STATUSES) for (const to of STATUSES) for (const actor of ACTORS) {
      expect(canTransition(from, to, actor, true), key(from, to, actor)).toBe(allowedKeys.has(key(from, to, actor)));
    }
  });

  it('adds only "Mark paid (test)" outside production', () => {
    for (const from of STATUSES) for (const to of STATUSES) for (const actor of ACTORS) {
      const extra = from === 'accepted' && to === 'paid' && actor === 'admin';
      expect(canTransition(from, to, actor, false), key(from, to, actor)).toBe(allowedKeys.has(key(from, to, actor)) || extra);
    }
  });

  it('leaves the end states with nowhere to go', () => {
    for (const s of ['completed', 'rejected', 'withdrawn', 'lapsed'] as const) expect(TRANSITIONS[s]).toEqual({});
  });

  it('emails the customer at the key moments only', () => {
    expect(EMAIL_ON).toEqual({ accepted: 'accepted', in_queue: 'in_queue', posted_back: 'posted_back', rejected: 'rejected' });
  });
});

describe('business days', () => {
  it('counts 10 weekdays from the arrival day', () => {
    expect(addBusinessDays('2026-11-02', 10)).toBe('2026-11-16'); // Monday → Monday two weeks on
    expect(addBusinessDays('2026-11-06', 10)).toBe('2026-11-20'); // Friday → Friday
    expect(addBusinessDays('2026-11-07', 10)).toBe('2026-11-20'); // Saturday arrival counts from Monday
    expect(backInPostBy('2026-12-31')).toBe('2027-01-15'); // New Year's Day (an NSW holiday) is skipped
  });
  it('skips listed holidays', () => {
    expect(addBusinessDays('2026-12-24', 2, new Set(['2026-12-25', '2026-12-28']))).toBe('2026-12-30');
  });
  it('knows the Sydney date, not the UTC one', () => {
    expect(sydneyDate(new Date('2026-10-28T14:00:00Z'))).toBe('2026-10-29');
  });
});

describe(`transitionOrder (${DB_BACKEND})`, () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  async function newOrder(email = 'player@test.picklemypaddle.com'): Promise<string> {
    const res = await post(t, await orderForm(t, { email }));
    return ((await res.json()) as { reference: string }).reference;
  }
  const deps = (isProduction = false) => ({ db: t.db, isProduction, now: t.clock.now });
  const emails = async (ref: string) =>
    (await t.db.query<{ template: string; payload: Record<string, unknown> }>(
      `SELECT x.template, x.payload FROM outbox x JOIN orders o ON o.id = x.order_id
        WHERE o.reference = $1 AND x.kind = 'email' AND x.template NOT IN ('customer_submitted', 'alert_submitted') ORDER BY x.id`,
      [ref],
    )).rows;

  it('walks an order from Submitted to Completed, recording who did what and queuing one email per key moment', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder();
    const step = (to: OrderStatus, actor: Actor, extra = {}) => transitionOrder(deps(), { reference: ref, to, actor, ...extra });

    expect(await step('questions', 'admin', { note: 'Asked about the edge guard' })).toEqual({ reference: ref, from: 'submitted', to: 'questions' });
    expect(await emails(ref)).toEqual([]); // Questions sends nothing: Attila writes from info@
    await step('accepted', 'admin');
    await step('paid', 'admin'); // staging's "Mark paid (test)"
    await step('in_queue', 'admin', { arrivedOn: '2026-10-26' });
    await step('regritted', 'admin');
    await step('posted_back', 'admin', { trackingNumber: '33XYZ0123456789' });
    await step('completed', 'system');

    expect((await emails(ref)).map((e) => e.template)).toEqual(['accepted', 'in_queue', 'posted_back']);
    expect((await emails(ref))[1]!.payload).toEqual({ backInPostBy: '2026-11-09' });

    const { rows: order } = await t.db.query<{ status: string; tracking_number: string; arrived_on: string }>(
      'SELECT status, tracking_number, arrived_on::text AS arrived_on FROM orders WHERE reference = $1', [ref]);
    expect(order[0]).toEqual({ status: 'completed', tracking_number: '33XYZ0123456789', arrived_on: '2026-10-26' });

    const { rows: history } = await t.db.query<{ status: string; actor: string; note: string | null }>(
      'SELECT h.status, h.actor, h.note FROM status_history h JOIN orders o ON o.id = h.order_id WHERE o.reference = $1 ORDER BY h.id', [ref]);
    expect(history.map((h) => `${h.status}:${h.actor}`)).toEqual([
      'submitted:customer', 'questions:admin', 'accepted:admin', 'paid:admin', 'in_queue:admin', 'regritted:admin', 'posted_back:admin', 'completed:system',
    ]);
    expect(history[1]!.note).toBe('Asked about the edge guard');
  });

  it('refuses anything else with 409, and changes nothing', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder();
    const err = await transitionOrder(deps(), { reference: ref, to: 'posted_back', actor: 'admin', trackingNumber: 'X1' }).catch((e) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect([err.httpStatus, err.code]).toEqual([409, 'transition_not_allowed']);
    expect(await emails(ref)).toEqual([]);
    const lapse = await transitionOrder(deps(), { reference: ref, to: 'lapsed', actor: 'admin' }).catch((e) => e);
    expect(lapse.httpStatus).toBe(409);
  });

  it('has no "Mark paid (test)" in production', async () => {
    t = await makeApp({ env: { APP_ENV: 'production', RESEND_API_KEY: 're_testkey' } });
    const ref = await newOrder();
    await transitionOrder(deps(true), { reference: ref, to: 'accepted', actor: 'admin' });
    const err = await transitionOrder(deps(true), { reference: ref, to: 'paid', actor: 'admin' }).catch((e) => e);
    expect(err.httpStatus).toBe(409);
    expect((await transitionOrder(deps(true), { reference: ref, to: 'paid', actor: 'stripe' })).to).toBe('paid');
  });

  it('needs a reason to reject (sent to the customer) and a tracking number to post back (400)', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder();
    expect((await transitionOrder(deps(), { reference: ref, to: 'rejected', actor: 'admin', reason: '  ' }).catch((e) => e)).code).toBe('reason_required');
    await transitionOrder(deps(), { reference: ref, to: 'rejected', actor: 'admin', reason: 'The face is cracked.' });
    expect(await emails(ref)).toEqual([{ template: 'rejected', payload: { reason: 'The face is cracked.' } }]);

    const ref2 = await newOrder('player+2@test.picklemypaddle.com');
    for (const to of ['accepted', 'paid', 'in_queue', 'regritted'] as const) await transitionOrder(deps(), { reference: ref2, to, actor: 'admin' });
    expect((await transitionOrder(deps(), { reference: ref2, to: 'posted_back', actor: 'admin' }).catch((e) => e)).code).toBe('tracking_required');
    expect((await transitionOrder(deps(), { reference: ref2, to: 'posted_back', actor: 'admin', trackingNumber: '<script>' }).catch((e) => e)).code).toBe('tracking_invalid');
  });

  it('refuses an arrival date in the future, and defaults it to today in Sydney', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder();
    for (const to of ['accepted', 'paid'] as const) await transitionOrder(deps(), { reference: ref, to, actor: 'admin' });
    expect((await transitionOrder(deps(), { reference: ref, to: 'in_queue', actor: 'admin', arrivedOn: '2099-01-01' }).catch((e) => e)).code).toBe('arrival_invalid');
    await transitionOrder(deps(), { reference: ref, to: 'in_queue', actor: 'admin' });
    const { rows } = await t.db.query<{ d: string }>('SELECT arrived_on::text AS d FROM orders WHERE reference = $1', [ref]);
    expect(rows[0]!.d).toBe(sydneyDate(t.clock.now));
  });

  it('queues nothing for smoke-test orders, and 404s an unknown reference', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder('smoke+r1@example.com');
    await transitionOrder(deps(), { reference: ref, to: 'accepted', actor: 'admin' });
    expect(await emails(ref)).toEqual([]);
    expect((await transitionOrder(deps(), { reference: 'PMP-ZZZZZ', to: 'accepted', actor: 'admin' }).catch((e) => e)).httpStatus).toBe(404);
  });
});

describe(`price frozen at Accept (SCRUM-81, ${DB_BACKEND})`, () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  async function newOrder(extra: { paddles?: number; postcode?: string } = {}): Promise<string> {
    const fd = await orderForm(t, { email: 'player@test.picklemypaddle.com', paddles: extra.paddles });
    if (extra.postcode) fd.set('postcode', extra.postcode);
    const res = await post(t, fd);
    expect(res.status).toBe(201);
    return ((await res.json()) as { reference: string }).reference;
  }
  const accept = (ref: string, extra: Record<string, unknown> = {}, tax: { gstRegisteredFrom: string | null } = { gstRegisteredFrom: null }) =>
    transitionOrder({ db: t.db, isProduction: false, now: t.clock.now, tax }, { reference: ref, to: 'accepted', actor: 'admin', ...extra });
  const saved = async (ref: string) =>
    (await t.db.query<Record<string, unknown>>(
      `SELECT amount_cents, subtotal_cents, discount_cents, postage_cents, postage_quoted_cents, postage_override_reason,
              gst_cents, tax_treatment, terms_version, terms_date::text AS terms_date
         FROM orders WHERE reference = $1`,
      [ref],
    )).rows[0]!;
  const acceptedEmail = async (ref: string) =>
    (await t.db.query<{ payload: Record<string, unknown> }>(
      `SELECT x.payload FROM outbox x JOIN orders o ON o.id = x.order_id WHERE o.reference = $1 AND x.template = 'accepted'`,
      [ref],
    )).rows[0]!.payload;
  const historyNote = async (ref: string) =>
    (await t.db.query<{ note: string | null }>(
      `SELECT h.note FROM status_history h JOIN orders o ON o.id = h.order_id WHERE o.reference = $1 AND h.status = 'accepted'`,
      [ref],
    )).rows[0]!.note;

  it('saves re-grit, calculated postage, total and the terms, and emails the same figures', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder({ paddles: 2 });
    await accept(ref);
    expect(await saved(ref)).toEqual({
      amount_cents: 14225, subtotal_cents: 12000, discount_cents: 0, postage_cents: 2225, postage_quoted_cents: 2225,
      postage_override_reason: null, gst_cents: 0, tax_treatment: 'not_registered', terms_version: 'price:2026-01-01;gst:none',
      terms_date: sydneyDate(t.clock.now),
    });
    expect(await acceptedEmail(ref)).toEqual({ amountCents: 14225, subtotalCents: 12000, postageCents: 2225, gstCents: 0, taxTreatment: 'not_registered' });
  });

  it('includes GST from the registration day, and leaves orders accepted before it unchanged', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const before = await newOrder();
    await accept(before); // not registered yet
    const after = await newOrder();
    // The GST date is set (and the service restarted): today is now on or after it.
    await accept(after, {}, { gstRegisteredFrom: sydneyDate(t.clock.now) });
    expect(await saved(before)).toMatchObject({ amount_cents: 8225, gst_cents: 0, tax_treatment: 'not_registered' });
    expect(await saved(after)).toMatchObject({ amount_cents: 8225, gst_cents: 748, tax_treatment: 'gst_inclusive' });
    expect((await saved(after)).terms_version).toBe(`price:2026-01-01;gst:from-${sydneyDate(t.clock.now)}`);
  });

  it('needs a reason to charge postage other than the calculated amount, and records it', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder();
    const err = await accept(ref, { postageCents: 1500 }).catch((e) => e);
    expect([err.httpStatus, err.code]).toEqual([400, 'postage_reason_required']);
    expect((await saved(ref)).amount_cents).toBeNull();

    // The calculated amount typed back in is not an override.
    const same = await newOrder();
    await accept(same, { postageCents: 2225 });
    expect(await saved(same)).toMatchObject({ postage_cents: 2225, postage_override_reason: null });

    await accept(ref, { postageCents: 1500, postageReason: 'Two paddles going in one bag with order PMP-ABCDE' });
    expect(await saved(ref)).toMatchObject({ amount_cents: 7500, postage_cents: 1500, postage_quoted_cents: 2225, postage_override_reason: 'Two paddles going in one bag with order PMP-ABCDE' });
    expect(await historyNote(ref)).toBe('Postage overridden: A$22.25 → A$15.00. Reason: Two paddles going in one bag with order PMP-ABCDE');
  });

  it('needs the postage typed in, with a reason, when it can’t be calculated', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder({ paddles: 10, postcode: '6798' }); // over 5 kg, to Christmas Island
    expect((await accept(ref).catch((e) => e)).code).toBe('postage_required');
    expect((await accept(ref, { postageCents: 9000 }).catch((e) => e)).code).toBe('postage_reason_required');
    await accept(ref, { postageCents: 9000, postageReason: 'Quoted at the post office' });
    expect(await saved(ref)).toMatchObject({ amount_cents: 69000, postage_cents: 9000, postage_quoted_cents: null });
    expect(await historyNote(ref)).toMatch(/^Postage entered by hand: A\$90\.00 .*Reason: Quoted at the post office$/);
  });

  it('refuses a negative or absurd postage', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const ref = await newOrder();
    for (const postageCents of [-1, 100_001, 12.5]) {
      expect((await accept(ref, { postageCents, postageReason: 'x' }).catch((e) => e)).code, String(postageCents)).toBe('postage_invalid');
    }
  });
});
