#!/usr/bin/env bash
# Install scenario of the deploy e2e test. Runs inside the throwaway Docker-in-Docker container
# started by e2e.sh and must never run on a host with real data. Everything it creates belongs
# to the compose projects me-e2e and me-e2e-edge and to /e2e, and is removed at exit.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$TEST_DIR/.." && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/../.." && pwd)
# shellcheck source=../lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=../lib/env.sh
. "$DEPLOY_DIR/lib/env.sh"
# shellcheck source=../lib/config.sh
. "$DEPLOY_DIR/lib/config.sh"
# shellcheck source=../lib/edge.sh
. "$DEPLOY_DIR/lib/edge.sh"
# shellcheck source=e2e-lib.sh
. "$TEST_DIR/e2e-lib.sh"

PROJECT=me-e2e
EDGE_PROJECT=me-e2e-edge
PORT=18080
PREFIX=/e2e/prefix
RENDER=/e2e/render
HOST=panel.example.test
VERSION='' IMAGE_PREFIX='' REPO_URL=''

while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=$2 && shift 2 ;;
    --image-prefix) IMAGE_PREFIX=$2 && shift 2 ;;
    --repo-url) REPO_URL=$2 && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
if [ -z "$VERSION" ] || [ -z "$IMAGE_PREFIX" ] || [ -z "$REPO_URL" ]; then
  die "--version, --image-prefix and --repo-url are required" 2
fi

for p in "$PROJECT" "$EDGE_PROJECT"; do
  case $p in mailexpert | mailexpert-edge | edge) fail "refusing to run as project $p" ;; esac
  [ -z "$(labelled ps "$p")$(labelled volume "$p")" ] || fail "project $p already has containers or volumes"
done
[ ! -e "$PREFIX" ] || fail "$PREFIX already exists"

teardown() {
  local status=$? p
  for p in "$PROJECT" "$EDGE_PROJECT"; do remove_project "$p"; done
  rm -rf "$PREFIX" "$RENDER"
  exit "$status"
}
trap teardown EXIT

install_run() { bash "$DEPLOY_DIR/install.sh" "$@"; }

generated_secrets() {
  local key
  for key in "${GENERATED_SECRET_KEYS[@]}"; do
    printf '%s=%s\n' "$key" "$(env_get "$PREFIX/.env" "$key")"
  done | sha256sum
}

config_files_hash() {
  sha256sum "$PREFIX/.env" "$PREFIX/install.conf" "$PREFIX/edge/.env" "$PREFIX/edge/Caddyfile" "$PREFIX/edge/compose.yml"
}

containers_state() {
  { labelled ps "$PROJECT"; labelled ps "$EDGE_PROJECT"; } |
    xargs -r docker inspect --format '{{.Name}} {{.Id}} {{.State.StartedAt}}' | sort
}

# 1. First run: secrets are generated, nothing starts, exit 3 lists the owner secrets.
set +e
out=$(install_run --prefix "$PREFIX" --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url "$REPO_URL" \
  --project "$PROJECT" --edge-project "$EDGE_PROJECT" --http-port "$PORT" --no-system \
  --signin direct --direct-host "$HOST" --edge-tls internal --admin-email admin@example.test 2>&1)
