#!/usr/bin/env bats
# status.sh, update.sh's checks and exit codes, and the decisions they share (lib/status.sh):
# migrations, image tags, data images, the steps a version change needs outside update.sh. The full
# runs use a real git checkout and stubs for id, docker and curl.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/status.sh"
  SCRIPT=$DEPLOY_DIR/status.sh
  # Whether systemd runs the host is the test's choice, not the machine's (updater_install sets 1).
  export MAILEXPERT_SYSTEMD=0
}

# --- lib/status.sh ---

@test "has_profile finds a profile in a comma-separated list" {
  has_profile tenant tenant
  has_profile "https,tenant" tenant
  has_profile "tenant, https" https
  ! has_profile "" tenant
  ! has_profile "tenants" tenant
  ! has_profile "https" tenant
}

@test "migration_versions takes only the runner's names (4 digits, '_', .sql) and sorts" {
  run migration_versions <<<$'backend/migrations/0002_b.sql\nbackend/migrations/0001_a.sql\nbackend/migrations/README.md\n0003_c.sql\nbackend/migrations/12_short.sql\nbackend/migrations/0004.sql\nbackend/migrations/x0005_y.sql'
  [ "$output" = $'0001_a\n0002_b\n0003_c' ]
}

@test "pending and unknown migrations compare the database with the target" {
  printf '%s\n' 0001_a 0002_b 0004_x >"$BATS_TEST_TMPDIR/applied"
  printf '%s\n' 0001_a 0002_b 0003_c >"$BATS_TEST_TMPDIR/target"
  [ "$(pending_migrations "$BATS_TEST_TMPDIR/applied" "$BATS_TEST_TMPDIR/target")" = 0003_c ]
  [ "$(unknown_migrations "$BATS_TEST_TMPDIR/applied" "$BATS_TEST_TMPDIR/target")" = 0004_x ]
}

@test "image_tag reads the tag of a reference, with a registry port and a digest" {
  [ "$(image_tag ghcr.io/o/mailexpert-backend:sha-0123456789ab)" = sha-0123456789ab ]
  [ "$(image_tag registry.local:5000/o/app:v1@sha256:abc)" = v1 ]
  [ -z "$(image_tag registry.local:5000/o/app)" ]
  [ -z "$(image_tag o/app@sha256:abc)" ]
}

@test "image_problems names the services that run another tag and skips absent ones" {
  run image_problems sha-0123456789ab frontend backend tenant-worker <<<$'frontend ghcr.io/o/mailexpert-frontend:sha-0123456789ab\nbackend ghcr.io/o/mailexpert-backend:sha-aaaaaaaaaaaa\npostgres postgres:16-alpine'
  [ "$status" -eq 0 ]
  [ "$output" = "version: backend runs sha-aaaaaaaaaaaa, the panel is at sha-0123456789ab" ]
}

@test "manifest_state tells a missing tag from a registry that cannot be asked" {
  [ "$(manifest_state 0 '')" = ok ]
  [ "$(manifest_state 1 'no such manifest: ghcr.io/o/x:sha-1')" = missing ]
  [ "$(manifest_state 1 'manifest unknown')" = missing ]
  [ "$(manifest_state 1 'unauthorized: authentication required')" = unknown ]
  [ "$(manifest_state 1 'dial tcp: lookup ghcr.io: no such host')" = unknown ]
  [ "$(manifest_state 1 'toomanyrequests: rate limit')" = unknown ]
}

@test "data_image_changes: a PostgreSQL major change is a problem, other changes are info" {
  compose() { printf 'services:\n  frontend:\n    image: x\n  postgres:\n    image: postgres:%s\n  redis:\n    image: redis:%s\nvolumes:\n  postgres_data:\n' "$1" "$2"; }
  compose 16-alpine 7-alpine >"$BATS_TEST_TMPDIR/old"
  compose 16-alpine 7-alpine >"$BATS_TEST_TMPDIR/same"
  compose 17-alpine 8-alpine >"$BATS_TEST_TMPDIR/major"
  compose 16.4-alpine 7-alpine >"$BATS_TEST_TMPDIR/minor"
  [ -z "$(data_image_changes "$BATS_TEST_TMPDIR/old" "$BATS_TEST_TMPDIR/same")" ]
  run data_image_changes "$BATS_TEST_TMPDIR/old" "$BATS_TEST_TMPDIR/major"
  [ "${lines[0]}" = "problem postgres postgres:16-alpine -> postgres:17-alpine" ]
  [ "${lines[1]}" = "info redis redis:7-alpine -> redis:8-alpine" ]
  run data_image_changes "$BATS_TEST_TMPDIR/old" "$BATS_TEST_TMPDIR/minor"
  [ "$output" = "info postgres postgres:16-alpine -> postgres:16.4-alpine" ]
}

