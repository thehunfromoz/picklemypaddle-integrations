import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { currentVersion, LATEST_VERSION } from './db/migrations.js';
import { logError } from './log.js';
import type { AbuseKeys, TrustedProxies } from './orders/abuse.js';
import type { PhotoStore } from './orders/photos.js';
import { orderRoutes } from './orders/routes.js';
import type { LinksMailer } from './orders/status.js';

export interface AppDeps {
  db: Db;
  photos: PhotoStore;
  keys: AbuseKeys;
  trusted: TrustedProxies;
  mailer?: LinksMailer | null;
  now?: () => Date;
  peer?: (c: Context) => string;
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
        email: deps.mailer ? 'configured' : 'not configured',
      },
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
