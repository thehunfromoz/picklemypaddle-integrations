/**
 * Order emails (SCRUM-69): templates, the Resend adapter, the allow-list and the outbox.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BACKOFF_MINUTES, isAllowed, linksMailer, MAX_ATTEMPTS, processOutbox, retryEmail, type MailSettings, type OutboxDeps } from '../src/email/outbox.js';
import { ALERT_TO, FROM, REPLY_TO, resendSender, SendError, type EmailMessage, type EmailSender } from '../src/email/sender.js';
import { placeholdersIn, render, sampleContext, TEMPLATES } from '../src/email/templates.js';
import { lookupStatus, requestLinks } from '../src/orders/status.js';
import { DB_BACKEND } from './helpers/db.js';
import { count, makeApp, orderForm, post, type TestApp } from './helpers/app.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface FakeSender extends EmailSender {
  sent: EmailMessage[];
  /** Errors to throw on the next sends, in order. */
  failures: Error[];
}

function fakeSender(): FakeSender {
  const s: FakeSender = {
    name: 'fake',
    sent: [],
    failures: [],
    async send(m) {
      const err = s.failures.shift();
      if (err) throw err;
      s.sent.push(m);
      return { id: `fake-${s.sent.length}` };
    },
  };
  return s;
}

const ORDER_EMAIL = 'player@test.picklemypaddle.com';
const SITE = 'http://localhost:4321';

function settings(over: Partial<MailSettings> = {}): MailSettings {
  return { isProduction: false, allowList: [ORDER_EMAIL, ALERT_TO], siteUrl: SITE, adminUrl: 'https://home-server.tail8bc7ae.ts.net:8445', ...over };
}

function outbox(t: TestApp, sender: EmailSender | null, over: Partial<MailSettings> = {}): OutboxDeps {
  return { db: t.db, sender, settings: settings(over), now: () => t.clock.now };
}

const rowsOf = (t: TestApp) =>
  t.db.query<{ id: string; template: string; recipient: string | null; state: string; attempts: number; last_error: string | null; next_attempt_at: Date }>(
    'SELECT id, template, recipient, state, attempts, last_error, next_attempt_at FROM outbox ORDER BY id',
  ).then((r) => r.rows);

const tokenFrom = (text: string) => /\/order\/status#([A-Za-z0-9_-]{43})/.exec(text)?.[1];

// ── Templates ─────────────────────────────────────────────────────────────────

describe('email templates', () => {
  for (const name of TEMPLATES) {
    for (const test of [true, false]) {
      it(`${name} (${test ? 'staging' : 'production'}) renders the same text and HTML as approved`, () => {
        const e = render(name, sampleContext(name, test));
        expect(e.subject.startsWith('[TEST] ')).toBe(test);
        expect(e.text.includes('TEST ORDER')).toBe(test);
        expect(e).toMatchSnapshot();
      });
    }
  }

  it('never loads anything remote: no images, scripts, styles or tracking', () => {
    for (const name of TEMPLATES) {
      const { html } = render(name, sampleContext(name, false));
      expect(html).not.toMatch(/<img|<script|<link|<iframe|url\(|src=/i);
    }
  });

  it('keeps customer details out of Attila’s alert', () => {
    const ctx = { ...sampleContext('alert_submitted', true), firstName: 'Zebedee', paddles: [{ brand: 'Uniquebrand', model: 'Uniquemodel' }] };
    const e = render('alert_submitted', ctx);
    for (const part of [e.subject, e.text, e.html]) {
      expect(part).not.toMatch(/Zebedee|Uniquebrand|Uniquemodel|@|order\/status/);
    }
    expect(e.subject).toBe('[TEST] New order PMP-7K3QX (1 paddle)');
  });

  it('escapes everything that comes from the order or from Attila', () => {
    const e = render('rejected', { ...sampleContext('rejected', false), firstName: '<b>Sam</b>', reason: 'Cracked <script>alert(1)</script> & "worn"' });
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.html).toContain('&lt;b&gt;Sam&lt;/b&gt;');
    expect(e.text).toContain('Cracked <script>alert(1)</script> & "worn"');
  });

  it('lists the wording still to confirm (production won’t start until there is none)', () => {
    // A new [To confirm: …] has to be added here on purpose, so none slips through unnoticed.
    expect(placeholdersIn()).toEqual([
      { template: 'accepted', placeholder: '[To confirm: payment link and how return postage is shown, added by SCRUM-9]' },
      { template: 'accepted', placeholder: '[To confirm: postal address and packing tips]' },
    ]);
  });
});

// ── Allow-list ────────────────────────────────────────────────────────────────

describe('allow-list', () => {
  const s = { isProduction: false, allowList: ['attila@example.org', 'sales@picklemypaddle.com'] };
  it('lets through listed addresses, whatever the case or plus-tag', () => {
    expect(isAllowed('Attila@Example.org', s)).toBe(true);
    expect(isAllowed('attila+order7@example.org', s)).toBe(true);
    expect(isAllowed('sales@picklemypaddle.com', s)).toBe(true);
  });
  it('stops everyone else outside production', () => {
    expect(isAllowed('customer@gmail.com', s)).toBe(false);
    expect(isAllowed('attila@example.org.evil.com', s)).toBe(false);
    expect(isAllowed('xattila@example.org', s)).toBe(false);
  });
  it('is ignored in production', () => {
    expect(isAllowed('customer@gmail.com', { ...s, isProduction: true })).toBe(true);
  });
});