@test "update_notes: nothing for a change inside the panel's images" {
  run update_notes 0 caddy <<<$'backend/src/index.js\nfrontend/src/App.jsx\ndocs/operations/deployment.md'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "update_notes: steps for a person are next, the rest info" {
  run update_notes 0 caddy,cloudflared <<<$'backend/migrations/0091_x.sql\nscripts/deploy/mail-node/setup.sh\ndeploy/edge/Dockerfile\ndeploy/edge/Caddyfile.tmpl\ndeploy/edge/compose.yml\ndeploy/systemd/mailexpert-health.timer'
  [[ ${lines[0]} == "next mail node: "*"setup.sh --dry-run"* ]]
  [[ ${lines[1]} == "info edge: the Caddy image changed; update.sh pulls the new one"*"edge-image.previous"* ]]
  [[ ${lines[2]} == "info edge: the Caddyfile template changed"* ]]
  [[ ${lines[3]} == "info edge: its compose file changed"* ]]
  [[ ${lines[4]} == "info timers: "* ]]
  [ "${#lines[@]}" -eq 5 ]
}

@test "update_notes: a changed migration file says nothing about migrations (an applied one is not run again)" {
  run update_notes 0 "" <<<"backend/migrations/0095_x.sql"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "pending_note: the pending versions, nothing when there are none" {
  run pending_note <<<""
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run pending_note <<<$'0096_a\n0097_b'
  [[ $output == "info migrations: the new version adds 2 database migration(s) the database has not applied (0096_a 0097_b); "*"pre-update dump"* ]]
  run pending_note <<<"$(printf '%04d_m\n' 1 2 3 4 5 6 7)"
  [[ $output == *"(0001_m 0002_m 0003_m 0004_m 0005_m and 2 more)"* ]]
}

@test "applied_note: none applied is a code-only way back, more needs the dump, unknown counts as applied" {
  run applied_note 96 96 sha-aaaaaaaaaaaa /opt/me /opt/me/backups/pre-update-sha-aaaaaaaaaaaa.dump
  [ "$output" = "info migrations: none was applied (96 before and after); going back to sha-aaaaaaaaaaaa needs no dump: install.sh --prefix /opt/me --version sha-aaaaaaaaaaaa" ]
  run applied_note 96 98 sha-aaaaaaaaaaaa /opt/me /d.dump
  [[ $output == "info migrations: 2 applied (96 before, 98 now); going back to sha-aaaaaaaaaaaa means restoring the pre-update dump /d.dump"* ]]
  run applied_note "" 98 sha-aaaaaaaaaaaa /opt/me /d.dump
  [[ $output == "info migrations: the applied ones cannot be compared (? before, 98 now): treat them as applied;"* ]]
}

@test "applied_note: a replaced Caddy image is put back before the code-only way back" {
  run applied_note 96 96 sha-aaaaaaaaaaaa /opt/me /d.dump /opt/me/edge/.env ghcr.io/x/mailexpert-edge@sha256:abc
  [ "$output" = "info migrations: none was applied (96 before and after); going back to sha-aaaaaaaaaaaa needs no dump: set EDGE_IMAGE in /opt/me/edge/.env back to ghcr.io/x/mailexpert-edge@sha256:abc, then install.sh --prefix /opt/me --version sha-aaaaaaaaaaaa" ]
  run applied_note 96 96 sha-aaaaaaaaaaaa /opt/me /d.dump /opt/me/edge/.env ""
  [[ $output == *"set EDGE_IMAGE in /opt/me/edge/.env back to empty (it was unpinned), then install.sh"* ]]
}

@test "update_notes: no Caddy lines without Caddy, no edge lines without an edge" {
  run update_notes 0 cloudflared <<<$'deploy/edge/Dockerfile\ndeploy/edge/Caddyfile.tmpl\ndeploy/edge/compose.yml'
  [ "$output" = "info edge: its compose file changed; install.sh (run by update.sh) copies it and recreates what changed" ]
  run update_notes 0 "" <<<$'deploy/edge/Dockerfile\ndeploy/edge/compose.yml'
  [ -z "$output" ]
}

@test "update_notes: the tenant worker line only with the profile" {
  run update_notes 1 "" <<<"deploy/tenant-worker/server.mjs"
  [[ $output == "info tenant worker: its image changed; update.sh pulls and restarts it"* ]]
  run update_notes 0 "" <<<"deploy/tenant-worker/server.mjs"
  [ -z "$output" ]
}

@test "update_notes: without systemd the units are not said to be installed" {
  run update_notes 0 "" 0 <<<"deploy/systemd/mailexpert-updater.path"
  [ "$output" = "info timers: the systemd units changed; this host runs without systemd, so install.sh does not install them" ]
  run update_notes 0 "" 1 <<<"deploy/systemd/mailexpert-updater.path"
  [ "$output" = "info timers: the systemd units changed; install.sh (run by update.sh) installs them" ]
}

@test "lines_json turns lines into a JSON array" {
  [ "$(printf 'a\nb "c"\n' | lines_json)" = '["a","b \"c\""]' ]
  [ "$(printf '' | lines_json)" = '[]' ]
}

# --- status.sh input ---

@test "--help prints usage and exits 0 without root" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ $output == *"Usage: status.sh"* ]]
}

