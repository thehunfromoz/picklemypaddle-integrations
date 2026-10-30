# picklemypaddle-integrations

Small service behind the Pickle My Paddle website. Jira epics: SCRUM-8 (orders and CRM),
SCRUM-9 (payments), SCRUM-10 (clubs).

Planned responsibilities:

- Receive order submissions (details + front/back paddle photos), validate and store them.
- Private status links for customers and clubs.
- Adapters, so each vendor can be swapped without touching the site:
  - CRM: HubSpot first
  - Payments: Stripe (payment links, invoices, webhooks)
  - Scheduling: HubSpot Meetings
- HubSpot properties/pipelines and Stripe products kept as configuration-as-code.

**Status:** order intake (SCRUM-8 part 1), order emails (SCRUM-69), the HubSpot mirror
(SCRUM-74), reviews (SCRUM-33), the order admin over Tailscale (SCRUM-71/72) and the queue with
NSW holidays (SCRUM-73). Retention (SCRUM-75) comes next.

## Stack

TypeScript on Node 22, [Hono](https://hono.dev) for HTTP, [zod](https://zod.dev) to validate
settings, Vitest for tests, pnpm. Same toolchain as the site.

## Run it on your Mac

```bash
corepack enable
pnpm install
cp .env.example .env      # local settings; .env is git-ignored
# a local Postgres for pnpm dev (tests don't need one):
docker run -d --name pmp-pg -p 5432:5432 -e POSTGRES_USER=pmp -e POSTGRES_PASSWORD=pmp -e POSTGRES_DB=pmp postgres:18-alpine
pnpm dev                  # http://localhost:8080/healthz
pnpm test                 # all tests, on PGlite
```

## Order API (SCRUM-65 to 67, SCRUM-70)

Served behind the gateway at `/api/*`, on the same origin as the site. Every answer from
`/api/orders*` is `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

### `GET /api/orders/form`

`200 { open: true, formToken }`. The site calls it when the order form loads. The token is the
signed load time (minimum fill time, below), and a failed call tells the site that ordering is
closed (production answers `503` until it is switched on, see the infra production runbook).

### `POST /api/orders`

`multipart/form-data`, exactly as the site's form sends it:

| Field | Notes |
| --- | --- |
| `name`, `email`, `phone` (optional), `street`, `suburb`, `state`, `postcode` | rules in `src/orders/rules.ts` |
| `consent`, `tournamentAck` | must both be `yes`; stored with timestamps |
| `paddles[i][brand]`, `paddles[i][model]` (optional), `paddles[i][front]`, `paddles[i][back]` | 1 to 10 paddles; `i` is the form's stable index and may have gaps, positions follow its order |
| `formToken` | from `GET /api/orders/form` |
| `idempotencyKey` | 16 to 64 of `A-Z a-z 0-9 _ -`, one per submission (see below) |
| `website` | the honeypot: always empty from a person |

| Answer | When |
| --- | --- |
| `201 { reference, statusToken, test? }` | stored, status **Submitted**. `reference` is `PMP-` + 5 characters with no 0/O, 1/I/L. `statusToken` opens `/order/status#<token>` (only its SHA-256 is stored). `test: true` outside production. Nothing personal is returned. |
| `400 { errors: { <field key>: message } }` | invalid details or photos. Keys match the form's: `email`, `paddles.0.front`, … Nothing is stored. `errors.form` means reload the page (missing, forged or day-old form token). |
| `413` | body over 60 MB, refused from `Content-Length` or while streaming |
| `415` | not `multipart/form-data` |
| `429 { message, retryAfter }` + `Retry-After` | a rate limit was hit |

**Idempotent:** a repeat with the same `idempotencyKey` within 24 hours answers with the original
reference (and a fresh status link to it) and creates nothing (double taps, flaky mobile
connections). **All or nothing:** the order, paddles, photos, first status and status token are
written in one transaction; photo files written before a failure are deleted again.

**Shared rules:** `src/orders/rules.ts` is the original; the site carries a byte-identical copy
(`src/lib/order-rules.ts`) and its unit tests fail if the two differ. Change it here first.

### `POST /api/orders/status`

JSON `{ token }`. `200` with the minimal view (reference, status in plain words, dated history,
paddles by brand and model, tracking number once posted back, `backInPostBy` (YYYY-MM-DD, In
queue and Re-gritted) and `paddlesAhead` (In queue), `test`), never name, address, phone, email or
photos. `queuePosition` is always null (reserved before SCRUM-73; kept for older site builds). Unknown, malformed, revoked and expired links all get the same `404`.
Links stop 90 days after **Completed**, 30 days after **Rejected** or **Lapsed**, and at once when
**Withdrawn** or deleted.

### `POST /api/orders/links`

JSON `{ email }`. Always `202` with the same message, whatever the address. With an email service
(SCRUM-69) it sends one email with a fresh link per live order and only then revokes the old
links. Until then it changes nothing, so no working link is ever lost.

### Photos (SCRUM-66)

- 10 MB per photo, 60 MB per request (the site shrinks photos to 2560 px before sending).
- The type is decided from the file's first bytes: JPEG, PNG or WebP only (HEIC is left to iOS).
- Each photo is decoded (at most 100 megapixels, checked from the header before decoding, and
  20 seconds) and re-encoded to a JPEG of at most 2560 px, upright, transparency on white, with
  **all** metadata removed (EXIF incl. GPS, XMP, IPTC, ICC).
- **Engine (`IMAGE_ENGINE`):** the image uses the **libvips command-line tools** from Alpine
  (`vips`). Alpine builds them for the baseline x86-64 CPU, so they run on home-server, whose
  processor predates x86-64-v2 (no SSE4.2). sharp's prebuilt binaries need x86-64-v2 and crashed
  the service there on 26 Oct 2026, so **sharp is a development dependency only** and is never in
  the image. On a Mac, `auto` uses the libvips tools if installed (`brew install vips`), otherwise
  sharp. The tests run every photo case against each engine available; CI installs the libvips
  tools and requires them (`REQUIRE_VIPS=1`).
- **Don't add native modules that need a newer CPU.** The container test starts the image under
  an emulated Core 2 (Penryn) CPU, home-server's class, and places an order through it.
- Only the re-encoded copy is written, under a random name in `PHOTO_DIR`, a private volume that
  nothing serves. The database keeps the path, size and dimensions, never the image.

### Abuse limits (SCRUM-67)

| Control | Default |
| --- | --- |
| Honeypot field filled, or submitted under `ORDER_MIN_FILL_SECONDS` (3) after the form loaded | normal-looking `201`, nothing stored, counted in the logs |
| Orders per IP | 5 per hour (`ORDER_LIMIT_PER_IP_HOUR`) |
| Orders per email address | 3 per 24 hours (`ORDER_LIMIT_PER_EMAIL_DAY`) |
| "Email me my links" | 3 per address per day, 10 per IP per hour |
| Request timeout | 120 s |

The client IP is the socket peer, or the right-most `X-Forwarded-For` entry when the peer is in
`TRUSTED_PROXIES` (the gateway). Counts live in Postgres, so restarts don't reset them, and are
kept two days. Only salted hashes of IPs and emails are stored or logged. Staging may raise the
per-IP limit for its smoke traffic; **production refuses to start with any limit relaxed.**

### Smoke-test orders

Outside production, orders from `@example.com` addresses are smoke tests (SCRUM-68): stored like
any other, and deleted with their photos after 24 hours.

## Reviews (SCRUM-33, decided 28 Oct 2026)

The Posted back email asks for a short review and links to a form on the private status page
(`?review=1`). `POST /api/orders/review { token, quote, firstName, suburb, permission }` takes one
review per order, only with a live link and once the order is Posted back or Completed (the status
view's `review` field says `open` or `received`). `permission` must be an explicit true or false,
and is stored with its time; reviews without it stay private. First name and suburb are typed by
the customer, not pre-filled, because the status page never shows a name or address. Attila's
alert includes the review only when it may be quoted. Publishing is by hand: approved ones go into
the site's `src/data/testimonials.json` by pull request. Rate-limited per IP like the links form.

**One reminder (SCRUM-80, decided 29 Oct 2026).** The Posted back email's ask arrives before the
customer has played with the paddle, so the daily job sends **one** `review_reminder` email 10 days
after Posted back if no review has come in: only for orders that were posted back (Posted back or
Completed), never for smoke orders, and never twice (`orders.review_reminder_at` is set in the same
transaction that queues it). It carries a fresh status link to the form and says it is the only
reminder. On staging, the admin's **Send review reminder now (test)** sends it without waiting (no
such button or route in production). The admin marks reviewed orders ("Reviewed", or "Reviewed
(private)" without permission to quote), and HubSpot gets the same flag (below).

## Order statuses (SCRUM-72, decided 26 Oct 2026)

Submitted → Questions → Accepted → Paid → In queue → Re-gritted → Posted back → Completed, plus the
end states Rejected, Withdrawn and Lapsed. `src/orders/transitions.ts` holds the only allowed moves
and who may make each (admin, Stripe, or the automatic jobs); anything else is refused with 409.
Rejected needs a reason (sent to the customer) and Posted back a tracking number (400 without).
Outside production, admin may also mark an Accepted order paid ("Mark paid (test)"). Every change
writes a history row with who made it, and queues its email in the same transaction.

| From | To (by) | Email to the customer |
| --- | --- | --- |
| Submitted | Questions, Accepted, Rejected, Withdrawn (admin) | Accepted (re-grit, postage, total, GST line), Rejected (reason) |
| Questions | Accepted, Rejected, Withdrawn (admin); Lapsed (automatic, 30 days) | as above |
| Accepted | Paid (Stripe, SCRUM-9; "Mark paid (test)" outside production); Withdrawn (admin); Lapsed (SCRUM-9) | |
| Paid | In queue (admin, records the arrival day); Withdrawn (admin) | In queue ("back in the post by") |
| In queue | Re-gritted (admin) | |
| Re-gritted | Posted back (admin, tracking number required) | Posted back (tracking, review link) |
| Posted back | Completed (admin, or automatic after 10 days) | |

Questions sends nothing: Attila writes to the customer himself from info@.

**Queue and promise (SCRUM-73).** When an order enters In queue, its promise date is stored:
arrival + 10 business days, skipping weekends and NSW public holidays (`src/orders/holidays.ts`,
from nsw.gov.au; the August Bank Holiday is a working day). The In queue email, the status page
("back in the post by", In queue and Re-gritted) and the admin all show that same date; the admin
flags it within 2 business days and once past. The status page also shows the paddles ahead in
the queue (In queue only): orders that arrived earlier, ties by reference, TEST orders counted
only among TEST orders. **Each year, add the next year's holidays** once NSW publishes them:
`tests/holidays.test.ts` fails from the day the list no longer covers the next 12 months. The automatic moves
(`src/orders/auto.ts`) run once a day, are idempotent, and are recorded as "system".

## Prices, postage and GST (SCRUM-81, decided 30 Oct 2026)

`src/pricing/` answers "what are the terms on this Sydney day?": A$60 a paddle (A$54 for clubs),
whether GST applies, and the return postage. **At Accept the order saves its terms**: re-grit,
discount (SCRUM-63), postage, total (`amount_cents`), GST included, the tax treatment and a terms
version. Later price, postage or GST changes never alter an accepted order, and the email, the
admin and HubSpot all show the saved figures.

- **Prices** live in `src/pricing/terms.ts` (`PRICE_LISTS`, dated). To change a price, add an entry
  dated from the change; never edit an old one.
- **GST:** `GST_REGISTERED_FROM` (a date, empty = not registered) and `BUSINESS_ABN`. Before the
  date, documents say "Invoice" and "No GST has been charged". From it, A$60 *includes* GST
  (A$5.45; GST = total ÷ 11 to the nearest cent) and documents become "Tax invoice". The issue
  date decides. Production needs the ABN once Stripe or GST is set up; staging may try a GST date
  without one.
- **Postage** is worked out from size and weight (`src/pricing/postage.ts`, data in
  `postage-data.ts`): the packing for the paddle count (a padded bag for 1–2, a box for 3–10), its
  size and weight, the **greater of actual and cubic weight** (m³ × 250; the table's `basis` can
  switch to actual weight only), then Australia Post Parcel Post from Sydney (one national price
  up to 5 kg; over 5 kg by the destination zone from the return postcode), plus the packaging cost.
  Australia Post changes prices each July: **add a new dated table then**. The admin's Accept form
  shows the working and fills in the amount; a different amount needs a reason, which goes in the
  history. When nothing can be calculated (a postcode outside the zone table and over 5 kg, or more
  than 10 paddles), Accept needs the amount and a reason.
- **`GET /api/pricing`** (public, cached 1 h) gives the website today's price, GST wording and
  postage per paddle count, so the wording changes on the GST date without a rebuild.

## Order admin (SCRUM-71/72)

Attila works orders here; HubSpot only mirrors it. The admin is **never on the public internet**:

- It has **its own listener**, `ADMIN_PORT` (8081). The public app (`PORT`, 8080) has no admin
  routes, so `/admin` through the public gateway is a 404 whatever headers it carries.
- In the stacks, only the gateway's admin listener reaches it, over a private Docker network, and
  that listener is published on the host's loopback only, for **Tailscale Serve** (never Funnel):
  `tailnet device → Tailscale Serve (HTTPS) → 127.0.0.1 → gateway → integrations:8081`.
- **Identity:** Tailscale Serve strips any `Tailscale-User-*` headers a client sends and adds the
  signed-in user's. The admin believes them only from `ADMIN_TRUSTED_PROXIES` (the gateway's
  `admin-gateway` alias; this machine by default) and lets in only the logins in `ADMIN_LOGINS`
  (403 otherwise; 503 while the list is empty). Tagged devices have no login, so they can't get in.
- **Forgery and caching:** every form carries a CSRF token (an HMAC of the login under a key kept
  in the database), POSTs must be same-origin (`Sec-Fetch-Site`, or `Origin` matching `Host`), and
  every response is `no-store`, `X-Frame-Options: DENY`, with a CSP that allows no scripts at all
  and `frame-ancestors 'none'`.

Pages (plain HTML forms, no JavaScript, made for a phone):

| Path | What |
| --- | --- |
| `GET /admin/orders?status=…` | The list. Default: waiting on Attila (Submitted, Questions, Paid, In queue, Re-gritted). Reference, date, paddles, days in status, TEST orders marked, and a flag once a Submitted order is past the 1-business-day reply promise. |
| `GET /admin/orders/:ref` | The order: customer, return address, front/back photos, the next allowed moves, notes, history, the emails and HubSpot syncs (with Retry for failed ones), and the review if one was left. |
| `POST /admin/orders/:ref/status` | A move (`to`, plus `reason`, `trackingNumber`, `arrivedOn`, `amount`, `note`). 400 for a missing reason or tracking number, 409 for a move the table doesn't allow. |
| `POST /admin/orders/:ref/mark-paid-test` | Outside production only (404 in production, and no button). |
| `POST /admin/orders/:ref/notes` | An internal note: never shown to the customer, never sent to HubSpot. |
| `POST /admin/outbox/:id/retry` | Queue a failed email or HubSpot sync again. |
| `GET /admin/photos/:id` | A paddle photo, only through the admin, `no-store`. |

Smoke-test orders never appear. Locally: set `ADMIN_LOGINS` in `.env`, run `pnpm dev`, and send
the header yourself, e.g. `curl -H 'Tailscale-User-Login: you@example.com' localhost:8081/admin/orders`
(a browser extension that adds the header works too).

`pnpm test:e2e` walks an order from Submitted to Completed in Chromium, at desktop and phone sizes,
against `tests/e2e/server.ts` (the admin over PGlite, with the identity headers added by
Playwright). CI runs it; `pnpm exec playwright install chromium` first on your Mac.

## Order emails (SCRUM-69)

Sent through Resend behind an `EmailSender` interface (`src/email/sender.ts`), From
`sales@picklemypaddle.com`, Reply-To `info@`. Customers get an email at the key moments only:
Submitted, Accepted, In queue, Posted back and Rejected (Questions are written by hand from info@).
Attila's new-order alert goes to sales@ and holds only the reference, paddle count and admin link.

- **Outbox:** emails are queued in the database in the same transaction as the order or status
  change, and a worker in the service sends them every 10 seconds, retrying after 1, 5 and 15 min,
  1, 3, 6 and 12 h. Then the email is `failed` (shown on the admin page, with a retry). A Resend
  outage never fails an order. A rejected request (bad key, invalid address) fails at once.
- **No tokens at rest:** emails are rendered when sent, and each email with a status link mints
  its own token for that send; only hashes are stored.
- **Outside production** mail reaches only `EMAIL_ALLOWLIST` (plus-addressing allowed); everything
  else is recorded as `suppressed`. Subjects start `[TEST]` and a banner says it's a test order.
  Smoke-test orders send nothing. Without `RESEND_API_KEY` (your Mac) nothing leaves at all.
- **Templates** (`src/email/templates.ts`) are written once and rendered as plain text and simple
  HTML (no remote images or tracking). `pnpm preview:emails` writes every template to
  `.email-previews/`; snapshot tests catch any unreviewed change. Facts not yet known are
  `[To confirm: …]`, and **production refuses to start while any remain**.

## HubSpot mirror (SCRUM-74)

A one-way copy of orders in HubSpot, so Attila gets a pipeline view and customer records; the
database stays the master and edits made in HubSpot are overwritten. Behind a `CrmAdapter`
interface (`src/crm/crm.ts`), with the HubSpot implementation in `src/crm/hubspot.ts`.

- **What goes across:** a contact (by email: first and last name, email, phone, suburb, state,
  postcode) and one deal per order (name = reference, `[TEST] ` prefixed outside production;
  amount = paddles × A$60; properties `pmp_reference`, `pmp_paddle_count`, `pmp_is_test`,
  `pmp_reviewed`), whose stage mirrors the order status 1:1 in the default pipeline. The contact
  also gets `pmp_has_reviewed`: yes once any of that customer's orders has a review (SCRUM-80; a
  later discount for reviewers can key on it). A review queues a sync, so both flags follow. **Never** the street address,
  photos, paddle details or a status-link token; a test checks every request.