// ── Resend adapter ────────────────────────────────────────────────────────────

describe('Resend adapter', () => {
  const msg: EmailMessage = { to: 'a@example.org', subject: 'S', text: 'T', html: '<p>H</p>', idempotencyKey: 'pmp-outbox-1' };

  it('sends from sales@ with replies to info@, the key only in the Authorization header', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resendSender('re_secret', fetchImpl).send(msg)).toEqual({ id: 'abc' });
    expect(seen!.url).toBe('https://api.resend.com/emails');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_secret');
    expect(headers['Idempotency-Key']).toBe('pmp-outbox-1');
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toEqual({ from: FROM, to: ['a@example.org'], reply_to: REPLY_TO, subject: 'S', text: 'T', html: '<p>H</p>' });
    expect(FROM).toBe('PickleMyPaddle <sales@picklemypaddle.com>');
    expect(String(seen!.init.body)).not.toContain('re_secret');
  });

  it('retries rate limits, server errors and network failures, but not rejected requests', async () => {
    const answer = (status: number) => (async () => new Response('{"message":"quoted input a@example.org"}', { status })) as unknown as typeof fetch;
    for (const [status, permanent] of [[429, false], [500, false], [503, false], [401, true], [403, true], [422, true]] as const) {
      const err = await resendSender('re_k', answer(status)).send(msg).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SendError);
      expect((err as SendError).permanent).toBe(permanent);
      expect((err as SendError).message).not.toContain('a@example.org');
    }
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const err = (await resendSender('re_k', down).send(msg).catch((e: unknown) => e)) as SendError;
    expect([err.code, err.permanent]).toEqual(['network:TypeError', false]);
  });
});

// ── Outbox ────────────────────────────────────────────────────────────────────

