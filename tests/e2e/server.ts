/**
 * The admin, on a real listener, for the Playwright walk-through (SCRUM-72): staging settings,
 * an in-process Postgres (PGlite) holding one test order, and the admin on 127.0.0.1 only.
 * Playwright adds the Tailscale identity headers itself, as Tailscale Serve would; the
 * connection comes from loopback, which the admin trusts by default.
 *
 *   pnpm exec tsx tests/e2e/server.ts    (playwright.config.ts starts it)
 */
import { serve } from '@hono/node-server';
import { createAdminApp } from '../../src/admin/app.js';
import { serviceSecret, TrustedProxies } from '../../src/orders/abuse.js';
import { createLead } from '../../src/clubs/leads.js';
import { makeApp, orderForm, post } from '../helpers/app.js';
import { fakeStripe } from '../helpers/fake-stripe.js';
import { applySession, startPayment } from '../../src/payments/payments.js';

export const E2E_ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 4411);
export const E2E_LOGIN = 'e2e-admin@test.picklemypaddle.com';

// SCRUM-82: Stripe is faked; the hook below pays an order the way a customer would.
const stripe = fakeStripe();
const t = await makeApp({ stripe, env: { APP_ENV: 'staging', ORDER_MIN_FILL_SECONDS: '0' } });
// The admin runs on real time; so must the payments, or Paid would sort before the moves made in the browser.
t.payments!.now = () => new Date();
// Enough orders for every test in both browser projects (desktop, phone): each test takes the
// first order still Submitted. A rejection the server refused leaves its order Submitted.
const references: string[] = [];
for (const email of ['e2e-1@test.picklemypaddle.com', 'e2e-2@test.picklemypaddle.com', 'e2e-3@test.picklemypaddle.com', 'e2e-4@test.picklemypaddle.com']) {
  const placed = await post(t, await orderForm(t, { paddles: 2, email }));
  if (placed.status !== 201) throw new Error(`could not place the e2e order: ${placed.status} ${await placed.text()}`);
  references.push(((await placed.json()) as { reference: string }).reference);
}
const reference = references.join(', ');
// SCRUM-93: one lead per browser project (desktop, phone) for the pipeline walk-through.
for (const project of ['desktop', 'phone']) {
  await createLead(
    t.db,
    { clubName: `E2E Lead ${project}`, suburb: 'Newtown', contactName: 'Jo Treasurer', contactEmail: 'jo@test.picklemypaddle.com', contactPhone: '0412 345 678', memberCount: 40, message: 'Keen to talk about re-gripping.', preferredTimes: 'Weekday evenings' },
    { isProduction: false, now: new Date() },
  );
}

const admin = createAdminApp({
  db: t.db,
  photos: t.photos,
  isProduction: false,
  logins: [E2E_LOGIN],
  trusted: new TrustedProxies(['127.0.0.1', '::1']),
  csrfKey: await serviceSecret(t.db, 'admin-csrf-key'),
  paymentsConfigured: true,
  emailAllowList: ['jo@test.picklemypaddle.com'],
});
const server = serve({ fetch: admin.fetch, port: E2E_ADMIN_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`e2e admin on http://127.0.0.1:${info.port}/admin (order ${reference})`);
});

// The customer pays (Pay now → Stripe Checkout → back), standing in for a real card: POST /pay/<reference>.
export const E2E_HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 4412);
const hook = serve({
  port: E2E_HOOK_PORT,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const m = /^\/pay\/(PMP-[A-Z0-9]{5})$/.exec(new URL(req.url).pathname);
    if (req.method !== 'POST' || !m) return new Response('not found', { status: 404 });
    const { rows } = await t.db.query<{ id: string }>('SELECT id FROM orders WHERE reference = $1', [m[1]]);
    if (!rows[0]) return new Response('no such order', { status: 404 });
    try {
      const { url } = await startPayment(t.payments!, rows[0].id, 'http://127.0.0.1');
      const session = [...stripe.sessions.values()].find((s) => s.url === url)!;
      stripe.pay(session.id);
      const outcome = await applySession(t.payments!, await t.payments!.stripe.getCheckoutSession(session.id), 'return');
      return new Response(outcome, { status: outcome === 'paid' ? 200 : 409 });
    } catch (err) {
      return new Response((err as Error).message, { status: 409 });
    }
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { hook.close(); server.close(() => void t.close().finally(() => process.exit(0))); });
}
