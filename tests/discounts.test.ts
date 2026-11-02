/**
 * Discount codes (SCRUM-63): the rules, the form's check, reserve at submit, consume at Paid,
 * release on Rejected/Withdrawn/Lapsed, the discount fixed at Accept (never off postage), the
 * emails, status page and HubSpot amount, the rate limit, and the admin page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapOrder } from '../src/crm/crm.js';
import { render } from '../src/email/templates.js';
import { checkCode, createCode, generateCode, listCodes, settleUseForStatus, usesOf, type NewCode } from '../src/orders/discounts.js';
import { createOrder } from '../src/orders/intake.js';
import { eraseCustomer, planErasure } from '../src/orders/erasure.js';
import { lookupStatus } from '../src/orders/status.js';
import { transitionOrder, TransitionError } from '../src/orders/transitions.js';
import {
  DISCOUNT_REFUSED,
  describeDiscount,
  discountCents,
  isDiscountCodeShape,
  normaliseDiscountCode,
  type DiscountBenefit,
} from '../src/orders/rules.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, SITE, smallJpeg, type TestApp } from './helpers/app.js';

const NEW: NewCode = { kind: 'free', value: 1, maxUses: 10, expiresOn: null, onePerEmail: true, note: null };

describe('discount rules (shared with the site)', () => {
  const cases: [DiscountBenefit, number, number][] = [
    // benefit, paddles, expected cents off at A$60
    [{ kind: 'free', value: 1 }, 1, 6000],
    [{ kind: 'free', value: 1 }, 10, 6000],
    [{ kind: 'free', value: 3 }, 2, 12000],
    [{ kind: 'free', value: 10 }, 10, 60000],
    [{ kind: 'amount', value: 1000 }, 1, 1000],
    [{ kind: 'amount', value: 1000 }, 10, 1000],
    [{ kind: 'amount', value: 9000 }, 1, 6000], // never more than the re-grit
    [{ kind: 'percent', value: 25 }, 1, 1500],
    [{ kind: 'percent', value: 25 }, 10, 15000],
    [{ kind: 'percent', value: 33 }, 1, 1980],
    [{ kind: 'percent', value: 100 }, 10, 60000],
  ];
  it.each(cases)('%o on %i paddle(s) takes off %i cents', (benefit, paddles, cents) => {
    expect(discountCents(benefit, paddles, 6000)).toBe(cents);
  });

  it('matches ignoring case and spaces, and allows hyphens', () => {
    expect(normaliseDiscountCode('  launch10 ')).toBe('LAUNCH10');
    expect(isDiscountCodeShape('free-ab3k7qxm')).toBe(true);
    expect(isDiscountCodeShape('-ABC')).toBe(false);
    expect(isDiscountCodeShape('AB')).toBe(false);
    expect(isDiscountCodeShape('LAUNCH 10')).toBe(false);
  });

  it('describes each kind plainly', () => {
    expect(describeDiscount({ kind: 'free', value: 1 })).toBe('Free re-grit for 1 paddle');
    expect(describeDiscount({ kind: 'free', value: 3 })).toBe('Free re-grit for up to 3 paddles');
    expect(describeDiscount({ kind: 'amount', value: 1050 })).toBe('A$10.50 off the re-grit');
    expect(describeDiscount({ kind: 'percent', value: 20 })).toBe('20% off the re-grit');
  });

  it('generates FREE- plus 8 easy-read characters', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^FREE-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
});

describe('discount codes in the service', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  const submit = async (code: string, opts: { email?: string; paddles?: number } = {}) => {
    const fd = await orderForm(t, { email: opts.email, paddles: opts.paddles, overrides: { discountCode: code } });
    return post(t, fd);
  };
  const check = (body: unknown) =>
    t.app.request('/api/discount-codes/check', { method: 'POST', body: JSON.stringify(body), headers: { Origin: SITE, 'Content-Type': 'application/json' } });
  const orderRow = async (reference: string) =>
    (await t.db.query<Record<string, unknown>>('SELECT * FROM orders WHERE reference = $1', [reference])).rows[0]!;
  const useState = async (reference: string) =>
    (await t.db.query<{ state: string }>('SELECT state FROM discount_uses WHERE reference = $1', [reference])).rows[0]?.state;

  it('refuses unknown, inactive, expired, used-up and already-used-by-this-email codes', async () => {
    t = await makeApp();
    const now = t.clock.now;
    await createCode(t.db, { ...NEW, code: 'ONEUSE', maxUses: 1 }, 'test', now);
    await createCode(t.db, { ...NEW, code: 'OLD', expiresOn: '2026-10-26' }, 'test', now);
    const off = await createCode(t.db, { ...NEW, code: 'OFF' }, 'test', now);
    await t.db.query('UPDATE discount_codes SET active = false WHERE id = $1', [off.id]);
    await createCode(t.db, { ...NEW, code: 'SHARED', maxUses: 5 }, 'test', now);

    expect((await checkCode(t.db, 'nope', { now })).ok).toBe(false);
    expect(await checkCode(t.db, 'n', { now })).toEqual({ ok: false, reason: 'malformed' });
    expect(await checkCode(t.db, 'off', { now })).toEqual({ ok: false, reason: 'inactive' });
    expect((await checkCode(t.db, 'old', { now })).ok).toBe(true); // still its last day (Sydney)
    t.clock.now = new Date('2026-10-26T13:30:00Z'); // 27 Oct in Sydney
    expect(await checkCode(t.db, 'old', { now: t.clock.now })).toEqual({ ok: false, reason: 'expired' });

    expect((await submit('oneuse')).status).toBe(201);
    expect(await checkCode(t.db, 'ONEUSE', { now: t.clock.now })).toEqual({ ok: false, reason: 'used_up' });

    expect((await submit('shared', { email: 'a@test.picklemypaddle.com' })).status).toBe(201);
    expect(await checkCode(t.db, 'shared', { now: t.clock.now, emailNorm: 'a@test.picklemypaddle.com' })).toEqual({ ok: false, reason: 'used_by_email' });
    expect((await checkCode(t.db, 'shared', { now: t.clock.now, emailNorm: 'b@test.picklemypaddle.com' })).ok).toBe(true);
  });

  it('the form check gives the benefit, or one message whatever the reason, and never logs the code', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'LAUNCH10' }, 'test', t.clock.now);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    try {
      const ok = await check({ code: ' launch10 ' });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(await ok.json()).toEqual({ valid: true, code: 'LAUNCH10', kind: 'free', value: 1, label: 'Free re-grit for 1 paddle' });
      for (const bad of [{ code: 'SECRETGUESS1' }, { code: 'x' }, {}, 'junk']) {
        const r = await check(bad);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ valid: false, message: DISCOUNT_REFUSED });
      }
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.some((l) => l.includes('discount_refused'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/SECRETGUESS1|LAUNCH10/i);
  });

  it('rate-limits checks per IP, counting codes on submitted orders too', async () => {
    t = await makeApp({ env: { DISCOUNT_CHECK_LIMIT_PER_IP_HOUR: '3' } });
    for (let i = 0; i < 2; i++) expect((await check({ code: `GUESS${i}X` })).status).toBe(200);
    expect((await submit('GUESS9X')).status).toBe(400); // the third check, through the order form
    const limited = await check({ code: 'GUESS3X' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    t.peer.address = '198.51.100.9';
    expect((await check({ code: 'GUESS4X' })).status).toBe(200);
  });

  it('a bad code at submit is refused with the one message and nothing is stored; the order goes ahead without it', async () => {
    t = await makeApp();
    const r = await submit('NOSUCHCODE');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ errors: { discountCode: DISCOUNT_REFUSED } });
    expect((await t.db.query('SELECT 1 FROM orders')).rows).toHaveLength(0);
    expect((await submit('')).status).toBe(201);
  });

  it('reserves at submit, fixes the discount at Accept (never off postage), consumes at Paid', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'LAUNCH10', value: 1 }, 'test', t.clock.now);
    const r = await submit('launch10', { paddles: 2 });
    expect(r.status).toBe(201);
    const { reference } = (await r.json()) as { reference: string };
    expect(await useState(reference)).toBe('reserved');
    expect(await orderRow(reference)).toMatchObject({ discount_code: 'LAUNCH10', discount_kind: 'free', discount_value: 1 });

    // Changing the code afterwards changes nothing on the order.
    await t.db.query(`UPDATE discount_codes SET active = false, value = 5 WHERE code = 'LAUNCH10'`);

    const deps = { db: t.db, isProduction: false, now: t.clock.now };
    await transitionOrder(deps, { reference, to: 'accepted', actor: 'admin' });
    const o = await orderRow(reference);
    expect(Number(o.subtotal_cents)).toBe(12000);
    expect(Number(o.discount_cents)).toBe(6000);
    expect(Number(o.amount_cents)).toBe(6000 + Number(o.postage_cents));
    expect(Number(o.postage_cents)).toBeGreaterThan(0);

    const email = (await t.db.query<{ payload: unknown }>(`SELECT payload FROM outbox WHERE template = 'accepted'`)).rows[0]!.payload;
    expect(typeof email === 'string' ? JSON.parse(email) : email).toMatchObject({ discountCents: 6000, discountCode: 'LAUNCH10' });

    await transitionOrder(deps, { reference, to: 'paid', actor: 'stripe' });
    expect(await useState(reference)).toBe('consumed');
  });

  it('releases the use when the order is rejected, withdrawn or lapses unpaid', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'ONCE', maxUses: 1, onePerEmail: false }, 'test', t.clock.now);
    const deps = { db: t.db, isProduction: false, now: t.clock.now };
    for (const [to, actor, via] of [
      ['rejected', 'admin', null],
      ['withdrawn', 'admin', 'accepted'],
      ['lapsed', 'system', 'questions'],
    ] as const) {
      const r = await submit('ONCE');
      expect(r.status, to).toBe(201);
      const { reference } = (await r.json()) as { reference: string };
      expect(await checkCode(t.db, 'ONCE', { now: t.clock.now })).toEqual({ ok: false, reason: 'used_up' });
      if (via) await transitionOrder(deps, { reference, to: via, actor: 'admin' });
      await transitionOrder(deps, { reference, to, actor, reason: to === 'rejected' ? 'Delaminated core.' : undefined });
      expect(await useState(reference)).toBe('released');
      expect((await checkCode(t.db, 'ONCE', { now: t.clock.now })).ok, to).toBe(true);
    }
  });

  it('a paid order that is later withdrawn keeps its use consumed', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'KEEP' }, 'test', t.clock.now);
    const { reference } = (await (await submit('KEEP')).json()) as { reference: string };
    const deps = { db: t.db, isProduction: false, now: t.clock.now };
    await transitionOrder(deps, { reference, to: 'accepted', actor: 'admin' });
    await transitionOrder(deps, { reference, to: 'paid', actor: 'stripe' });
    await transitionOrder(deps, { reference, to: 'withdrawn', actor: 'admin' });
    expect(await useState(reference)).toBe('consumed');
  });

  it('two orders racing for the last use: exactly one gets it', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'LAST', maxUses: 1, onePerEmail: false }, 'test', t.clock.now);
    const jpeg = await smallJpeg();
    const photos = [{ front: { data: jpeg, width: 1, height: 1 }, back: { data: jpeg, width: 1, height: 1 } }];
    const input = {
      name: 'Racer', email: 'r@test.picklemypaddle.com', street: '1 St', suburb: 'Sydney', state: 'NSW', postcode: '2000',
      consent: true, tournamentAck: true, paddles: [{ brand: 'Joola' }],
    };
    const deps = { db: t.db, photos: t.photos, isProduction: false, now: () => t.clock.now };
    const results = await Promise.allSettled([createOrder(deps, input, photos, null, 'LAST'), createOrder(deps, input, photos, null, 'LAST')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as Error).name === 'DiscountRefusedError')).toHaveLength(1);
    expect((await t.db.query('SELECT 1 FROM orders')).rows).toHaveLength(1);
  });

  it('a deleted order’s held use stops counting', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'GONE', maxUses: 1 }, 'test', t.clock.now);
    const { reference } = (await (await submit('GONE')).json()) as { reference: string };
    await t.db.query('DELETE FROM orders WHERE reference = $1', [reference]);
    expect((await checkCode(t.db, 'GONE', { now: t.clock.now })).ok).toBe(true);
    expect((await usesOf(t.db, (await listCodes(t.db))[0]!.id))[0]).toMatchObject({ reference, orderExists: false });
  });

  it('won’t accept an order whose total would be A$0', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'ALLFREE' }, 'test', t.clock.now);
    const { reference } = (await (await submit('ALLFREE')).json()) as { reference: string };
    const err = await transitionOrder(
      { db: t.db, isProduction: false, now: t.clock.now },
      { reference, to: 'accepted', actor: 'admin', postageCents: 0, postageReason: 'Collected in person' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect((err as TransitionError).code).toBe('nothing_to_pay');
  });

  it('shows the code on the confirmation email, status page and HubSpot estimate, then the fixed discount', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'TENOFF', kind: 'amount', value: 1000 }, 'test', t.clock.now);
    const body = (await (await submit('TENOFF')).json()) as { reference: string; statusToken: string };

    const submitted = render('customer_submitted', {
      test: true, siteUrl: SITE, reference: body.reference, firstName: 'Test', paddles: [{ brand: 'Joola', model: null }],
      statusUrl: `${SITE}/order/status#x`, discountOffer: { code: 'TENOFF', kind: 'amount', value: 1000 },
    });
    expect(submitted.text).toContain('Code applied: TENOFF (A$10 off the re-grit), so A$10 off the re-grit. It’s confirmed when we accept your order.');

    let view = await lookupStatus(t.db, body.statusToken, t.clock.now);
    expect(view!.discount).toEqual({ code: 'TENOFF', label: 'A$10 off the re-grit', cents: 1000, confirmed: false });

    const { rows } = await t.db.query<Parameters<typeof mapOrder>[0]>(
      `SELECT o.*, (SELECT count(*)::int FROM paddles p WHERE p.order_id = o.id) AS paddle_count, false AS has_review, false AS contact_has_review
         FROM orders o WHERE reference = $1`,
      [body.reference],
    );
    expect(mapOrder(rows[0]!).deal.amountCents).toBe(5000);

    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference: body.reference, to: 'accepted', actor: 'admin' });
    view = await lookupStatus(t.db, body.statusToken, t.clock.now);
    expect(view!.discount).toMatchObject({ cents: 1000, confirmed: true });

    const accepted = render('accepted', {
      test: true, siteUrl: SITE, reference: body.reference, firstName: 'Test', paddles: [{ brand: 'Joola', model: null }],
      statusUrl: `${SITE}/order/status#x`, subtotalCents: 6000, discountCents: 1000, discountCode: 'TENOFF', postageCents: 1170, amountCents: 6170,
    });
    expect(accepted.text).toContain('Discount (TENOFF): −A$10');
    expect(accepted.text).toContain('Total: A$61.70');
  });

  it('erasing the customer clears a one-person code’s note, not a shared one’s', async () => {
    t = await makeApp();
    await createCode(t.db, { ...NEW, code: 'FREE-ABCDEFGH', maxUses: 1, note: 'Erin from the club' }, 'test', t.clock.now);
    await createCode(t.db, { ...NEW, code: 'SHAREDX', note: 'Flyer at Olympic Park' }, 'test', t.clock.now);
    const email = 'erin@test.picklemypaddle.com';
    for (const code of ['FREE-ABCDEFGH', 'SHAREDX']) {
      const { reference } = (await (await submit(code, { email })).json()) as { reference: string };
      await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to: 'withdrawn', actor: 'admin' });
    }
    const deps = { db: t.db, photos: t.photos, crm: null };
    const plan = await planErasure(deps, email, t.clock.now);
    await eraseCustomer(deps, email, plan.fingerprint, t.clock.now);
    const codes = Object.fromEntries((await listCodes(t.db)).map((c) => [c.code, c]));
    expect(codes['FREE-ABCDEFGH']!.note).toBeNull();
    expect(codes.SHAREDX!.note).toBe('Flyer at Olympic Park');
  });

  it('settling an order without a code does nothing', async () => {
    t = await makeApp();
    const { reference } = (await (await submit('')).json()) as { reference: string };
    const { rows } = await t.db.query<{ id: string }>('SELECT id FROM orders WHERE reference = $1', [reference]);
    await settleUseForStatus(t.db, rows[0]!.id, 'paid', t.clock.now);
    expect((await t.db.query('SELECT 1 FROM discount_uses')).rows).toHaveLength(0);
  });
});

describe('discount codes admin page', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  it('creates a typed code, generates a one-person one, deactivates, and lists uses by reference', async () => {
    t = await makeApp();
    const admin = await makeAdmin(t);
    expect((await admin.get('/admin/codes')).status).toBe(200);

    let r = await admin.post('/admin/codes', { code: 'launch10', kind: 'free', value: '1', maxUses: '10', onePerEmail: 'yes', expiresOn: '' });
    expect(r.status).toBe(303);
    const launch = r.headers.get('location')!;
    expect(launch).toMatch(/^\/admin\/codes\/\d+\?done=created$/);

    r = await admin.post('/admin/codes', { kind: 'free', value: '1', maxUses: '1', onePerEmail: 'yes', note: 'Sam from the club' });
    expect(r.status).toBe(303);
    const codes = await listCodes(t.db);
    expect(codes.map((c) => c.code)).toContain('LAUNCH10');
    expect(codes.find((c) => c.code.startsWith('FREE-'))).toMatchObject({ maxUses: 1, note: 'Sam from the club' });

    // Refused: duplicate, bad amount, bad code.
    for (const bad of [
      { code: 'LAUNCH10', kind: 'free', value: '1', maxUses: '1' },
      { kind: 'amount', value: 'ten', maxUses: '1' },
      { code: '-X-', kind: 'percent', value: '10', maxUses: '1' },
      { kind: 'percent', value: '150', maxUses: '1' },
    ] as Record<string, string>[]) expect((await admin.post('/admin/codes', bad)).status, JSON.stringify(bad)).toBe(400);

    const { reference } = (await (await post(t, await orderForm(t, { overrides: { discountCode: 'LAUNCH10' } }))).json()) as { reference: string };
    const page = await (await admin.get(launch.split('?')[0]!)).text();
    expect(page).toContain(reference);
    expect(page).toContain('Held (not paid yet)');
    expect(page).not.toContain('player@test.picklemypaddle.com');

    r = await admin.post(`${launch.split('?')[0]}/active`, { active: 'no' });
    expect(r.status).toBe(303);
    expect((await checkCode(t.db, 'LAUNCH10', { now: t.clock.now })).ok).toBe(false);

    const order = await (await admin.get(`/admin/orders/${reference}`)).text();
    expect(order).toContain('LAUNCH10: Free re-grit for 1 paddle');
  });
});
