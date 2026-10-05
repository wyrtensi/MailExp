#!/usr/bin/env bats
# What backup.sh puts into the snapshot next to the dump: the real backup CLI with a synthetic
# dump and a docker stub that copies the staging directory restic is given (CAPTURE) before
# backup.sh removes it. Synthetic tenant files stand in for the PFX and its password.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  if [ "$(id -u)" != 0 ]; then skip "needs root"; fi
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/state" "$P/backups" "$P/app" "$BATS_TEST_TMPDIR/bin"
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-files-test HTTP_PORT=18090 SYSTEM=0 REPO_URL=https://github.com/wyrtensi/MailExpert.git >"$P/install.conf"
  printf '%s\n' RESTIC_REPOSITORY=s3:https://s3.example.com/backups RESTIC_PASSWORD=test-only \
    AWS_ACCESS_KEY_ID=test-only AWS_SECRET_ACCESS_KEY=test-only BACKUP_PING_URL=https://hc.example.com/ping/backup >"$P/.env"
  chmod 600 "$P/.env"
  cat >"$BATS_TEST_TMPDIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *:/out)
      printf 'synthetic dump\n' >"${arg%:/out}/db.dump"
      printf '{"schema_migrations":1}\n' >"${arg%:/out}/counts.json"
      ;;
    *:/backup:ro)
      mkdir -p "$CAPTURE"
      cp -a "${arg%:/backup:ro}/." "$CAPTURE/"
      ;;
  esac
done
case " $* " in
  *" backup --json "*) printf '{"message_type":"summary","snapshot_id":"0123456789abcdef"}\n' ;;
esac
exit 0
STUB
  # curl: each ping as one line in PING_LOG, "<url> <body>".
  cat >"$BATS_TEST_TMPDIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
url=''
while [ $# -gt 0 ]; do
  if [ "$1" = -K ]; then url=$(sed -n 's/^url = "\(.*\)"$/\1/p' "$2"); shift; fi
  shift
done
printf '%s %s\n' "$url" "$(cat)" >>"$PING_LOG"
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker" "$BATS_TEST_TMPDIR/bin/curl"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH" CAPTURE=$BATS_TEST_TMPDIR/capture PING_LOG=$BATS_TEST_TMPDIR/ping.log
  export MAILEXPERT_BACKUP_LOCK_TIMEOUT=0
}

PFX_CONTENT=synthetic-pfx-bytes
PASSWORD_CONTENT=synthetic-pfx-password

# tenant_on [cert dir] [password file]: the profile and the paths in .env (none: compose's
# defaults), the files in place as mail-node.md 6e lays them out (owner 10001, 0400 in 0500).
tenant_on() {
  local cert=${1:-$P/app/tenant-cert} pass=${2:-$P/app/tenant-secrets/app.pfx.password}
  printf '%s\n' COMPOSE_PROFILES=tenant TENANT_WORKER_URL=http://tenant-worker:8080 >>"$P/.env"
  if [ $# -gt 0 ]; then printf '%s\n' "TENANT_CERT_DIR=$1" "TENANT_PFX_PASSWORD_FILE=$2" >>"$P/.env"; fi
  mkdir -p "$cert" "$(dirname "$pass")"
  printf '%s' "$PFX_CONTENT" >"$cert/app.pfx"
  printf '%s' "$PASSWORD_CONTENT" >"$pass"
  chown 10001:0 "$cert/app.pfx" "$pass" "$cert" "$(dirname "$pass")"
  chmod 0400 "$cert/app.pfx" "$pass"
  chmod 0500 "$cert" "$(dirname "$pass")"
}

@test "the tenant profile on: the PFX and its password file go into the snapshot, root 0600" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  [ -f "$CAPTURE/db.dump" ] && [ -f "$CAPTURE/env" ] && [ -f "$CAPTURE/install.conf" ]
  cmp -s "$CAPTURE/tenant/app.pfx" "$BATS_TEST_TMPDIR/certs/app.pfx"
  cmp -s "$CAPTURE/tenant/app.pfx.password" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  [ "$(stat -c '%u %g %a' "$CAPTURE/tenant/app.pfx")" = '0 0 600' ]
  [ "$(stat -c '%u %g %a' "$CAPTURE/tenant/app.pfx.password")" = '0 0 600' ]
  [ "$(stat -c '%u %g %a' "$CAPTURE/tenant")" = '0 0 700' ]
  [[ $output == *"tenant: app.pfx added"* && $output == *"tenant: app.pfx.password added"* ]]
  [[ $output != *"$PFX_CONTENT"* && $output != *"$PASSWORD_CONTENT"* ]]
  # The originals stay as they were.
  [ "$(stat -c '%u %a' "$BATS_TEST_TMPDIR/certs/app.pfx")" = '10001 400' ]
}