- **Sync:** every order and status change queues a `crm` job in the outbox (one waiting job per
  order at most), which the service runs every 30 s with the email backoff. HubSpot being down
  never blocks an order. Record IDs are kept on the order; a deal deleted in HubSpot is found
  again by reference or recreated.
- **Test portal only outside production:** `HUBSPOT_PORTAL_ID` must equal `HUBSPOT_TEST_PORTAL_ID`
  or the service won't start, and before its first write the worker checks the key really
  belongs to that portal (`portal_mismatch` otherwise, and nothing is written).
- **Setup as code:** `node dist/cli/hubspot-setup.js --dry-run` shows what it would change (the
  property group and properties on deals and contacts, and the 11 stages); without `--dry-run` it
  applies them, idempotently. Stages that aren't ours are listed and left alone.
- **Resync:** `node dist/cli/crm-resync.js` queues every order (after an outage, or when
  production moves to its own portal).

## Retention and erasure (SCRUM-75)

What the privacy policy promises about keeping data, done by the service itself.

**The daily job** (`src/orders/retention.ts`, in the service's daily jobs). Each rule counts from
the Sydney day the order reached the status it starts from:

| Rule | When | What goes |
| --- | --- | --- |
| photos | 12 months after Completed | the paddle photos (files and rows); the order stays |
| enquiries | 12 months after Rejected, Withdrawn or Lapsed, never paid | the whole order, its HubSpot deal, and its contact if the customer has no other order |
| paid | 5 years after a paid order's end status (Completed, or Withdrawn after paying) | the whole order, the tax record included |

The ATO's 5 years run from when a record was made or the transaction completed, whichever is
later (checked 30 Oct 2026); nothing ties them to the financial year. Open orders are never
touched. Smoke-test orders go 24 hours after they're placed; Attila's own TEST orders follow the
rules above (decided 30 Oct 2026). HubSpot is cleaned up before the rows go; if it can't be
reached the order waits for the next run. Each run writes its counts to `retention_runs` and the
log, never who.

**Extensions.** From an order's page Attila can keep it longer (a date after today, at most 5
years on, and a reason such as a dispute). Every rule waits until after that date, then applies
again. The admin's **Retention** page lists what is due in the next 14 days by rule, the
extensions in force, the recent runs and the erasures.

