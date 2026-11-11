# picklemypaddle-integrations

Small service behind the Pickle My Paddle website. Jira epics: SCRUM-8 (orders and CRM),
SCRUM-9 (payments), SCRUM-10 (clubs).

Planned responsibilities:

- Receive order submissions (details + front/back paddle photos), validate and store them.
- Private status links for customers and clubs.
- Adapters, so each vendor can be swapped without touching the site:
  - CRM: HubSpot first
  - Payments: Stripe Checkout (SCRUM-82): Pay now on the status page; return, events poller, webhook
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
| `consent`, `tournamentAck`, `artworkAck` | must all be `yes`; stored with timestamps (`artwork_ack_at`: the new grit is black and hides logos and artwork, SCRUM-104; orders from before it have none) |
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
| Discount-code checks (the form's, plus each submitted order that carries a code) | 20 per IP per hour (`DISCOUNT_CHECK_LIMIT_PER_IP_HOUR`) |
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
Only Stripe sets Paid (SCRUM-82 removed staging's "Mark paid (test)"). Every change
writes a history row with who made it, and queues its email in the same transaction.

| From | To (by) | Email to the customer |
| --- | --- | --- |
| Submitted | Questions, Accepted, Rejected, Withdrawn (admin) | Accepted (re-grit, postage, total, GST line), Rejected (reason) |
| Questions | Accepted, Rejected, Withdrawn (admin); Lapsed (automatic, 30 days) | as above |
| Accepted | Paid (Stripe only, SCRUM-82); Withdrawn (admin); Lapsed (automatic, unpaid on day 30, SCRUM-83) | |
| Paid | In queue (admin, records the arrival day); Withdrawn (admin) | In queue ("back in the post by") |
| In queue | Re-gritted (admin) | |
| Re-gritted | Posted back (admin, tracking number required) | Posted back (tracking, review link) |
| Posted back | Completed (admin, or automatic after 10 days) | |

Questions sends nothing: Attila writes to the customer himself from info@.

**Queue and promise (SCRUM-73).** When an order enters In queue, its promise date is stored:
arrival + the order's turnaround (10 business days by default, `TURNAROUND_BUSINESS_DAYS` in `src/orders/dates.ts`, the one place to change it; Attila sets another number, 1 to 65, when he accepts the order, SCRUM-105: stored as `turnaround_days`, in the acceptance email and the payment email, and fixed once queued), skipping weekends and NSW public holidays (`src/orders/holidays.ts`,
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
  size and weight, the chargeable weight (**actual weight for launch**, decided 2 Nov 2026; the
  table's `basis: 'cubic'` charges the greater of actual and cubic, m³ × 250), then Australia Post
  Parcel Post from Sydney (one national price up to 5 kg; over 5 kg by the destination zone from the
  return postcode). Packaging is **absorbed for a single paddle** and charged at cost from two
  paddles (`chargePackagingFromPaddles`). On today's figures: 1 paddle A$11.70, 2 A$18.00, 3–9
  A$23.75, 10 A$27.95, anywhere in Australia.
  Australia Post changes prices each July: **add a new dated table then**. The admin's Accept form
  shows the working and fills in the amount; a different amount needs a reason, which goes in the
  history. When nothing can be calculated (on cubic weight, a parcel over 5 kg to a postcode outside
  the zone table; or more than 10 paddles), Accept needs the amount and a reason.
- **`GET /api/pricing`** (public, cached 1 h) gives the website today's price, GST wording and
  postage per paddle count, so the wording changes on the GST date without a rebuild.

## Discount codes (SCRUM-63, decided 30 Oct and 2 Nov 2026)

Codes are managed in admin (**Discount codes** in the bar), with **one form** (redesigned 3 Nov
2026): a prefix (1 to 20 letters and digits), what the code gives, and the kind of code:
**one per person**, 1 to 100 unique codes `PREFIX-XXXXXXXX` (8 easy-read random characters), each
used once and once per email (the launch offer: 10 of them), or **shared**, one code that is
exactly the prefix (e.g. `SPRING10`) with its own total uses and once-per-email choice (marketing
campaigns). Either kind can give any benefit. Each code's note (who it went to) is editable; the
list filters by prefix and state (active, used up, expired, inactive). A code gives a **free re-grit for up to
N paddles**, **A$x off** or **x% off** the order's re-grit, never return postage, so every order
still pays something (Accept refuses an A$0 total). Direct orders only.

- **Format:** letters and digits, plus the hyphen in generated codes (3 to 32 long); matched ignoring
  case and spaces.
- **`POST /api/discount-codes/check`** `{ code, email? }` → `{ valid: true, code, kind, value,
  label }` or `{ valid: false, message }`. Every refusal (unknown, inactive, expired, used up,
  already used by this email) gets the same message. Rate-limited per IP; refusals are logged as
  `discount_refused` with the reason only, never the code.
- **At submit** the order's `discountCode` field is checked again with the code's row locked, and a
  use is **reserved** in the same transaction (two orders can't both take the last use). A refused
  code answers `400 { errors: { discountCode } }` and stores nothing. What the code gives is saved
  on the order (`discount_code`, `discount_kind`, `discount_value`), so changing or deactivating
  the code later never changes it. **At Accept** the discount is fixed in `discount_cents` with the
  other terms (SCRUM-81).
- **Uses:** reserved at submit, **consumed at Paid**, **released** when the order is Rejected,
  Withdrawn or Lapsed before paying (a paid order keeps its use). A deleted order's held use stops
  counting. The code page lists uses by order reference only.
- **Shown on:** the Submitted email ("code applied, confirmed when we accept"), the admin order
  page and Accept form, the Accepted email (a Discount line), the status page (`discount` in
  `/api/orders/status`) and the HubSpot deal amount (taken off the estimate before Accept; the
  saved total after). The receipt follows with SCRUM-84.
- The shared helpers (`discountCents`, `describeDiscount`, the code format) are in
  `src/orders/rules.ts`, so the website's estimate uses the same arithmetic.

## Payments (SCRUM-82, decided 30 Oct and 2 Nov 2026)

Cards are entered only on Stripe's own Checkout pages (PCI SAQ A); no card details reach us.

- **Pay now** is on the private status page, only while the order is Accepted. It posts the status
  token to **`POST /api/orders/pay`**, which makes a fresh Checkout Session for the total saved at
  Accept (expiring the order's earlier open ones) and returns Stripe's page. Emails never carry a
  Stripe link (they expire); the Accepted email's button opens the status page. The token never
  goes to Stripe: the site keeps it in the tab's sessionStorage for the return.
- **Line items:** "Re-grit, N paddles, both faces" and "Return postage", in AUD, adding up to the
  saved total. A discount code makes the re-grit line net, e.g. "… (code FREE-…: A$60 off)" at A$0
  (Checkout can't show a negative line; no Stripe coupons). Session metadata: the order id
  (`client_reference_id`) and reference; the customer's email is filled in.
- **Recognising a payment**, all through `applySession` (`src/payments/payments.ts`), idempotent on
  the session id, with the payment row and Paid (actor `stripe`) in one transaction:
  1. **Return:** Stripe sends the customer to `/order/paid?session_id=…`; the site posts it to
     **`POST /api/orders/paid`**, and the service fetches the session from Stripe and applies it.
  2. **Webhook `POST /api/stripe/webhook`**, production only (404 elsewhere): raw body, signature
     checked with `STRIPE_WEBHOOK_SECRET` (5-minute tolerance). Events: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`, `charge.refunded`.
  3. **Events poller** every 2 minutes (`GET /v1/events` for the same types since the last one seen;
     cursor in `job_state`): staging's only feed (Stripe can't reach home-server) and production's
     backstop. Each event is applied once (`stripe_events`).
- **Saved per payment** (`payments`): payment intent, amount, Stripe fee (from the balance
  transaction), paid at, how it arrived. An amount that isn't the saved total, or a payment for an
  order no longer Accepted, is saved with a `problem`, noted on the order and shown in admin; the
  status doesn't move. **Refunds** are made in the Stripe dashboard; `charge.refunded` records the
  refunded total and a note. Nothing refunds or changes status automatically.
- **Admin** shows the payment (amount, fee, time, refunds, problems) with an "Open in Stripe" link,
  or "Payments not configured" without a key.
- **The key** is a **restricted key** with only: Checkout Sessions **Write**; PaymentIntents,
  Charges, Balance and Events **Read**. Live keys are refused outside production, test keys in
  production. `STRIPE_WEBHOOK_SECRET` is required in production only.

## Unpaid orders (SCRUM-83, decided 30 Oct and 2 Nov 2026)

Days are Sydney calendar days from the Accepted time in the history (`src/orders/auto.ts`,
`src/orders/payment-reminder.ts`), run daily with the other jobs:

- **Day 14**, still Accepted: one **payment reminder** ("PMP-… is waiting for payment; it lapses on
  <date>", Pay now on the order page). Once only (`orders.payment_reminder_at`); smoke orders never.
- **Day 30**, still Accepted: **Accepted → Lapsed** (actor `system`, note "Automatic: unpaid 30 days
  after acceptance."), no email. Open Checkout Sessions are expired at Stripe; a discount code use is
  given back; Pay now disappears (409). Lapsed orders then follow the 12-month rule (SCRUM-75).
- **Late payments:** a payment for a Lapsed or Withdrawn order is recorded with its problem, never
  applied; Attila gets an `alert_payment` email (reference and admin link only) and the order shows
  in "Waiting on you" with a **Payment after lapse** badge. He either **reinstates** it (admin only,
  with a note: the order moves to Paid, the payment is marked reinstated by him, a discount code use
  is taken again) or refunds it in Stripe. Other payment problems (wrong amount, a second payment)
  alert the same way with **Check payment**. An order with any Stripe payment counts as paid for
  retention and erasure.
- The admin list shows "lapses in N days unless paid" for Accepted orders.
- **On staging:** `node dist/cli/backdate-order.js PMP-XXXXX 15d` then `node dist/cli/unpaid-run.js`
  sends the reminder; `31d` then `unpaid-run.js` lapses it.

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
  **A club's billing email follows the same rule** (SCRUM-85, after Attila's UAT of 5 Nov 2026): outside
  production the admin refuses one that isn't on `EMAIL_ALLOWLIST` (plus-addressing allowed) or at a
  reserved test domain (`example.com`, `.test`), so a real club's address is never saved on staging and
  can't reach the outbox, the HubSpot test portal or Stripe. Production takes any valid address.
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
  amount = the total fixed at Accept, before that the re-grit estimate less any code's discount,
  always sent with two decimals; properties `pmp_reference`, `pmp_paddle_count`, `pmp_is_test`,
  `pmp_reviewed`, and how the amount is made up (3 Nov 2026): `pmp_regrit_aud` (before discount),
  `pmp_discount_code`, `pmp_discount_aud`, `pmp_postage_aud` and `pmp_gst_aud` (the last two empty
  until Accept)), whose stage mirrors the order status 1:1 in the default pipeline. The contact
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
  property group and properties on deals, contacts and companies, and the 16 stages); without `--dry-run` it
  applies them, idempotently. Stages that aren't ours are listed and left alone. **Run it after
  any change that adds a property** (before the syncs that write it: HubSpot refuses unknown
  properties, and those syncs fail until it has run; retry them, or run `crm-resync.js`).
- **Clubs (SCRUM-85 AC8, 4 Nov 2026):** a club is a **company** (name, `[TEST] ` prefixed
  outside production; `pmp_club_id`, `pmp_is_test`) linked to its billing contact (name and email
  only, so a treasurer who is also a customer keeps their other details), and each batch a **deal**
  (`<PMPB-…> (<club>)`; amount = the invoice total once invoiced, before that the paddles to
  re-grit at the club price on the price list in force today (the invoice uses its issue date's list)
  plus the GST the invoice will add once `GST_REGISTERED_FROM` has come, A$0 if cancelled; `pmp_reference`, `pmp_paddle_count`, `pmp_is_test`) linked to
  both. The free plan has one deal pipeline, so batches use five stages after the order ones,
  "Club batch: collected / returned / invoiced / paid / cancelled" (a second pipeline is possible
  on Starter, SCRUM-98). One `crm` job per club (`outbox.club_id`) syncs the company, contact and
  every batch; it's queued when a club is added or edited and when a batch is recorded, returned,
  cancelled or paid. Records are found again by `pmp_club_id` / `pmp_reference` or recreated, as
  for orders. The club's admin page shows the latest sync, with Retry when it failed. The key
  needs the companies scopes (`.env.example`), then run `hubspot-setup.js`.
- **Resync:** `node dist/cli/crm-resync.js` queues every order and club (after an outage, or when
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

## Clubs and batches (SCRUM-85, decided 30 Oct and 4 Nov 2026)

Clubs collect paddles from their members and hand them over in batches; the club keeps its
members' details, so only the club's name and billing details are held here.

- **Admin → Clubs:** add a club (name, billing contact and email, billing address, optional ABN,
  notes), edit it, make it inactive. **Record a batch collected** (date, paddle count).
- **A batch:** Collected → Returned → Invoiced → Paid, or Cancelled before it's returned.
  **Return and invoice** records the return date and any paddles returned unchanged (not
  charged), issues the invoice and queues its email, in one transaction. A batch returned
  entirely unchanged stays Returned, with nothing invoiced.
- **The invoice:** in the shared `PMP-INV-` sequence, a frozen snapshot like receipts. The amount is
  paddles re-gritted × the club price on the issue date (A$54, `src/pricing/terms.ts`). It's due
  `CLUB_PAYMENT_TERMS_DAYS` after issue (14 until Attila confirms; unused since SCRUM-102, see below). **GST for clubs is added on
  top** (decided 4 Nov 2026): before `GST_REGISTERED_FROM` it's an "Invoice" with no GST; from it,
  a "Tax invoice" showing the subtotal excluding GST, GST at 10% as its own line, and the total.
  Direct orders are unchanged: A$60 including GST.
- **The email** goes to the club's billing email, From sales@, **Reply-To attila@**, with a
  private link to the invoice's page (`/club/invoice?n=…#token`; a token per send, only its hash
  kept, valid for a year). The page asks `POST /api/clubs/invoice { token, number }`.
- **How to pay** (printed on the invoice): PayID to `BUSINESS_PAYID`, card from the invoice's
  page, or cash. Until `BUSINESS_PAYID` is set, invoices show `[To confirm: PayID]`, and
  production refuses to issue one.
- **Payments (part 2):** on a batch's page, **Record a PayID or cash payment** (amount, date,
  method, reference); payment is in full for each invoice (decided 6 Nov 2026): any other amount is refused. **By card:** where
  Stripe is set up, invoices offer "Pay by card" on their page: `POST /api/clubs/pay` makes a
  Checkout Session for what is still owing, which is the whole total (expiring older open ones), and the return
  (`/club/paid` → `POST /api/clubs/paid`), the events poller or the webhook apply it through the same
  idempotent `applySession`. A card payment that would take the invoice past its total, or arrives
  after it's paid, is recorded with a problem, not applied, and shown on the batch for a refund in
  Stripe. Once payments reach the total, the invoice shows "paid" (e.g. "by PayID and card") and the
  batch is Paid.
- **Overdue:** an invoiced batch past its due date with something owing is flagged in the admin
  (batch list and page). Nothing chases the club automatically.
- The HubSpot company and deal come next. Clubs never get discount codes.

## Club leads and the pipeline (SCRUM-93, decided 4 and 9 Nov 2026)

- **The form:** the Clubs page's "Talk to us about your club" posts to `POST /api/clubs/lead`
  (`GET /api/clubs/lead/form` gives the form token). Club name, suburb, contact name, email and a
  rough size are required; phone, message and preferred times are optional. It has the order form's
  abuse protections: a honeypot (`website`), a 3-second minimum fill time (a bot gets a normal 201 and
  nothing is saved), and per-address (5 an hour) and per-email (3 a day, plus-addresses counted as one)
  limits. Nothing about members and no street address is asked for or kept, and the table has no
  such columns.
- **A lead is a club** (`clubs.status` lead, meeting, agreement_sent, then active or inactive), not a
  table of its own. Billing details are only required from Active on (a database check), so they are
  empty until Attila adds them. The migration leaves every existing club untouched.
- **Emails:** the contact gets an acknowledgement ("we'll reply within 1 business day with times"),
  Attila an alert with the club name and the admin link only, both from sales@ with Reply-To attila@.
  A club already on file (same name) gets no second record and no acknowledgement, but Attila is still
  alerted. Outside production the contact's address must be allow-listed or a reserved test domain (the
  rule for a club's billing email), so a real person's address never reaches staging, the outbox or HubSpot.
- **Admin:** Clubs lists leads by stage above the customers; a lead's page shows the enquiry, sets a
  meeting date and moves the lead one step along (or back, or out to Inactive). Active needs the
  billing details first.
- **HubSpot:** a lead is a company (with its "Club stage") and its contact, one-way like the rest.
- **Retention:** a club that never became a customer (no billing details, no batches) is deleted 12 months
  after its last activity, with its HubSpot company and contact (`runLeadRetention`, in the daily job
  and `retention-run`).

## The club agreement (SCRUM-94, decided 4 Nov 2026)

- **Versions** are numbered, dated texts in the repo (`src/clubs/agreements/`, registered in
  `agreement-versions.ts`). v0.1 is Claude's draft for Attila's approval: `approvedOn` stays null until
  he approves that exact text. **The live version** is the newest approved one; outside production the
  newest is live even if a draft, so staging can try it (every email says TEST). Production only sends an
  approved version and **refuses to start while the live version still has a `[To confirm: …]`**.
- **A version is never edited once sent.** A hash of the text is kept at its first send
  (`club_agreements.sha256`); a changed text with the same number is refused at send time, the database
  freezes a sent row (only the acceptance is filled in, once), and production refuses to start if a sent
  version was edited. A change is a new file and a new number.
- **Send** (club page in admin): to the club's contact (the enquiry's contact, else the billing contact),
  from sales@ with Reply-To attila@. The email has the full text, the Schedule (filled in from the club's
  record) and a private link to a printable page (`/club/agreement#token`, `POST /api/clubs/agreement`,
  like invoices: browser print, no PDF engine). A club at Meeting arranged moves to Agreement sent; a
  newer version can also go to an Active club, whose accepted version stays on record until it accepts the new one.
- **Becoming Active:** a club that came in through the form becomes Active only by recording its "I agree" reply (no move, no Reactivate); a club made in admin before agreements, or one with batches, is a customer already and can be reactivated.
- **Record the reply** by hand (replies are read in Gmail; nothing is parsed): version, date of the reply,
  who replied and a note. The club becomes Active (it needs its billing details first).
- **Pickups** (SCRUM-96) call `requireAcceptedAgreement(db, clubId)`: a club that hasn't accepted a
  version can't request one.
- v0.1 says payment is in full for each invoice (no part payments, decided 7 Nov 2026).

## Payment before return, and the postage allowance (SCRUM-102, decided 11 Nov 2026)

- A club pays before its batch goes back (agreement 7.3). The order is Collected → Invoiced → Paid →
  Returned (migration 21). "Re-gritted: invoice the club" issues the invoice and emails it; "Mark
  returned" (with the return date, and a tracking number for post) is only offered once it is paid. A
  batch where every paddle came back unchanged has nothing to invoice and goes back directly.
- The invoice has no due date (it is due before return), so the "overdue" flag no longer fires.
  `CLUB_PAYMENT_TERMS_DAYS` and the overdue check (`isOverdue`) are deliberately KEPT, unused (decided 11 Nov):
  clubs may insist on deferred payment. **Flagged for review after going to production**, when the
  negotiations with clubs have landed (Jira follow-up).
- A posted batch of 6 or more paddles gets a negative line, "Postage allowance", for the standard
  cost of the club's postage TO US (corrected 11 Nov: it is not the return leg): Australia Post's price
  for that many paddles at the club's venue postcode on the invoice date
  (`pricing/postage.ts`, postage only), or an amount entered when that can't be worked out. GST, once
  registered, is on the invoice after it. `[To confirm with the accountant: GST on the allowance.]`
  The postcode is the club's venue postcode (set on the club's page, "Venue"); a club added by hand has
  none, so it falls back to the postcode at the end of the billing address (`postcodeFromAddress`).
- A returned, invoiced batch stays a Closed-won deal in HubSpot.

## Clubs that post their paddles, and meeting times (SCRUM-94/96/93 UAT, decided 10 Nov 2026)

- **Post as well as pickup.** A club outside pickup range can post a box (we supply it) to the
  business address and we post the batch back. A batch has a `method` (`pickup` or `post`), one
  tracking number to us and one back (letters, digits, dashes, up to 60), and the existing free-text
  note. `collected_on` is the day it came into our hands either way; "Record a batch received" in admin.
- **Postage (as decided 11 Nov 2026, replacing the 10 Nov wording):** the club pays the postage to us; for a
  posted batch of 6 or more paddles (`POSTAGE_ALLOWANCE_MIN`) its standard cost comes off the invoice as
  its own line, so clubs are encouraged to send bigger batches. We pay the postage back to the
  club, for every batch (decided 11 Nov; agreement 0.3, 5.3).
- **Agreement 0.2** (0.1 was never sent): dead-spot check in 3.2, a new section 5 for post, custody 6.6,
  later sections renumbered. Liability in transit is `[To confirm]`: to be agreed with each club.
- **Meeting time and length** are optional and set after the date (migration 19). The meeting goes to the
  company's "Club meeting" property in HubSpot (run `hubspot-setup` once per portal after deploying).

## The local pickup service area (SCRUM-102, decided 10 Nov 2026)

- `service-area-suburbs.json` is the single source of truth for the area (never copy suburbs into
  code) and `service-area.ts` checks a venue against it. **The site owns both** (`src/lib/`: the map and
  the suburb list are public site content); they are copied byte-for-byte into `src/clubs/` here, and
  `tests/service-area-parity.test.ts` checks the copies against the site's `main`. Change the site first.
- Inside = suburb matches and (no postcode, or the postcode is one of its postcodes). A listed suburb
  with another postcode is outside and flagged for review (`area_review`); an unknown suburb is postal.
- The lead form takes the venue suburb and postcode (4 digits, required). The club stores the default
  (`fulfilment_default`), the list version (`area_version`), and any admin override
  (`fulfilment_override` + `_at`), so a later list change doesn't silently change existing clubs.
  Admin shows and overrides it; the batch form starts on it; HubSpot's company has "Club pickup or post".
- A new list version is a new JSON `version`; nothing is re-evaluated for existing clubs.
- Agreement 0.3 (0.2 was sent to a staging test club, so it is left as it was) carries Attila's UAT
  wording; the Schedule shows the venue, how batches travel and the list version.

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
- **Stripe keys must be test-mode (`rk_test_…`/`sk_test_…`) outside production.** A live key on dev or
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