describe(`order emails through the outbox (${DB_BACKEND})`, () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  it('an order queues two emails: the customer’s confirmation and Attila’s alert', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    expect((await post(t, await orderForm(t, { paddles: 2 }))).status).toBe(201);
    const rows = await rowsOf(t);
    expect(rows.map((r) => [r.template, r.recipient, r.state])).toEqual([
      ['customer_submitted', ORDER_EMAIL, 'pending'],
      ['alert_submitted', ALERT_TO, 'pending'],
    ]);
  });

  it('smoke-test orders queue nothing', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t, { email: 'smoke+run1@example.com' }));
    expect(await count(t.db, 'outbox')).toBe(0);
  });

  it('sends both, the customer’s with a working status link, and no token is ever stored in plain', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t));
    const sender = fakeSender();
    expect(await processOutbox(outbox(t, sender))).toEqual({ sent: 2, retrying: 0, failed: 0, suppressed: 0 });

    const [customer, alert] = sender.sent;
    expect(customer!.to).toBe(ORDER_EMAIL);
    expect(customer!.subject).toMatch(/^\[TEST\] We’ve got your order PMP-[A-Z0-9]{5}$/);
    expect(customer!.text).toContain('Selkirk Vanguard Power Air');
    expect(customer!.text).toContain('1 business day');
    const token = tokenFrom(customer!.text);
    expect(token).toBeDefined();
    expect((await lookupStatus(t.db, token, t.clock.now))?.status).toBe('submitted');
    const stored = JSON.stringify((await t.db.query('SELECT * FROM outbox')).rows);
    expect(stored).not.toContain(token);

    expect(alert!.to).toBe(ALERT_TO);
    expect(alert!.subject).toMatch(/^\[TEST\] New order PMP-[A-Z0-9]{5} \(1 paddle\)$/);
    expect(alert!.text).toMatch(/https:\/\/home-server\.tail8bc7ae\.ts\.net:8445\/admin\/orders\/PMP-/);
    expect(alert!.text).not.toContain('Test Player');
    expect(alert!.idempotencyKey).toMatch(/^pmp-outbox-\d+$/);

    expect((await rowsOf(t)).map((r) => r.state)).toEqual(['sent', 'sent']);
    // Nothing left to do.
    expect(await processOutbox(outbox(t, sender))).toEqual({ sent: 0, retrying: 0, failed: 0, suppressed: 0 });
  });

  it('outside production, a recipient not on the allow-list is suppressed and never sent', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t, { email: 'stranger@gmail.com' }));
    const sender = fakeSender();
    expect(await processOutbox(outbox(t, sender))).toMatchObject({ sent: 1, suppressed: 1 });
    expect(sender.sent.map((m) => m.to)).toEqual([ALERT_TO]);
    expect((await rowsOf(t))[0]).toMatchObject({ template: 'customer_submitted', state: 'suppressed', last_error: 'not_allow_listed' });
  });

  it('in production the allow-list is ignored and subjects have no [TEST]', async () => {
    t = await makeApp({ env: { APP_ENV: 'production', RESEND_API_KEY: 're_testkey' } });
    await post(t, await orderForm(t, { email: 'stranger@gmail.com' }));
    const sender = fakeSender();
    await processOutbox(outbox(t, sender, { isProduction: true, allowList: [] }));
    expect(sender.sent.map((m) => m.to)).toEqual(['stranger@gmail.com', ALERT_TO]);
    expect(sender.sent.every((m) => !m.subject.includes('[TEST]'))).toBe(true);
  });

  it('a failed send is retried with backoff, never fails the order, and drops the token it minted', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const sender = fakeSender();
    sender.failures.push(new SendError('http:503', false));
    expect((await post(t, await orderForm(t))).status).toBe(201);
    const tokensBefore = await count(t.db, 'status_tokens');

    expect(await processOutbox(outbox(t, sender))).toMatchObject({ retrying: 1, sent: 1 });
    const [first] = await rowsOf(t);
    expect(first).toMatchObject({ state: 'pending', attempts: 1, last_error: 'http:503' });
    expect(new Date(first!.next_attempt_at).getTime() - t.clock.now.getTime()).toBe(BACKOFF_MINUTES[0] * 60_000);
    // The token minted for the failed send was deleted; the alert carries none.
    expect(await count(t.db, 'status_tokens')).toBe(tokensBefore);

    // Not due yet.
    expect(await processOutbox(outbox(t, sender))).toMatchObject({ sent: 0, retrying: 0 });
    t.clock.now = new Date(t.clock.now.getTime() + 60_000);
    expect(await processOutbox(outbox(t, sender))).toMatchObject({ sent: 1 });
    expect((await rowsOf(t))[0]).toMatchObject({ state: 'sent', attempts: 2, last_error: null });
  });

  it('gives up on a permanent failure or after the last attempt, and the admin retry puts it back', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t));
    const sender = fakeSender();
    sender.failures.push(new SendError('http:422', true));
    await processOutbox(outbox(t, sender));
    const [row] = await rowsOf(t);
    expect(row).toMatchObject({ state: 'failed', last_error: 'http:422' });

    expect(await retryEmail(t.db, row!.id, t.clock.now)).toBe(true);
    expect(await retryEmail(t.db, row!.id, t.clock.now)).toBe(false); // already pending
    await processOutbox(outbox(t, sender));
    expect((await rowsOf(t))[0]!.state).toBe('sent');

    // A provider that stays down: one try plus every backoff step, then failed.
    sender.failures.push(...Array.from({ length: MAX_ATTEMPTS }, () => new SendError('http:500', false)));
    await post(t, await orderForm(t, { email: 'player+2@test.picklemypaddle.com' }));
    await t.db.query(`DELETE FROM outbox WHERE template = 'alert_submitted'`);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await processOutbox(outbox(t, sender));
      t.clock.now = new Date(t.clock.now.getTime() + 13 * 60 * 60_000);
    }
    const last = (await rowsOf(t)).at(-1)!;
    expect(last).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS, last_error: 'http:500' });
  });

  it('without a provider (development) nothing leaves, and it says so', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    await post(t, await orderForm(t));
    expect(await processOutbox(outbox(t, null))).toMatchObject({ suppressed: 2 });
    expect((await rowsOf(t)).map((r) => r.last_error)).toEqual(['no_provider', 'no_provider']);
  });
});

describe(`"email me my links" with the real mailer (${DB_BACKEND})`, () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  it('sends fresh links to an allow-listed address and retires the old ones', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const first = (await (await post(t, await orderForm(t))).json()) as { statusToken: string };
    const sender = fakeSender();
    const out = await requestLinks(t.db, ORDER_EMAIL, t.clock.now, linksMailer(outbox(t, sender)));
    expect(out).toEqual({ orders: 1, sent: true });
    expect(sender.sent[0]!.subject).toBe('[TEST] Your PickleMyPaddle order link');
    expect(await lookupStatus(t.db, tokenFrom(sender.sent[0]!.text), t.clock.now)).not.toBeNull();
    expect(await lookupStatus(t.db, first.statusToken, t.clock.now)).toBeNull();
  });

  it('suppresses an address outside the allow-list and keeps the customer’s existing link working', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const first = (await (await post(t, await orderForm(t, { email: 'stranger@gmail.com' }))).json()) as { statusToken: string };
    const sender = fakeSender();
    const tokens = await count(t.db, 'status_tokens');
    expect(await requestLinks(t.db, 'stranger@gmail.com', t.clock.now, linksMailer(outbox(t, sender)))).toEqual({ orders: 1, sent: false });
    expect(sender.sent).toEqual([]);
    expect(await count(t.db, 'status_tokens')).toBe(tokens);
    expect(await lookupStatus(t.db, first.statusToken, t.clock.now)).not.toBeNull();
    const rec = (await t.db.query<{ recipient: string | null; state: string }>(`SELECT recipient, state FROM outbox WHERE template = 'links'`)).rows;
    expect(rec).toEqual([{ recipient: null, state: 'suppressed' }]);
  });
});