@test "compose's default paths resolve against the checkout" {
  tenant_on
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  cmp -s "$CAPTURE/tenant/app.pfx" "$P/app/tenant-cert/app.pfx"
  cmp -s "$CAPTURE/tenant/app.pfx.password" "$P/app/tenant-secrets/app.pfx.password"
}

@test "the profile on and the password file missing: a warning naming the key, the backup goes on" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  rm -f "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  [[ $output == *"warning: tenant:"*"$BATS_TEST_TMPDIR/secrets/app.pfx.password (TENANT_PFX_PASSWORD_FILE) is missing"* ]]
  [ -f "$CAPTURE/tenant/app.pfx" ]
  [ ! -e "$CAPTURE/tenant/app.pfx.password" ]
  [ -f "$CAPTURE/db.dump" ]
}

@test "the profile off: no tenant files in the snapshot, even with the files on disk" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  sed -i 's/^COMPOSE_PROFILES=tenant$/COMPOSE_PROFILES=/' "$P/.env"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  [ -f "$CAPTURE/env" ]
  [ ! -e "$CAPTURE/tenant" ]
  [[ $output != *tenant:* ]]
}

@test "a local dump only (no restic keys): the tenant files are never copied" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  sed -i '/^RESTIC_\|^AWS_/d' "$P/.env"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump"
  [ "$status" -eq 0 ]
  [ -f "$P/kept.dump" ]
  [ ! -e "$CAPTURE" ]
  # stage_tenant_files logs every file it copies ("tenant: app.pfx added"): none may appear.
  [[ $output != *tenant:* ]]
}

@test "a move backup with a tenant file missing fails: fail ping, the server does not turn standby" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  rm -f "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag move
  [ "$status" -eq 1 ]
  [[ $output == *"$BATS_TEST_TMPDIR/secrets/app.pfx.password (TENANT_PFX_PASSWORD_FILE)"* ]]
  [ ! -e "$P/state/standby" ]
  [ ! -e "$CAPTURE" ]
  grep -q '^https://hc.example.com/ping/backup/fail ' "$PING_LOG"
  run grep -c '^https://hc.example.com/ping/backup ' "$PING_LOG"
  [ "$output" = 0 ]
}

@test "a move backup with both tenant files succeeds and turns the server standby" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag move
  [ "$status" -eq 0 ]
  [ -f "$CAPTURE/tenant/app.pfx" ] && [ -f "$CAPTURE/tenant/app.pfx.password" ]
  [ -e "$P/state/standby" ]
}

@test "another tag with a tenant file missing: the success ping carries the warning" {
  tenant_on "$BATS_TEST_TMPDIR/certs" "$BATS_TEST_TMPDIR/secrets/app.pfx.password"
  rm -f "$BATS_TEST_TMPDIR/certs/app.pfx"
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  grep -q "^https://hc.example.com/ping/backup snapshot 01234567 (manual): .*warning: tenant profile on, missing and not in this snapshot: $BATS_TEST_TMPDIR/certs/app.pfx (TENANT_CERT_DIR)\$" "$PING_LOG"
  [ ! -e "$CAPTURE/tenant/app.pfx" ]
}