@test "bad input is exit 2" {
  run bash "$SCRIPT" --target 0123456789ab
  [ "$status" -eq 2 ]
  [[ $output == *"--target must be sha-"* ]]
  run bash "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --prefix
  [ "$status" -eq 2 ]
}

@test "--json: a failed run still prints one JSON object with the error" {
  run --separate-stderr bash "$SCRIPT" --json --target nope
  [ "$status" -eq 2 ]
  [ "$(jq -r .error <<<"$output")" = invalid_input_or_no_installation ]
  [ "$(jq -r .exit_code <<<"$output")" = 2 ]
}

@test "not root is exit 2" {
  if [ "$(id -u)" = 0 ]; then skip "runs as root"; fi
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ $output == *"run status.sh as root"* ]]
}

# --- full runs against a git checkout, docker and curl stubbed ---

# commit <dir> <message>: commits everything in <dir>, prints the full sha.
commit() {
  git -C "$1" add -A >/dev/null
  git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m "$2"
  git -C "$1" rev-parse HEAD
}

compose_file() {
  printf 'services:\n  backend:\n    image: x\n  postgres:\n    image: postgres:%s\n  redis:\n    image: redis:7-alpine\n' "$1"
}

stub_install() {
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  printf '#!/usr/bin/env bash\n[ "$1" = -u ] && echo 0 || command -p id "$@"\n' >"$STUB/id"
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
# STUB_DOCKER_DOWN=1: the daemon does not answer.
if [ "${STUB_DOCKER_DOWN:-0}" = 1 ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
case " $* " in
  *" ps -a --filter label=com.docker.compose.project=me-test --format "*)
    # STUB_FOREIGN: a container of the panel's project that another directory's compose made.
    if [ -n "${STUB_FOREIGN:-}" ]; then printf '%s\t%s\n' "$STUB_FOREIGN" /srv/neighbour; fi ;;
  *" ps "*"{{.Service}} {{.State}} {{.Health}}"*)
    printf '%s\n' "frontend running healthy" "backend running healthy" "postgres running healthy" "redis running healthy" "cloudflared running " ;;
  *" ps "*"{{.Service}} {{.Image}}"*)
    printf '%s\n' "frontend ghcr.io/wyrtensi/mailexpert-frontend:$STUB_TAG" "backend ghcr.io/wyrtensi/mailexpert-backend:$STUB_TAG" "postgres postgres:16-alpine" ;;
  *" exec -T postgres "*)
    [ "${STUB_PSQL:-0}" = 0 ] || exit 1
    sql=$(cat)
    case $sql in
      *"count(*) FROM schema_migrations"*) printf '%s\n' $STUB_APPLIED | grep -c . ;;
      *schema_migrations*) printf '%s\n' $STUB_APPLIED ;;
      *integration_config*) printf '%s\n' "${STUB_SPAM_RULE-ok}" ;;
    esac ;;
  *" info "*) exit 1 ;;
  *" image inspect "*) exit 1 ;;
  *" pull "*) exit "${STUB_PULL:-0}" ;;
  *" manifest inspect "*)
    case ${STUB_MANIFEST:-ok} in
      ok) exit 0 ;;
      missing) echo "no such manifest: $3" >&2; exit 1 ;;
      denied) echo "unauthorized: authentication required" >&2; exit 1 ;;
    esac ;;
