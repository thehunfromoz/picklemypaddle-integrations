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
import { makeApp, orderForm, post } from '../helpers/app.js';

export const E2E_ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 4411);
export const E2E_LOGIN = 'e2e-admin@test.picklemypaddle.com';

const t = await makeApp({ env: { APP_ENV: 'staging', ORDER_MIN_FILL_SECONDS: '0' } });
// Enough orders for every test in both browser projects (desktop, phone): each test takes the
// first order still Submitted. A rejection the server refused leaves its order Submitted.
const references: string[] = [];
for (const email of ['e2e-1@test.picklemypaddle.com', 'e2e-2@test.picklemypaddle.com', 'e2e-3@test.picklemypaddle.com', 'e2e-4@test.picklemypaddle.com']) {
  const placed = await post(t, await orderForm(t, { paddles: 2, email }));
  if (placed.status !== 201) throw new Error(`could not place the e2e order: ${placed.status} ${await placed.text()}`);
  references.push(((await placed.json()) as { reference: string }).reference);
}
const reference = references.join(', ');

const admin = createAdminApp({
  db: t.db,
  photos: t.photos,
  isProduction: false,
  logins: [E2E_LOGIN],
  trusted: new TrustedProxies(['127.0.0.1', '::1']),
  csrfKey: await serviceSecret(t.db, 'admin-csrf-key'),
});
const server = serve({ fetch: admin.fetch, port: E2E_ADMIN_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`e2e admin on http://127.0.0.1:${info.port}/admin (order ${reference})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => void t.close().finally(() => process.exit(0))));
}
