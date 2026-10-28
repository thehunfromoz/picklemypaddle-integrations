import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../src/config.js';

const dbUrl = 'postgres://pmp:' + 's3cretPassw0rd' + '@postgres:5432/pmp';
const base = { APP_ENV: 'staging', PUBLIC_SITE_ORIGIN: 'http://home-server:8088', DATABASE_URL: dbUrl, EMAIL_ALLOWLIST: 'sales@picklemypaddle.com' };
const resendKey = 're_' + 'd'.repeat(30);
const testKey = 'sk_test_' + 'a'.repeat(24);
const liveKey = 'sk_live_' + 'b'.repeat(24);
const whsec = 'whsec_' + 'c'.repeat(24);
const hubspotKey = 'pat-ap1-' + 'a'.repeat(36);

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
      'DATABASE_URL is required but not set',
    ]);
  });

  describe('order settings (SCRUM-64, SCRUM-67)', () => {
    it('refuses an invalid DATABASE_URL without printing it', () => {
      for (const bad of ['', 'mysql://u:p@db/x', 'postgres://u:p@db', 'not a url at all']) {
        const p = problems({ ...base, DATABASE_URL: bad });
        expect(p).toHaveLength(1);
        expect(p[0]).toMatch(/^DATABASE_URL (must be a postgres:\/\/ URL|is required)/);
        if (bad) expect(p[0]).not.toContain(bad);
      }
    });

    it('never shows the database URL (it carries the password)', () => {
      const shown = JSON.stringify(describeConfig(loadConfig(base)));
      expect(shown).not.toContain('s3cretPassw0rd');
      expect(describeConfig(loadConfig(base)).DATABASE_URL).toBe('[set]');
    });

    it('defaults the photo folder, limits and trusted proxies', () => {
      const c = loadConfig(base);
      expect(c.PHOTO_DIR).toBe('/data/photos');
      expect(c.TRUSTED_PROXIES).toEqual([]);
      expect([c.ORDER_LIMIT_PER_IP_HOUR, c.ORDER_LIMIT_PER_EMAIL_DAY, c.LINKS_LIMIT_PER_EMAIL_DAY, c.LINKS_LIMIT_PER_IP_HOUR, c.ORDER_MIN_FILL_SECONDS])
        .toEqual([5, 3, 3, 10, 3]);
      expect(loadConfig({ ...base, TRUSTED_PROXIES: 'gateway, 10.0.0.0/8' }).TRUSTED_PROXIES).toEqual(['gateway', '10.0.0.0/8']);
    });

    it('lets staging raise its limits for smoke traffic', () => {
      expect(loadConfig({ ...base, ORDER_LIMIT_PER_IP_HOUR: '60' }).ORDER_LIMIT_PER_IP_HOUR).toBe(60);
    });

    it('never lets production relax a limit, only tighten it', () => {
      const prod = { ...base, APP_ENV: 'production', RESEND_API_KEY: resendKey };
      expect(problems({ ...prod, ORDER_LIMIT_PER_IP_HOUR: '6' })[0]).toMatch(/^ORDER_LIMIT_PER_IP_HOUR can't be relaxed in production/);
      expect(problems({ ...prod, ORDER_MIN_FILL_SECONDS: '1' })[0]).toMatch(/^ORDER_MIN_FILL_SECONDS can't be relaxed in production/);
      expect(loadConfig({ ...prod, ORDER_LIMIT_PER_IP_HOUR: '2', ORDER_MIN_FILL_SECONDS: '5' }).ORDER_LIMIT_PER_IP_HOUR).toBe(2);
    });
  });

  it('reads one or more site origins (SCRUM-38)', () => {
    expect(loadConfig(base).PUBLIC_SITE_ORIGIN).toEqual(['http://home-server:8088']);
    const both = loadConfig({
      ...base,
      PUBLIC_SITE_ORIGIN: ' http://home-server:8088 , https://home-server.tail8bc7ae.ts.net:8443 ,',
    });
    expect(both.PUBLIC_SITE_ORIGIN).toEqual(['http://home-server:8088', 'https://home-server.tail8bc7ae.ts.net:8443']);
  });

  it('rejects site origins with a path, a trailing slash or a non-web scheme', () => {
    for (const bad of ['http://home-server:8088/', 'http://home-server:8088/api', 'ftp://home-server', 'home-server:8088']) {
      expect(problems({ ...base, PUBLIC_SITE_ORIGIN: bad })[0]).toMatch(/^PUBLIC_SITE_ORIGIN must be origins like/);
    }
  });

  it('treats an empty origin list as unset', () => {
    expect(problems({ ...base, PUBLIC_SITE_ORIGIN: ' , ' })).toEqual(['PUBLIC_SITE_ORIGIN is required but not set']);
  });

  it('rejects an unknown environment', () => {
    expect(problems({ ...base, APP_ENV: 'prod' })[0]).toMatch(/^APP_ENV must be one of/);
  });

  it('accepts a HubSpot service key', () => {
    expect(loadConfig({ ...base, HUBSPOT_ACCESS_TOKEN: hubspotKey }).HUBSPOT_ACCESS_TOKEN).toBe(hubspotKey);
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
    expect(problems({ ...base, APP_ENV: 'production', RESEND_API_KEY: resendKey, STRIPE_SECRET_KEY: testKey, STRIPE_WEBHOOK_SECRET: whsec }))
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

describe('email settings (SCRUM-69)', () => {
  it('refuses to start outside production without an allow-list', () => {
    const { EMAIL_ALLOWLIST: _, ...noList } = base;
    for (const APP_ENV of ['development', 'staging']) {
      expect(problems({ ...noList, APP_ENV })[0]).toMatch(/^EMAIL_ALLOWLIST is required outside production/);
    }
  });

  it('reads the allow-list lower-cased and refuses anything that is not an address', () => {
    expect(loadConfig({ ...base, EMAIL_ALLOWLIST: ' Sales@PickleMyPaddle.com , me+x@example.org ' }).EMAIL_ALLOWLIST)
      .toEqual(['sales@picklemypaddle.com', 'me+x@example.org']);
    expect(problems({ ...base, EMAIL_ALLOWLIST: 'sales@picklemypaddle.com, nobody' })[0]).toMatch(/^EMAIL_ALLOWLIST must be email addresses/);
  });

  it('needs a Resend key in production but no allow-list', () => {
    const { EMAIL_ALLOWLIST: _, ...noList } = base;
    expect(problems({ ...noList, APP_ENV: 'production' })).toEqual(['RESEND_API_KEY is required in production (customer emails)']);
    expect(loadConfig({ ...noList, APP_ENV: 'production', RESEND_API_KEY: resendKey }).APP_ENV).toBe('production');
  });

  it('never shows the Resend key, and shows the allow-list only as a count', () => {
    const shown = describeConfig(loadConfig({ ...base, RESEND_API_KEY: resendKey }));
    expect(shown.RESEND_API_KEY).toBe('[set]');
    expect(shown.EMAIL_ALLOWLIST).toBe('1 address(es)');
    expect(JSON.stringify(shown)).not.toContain('sales@');
  });

  it('checks the link bases', () => {
    expect(problems({ ...base, SITE_URL: 'https://www.picklemypaddle.com/' })[0]).toMatch(/^SITE_URL must be an origin/);
    expect(loadConfig({ ...base, ADMIN_URL: 'https://home-server.tail8bc7ae.ts.net:8445' }).ADMIN_URL).toBeDefined();
  });
});

describe('describeConfig', () => {
  it('hides secret values', () => {
    const c = loadConfig({ ...base, STRIPE_SECRET_KEY: testKey, STRIPE_WEBHOOK_SECRET: whsec, HUBSPOT_PORTAL_ID: '123' });
    const shown = describeConfig(c);
    expect(shown.STRIPE_SECRET_KEY).toBe('[set]');
    expect(shown.STRIPE_WEBHOOK_SECRET).toBe('[set]');
    expect(shown.HUBSPOT_PORTAL_ID).toBe('123');
    expect(shown.PUBLIC_SITE_ORIGIN).toBe('http://home-server:8088');
    expect(JSON.stringify(shown)).not.toContain(testKey);
  });
});
