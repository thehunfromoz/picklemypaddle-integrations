/**
 * Versioned schema migrations (SCRUM-64). Run on startup, before the service listens, so a
 * container is only healthy once its schema is current. A failed migration stops the new
 * container (exit 1); the staging updater then rolls back to the previous image, which keeps
 * working because migrations are only ever additive.
 *
 * Rules: never edit a migration once merged; add a new one. Each runs in its own transaction,
 * and a lock stops two containers migrating at once.
 */
import type { Db } from './db.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'orders, paddles, photos, status history, status-link tokens, rate limits',
    sql: `
      -- One row per order. Personal details stay here (the order of record); HubSpot gets a
      -- mirror later (SCRUM-74). is_test is true for every order taken outside production.
      CREATE TABLE orders (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reference         text NOT NULL,
        status            text NOT NULL,
        status_changed_at timestamptz NOT NULL DEFAULT now(),
        is_test           boolean NOT NULL,
        is_smoke          boolean NOT NULL DEFAULT false,
        name              text NOT NULL,
        email             text NOT NULL,
        email_norm        text NOT NULL,
        phone             text,
        street            text NOT NULL,
        suburb            text NOT NULL,
        state             text NOT NULL,
        postcode          text NOT NULL,
        consent_at        timestamptz NOT NULL,
        tournament_ack_at timestamptz NOT NULL,
        tracking_number   text,
        idempotency_key   text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT orders_reference_key UNIQUE (reference),
        CONSTRAINT orders_idempotency_key UNIQUE (idempotency_key)
      );
      CREATE INDEX orders_email_norm_idx ON orders (email_norm);
      CREATE INDEX orders_smoke_idx ON orders (created_at) WHERE is_smoke;

      CREATE TABLE paddles (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id  uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        position  integer NOT NULL,
        brand     text NOT NULL,
        model     text,
        UNIQUE (order_id, position)
      );

      -- Where each processed photo file is, never the image itself (photos live on a volume).
      CREATE TABLE photos (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        paddle_id  uuid NOT NULL REFERENCES paddles (id) ON DELETE CASCADE,
        side       text NOT NULL CHECK (side IN ('front', 'back')),
        path       text NOT NULL UNIQUE,
        bytes      integer NOT NULL,
        width      integer NOT NULL,
        height     integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (paddle_id, side)
      );

      CREATE TABLE status_history (
        id       bigserial PRIMARY KEY,
        order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        status   text NOT NULL,
        at       timestamptz NOT NULL DEFAULT now(),
        note     text
      );
      CREATE INDEX status_history_order_idx ON status_history (order_id, at);

      -- Private status links (SCRUM-70): only a SHA-256 of each token is kept.
      CREATE TABLE status_tokens (
        id         bigserial PRIMARY KEY,
        order_id   uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        token_hash bytea NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz
      );
      CREATE INDEX status_tokens_order_idx ON status_tokens (order_id);

      -- Abuse limits (SCRUM-67): one row per counted event; keys are salted hashes, never raw
      -- IPs or emails. Rows older than two days are deleted daily.
      CREATE TABLE rate_limit_events (
        id       bigserial PRIMARY KEY,
        bucket   text NOT NULL,
        key_hash text NOT NULL,
        at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX rate_limit_events_lookup_idx ON rate_limit_events (bucket, key_hash, at);

      -- Random keys the service makes for itself on first start (form-token signing, hashing
      -- salt). Kept in the database so every container and restart agrees on them.
      CREATE TABLE app_secrets (
        name       text PRIMARY KEY,
        value      bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** An arbitrary constant: the advisory lock that serialises migrations. */
const LOCK_ID = 4_706_518;

/** Brings the schema to the latest version. Returns the version now in place. */
export async function migrate(db: Db): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const { rows } = await q.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => Number(r.version)));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await q.exec(m.sql);
      await q.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    }
    return currentVersion(q);
  });
}

export async function currentVersion(q: { query: Db['query'] }): Promise<number> {
  const { rows } = await q.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  return Number(rows[0]?.v ?? 0);
}