esac
exit 0
STUB_EOF
  cat >"$STUB/curl" <<'STUB_EOF'
#!/usr/bin/env bash
case " $* " in
  *"https://cf.example.com/api/health"*)
    printf '%s\n' "$*" >>"$CURL_CF_LOG"
    printf '%s\037%s\037' "${STUB_CF_CODE:-302}" "${STUB_CF_LOCATION-https://team-x.cloudflareaccess.com/cdn-cgi/access/login/cf.example.com}" ;;
  *"/api/health/ready"*) exit "${STUB_READY:-0}" ;;
  *"/api/version"*) printf '{"version":"x","sha":"%s"}\n' "$STUB_SHA" ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/id" "$STUB/docker" "$STUB/curl"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log CURL_CF_LOG=$BATS_TEST_TMPDIR/curl-cf.log

  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/app/backend/migrations" "$P/state" "$P/backups" "$P/edge"
  git -C "$P/app" init -q
  printf 'select 1;\n' >"$P/app/backend/migrations/0001_a.sql"
  compose_file 16-alpine >"$P/app/docker-compose.yml"
  OLD=$(commit "$P/app" one)
  printf 'select 2;\n' >"$P/app/backend/migrations/0002_b.sql"
  mkdir -p "$P/app/scripts/deploy/mail-node"
  printf '#!/bin/sh\n' >"$P/app/scripts/deploy/mail-node/setup.sh"
  NEW=$(commit "$P/app" two)
  git -C "$P/app" checkout -q --detach "$OLD"
  git -C "$P/app" remote add origin "$P/app"
  printf '%s\n' "VERSION=sha-${OLD:0:12}" SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-test HTTP_PORT=18090 SYSTEM=0 "REPO_URL=$P/app" >"$P/install.conf"
  printf '%s\n' COMPOSE_PROFILES= SESSION_SECRET=do-not-print-me >"$P/.env"
  export STUB_TAG=sha-${OLD:0:12} STUB_SHA=$OLD STUB_APPLIED=0001_a
}

@test "a healthy panel without a target: exit 0, versions shown, no secret printed" {
  stub_install
  run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"version              sha-${OLD:0:12}"* ]]
  [[ $output == *"running              sha-${OLD:0:12}"* ]]
  [[ $output == *"result: no problems"* ]]
  [[ $output == *"warning: backup: restic is not configured"* ]]
  [[ $output != *"do-not-print-me"* ]]
}

@test "a container of another owner in the panel's project is a problem" {
  stub_install
  STUB_FOREIGN=neighbour-web run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $output == *"problem: ownership: compose project me-test: container neighbour-web (/srv/neighbour) is not this install's; install.sh and update.sh refuse to run until it is gone"* ]]
}

# cf_install: the panel of stub_install behind the tunnel on cf.example.com.
cf_install() {
  stub_install
  printf '%s\n' "VERSION=sha-${OLD:0:12}" SIGNIN=cf CF_HOST=cf.example.com ADMIN_EMAILS=admin@example.com EDGE=1 \
    PROJECT=me-test HTTP_PORT=18090 SYSTEM=0 "REPO_URL=$P/app" >"$P/install.conf"
  printf '%s\n' COMPOSE_PROFILES= SESSION_SECRET=do-not-print-me CF_ACCESS_ISSUER=https://team-x.cloudflareaccess.com \
    "CF_ACCESS_AUDIENCE=$(printf 'f%.0s' {1..64})" >"$P/.env"
}

