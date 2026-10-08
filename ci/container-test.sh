#!/usr/bin/env bash
# Container tests for the integrations image, run by the shared image workflow
# (picklemypaddle-infra/.github/workflows/image.yml) with IMAGE=<local tag>.
set -euo pipefail
cleanup() { docker rm -f svc >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "1. Refuses to start without required settings, and names them"
set +e; out=$(docker run --rm "$IMAGE" 2>&1); code=$?; set -e
echo "$out"
[ "$code" = 78 ]
grep -q "APP_ENV is required but not set" <<<"$out"
grep -q "PUBLIC_SITE_ORIGIN is required but not set" <<<"$out"

echo "2. Refuses a live Stripe key on staging, without echoing it"
key="sk_live_$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
set +e
out=$(docker run --rm -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 \
      -e STRIPE_SECRET_KEY="$key" -e STRIPE_WEBHOOK_SECRET=whsec_x "$IMAGE" 2>&1); code=$?
set -e
echo "${out//$key/[REDACTED]}"
[ "$code" = 78 ]
grep -q "STRIPE_SECRET_KEY is a LIVE key" <<<"$out"
if grep -qF "$key" <<<"$out"; then echo "secret value leaked into output"; exit 1; fi

echo "3. Starts and becomes healthy, as non-root, with valid settings"
docker run -d --name svc -p 8080:8080 -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 "$IMAGE" >/dev/null
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' svc)" = healthy ] && break; sleep 2
done
docker inspect -f '{{.State.Health.Status}}' svc | grep -qx healthy
curl -fsS http://127.0.0.1:8080/api/status; echo
[ "$(docker inspect -f '{{.Config.User}}' svc)" = node ]
echo "All container tests passed."
