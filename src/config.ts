/**
 * Settings for the integrations service (SCRUM-18).
 *
 * Every value comes from the environment, never from the repo:
 *   - dev:        a git-ignored `.env` file, copied from `.env.example`
 *   - staging:    a root-only file on home-server (/etc/picklemypaddle/integrations.env)
 *   - production: the same, on the OVH server (later)
 *
 * The service refuses to start if a required value is missing or invalid, and the
 * error names the setting (never its value). Outside production, Stripe keys must be
 * test-mode keys, so staging can never charge a real card.
 *
 * SCRUM-64/67: DATABASE_URL (the order of record, a secret because it carries the password),
 * the photo folder, and the abuse limits. Production limits can be tightened but never
 * relaxed above the defaults, so a test setting can't leak into production.
 */
import { z } from 'zod';
import { IMAGE_ENGINES } from './orders/image-engine.js';

export const APP_ENVS = ['development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const optional = (schema: z.ZodString) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

/** One web origin: scheme, host and optional port, nothing else (no path or trailing slash). */
const isOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
};

/**
 * Comma-separated list of website origins allowed to call this service (CORS).
 * Staging is reached on the LAN and over Tailscale (SCRUM-38), so it lists both.
 */
const originList = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const items = v.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  },
  z.array(
    z.string().refine(isOrigin, {
      message: 'must be origins like http://home-server:8088 (comma-separated, no path or trailing slash)',
    }),
  ),
);

/** postgres://user:password@host:port/db — checked for shape only; the value is never printed. */
const isPostgresUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && !!url.hostname && url.pathname.length > 1;
  } catch {
    return false;
  }
};

/** A positive whole number, as text in the environment. */
const count = (fallback: number) => z.coerce.number().int().min(1).max(100_000).default(fallback);

/** Default abuse limits (SCRUM-67, agreed 26 Oct 2026). Production may only go lower. */
export const LIMIT_DEFAULTS = {
  ORDER_LIMIT_PER_IP_HOUR: 5,
  ORDER_LIMIT_PER_EMAIL_DAY: 3,
  LINKS_LIMIT_PER_EMAIL_DAY: 3,
  LINKS_LIMIT_PER_IP_HOUR: 10,
  ORDER_MIN_FILL_SECONDS: 3,
} as const;

const schema = z
  .object({
    APP_ENV: z.enum(APP_ENVS, { error: `must be one of: ${APP_ENVS.join(', ')}` }),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Website origins allowed to call this service (CORS), e.g. http://home-server:8088,https://… */
    PUBLIC_SITE_ORIGIN: originList,

    // ── Orders (SCRUM-64 to 70) ────────────────────────────────────────────────
    /** The order database. Required: the service won't start without it. */
    DATABASE_URL: z.string().refine(isPostgresUrl, {
      message: 'must be a postgres:// URL (postgres://user:password@host:5432/database)',
    }),
    /** Where processed photos are kept: a private volume, never served statically. */
    PHOTO_DIR: z.string().min(1).default('/data/photos'),
    /**
     * Who may set X-Forwarded-For: comma-separated IPs, CIDR ranges or host names (resolved),
     * e.g. "gateway" in the Compose stacks. Empty = trust nobody (use the socket address).
     */
    TRUSTED_PROXIES: z
      .preprocess((v) => (typeof v === 'string' ? v : ''), z.string())
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    ORDER_LIMIT_PER_IP_HOUR: count(LIMIT_DEFAULTS.ORDER_LIMIT_PER_IP_HOUR),
    ORDER_LIMIT_PER_EMAIL_DAY: count(LIMIT_DEFAULTS.ORDER_LIMIT_PER_EMAIL_DAY),
    LINKS_LIMIT_PER_EMAIL_DAY: count(LIMIT_DEFAULTS.LINKS_LIMIT_PER_EMAIL_DAY),
    LINKS_LIMIT_PER_IP_HOUR: count(LIMIT_DEFAULTS.LINKS_LIMIT_PER_IP_HOUR),
    /** Submissions faster than this after the form loaded are treated as bots. */
    ORDER_MIN_FILL_SECONDS: z.coerce.number().int().min(0).max(60).default(LIMIT_DEFAULTS.ORDER_MIN_FILL_SECONDS),
    /** Photo engine (SCRUM-66): vips (the image's libvips tools), sharp (development), or auto. */
    IMAGE_ENGINE: z.enum(IMAGE_ENGINES, { error: `must be one of: ${IMAGE_ENGINES.join(', ')}` }).default('auto'),

    // ── Stripe (SCRUM-9). Optional until payments are built. ──────────────────
    STRIPE_SECRET_KEY: optional(
      z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'must be a Stripe secret or restricted key'),
    ),
    STRIPE_WEBHOOK_SECRET: optional(z.string().regex(/^whsec_[A-Za-z0-9]+$/, 'must start with whsec_')),

    // ── HubSpot (SCRUM-8). Optional until the CRM adapter is built. ───────────
    HUBSPOT_ACCESS_TOKEN: optional(z.string().regex(/^pat-[a-z0-9]+-[A-Za-z0-9-]+$/, 'must be a HubSpot service key (pat-…)')),
    /** Public: also built into the site's forms. */
    HUBSPOT_PORTAL_ID: optional(z.string().regex(/^\d+$/, 'must be the numeric HubSpot portal (account) ID')),
  })
  .superRefine((c, ctx) => {
    if (c.APP_ENV === 'production') {
      for (const [key, max] of Object.entries(LIMIT_DEFAULTS) as [keyof typeof LIMIT_DEFAULTS, number][]) {
        const tooLoose = key === 'ORDER_MIN_FILL_SECONDS' ? c[key] < max : c[key] > max;
        if (tooLoose) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `can't be relaxed in production (default ${max}); production limits are never loosened for tests`,
          });
        }
      }
    }
    if (c.APP_ENV !== 'production' && c.STRIPE_SECRET_KEY && /_live_/.test(c.STRIPE_SECRET_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: `is a LIVE key, but APP_ENV is ${c.APP_ENV}; use a test-mode key (sk_test_…) outside production`,
      });
    }
    if (c.APP_ENV === 'production' && c.STRIPE_SECRET_KEY && /_test_/.test(c.STRIPE_SECRET_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'is a test-mode key, but APP_ENV is production',
      });
    }
    if (c.STRIPE_SECRET_KEY && !c.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'is required when STRIPE_SECRET_KEY is set',
      });
    }
  });

export type Config = z.infer<typeof schema>;

/** Settings whose values must never be printed or logged. */
export const SECRET_KEYS = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'HUBSPOT_ACCESS_TOKEN'] as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parse and validate settings. Throws ConfigError naming every bad setting (never its value). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Readonly<Config> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? 'configuration');
      // Missing: not in the environment at all, or a list that was only separators (" , ").
      // Decided from the environment, not Zod's issue details, so no input value is ever echoed.
      const raw = env[name];
      // Cross-setting rules (custom issues) keep their own message even when the setting is unset.
      const missing = issue.code !== 'custom' && (raw === undefined || issue.code === 'invalid_type');
      return missing ? `${name} is required but not set` : `${name} ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  return Object.freeze(result.data);
}

/** A copy that is safe to log: secrets shown only as set/unset. */
export function describeConfig(config: Config): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    if ((SECRET_KEYS as readonly string[]).includes(key)) out[key] = '[set]';
    else out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
