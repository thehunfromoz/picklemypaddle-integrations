/**
 * The clubs' public API (SCRUM-85):
 *
 *   POST /api/clubs/invoice { token, number } → a club invoice, for its printable page on the site, or 404
 *
 * The token is the private link from the invoice email; a wrong token and a wrong number get the
 * same answer. Guessing is hopeless (256-bit tokens), but each address is still limited per hour,
 * like every other public route.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/db.js';
import { clubDocumentForToken } from '../documents/documents.js';
import { log } from '../log.js';
import { checkLimit, clientIp, hashKey, recordEvent, type AbuseKeys, type Limit, type TrustedProxies } from '../orders/abuse.js';

export interface ClubRouteDeps {
  db: Db;
  keys: AbuseKeys;
  trusted: TrustedProxies;
  /** Invoice lookups allowed per address per hour. */
  lookupsPerIpHour?: number;
  now?: () => Date;
  peer?: (c: Context) => string;
}

export const CLUB_INVOICE_LOOKUPS_PER_IP_HOUR = 120;
const HOUR = 60 * 60 * 1000;
const nodePeer = (c: Context): string =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? '';

const INVALID_LINK = { error: 'invalid_link', message: 'This invoice link isn’t valid. Use the link in the latest invoice email, or reply to it and we’ll send a new one.' };
const RATE_MESSAGE = 'We’ve received a lot of requests from you recently. Please try again later, or email attila@picklemypaddle.com.';

export function clubRoutes(deps: ClubRouteDeps) {
  const now = deps.now ?? (() => new Date());
  const peer = deps.peer ?? nodePeer;
  const limit: Limit = { bucket: 'club-invoice-ip', max: deps.lookupsPerIpHour ?? CLUB_INVOICE_LOOKUPS_PER_IP_HOUR, windowMs: HOUR };
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.post('/invoice', bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const at = now();
    const ipKey = hashKey(deps.keys.pepper, await clientIp(peer(c), c.req.header('x-forwarded-for'), deps.trusted));
    const r = await checkLimit(deps.db, limit, ipKey, at);
    if (!r.ok) {
      log('rate_limited', { bucket: limit.bucket, key: ipKey.slice(0, 12) });
      c.header('Retry-After', String(r.retryAfterSeconds));
      return c.json({ error: 'rate_limited', message: RATE_MESSAGE, retryAfter: r.retryAfterSeconds }, 429);
    }
    await recordEvent(deps.db, limit.bucket, ipKey, at);
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; number?: unknown } | null;
    const doc = await clubDocumentForToken(deps.db, body?.token, body?.number, at);
    return doc ? c.json(doc) : c.json(INVALID_LINK, 404);
  });
  return app;
}
