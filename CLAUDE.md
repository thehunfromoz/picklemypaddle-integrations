# picklemypaddle-integrations

TypeScript / Node 22 service (Hono, zod, Postgres): orders, admin, emails, HubSpot mirror, Stripe,
documents. How we work, and the rules for every repo: `../picklemypaddle-infra/docs/working-with-claude.md`.
Which tests guard what: `../picklemypaddle-infra/docs/qa-gates.md`. Decisions per feature are in
this repo's `README.md`.

## Checks (the same as CI)

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
bash ci/container-test.sh     # the image under QEMU -cpu Penryn with a real Postgres 18 (Docker)
```

`pnpm test` runs on PGlite. Stripe and HubSpot are faked at the HTTP boundary
(`tests/helpers/fake-stripe.ts`, `tests/helpers/fake-hubspot.ts`); tests never call the real APIs.

## Rules for this repo

- **Status changes go through `src/orders/transitions.ts`**, which also queues the email and the CRM sync.
- `src/orders/rules.ts` is copied byte-for-byte into the site; change both, this one first.
- **home-server's CPU predates x86-64-v2:** check any new native dependency or base image against it
  (the container test runs under Penryn for this reason).
- A new required setting also goes in infra CI's "Real site image runs behind the gateway" job and
  in `docs/as-built.md`'s secrets table.
- Dummy secrets in tests are assembled at runtime, so push protection doesn't reject them.
- On staging, try the jobs with `ssh pmp-staging cli <name> …` (backdate-order, unpaid-run,
  retention-run, crm-resync, hubspot-setup) and look with `ssh pmp-staging sql "select …"`.
