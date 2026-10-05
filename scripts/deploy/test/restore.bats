#!/usr/bin/env bats
# restore.sh: a panel snapshot onto a fresh server. Full runs against a synthetic prefix with a
# docker stub that answers restic (the snapshot list, the restore into the work directory from a
# fixture), compose and psql; --no-start, so install.sh never runs.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  SCRIPT=$DEPLOY_DIR/restore.sh
}

COUNTS='{"schema_migrations" : 90, "users" : 1, "email_accounts" : 0, "google_oauth_apps" : 0}'
TOKEN=tenant-token-0123456789abcdef0123456789abcdef

stub_restore() {
  if [ "$(id -u)" != 0 ]; then skip "needs root"; fi
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case " $* " in
  *" volume inspect "*) exit 1 ;;
  *" snapshots --json "*)
    printf '[{"id":"%s","hostname":"mailexpert-0123456789abcdef","time":"2026-10-01T03:30:00Z","tags":["nightly"]}]\n' \
      0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    ;;
  *" restore "*" --target /restore "*)
    prev=''
    for arg in "$@"; do
      if [ "$prev" = -v ] && [[ $arg == *:/restore ]]; then
        mkdir -p "${arg%:/restore}/backup"
        cp -a "$SNAPSHOT/." "${arg%:/restore}/backup/"
      fi
      prev=$arg
    done
    ;;
  *"pg_restore"*) cat >/dev/null ;;
  *" exec -T postgres "*) cat >/dev/null && printf '%s\n' "$COUNTS" ;;
  *"verify-restore.mjs"*) printf '{"ok":true}\n' ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/docker"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log COUNTS

  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/app/scripts/deploy" "$P/state" "$P/edge"
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-test HTTP_PORT=18090 SYSTEM=0 "REPO_URL=$P/app" >"$P/install.conf"
  # What install.sh --no-start and configure.sh (the restic keys only) leave on the new server.
  printf '%s\n' SESSION_SECRET=new-session ENCRYPTION_KEY=new-key DB_PASSWORD=new-db \
    RESTIC_REPOSITORY=s3:https://s3.example.com/backups/panel RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key >"$P/.env"
  chmod 600 "$P/.env"

  # The snapshot: the old server's .env with the tenant worker configured (mail-node.md, 6e).
  export SNAPSHOT=$BATS_TEST_TMPDIR/snapshot
  mkdir -p "$SNAPSHOT"
  printf '%s\n' SESSION_SECRET=old-session ENCRYPTION_KEY=old-key DB_PASSWORD=old-db \
    RESTIC_REPOSITORY=s3:https://s3.example.com/backups/panel RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key \
    COMPOSE_PROFILES=tenant TENANT_WORKER_URL=http://tenant-worker:8080 "TENANT_WORKER_TOKEN=$TOKEN" \
    "TENANT_CERT_DIR=$P/tenant-cert" "TENANT_PFX_PASSWORD_FILE=$P/tenant-secrets/app.pfx.password" \
    TENANT_ID=00000000-0000-0000-0000-000000000001 TENANT_APP_ID=00000000-0000-0000-0000-000000000002 \
    TENANT_ORGANIZATION=example.onmicrosoft.com >"$SNAPSHOT/env"
  printf '%s\n' VERSION=sha-0123456789ab >"$SNAPSHOT/install.conf"
  printf 'PGDMP' >"$SNAPSHOT/db.dump"
  printf '%s\n' "$COUNTS" >"$SNAPSHOT/counts.json"
}

# tenant_files: the certificate and its password where the snapshot's .env points (the owner
# copied them there: the snapshot below, like one made before backups held them, has none).
tenant_files() {
  mkdir -p "$P/tenant-cert" "$P/tenant-secrets"
  printf 'pfx' >"$P/tenant-cert/app.pfx"
  printf 'password' >"$P/tenant-secrets/app.pfx.password"
}

