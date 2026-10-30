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
  {
    version: 2,
    name: 'outbox for emails and CRM jobs; who changed a status; paddle arrival date',
    sql: `
      -- SCRUM-69/74: work that talks to the outside world (Resend, HubSpot) is queued here in the
      -- same transaction as the change that causes it, then sent by a background worker with
      -- retries. An outage at either provider never fails an order or a status change.
      --
      -- payload holds only what the template can't read from the order (an amount, a reason
      -- typed by Attila). Never a status-link token: emails are rendered when sent, and each
      -- send mints its own token, so only token hashes are ever stored (SCRUM-70).
      CREATE TABLE outbox (
        id              bigserial PRIMARY KEY,
        kind            text NOT NULL CHECK (kind IN ('email', 'crm')),
        order_id        uuid REFERENCES orders (id) ON DELETE CASCADE,
        template        text NOT NULL,
        -- Email only. Personal data: goes when the order is deleted (cascade).
        recipient       text,
        payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- pending → sending (leased to a worker) → sent | failed | suppressed
        state           text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        -- An error type/code or a short reason (e.g. 'not_allow_listed'), never a message body.
        last_error      text,
        provider_id     text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        done_at         timestamptz
      );
      CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE state IN ('pending', 'sending');
      CREATE INDEX outbox_order_idx ON outbox (order_id, created_at);
      -- At most one waiting CRM job per order: a sync pushes the order's current state anyway.
      CREATE UNIQUE INDEX outbox_crm_pending_key ON outbox (order_id) WHERE kind = 'crm' AND state = 'pending';

      -- SCRUM-72: who made each change: 'customer' (intake), 'admin', 'system' (automatic jobs)
      -- or 'stripe'. Older rows were all made at intake.
      ALTER TABLE status_history ADD COLUMN actor text;
      UPDATE status_history SET actor = 'customer' WHERE actor IS NULL;

      -- SCRUM-72/73: the day the paddles arrived (set on In queue); "back in the post by" counts from it.
      ALTER TABLE orders ADD COLUMN arrived_on date;
    `,
  },
  {
    version: 3,
    name: 'HubSpot record IDs on each order',
    sql: `
      -- SCRUM-74: the CRM records mirroring this order, once synced. The database stays the
      -- master; these only let a sync update the same records instead of creating new ones.
      ALTER TABLE orders ADD COLUMN crm_contact_id text;
      ALTER TABLE orders ADD COLUMN crm_deal_id text;
    `,
  },
  {
    version: 4,
    name: 'customer reviews (testimonial requests)',
    sql: `
      -- SCRUM-33: one review per order, left on the private status page once the paddles are on
      -- their way back. Quoted on the website only with permission (as first name and suburb),
      -- and only after Attila adds it to the site's testimonials file. Goes with the order.
      CREATE TABLE reviews (
        id            bigserial PRIMARY KEY,
        order_id      uuid NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
        quote         text NOT NULL,
        first_name    text NOT NULL,
        suburb        text NOT NULL,
        permission    boolean NOT NULL,
        permission_at timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CHECK (permission = (permission_at IS NOT NULL))
      );
    `,
  },
  {
    version: 5,
    name: 'internal notes on orders (admin)',
    sql: `
      -- SCRUM-72 AC7: Attila's own notes on an order. Never shown to the customer, never sent to
      -- HubSpot. author is the Tailscale login that wrote it. Goes with the order.
      CREATE TABLE order_notes (
        id       bigserial PRIMARY KEY,
        order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        at       timestamptz NOT NULL DEFAULT now(),
        author   text NOT NULL,
        note     text NOT NULL
      );
      CREATE INDEX order_notes_order_idx ON order_notes (order_id, at);
      -- The automatic jobs (auto-complete, auto-lapse) look orders up by status and age.
      CREATE INDEX orders_status_idx ON orders (status, status_changed_at);
    `,
  },
  {
    version: 6,
    name: 'promise date on queued orders',
    sql: `
      -- SCRUM-73: "back in the post by", fixed when the order enters In queue (arrival + 10 NSW
      -- business days), so a later change to the holiday list never moves a promise already made.
      -- Orders queued before this migration have none; the service works it out from arrived_on.
      ALTER TABLE orders ADD COLUMN promise_on date;
    `,
  },
  {
    version: 7,
    name: 'review reminder sent (once per order)',
    sql: `
      -- SCRUM-80: when the one review reminder was queued. Set in the same transaction that queues
      -- it, so an order can never get a second one.
      ALTER TABLE orders ADD COLUMN review_reminder_at timestamptz;
    `,
  },
  {
    version: 8,
    name: 'retention: amounts, extensions, erasure, audit',
    sql: `
      -- SCRUM-75. The agreed price, set on Accepted, so a paid order's tax record keeps its amount
      -- even after erasure removes the paddle details. Orders accepted before this get paddles x A$60.
      ALTER TABLE orders ADD COLUMN amount_cents integer;
      UPDATE orders o SET amount_cents = (SELECT count(*) FROM paddles p WHERE p.order_id = o.id) * 6000
       WHERE o.amount_cents IS NULL
         AND EXISTS (SELECT 1 FROM status_history h WHERE h.order_id = o.id AND h.status = 'accepted');

      -- An extension holds an order back from every retention rule until this Sydney date (a dispute,
      -- say). It expires by itself: once the date has passed the rules apply again.
      ALTER TABLE orders ADD COLUMN retain_until date;
      ALTER TABLE orders ADD COLUMN retain_reason text;
      ALTER TABLE orders ADD COLUMN retain_set_at timestamptz;
      ALTER TABLE orders ADD CONSTRAINT orders_retain_both CHECK ((retain_until IS NULL) = (retain_reason IS NULL));

      -- Erasure on request kept only the tax minimum of this paid order (personal data is gone).
      ALTER TABLE orders ADD COLUMN erased_at timestamptz;

      -- What the daily job deleted, by rule: counts only, never who.
      CREATE TABLE retention_runs (
        id       bigserial PRIMARY KEY,
        at       timestamptz NOT NULL DEFAULT now(),
        rule     text NOT NULL,
        count    integer NOT NULL
      );
      CREATE INDEX retention_runs_at_idx ON retention_runs (at);

      -- Erasures on request: when, and what categories went. No email, name or reference.
      CREATE TABLE erasures (
        id               bigserial PRIMARY KEY,
        at               timestamptz NOT NULL DEFAULT now(),
        orders_deleted   integer NOT NULL,
        orders_minimised integer NOT NULL,
        categories       text NOT NULL,
        crm              text NOT NULL
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
