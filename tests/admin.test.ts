/**
 * The order admin: who may use it (SCRUM-71) and what it does (SCRUM-72).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseAmount } from '../src/admin/app.js';
import { replyOverdue } from '../src/admin/data.js';
import { csrfToken } from '../src/admin/guard.js';
import { loadConfig } from '../src/config.js';
import { ADMIN_HOST, ATTILA, makeAdmin, type TestAdmin } from './helpers/admin.js';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function placeOrder(t: TestApp, opts: Parameters<typeof orderForm>[1] = {}): Promise<{ reference: string; statusToken: string }> {
  const res = await post(t, await orderForm(t, opts));
  expect(res.status).toBe(201);
  return (await res.json()) as { reference: string; statusToken: string };
}

const statusOf = async (t: TestApp, reference: string) =>
  (await t.db.query<{ status: string }>('SELECT status FROM orders WHERE reference = $1', [reference])).rows[0]?.status;

const emailsFor = async (t: TestApp, reference: string, template: string) =>
  Number(
    (
      await t.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM outbox ob JOIN orders o ON o.id = ob.order_id WHERE o.reference = $1 AND ob.kind = 'email' AND ob.template = $2`,
        [reference, template],
      )
    ).rows[0]!.n,
  );

/** Moves an order through the admin's own form, expecting the redirect back to the order. */
async function move(a: TestAdmin, reference: string, to: string, fields: Record<string, string> = {}) {
  const res = await a.post(`/admin/orders/${reference}/status`, { to, ...fields });
  expect(res.status, `move to ${to}: ${res.status === 303 ? '' : await res.clone().text()}`).toBe(303);
  expect(res.headers.get('location')).toBe(`/admin/orders/${reference}?done=moved`);
}

// ── SCRUM-71: access ──────────────────────────────────────────────────────────

