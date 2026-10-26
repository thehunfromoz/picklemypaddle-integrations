/** Logs never carry personal data (SCRUM-65 AC10, SCRUM-67 AC7). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, orderForm, post, SITE, type TestApp } from './helpers/app.js';

let t: TestApp;
let lines: string[];
beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
});

const PERSONAL = ['Unique Person Name', 'unique.person@test.picklemypaddle.com', '0499 888 777', '42 Secret Lane', 'Hiddenville', '203.0.113.7'];

describe('what the service logs', () => {
  it('contains no names, emails, phones, addresses or raw IPs across the order flow', async () => {
    t = await makeApp();
    const overrides = { name: PERSONAL[0]!, email: PERSONAL[1]!, phone: PERSONAL[2]!, street: PERSONAL[3]!, suburb: PERSONAL[4]! };
    await post(t, await orderForm(t, { overrides }));                                  // created
    await post(t, await orderForm(t, { overrides, honeypot: 'x' }));                   // bot
    await post(t, await orderForm(t, { overrides: { ...overrides, postcode: 'bad' } })); // invalid
    for (let i = 0; i < 6; i++) await post(t, await orderForm(t, { overrides }));      // rate-limited
    await t.app.request('/api/orders/links', { method: 'POST', body: JSON.stringify({ email: PERSONAL[1] }), headers: { 'Content-Type': 'application/json', Origin: SITE } });
    // A database error mid-request: its message would quote values, so it must not be logged.
    await t.db.query('ALTER TABLE paddles ADD CONSTRAINT no_brand CHECK (brand <> $$Selkirk$$) NOT VALID');
    t.peer.address = '198.51.100.200';
    await post(t, await orderForm(t, { overrides: { ...overrides, email: 'other.unique@test.picklemypaddle.com' } }));

    const all = lines.join('\n');
    expect(all).toMatch(/order_created/);
    expect(all).toMatch(/order_bot_suspected/);
    expect(all).toMatch(/rate_limited/);
    expect(all).toMatch(/request_failed/);
    for (const p of [...PERSONAL, 'other.unique', 'Selkirk', '198.51.100.200']) expect(all).not.toContain(p);
  });
});
