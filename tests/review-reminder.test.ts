/**
 * The one review reminder (SCRUM-80): 10 days after Posted back, only without a review, never
 * twice; the staging-only "Send review reminder now (test)"; the "Reviewed" badge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { processOutbox } from '../src/email/outbox.js';
import { submitReview } from '../src/orders/reviews.js';
import { runReviewReminders } from '../src/orders/review-reminder.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const DAY = 24 * 60 * 60 * 1000;
let n = 0;

async function place(email = `rr${++n}@test.picklemypaddle.com`): Promise<{ reference: string; token: string; email: string }> {
  const res = await post(t, await orderForm(t, { email }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { reference: string; statusToken: string };
  return { reference: body.reference, token: body.statusToken, email };
}

async function walk(reference: string, ...steps: string[]) {
  for (const to of steps) {
    await transitionOrder(
      { db: t.db, isProduction: false, now: t.clock.now },
      { reference, to: to as never, actor: 'admin', ...(to === 'posted_back' ? { trackingNumber: 'AP1' } : {}) },
    );
  }
}
const toPostedBack = (reference: string) => walk(reference, 'accepted', 'paid', 'in_queue', 'regritted', 'posted_back');

const reminders = async (reference?: string) =>
  (
    await t.db.query<{ reference: string; recipient: string }>(
      `SELECT o.reference, ob.recipient FROM outbox ob JOIN orders o ON o.id = ob.order_id
        WHERE ob.template = 'review_reminder' ${reference ? 'AND o.reference = $1' : ''} ORDER BY ob.id`,
      reference ? [reference] : [],
    )
  ).rows;

const at = (days: number) => new Date(t.clock.now.getTime() + days * DAY);

describe('the daily review reminder', () => {
  it('goes 10 days after Posted back, to the customer, once only', async () => {
    t = await makeApp();
    const o = await place();
    await toPostedBack(o.reference);

    expect(await runReviewReminders(t.db, at(9.9))).toBe(0);
    expect(await runReviewReminders(t.db, at(10))).toBe(1);
    expect(await reminders(o.reference)).toEqual([{ reference: o.reference, recipient: o.email }]);
    // Never a second one, however often the job runs.
    expect(await runReviewReminders(t.db, at(11))).toBe(0);
    expect(await runReviewReminders(t.db, at(400))).toBe(0);
    expect(await reminders(o.reference)).toHaveLength(1);
  });

  it('still waits the 10 days when the order was completed by hand earlier', async () => {
    t = await makeApp();
    const o = await place();
    await toPostedBack(o.reference);
    await walk(o.reference, 'completed');
    expect(await runReviewReminders(t.db, at(3))).toBe(0);
    expect(await runReviewReminders(t.db, at(10))).toBe(1);
  });

  it('is not sent when a review has come in', async () => {
    t = await makeApp();
    const o = await place();
    await toPostedBack(o.reference);
    const r = await submitReview(t.db, { token: o.token, quote: 'Like new, thanks!', firstName: 'Sam', suburb: 'Newtown', permission: false }, t.clock.now);
    expect(r.ok).toBe(true);
    expect(await runReviewReminders(t.db, at(30))).toBe(0);
  });

  it('is never sent for orders that weren’t posted back, or for smoke orders', async () => {
    t = await makeApp();
    const rejected = await place();
    await transitionOrder({ db: t.db, isProduction: false, now: t.clock.now }, { reference: rejected.reference, to: 'rejected', actor: 'admin', reason: 'Cracked face.' });
    const withdrawn = await place();
    await walk(withdrawn.reference, 'accepted', 'withdrawn');
    const queued = await place();
    await walk(queued.reference, 'accepted', 'paid', 'in_queue');
    const smoke = await place('smoke+rr@example.com');
    await toPostedBack(smoke.reference);
    expect(await runReviewReminders(t.db, at(60))).toBe(0);
    expect(await reminders()).toEqual([]);
  });

  it('renders with a fresh status link to the review form, and says it is the only one', async () => {
    t = await makeApp();
    const o = await place('attila@test.picklemypaddle.com'); // the test app's allow-listed address
    await toPostedBack(o.reference);
    await t.db.query(`UPDATE outbox SET state = 'sent' WHERE kind = 'email'`); // only the reminder left to send
    await runReviewReminders(t.db, at(10));
    const sent: { to: string; subject: string; text: string }[] = [];
    const run = await processOutbox({
      db: t.db,
      sender: { name: 'fake', send: async (m) => (sent.push(m), { id: 'x' }) },
      settings: { isProduction: false, allowList: ['attila@test.picklemypaddle.com'], siteUrl: 'http://site.test', adminUrl: null },
      now: () => at(10),
    });
    expect(run.sent).toBe(1);
    expect(sent[0]!.subject).toBe(`[TEST] How’s the re-gritted paddle? (${o.reference})`);
    expect(sent[0]!.text).toMatch(/http:\/\/site\.test\/order\/status\?review=1#[A-Za-z0-9_-]{43}/);
    expect(sent[0]!.text).toContain('This is the only reminder we’ll send about it.');
  });
});

describe('admin: "Send review reminder now (test)" and the Reviewed badge', () => {
  it('sends the reminder at once on staging, only once, and says when it went', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const o = await place();
    await toPostedBack(o.reference);

    let page = await (await a.get(`/admin/orders/${o.reference}`)).text();
    expect(page).toContain('No review yet. The one reminder goes automatically on');
    expect(page).toContain('Send review reminder now (test)');

    const res = await a.post(`/admin/orders/${o.reference}/review-reminder-test`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/orders/${o.reference}?done=reminder`);
    expect(await reminders(o.reference)).toHaveLength(1);

    page = await (await a.get(`/admin/orders/${o.reference}?done=reminder`)).text();
    expect(page).toContain('Review reminder queued');
    expect(page).toContain('The one reminder went on');
    expect(page).not.toContain('Send review reminder now (test)');
    // A second press, and the daily job later, send nothing more.
    expect((await a.post(`/admin/orders/${o.reference}/review-reminder-test`)).status).toBe(409);
    expect(await runReviewReminders(t.db, at(30))).toBe(0);
    expect(await reminders(o.reference)).toHaveLength(1);
  });

  it('refuses an order that hasn’t been posted back', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const o = await place();
    expect((await a.post(`/admin/orders/${o.reference}/review-reminder-test`)).status).toBe(409);
    expect(await (await a.get(`/admin/orders/${o.reference}`)).text()).not.toContain('Send review reminder now');
  });

  it('has no button and no route in production', async () => {
    t = await makeApp();
    const prod = await makeAdmin(t, { isProduction: true });
    const o = await place();
    await toPostedBack(o.reference);
    expect(await (await prod.get(`/admin/orders/${o.reference}`)).text()).not.toContain('Send review reminder now');
    expect((await prod.post(`/admin/orders/${o.reference}/review-reminder-test`)).status).toBe(404);
    expect(await reminders()).toEqual([]);
  });

  it('marks reviewed orders in the list, private ones as such', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const quoted = await place();
    const privateOne = await place();
    for (const [o, permission] of [[quoted, true], [privateOne, false]] as const) {
      await toPostedBack(o.reference);
      await submitReview(t.db, { token: o.token, quote: 'Great job, plays like new.', firstName: 'Sam', suburb: 'Newtown', permission }, t.clock.now);
    }
    const list = await (await a.get('/admin/orders?status=posted_back')).text();
    expect(list).toContain('<span class="badge sent">Reviewed</span>');
    expect(list).toContain('<span class="badge sent">Reviewed (private)</span>');
  });
});