@test "the tenant worker's settings come back from the snapshot" {
  stub_restore
  tenant_files
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" COMPOSE_PROFILES)" = tenant ]
  [ "$(env_get "$P/.env" TENANT_WORKER_URL)" = http://tenant-worker:8080 ]
  [ "$(env_get "$P/.env" TENANT_WORKER_TOKEN)" = "$TOKEN" ]
  [ "$(env_get "$P/.env" TENANT_CERT_DIR)" = "$P/tenant-cert" ]
  [ "$(env_get "$P/.env" TENANT_PFX_PASSWORD_FILE)" = "$P/tenant-secrets/app.pfx.password" ]
  [ "$(env_get "$P/.env" TENANT_ID)" = 00000000-0000-0000-0000-000000000001 ]
  [ "$(env_get "$P/.env" TENANT_APP_ID)" = 00000000-0000-0000-0000-000000000002 ]
  [ "$(env_get "$P/.env" TENANT_ORGANIZATION)" = example.onmicrosoft.com ]
  [ "$(env_get "$P/.env" ENCRYPTION_KEY)" = old-key ]
  [[ $output == *"tenant worker settings from the snapshot: COMPOSE_PROFILES TENANT_WORKER_URL TENANT_WORKER_TOKEN"* ]]
  [[ $output != *"$TOKEN"* ]]
  [ "$(stat -c %a "$P/.env")" = 600 ]
}

@test "tenant settings this server has stay" {
  stub_restore
  tenant_files
  printf '%s\n' TENANT_WORKER_TOKEN=set-here-0123456789abcdef0123456789abcdef >>"$P/.env"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" TENANT_WORKER_TOKEN)" = set-here-0123456789abcdef0123456789abcdef ]
  [ "$(env_get "$P/.env" TENANT_WORKER_URL)" = http://tenant-worker:8080 ]
}

@test "other profiles on this server: tenant is added to them, and its files are required" {
  stub_restore
  printf '%s\n' COMPOSE_PROFILES=extra >>"$P/.env"
  cp -p "$P/.env" "$BATS_TEST_TMPDIR/env.before"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 2 ]
  [[ $output == *"$P/tenant-cert/app.pfx"* ]]
  cmp -s "$P/.env" "$BATS_TEST_TMPDIR/env.before"
  tenant_files
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" COMPOSE_PROFILES)" = extra,tenant ]
  [ "$(env_get "$P/.env" TENANT_WORKER_URL)" = http://tenant-worker:8080 ]
  [[ $output == *"tenant worker settings from the snapshot: COMPOSE_PROFILES TENANT_WORKER_URL"* ]]
  [[ $output != *"$TOKEN"* ]]
}

@test "the tenant profile without its certificate here: exit 2 before anything changes" {
  stub_restore
  cp -p "$P/.env" "$BATS_TEST_TMPDIR/env.before"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 2 ]
  [[ $output == *"$P/tenant-cert/app.pfx"* && $output == *"$P/tenant-secrets/app.pfx.password"* ]]
  [[ $output != *"$TOKEN"* ]]
  cmp -s "$P/.env" "$BATS_TEST_TMPDIR/env.before"
  run grep -q pg_restore "$DOCKER_LOG"
  [ "$status" -eq 1 ]
  # Compose's defaults are relative to the checkout.
  sed -i '/^TENANT_CERT_DIR=/d; /^TENANT_PFX_PASSWORD_FILE=/d' "$SNAPSHOT/env"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 2 ]
  [[ $output == *"$P/app/tenant-cert/app.pfx"* && $output == *"$P/app/tenant-secrets/app.pfx.password"* ]]
}

@test "a snapshot without the tenant worker restores as before" {
  stub_restore
  sed -i '/^COMPOSE_PROFILES=/d; /^TENANT_/d' "$SNAPSHOT/env"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  run env_get "$P/.env" COMPOSE_PROFILES
  [ "$status" -eq 1 ]
  [ "$(env_get "$P/.env" ENCRYPTION_KEY)" = old-key ]
}

PFX_CONTENT=synthetic-pfx-bytes
PASSWORD_CONTENT=synthetic-pfx-password