@test "an install that keeps the edge project edge: an info line on how to move, nothing else" {
  cf_install
  printf 'EDGE_PROJECT=edge\n' >>"$P/install.conf"
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.info | map(select(startswith("names: the edge'"'"'s compose project '"'"'edge'"'"' has no mailexpert prefix"))) | length' <<<"$output")" = 1 ]
  [[ $output == *"install.sh --prefix $P --edge-project mailexpert-edge"* ]]
  [ "$(jq -r '.problems | length' <<<"$output")" = 0 ]
  # install.conf still says edge: status.sh changes nothing.
  [ "$(env_get "$P/install.conf" EDGE_PROJECT)" = edge ]
  sed -i 's/^EDGE_PROJECT=edge$/EDGE_PROJECT=mailexpert-edge/' "$P/install.conf"
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$(jq -r '.info | map(select(startswith("names: the edge"))) | length' <<<"$output")" = 0 ]
}

@test "the tunnel: Cloudflare Access of the issuer's team in front of <CF_HOST> is reported, no warning" {
  cf_install
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.cf_access.state' <<<"$output")" = ok ]
  [ "$(jq -r '.cf_access.team' <<<"$output")" = team-x.cloudflareaccess.com ]
  [ "$(jq -r '.warnings | map(select(startswith("cloudflare access:"))) | length' <<<"$output")" = 0 ]
  [[ $output != *ffffffff* && $output != *do-not-print-me* ]]
  [ "$(grep -c . "$CURL_CF_LOG")" = 1 ]
  run bash "$SCRIPT" --prefix "$P"
  [[ $output == *"cf_access            ok"* ]]
}

@test "the tunnel: a team mismatch or a missing Access app is a warning with the next step, not a problem" {
  cf_install
  STUB_CF_LOCATION=https://team-y.cloudflareaccess.com/cdn-cgi/access/login/cf.example.com run bash "$SCRIPT" --prefix "$P" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.cf_access.state' <<<"$output")" = team_mismatch ]
  [ "$(jq -r '.warnings | map(select(startswith("cloudflare access: Access for cf.example.com belongs to team-y"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.problems | length' <<<"$output")" = 0 ]
  STUB_CF_CODE=200 STUB_CF_LOCATION='' run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"warning: cloudflare access: https://cf.example.com/api/health answers 200 without Cloudflare Access"* ]]
}

@test "without the tunnel Cloudflare is not asked" {
  stub_install
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$(jq -r '.cf_access' <<<"$output")" = null ]
  [ ! -e "$CURL_CF_LOG" ]
}

@test "on a standby server Cloudflare is not asked" {
  cf_install
  : >"$P/state/standby"
  STUB_READY=1 run bash "$SCRIPT" --prefix "$P" --json
  [ "$(jq -r '.cf_access' <<<"$output")" = null ]
  [ ! -e "$CURL_CF_LOG" ]
}

@test "--target: pending migrations, the mail node as next, images checked in the registry" {
  stub_install
  run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.target.pending_migrations | join(",")' <<<"$output")" = 0002_b ]
  [ "$(jq -r '.target.images["mailexpert-backend"]' <<<"$output")" = ok ]
  [ "$(jq -r '.target.commit_found' <<<"$output")" = true ]
  [ "$(jq -r '.next | map(select(startswith("mail node:"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.info | map(select(startswith("migrations: the new version adds 1 database migration(s) the database has not applied (0002_b)"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.ready' <<<"$output")" = true ]
  [ "$(jq -r '.migrations_applied' <<<"$output")" = 1 ]
  grep -q "manifest inspect ghcr.io/wyrtensi/mailexpert-frontend:sha-${NEW:0:12}" "$DOCKER_LOG"
  ! grep -q "tenant-worker:sha-" "$DOCKER_LOG"
}

@test "--target: a changed migration file the database already applied is not called a new migration" {
  stub_install
  STUB_APPLIED=$'0001_a\n0002_b' run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 0 ]
  [ "$(jq -c '.target.pending_migrations' <<<"$output")" = '[]' ]
  [ "$(jq -r '.info | map(select(startswith("migrations:"))) | length' <<<"$output")" = 0 ]
  # Unknown (the schema not read): the warning says so, no line claims new migrations.
  STUB_PSQL=1 run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$(jq -r '.info | map(select(startswith("migrations:"))) | length' <<<"$output")" = 0 ]
  [ "$(jq -r '.warnings | map(select(contains("pending migrations are unknown"))) | length' <<<"$output")" = 1 ]
}

@test "--target to the same commit: pending migrations is none in the text" {
  stub_install
  run bash "$SCRIPT" --prefix "$P" --target "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  [[ $output == *"pending_migrations   none"* ]]
  [[ $output == *"info: target: the panel is already at sha-${OLD:0:12}"* ]]
}