code=$?
set -e
printf '%s\n' "$out"
[ "$code" = 3 ] || fail "first run exited $code, expected 3"
[[ $out == *AUTH_GOOGLE_CLIENT_ID* && $out == *AUTH_GOOGLE_CLIENT_SECRET* ]] || fail "the missing secrets are not listed"
[[ $out != *DNS_API_TOKEN* ]] || fail "DNS_API_TOKEN must not be required with --edge-tls internal"
[[ $(env_get "$PREFIX/.env" SESSION_SECRET) =~ ^[0-9a-f]{64}$ ]] || fail "SESSION_SECRET"
[[ $(env_get "$PREFIX/.env" ENCRYPTION_KEY) =~ ^[0-9a-f]{64}$ ]] || fail "ENCRYPTION_KEY"
[[ $(env_get "$PREFIX/.env" DB_PASSWORD) =~ ^[0-9a-f]{48}$ ]] || fail "DB_PASSWORD"
[[ $(env_get "$PREFIX/.env" VAPID_PUBLIC_KEY) =~ ^[A-Za-z0-9_-]{87}$ ]] || fail "VAPID_PUBLIC_KEY"
[[ $(env_get "$PREFIX/.env" VAPID_PRIVATE_KEY) =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "VAPID_PRIVATE_KEY"
[ "$(stat -c %a "$PREFIX/.env")" = 600 ] || fail ".env is not 0600"
[ -z "$(labelled ps "$PROJECT")" ] || fail "the panel started without its secrets"
secrets_first=$(generated_secrets)
pass "first run generates secrets and waits for the owner's (exit 3)"

# 2. configure.sh refuses a different generated secret and stores owner secrets silently.
before=$(sha256sum <"$PREFIX/.env")
set +e
printf 'ENCRYPTION_KEY=%s\n' "$(gen_hex 32)" | bash "$DEPLOY_DIR/configure.sh" --prefix "$PREFIX" >/dev/null 2>&1
code=$?
set -e
[ "$code" = 2 ] || fail "configure.sh accepted a different ENCRYPTION_KEY (exit $code)"
[ "$(sha256sum <"$PREFIX/.env")" = "$before" ] || fail "a refused configure.sh changed .env"
out=$(printf 'AUTH_GOOGLE_CLIENT_ID=e2e-client.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=e2e-fake-client-secret\n' |
  bash "$DEPLOY_DIR/configure.sh" --prefix "$PREFIX" 2>&1)
[[ $out != *e2e-fake-client-secret* ]] || fail "configure.sh printed a secret"
pass "configure.sh"

# 3. Second run without flags repeats install.conf; the panel and Caddy come up.
install_run --prefix "$PREFIX"
ready=$(curl -fsS "http://127.0.0.1:$PORT/api/health/ready")
[ "$(jq -r .status <<<"$ready")" = ready ] || fail "ready: $ready"
sha=$(curl -fsS "http://127.0.0.1:$PORT/api/version" | jq -r .sha)
[ "$sha" = "$(git -C "$PREFIX/app" rev-parse HEAD)" ] || fail "running build $sha"
ports=$(docker port "$PROJECT-frontend")
[ "$ports" = "80/tcp -> 127.0.0.1:$PORT" ] || fail "frontend ports: $ports"
root=$PREFIX/state/edge-local-root.crt
config=$(curl -fsS --cacert "$root" --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/auth/config")
[ "$(jq -r '.mode + " " + (.googleSignIn | tostring)' <<<"$config")" = "google true" ] || fail "auth config through the edge: $config"
if curl -fs -o /dev/null --cacert "$root" --resolve "other.example.test:443:127.0.0.1" https://other.example.test/ 2>/dev/null; then
  fail "the edge answered a host other than $HOST"
fi
redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$HOST:80:127.0.0.1" "http://$HOST/")
[ "$redirect" = "308 https://$HOST/" ] || fail "http redirect: $redirect"
[ "$(env_get "$PREFIX/.env" APP_URL)" = "https://$HOST" ] || fail "APP_URL"
[ "$(env_get "$PREFIX/.env" GOOGLE_REDIRECT_URI)" = "https://$HOST/oauth/google/callback" ] || fail "GOOGLE_REDIRECT_URI"
[ "$(generated_secrets)" = "$secrets_first" ] || fail "generated secrets changed"
pass "second run: panel ready (build $sha), edge TLS, routing and redirect"

# 4. Third run: no file changes, no container recreated or restarted.
files_before=$(config_files_hash)
state_before=$(containers_state)
install_run --prefix "$PREFIX"
[ "$(config_files_hash)" = "$files_before" ] || fail "a rerun changed configuration files"
[ "$(containers_state)" = "$state_before" ] || fail "a rerun recreated or restarted containers"
pass "rerun is idempotent"

# 5. A lost DB_PASSWORD next to an existing database volume stops the installer.
cp -p "$PREFIX/.env" "$PREFIX/.env.keep"
sed -i '/^DB_PASSWORD=/d' "$PREFIX/.env"
set +e
out=$(install_run --prefix "$PREFIX" 2>&1)
code=$?
set -e
mv -f "$PREFIX/.env.keep" "$PREFIX/.env"
if [ "$code" != 1 ] || [[ $out != *DB_PASSWORD* ]]; then fail "lost DB_PASSWORD with a database volume: exit $code"; fi
[ "$(containers_state)" = "$state_before" ] || fail "the refused run touched containers"
pass "a lost DB_PASSWORD is refused"

# 6. A run that rewrites the Caddyfile and stops before Caddy restarts (exit 3 here) leaves the
# restart to the next run: Caddy then answers the new host.
NEW_HOST=panel2.example.test
secret=$(env_get "$PREFIX/.env" AUTH_GOOGLE_CLIENT_SECRET)
sed -i '/^AUTH_GOOGLE_CLIENT_SECRET=/d' "$PREFIX/.env"
set +e
install_run --prefix "$PREFIX" --direct-host "$NEW_HOST" >/dev/null 2>&1
code=$?
set -e
[ "$code" = 3 ] || fail "the run without AUTH_GOOGLE_CLIENT_SECRET exited $code, expected 3"
grep -q "@app host $NEW_HOST" "$PREFIX/edge/Caddyfile" || fail "the Caddyfile was not rewritten for $NEW_HOST"
printf 'AUTH_GOOGLE_CLIENT_SECRET=%s\n' "$secret" | bash "$DEPLOY_DIR/configure.sh" --prefix "$PREFIX" >/dev/null 2>&1
install_run --prefix "$PREFIX"
curl -fsS -o /dev/null --cacert "$root" --resolve "$NEW_HOST:443:127.0.0.1" "https://$NEW_HOST/api/health" ||
  fail "Caddy does not answer $NEW_HOST after the rerun"
pass "a Caddyfile change from an interrupted run is applied by the next run"

# 7. Tunnel modes are rendered and parsed only: the test has no real tunnel token.
for mode in cf both; do
  (
    install_defaults
    CFG_SIGNIN=$mode CFG_CF_HOST=cf.example.test CFG_DIRECT_HOST=$HOST CFG_EDGE_PROJECT=me-e2e-render
    write_edge_files "$REPO_DIR" "$RENDER/$mode" "$IMAGE_PREFIX/mailexpert-edge:$VERSION"
    env_set "$RENDER/$mode/.env" TUNNEL_TOKEN "$(gen_hex 32)"
    env_set "$RENDER/$mode/.env" DNS_API_TOKEN "$(gen_hex 20)"
  )
  services=$(docker compose -p me-e2e-render --project-directory "$RENDER/$mode" --env-file "$RENDER/$mode/.env" \
    -f "$RENDER/$mode/compose.yml" config --services | sort | paste -sd' ' -)
  case $mode in
    cf) want=cloudflared ;;
    both) want='caddy cloudflared' ;;
  esac
  [ "$services" = "$want" ] || fail "$mode edge services: $services"
done
docker run --rm --network none -e DNS_API_TOKEN="$(gen_hex 20)" -v "$RENDER/both/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$IMAGE_PREFIX/mailexpert-edge:$VERSION" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
  fail "caddy rejected the DNS-01 Caddyfile"
pass "cf and both edges render and parse"

pass "install e2e passed"
