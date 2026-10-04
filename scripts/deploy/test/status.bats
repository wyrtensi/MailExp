#!/usr/bin/env bats
# status.sh and the decisions it shares with update.sh (lib/status.sh): migrations, image tags,
# the steps a version change needs outside update.sh. The full run uses a real git checkout and
# stubs for id, docker and curl.

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

@test "migration_versions keeps .sql files, strips directories and sorts" {
  run migration_versions <<<$'backend/migrations/0002_b.sql\nbackend/migrations/0001_a.sql\nbackend/migrations/README.md\n0003_c.sql'
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

@test "update_notes: nothing for a change inside the panel's images" {
  run update_notes 0 <<<$'backend/src/index.js\nfrontend/src/App.jsx\ndocs/operations/deployment.md'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "update_notes: migrations, mail node scripts, edge image and templates, timers" {
  run update_notes 0 <<<$'backend/migrations/0091_x.sql\nscripts/deploy/mail-node/setup.sh\ndeploy/edge/Dockerfile\ndeploy/edge/Caddyfile.tmpl\ndeploy/systemd/mailexpert-health.timer'
  [[ ${lines[0]} == "migrations: "* ]]
  [[ ${lines[1]} == "mail node: "*"setup.sh --dry-run"* ]]
  [[ ${lines[2]} == "edge: the Caddy image changed"*"EDGE_IMAGE"* ]]
  [[ ${lines[3]} == "edge: its compose file or Caddyfile template changed"* ]]
  [[ ${lines[4]} == "timers: "* ]]
  [ "${#lines[@]}" -eq 5 ]
}

@test "update_notes: the tenant worker note depends on the profile" {
  run update_notes 1 <<<"deploy/tenant-worker/server.mjs"
  [[ $output == "tenant worker: its image changed; update.sh pulls and restarts it"* ]]
  run update_notes 0 <<<"deploy/tenant-worker/server.mjs"
  [[ $output == *"runs no tenant worker"* ]]
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

@test "not root is exit 2" {
  if [ "$(id -u)" = 0 ]; then skip "runs as root"; fi
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ $output == *"run status.sh as root"* ]]
}

# --- a full run against a git checkout, docker and curl stubbed ---

# commit <dir> <message>: commits everything in <dir>, prints the full sha.
commit() {
  git -C "$1" add -A >/dev/null
  git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m "$2"
  git -C "$1" rev-parse HEAD
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
    sql=$(cat)
    case $sql in
      *schema_migrations*) printf '%s\n' $STUB_APPLIED ;;
      *integration_config*) printf '%s\n' "${STUB_SPAM_RULE-ok}" ;;
    esac ;;
  *" info "*) exit 1 ;;
  *" image inspect "*) exit 1 ;;
  *" manifest inspect "*) exit "${STUB_MANIFEST:-0}" ;;
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
  OLD=$(commit "$P/app" one)
  printf 'select 2;\n' >"$P/app/backend/migrations/0002_b.sql"
  mkdir -p "$P/app/scripts/deploy/mail-node"
  printf '#!/bin/sh\n' >"$P/app/scripts/deploy/mail-node/setup.sh"
  NEW=$(commit "$P/app" two)
  git -C "$P/app" checkout -q --detach "$OLD"
  printf '%s\n' "VERSION=sha-${OLD:0:12}" SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-test HTTP_PORT=18090 >"$P/install.conf"
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

@test "--target: pending migrations, mail node note, images checked in the registry" {
  stub_install
  run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.target.pending_migrations | join(",")' <<<"$output")" = 0002_b ]
  [ "$(jq -r '.target.images["mailexpert-backend"]' <<<"$output")" = true ]
  [ "$(jq -r '.target.commit_found' <<<"$output")" = true ]
  [ "$(jq -r '.notes | map(select(startswith("mail node:"))) | length' <<<"$output")" = 1 ]
  [ "$(jq -r '.ready' <<<"$output")" = true ]
  [ "$(jq -r '.migrations_applied' <<<"$output")" = 1 ]
  grep -q "manifest inspect ghcr.io/wyrtensi/mailexpert-frontend:sha-${NEW:0:12}" "$DOCKER_LOG"
  ! grep -q "tenant-worker:sha-" "$DOCKER_LOG"
}

@test "--target: a missing image and a target older than the schema are problems" {
  stub_install
  STUB_MANIFEST=1 STUB_APPLIED=$'0001_a\n0002_b\n0003_c' run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}" --json
  [ "$status" -eq 1 ]
  [ "$(jq -r '.target.unknown_migrations | join(",")' <<<"$output")" = 0003_c ]
  [ "$(jq -r '.problems | map(select(contains("not in the registry"))) | length' <<<"$output")" = 2 ]
  [ "$(jq -r '.problems | map(select(contains("older than the database schema"))) | length' <<<"$output")" = 1 ]
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

@test "a standby server is a note, not a problem, until a target is asked for" {
  stub_install
  : >"$P/state/standby"
  STUB_READY=1 run bash "$SCRIPT" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"note: standby"* ]]
  STUB_READY=1 run bash "$SCRIPT" --prefix "$P" --target "sha-${NEW:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"problem: target: standby server"* ]]
}

@test "update.sh --check runs status.sh --target and changes nothing" {
  stub_install
  run bash "$DEPLOY_DIR/update.sh" --check "sha-${NEW:0:12}" --prefix "$P"
  [ "$status" -eq 0 ]
  [[ $output == *"target               sha-${NEW:0:12}"* ]]
  [[ $output == *"pending_migrations   0002_b"* ]]
  [ "$(git -C "$P/app" rev-parse HEAD)" = "$OLD" ]
  [ ! -e "$P/backups/pre-update-sha-${OLD:0:12}.dump" ]
}
