/**
 * Unpaid orders (SCRUM-83): the day-14 payment reminder, Accepted → Lapsed on day 30 (Sydney
 * dates from the Accepted time), late payments flagged and alerted, and reinstating them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listOrders } from '../src/admin/data.js';
import { render, sampleContext } from '../src/email/templates.js';
import { runAutoTransitions, UNPAID_LAPSE_NOTE } from '../src/orders/auto.js';
import { createCode } from '../src/orders/discounts.js';
import { runPaymentReminders } from '../src/orders/payment-reminder.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { pollEvents, reinstateLatePayment } from '../src/payments/payments.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';
import { fakeStripe, type FakeStripe } from './helpers/fake-stripe.js';

// Accepted at 12:00 on 26 Oct 2026 in Sydney (01:00 UTC, daylight saving).
const ACCEPTED = new Date('2026-10-26T01:00:00Z');
/** Midday in Sydney, N days after acceptance. */
const day = (n: number) => new Date(ACCEPTED.getTime() + n * 24 * 60 * 60 * 1000);

describe('unpaid orders', () => {
  let t: TestApp;
  let stripe: FakeStripe;
  afterEach(async () => t?.close());

  const setup = async () => {
    const opts: { clock?: { now: Date } } = {};
    stripe = fakeStripe(opts);
    t = await makeApp({ stripe });
    opts.clock = t.clock;
    t.clock.now = ACCEPTED;
  };
  const deps = () => ({ db: t.db, isProduction: false, now: t.clock.now });
  const accepted = async (opts: { email?: string; code?: string } = {}) => {
    const fd = await orderForm(t, { email: opts.email, overrides: opts.code ? { discountCode: opts.code } : {} });
    const { reference, statusToken } = (await (await post(t, fd)).json()) as { reference: string; statusToken: string };
    await transitionOrder(deps(), { reference, to: 'accepted', actor: 'admin' });
    return { reference, token: statusToken };
  };
  const status = async (reference: string) => (await t.db.query<{ status: string }>('SELECT status FROM orders WHERE reference = $1', [reference])).rows[0]!.status;
  const emails = async (template: string) =>
    (await t.db.query<{ recipient: string; payload: unknown }>('SELECT recipient, payload FROM outbox WHERE template = $1', [template])).rows;
  const payNow = async (token: string) => {
    const r = await t.app.request('/api/orders/pay', { method: 'POST', body: JSON.stringify({ token }), headers: { Origin: SITE, 'Content-Type': 'application/json' } });
    const { url } = (await r.json()) as { url: string };
    return [...stripe.sessions.values()].find((s) => s.url === url)!;
  };

  it('reminds once, on day 14 (Sydney dates): not day 13, not again on day 15', async () => {
    await setup();
    const { reference } = await accepted();
    expect(await runPaymentReminders(t.db, day(13))).toBe(0);
    expect(await runPaymentReminders(t.db, new Date('2026-11-08T12:59:00Z'))).toBe(0); // 23:59 on 8 Nov in Sydney
    expect(await runPaymentReminders(t.db, new Date('2026-11-08T13:00:00Z'))).toBe(1); // 00:00 on 9 Nov: day 14
    expect(await runPaymentReminders(t.db, day(15))).toBe(0);
    const sent = await emails('payment_reminder');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipient).toBe('player@test.picklemypaddle.com');
    expect(typeof sent[0]!.payload === 'string' ? JSON.parse(sent[0]!.payload) : sent[0]!.payload).toEqual({ lapsesOn: '2026-11-25', amountCents: 7170 });
    expect(await status(reference)).toBe('accepted');
  });

  it('lapses on day 30, not day 29, with the note and no email; releases a code; expires open sessions', async () => {
    await setup();
    await createCode(t.db, { code: 'FREE-ABCDEFGH', kind: 'free', value: 1, maxUses: 1, expiresOn: null, onePerEmail: true, note: null }, 'test', t.clock.now);
    const { reference, token } = await accepted({ code: 'FREE-ABCDEFGH' });
    expect((await runAutoTransitions(t.db, day(29), false, t.payments)).lapsed).toBe(0);
    t.clock.now = new Date(day(30).getTime() - 60 * 60 * 1000); // Pay now an hour before the lapse...
    const session = await payNow(token); // ...then the customer leaves Stripe's page open
    expect((await runAutoTransitions(t.db, day(30), false, t.payments)).lapsed).toBe(1);
    expect(await status(reference)).toBe('lapsed');
    const h = (await t.db.query<{ actor: string; note: string }>(`SELECT actor, note FROM status_history WHERE status = 'lapsed'`)).rows[0]!;
    expect(h).toEqual({ actor: 'system', note: UNPAID_LAPSE_NOTE });
    expect(await emails('lapsed')).toEqual([]);
    expect(stripe.sessions.get(session.id)!.status).toBe('expired');
    expect((await t.db.query(`SELECT 1 FROM discount_uses WHERE state = 'released'`)).rows).toHaveLength(1);
    const view = (await (await t.app.request('/api/orders/status', { method: 'POST', body: JSON.stringify({ token }), headers: { Origin: SITE, 'Content-Type': 'application/json' } })).json()) as { statusLabel: string; payment: { canPay: boolean } };
    expect(view.statusLabel).toBe('Closed: not paid within 30 days of acceptance');
    expect(view.payment.canPay).toBe(false);
    // Pay now is gone.
    const r = await t.app.request('/api/orders/pay', { method: 'POST', body: JSON.stringify({ token }), headers: { Origin: SITE, 'Content-Type': 'application/json' } });
    expect(r.status).toBe(409);
  });

  it('never reminds or lapses a paid order', async () => {
    await setup();
    const { reference, token } = await accepted();
    stripe.pay((await payNow(token)).id);
    await pollEvents(t.payments!);
    expect(await status(reference)).toBe('paid');
    expect(await runPaymentReminders(t.db, day(20))).toBe(0);
    expect((await runAutoTransitions(t.db, day(40), false, t.payments)).lapsed).toBe(0);
    expect(await status(reference)).toBe('paid');
  });

  it('a payment after the lapse is flagged, alerts Attila and stays recorded; reinstating needs a note and records who', async () => {
    await setup();
    await createCode(t.db, { code: 'FREE-ZYXWVUTS', kind: 'free', value: 1, maxUses: 1, expiresOn: null, onePerEmail: true, note: null }, 'test', t.clock.now);
    const { reference, token } = await accepted({ code: 'FREE-ZYXWVUTS' });
    const session = await payNow(token);
    t.clock.now = day(30);
    // The lapse happens while the customer is on Stripe's page; Stripe can't expire it once paid.
    stripe.pay(session.id);
    await runAutoTransitions(t.db, day(30), false, null);
    await pollEvents(t.payments!);
    expect(await status(reference)).toBe('lapsed');
    expect((await t.db.query('SELECT problem, amount_cents FROM payments')).rows[0]).toMatchObject({ problem: 'order_lapsed', amount_cents: 1170 });
    const alerts = await emails('alert_payment');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.recipient).toBe('sales@picklemypaddle.com');

    const listed = await listOrders(t.db, ['submitted', 'questions'], t.clock.now, { withPaymentProblems: true });
    expect(listed.map((o) => [o.reference, o.paymentProblem])).toEqual([[reference, 'late']]);

    const admin = await makeAdmin(t, { paymentsConfigured: true });
    const page = await (await admin.get(`/admin/orders/${reference}`)).text();
    expect(page).toContain('Payment received after the order lapsed: A$11.70');
    expect(page).toContain('Reinstate as paid');
    expect((await admin.post(`/admin/orders/${reference}/reinstate`, { note: '  ' })).status).toBe(400);
    expect(await status(reference)).toBe('lapsed');
    const ok = await admin.post(`/admin/orders/${reference}/reinstate`, { note: 'Customer paid the evening it lapsed' });
    expect(ok.status).toBe(303);
    expect(await status(reference)).toBe('paid');
    const h = (await t.db.query<{ actor: string; note: string }>(`SELECT actor, note FROM status_history WHERE status = 'paid'`)).rows[0]!;
    expect(h.actor).toBe('admin');
    expect(h.note).toContain('Reinstated as paid by attila@test.picklemypaddle.com');
    expect(h.note).toContain('Customer paid the evening it lapsed');
    expect((await t.db.query('SELECT problem, reinstated_by FROM payments')).rows[0]).toEqual({ problem: null, reinstated_by: 'attila@test.picklemypaddle.com' });
    expect((await t.db.query(`SELECT state FROM discount_uses`)).rows[0]).toEqual({ state: 'consumed' });
    // Once only.
    expect((await admin.post(`/admin/orders/${reference}/reinstate`, { note: 'again' })).status).toBe(409);
  });

  it('a Withdrawn order with a late payment can be reinstated too; one without can’t; admin never sets Paid otherwise', async () => {
    await setup();
    const a = await accepted({ email: 'a@test.picklemypaddle.com' });
    const s = await payNow(a.token);
    await transitionOrder(deps(), { reference: a.reference, to: 'withdrawn', actor: 'admin' });
    stripe.pay(s.id);
    await pollEvents(t.payments!);
    expect((await t.db.query('SELECT problem FROM payments')).rows[0]).toEqual({ problem: 'order_withdrawn' });
    await reinstateLatePayment(t.db, a.reference, 'attila', 'They changed their mind back', { isProduction: false, now: t.clock.now });
    expect(await status(a.reference)).toBe('paid');

    const b = await accepted({ email: 'b@test.picklemypaddle.com' });
    await transitionOrder(deps(), { reference: b.reference, to: 'withdrawn', actor: 'admin' });
    await expect(reinstateLatePayment(t.db, b.reference, 'attila', 'no payment', { isProduction: false, now: t.clock.now })).rejects.toMatchObject({ code: 'nothing_to_reinstate' });
    await expect(transitionOrder(deps(), { reference: b.reference, to: 'paid', actor: 'admin', note: 'x' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a refunded late payment is no longer offered for reinstating', async () => {
    await setup();
    const { reference, token } = await accepted();
    const s = await payNow(token);
    await transitionOrder(deps(), { reference, to: 'withdrawn', actor: 'admin' });
    stripe.pay(s.id);
    await pollEvents(t.payments!);
    const pi = (await t.db.query<{ payment_intent_id: string }>('SELECT payment_intent_id FROM payments')).rows[0]!.payment_intent_id;
    stripe.refund(pi, 7170);
    await pollEvents(t.payments!);
    await expect(reinstateLatePayment(t.db, reference, 'attila', 'x', { isProduction: false, now: t.clock.now })).rejects.toMatchObject({ code: 'nothing_to_reinstate' });
    expect((await listOrders(t.db, [], t.clock.now, { withPaymentProblems: true }))).toEqual([]);
  });

  it('the admin list says when an Accepted order lapses', async () => {
    await setup();
    const { reference } = await accepted();
    const at = async (n: number) => (await listOrders(t.db, ['accepted'], day(n))).find((o) => o.reference === reference)!.lapsesInDays;
    expect(await at(0)).toBe(30);
    expect(await at(25)).toBe(5);
    expect(await at(30)).toBe(0);
    const page = await (await (await makeAdmin(t)).get('/admin/orders?status=accepted')).text();
    expect(page).toContain('lapses in 30 days unless paid');
  });

  it('the reminder email says when it lapses and links to Pay now on the order page', () => {
    const email = render('payment_reminder', { ...sampleContext('payment_reminder', false), amountCents: 13800 });
    expect(email.subject).toBe('PMP-7K3QX is waiting for payment');
    expect(email.text).toContain('Your order PMP-7K3QX is waiting for payment (A$138, including return postage). It lapses on Wednesday 2 December 2026 if it’s still unpaid then');
    expect(email.text).toContain('Pay now on your order page');
    expect(email.text).not.toContain('stripe.com');
  });
});