describe('admin access (SCRUM-71)', () => {
  it('refuses a request without Tailscale identity headers (403)', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const res = await a.get('/admin/orders', { Host: ADMIN_HOST });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no Tailscale identity/);
  });

  it('refuses a login that is not in ADMIN_LOGINS (403)', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    expect((await a.get('/admin/orders', a.identity('someone@example.com'))).status).toBe(403);
  });

  it("lets Attila's login in on the trusted (loopback) listener (200)", async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const res = await a.get('/admin/orders');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Signed in through Tailscale as Attila Madarasz');
    // Logins compare case-insensitively (Tailscale lower-cases them anyway).
    expect((await a.get('/admin/orders', a.identity(ATTILA.toUpperCase()))).status).toBe(200);
  });

  it('ignores the identity headers when the connection is not from the trusted proxy (403)', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    a.peer.address = '172.18.0.5'; // e.g. another container on the stack's network
    const res = await a.get('/admin/orders');
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/only through Tailscale/);
  });

  it('is not on the public listener at all: the same headers there get a 404', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    for (const path of ['/admin', '/admin/orders', '/admin/admin.css', '/api/admin/orders']) {
      const res = await t.app.request(path, { headers: a.identity() });
      expect(res.status, path).toBe(404);
    }
  });

  it('answers 503 until ADMIN_LOGINS is set, and never lets anyone in', async () => {
    t = await makeApp();
    const a = await makeAdmin(t, { logins: undefined });
    expect((await a.get('/admin/orders')).status).toBe(503);
    const b = await makeAdmin(t, { logins: [] });
    expect((await b.get('/admin/orders')).status).toBe(503);
  });

  it('sends no-store, DENY and a script-free CSP on pages and refusals alike', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    for (const res of [await a.get('/admin/orders'), await a.get('/admin/orders', { Host: ADMIN_HOST })]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('script-src');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  it('refuses a state change without the CSRF token, or from another origin', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const path = `/admin/orders/${reference}/notes`;
    // No token, or a token for someone else's login.
    expect((await a.post(path, { note: 'x', _csrf: '' })).status).toBe(403);
    expect((await a.post(path, { note: 'x', _csrf: csrfToken(Buffer.alloc(32), ATTILA) })).status).toBe(403);
    // Right token, but sent from another site.
    expect((await a.post(path, { note: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    // Older browsers without Sec-Fetch-Site: Origin must match the Host.
    const noFetchMeta = { 'Sec-Fetch-Site': '' };
    expect((await a.post(path, { note: 'x' }, { ...noFetchMeta, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await a.post(path, { note: 'x' }, noFetchMeta)).status).toBe(403); // no Origin at all
    expect((await a.post(path, { note: 'ok' }, { ...noFetchMeta, Origin: `https://${ADMIN_HOST}` })).status).toBe(303);
    // Nothing but the last one was saved.
    const { rows } = await t.db.query<{ note: string }>('SELECT note FROM order_notes');
    expect(rows.map((r) => r.note)).toEqual(['ok']);
  });

  it('gives each login its own CSRF token', async () => {
    t = await makeApp();
    const a = await makeAdmin(t, { logins: [ATTILA, 'other@github'] });
    expect(a.csrf(ATTILA)).not.toBe(a.csrf('other@github'));
  });
});

describe('admin settings (SCRUM-71)', () => {
  const base = { APP_ENV: 'staging', PUBLIC_SITE_ORIGIN: SITE, DATABASE_URL: 'postgres://u:p@h:5432/d', EMAIL_ALLOWLIST: 'a@b.co' };

  it('defaults to port 8081, trusting only this machine, with no logins', () => {
    const c = loadConfig(base);
    expect(c.ADMIN_PORT).toBe(8081);
    expect(c.ADMIN_TRUSTED_PROXIES).toEqual(['127.0.0.1', '::1']);
    expect(c.ADMIN_LOGINS).toBeUndefined();
  });

  it('accepts Tailscale logins without a dot (GitHub tailnets) and lower-cases them', () => {
    expect(loadConfig({ ...base, ADMIN_LOGINS: 'Someone@GitHub, a@b.co' }).ADMIN_LOGINS).toEqual(['someone@github', 'a@b.co']);
    expect(() => loadConfig({ ...base, ADMIN_LOGINS: 'not a login' })).toThrow(/ADMIN_LOGINS must be Tailscale logins/);
  });

  it('refuses an admin port that is the public port', () => {
    expect(() => loadConfig({ ...base, PORT: '8081' })).toThrow(/ADMIN_PORT must differ from PORT/);
  });
});

// ── SCRUM-72: the order admin ─────────────────────────────────────────────────

describe('order list (SCRUM-72 AC1)', () => {
  it('shows what is waiting on Attila by default, with paddles, days in status and TEST marks', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const one = await placeOrder(t, { paddles: 2, email: 'one@test.picklemypaddle.com' });
    const two = await placeOrder(t, { email: 'two@test.picklemypaddle.com' });
    await move(a, two.reference, 'accepted'); // waiting on the customer, not on Attila
    t.clock.now = new Date(t.clock.now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const page = await (await a.get('/admin/orders')).text();
    expect(page).toContain(one.reference);
    expect(page).not.toContain(two.reference);
    expect(page).toContain('2 paddles');
    expect(page).toContain('3 days in Submitted');
    expect(page).toContain('<span class="badge test">TEST</span>');

    const all = await (await a.get('/admin/orders?status=all')).text();
    expect(all).toContain(two.reference);
    const accepted = await (await a.get('/admin/orders?status=accepted')).text();
    expect(accepted).toContain(two.reference);
    expect(accepted).not.toContain(one.reference);
    expect((await a.get('/admin/orders?status=nonsense')).status).toBe(404);
  });

  it('flags orders past the 1-business-day reply promise', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    // Placed Monday 26 Oct (Sydney); due by the end of Tuesday.
    const { reference } = await placeOrder(t);
    t.clock.now = new Date('2026-10-27T05:00:00Z'); // Tuesday afternoon in Sydney
    expect(await (await a.get('/admin/orders')).text()).not.toContain('Reply overdue');
    t.clock.now = new Date('2026-10-27T14:00:00Z'); // Wednesday 1 am in Sydney
    const page = await (await a.get('/admin/orders')).text();
    expect(page).toContain('Reply overdue');
    expect(page).toContain('1 order past the 1-business-day reply promise');
    // Answering it (any move out of Submitted) clears the flag.
    await move(a, reference, 'questions');
    expect(await (await a.get('/admin/orders')).text()).not.toContain('Reply overdue');
  });

  it('counts the reply promise in business days (a Friday order is due on Monday)', () => {
    const fri = new Date('2026-10-30T01:00:00Z'); // Friday in Sydney
    expect(replyOverdue('submitted', fri, new Date('2026-11-01T23:00:00Z'))).toBe(false); // Monday morning
    expect(replyOverdue('submitted', fri, new Date('2026-11-02T14:00:00Z'))).toBe(true); // Tuesday 1 am
    expect(replyOverdue('questions', fri, new Date('2026-11-10T00:00:00Z'))).toBe(false);
  });

  it('never lists smoke-test orders', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t, { email: 'smoke+run1@example.com' });
    expect(await (await a.get('/admin/orders?status=all')).text()).not.toContain(reference);
    expect((await a.get(`/admin/orders/${reference}`)).status).toBe(404);
  });
});

describe('order detail (SCRUM-72 AC2)', () => {
  it('shows the customer, the return address, the photos, the history and the outbox', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const res = await a.get(`/admin/orders/${reference}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    for (const text of ['Test Player', 'player@test.picklemypaddle.com', '0412 345 678', '1 Court St', 'Sydney NSW 2000', 'Selkirk Vanguard Power Air', 'customer_submitted', 'alert_submitted']) {
      expect(page, text).toContain(text);
    }
    const photoIds = [...page.matchAll(/<img src="\/admin\/photos\/([0-9a-f-]{36})"/g)].map((m) => m[1]);
    expect(photoIds).toHaveLength(2);
  });

  it('serves photos only through the authorised route, never cached', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const page = await (await a.get(`/admin/orders/${reference}`)).text();
    const id = /\/admin\/photos\/([0-9a-f-]{36})/.exec(page)![1]!;

    const res = await a.get(`/admin/photos/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);

    expect((await a.get(`/admin/photos/${id}`, { Host: ADMIN_HOST })).status).toBe(403); // no identity
    expect((await a.get(`/admin/photos/${id}`, a.identity('someone@example.com'))).status).toBe(403);
    expect((await t.app.request(`/admin/photos/${id}`, { headers: a.identity() })).status).toBe(404); // public listener
    expect((await a.get('/admin/photos/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await a.get('/admin/photos/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });

  it('escapes everything the customer typed', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t, { overrides: { name: 'Eve <script>alert(1)</script>', street: '1 "Quoted" & <b>St</b>' } });
    const page = await (await a.get(`/admin/orders/${reference}`)).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('Eve &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('1 &quot;Quoted&quot; &amp; &lt;b&gt;St&lt;/b&gt;');
  });

  it('answers 404 for an unknown or malformed reference', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    expect((await a.get('/admin/orders/PMP-ZZZZZ')).status).toBe(404);
    expect((await a.get('/admin/orders/not-a-ref')).status).toBe(404);
  });
});

describe('moving orders (SCRUM-72 AC3, AC4, AC6, AC7)', () => {
  it('walks an order from Submitted to Completed, emailing at the key moments only', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);

    await move(a, reference, 'questions', { note: 'Asked about the edge guard' });
    await move(a, reference, 'accepted', { amount: '55.50' });
    expect((await a.post(`/admin/orders/${reference}/mark-paid-test`)).status).toBe(303);
    await move(a, reference, 'in_queue', { arrivedOn: '2026-10-26' });
    await move(a, reference, 'regritted');
    await move(a, reference, 'posted_back', { trackingNumber: 'AP 1234-5678' });
    await move(a, reference, 'completed');
    expect(await statusOf(t, reference)).toBe('completed');

    for (const [template, n] of [['accepted', 1], ['in_queue', 1], ['posted_back', 1], ['rejected', 0]] as const) {
      expect(await emailsFor(t, reference, template), template).toBe(n);
    }
    const { rows: payload } = await t.db.query<{ payload: { amountCents?: number } }>(
      `SELECT ob.payload FROM outbox ob JOIN orders o ON o.id = ob.order_id WHERE o.reference = $1 AND ob.template = 'accepted'`,
      [reference],
    );
    expect(payload[0]!.payload.amountCents).toBe(5550);

    const { rows: history } = await t.db.query<{ status: string; actor: string; note: string | null }>(
      'SELECT h.status, h.actor, h.note FROM status_history h JOIN orders o ON o.id = h.order_id WHERE o.reference = $1 ORDER BY h.at, h.id',
      [reference],
    );
    expect(history.map((h) => `${h.status}/${h.actor}`)).toEqual([
      'submitted/customer', 'questions/admin', 'accepted/admin', 'paid/admin', 'in_queue/admin', 'regritted/admin', 'posted_back/admin', 'completed/admin',
    ]);
    expect(history[1]!.note).toBe('Asked about the edge guard');
    expect(history[3]!.note).toMatch(/test shortcut/);

    const page = await (await a.get(`/admin/orders/${reference}`)).text();
    expect(page).toContain('This order is closed.');
    expect(page).toContain('AP 1234-5678');
  });

  it('writes exactly one email per emailing transition, with the right template', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    await move(a, reference, 'rejected', { reason: 'The face is delaminating; a re-grit would not last.' });
    expect(await emailsFor(t, reference, 'rejected')).toBe(1);
    const { rows } = await t.db.query<{ payload: { reason?: string } }>(
      `SELECT ob.payload FROM outbox ob JOIN orders o ON o.id = ob.order_id WHERE o.reference = $1 AND ob.template = 'rejected'`,
      [reference],
    );
    expect(rows[0]!.payload.reason).toBe('The face is delaminating; a re-grit would not last.');
    // Questions sends nothing.
    const other = await placeOrder(t, { email: 'q@test.picklemypaddle.com' });
    const before = Number((await t.db.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE kind = 'email'`)).rows[0]!.n);
    await move(a, other.reference, 'questions');
    expect(Number((await t.db.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE kind = 'email'`)).rows[0]!.n)).toBe(before);
  });

  it('refuses Rejected without a reason and Posted back without tracking (400)', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const res = await a.post(`/admin/orders/${reference}/status`, { to: 'rejected', reason: '  ' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Give the customer a reason');
    expect(await statusOf(t, reference)).toBe('submitted');

    await move(a, reference, 'accepted');
    await a.post(`/admin/orders/${reference}/mark-paid-test`);
    await move(a, reference, 'in_queue');
    await move(a, reference, 'regritted');
    const noTracking = await a.post(`/admin/orders/${reference}/status`, { to: 'posted_back' });
    expect(noTracking.status).toBe(400);
    expect(await noTracking.text()).toContain('Enter the tracking number');
    expect(await statusOf(t, reference)).toBe('regritted');
  });

  it('refuses any move outside the table (409), and Paid through the general form (400)', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const res = await a.post(`/admin/orders/${reference}/status`, { to: 'completed' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('can’t be moved to completed');
    expect((await a.post(`/admin/orders/${reference}/status`, { to: 'paid' })).status).toBe(400);
    expect((await a.post(`/admin/orders/${reference}/status`, { to: 'nonsense' })).status).toBe(400);
    expect((await a.post(`/admin/orders/${reference}/status`, { to: 'accepted', amount: 'lots' })).status).toBe(400);
    // Mark paid (test) from Submitted is not a move in the table either.
    expect((await a.post(`/admin/orders/${reference}/mark-paid-test`)).status).toBe(409);
    expect(await statusOf(t, reference)).toBe('submitted');
  });

  it('offers only the allowed moves on the page', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const page = await (await a.get(`/admin/orders/${reference}`)).text();
    const offered = [...page.matchAll(/name="to" value="([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(offered).toEqual(['accepted', 'questions', 'rejected', 'withdrawn']);
    expect(page).not.toContain('Mark paid (test)');
  });

  it('has "Mark paid (test)" outside production only: in production there is no button and no route', async () => {
    t = await makeApp();
    const staging = await makeAdmin(t);
    const prod = await makeAdmin(t, { isProduction: true });
    const { reference } = await placeOrder(t);
    await move(staging, reference, 'accepted');

    expect(await (await staging.get(`/admin/orders/${reference}`)).text()).toContain('Mark paid (test)');
    const prodPage = await (await prod.get(`/admin/orders/${reference}`)).text();
    expect(prodPage).not.toContain('Mark paid (test)');
    expect(prodPage).toContain('Paid is set by Stripe');
    expect((await prod.post(`/admin/orders/${reference}/mark-paid-test`)).status).toBe(404);
    expect(await statusOf(t, reference)).toBe('accepted');
    expect(await (await prod.get('/admin/orders')).text()).not.toContain('(TEST)');
  });

  it('keeps internal notes away from the customer', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference, statusToken } = await placeOrder(t);
    const res = await a.post(`/admin/orders/${reference}/notes`, { note: 'Customer sounds keen; offer the club rate' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/orders/${reference}?done=note`);
    const page = await (await a.get(`/admin/orders/${reference}?done=note`)).text();
    expect(page).toContain('Customer sounds keen; offer the club rate');
    expect(page).toContain('Note saved.');
    const { rows } = await t.db.query<{ author: string }>('SELECT author FROM order_notes');
    expect(rows[0]!.author).toBe(ATTILA);

    const status = await t.app.request('/api/orders/status', {
      method: 'POST',
      body: JSON.stringify({ token: statusToken }),
      headers: { 'Content-Type': 'application/json', Origin: SITE },
    });
    expect(status.status).toBe(200);
    expect(await status.text()).not.toContain('club rate');
    expect((await a.post(`/admin/orders/${reference}/notes`, { note: ' ' })).status).toBe(400);
  });
});

describe('outbox retry (SCRUM-72 AC2)', () => {
  it('puts a failed email back in the queue, and only a failed one', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const { rows } = await t.db.query<{ id: string }>(
      `UPDATE outbox SET state = 'failed', last_error = 'http_500', attempts = 8
        WHERE template = 'customer_submitted' RETURNING id`,
    );
    const id = String(rows[0]!.id);
    const page = await (await a.get(`/admin/orders/${reference}`)).text();
    expect(page).toContain(`action="/admin/outbox/${id}/retry"`);
    expect(page).toContain('http_500');

    const res = await a.post(`/admin/outbox/${id}/retry`);
    expect(res.status).toBe(303);
    const { rows: after } = await t.db.query<{ state: string; attempts: number }>('SELECT state, attempts FROM outbox WHERE id = $1', [id]);
    expect(after[0]).toMatchObject({ state: 'pending', attempts: 0 });
    // Already pending: nothing to retry.
    expect((await a.post(`/admin/outbox/${id}/retry`)).status).toBe(409);
    expect((await a.post('/admin/outbox/999999/retry')).status).toBe(404);
  });

  it('retries a failed HubSpot sync too', async () => {
    t = await makeApp();
    const a = await makeAdmin(t);
    const { reference } = await placeOrder(t);
    const { rows } = await t.db.query<{ id: string }>(`UPDATE outbox SET state = 'failed', last_error = 'http_502' WHERE kind = 'crm' RETURNING id`);
    expect(rows).toHaveLength(1);
    expect((await a.post(`/admin/outbox/${rows[0]!.id}/retry`)).status).toBe(303);
    expect(await (await a.get(`/admin/orders/${reference}`)).text()).toContain('HubSpot sync');
  });
});

describe('amounts', () => {
  it('reads dollars as cents', () => {
    expect(parseAmount('60')).toBe(6000);
    expect(parseAmount('60.5')).toBe(6050);
    expect(parseAmount('60.05')).toBe(6005);
    expect(parseAmount('0')).toBe(0);
    for (const bad of ['', '-1', '1e3', '60.555', '123456', 'sixty']) expect(parseAmount(bad), bad).toBeUndefined();
  });
});
