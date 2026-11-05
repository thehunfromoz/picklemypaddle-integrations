/**
 * Paying club invoices (SCRUM-85, part 2): PayID and cash recorded by hand (part payments, the
 * balance, Paid once it reaches the total), card through a faked Stripe Checkout (start, the
 * return, the poller, part-paid invoices, a payment that arrives after it's been paid), and the
 * overdue flag in the admin.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createBatch, createClub, findBatch, isOverdue, returnBatch } from '../src/clubs/clubs.js';
import { invoiceBalance, recordClubPayment } from '../src/clubs/payments.js';
import { DEFAULT_SELLER, documentByNumber } from '../src/documents/documents.js';
import { processOutbox } from '../src/email/outbox.js';
import type { EmailMessage } from '../src/email/sender.js';
import { pollEvents } from '../src/payments/payments.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, SITE, type TestApp } from './helpers/app.js';
import { fakeStripe, type FakeStripe } from './helpers/fake-stripe.js';

let t: TestApp;
let stripe: FakeStripe;
afterEach(async () => t?.close());

const BILLING = 'jo@test.picklemypaddle.com';
const seller = { ...DEFAULT_SELLER, payId: 'payments@picklemypaddle.com' };

/** A club with a returned, invoiced batch of `paddles` (× A$54). */
async function invoiced(paddles = 5, opts: { stripe?: boolean } = {}) {
  // Charges are stamped with the test's clock, not today's date (this test failed once the real date moved on).
  stripe = fakeStripe({ clock: { get now() { return t.clock.now; } } });
  t = await makeApp(opts.stripe ? { stripe } : {});
  t.clock.now = new Date('2026-11-04T01:00:00Z');
  const club = await createClub(t.db, { name: 'Inner West PC', billingName: 'Jo Treasurer', billingEmail: BILLING, billingAddress: '1 Court St', abn: null, notes: null }, { isProduction: false, now: t.clock.now });
  const batch = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-02', paddleCount: paddles, notes: null, now: t.clock.now });
  await returnBatch({ db: t.db, seller, isProduction: false, paymentTermsDays: 14, now: t.clock.now, payByCard: !!opts.stripe }, { reference: batch.reference, returnedOn: '2026-11-04', unchangedCount: 0 });
  const b = (await findBatch(t.db, batch.reference))!;
  return { batch: b, invoiceId: b.invoice!.id, number: b.invoice!.number };
}

const pay = (reference: string, over: Partial<Parameters<typeof recordClubPayment>[1]> = {}) =>
  recordClubPayment(t.db, { batchReference: reference, method: 'payid', amountCents: 27000, paidOn: '2026-11-04', reference: 'TX123', by: 'attila@test', now: t.clock.now, ...over });

