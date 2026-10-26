#!/usr/bin/env bash
# Container tests for the integrations image, run by the shared image workflow
# (picklemypaddle-infra/.github/workflows/image.yml) with IMAGE=<local tag>, after pnpm install.
#
# SCRUM-64 to 67: a real Postgres 18 (the version staging and production run) is started beside
# the image, so this also runs the database test suite against real Postgres (locally it uses
# PGlite) and places a real order through the running image.
set -euo pipefail
NET=pmp-ci
PG_IMAGE=postgres:18-alpine
PG_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
DB_URL="postgres://pmp:${PG_PASSWORD}@pg:5432/pmp"
cleanup() {
  docker rm -f svc svc-bad svc-oldcpu pg >/dev/null 2>&1 || true
  docker volume rm pmp-ci-photos pmp-ci-photos-oldcpu >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
fail() { echo "::error title=container test::$*"; exit 1; }

docker network create "$NET" >/dev/null
docker run -d --name pg --network "$NET" -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=pmp -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=pmp "$PG_IMAGE" >/dev/null
for _ in $(seq 1 30); do docker exec pg pg_isready -U pmp -d pmp >/dev/null 2>&1 && break; sleep 1; done
docker exec pg pg_isready -U pmp -d pmp >/dev/null || fail "Postgres didn't start"
# pg_isready can answer before the init scripts finish and Postgres restarts; wait for a real query.
for _ in $(seq 1 30); do docker exec pg psql -U pmp -d pmp -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done

echo "1. Refuses to start without required settings, and names them"
set +e; out=$(docker run --rm "$IMAGE" 2>&1); code=$?; set -e
echo "$out"
[ "$code" = 78 ]
grep -q "APP_ENV is required but not set" <<<"$out"
grep -q "PUBLIC_SITE_ORIGIN is required but not set" <<<"$out"
grep -q "DATABASE_URL is required but not set" <<<"$out"

echo "2. Refuses a live Stripe key on staging, without echoing it"
key="sk_live_$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
set +e
out=$(docker run --rm -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 -e DATABASE_URL="$DB_URL" \
      -e STRIPE_SECRET_KEY="$key" -e STRIPE_WEBHOOK_SECRET=whsec_x "$IMAGE" 2>&1); code=$?
set -e
echo "${out//$key/[REDACTED]}"
[ "$code" = 78 ]
grep -q "STRIPE_SECRET_KEY is a LIVE key" <<<"$out"
if grep -qF "$key" <<<"$out"; then echo "secret value leaked into output"; exit 1; fi

echo "3. Refuses an invalid DATABASE_URL, names it, never prints it (SCRUM-64)"
bad="mysql://pmp:${PG_PASSWORD}@pg/pmp"
set +e; out=$(docker run --rm -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 -e DATABASE_URL="$bad" "$IMAGE" 2>&1); code=$?; set -e
echo "${out//$PG_PASSWORD/[REDACTED]}"
[ "$code" = 78 ] || fail "invalid DATABASE_URL: exit $code, expected 78"
grep -q "DATABASE_URL must be a postgres:// URL" <<<"$out"
if grep -qF "$PG_PASSWORD" <<<"$out"; then fail "the database password leaked into output"; fi

echo "4. Never becomes healthy when the database can't be reached (so staging rolls back)"
set +e
timeout 60 docker run --name svc-bad --network "$NET" -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 \
  -e DATABASE_URL="postgres://pmp:${PG_PASSWORD}@no-such-db:5432/pmp" "$IMAGE" >/tmp/svc-bad.log 2>&1; code=$?
set -e
sed "s/$PG_PASSWORD/[REDACTED]/g" /tmp/svc-bad.log
[ "$code" != 0 ] || fail "started without a database"
grep -q '"event":"migration_failed"' /tmp/svc-bad.log || fail "no migration_failed event"
if grep -qF "$PG_PASSWORD" /tmp/svc-bad.log; then fail "the database password leaked into the log"; fi

echo "5. Database tests against real Postgres 18 (locally they run on PGlite), photos via the libvips tools"
# The image processes photos with the libvips tools (SCRUM-66), so the suite must test that engine too.
sudo apt-get update -q >/dev/null && sudo apt-get install -y -q libvips-tools >/dev/null
REQUIRE_VIPS=1 TEST_DATABASE_URL="postgres://pmp:${PG_PASSWORD}@127.0.0.1:5433/pmp" \
  pnpm exec vitest run --reporter=default --reporter=json --outputFile=/tmp/vitest-pg.json
read -r passed total files < <(node -e '
  const r = JSON.parse(require("fs").readFileSync("/tmp/vitest-pg.json", "utf8"));
  console.log(r.numPassedTests, r.numTotalTests, r.numTotalTestSuites)')
[ "$passed" = "$total" ] && [ "$total" -gt 50 ] || fail "database tests on Postgres: $passed of $total passed"
version="$(docker exec pg psql -U pmp -d pmp -tAc 'show server_version')"
echo "::notice title=database tests ran on real Postgres::$passed of $total tests passed against PostgreSQL $version (TEST_DATABASE_URL)"

echo "6. Image has no sharp; photos use the libvips tools (SCRUM-66, home-server's CPU can't run sharp)"
if docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/node_modules/.pnpm | grep -q "^sharp@"'; then fail "sharp is in the image"; fi
docker run --rm --entrypoint sh "$IMAGE" -c 'vipsthumbnail --version && test "$IMAGE_ENGINE" = vips' || fail "libvips tools missing or IMAGE_ENGINE isn't vips"

echo "6b. Starts healthy as non-root (read-only, like the stacks), migrates, and reports the database (SCRUM-64)"
docker run -d --name svc --network "$NET" -p 8080:8080 --read-only --tmpfs /tmp -v pmp-ci-photos:/data/photos \
  -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 \
  -e DATABASE_URL="$DB_URL" -e ORDER_MIN_FILL_SECONDS=0 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' svc)" = healthy ] && break; sleep 2
done
docker inspect -f '{{.State.Health.Status}}' svc | grep -qx healthy || { docker logs svc; fail "not healthy"; }
[ "$(docker inspect -f '{{.Config.User}}' svc)" = node ]
status="$(curl -fsS http://127.0.0.1:8080/api/status)"; echo "$status"
grep -q '"database":{"reachable":true,"migration":1,"latest":1}' <<<"$status" || fail "database not reported reachable at migration 1"
grep -q '"imageEngine":"vips"' <<<"$status" || fail "the service isn't using the libvips tools"
if docker logs svc 2>&1 | grep -qF "$PG_PASSWORD"; then fail "the database password leaked into the service log"; fi

echo "7. A real order through the running image (SCRUM-65)"
node --input-type=module -e "
  import sharp from 'sharp';
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#4565A6' } })
    .withExif({ IFD0: { Make: 'CI-Cam' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 52/1 0/1' } })
    .jpeg().toFile('/tmp/paddle.jpg');"
token="$(curl -fsS http://127.0.0.1:8080/api/orders/form | node -pe 'JSON.parse(require("fs").readFileSync(0)).formToken')"
resp="$(curl -sS -w '\n%{http_code}' -X POST http://127.0.0.1:8080/api/orders -H 'Origin: http://home-server:8088' \
  -F name='CI Player' -F email='ci+container@example.com' -F street='1 Court St' -F suburb=Sydney -F state=NSW \
  -F postcode=2000 -F consent=yes -F tournamentAck=yes -F formToken="$token" -F website= \
  -F 'paddles[0][brand]=Selkirk' -F 'paddles[0][front]=@/tmp/paddle.jpg;type=image/jpeg' \
  -F 'paddles[0][back]=@/tmp/paddle.jpg;type=image/jpeg')"
echo "$resp"
[ "$(tail -n1 <<<"$resp")" = 201 ] || fail "order POST: $resp"
grep -qE '"reference":"PMP-[A-HJ-KM-NP-Z2-9]{5}"' <<<"$resp" || fail "no PMP reference in the answer"
grep -q '"test":true' <<<"$resp" || fail "staging order not marked test"
row="$(docker exec pg psql -U pmp -d pmp -tAc "select status, is_test, is_smoke from orders")"
[ "$row" = "submitted|t|t" ] || fail "stored order row: $row"
[ "$(docker exec pg psql -U pmp -d pmp -tAc 'select count(*) from photos')" = 2 ] || fail "photo rows"
files="$(docker exec svc find /data/photos -type f -name '*.jpg')"; echo "$files"
[ "$(wc -l <<<"$files")" = 2 ] || fail "expected 2 photo files on the volume"
docker cp "svc:$(head -n1 <<<"$files")" /tmp/stored.jpg
node --input-type=module -e "
  import sharp from 'sharp';
  const m = await sharp('/tmp/stored.jpg').metadata();
  if (m.exif || m.xmp || Math.max(m.width, m.height) !== 2560) { console.error(m); process.exit(1); }
  console.log('stored photo: ' + m.width + 'x' + m.height + ', no EXIF/XMP');" || fail "stored photo kept metadata or wrong size"
if docker logs svc 2>&1 | grep -qE 'CI Player|ci\+container|Court St'; then fail "personal data in the service log"; fi

echo "8. Big bodies are refused before they are read (SCRUM-66/67)"
head -c $((61*1024*1024)) /dev/zero >/tmp/big.bin
# The service answers from Content-Length alone, so curl may see the connection close while still
# uploading: its exit status doesn't matter, only the answer it got.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H 'Expect:' -X POST http://127.0.0.1:8080/api/orders \
  -H 'Content-Type: multipart/form-data; boundary=x' --data-binary @/tmp/big.bin || true)"
[ "$code" = 413 ] || fail "61 MB body got '$code', expected 413"

echo "9. Starts and takes an order on an older CPU like home-server's (Core 2 era: no SSE4.2, not x86-64-v2)"
# QEMU emulates that processor for the service's own process (Node), which is what crashed on
# home-server on 26 Oct 2026 when sharp needed x86-64-v2. The libvips tools are then run under the
# same emulation directly, since programs the service starts would otherwise run natively.
sudo apt-get install -y -q qemu-user-static >/dev/null  # package lists refreshed in step 5
QEMU="$(command -v qemu-x86_64-static)"
docker run -d --name svc-oldcpu --network "$NET" -p 8081:8080 --read-only --tmpfs /tmp -v pmp-ci-photos-oldcpu:/data/photos \
  -v "$QEMU:/usr/local/bin/qemu-x86_64-static:ro" --entrypoint /usr/local/bin/qemu-x86_64-static \
  -e APP_ENV=staging -e PUBLIC_SITE_ORIGIN=http://home-server:8088 -e DATABASE_URL="$DB_URL" -e ORDER_MIN_FILL_SECONDS=0 \
  "$IMAGE" -cpu Penryn /usr/local/bin/node dist/server.js >/dev/null
for _ in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' svc-oldcpu)" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Status}}' svc-oldcpu)" = exited ] && break
  sleep 2
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' svc-oldcpu)" != healthy ]; then
  docker logs svc-oldcpu 2>&1 | tail -20
  fail "not healthy on an emulated Penryn CPU (home-server class)"
fi
token="$(curl -fsS http://127.0.0.1:8081/api/orders/form | node -pe 'JSON.parse(require("fs").readFileSync(0)).formToken')"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8081/api/orders -H 'Origin: http://home-server:8088' \
  -F name='CI Player' -F email='ci+oldcpu@example.com' -F street='1 Court St' -F suburb=Sydney -F state=NSW \
  -F postcode=2000 -F consent=yes -F tournamentAck=yes -F formToken="$token" -F website= \
  -F 'paddles[0][brand]=Selkirk' -F 'paddles[0][front]=@/tmp/paddle.jpg;type=image/jpeg' \
  -F 'paddles[0][back]=@/tmp/paddle.jpg;type=image/jpeg')"
[ "$code" = 201 ] || fail "order on the emulated older CPU got $code"
docker run --rm -v "$QEMU:/usr/local/bin/qemu-x86_64-static:ro" -v /tmp/paddle.jpg:/in/paddle.jpg:ro --tmpfs /out \
  --entrypoint /usr/local/bin/qemu-x86_64-static "$IMAGE" -cpu Penryn /usr/bin/vipsthumbnail /in/paddle.jpg \
  --size '2560x2560>' -o '/out/p.jpg[Q=85,keep=none]' || fail "vipsthumbnail fails on an emulated Penryn CPU"
echo "::notice title=older CPU::the image starts, takes an order and runs vipsthumbnail on an emulated Penryn CPU (home-server class, no SSE4.2)"

echo "All container tests passed."
