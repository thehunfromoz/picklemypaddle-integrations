/**
 * Stripe payment after assessment (SCRUM-82), with Stripe faked at the HTTP boundary:
 * Pay now → a Checkout Session for the saved total; Paid from the return, the webhook and the
 * poller, each alone and all together (once); wrong amounts flagged; refunds recorded; the poller
 * resuming from its last event; the webhook's signature; the admin and status page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutParams, pollEvents, signWebhook, verifyWebhook } from '../src/payments/payments.js';
import { formEncode } from '../src/payments/stripe.js';
import { createCode } from '../src/orders/discounts.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';
import { fakeStripe, TEST_WEBHOOK_SECRET, type FakeStripe } from './helpers/fake-stripe.js';

const NOW = new Date('2026-11-02T01:00:00Z');

describe('Checkout Session parameters', () => {
  const order = {
    id: '6f1c2d3e-0000-4000-8000-000000000001', reference: 'PMP-ABCDE', email: 'p@example.com', paddles: 2,
    subtotalCents: 12000, discountCents: 0, discountCode: null, postageCents: 1800, amountCents: 13800,
  };
  const urls = { success: `${SITE}/order/paid?session_id={CHECKOUT_SESSION_ID}`, cancel: `${SITE}/order/status?payment=cancelled` };

  it('carries the order, the customer’s email and line items that add up to the saved total, in AUD', () => {
    const p = new URLSearchParams(formEncode(checkoutParams(order, urls, NOW)));
    expect(Object.fromEntries(p)).toMatchObject({
      mode: 'payment',
      client_reference_id: order.id,
      customer_email: 'p@example.com',
      'metadata[reference]': 'PMP-ABCDE',
      'line_items[0][price_data][currency]': 'aud',
      'line_items[0][price_data][unit_amount]': '12000',
      'line_items[0][price_data][product_data][name]': 'Re-grit, 2 paddles, both faces',
      'line_items[1][price_data][unit_amount]': '1800',
      'line_items[1][price_data][product_data][name]': 'Return postage',
      success_url: urls.success,
      cancel_url: urls.cancel,
      expires_at: String(Math.floor(NOW.getTime() / 1000) + 7200),
    });
    expect(p.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('shows a discount as a net re-grit line (A$0 for a free re-grit), never a negative one', () => {
    const p = new URLSearchParams(formEncode(checkoutParams(
      { ...order, paddles: 1, subtotalCents: 6000, discountCents: 6000, discountCode: 'FREE-ABCDEFGH', postageCents: 1170, amountCents: 1170 }, urls, NOW)));
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('0');
    expect(p.get('line_items[0][price_data][product_data][name]')).toBe('Re-grit, 1 paddle, both faces (code FREE-ABCDEFGH: A$60 off)');
    expect(p.get('line_items[1][price_data][unit_amount]')).toBe('1170');
  });

  it('refuses line items that don’t add up', () => {
    expect(() => checkoutParams({ ...order, amountCents: 99 }, urls, NOW)).toThrow();
  });
});

describe('webhook signature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts Stripe’s signature and refuses anything else', () => {
    const header = signWebhook(TEST_WEBHOOK_SECRET, body, NOW);
    expect(verifyWebhook(TEST_WEBHOOK_SECRET, header, body, NOW)).toBe(true);
    expect(verifyWebhook(TEST_WEBHOOK_SECRET, header, body + ' ', NOW)).toBe(false);
    expect(verifyWebhook(['whsec', 'other'].join('_'), header, body, NOW)).toBe(false);
    expect(verifyWebhook(TEST_WEBHOOK_SECRET, header, body, new Date(NOW.getTime() + 301_000))).toBe(false); // replayed late
    expect(verifyWebhook(TEST_WEBHOOK_SECRET, undefined, body, NOW)).toBe(false);
    expect(verifyWebhook(TEST_WEBHOOK_SECRET, 't=abc,v1=zz', body, NOW)).toBe(false);
  });
});

describe('paying for an order', () => {
  let t: TestApp;
  let stripe: FakeStripe;
  afterEach(async () => t?.close());

  const setup = async (env: Record<string, string> = {}) => {
    const opts: { clock?: { now: Date } } = {};
    stripe = fakeStripe(opts);
    t = await makeApp({ stripe, env });
    opts.clock = t.clock; // the fake Stripe keeps the app's time
  };
  const deps = () => ({ db: t.db, isProduction: false, now: t.clock.now });
  const accepted = async (opts: { code?: string; email?: string } = {}) => {
    const fd = await orderForm(t, { email: opts.email, overrides: opts.code ? { discountCode: opts.code } : {} });
    const { reference, statusToken } = (await (await post(t, fd)).json()) as { reference: string; statusToken: string };
    await transitionOrder(deps(), { reference, to: 'accepted', actor: 'admin' });
    return { reference, token: statusToken };
  };
  const api = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    t.app.request(`/api/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { Origin: SITE, 'Content-Type': 'application/json', ...headers } });
  const status = async (reference: string) => (await t.db.query<{ status: string }>('SELECT status FROM orders WHERE reference = $1', [reference])).rows[0]!.status;
  const payRows = async () => (await t.db.query<Record<string, unknown>>('SELECT * FROM payments')).rows;
  const paidEmails = async () => Number((await t.db.query<{ n: string }>(`SELECT count(*) AS n FROM status_history WHERE status = 'paid'`)).rows[0]!.n);
  const startPay = async (token: string) => {
    const r = await api('orders/pay', { token });
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    return [...stripe.sessions.values()].find((s) => s.url === url)!;
  };

  it('Pay now makes a Checkout Session for the saved total, and a new click expires the old one', async () => {
    await setup();
    const { token, reference } = await accepted();
    const first = await startPay(token);
    expect(first.amount_total).toBe(6000 + 1170);
    expect(first.params.get('success_url')).toBe(`${SITE}/order/paid?session_id={CHECKOUT_SESSION_ID}`);
    expect(first.params.get('metadata[reference]')).toBe(reference);
    const create = stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')!;
    expect(create.headers['idempotency-key']).toMatch(/^pmp-pay-/);
    expect(create.headers.authorization).toMatch(/^Bearer rk_test_/);

    const second = await startPay(token);
    expect(second.id).not.toBe(first.id);
    expect(stripe.sessions.get(first.id)!.status).toBe('expired');
  });

  it('a coded free re-grit charges only the return postage', async () => {
    await setup();
    await createCode(t.db, { code: 'FREE-ABCDEFGH', kind: 'free', value: 1, maxUses: 1, expiresOn: null, onePerEmail: true, note: null }, 'test', t.clock.now);
    const { token } = await accepted({ code: 'FREE-ABCDEFGH' });
    const s = await startPay(token);
    expect(s.amount_total).toBe(1170);
    expect(s.params.get('line_items[0][price_data][unit_amount]')).toBe('0');
  });

  it('refuses to pay an order that isn’t Accepted (409), a bad link (404), and is rate-limited', async () => {
    await setup({ LINKS_LIMIT_PER_IP_HOUR: '3' });
    const submitted = (await (await post(t, await orderForm(t))).json()) as { statusToken: string };
    let r = await api('orders/pay', { token: submitted.statusToken });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toContain('can’t be paid at the moment');
    r = await api('orders/pay', { token: 'x'.repeat(43) });
    expect(r.status).toBe(404);
    await api('orders/pay', { token: 'y'.repeat(43) });
    expect((await api('orders/pay', { token: 'z'.repeat(43) })).status).toBe(429);
  });

  it('a lapsed order refuses to pay', async () => {
    await setup();
    const { token, reference } = await accepted();
    await transitionOrder(deps(), { reference, to: 'lapsed', actor: 'system' });
    expect((await api('orders/pay', { token })).status).toBe(409);
  });

  it('without Stripe set up, Pay now is hidden and refused (503)', async () => {
    t = await makeApp();
    const fd = await orderForm(t);
    const { reference, statusToken } = (await (await post(t, fd)).json()) as { reference: string; statusToken: string };
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference, to: 'accepted', actor: 'admin' });
    const view = (await (await api('orders/status', { token: statusToken })).json()) as { payment: { canPay: boolean } };
    expect(view.payment.canPay).toBe(false);
    expect((await api('orders/pay', { token: statusToken })).status).toBe(503);
  });

  it('the return from Checkout marks it Paid at once, with the fee; the status page shows it', async () => {
    await setup();
    const { token, reference } = await accepted();
    let view = (await (await api('orders/status', { token })).json()) as { payment: { amountCents: number; canPay: boolean; paidAt: string | null } };
    expect(view.payment).toEqual({ amountCents: 7170, canPay: true, paidAt: null });

    const s = await startPay(token);
    stripe.pay(s.id);
    const r = await api('orders/paid', { sessionId: s.id });
    expect(await r.json()).toEqual({ paid: true, reference });
    expect(await status(reference)).toBe('paid');
    const [p] = await payRows();
    expect(p).toMatchObject({ amount_cents: 7170, fee_cents: stripe.feeFor(7170), source: 'return', problem: null, currency: 'aud', livemode: false });

    view = (await (await api('orders/status', { token })).json()) as typeof view;
    expect(view.payment!.canPay).toBe(false);
    expect(view.payment!.paidAt).toBeTruthy();
    expect((await api('orders/pay', { token })).status).toBe(409);
  });

  it('an unpaid or unknown session on return changes nothing', async () => {
    await setup();
    const { token, reference } = await accepted();
    const s = await startPay(token);
    expect(await (await api('orders/paid', { sessionId: s.id })).json()).toEqual({ paid: false });
    expect((await api('orders/paid', { sessionId: 'cs_test_nosuchsession12345' })).status).toBe(404);
    expect((await api('orders/paid', { sessionId: 'not-a-session' })).status).toBe(404);
    expect(await status(reference)).toBe('accepted');
  });

  it('the poller marks it Paid, resumes from its last event, and records a refund', async () => {
    await setup();
    const { token, reference } = await accepted();
    expect(await pollEvents(t.payments!)).toEqual({ events: 0, applied: 0 });
    stripe.pay((await startPay(token)).id);
    expect(await pollEvents(t.payments!)).toEqual({ events: 1, applied: 1 });
    expect(await status(reference)).toBe('paid');
    expect(await pollEvents(t.payments!)).toEqual({ events: 0, applied: 0 }); // resumes after the last one

    const pi = (await payRows())[0]!.payment_intent_id as string;
    stripe.refund(pi, 1170);
    expect(await pollEvents(t.payments!)).toEqual({ events: 1, applied: 1 });
    expect((await payRows())[0]).toMatchObject({ refunded_cents: 1170 });
    expect(await status(reference)).toBe('paid'); // nothing refunds or moves automatically
    const notes = await t.db.query<{ note: string }>('SELECT note FROM order_notes');
    expect(notes.rows.map((n) => n.note).join('\n')).toContain('Refund recorded from Stripe: A$11.70');
  });

  it('the poller pages through more than one page of events, oldest first', async () => {
    await setup();
    const orders = [];
    for (let i = 0; i < 3; i++) orders.push(await accepted({ email: `p${i}@test.picklemypaddle.com` }));
    await pollEvents(t.payments!); // sets the cursor (nothing yet)
    for (const o of orders) stripe.pay((await startPay(o.token)).id);
    // A page size of 100 in production; force paging by asking Stripe for one at a time.
    const list = t.payments!.stripe.listEvents.bind(t.payments!.stripe);
    t.payments!.stripe.listEvents = (q) => list({ ...q, limit: 1 });
    expect(await pollEvents(t.payments!)).toEqual({ events: 3, applied: 3 });
    for (const o of orders) expect(await status(o.reference)).toBe('paid');
  });

  it('return, webhook and poller together mark it Paid once, with one history row and one payment', async () => {
    await setup({ APP_ENV: 'production', RESEND_API_KEY: 're_testkey', STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET });
    const { token, reference } = await accepted();
    await pollEvents(t.payments!);
    const event = stripe.pay((await startPay(token)).id);
    const body = JSON.stringify(event);
    const hook = () => api('stripe/webhook', body, { 'Stripe-Signature': signWebhook(TEST_WEBHOOK_SECRET, body, t.clock.now) });
    const session = event.data.object as { id: string };
    const results = await Promise.all([api('orders/paid', { sessionId: session.id }), hook(), pollEvents(t.payments!), hook()]);
    expect(results[1]!.status).toBe(200);
    expect(await status(reference)).toBe('paid');
    expect(await paidEmails()).toBe(1);
    expect(await payRows()).toHaveLength(1);
    expect(Number((await t.db.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE kind = 'crm'`)).rows[0]!.n)).toBeGreaterThan(0);
  });

  it('the webhook refuses a bad signature (400, no change) and is 404 outside production', async () => {
    await setup({ APP_ENV: 'production', RESEND_API_KEY: 're_testkey', STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET });
    const { token, reference } = await accepted();
    const event = stripe.pay((await startPay(token)).id);
    const body = JSON.stringify(event);
    const bad = await api('stripe/webhook', body, { 'Stripe-Signature': signWebhook(['whsec', 'wrongsecret'].join('_'), body, t.clock.now) });
    expect(bad.status).toBe(400);
    expect((await api('stripe/webhook', body)).status).toBe(400);
    expect(await status(reference)).toBe('accepted');
    await t.close();

    await setup({ APP_ENV: 'staging', STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET });
    expect((await api('stripe/webhook', '{}')).status).toBe(404);
  });

  it('a wrong amount is flagged for Attila and the order doesn’t move', async () => {
    await setup();
    const { token, reference } = await accepted();
    const s = await startPay(token);
    stripe.pay(s.id, { amount: 100 });
    expect(await (await api('orders/paid', { sessionId: s.id })).json()).toEqual({ paid: false, review: true });
    expect(await status(reference)).toBe('accepted');
    expect((await payRows())[0]).toMatchObject({ problem: 'amount_mismatch', amount_cents: 100 });
    const admin = await makeAdmin(t, { paymentsConfigured: true });
    const page = await (await admin.get(`/admin/orders/${reference}`)).text();
    expect(page).toContain('Not applied: the amount paid isn’t the order’s total');
    expect(page).toContain('https://dashboard.stripe.com/test/payments/pi_test_');
  });

  it('a payment for an order that lapsed meanwhile is flagged, not applied', async () => {
    await setup();
    const { token, reference } = await accepted();
    const s = await startPay(token);
    await transitionOrder(deps(), { reference, to: 'lapsed', actor: 'system' });
    stripe.pay(s.id);
    await pollEvents(t.payments!);
    expect(await status(reference)).toBe('lapsed');
    expect((await payRows())[0]).toMatchObject({ problem: 'order_lapsed' });
  });

  it('a session completed after the customer clicked Pay now again is applied, not paid twice', async () => {
    await setup();
    const { token, reference } = await accepted();
    const s = await startPay(token);
    stripe.pay(s.id);
    const r = await api('orders/pay', { token });
    expect(r.status).toBe(409);
    expect(await status(reference)).toBe('paid');
  });

  it('admin shows the payment: amount, fee, time and a Stripe dashboard link', async () => {
    await setup();
    const { token, reference } = await accepted();
    const s = await startPay(token);
    stripe.pay(s.id);
    await api('orders/paid', { sessionId: s.id });
    const page = await (await (await makeAdmin(t, { paymentsConfigured: true })).get(`/admin/orders/${reference}`)).text();
    expect(page).toContain('<h2>Payment</h2>');
    expect(page).toContain('<strong>A$71.70</strong> by card');
    expect(page).toContain(`Stripe fee A$${(stripe.feeFor(7170) / 100).toFixed(2)}`);
    expect(page).toContain('Open in Stripe');
  });

  it('a fee Stripe hasn’t worked out by the return is filled in by the next poll (seen 3 Nov 2026)', async () => {
    await setup();
    const { token, reference } = await accepted();
    const s = await startPay(token);
    stripe.pay(s.id);
    stripe.feePending = true;
    await api('orders/paid', { sessionId: s.id });
    expect((await payRows())[0]).toMatchObject({ fee_cents: null });
    const admin = await makeAdmin(t, { paymentsConfigured: true });
    expect(await (await admin.get(`/admin/orders/${reference}`)).text()).toContain('Stripe fee not known yet');
    stripe.feePending = false;
    await pollEvents(t.payments!);
    expect((await payRows())[0]).toMatchObject({ fee_cents: stripe.feeFor(7170) });
    expect(await (await admin.get(`/admin/orders/${reference}`)).text()).toContain(`net A$${((7170 - stripe.feeFor(7170)) / 100).toFixed(2)}`);
  });

  it('a Stripe outage on Pay now is a plain 502, and the order stays Accepted', async () => {
    await setup();
    const { token, reference } = await accepted();
    stripe.failNext.push(500);
    const r = await api('orders/pay', { token });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { message: string }).message).toContain('try again');
    expect(await status(reference)).toBe('accepted');
  });
});