@test "--target with an unreadable schema: migrations unknown (null), never none" {
  stub_install
  STUB_PSQL=1 run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$(jq -r '.target.pending_migrations' <<<"$output")" = null ]
  [ "$(jq -r '.target.unknown_migrations' <<<"$output")" = null ]
  [ "$(jq -r '.warnings | map(select(contains("pending migrations are unknown"))) | length' <<<"$output")" = 1 ]
  STUB_PSQL=1 run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}"
  [[ $output == *"pending_migrations   unknown"* ]]
}

@test "--target: a missing image, a registry that refuses, a target older than the schema" {
  stub_install
  STUB_MANIFEST=missing STUB_APPLIED=$'0001_a\n0002_b\n0003_c' run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 1 ]
  [ "$(jq -r '.target.unknown_migrations | join(",")' <<<"$output")" = 0003_c ]
  [ "$(jq -r '.target.images["mailexpert-backend"]' <<<"$output")" = missing ]
  [ "$(jq -r '.problems | map(select(contains("does not exist in the registry"))) | length' <<<"$output")" = 2 ]
  [ "$(jq -r '.problems | map(select(contains("older than the database schema"))) | length' <<<"$output")" = 1 ]
  STUB_MANIFEST=denied run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 1 ]
  [ "$(jq -r '.target.images["mailexpert-frontend"]' <<<"$output")" = unknown ]
  [ "$(jq -r '.problems | map(select(contains("registry is unreachable or refused access"))) | length' <<<"$output")" = 2 ]
}

@test "--target: a PostgreSQL major change is a problem" {
  stub_install
  git -C "$P/app" checkout -q --detach "$NEW"
  compose_file 17-alpine >"$P/app/docker-compose.yml"
  PG=$(commit "$P/app" pg17)
  git -C "$P/app" checkout -q --detach "$OLD"
  run bash "$SCRIPT" --prefix "$P" --target "sha-${PG:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"problem: target: postgres changes from postgres:16-alpine to postgres:17-alpine"* ]]
}

@test "--target never fetches while an update holds its lock" {
  stub_install
  git -C "$P/app" remote set-url origin "$BATS_TEST_TMPDIR/nowhere"
  exec 8>"$P/state/update.lock"
  flock -n 8
  run bash "$SCRIPT" --prefix "$P" --target sha-0123456789ab --json
  exec 8>&-
  [ "$status" -eq 1 ]
  [ "$(jq -r '.problems | map(select(contains("an update, rollback or restore is running"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.warnings | map(select(contains("git fetch failed"))) | length' <<<"$output")" = 0 ]
}

@test "the tenant profile adds the worker's container and image" {
  stub_install
  printf '%s\n' COMPOSE_PROFILES=tenant >"$P/.env"
  run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"problem: containers: tenant-worker does not exist"* ]]
  grep -q "manifest inspect ghcr.io/wyrtensi/mailexpert-tenant-worker:sha-${NEW:0:12}" "$DOCKER_LOG"
}

@test "a running build other than install.conf, not ready, and an outdated spam rule" {
  stub_install
  STUB_SHA=ffffffffffffffffffffffffffffffffffffffff STUB_READY=1 STUB_SPAM_RULE=outdated run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $output == *"problem: version: the running build is sha-ffffffffffff"* ]]
  [[ $output == *"problem: ready: "* ]]
  [[ $output == *"warning: mail node: the spam-sort rule on the node is outdated"* ]]
}

@test "a standby server is info, not a problem, until a target is asked for" {
  stub_install
  : >"$P/state/standby"
  STUB_READY=1 run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"info: standby"* ]]
  STUB_READY=1 run --separate-stderr bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [[ $stderr != *"unbound variable"* && $stderr != *"a command failed"* ]]
  [ "$status" -eq 1 ]
  [ "$(jq -r '.problems | map(select(startswith("target: standby server"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.target.pending_migrations' <<<"$output")" = null ]
}

# --- update.sh: --check and the exit codes before the switch ---

@test "update.sh --check runs status.sh --target and changes nothing" {
  stub_install
  run bash "$DEPLOY_DIR/update.sh" --check "sha-${NEW:0:12}" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"target               sha-${NEW:0:12}"* ]]
  [[ $output == *"pending_migrations   0002_b"* ]]
  [ "$(git -C "$P/app" rev-parse HEAD)" = "$OLD" ]
  [ ! -e "$P/backups/pre-update-sha-${OLD:0:12}.dump" ]
}

