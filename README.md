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

**Status:** skeleton (SCRUM-13/18). Health check, settings validation, CORS and security
headers; no business routes yet.

## Stack

TypeScript on Node 22, [Hono](https://hono.dev) for HTTP, [zod](https://zod.dev) to validate
settings, Vitest for tests, pnpm. Same toolchain as the site.

## Run it on your Mac

```bash
corepack enable
pnpm install
cp .env.example .env      # local settings; .env is git-ignored
pnpm dev                  # http://localhost:8080/healthz
pnpm test                 # unit tests
```

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
- Secret values are never logged. Startup logs show them only as `[set]`.
- The website only ever gets public values, such as the HubSpot portal ID. Private tokens stay
  in this service.

## CI

Every PR runs type-check, unit tests, build and a gitleaks secret scan. CI also builds the
Docker image and checks that it:
- refuses to start without settings and names them;
- refuses a live Stripe key on staging without printing it;
- starts healthy as a non-root user with valid settings;
- passes Trivy.

Merges to `main` publish `ghcr.io/thehunfromoz/picklemypaddle-integrations:staging` and `:<sha>`.
