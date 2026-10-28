/**
 * Reviews from the private status page (SCRUM-33).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { processOutbox } from '../src/email/outbox.js';
import { ALERT_TO, type EmailMessage, type EmailSender } from '../src/email/sender.js';
import { validateReview } from '../src/orders/reviews.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { DB_BACKEND } from './helpers/db.js';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => t?.close());

const EMAIL = 'player@test.picklemypaddle.com';
const json = (path: string, body: unknown) =>
  t.app.request(`/api/orders/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: SITE } });

async function postedBackOrder(): Promise<{ reference: string; token: string }> {
  const { reference, statusToken } = (await (await post(t, await orderForm(t, { email: EMAIL }))).json()) as { reference: string; statusToken: string };
  const d = { db: t.db, isProduction: false, now: t.clock.now };
  for (const to of ['accepted', 'paid', 'in_queue', 'regritted'] as const) await transitionOrder(d, { reference, to, actor: 'admin' });
  await transitionOrder(d, { reference, to: 'posted_back', actor: 'admin', trackingNumber: '33XYZ0123456789' });
  return { reference, token: statusToken };
}

const good = { quote: 'Feels brand new: the spin is back.', firstName: 'Sam', suburb: 'Newtown', permission: true };

function recorder(): EmailSender & { sent: EmailMessage[] } {
  const s = { name: 'fake', sent: [] as EmailMessage[], async send(m: EmailMessage) { s.sent.push(m); return { id: 'x' }; } };
  return s;
}

describe('review validation', () => {
  it('accepts a short review with an explicit yes or no', () => {
    expect(validateReview({ token: '', ...good })).toEqual({ quote: good.quote, firstName: 'Sam', suburb: 'Newtown', permission: true });
    expect(validateReview({ token: '', ...good, firstName: ' Siobhán ', suburb: "Coogee", permission: false })).toMatchObject({ firstName: 'Siobhán', permission: false });
  });
  it('names each problem', () => {
    const r = validateReview({ token: '', quote: 'ok', firstName: 'Sam 2', suburb: '', permission: 'yes' });
    expect(r).toEqual({
      errors: {
        quote: 'Tell us a little more (a sentence or two).',
        firstName: 'Enter just your first name.',
        suburb: 'Enter your suburb or town.',
        permission: 'Choose whether we may quote you.',
      },
    });
    expect('errors' in validateReview({ token: '', ...good, quote: 'x'.repeat(601) })).toBe(true);
    expect('errors' in validateReview({ token: '', ...good, firstName: 'Sam <b>' })).toBe(true);
  });
});

describe(`POST /api/orders/review (${DB_BACKEND})`, () => {
  it('opens on the status page once the paddles are posted back, and closes once a review is in', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const { statusToken } = (await (await post(t, await orderForm(t))).json()) as { statusToken: string };
    const view = async (token: string) => ((await (await json('status', { token })).json()) as { review: unknown }).review;
    expect(await view(statusToken)).toBeNull();
    expect((await json('review', { token: statusToken, ...good })).status).toBe(409);

    const { token } = await postedBackOrder();
    expect(await view(token)).toBe('open');
    const res = await json('review', { token, ...good });
    expect(res.status).toBe(201);
    expect(await view(token)).toBe('received');
    const again = await json('review', { token, ...good });
    expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([409, 'already_received']);
  });

  it('stores the permission with its time, and alerts Attila with the review only when it may be quoted', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const a = await postedBackOrder();
    await json('review', { token: a.token, ...good });
    const b = await postedBackOrder();
    await json('review', { token: b.token, ...good, quote: 'Private: the grip is great but postage was slow.', permission: false });

    const { rows } = await t.db.query<{ quote: string; permission: boolean; permission_at: Date | null }>(
      'SELECT quote, permission, permission_at FROM reviews ORDER BY id');
    expect(rows.map((r) => [r.permission, r.permission_at !== null])).toEqual([[true, true], [false, false]]);

    const sender = recorder();
    await processOutbox({ db: t.db, sender, settings: { isProduction: false, allowList: [EMAIL, ALERT_TO], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
    const alerts = sender.sent.filter((m) => m.subject.includes('Review for'));
    expect(alerts.map((m) => [m.to, m.subject])).toEqual([
      [ALERT_TO, `[TEST] Review for ${a.reference} (may quote)`],
      [ALERT_TO, `[TEST] Review for ${b.reference} (not for quoting)`],
    ]);
    expect(alerts[0]!.text).toContain(good.quote);
    expect(alerts[0]!.text).toContain('Sam, Newtown');
    expect(alerts[1]!.text).not.toContain('postage was slow');
    for (const m of alerts) expect(m.text).not.toContain(EMAIL);
  });

  it('the Posted back email asks for a review with a working link to the form', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await postedBackOrder();
    const sender = recorder();
    await processOutbox({ db: t.db, sender, settings: { isProduction: false, allowList: [EMAIL, ALERT_TO], siteUrl: SITE, adminUrl: null }, now: () => t.clock.now });
    const posted = sender.sent.find((m) => m.subject.includes('on the way back'))!;
    expect(posted.text).toMatch(/how did we do\?/i);
    const token = /\/order\/status\?review=1#([A-Za-z0-9_-]{43})/.exec(posted.text)?.[1];
    expect(token).toBeDefined();
    expect((await json('review', { token, ...good })).status).toBe(201);
  });

  it('answers a bad link like the status page does, and a bad review with its problems', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const bad = await json('review', { token: 'x'.repeat(43), ...good });
    expect([bad.status, await bad.json()]).toEqual([404, { error: 'invalid_link', message: 'This link isn’t valid or has expired.' }]);
    const { token } = await postedBackOrder();
    const res = await json('review', { token, ...good, quote: '' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Record<string, string> }).errors.quote).toBeDefined();
    expect((await t.db.query('SELECT 1 FROM reviews')).rows).toHaveLength(0);
  });

  it('is rate-limited per IP', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    for (let i = 0; i < 10; i++) expect((await json('review', { token: 'y'.repeat(43), ...good })).status).toBe(404);
    expect((await json('review', { token: 'y'.repeat(43), ...good })).status).toBe(429);
  });
});