@test "update.sh: an image that does not pull is exit 3, nothing changed" {
  stub_install
  STUB_PULL=1 run bash "$DEPLOY_DIR/update.sh" "sha-${NEW:0:12}" --prefix "$P"
  [ "$status" -eq 3 ]
  [[ $output == *"cannot pull"* ]]
  [[ $output == *"nothing was changed: the old version still runs"* ]]
  [ "$(git -C "$P/app" rev-parse HEAD)" = "$OLD" ]
}

@test "update.sh: a PostgreSQL major change is refused with exit 2 before anything is pulled" {
  stub_install
  git -C "$P/app" checkout -q --detach "$NEW"
  compose_file 17-alpine >"$P/app/docker-compose.yml"
  PG=$(commit "$P/app" pg17)
  git -C "$P/app" checkout -q --detach "$OLD"
  run bash "$DEPLOY_DIR/update.sh" "sha-${PG:0:12}" --prefix "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"a new PostgreSQL major version needs a dump and a restore"* ]]
  ! grep -q " pull " "$DOCKER_LOG"
}

@test "update.sh hands its update lock to the pre-update backup" {
  stub_install
  mv "$STUB/docker" "$STUB/docker.stub"
  # The dump: whether a fresh process could take update.lock (update.sh must still hold it), and
  # the descriptor backup.sh was handed.
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  case $arg in
    *:/out)
      out=${arg%:/out}
      if bash -c 'exec 7>"$1"; flock -n 7' _ "$P/state/update.lock"; then echo free; else echo held; fi >"$LOCK_LOG"
      printf 'fd=%s\n' "${MAILEXPERT_UPDATE_LOCK_FD:-}" >>"$LOCK_LOG"
      printf 'PGDMP' >"$out/db.dump"
      printf '{"schema_migrations":1}\n' >"$out/counts.json"
      exit 0
      ;;
  esac
done
exec "$(dirname "$0")/docker.stub" "$@"
STUB_EOF
  chmod +x "$STUB/docker"
  printf '{"dump_bytes":5}\n' >"$P/state/backup-last.json"
  # Without the handed descriptor the backup would wait for update.sh itself and give up at once.
  export P LOCK_LOG=$BATS_TEST_TMPDIR/lock.log MAILEXPERT_BACKUP_LOCK_TIMEOUT=0
  run bash "$DEPLOY_DIR/update.sh" "sha-${NEW:0:12}" --prefix "$P"
  [ "$(sed -n 1p "$LOCK_LOG")" = held ]
  [[ $(sed -n 2p "$LOCK_LOG") =~ ^fd=[0-9]+$ ]]
  [ "$(cat "$P/backups/pre-update-sha-${OLD:0:12}.dump")" = PGDMP ]
  [[ $output != *"the backup before the update failed"* ]]
  # Past the backup: the switch began (this checkout has no installer, so it does not become ready).
  [ "$status" -eq 1 ]
}

@test "update.sh: invalid input stays exit 2" {
  run bash "$DEPLOY_DIR/update.sh" sha-nothex
  [ "$status" -eq 2 ]
}

# updater_install <absent|active|inactive>: the install of stub_install (--no-system, project
# me-test) on a host that systemd runs (MAILEXPERT_SYSTEMD=1), the updater script in the checkout
# and a systemctl stub that knows the updater path unit in that state.
updater_install() {
  stub_install
  mkdir -p "$P/app/scripts/deploy"
  printf '#!/bin/sh\n' >"$P/app/scripts/deploy/updater.sh"
  chmod +x "$P/app/scripts/deploy/updater.sh"
  cat >"$STUB/systemctl" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
case $1 in
  cat) [ "$UPDATER_UNIT" != absent ] ;;
  is-active) [ "$UPDATER_UNIT" = active ] ;;
esac
STUB_EOF
  chmod +x "$STUB/systemctl"
  export UPDATER_UNIT=$1 MAILEXPERT_SYSTEMD=1 SYSTEMCTL_LOG=$BATS_TEST_TMPDIR/systemctl.log
}

