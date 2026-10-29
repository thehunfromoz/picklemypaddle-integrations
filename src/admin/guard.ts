/**
 * Who may use the order admin (SCRUM-71 AC4 and AC5).
 *
 * The admin is never on the public internet. It has its own listener (ADMIN_PORT), which the
 * public gateway never routes. In the stacks only the gateway's admin listener can reach it, and
 * that listener is published on the host's loopback only, for Tailscale Serve:
 *
 *   tailnet device ─► Tailscale Serve (HTTPS) ─► 127.0.0.1:<port> ─► gateway ─► integrations:ADMIN_PORT
 *
 * Tailscale Serve removes any Tailscale-User-* headers a client sends and adds the real ones for
 * the signed-in user (tagged devices get none). So the identity headers are believed only when
 * the connection comes from a trusted peer (ADMIN_TRUSTED_PROXIES: the gateway on its private
 * admin network); from anyone else every request is refused before the headers are read.
 *
 * Then: no Tailscale-User-Login → 403; a login not in ADMIN_LOGINS → 403. State-changing
 * requests must also come from the same origin (Sec-Fetch-Site / Origin) and carry the CSRF
 * token that every admin form holds.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { log } from '../log.js';
import type { TrustedProxies } from '../orders/abuse.js';

export const LOGIN_HEADER = 'tailscale-user-login';
export const NAME_HEADER = 'tailscale-user-name';

export interface AdminIdentity {
  login: string;
  name: string | null;
  csrf: string;
}

export interface GuardDeps {
  logins: readonly string[] | undefined;
  trusted: TrustedProxies;
  peer: (c: Context) => string;
  csrfKey: Buffer;
}

/** One token per login: an HMAC under a key the service keeps in its database. */
export const csrfToken = (key: Buffer, login: string) => createHmac('sha256', key).update(`admin-csrf:${login}`).digest('base64url');

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const refuse = (c: Context, status: 403 | 503, message: string) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return c.body(message, status);
};

/** Request came from this site's own pages (not another site, not a bookmarklet). */
export function isSameOrigin(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site) return site === 'same-origin';
  // Older browsers: the Origin header's host must be the one the request was sent to.
  const origin = c.req.header('origin');
  const host = c.req.header('host');
  if (!origin || !host || origin === 'null') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Identity and request-forgery checks for every admin request. */
export function adminGuard(deps: GuardDeps): MiddlewareHandler<{ Variables: { admin: AdminIdentity } }> {
  const allowed = new Set((deps.logins ?? []).map((l) => l.toLowerCase()));
  return async (c, next) => {
    if (!(await deps.trusted.trusts(deps.peer(c)))) {
      log('admin_refused', { reason: 'untrusted_peer' });
      return refuse(c, 403, 'Forbidden: the admin is reachable only through Tailscale.');
    }
    if (allowed.size === 0) return refuse(c, 503, 'The admin is not set up yet: ADMIN_LOGINS is empty.');
    const login = c.req.header(LOGIN_HEADER)?.trim().toLowerCase();
    if (!login) {
      log('admin_refused', { reason: 'no_identity' });
      return refuse(c, 403, 'Forbidden: no Tailscale identity. Open the admin from a signed-in device on the tailnet.');
    }
    if (!allowed.has(login)) {
      // The login is personal data: logged as "someone not on the list" only.
      log('admin_refused', { reason: 'login_not_allowed' });
      return refuse(c, 403, 'Forbidden: this Tailscale login may not use the admin.');
    }
    const csrf = csrfToken(deps.csrfKey, login);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!isSameOrigin(c)) {
        log('admin_refused', { reason: 'cross_origin' });
        return refuse(c, 403, 'Forbidden: that request did not come from the admin’s own pages.');
      }
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const given = typeof body._csrf === 'string' ? body._csrf : '';
      if (!sameToken(given, csrf)) {
        log('admin_refused', { reason: 'bad_csrf' });
        return refuse(c, 403, 'Forbidden: the form had expired or was tampered with. Go back, reload and try again.');
      }
    }
    // Tailscale sends the display name percent-encoded only when it isn't plain ASCII; show it as sent.
    c.set('admin', { login, name: c.req.header(NAME_HEADER)?.trim() || null, csrf });
    await next();
  };
}
