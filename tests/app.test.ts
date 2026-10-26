import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_VERSION } from '../src/db/migrations.js';
import { makeApp, SITE, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => t.close());

describe('app', () => {
  it('answers the health check', async () => {
    const res = await t.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('reports adapters and the database without secret values (SCRUM-64)', async () => {
    const res = await t.app.request('/api/status');
    expect(await res.json()).toEqual({
      env: 'development',
      database: { reachable: true, migration: LATEST_VERSION, latest: LATEST_VERSION },
      adapters: { stripe: 'not configured', hubspot: 'not configured', email: 'not configured' },
    });
  });

  it('reports the database as unreachable instead of failing', async () => {
    await t.db.close();
    const res = await t.app.request('/api/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { database: { reachable: boolean } }).database.reachable).toBe(false);
    t = await makeApp(); // something for afterEach to close
  });

  it('allows CORS only from the site origin', async () => {
    const ok = await t.app.request('/api/status', { headers: { Origin: SITE } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    const other = await t.app.request('/api/status', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('allows CORS from each listed origin (LAN and Tailscale)', async () => {
    const lan = 'http://home-server:8088';
    const ts = 'https://home-server.tail8bc7ae.ts.net:8443';
    const staging = await makeApp({ env: { APP_ENV: 'staging', PUBLIC_SITE_ORIGIN: `${lan},${ts}` } });
    try {
      for (const origin of [lan, ts]) {
        const res = await staging.app.request('/api/status', { headers: { Origin: origin } });
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      }
      const other = await staging.app.request('/api/status', { headers: { Origin: 'https://evil.example' } });
      expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    } finally {
      await staging.close();
    }
  });

  it('sets security headers and returns JSON 404s', async () => {
    const res = await t.app.request('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