@test "updater: an active path unit is reported, no warning" {
  updater_install active
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$status" -eq 0 ]
  [ "$(jq -c '.updater' <<<"$output")" = '{"state":"active","expected":true}' ]
  [ "$(jq -r '.warnings | map(select(startswith("updater:"))) | length' <<<"$output")" = 0 ]
  grep -qx 'is-active --quiet mailexpert-updater-me-test.path' "$SYSTEMCTL_LOG"
  run bash "$SCRIPT" --prefix "$P"
  [[ $output == *"updater              active"* ]]
}

@test "updater: a missing or inactive path unit where it is expected is a warning, not a problem, also with --no-system" {
  updater_install absent
  grep -qx SYSTEM=0 "$P/install.conf"
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$status" -eq 0 ]
  [ "$(jq -c '.updater' <<<"$output")" = '{"state":"not_installed","expected":true}' ]
  [ "$(jq -r '.warnings | map(select(startswith("updater: mailexpert-updater-me-test.path is not installed"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.problems | length' <<<"$output")" = 0 ]
  UPDATER_UNIT=inactive run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"warning: updater: mailexpert-updater-me-test.path is installed but not active (systemctl enable --now mailexpert-updater-me-test.path)"* ]]
}

@test "updater: the default project keeps the fixed unit name" {
  updater_install absent
  sed -i 's/^PROJECT=me-test$/PROJECT=mailexpert/' "$P/install.conf"
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$(jq -r '.warnings | map(select(startswith("updater: mailexpert-updater.path is not installed"))) | length' <<<"$output")" = 1 ]
  grep -qx 'cat mailexpert-updater.path' "$SYSTEMCTL_LOG"
}

@test "updater: a checkout without updater.sh does not expect the units" {
  updater_install absent
  rm "$P/app/scripts/deploy/updater.sh"
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$(jq -c '.updater' <<<"$output")" = '{"state":"not_installed","expected":false}' ]
  [ "$(jq -r '.warnings | map(select(startswith("updater:"))) | length' <<<"$output")" = 0 ]
}

@test "updater: a host without systemd says so and is not an error" {
  updater_install absent
  export MAILEXPERT_SYSTEMD=0
  run bash "$SCRIPT" --prefix "$P" --json
  [ "$status" -eq 0 ]
  [ "$(jq -c '.updater' <<<"$output")" = '{"state":"no_systemd","expected":false}' ]
  [ "$(jq -r '.info | map(select(startswith("updater: not installed, this host runs without systemd"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.warnings | map(select(startswith("updater:"))) | length' <<<"$output")" = 0 ]
  [ ! -e "$SYSTEMCTL_LOG" ]
}

@test "healthcheck.sh: an installed but inactive path unit is a problem, active or absent is not" {
  updater_install inactive
  run --separate-stderr bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $stderr == *"problem: updater: mailexpert-updater-me-test.path is installed but not active"* ]]
  UPDATER_UNIT=active run --separate-stderr bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P"
  [[ $stderr != *"updater:"* ]]
  UPDATER_UNIT=absent run --separate-stderr bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P"
  [[ $stderr != *"updater:"* ]]
}

@test "healthcheck.sh: a host without systemd is not an updater problem" {
  updater_install inactive
  MAILEXPERT_SYSTEMD=0 run --separate-stderr bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P"
  [[ $stderr != *"updater:"* ]]
}

@test "healthcheck.sh and status.sh: a Docker that does not answer is reported, the ownership check does not end the run" {
  updater_install active
  STUB_DOCKER_DOWN=1 run --separate-stderr bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $stderr == *"problem: containers: docker compose ps failed for me-test"* ]]
  [[ $stderr == *"problem: backup:"* ]]
  [[ $stderr != *"a command failed"* ]]
  STUB_DOCKER_DOWN=1 run --separate-stderr bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $output == *"warning: ownership: docker did not answer; the panel's compose project was not checked"* ]]
  [[ $output == *"result: "* ]]
  [[ $stderr != *"a command failed"* ]]
}

@test "healthcheck.sh: another owner's container in the panel's project is a problem; a generic edge name is info" {
  updater_install active
  STUB_FOREIGN=neighbour-web run --separate-stderr bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $stderr == *"problem: ownership: compose project me-test holds another owner's container neighbour-web (/srv/neighbour)"* ]]
  [[ $stderr == *"info: names: the panel's compose project 'me-test' has no mailexpert prefix"* ]]
}
