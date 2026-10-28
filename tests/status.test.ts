/** Private status links (SCRUM-70). */
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken, linkExpiresAt, linkIsLive, newStatusToken, TOKEN_RE, type OrderStatus } from '../src/orders/model.js';
import type { LinksMailer } from '../src/orders/status.js';
import { count, makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';
import { DB_BACKEND } from './helpers/db.js';

let t: TestApp;
afterEach(async () => t?.close());

const DAY = 24 * 60 * 60 * 1000;

describe('tokens', () => {
  it('carry 256 random bits as 43 URL-safe characters', () => {
    const seen = new Set(Array.from({ length: 1000 }, newStatusToken));
    expect(seen.size).toBe(1000);
    for (const tok of seen) expect(tok).toMatch(TOKEN_RE);
    expect(Buffer.from(newStatusToken(), 'base64url')).toHaveLength(32);
  });

  it('are stored only as a SHA-256 hash', () => {
    expect(hashToken('a'.repeat(43))).toHaveLength(32);
  });
});

describe('link expiry per status (injected clock)', () => {
  const changed = new Date('2026-11-01T00:00:00Z');
  const at = (days: number) => new Date(changed.getTime() + days * DAY);
  const table: [OrderStatus, number, boolean][] = [
    ['submitted', 3650, true],
    ['in_queue', 400, true],
    ['posted_back', 400, true],
    ['completed', 89.9, true], ['completed', 90, false],
    ['rejected', 29.9, true], ['rejected', 30, false],
    ['lapsed', 29.9, true], ['lapsed', 30, false],
    ['withdrawn', 0, false],
  ];
  for (const [status, days, live] of table) {
    it(`${status}, ${days} days later: ${live ? 'works' : 'expired'}`, () => {
      expect(linkIsLive(status, changed, at(days))).toBe(live);
    });
  }
  it('open orders have no expiry yet', () => expect(linkExpiresAt('accepted', changed)).toBeNull());
});

async function placeOrder(email = 'player@test.picklemypaddle.com') {
  const res = await post(t, await orderForm(t, { email }));
  return (await res.json()) as { reference: string; statusToken: string };
}
const status = (token: unknown) =>
  t.app.request('/api/orders/status', { method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json', Origin: SITE } });

describe(`POST /api/orders/status (${DB_BACKEND})`, () => {
  it('shows the minimal view only: never name, address, phone, email or photos', async () => {
    t = await makeApp();
    const order = await placeOrder();
    const res = await status(order.statusToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const view = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual([
      'backInPostBy', 'history', 'paddles', 'queuePosition', 'reference', 'review', 'status', 'statusLabel', 'test', 'trackingNumber',
    ]);
    expect(view).toMatchObject({
      reference: order.reference,
      status: 'submitted',
      paddles: [{ brand: 'Selkirk', model: 'Vanguard Power Air' }],
      trackingNumber: null,
      test: true,
    });
    const text = JSON.stringify(view);
    for (const personal of ['Test Player', 'player@test', '0412', 'Court St', 'Sydney', '2000', '.jpg']) {
      expect(text).not.toContain(personal);
    }
  });

  it('answers unknown, malformed, revoked and expired links identically', async () => {
    t = await makeApp();
    const order = await placeOrder();
    const revoked = await placeOrder('other@test.picklemypaddle.com');
    await t.db.query('UPDATE status_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(revoked.statusToken)]);
    const expired = await placeOrder('third@test.picklemypaddle.com');
    await t.db.query(
      "UPDATE orders SET status = 'completed', status_changed_at = $2 WHERE reference = $1",
      [expired.reference, new Date(t.clock.now.getTime() - 91 * DAY)],
    );
    const answers = [];
    for (const token of [newStatusToken(), 'short', 42, null, revoked.statusToken, expired.statusToken]) {
      const res = await status(token);
      answers.push({ status: res.status, body: await res.text() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]!.status).toBe(404);
    expect(answers[0]!.body).toContain('isn’t valid or has expired');
    expect((await status(order.statusToken)).status).toBe(200);
  });

  it('a Withdrawn order\'s link stops at once', async () => {
    t = await makeApp();
    const order = await placeOrder();
    await t.db.query("UPDATE orders SET status = 'withdrawn', status_changed_at = $2 WHERE reference = $1", [order.reference, t.clock.now]);
    expect((await status(order.statusToken)).status).toBe(404);
  });

  it('a deleted order\'s link stops at once', async () => {
    t = await makeApp();
    const order = await placeOrder();
    await t.db.query('DELETE FROM orders WHERE reference = $1', [order.reference]);
    expect((await status(order.statusToken)).status).toBe(404);
  });
});

describe(`"email me my links" (${DB_BACKEND})`, () => {
  const ask = (email: string) =>
    t.app.request('/api/orders/links', { method: 'POST', body: JSON.stringify({ email }), headers: { 'Content-Type': 'application/json', Origin: SITE } });

  const fakeMailer = () => {
    const sent: { to: string; links: { reference: string; token: string }[] }[] = [];
    const mailer: LinksMailer = { async sendLinks(to, links) { sent.push({ to, links }); return true; } };
    return { sent, mailer };
  };

  it('gives the same answer for a known and an unknown address', async () => {
    const { mailer } = fakeMailer();
    t = await makeApp({ mailer });
    await placeOrder('known@test.picklemypaddle.com');
    const known = await ask('known@test.picklemypaddle.com');
    const unknown = await ask('nobody@test.picklemypaddle.com');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.text()).toBe(await unknown.text());
  });

  it('sends one email with a fresh link per live order, and the old links stop working', async () => {
    const { sent, mailer } = fakeMailer();
    t = await makeApp({ mailer });
    const a = await placeOrder('Many@Test.PickleMyPaddle.com');
    const b = await placeOrder('many@test.picklemypaddle.com');
    const old = await placeOrder('many@test.picklemypaddle.com');
    await t.db.query("UPDATE orders SET status = 'completed', status_changed_at = $2 WHERE reference = $1", [old.reference, new Date(t.clock.now.getTime() - 100 * DAY)]);
    await ask('MANY@test.picklemypaddle.com');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.links.map((l) => l.reference).sort()).toEqual([a.reference, b.reference].sort());
    expect((await status(a.statusToken)).status).toBe(404);
    expect((await status(sent[0]!.links[0]!.token)).status).toBe(200);
  });

  it('keeps the old links if the email fails to send', async () => {
    t = await makeApp({ mailer: { async sendLinks() { throw new Error('mail down'); } } });
    const a = await placeOrder();
    expect((await ask('player@test.picklemypaddle.com')).status).toBe(202);
    expect((await status(a.statusToken)).status).toBe(200);
    expect(await count(t.db, 'status_tokens')).toBe(1);
  });

  it('without an email service yet (until SCRUM-69) changes nothing', async () => {
    t = await makeApp();
    const a = await placeOrder();
    expect((await ask('player@test.picklemypaddle.com')).status).toBe(202);
    expect((await status(a.statusToken)).status).toBe(200);
  });

  it('is rate-limited: 3 per address per day, 10 per IP per hour', async () => {
    t = await makeApp();
    for (let i = 0; i < 3; i++) expect((await ask('a@test.picklemypaddle.com')).status).toBe(202);
    expect((await ask('a@test.picklemypaddle.com')).status).toBe(429);
    for (let i = 0; i < 7; i++) expect((await ask(`b${i}@test.picklemypaddle.com`)).status).toBe(202);
    const res = await ask('c@test.picklemypaddle.com');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('refuses something that isn\'t an email address', async () => {
    t = await makeApp();
    expect((await ask('nope')).status).toBe(400);
  });
});
