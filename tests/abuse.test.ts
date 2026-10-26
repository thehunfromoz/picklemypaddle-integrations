/** Abuse protection on the order endpoints (SCRUM-67). */
import { afterEach, describe, expect, it } from 'vitest';
import { checkFormToken, clientIp, issueFormToken, TrustedProxies } from '../src/orders/abuse.js';
import { count, makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';
import { DB_BACKEND } from './helpers/db.js';

let t: TestApp;
afterEach(async () => t?.close());

const emailN = (i: number) => `player${i}@test.picklemypaddle.com`;

describe(`bots get a normal-looking answer and nothing is stored (${DB_BACKEND})`, () => {
  it('honeypot filled → 201 with a reference, nothing stored', async () => {
    t = await makeApp();
    const res = await post(t, await orderForm(t, { honeypot: 'https://spam.example' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { reference: string }).reference).toMatch(/^PMP-/);
    expect(await count(t.db, 'orders')).toBe(0);
  });

  it('submitted under 3 seconds after the form loaded → the same', async () => {
    t = await makeApp();
    const res = await post(t, await orderForm(t, { formToken: t.formToken(1) }));
    expect(res.status).toBe(201);
    expect(await count(t.db, 'orders')).toBe(0);
  });

  it('missing, forged or day-old form token → 400 asking to reload', async () => {
    t = await makeApp();
    for (const formToken of ['', '1761440000000.forged', t.formToken(25 * 60 * 60)]) {
      const res = await post(t, await orderForm(t, { formToken }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { errors: { form: string } }).errors.form).toMatch(/reload/);
    }
    expect(await count(t.db, 'orders')).toBe(0);
  });
});

describe('form tokens', () => {
  const key = Buffer.alloc(32, 7);
  const now = new Date('2026-10-26T00:00:00Z');
  it('round-trip and report their age', () => {
    const tok = issueFormToken(key, new Date(now.getTime() - 5000));
    expect(checkFormToken(key, tok, now)).toEqual({ ok: true, ageMs: 5000 });
  });
  it('fail with another key or a changed time', () => {
    const tok = issueFormToken(key, now);
    expect(checkFormToken(Buffer.alloc(32, 8), tok, now).ok).toBe(false);
    expect(checkFormToken(key, tok.replace(/^\d/, (d) => String((Number(d) + 1) % 10)), now).ok).toBe(false);
  });
});

describe(`rate limits (${DB_BACKEND})`, () => {
  it('the 6th order from one IP within an hour → 429 with Retry-After and a message', async () => {
    t = await makeApp();
    for (let i = 0; i < 5; i++) expect((await post(t, await orderForm(t, { email: emailN(i) }))).status).toBe(201);
    const res = await post(t, await orderForm(t, { email: emailN(9) }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(3500);
    expect(((await res.json()) as { message: string }).message).toMatch(/try again later/);
    expect(await count(t.db, 'orders')).toBe(5);
  });

  it('allows that IP again once the hour has passed', async () => {
    t = await makeApp();
    for (let i = 0; i < 5; i++) await post(t, await orderForm(t, { email: emailN(i) }));
    t.clock.now = new Date(t.clock.now.getTime() + 61 * 60 * 1000);
    expect((await post(t, await orderForm(t, { email: emailN(7) }))).status).toBe(201);
  });

  it('the 4th order for one email address within 24 h → 429, whatever the IP', async () => {
    t = await makeApp();
    for (let i = 0; i < 3; i++) {
      t.peer.address = `198.51.100.${i + 1}`;
      expect((await post(t, await orderForm(t, { email: 'Same@Test.PickleMyPaddle.com' }))).status).toBe(201);
    }
    t.peer.address = '198.51.100.99';
    expect((await post(t, await orderForm(t, { email: 'same@test.picklemypaddle.com' }))).status).toBe(429);
  });

  it('limits survive a restart (they live in Postgres)', async () => {
    t = await makeApp();
    for (let i = 0; i < 5; i++) await post(t, await orderForm(t, { email: emailN(i) }));
    const restarted = await makeApp({ db: t.db }); // a new app process over the same database
    expect((await post(restarted, await orderForm(restarted, { email: emailN(8) }))).status).toBe(429);
  });

  it('staging can raise the per-IP limit for smoke traffic', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging', ORDER_LIMIT_PER_IP_HOUR: '7' } });
    for (let i = 0; i < 7; i++) expect((await post(t, await orderForm(t, { email: emailN(i) }))).status).toBe(201);
    expect((await post(t, await orderForm(t, { email: emailN(8) }))).status).toBe(429);
  });

  it('stores only salted hashes, never raw IPs or emails', async () => {
    t = await makeApp();
    await post(t, await orderForm(t));
    const { rows } = await t.db.query<{ key_hash: string }>('SELECT key_hash FROM rate_limit_events');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.key_hash).not.toContain('203.0.113.7');
    }
  });
});

describe('client IP behind the gateway', () => {
  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
    const trusted = new TrustedProxies(['172.18.0.0/16']);
    expect(await clientIp('203.0.113.7', '198.51.100.1', trusted)).toBe('203.0.113.7');
    expect(await clientIp('::ffff:203.0.113.7', '198.51.100.1', trusted)).toBe('203.0.113.7');
  });

  it('takes the right-most entry (the one the gateway added) from a trusted proxy', async () => {
    const trusted = new TrustedProxies(['172.18.0.0/16']);
    expect(await clientIp('172.18.0.3', '6.6.6.6, 198.51.100.1', trusted)).toBe('198.51.100.1');
    expect(await clientIp('::ffff:172.18.0.3', '198.51.100.1', trusted)).toBe('198.51.100.1');
    expect(await clientIp('172.18.0.3', 'garbage', trusted)).toBe('172.18.0.3');
  });

  it('resolves host names such as "gateway"', async () => {
    expect(await clientIp('127.0.0.1', '198.51.100.1', new TrustedProxies(['localhost']))).toBe('198.51.100.1');
    expect(await clientIp('127.0.0.1', '198.51.100.1', new TrustedProxies(['no-such-host.invalid']))).toBe('127.0.0.1');
  });

  it('trusts nobody by default', async () => {
    expect(await clientIp('172.18.0.3', '198.51.100.1', new TrustedProxies([]))).toBe('172.18.0.3');
  });

  it('a spoofed X-Forwarded-For can\'t dodge the per-IP limit', async () => {
    t = await makeApp({ env: { TRUSTED_PROXIES: '172.18.0.0/16' } });
    for (let i = 0; i < 6; i++) {
      const res = await post(t, await orderForm(t, { email: emailN(i) }), { 'X-Forwarded-For': `198.51.100.${i}` });
      expect(res.status).toBe(i < 5 ? 201 : 429);
    }
  });
});

