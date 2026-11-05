import { serve } from '@hono/node-server';
import { ConfigError, describeConfig, loadConfig, type Config } from './config.js';
import { createApp } from './app.js';
import { createPgDb } from './db/db.js';
import { migrate } from './db/migrations.js';
import { hubspotAdapter, hubspotClient, portalIdOf } from './crm/hubspot.js';
import type { CrmDeps } from './crm/sync.js';
import { linksMailer, type OutboxDeps } from './email/outbox.js';
import { resendSender } from './email/sender.js';
import { placeholdersIn } from './email/templates.js';
import { startJobs } from './jobs.js';
import { log, logError } from './log.js';
import { createAdminApp } from './admin/app.js';
import { loadAbuseKeys, serviceSecret, TrustedProxies } from './orders/abuse.js';
import { fsPhotoStore, useImageEngine } from './orders/photos.js';
import type { PaymentDeps } from './payments/payments.js';
import { stripeClient } from './payments/stripe.js';
import { DEFAULT_SELLER, type Seller } from './documents/documents.js';

function configOrExit(): Readonly<Config> {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Names the problem settings, never their values. Exit code 78 = configuration error.
      console.error(`picklemypaddle-integrations will not start.\n${err.message}`);
      process.exit(78);
    }
    throw err;
  }
}

const config = configOrExit();

// SCRUM-66: the photo engine must work before we take orders. Exit 78 like any setting problem.
let imageEngine: string;
try {
  imageEngine = (await useImageEngine(config.IMAGE_ENGINE)).name;
} catch (err) {
  console.error(`picklemypaddle-integrations will not start.\n  - ${(err as Error).message}`);
  process.exit(78);
}
log('image_engine_ready', { engine: imageEngine });
// SCRUM-69: production never sends an email that still has a [To confirm: …] in it.
if (config.APP_ENV === 'production') {
  const left = placeholdersIn();
  if (left.length > 0) {
    console.error(`picklemypaddle-integrations will not start.\n  - email templates still need wording: ${[...new Set(left.map((p) => p.template))].join(', ')}`);
    process.exit(78);
  }
}

const db = createPgDb(config.DATABASE_URL);

// The schema must be current before we accept a single request (SCRUM-64). If it can't be
// brought up to date, exit: the container never becomes healthy and staging rolls back.
let version: number;
try {
  version = await migrate(db);
} catch (err) {
  logError('migration_failed', err);
  process.exit(1);
}
log('database_ready', { migration: version });

const photos = fsPhotoStore(config.PHOTO_DIR);
const outbox: OutboxDeps = {
  db,
  sender: config.RESEND_API_KEY ? resendSender(config.RESEND_API_KEY) : null,
  settings: {
    isProduction: config.APP_ENV === 'production',
    allowList: config.EMAIL_ALLOWLIST ?? [],
    siteUrl: config.SITE_URL ?? config.PUBLIC_SITE_ORIGIN[0]!,
    adminUrl: config.ADMIN_URL?.replace(/\/$/, '') ?? null,
  },
  now: () => new Date(),
};
// SCRUM-84: who issues receipts and credit notes. Each document keeps what it was issued with.
const seller: Seller = {
  ...DEFAULT_SELLER,
  name: config.BUSINESS_NAME,
  abn: config.BUSINESS_ABN ?? null,
  gstRegisteredFrom: config.GST_REGISTERED_FROM ?? null,
  payId: config.BUSINESS_PAYID ?? null,
};
// SCRUM-82: Stripe, only when a key is set. Outside production the settings refuse a live key.
const payments: PaymentDeps | null = config.STRIPE_SECRET_KEY
  ? { db, stripe: stripeClient(config.STRIPE_SECRET_KEY, config.STRIPE_API_BASE), isProduction: config.APP_ENV === 'production', now: () => new Date(), seller }
  : null;
log('payments_ready', { stripe: payments ? (payments.stripe.livemode ? 'live' : 'test') : 'not configured' });

const app = createApp(config, {
  db,
  photos,
  keys: await loadAbuseKeys(db),
  trusted: new TrustedProxies(config.TRUSTED_PROXIES),
  mailer: linksMailer(outbox),
  emailProvider: outbox.sender?.name ?? null,
  imageEngine,
  payments,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`integrations listening on :${info.port}`, describeConfig(config));
});
// SCRUM-67: a slow upload gets at most 2 minutes.
const http = server as unknown as { requestTimeout: number; headersTimeout: number };
http.requestTimeout = 120_000;
http.headersTimeout = 30_000;

// SCRUM-74: the HubSpot mirror, only when a key is set. Outside production it may only ever
// write to the test portal: the settings check that at startup, and the worker checks the key
// really belongs to it before the first write.
const hubspot = config.HUBSPOT_ACCESS_TOKEN ? hubspotClient(config.HUBSPOT_ACCESS_TOKEN, config.HUBSPOT_API_BASE) : null;
const crm: CrmDeps = {
  db,
  adapter: hubspot ? hubspotAdapter(hubspot) : null,
  portalId: hubspot ? () => portalIdOf(hubspot) : null,
  expectedPortalId: config.HUBSPOT_PORTAL_ID ?? null,
  now: () => new Date(),
  tax: { gstRegisteredFrom: config.GST_REGISTERED_FROM ?? null },
};

// SCRUM-71/72: the order admin, on its own listener. The public gateway never routes here; in the
// stacks only the gateway's loopback-only admin listener (Tailscale Serve's target) reaches it.
const admin = createAdminApp({
  db,
  photos,
  isProduction: config.APP_ENV === 'production',
  emailAllowList: config.EMAIL_ALLOWLIST ?? [],
  logins: config.ADMIN_LOGINS,
  trusted: new TrustedProxies(config.ADMIN_TRUSTED_PROXIES),
  csrfKey: await serviceSecret(db, 'admin-csrf-key'),
  // SCRUM-75: erasure deletes the customer's HubSpot contact too.
  crm: crm.adapter ? crm : null,
  // SCRUM-81: from this Sydney day, newly accepted orders include GST.
  tax: { gstRegisteredFrom: config.GST_REGISTERED_FROM ?? null },
  // SCRUM-82: shows "Payments not configured" without a key.
  paymentsConfigured: !!payments,
  seller,
  // SCRUM-85: days a club has to pay.
  clubPaymentTermsDays: config.CLUB_PAYMENT_TERMS_DAYS,
});
const adminServer = serve({ fetch: admin.fetch, port: config.ADMIN_PORT }, (info) => {
  log('admin_listening', { port: info.port, logins: config.ADMIN_LOGINS?.length ?? 0 });
});
const adminHttp = adminServer as unknown as { requestTimeout: number; headersTimeout: number };
adminHttp.requestTimeout = 30_000;
adminHttp.headersTimeout = 15_000;

const stopJobs = startJobs(db, photos, outbox, crm, () => new Date(), config.APP_ENV === 'production', payments);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopJobs();
    adminServer.close();
    server.close(() => void db.close().finally(() => process.exit(0)));
  });
}
