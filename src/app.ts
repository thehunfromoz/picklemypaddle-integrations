import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { currentVersion, LATEST_VERSION } from './db/migrations.js';
import { logError } from './log.js';
import type { AbuseKeys, TrustedProxies } from './orders/abuse.js';
import type { PhotoStore } from './orders/photos.js';
import { sydneyDate } from './orders/dates.js';
import { orderRoutes } from './orders/routes.js';
import { postageGuide, postageTableOn } from './pricing/postage.js';
import { priceNote, termsOn } from './pricing/terms.js';
import type { LinksMailer } from './orders/status.js';

export interface AppDeps {
  db: Db;
  photos: PhotoStore;
  keys: AbuseKeys;
  trusted: TrustedProxies;
  mailer?: LinksMailer | null;
  now?: () => Date;
  peer?: (c: Context) => string;
  /** Which email provider sends (SCRUM-69), for /api/status; null = none (nothing leaves). */
  emailProvider?: string | null;
  /** Which photo engine runs (SCRUM-66), for /api/status. */
  imageEngine?: string;
}

/** The HTTP app. CRM and payment routes are added by their own stories. */
export function createApp(config: Config, deps: AppDeps) {
  const app = new Hono();

  app.use('*', secureHeaders());
  app.use(
    '/api/*',
    cors({ origin: config.PUBLIC_SITE_ORIGIN, allowMethods: ['GET', 'POST'], maxAge: 600 }),
  );

  app.get('/healthz', (c) => c.text('ok'));

  // Which adapters are configured (no secret values, just on/off), and whether the order
  // database answers and its schema is current (SCRUM-64; the staging smoke test reads this).
  app.get('/api/status', async (c) => {
    let database: { reachable: boolean; migration: number | null; latest: number };
    try {
      database = { reachable: true, migration: await currentVersion(deps.db), latest: LATEST_VERSION };
    } catch {
      database = { reachable: false, migration: null, latest: LATEST_VERSION };
    }
    return c.json({
      env: config.APP_ENV,
      database,
      adapters: {
        stripe: config.STRIPE_SECRET_KEY ? 'configured' : 'not configured',
        hubspot: config.HUBSPOT_ACCESS_TOKEN ? 'configured' : 'not configured',
        email: deps.emailProvider ? 'configured' : 'not configured',
      },
      ...(deps.imageEngine ? { imageEngine: deps.imageEngine } : {}),
    });
  });

  // SCRUM-81: today's price, GST wording and postage guide, for the website (public; no personal
  // data). The site reads it so the wording changes on GST_REGISTERED_FROM without a rebuild.
  app.get('/api/pricing', (c) => {
    const today = sydneyDate((deps.now ?? (() => new Date()))());
    const terms = termsOn(today, { gstRegisteredFrom: config.GST_REGISTERED_FROM ?? null });
    const table = postageTableOn(today);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json({
      date: today,
      currency: 'AUD',
      termsVersion: terms.version,
      pricePerPaddleCents: terms.pricePerPaddleCents,
      gst: { registered: terms.treatment === 'gst_inclusive', note: priceNote(terms.treatment) },
      postage: { table: table.from, basis: table.basis, byPaddles: postageGuide(today) },
    });
  });

  app.route(
    '/api/orders',
    orderRoutes({
      db: deps.db,
      photos: deps.photos,
      keys: deps.keys,
      trusted: deps.trusted,
      mailer: deps.mailer ?? null,
      isProduction: config.APP_ENV === 'production',
      limits: {
        orderPerIpHour: config.ORDER_LIMIT_PER_IP_HOUR,
        orderPerEmailDay: config.ORDER_LIMIT_PER_EMAIL_DAY,
        linksPerEmailDay: config.LINKS_LIMIT_PER_EMAIL_DAY,
        linksPerIpHour: config.LINKS_LIMIT_PER_IP_HOUR,
        minFillSeconds: config.ORDER_MIN_FILL_SECONDS,
      },
      now: deps.now,
      peer: deps.peer,
    }),
  );

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    // Type, code and stack frames only: messages can quote what the customer typed.
    logError('request_failed', err, { path: c.req.path });
    return c.json({ error: 'internal error', message: 'Sorry, something went wrong. Please try again, or email us.' }, 500);
  });

  return app;
}
