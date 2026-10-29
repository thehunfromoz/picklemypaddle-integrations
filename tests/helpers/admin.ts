/** The admin app (SCRUM-71/72) over a TestApp's database, with Tailscale identity headers faked. */
import type { Context } from 'hono';
import { createAdminApp } from '../../src/admin/app.js';
import { csrfToken } from '../../src/admin/guard.js';
import { serviceSecret, TrustedProxies } from '../../src/orders/abuse.js';
import type { TestApp } from './app.js';

export const ATTILA = 'attila@test.picklemypaddle.com';
export const ADMIN_HOST = 'home-server.example.ts.net:8445';

export interface TestAdmin {
  app: ReturnType<typeof createAdminApp>;
  /** Where the connection comes from: 127.0.0.1 (trusted, like the gateway) unless changed. */
  peer: { address: string };
  csrf(login?: string): string;
  /** Headers Tailscale Serve would add for a signed-in user (plus the Host it was opened at). */
  identity(login?: string): Record<string, string>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  /** A same-origin form POST with the right CSRF token, as the admin's own pages send it. */
  post(path: string, fields?: Record<string, string>, headers?: Record<string, string>): Promise<Response>;
}

export async function makeAdmin(
  t: TestApp,
  opts: { isProduction?: boolean; logins?: string[] | undefined; trusted?: string[] } = {},
): Promise<TestAdmin> {
  const csrfKey = await serviceSecret(t.db, 'admin-csrf-key');
  const peer = { address: '127.0.0.1' };
  const app = createAdminApp({
    db: t.db,
    photos: t.photos,
    isProduction: opts.isProduction ?? false,
    logins: 'logins' in opts ? opts.logins : [ATTILA],
    trusted: new TrustedProxies(opts.trusted ?? ['127.0.0.1', '::1']),
    csrfKey,
    now: () => t.clock.now,
    peer: (_c: Context) => peer.address,
  });
  const identity = (login = ATTILA) => ({ 'Tailscale-User-Login': login, 'Tailscale-User-Name': 'Attila Madarasz', Host: ADMIN_HOST });
  const csrf = (login = ATTILA) => csrfToken(csrfKey, login);
  return {
    app,
    peer,
    csrf,
    identity,
    get: async (path, headers = identity()) => app.request(path, { headers }),
    post: async (path, fields = {}, headers = {}) =>
      app.request(path, {
        method: 'POST',
        body: new URLSearchParams({ _csrf: csrf(), ...fields }).toString(),
        headers: { ...identity(), 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...headers },
      }),
  };
}