describe('PayID and cash payments, recorded by hand', () => {
  it('part payments show the balance; the last one makes the invoice and the batch Paid', async () => {
    const { batch, invoiceId, number } = await invoiced(5); // A$270
    expect(await pay(batch.reference, { amountCents: 10000 })).toEqual({ paidInFull: false, balanceCents: 17000 });
    expect(await findBatch(t.db, batch.reference)).toMatchObject({ status: 'invoiced', invoice: { balanceCents: 17000 } });
    expect((await documentByNumber(t.db, number))!.paid).toBeNull();

    expect(await pay(batch.reference, { method: 'cash', amountCents: 17000, paidOn: '2026-11-04', reference: null })).toEqual({ paidInFull: true, balanceCents: 0 });
    expect(await findBatch(t.db, batch.reference)).toMatchObject({ status: 'paid', invoice: { balanceCents: 0 } });
    expect((await documentByNumber(t.db, number))!.paid).toEqual({ on: '2026-11-04', method: 'PayID and cash' });
    expect(await invoiceBalance(t.db, invoiceId)).toEqual({ totalCents: 27000, paidCents: 27000, balanceCents: 0 });
  });

  it('refuses more than is owing, card by hand, a future date, a date before collection, and a batch not invoiced', async () => {
    const { batch } = await invoiced(5);
    await expect(pay(batch.reference, { amountCents: 27001 })).rejects.toMatchObject({ code: 'too_much' });
    await expect(pay(batch.reference, { method: 'card' })).rejects.toMatchObject({ code: 'bad_method' });
    await expect(pay(batch.reference, { paidOn: '2026-11-05' })).rejects.toMatchObject({ code: 'future_date' });
    await expect(pay(batch.reference, { paidOn: '2026-11-01' })).rejects.toMatchObject({ code: 'bad_date' });
    // Looks like a date but isn't one: a form error, not a crash.
    await expect(pay(batch.reference, { paidOn: '2026-13-01' })).rejects.toMatchObject({ code: 'bad_date' });
    await expect(pay(batch.reference, { paidOn: '2026-02-30' })).rejects.toMatchObject({ code: 'bad_date' });
    await expect(pay(batch.reference, { amountCents: 0 })).rejects.toMatchObject({ code: 'bad_amount' });
    await pay(batch.reference);
    await expect(pay(batch.reference, { amountCents: 1 })).rejects.toMatchObject({ code: 'not_owing' });

    const club = (await t.db.query<{ id: string }>('SELECT id FROM clubs')).rows[0]!;
    const open = await createBatch(t.db, { clubId: club.id, collectedOn: '2026-11-03', paddleCount: 2, notes: null, now: t.clock.now });
    await expect(pay(open.reference, { amountCents: 100 })).rejects.toMatchObject({ code: 'not_owing' });
  });

  it('the admin records a payment, shows what is owing and flags an overdue invoice', async () => {
    const { batch } = await invoiced(5);
    const admin = await makeAdmin(t);
    const r = await admin.post(`/admin/batches/${batch.reference}/payments`, { amount: '100', paidOn: '2026-11-04', method: 'payid', reference: 'TX1' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('done=payment_recorded');
    let page = await (await admin.get(`/admin/batches/${batch.reference}`)).text();
    expect(page).toContain('Still owing: <strong>A$170</strong>');
    expect(page).toContain('TX1');
    expect(page).not.toContain('Overdue');

    const bad = await admin.post(`/admin/batches/${batch.reference}/payments`, { amount: '500', paidOn: '2026-11-04', method: 'cash' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('That’s more than is owing (A$170).');

    // Two weeks and a day later: overdue, in the batch list and on its page.
    t.clock.now = new Date('2026-11-19T01:00:00Z');
    expect(isOverdue((await findBatch(t.db, batch.reference))!, '2026-11-19')).toBe(true);
    expect(await (await admin.get('/admin/batches')).text()).toContain('Overdue');
    page = await (await admin.get(`/admin/batches/${batch.reference}`)).text();
    expect(page).toContain('Overdue');

    const done = await admin.post(`/admin/batches/${batch.reference}/payments`, { amount: '170', paidOn: '2026-11-19', method: 'cash' });
    expect(done.headers.get('location')).toContain('done=payment_paid');
    page = await (await admin.get(`/admin/batches/${batch.reference}`)).text();
    expect(page).toContain('Paid in full.');
    expect(page).not.toContain('Overdue');
  });
});

describe('card payments through Stripe Checkout', () => {
  const api = (path: string, body: unknown) =>
    t.app.request(`/api/clubs/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: SITE } });

  /** The invoice email's private link token. */
  async function tokenFor(number: string): Promise<string> {
    const sent: EmailMessage[] = [];
    await processOutbox({ db: t.db, sender: { name: 'fake', send: async (m) => (sent.push(m), { id: 'e' }) }, settings: { isProduction: false, allowList: [BILLING], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
    const m = sent.find((x) => x.subject.includes(number))!;
    expect(m.text).toContain('View, print or pay by card');
    return new RegExp(`/club/invoice\\?n=${number}#([A-Za-z0-9_-]{43})`).exec(m.text)![1]!;
  }

  it('pays what is owing by card: the page offers it, Checkout is for the balance, the return applies it', async () => {
    const { batch, number } = await invoiced(5, { stripe: true });
    const token = await tokenFor(number);
    await pay(batch.reference, { amountCents: 7000 }); // a PayID part payment first

    const view = (await (await api('invoice', { token, number })).json()) as { balanceCents: number; canPayByCard: boolean; payments: unknown[]; snapshot: { payByCard?: boolean } };
    expect(view).toMatchObject({ balanceCents: 20000, canPayByCard: true, payments: [{ method: 'PayID', amountCents: 7000, paidOn: '2026-11-04' }] });
    expect(view.snapshot.payByCard).toBe(true);

    const started = await api('pay', { token, number });
    expect(started.status).toBe(200);
    expect((await started.json()) as { url: string }).toMatchObject({ url: expect.stringContaining('checkout') });
    const [sessionId, session] = [...stripe.sessions.entries()].at(-1)!;
    expect(session.params.get('line_items[0][price_data][unit_amount]')).toBe('20000');
    expect(session.params.get('client_reference_id')).toMatch(/^club-inv-\d+$/);
    expect(session.params.get('success_url')).toBe(`${SITE}/club/paid?session_id={CHECKOUT_SESSION_ID}`);
    expect(session.params.get('success_url')).not.toContain(token);
    expect(session.params.get('cancel_url')).not.toContain(token);

    stripe.pay(sessionId);
    const back = await api('paid', { sessionId });
    expect(await back.json()).toEqual({ paid: true, number });
    expect(await findBatch(t.db, batch.reference)).toMatchObject({ status: 'paid', invoice: { balanceCents: 0 } });
    expect((await documentByNumber(t.db, number))!.paid).toEqual({ on: '2026-11-04', method: 'PayID and card' });
    // The same return again, or the poller seeing the event, changes nothing.
    expect(await (await api('paid', { sessionId })).json()).toEqual({ paid: true, number });
    await pollEvents(t.payments!);
    expect(Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM club_payments WHERE method = 'card'`)).rows[0]!.n)).toBe(1);
    // Nothing left to pay.
    const again = await api('pay', { token, number });
    expect(again.status).toBe(409);
    expect(((await (await api('invoice', { token, number })).json()) as { canPayByCard: boolean }).canPayByCard).toBe(false);
  });

  it('the events poller applies a card payment the return never reported', async () => {
    const { batch, number } = await invoiced(2, { stripe: true });
    const token = await tokenFor(number);
    await api('pay', { token, number });
    stripe.pay([...stripe.sessions.keys()].at(-1)!);
    await pollEvents(t.payments!);
    expect(await findBatch(t.db, batch.reference)).toMatchObject({ status: 'paid' });
  });

  it('a card payment that arrives after the invoice was paid by PayID is flagged, not applied, and shown in the admin', async () => {
    const { batch, number } = await invoiced(2, { stripe: true });
    const token = await tokenFor(number);
    await api('pay', { token, number });
    const sessionId = [...stripe.sessions.keys()].at(-1)!;
    await pay(batch.reference, { amountCents: 10800 }); // paid in full by PayID meanwhile
    stripe.pay(sessionId);
    expect(await (await api('paid', { sessionId })).json()).toEqual({ paid: false, review: true });
    expect(Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM club_payments`)).rows[0]!.n)).toBe(1);
    const admin = await makeAdmin(t);
    const page = await (await admin.get(`/admin/batches/${batch.reference}`)).text();
    expect(page).toContain('wasn’t applied: the invoice was already paid in full. Refund it in the Stripe dashboard.');
    // Attila is told too: the batch is Paid, so it drops off the open list and he'd not see it otherwise.
    const alerts = await t.db.query<{ recipient: string; payload: string | { problem: string } }>(
      `SELECT recipient, payload FROM outbox WHERE kind = 'email' AND template = 'alert_payment' AND batch_id = $1`,
      [(await findBatch(t.db, batch.reference))!.id],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]!.recipient).toBe('sales@picklemypaddle.com');
    const sent: EmailMessage[] = [];
    await processOutbox({ db: t.db, sender: { name: 'fake', send: async (m) => (sent.push(m), { id: 'e' }) }, settings: { isProduction: false, allowList: ['sales@picklemypaddle.com'], siteUrl: SITE, adminUrl: 'https://admin.test' }, now: () => t.clock.now });
    const alert = sent.find((m) => m.subject.includes('Payment to check'))!;
    expect(alert.to).toBe('sales@picklemypaddle.com');
    expect(alert.subject).toContain(batch.reference);
    expect(alert.text).toContain('club batch');
    expect(alert.text).toContain('already paid in full');
    expect(alert.text).not.toContain('reinstated');
    expect(alert.text).toContain(`https://admin.test/admin/batches/${batch.reference}`);
  });

  it('a wrong token, an order’s session id or no Stripe here gets nowhere', async () => {
    const { number } = await invoiced(2);
    expect((await api('pay', { token: 'x'.repeat(43), number })).status).toBe(404);
    const token = await (async () => {
      const sent: EmailMessage[] = [];
      await processOutbox({ db: t.db, sender: { name: 'fake', send: async (m) => (sent.push(m), { id: 'e' }) }, settings: { isProduction: false, allowList: [BILLING], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
      expect(sent[0]!.text).toContain('View or print the invoice');
      expect(sent[0]!.text).not.toMatch(/card/i);
      return /#([A-Za-z0-9_-]{43})/.exec(sent[0]!.text)![1]!;
    })();
    expect(((await (await api('invoice', { token, number })).json()) as { canPayByCard: boolean }).canPayByCard).toBe(false);
    const r = await api('pay', { token, number });
    expect(r.status).toBe(503);
    expect((await api('paid', { sessionId: 'cs_test_nope0000000000' })).status).toBe(503);
  });
});
