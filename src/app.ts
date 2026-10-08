import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from './config.js';

/** The HTTP app. Order, CRM and payment routes are added by their own stories. */
export function createApp(config: Config) {
  const app = new Hono();

  app.use('*', secureHeaders());
  app.use(
    '/api/*',
    cors({ origin: config.PUBLIC_SITE_ORIGIN, allowMethods: ['GET', 'POST'], maxAge: 600 }),
  );

  app.get('/healthz', (c) => c.text('ok'));

  // Which adapters are configured (no secret values, just on/off).
  app.get('/api/status', (c) =>
    c.json({
      env: config.APP_ENV,
      adapters: {
        stripe: config.STRIPE_SECRET_KEY ? 'configured' : 'not configured',
        hubspot: config.HUBSPOT_ACCESS_TOKEN ? 'configured' : 'not configured',
      },
    }),
  );

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
