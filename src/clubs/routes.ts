/**
 * The clubs' public API (SCRUM-85):
 *
 *   POST /api/clubs/invoice { token, number } → a club invoice, for its printable page on the site, or 404
 *
 * The token is the private link from the invoice email; a wrong token and a wrong number get the
 * same answer. Paying by card from that page is SCRUM-85's second part.
 */
import { Hono } from 'hono';
import type { Db } from '../db/db.js';
import { clubDocumentForToken } from '../documents/documents.js';

export interface ClubRouteDeps {
  db: Db;
  now?: () => Date;
}

const INVALID_LINK = { error: 'invalid_link', message: 'This invoice link isn’t valid. Use the link in the latest invoice email, or reply to it and we’ll send a new one.' };

export function clubRoutes(deps: ClubRouteDeps) {
  const now = deps.now ?? (() => new Date());
  const app = new Hono();
  app.post('/invoice', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; number?: unknown } | null;
    const doc = await clubDocumentForToken(deps.db, body?.token, body?.number, now());
    return doc ? c.json(doc) : c.json(INVALID_LINK, 404);
  });
  return app;
}