describe('cheap refusals before the body is read', () => {
  it('wrong content type → 415', async () => {
    t = await makeApp();
    const res = await t.app.request('/api/orders', {
      method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'Content-Type': 'application/json', Origin: SITE },
    });
    expect(res.status).toBe(415);
  });

  it('malformed multipart → 400 quickly', async () => {
    t = await makeApp();
    const started = Date.now();
    const res = await t.app.request('/api/orders', {
      method: 'POST',
      body: '--xyz\r\nContent-Disposition: form-data; name="name"\r\n\r\nunterminated',
      headers: { 'Content-Type': 'multipart/form-data; boundary=xyz', Origin: SITE },
    });
    expect(res.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a body over 60 MB → 413', async () => {
    t = await makeApp();
    const fd = await orderForm(t);
    fd.set('paddles[0][front]', new File([new Uint8Array(61 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' }));
    const res = await post(t, fd);
    expect(res.status).toBe(413);
    expect(await count(t.db, 'orders')).toBe(0);
  });

  it('a Content-Length over 60 MB is refused without reading the body', async () => {
    t = await makeApp();
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 10) controller.close();
      },
    });
    const res = await t.app.request('/api/orders', {
      method: 'POST',
      body,
      // @ts-expect-error Node's fetch needs duplex for a streamed body
      duplex: 'half',
      headers: { 'Content-Type': 'multipart/form-data; boundary=xyz', 'Content-Length': String(61 * 1024 * 1024), Origin: SITE },
    });
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
  });
});