# snapshot_tenant_files [name...]: the PFX and its password in the snapshot, where backup.sh
# stages them (tenant/app.pfx, tenant/app.pfx.password); both by default.
snapshot_tenant_files() {
  local which=("$@") f
  if [ ${#which[@]} -eq 0 ]; then which=(app.pfx app.pfx.password); fi
  mkdir -p "$SNAPSHOT/tenant"
  for f in "${which[@]}"; do
    case $f in
      app.pfx) printf '%s' "$PFX_CONTENT" >"$SNAPSHOT/tenant/app.pfx" ;;
      app.pfx.password) printf '%s' "$PASSWORD_CONTENT" >"$SNAPSHOT/tenant/app.pfx.password" ;;
    esac
  done
}

@test "the snapshot's PFX and password file go to the configured paths, owner 10001, 0400 in 0500" {
  stub_restore
  snapshot_tenant_files
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  cmp -s "$P/tenant-cert/app.pfx" "$SNAPSHOT/tenant/app.pfx"
  cmp -s "$P/tenant-secrets/app.pfx.password" "$SNAPSHOT/tenant/app.pfx.password"
  [ "$(stat -c '%u %g %a' "$P/tenant-cert/app.pfx")" = '10001 0 400' ]
  [ "$(stat -c '%u %g %a' "$P/tenant-secrets/app.pfx.password")" = '10001 0 400' ]
  [ "$(stat -c '%u %g %a' "$P/tenant-cert")" = '10001 0 500' ]
  [ "$(stat -c '%u %g %a' "$P/tenant-secrets")" = '10001 0 500' ]
  [[ $output == *"tenant worker files from the snapshot: $P/tenant-cert/app.pfx $P/tenant-secrets/app.pfx.password"* ]]
  [[ $output != *"$PFX_CONTENT"* && $output != *"$PASSWORD_CONTENT"* && $output != *"$TOKEN"* ]]
  grep -q pg_restore "$DOCKER_LOG"
}

@test "tenant files this server has stay; only the missing one comes from the snapshot" {
  stub_restore
  snapshot_tenant_files
  mkdir -p "$P/tenant-cert"
  printf 'pfx-set-here' >"$P/tenant-cert/app.pfx"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  [ "$(cat "$P/tenant-cert/app.pfx")" = pfx-set-here ]
  cmp -s "$P/tenant-secrets/app.pfx.password" "$SNAPSHOT/tenant/app.pfx.password"
  [ "$(stat -c '%u %a' "$P/tenant-secrets/app.pfx.password")" = '10001 400' ]
  [[ $output == *"tenant worker files from the snapshot: $P/tenant-secrets/app.pfx.password"* ]]
}

@test "the snapshot's tenant files with compose's default paths land in the checkout" {
  stub_restore
  snapshot_tenant_files
  sed -i '/^TENANT_CERT_DIR=/d; /^TENANT_PFX_PASSWORD_FILE=/d' "$SNAPSHOT/env"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  cmp -s "$P/app/tenant-cert/app.pfx" "$SNAPSHOT/tenant/app.pfx"
  cmp -s "$P/app/tenant-secrets/app.pfx.password" "$SNAPSHOT/tenant/app.pfx.password"
  [ "$(stat -c '%u %a' "$P/app/tenant-cert")" = '10001 500' ]
}

@test "a snapshot with only one of the tenant files: nothing placed, exit 2 naming the path" {
  stub_restore
  snapshot_tenant_files app.pfx
  cp -p "$P/.env" "$BATS_TEST_TMPDIR/env.before"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 2 ]
  [[ $output == *"$P/tenant-secrets/app.pfx.password"* ]]
  [ ! -e "$P/tenant-cert" ] && [ ! -e "$P/tenant-secrets" ]
  cmp -s "$P/.env" "$BATS_TEST_TMPDIR/env.before"
}

@test "the snapshot's tenant files are not placed when the tenant profile is off everywhere" {
  stub_restore
  snapshot_tenant_files
  sed -i '/^COMPOSE_PROFILES=/d' "$SNAPSHOT/env"
  run bash "$SCRIPT" latest --prefix "$P" --no-start
  [ "$status" -eq 0 ]
  [ ! -e "$P/tenant-cert" ] && [ ! -e "$P/tenant-secrets" ]
}