**Erasure on request** (`src/orders/erasure.ts`; admin → Retention → Erase a customer). By email
address, with a preview of exactly what goes and a ticked confirmation:

- never-paid orders are deleted entirely;
- paid orders inside their 5 years keep only the reference, name, dates, statuses and amount
  (`orders.amount_cents`, set on Accepted; the payment reference arrives with SCRUM-9). Photos,
  email, phone, return address, paddle details, the review, internal notes, history notes,
  status links and queued emails go now, and the paid rule removes the rest later;
- HubSpot first: the contact is GDPR-deleted (permanent; found by email if its ID wasn't stored),
  deals are deleted, or stripped to reference and amount for kept orders. If HubSpot fails,
  nothing is erased. Erased orders are never synced again;
- refused while any of the customer's orders is still open (it would lose the return address);
- an `erasures` row records when, the counts and the categories, never who.

Gmail and Resend are outside the service: infra `runbooks/deletion.md`.

**Commands** (from `/opt/picklemypaddle/staging`, with `sudo docker compose -f compose.staging.yml exec integrations`):

- `node dist/cli/retention-run.js --dry-run` lists what is due now and in the next 14 days;
  without `--dry-run` it runs the job now.
- `node dist/cli/backdate-order.js PMP-XXXXX 13` (**test only**: refused in production and for
  non-TEST orders) moves every date on a TEST order back 13 months, to see a rule work.

## Database (SCRUM-64)

PostgreSQL 18, one server per app, never shared. `DATABASE_URL` is required and secret. Versioned
migrations (`src/db/migrations.ts`) run on startup before the service listens; a failure exits,
so the container never becomes healthy and staging rolls back. Migrations are additive only.

Tests run on PGlite (Postgres in WebAssembly, in-process) locally, and on a real Postgres 18 in
CI's container test, which leaves a "database tests ran on real Postgres" annotation. To run
them against your own Postgres: `TEST_DATABASE_URL=postgres://… pnpm test` (each test gets its
own schema, dropped afterwards).

## Logs

One JSON line per event, with references, counts, timings and hash prefixes only: never names,
emails, addresses, phone numbers or raw IPs. Errors are logged as type, code and stack frames,
because library messages can quote input values. A test checks this across the order flow.

## Settings and secrets (SCRUM-18)

All settings come from environment variables; see `.env.example` for the full list.

| Where | Values come from |
| --- | --- |
| Your Mac | `.env` (git-ignored), copied from `.env.example` |
| Staging (home-server) | `/etc/picklemypaddle/integrations.env`, root-only (`picklemypaddle-infra` runbook) |
| Production (OVH, later) | the same pattern on the OVH server |

- **Refuses to start** if a required setting is missing or invalid. The error names every
  problem setting, never its value, and the exit code is 78.
- **Stripe keys must be test-mode (`sk_test_…`) outside production.** A live key on dev or
  staging stops the service, so staging can never charge a real card. A test key in production
  stops it too.
- **HubSpot** uses a separate test portal outside production.
- **GST and ABN** (SCRUM-81): a bad `GST_REGISTERED_FROM` date or an ABN that fails the ATO
  checksum stops the service.
- **Email:** outside production the service won't start without `EMAIL_ALLOWLIST`; in production
  it needs `RESEND_API_KEY` and ignores any allow-list. The allow-list is logged only as a count.
- Secret values are never logged. Startup logs show them only as `[set]`.
- The website only ever gets public values, such as the HubSpot portal ID. Private tokens stay
  in this service.

## CI

Every PR runs type-check, unit tests, build, the admin walk-through in Chromium (`test:e2e`) and a
gitleaks secret scan. CI also builds the
Docker image and, beside a real Postgres 18, checks that it:
- refuses to start without settings and names them (`DATABASE_URL` included);
- refuses a live Stripe key on staging, and an invalid `DATABASE_URL`, without printing either;
- never becomes healthy when the database can't be reached;
- passes the whole test suite against real Postgres (annotated);
- starts healthy as a non-root user, migrates and reports the database on `/api/status`;
- takes a real order end to end and stores a metadata-free 2560 px photo;
- contains no sharp, uses the libvips tools, and runs read-only like the stacks;
- starts and takes an order on an emulated Penryn CPU (home-server class, no SSE4.2);
- refuses a 61 MB body with 413;
- passes Trivy (Alpine's libvips packages included).

Merges to `main` publish `ghcr.io/thehunfromoz/picklemypaddle-integrations:staging` and `:<sha>`.
