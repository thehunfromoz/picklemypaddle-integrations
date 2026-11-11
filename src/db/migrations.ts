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
  {
    version: 9,
    name: 'pricing: terms saved at Accept',
    sql: `
      -- SCRUM-81. What the customer was asked to pay, frozen at Accept: amount_cents (from
      -- SCRUM-75) stays the total; these say how it was made up and which terms applied. Changing a
      -- price, the postage table or the GST date never alters an order already accepted.
      ALTER TABLE orders ADD COLUMN subtotal_cents integer;
      ALTER TABLE orders ADD COLUMN discount_cents integer NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD COLUMN postage_cents integer;
      -- The calculated postage, and Attila's reason when he charged something else.
      ALTER TABLE orders ADD COLUMN postage_quoted_cents integer;
      ALTER TABLE orders ADD COLUMN postage_override_reason text;
      ALTER TABLE orders ADD COLUMN postage_detail text;
      ALTER TABLE orders ADD COLUMN gst_cents integer;
      ALTER TABLE orders ADD COLUMN tax_treatment text CHECK (tax_treatment IN ('not_registered', 'gst_inclusive'));
      ALTER TABLE orders ADD COLUMN terms_version text;
      ALTER TABLE orders ADD COLUMN terms_date date;

      -- Orders accepted before this: re-grit only, no postage recorded, not GST-registered.
      UPDATE orders SET subtotal_cents = amount_cents, postage_cents = 0, gst_cents = 0,
             tax_treatment = 'not_registered', terms_version = 'before-scrum-81'
       WHERE amount_cents IS NOT NULL;
    `,
  },
  {
    version: 10,
    name: 'discount codes',
    sql: `
      -- SCRUM-63. Codes Attila manages in admin; direct orders only, never off postage.
      CREATE TABLE discount_codes (
        id            bigserial PRIMARY KEY,
        code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$'),
        kind          text NOT NULL CHECK (kind IN ('free', 'amount', 'percent')),
        value         integer NOT NULL CHECK (value > 0),
        max_uses      integer NOT NULL CHECK (max_uses > 0),
        expires_on    date,
        one_per_email boolean NOT NULL DEFAULT true,
        note          text,
        active        boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now(),
        created_by    text,
        CHECK (kind <> 'percent' OR value <= 100)
      );

      -- One row per order that used a code: reserved at submit, consumed at Paid, released when the
      -- order is Rejected, Withdrawn or Lapsed unpaid. Only references are kept for Attila's list;
      -- the per-email rule reads the order itself, so a deleted order's use stops counting for its
      -- email (and, if still only reserved, stops counting at all).
      CREATE TABLE discount_uses (
        id          bigserial PRIMARY KEY,
        code_id     bigint NOT NULL REFERENCES discount_codes(id),
        order_id    uuid REFERENCES orders(id) ON DELETE SET NULL,
        reference   text NOT NULL,
        state       text NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
        reserved_at timestamptz NOT NULL,
        settled_at  timestamptz
      );
      CREATE INDEX discount_uses_code ON discount_uses (code_id, state);
      CREATE UNIQUE INDEX discount_uses_order ON discount_uses (order_id) WHERE order_id IS NOT NULL;

      -- What the code gave, saved on the order at submit, so changing or deactivating the code
      -- later never changes the order. discount_cents is the estimate until Accept fixes it.
      ALTER TABLE orders ADD COLUMN discount_code text;
      ALTER TABLE orders ADD COLUMN discount_kind text CHECK (discount_kind IN ('free', 'amount', 'percent'));
      ALTER TABLE orders ADD COLUMN discount_value integer;
    `,
  },
  {
    version: 11,
    name: 'stripe payments',
    sql: `
      -- SCRUM-82. Each Checkout Session made for an order (one per Pay now click); older open ones
      -- are expired when a new one is made.
      CREATE TABLE stripe_sessions (
        id           text PRIMARY KEY,
        order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        amount_cents integer NOT NULL,
        created_at   timestamptz NOT NULL,
        expires_at   timestamptz NOT NULL,
        expired_at   timestamptz
      );
      CREATE INDEX stripe_sessions_order ON stripe_sessions (order_id);

      -- One row per completed, paid Checkout Session, however it was recognised (return, webhook,
      -- poller): the unique session id makes applying it idempotent. problem is null when the
      -- payment moved the order to Paid; otherwise why it didn't (amount_mismatch, order_lapsed…),
      -- for Attila to sort out in the Stripe dashboard. No card details are ever stored.
      CREATE TABLE payments (
        id                  bigserial PRIMARY KEY,
        order_id            uuid REFERENCES orders(id) ON DELETE CASCADE,
        checkout_session_id text NOT NULL UNIQUE,
        payment_intent_id   text UNIQUE,
        amount_cents        integer NOT NULL,
        currency            text NOT NULL,
        fee_cents           integer,
        paid_at             timestamptz NOT NULL,
        recorded_at         timestamptz NOT NULL,
        source              text NOT NULL CHECK (source IN ('return', 'webhook', 'poller', 'test')),
        livemode            boolean NOT NULL,
        problem             text,
        refunded_cents      integer NOT NULL DEFAULT 0,
        refunded_at         timestamptz
      );
      CREATE INDEX payments_order ON payments (order_id);

      -- Stripe events already handled (webhook or poller), so each is applied once.
      CREATE TABLE stripe_events (
        id          text PRIMARY KEY,
        type        text NOT NULL,
        source      text NOT NULL,
        received_at timestamptz NOT NULL
      );

      -- Small bits of job state, e.g. the events poller's cursor.
      CREATE TABLE job_state (
        name       text PRIMARY KEY,
        value      text NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `,
  },
  {
    version: 12,
    name: 'unpaid orders: reminder, reinstated late payments',
    sql: `
      -- SCRUM-83. The one payment reminder (day 14), set when it is queued.
      ALTER TABLE orders ADD COLUMN payment_reminder_at timestamptz;
      -- A late payment Attila reinstated (the order moved to Paid): who and when.
      ALTER TABLE payments ADD COLUMN reinstated_at timestamptz;
      ALTER TABLE payments ADD COLUMN reinstated_by text;
    `,
  },
  {
    version: 13,
    name: 'documents: receipts, invoices, credit notes',
    sql: `
      -- SCRUM-84. One gapless sequence per series: INV for receipts and invoices, CN for credit
      -- notes. A number is taken by UPDATE … RETURNING inside the transaction that issues the
      -- document, so the row lock serialises issuers and a rollback gives the number back.
      CREATE TABLE document_counters (
        series text PRIMARY KEY CHECK (series IN ('INV', 'CN')),
        last   integer NOT NULL CHECK (last >= 0)
      );
      INSERT INTO document_counters (series, last) VALUES ('INV', 0), ('CN', 0);

      -- A document is a frozen snapshot: snapshot is canonical JSON text (byte-for-byte what was
      -- issued) and snapshot_sha256 its hash. Only the paid state may be added later, once.
      CREATE TABLE documents (
        id              bigserial PRIMARY KEY,
        number          text NOT NULL UNIQUE CHECK (number ~ '^PMP-(INV|CN)-[0-9]{4,}$'),
        kind            text NOT NULL CHECK (kind IN ('receipt', 'invoice', 'credit_note')),
        order_id        uuid REFERENCES orders(id) ON DELETE CASCADE,
        payment_id      bigint REFERENCES payments(id) ON DELETE SET NULL,
        refers_to       bigint REFERENCES documents(id) ON DELETE CASCADE,
        issued_on       date NOT NULL,
        issued_at       timestamptz NOT NULL,
        total_cents     integer NOT NULL CHECK (total_cents >= 0),
        gst_cents       integer NOT NULL CHECK (gst_cents >= 0),
        snapshot        text NOT NULL,
        snapshot_sha256 text NOT NULL,
        paid_on         date,
        paid_method     text,
        CHECK ((paid_on IS NULL) = (paid_method IS NULL))
      );
      CREATE INDEX documents_order ON documents (order_id);
      -- Exactly one receipt per payment, however many times Paid is recognised.
      CREATE UNIQUE INDEX documents_one_receipt ON documents (payment_id) WHERE kind = 'receipt';

      CREATE FUNCTION documents_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.issued_on IS DISTINCT FROM OLD.issued_on OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
           OR NEW.total_cents IS DISTINCT FROM OLD.total_cents OR NEW.gst_cents IS DISTINCT FROM OLD.gst_cents
           OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
           OR NEW.refers_to IS DISTINCT FROM OLD.refers_to THEN
          RAISE EXCEPTION 'documents are never edited after issue: issue a credit note instead';
        END IF;
        IF OLD.paid_on IS NOT NULL AND (NEW.paid_on IS DISTINCT FROM OLD.paid_on OR NEW.paid_method IS DISTINCT FROM OLD.paid_method) THEN
          RAISE EXCEPTION 'a document''s paid state is set once';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER documents_frozen BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION documents_frozen();
    `,
  },
  {
    version: 14,
    name: 'clubs, batches and club invoices',
    sql: `
      -- SCRUM-85. A club and its billing details. Club members' details are never held: the club
      -- keeps them. status already has room for SCRUM-10's pipeline (SCRUM-93); SCRUM-85 uses
      -- active and inactive only. is_test: made outside production.
      CREATE TABLE clubs (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name              text NOT NULL,
        billing_name      text NOT NULL,
        billing_email     text NOT NULL,
        billing_address   text NOT NULL,
        abn               text CHECK (abn ~ '^[0-9]{11}$'),
        notes             text,
        status            text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('lead', 'meeting', 'agreement_sent', 'active', 'inactive')),
        is_test           boolean NOT NULL,
        crm_company_id    text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX clubs_name_key ON clubs (lower(name));

      -- One visit's paddles. Collected → Returned → Invoiced → Paid, or Cancelled before return.
      -- unchanged_count: paddles returned without a re-grit (unsuitable on arrival), not charged.
      CREATE TABLE batches (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reference         text NOT NULL UNIQUE CHECK (reference ~ '^PMPB-[0-9A-Z]{5}$'),
        club_id           uuid NOT NULL REFERENCES clubs (id),
        status            text NOT NULL CHECK (status IN ('collected', 'returned', 'invoiced', 'paid', 'cancelled')),
        status_changed_at timestamptz NOT NULL DEFAULT now(),
        collected_on      date NOT NULL,
        paddle_count      integer NOT NULL CHECK (paddle_count BETWEEN 1 AND 500),
        returned_on       date,
        unchanged_count   integer NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0 AND unchanged_count <= paddle_count),
        notes             text,
        crm_deal_id       text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CHECK ((returned_on IS NULL) = (status IN ('collected', 'cancelled')))
      );
      CREATE INDEX batches_club_idx ON batches (club_id, collected_on);
      CREATE INDEX batches_status_idx ON batches (status);

      -- A club invoice belongs to its batch (and stays with it: a tax record, never cascaded away).
      ALTER TABLE documents ADD COLUMN batch_id uuid REFERENCES batches (id);
      ALTER TABLE documents ADD COLUMN due_on date;
      CREATE INDEX documents_batch ON documents (batch_id);
      CREATE UNIQUE INDEX documents_one_invoice_per_batch ON documents (batch_id) WHERE kind = 'invoice';

      -- Club emails are queued like order emails, against the batch (never both).
      ALTER TABLE outbox ADD COLUMN batch_id uuid REFERENCES batches (id) ON DELETE CASCADE;
      ALTER TABLE outbox ADD CONSTRAINT outbox_one_owner CHECK (order_id IS NULL OR batch_id IS NULL);
      CREATE INDEX outbox_batch_idx ON outbox (batch_id, created_at);

      -- The private link in a club invoice email, minted per send like order status tokens:
      -- only a SHA-256 of each token is kept.
      CREATE TABLE document_tokens (
        id          bigserial PRIMARY KEY,
        document_id bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        token_hash  bytea NOT NULL UNIQUE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        revoked_at  timestamptz
      );
      CREATE INDEX document_tokens_document_idx ON document_tokens (document_id);

      -- The new columns are part of the document as issued, so they are frozen too.
      CREATE OR REPLACE FUNCTION documents_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.issued_on IS DISTINCT FROM OLD.issued_on OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
           OR NEW.total_cents IS DISTINCT FROM OLD.total_cents OR NEW.gst_cents IS DISTINCT FROM OLD.gst_cents
           OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
           OR NEW.refers_to IS DISTINCT FROM OLD.refers_to
           OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.due_on IS DISTINCT FROM OLD.due_on THEN
          RAISE EXCEPTION 'documents are never edited after issue: issue a credit note instead';
        END IF;
        IF OLD.paid_on IS NOT NULL AND (NEW.paid_on IS DISTINCT FROM OLD.paid_on OR NEW.paid_method IS DISTINCT FROM OLD.paid_method) THEN
          RAISE EXCEPTION 'a document''s paid state is set once';
        END IF;
        RETURN NEW;
      END
      $$;
    `,
  },
  {
    version: 15,
    name: 'club invoice payments',
    sql: `
      -- SCRUM-85 (part 2). Every payment against a club invoice: PayID or cash recorded by hand,
      -- or a card payment through Stripe Checkout (payment_id). Part payments are fine; the invoice
      -- and its batch are Paid once the payments reach the invoice's total.
      CREATE TABLE club_payments (
        id           bigserial PRIMARY KEY,
        document_id  bigint NOT NULL REFERENCES documents (id),
        method       text NOT NULL CHECK (method IN ('payid', 'cash', 'card')),
        amount_cents integer NOT NULL CHECK (amount_cents > 0),
        paid_on      date NOT NULL,
        reference    text,
        payment_id   bigint UNIQUE REFERENCES payments (id),
        recorded_at  timestamptz NOT NULL,
        recorded_by  text NOT NULL,
        CHECK ((method = 'card') = (payment_id IS NOT NULL))
      );
      CREATE INDEX club_payments_document_idx ON club_payments (document_id);

      -- Card payments for club invoices use the same Stripe tables as orders, against the invoice.
      ALTER TABLE stripe_sessions ALTER COLUMN order_id DROP NOT NULL;
      ALTER TABLE stripe_sessions ADD COLUMN document_id bigint REFERENCES documents (id);
      ALTER TABLE stripe_sessions ADD CONSTRAINT stripe_sessions_one_owner CHECK ((order_id IS NULL) <> (document_id IS NULL));
      CREATE INDEX stripe_sessions_document ON stripe_sessions (document_id);
      ALTER TABLE payments ADD COLUMN document_id bigint REFERENCES documents (id);
      ALTER TABLE payments ADD CONSTRAINT payments_one_owner CHECK (order_id IS NULL OR document_id IS NULL);
    `,
  },
  {
    version: 16,
    name: 'club HubSpot sync',
    sql: `
      -- SCRUM-85 AC8: a club is a HubSpot company (with its billing contact) and each batch a deal.
      -- One CRM job per club syncs all of it; at most one waits per club, like orders.
      ALTER TABLE clubs ADD COLUMN crm_contact_id text;
      ALTER TABLE outbox ADD COLUMN club_id uuid REFERENCES clubs (id) ON DELETE CASCADE;
      ALTER TABLE outbox ADD CONSTRAINT outbox_club_alone CHECK (club_id IS NULL OR (order_id IS NULL AND batch_id IS NULL));
      CREATE UNIQUE INDEX outbox_crm_club_pending_key ON outbox (club_id) WHERE kind = 'crm' AND state = 'pending';
    `,
  },
  {
    version: 17,
    name: 'club leads',
    sql: `
      -- SCRUM-93. A lead is a club record before it is a customer (status lead, meeting,
      -- agreement_sent), so the billing details are only required from Active on. A club's
      -- members' details are never held: only the one contact who writes to us, and what they
      -- tell us about the club. Existing clubs are all Active and are untouched.
      ALTER TABLE clubs ALTER COLUMN billing_name DROP NOT NULL;
      ALTER TABLE clubs ALTER COLUMN billing_email DROP NOT NULL;
      ALTER TABLE clubs ALTER COLUMN billing_address DROP NOT NULL;
      -- Only an Active club needs them: a lead that is not going ahead is Inactive without any.
      ALTER TABLE clubs ADD CONSTRAINT clubs_billing_when_active CHECK (
        status <> 'active'
        OR (billing_name IS NOT NULL AND billing_email IS NOT NULL AND billing_address IS NOT NULL)
      );
      ALTER TABLE clubs ADD COLUMN suburb text;
      ALTER TABLE clubs ADD COLUMN contact_name text;
      ALTER TABLE clubs ADD COLUMN contact_email text;
      ALTER TABLE clubs ADD COLUMN contact_phone text;
      ALTER TABLE clubs ADD COLUMN club_size integer CHECK (club_size BETWEEN 1 AND 100000);
      ALTER TABLE clubs ADD COLUMN lead_message text;
      ALTER TABLE clubs ADD COLUMN preferred_times text;
      ALTER TABLE clubs ADD COLUMN meeting_on date;
      -- The last time anyone did anything with the club: a lead that never becomes Active is
      -- deleted 12 months after it (the retention job).
      ALTER TABLE clubs ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
      UPDATE clubs SET last_activity_at = updated_at;
    `,
  },
  {
    version: 18,
    name: 'club agreements',
    sql: `
      -- SCRUM-94. One row per club per agreement version: when it was emailed (and what the
      -- text's hash was then), and, once Attila records the "I agree" reply, who accepted it and
      -- when. A club's accepted version is the highest one accepted; a newer version sent to an
      -- Active club leaves the old one on record until it is accepted.
      CREATE TABLE club_agreements (
        id                   bigserial PRIMARY KEY,
        club_id              uuid NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
        version              integer NOT NULL CHECK (version >= 1),
        sha256               text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        sent_at              timestamptz NOT NULL,
        sent_to              text NOT NULL,
        schedule             jsonb NOT NULL,
        accepted_on          date,
        accepted_by          text CHECK (accepted_by IS NULL OR char_length(accepted_by) BETWEEN 1 AND 120),
        accepted_note        text CHECK (accepted_note IS NULL OR char_length(accepted_note) <= 1000),
        accepted_recorded_at timestamptz,
        UNIQUE (club_id, version),
        CHECK ((accepted_on IS NULL) = (accepted_by IS NULL) AND (accepted_on IS NULL) = (accepted_recorded_at IS NULL))
      );

      -- What was sent is never changed: the text (its hash), the version and the first send's date
      -- are frozen, and so is everything once the club has accepted. Until then a re-send to a
      -- corrected address may update who it went to and the Schedule it showed. The acceptance is
      -- filled in once.
      CREATE OR REPLACE FUNCTION club_agreements_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.version IS DISTINCT FROM OLD.version
           OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
          RAISE EXCEPTION 'a sent agreement is never edited: send a new version';
        END IF;
        IF OLD.accepted_on IS NOT NULL AND (NEW.sent_to IS DISTINCT FROM OLD.sent_to OR NEW.schedule IS DISTINCT FROM OLD.schedule) THEN
          RAISE EXCEPTION 'an accepted agreement is never edited: send a new version';
        END IF;
        IF OLD.accepted_on IS NOT NULL AND (NEW.accepted_on IS DISTINCT FROM OLD.accepted_on
           OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by OR NEW.accepted_note IS DISTINCT FROM OLD.accepted_note) THEN
          RAISE EXCEPTION 'an acceptance is recorded once';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER club_agreements_frozen BEFORE UPDATE ON club_agreements
        FOR EACH ROW EXECUTE FUNCTION club_agreements_frozen();

      -- The private link in the agreement email (the printable page): only a hash of each token is kept.
      CREATE TABLE club_agreement_tokens (
        id           bigserial PRIMARY KEY,
        agreement_id bigint NOT NULL REFERENCES club_agreements (id) ON DELETE CASCADE,
        token_hash   bytea NOT NULL UNIQUE,
        created_at   timestamptz NOT NULL DEFAULT now(),
        revoked_at   timestamptz
      );
      CREATE INDEX club_agreement_tokens_agreement_idx ON club_agreement_tokens (agreement_id);
    `,
  },
  {
    version: 19,
    name: 'club postage and meeting time',
    sql: `
      -- SCRUM-96/94 UAT (10 Nov 2026): a club can post its paddles instead of waiting for a pickup.
      -- collected_on stays the day the batch came into our hands (picked up, or received by post).
      ALTER TABLE batches ADD COLUMN method text NOT NULL DEFAULT 'pickup' CHECK (method IN ('pickup', 'post'));
      ALTER TABLE batches ADD COLUMN inbound_tracking text CHECK (length(inbound_tracking) <= 60);
      ALTER TABLE batches ADD COLUMN return_tracking text CHECK (length(return_tracking) <= 60);
      -- A meeting's time of day and length are optional, and set after the date.
      ALTER TABLE clubs ADD COLUMN meeting_time text CHECK (meeting_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
      ALTER TABLE clubs ADD COLUMN meeting_minutes integer CHECK (meeting_minutes BETWEEN 5 AND 480);
      ALTER TABLE clubs ADD CONSTRAINT clubs_meeting_time_needs_date CHECK (meeting_on IS NOT NULL OR (meeting_time IS NULL AND meeting_minutes IS NULL));
    `,
  },
  {
    version: 20,
    name: 'club service area',
    sql: `
      -- SCRUM-102. The venue's postcode (the suburb column is the venue suburb), the method the service
      -- area gave it (local pickup or post) with the list version used, any admin override (and when),
      -- and whether the suburb matched with a different postcode (look at it).
      ALTER TABLE clubs ADD COLUMN venue_postcode text CHECK (venue_postcode ~ '^[0-9]{4}$');
      ALTER TABLE clubs ADD COLUMN fulfilment_default text CHECK (fulfilment_default IN ('local', 'postal'));
      ALTER TABLE clubs ADD COLUMN fulfilment_override text CHECK (fulfilment_override IN ('local', 'postal'));
      ALTER TABLE clubs ADD COLUMN fulfilment_override_at timestamptz;
      ALTER TABLE clubs ADD COLUMN area_version text;
      ALTER TABLE clubs ADD COLUMN area_review boolean NOT NULL DEFAULT false;
      ALTER TABLE clubs ADD CONSTRAINT clubs_override_recorded CHECK ((fulfilment_override IS NULL) = (fulfilment_override_at IS NULL));
    `,
  },
  {
    version: 21,
    name: 'club payment before return',
    sql: `
      -- SCRUM-102 UAT (11 Nov 2026): a club pays before its batch goes back. The order is now
      -- Collected, Invoiced, Paid, Returned (a batch with nothing to invoice goes Collected to Returned).
      -- So an invoiced or paid batch has no return date yet; older ones keep theirs. A returned batch has one.
      DO $do$
      DECLARE c text;
      BEGIN
        SELECT conname INTO c FROM pg_constraint
         WHERE conrelid = 'batches'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%returned_on IS NULL%';
        IF c IS NOT NULL THEN EXECUTE 'ALTER TABLE batches DROP CONSTRAINT ' || quote_ident(c); END IF;
      END
      $do$;
      ALTER TABLE batches ADD CONSTRAINT batches_return_date CHECK (
        (status = 'returned' AND returned_on IS NOT NULL) OR (status IN ('collected', 'cancelled') AND returned_on IS NULL) OR status IN ('invoiced', 'paid')
      );
    `,
  },
  {
    version: 22,
    name: 'order artwork acknowledgement',
    sql: `
      -- SCRUM-104: the customer accepts that the black re-grit hides logos and artwork on the paddle faces.
      -- Nullable: orders made before this had no such tick-box. Not personal data, so erasure keeps it.
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS artwork_ack_at timestamptz;
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
