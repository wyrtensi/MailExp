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
  [[ ${lines[0]} == "info migrations: "* ]]
  [[ ${lines[1]} == "next mail node: "*"setup.sh --dry-run"* ]]
  [[ ${lines[2]} == "info edge: the Caddy image changed; update.sh pulls the new one"*"edge-image.previous"* ]]
  [[ ${lines[3]} == "info edge: the Caddyfile template changed"* ]]
  [[ ${lines[4]} == "info edge: its compose file changed"* ]]
  [[ ${lines[5]} == "info timers: "* ]]
  [ "${#lines[@]}" -eq 6 ]
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
  [ "$output" = "info timers: the systemd units changed; this install runs without systemd (--no-system), so install.sh does not install them" ]
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
case " $* " in
  *" ps "*"{{.Service}} {{.State}} {{.Health}}"*)
    printf '%s\n' "frontend running healthy" "backend running healthy" "postgres running healthy" "redis running healthy" ;;
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
  *"/api/health/ready"*) exit "${STUB_READY:-0}" ;;
  *"/api/version"*) printf '{"version":"x","sha":"%s"}\n' "$STUB_SHA" ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/id" "$STUB/docker" "$STUB/curl"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log

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

@test "--target: pending migrations, the mail node as next, images checked in the registry" {
  stub_install
  run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.target.pending_migrations | join(",")' <<<"$output")" = 0002_b ]
  [ "$(jq -r '.target.images["mailexpert-backend"]' <<<"$output")" = ok ]
  [ "$(jq -r '.target.commit_found' <<<"$output")" = true ]
  [ "$(jq -r '.next | map(select(startswith("mail node:"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.info | map(select(startswith("migrations:"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.ready' <<<"$output")" = true ]
  [ "$(jq -r '.migrations_applied' <<<"$output")" = 1 ]
  grep -q "manifest inspect ghcr.io/wyrtensi/mailexpert-frontend:sha-${NEW:0:12}" "$DOCKER_LOG"
  ! grep -q "tenant-worker:sha-" "$DOCKER_LOG"
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
