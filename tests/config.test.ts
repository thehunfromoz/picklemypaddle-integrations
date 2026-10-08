import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../src/config.js';

const base = { APP_ENV: 'staging', PUBLIC_SITE_ORIGIN: 'http://home-server:8088' };
const testKey = 'sk_test_' + 'a'.repeat(24);
const liveKey = 'sk_live_' + 'b'.repeat(24);
const whsec = 'whsec_' + 'c'.repeat(24);

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('accepts the minimum settings and defaults the port', () => {
    const c = loadConfig(base);
    expect(c.APP_ENV).toBe('staging');
    expect(c.PORT).toBe(8080);
  });

  it('names each missing required setting', () => {
    expect(problems({})).toEqual([
      'APP_ENV is required but not set',
      'PUBLIC_SITE_ORIGIN is required but not set',
    ]);
  });

  it('rejects an unknown environment', () => {
    expect(problems({ ...base, APP_ENV: 'prod' })[0]).toMatch(/^APP_ENV must be one of/);
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: '  ' }).STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('refuses a live Stripe key outside production', () => {
    for (const APP_ENV of ['development', 'staging']) {
      expect(problems({ ...base, APP_ENV, STRIPE_SECRET_KEY: liveKey, STRIPE_WEBHOOK_SECRET: whsec })).toEqual([
        `STRIPE_SECRET_KEY is a LIVE key, but APP_ENV is ${APP_ENV}; use a test-mode key (sk_test_…) outside production`,
      ]);
    }
  });

  it('refuses a test Stripe key in production', () => {
    expect(problems({ ...base, APP_ENV: 'production', STRIPE_SECRET_KEY: testKey, STRIPE_WEBHOOK_SECRET: whsec }))
      .toEqual(['STRIPE_SECRET_KEY is a test-mode key, but APP_ENV is production']);
  });

  it('requires the webhook secret once Stripe is configured', () => {
    expect(problems({ ...base, STRIPE_SECRET_KEY: testKey })).toEqual([
      'STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set',
    ]);
  });

  it('never puts a secret value in an error message', () => {
    const bad = 'not-a-real-key-but-secret-looking-123';
    const msgs = problems({ ...base, STRIPE_SECRET_KEY: bad, HUBSPOT_ACCESS_TOKEN: bad }).join('\n');
    expect(msgs).toContain('STRIPE_SECRET_KEY');
    expect(msgs).toContain('HUBSPOT_ACCESS_TOKEN');
    expect(msgs).not.toContain(bad);
  });
});

describe('describeConfig', () => {
  it('hides secret values', () => {
    const c = loadConfig({ ...base, STRIPE_SECRET_KEY: testKey, STRIPE_WEBHOOK_SECRET: whsec, HUBSPOT_PORTAL_ID: '123' });
    const shown = describeConfig(c);
    expect(shown.STRIPE_SECRET_KEY).toBe('[set]');
    expect(shown.STRIPE_WEBHOOK_SECRET).toBe('[set]');
    expect(shown.HUBSPOT_PORTAL_ID).toBe('123');
    expect(JSON.stringify(shown)).not.toContain(testKey);
  });
});
