import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const app = createApp(loadConfig({ APP_ENV: 'development', PUBLIC_SITE_ORIGIN: 'http://localhost:4321' }));

describe('app', () => {
  it('answers the health check', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('reports adapter status without secret values', async () => {
    const res = await app.request('/api/status');
    expect(await res.json()).toEqual({
      env: 'development',
      adapters: { stripe: 'not configured', hubspot: 'not configured' },
    });
  });

  it('allows CORS only from the site origin', async () => {
    const ok = await app.request('/api/status', { headers: { Origin: 'http://localhost:4321' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:4321');
    const other = await app.request('/api/status', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('allows CORS from each listed origin (LAN and Tailscale)', async () => {
    const lan = 'http://home-server:8088';
    const ts = 'https://home-server.tail8bc7ae.ts.net:8443';
    const staging = createApp(loadConfig({ APP_ENV: 'staging', PUBLIC_SITE_ORIGIN: `${lan},${ts}` }));
    for (const origin of [lan, ts]) {
      const res = await staging.request('/api/status', { headers: { Origin: origin } });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const other = await staging.request('/api/status', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('sets security headers and returns JSON 404s', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
