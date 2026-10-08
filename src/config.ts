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
 */
import { z } from 'zod';

export const APP_ENVS = ['development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const optional = (schema: z.ZodString) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const schema = z
  .object({
    APP_ENV: z.enum(APP_ENVS, {
      errorMap: () => ({ message: `must be one of: ${APP_ENVS.join(', ')}` }),
    }),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Origin of the website allowed to call this service (CORS), e.g. http://home-server:8088 */
    PUBLIC_SITE_ORIGIN: z.string().url({ message: 'must be a URL like http://home-server:8088' }),

    // ── Stripe (SCRUM-9). Optional until payments are built. ──────────────────
    STRIPE_SECRET_KEY: optional(
      z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'must be a Stripe secret or restricted key'),
    ),
    STRIPE_WEBHOOK_SECRET: optional(z.string().regex(/^whsec_[A-Za-z0-9]+$/, 'must start with whsec_')),

    // ── HubSpot (SCRUM-8). Optional until the CRM adapter is built. ───────────
    HUBSPOT_ACCESS_TOKEN: optional(z.string().regex(/^pat-[a-z0-9]+-[A-Za-z0-9-]+$/, 'must be a HubSpot private app token (pat-…)')),
    /** Public: also built into the site's forms. */
    HUBSPOT_PORTAL_ID: optional(z.string().regex(/^\d+$/, 'must be the numeric HubSpot portal (account) ID')),
  })
  .superRefine((c, ctx) => {
    if (c.APP_ENV !== 'production' && c.STRIPE_SECRET_KEY && /_live_/.test(c.STRIPE_SECRET_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_SECRET_KEY'],
        message: `is a LIVE key, but APP_ENV is ${c.APP_ENV}; use a test-mode key (sk_test_…) outside production`,
      });
    }
    if (c.APP_ENV === 'production' && c.STRIPE_SECRET_KEY && /_test_/.test(c.STRIPE_SECRET_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_SECRET_KEY'],
        message: 'is a test-mode key, but APP_ENV is production',
      });
    }
    if (c.STRIPE_SECRET_KEY && !c.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'is required when STRIPE_SECRET_KEY is set',
      });
    }
  });

export type Config = z.infer<typeof schema>;

/** Settings whose values must never be printed or logged. */
export const SECRET_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'HUBSPOT_ACCESS_TOKEN'] as const;

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
      const missing = issue.code === 'invalid_type' && issue.received === 'undefined';
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
    out[key] = (SECRET_KEYS as readonly string[]).includes(key) ? '[set]' : value;
  }
  return out;
}
