#!/usr/bin/env bash
# Restores the panel from a restic snapshot on a fresh server, after install.sh --no-start of the
# same version and configure.sh with the restic keys (the recovery key and the S3 keys):
#   - ENCRYPTION_KEY, DB_PASSWORD, SESSION_SECRET and the VAPID pair come from the snapshot in
#     place of the ones install.sh generated here. That is safe only while there is no database:
#     nothing here was encrypted or initialised with them yet, which is why restore.sh refuses
#     to run next to a database volume or containers of the project;
#   - owner secrets this server does not have (Access, Google sign-in, pings, tunnel and DNS
#     tokens) are filled in from the snapshot; the ones set here stay;
#   - so are the tenant worker's settings (COMPOSE_PROFILES, TENANT_*); the snapshot's tenant
#     profile is appended to a COMPOSE_PROFILES this server already has. Its PFX and password file
#     come back from the snapshot to the places those settings name, where this server has none
#     (owner 10001, 0400). A snapshot without them (made before backups held them, or while they
#     were missing on the old server) leaves them to the owner: with the profile on, restore.sh
#     then stops before any change until they are in place;
#   - install.conf, the port and the compose project stay as installed here;
#   - the database is restored and checked (row counts, no pending migration, every credential
#     decrypts), and Redis from a --with-redis snapshot;
#   - install.sh then starts the panel and checks it. --no-start stops before that: a rehearsal
#     must not run a second panel next to the live one (both would sync every mailbox).
#
#   restore.sh latest|<snapshot id> [--prefix /opt/mailexpert] [--host <restic host>] [--no-start]
#
# latest is the newest snapshot of any panel server (each server backs up under its own restic host,
# mailexpert-<hex>; a mail node's mailexpert-node-<hex> snapshots are never picked);
# --host limits the choice to one server's snapshots. The host and time restored are printed.
#
# Exit codes: 0 restored, 1 failure, 2 invalid input or not a fresh server (no data changed).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib/ops.sh
. "$LIB_DIR/ops.sh"
exit_on_unexpected_failure

WORK=''

usage() {
  cat <<'EOF'
Usage: restore.sh latest|<snapshot id> [--prefix /opt/mailexpert] [--host <restic host>] [--no-start]

On a fresh server: install.sh --version <the snapshot's version> --no-start, configure.sh with
RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, then this.
latest       the newest snapshot of any panel server in the repository (never a mail node's)
--host       only snapshots of this restic host (restic snapshots lists them)
--no-start   restore without starting the panel (rehearsal of a move); the server stays standby
Exit codes: 0 restored, 1 failure, 2 invalid input or not a fresh server (no data changed).
EOF
}

# shellcheck disable=SC2317,SC2329 # invoked only through `trap cleanup EXIT` in main, not called directly
cleanup() {
  local status=$?
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  exit "$status"
}

# names <lines>: the lines joined with spaces, "none" when there are none.
names() {
  if [ -z "$1" ]; then echo none; else paste -sd' ' - <<<"$1"; fi
}

# restore_secrets <dir>: generated keys from the snapshot replace this server's; owner secrets
# fill the gaps. Under install.sh's lock, like every other write to .env.
restore_secrets() {
  local files=$1 generated owner tenant edge=''
  take_install_lock "$STATE_DIR" 600 restore.sh
  cp -p "$ENV_FILE" "$ENV_FILE.pre-restore"
  generated=$(merge_restored_keys "$ENV_FILE" "$files/env" overwrite "${GENERATED_SECRET_KEYS[@]}")
  owner=$(merge_restored_keys "$ENV_FILE" "$files/env" fill "${APP_OWNER_KEYS[@]}")
  # COMPOSE_PROFILES first: an empty list here takes the snapshot's, a list without the snapshot's
  # tenant gets it appended (the TENANT_* keys alone would leave the worker off).
  tenant=$(merge_restored_keys "$ENV_FILE" "$files/env" fill COMPOSE_PROFILES)
  if [ -z "$tenant" ]; then tenant=$(add_restored_profile "$ENV_FILE" "$files/env" tenant); fi
  tenant=$(printf '%s\n' "$tenant" "$(merge_restored_keys "$ENV_FILE" "$files/env" fill "${TENANT_KEYS[@]}")" | grep .) || tenant=
  if [ -f "$files/edge.env" ] && [ -f "$EDGE_ENV" ]; then
    edge=$(merge_restored_keys "$EDGE_ENV" "$files/edge.env" fill "${EDGE_OWNER_KEYS[@]}")
  fi
  exec 9>&-
  log "generated keys from the snapshot: $(names "$generated")"
  log "owner secrets from the snapshot: $(names "$owner"); edge: $(names "$edge")"
  log "tenant worker settings from the snapshot: $(names "$tenant")"
  log "the .env from before the restore is kept as $ENV_FILE.pre-restore"
}

# restore_database <dir>: a new database volume with the restored DB_PASSWORD, the dump, and the
# row counts compared with the ones taken at dump time.
restore_database() {
  local files=$1 expected restored
  app_compose up -d --wait --quiet-pull postgres >/dev/null
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  app_compose exec -T postgres sh -c \
    'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' <"$files/db.dump"
  expected=$(<"$files/counts.json")
  restored=$(app_psql <"$LIB_DIR/counts.sql")
  [ "$restored" = "$expected" ] || die "row counts differ after the restore (snapshot: $expected, restored: $restored)"
  log "database restored, rows: $restored"
}

# restore_redis <dir>: dump.rdb of a --with-redis snapshot into the Redis volume before Redis
# first starts (sessions and idempotency keys survive the move).
restore_redis() {
  [ -f "$1/redis.rdb" ] || return 0
  app_compose up --no-start redis >/dev/null
  app_compose cp "$1/redis.rdb" redis:/data/dump.rdb
  log "redis: dump.rdb restored"
}

# check_restored <counts json>: verify-restore.mjs in the backend image against the restored
# database, with the restored ENCRYPTION_KEY: no pending migration, every credential decrypts.
check_restored() {
  local mailboxes result
  mailboxes=$(json_number email_accounts <<<"$1") || mailboxes=0
  export VERIFY_EXPECT_MAILBOX=0
  if [ "$mailboxes" -gt 0 ]; then VERIFY_EXPECT_MAILBOX=1; fi
  result=$(app_compose run --rm --no-deps -T -e VERIFY_EXPECT_MAILBOX \
    -v "$LIB_DIR/verify-restore.mjs:/app/verify-restore.mjs:ro" --entrypoint node backend verify-restore.mjs 2>/dev/null) ||
    die "the restored data failed the check: $result"
  log "restored data: $result"
}

main() {
  local prefix=/opt/mailexpert snapshot='' host='' no_start=0 started files version counts f picked id from at missing placed
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      --host)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--host needs a value" 2; fi
        host=$2
        shift 2
        ;;
      --no-start) no_start=1 && shift ;;
      -h | --help) usage && return 0 ;;
      -*) die "unknown option: $1 (see --help)" 2 ;;
      *)
        if [ -n "$snapshot" ]; then die "one snapshot only" 2; fi
        snapshot=$1
        shift
        ;;
    esac
  done
  [[ $snapshot =~ ^(latest|[0-9a-f]{8,64})$ ]] || die "usage: restore.sh latest|<snapshot id> [--prefix <prefix>] [--host <restic host>] [--no-start]" 2
  if [ -n "$host" ]; then restic_host_ok "$host" || die "--host: not a restic host name" 2; fi
  [ "$(id -u)" = 0 ] || die "run restore.sh as root"
  load_install "$prefix"
  backup_configured "$ENV_FILE" ||
    die "the restic keys are missing in $ENV_FILE: add RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with configure.sh first" 2
  take_lock "$STATE_DIR/update.lock" 60 "update.sh or restore.sh"
  if db_volume_exists; then
    die "volume ${CFG_PROJECT}_postgres_data exists: restore.sh runs only on a server without a database. If it holds nothing you need (for example after a rehearsal), remove it with: docker compose -p $CFG_PROJECT down -v; then run restore.sh again" 2
  fi
  [ -z "$(project_containers)" ] ||
    die "compose project $CFG_PROJECT has containers: restore.sh runs only where the panel never started; if they hold nothing you need: docker compose -p $CFG_PROJECT down -v" 2

  set_standby
  trap cleanup EXIT
  WORK=$STATE_DIR/restore
  rm -rf "$WORK"
  mkdir -m 700 "$WORK"
  load_restic_env
  ensure_image "$RESTIC_IMAGE"
  started=$SECONDS
  picked=$(pick_snapshot "$snapshot" "$host" '' "$PANEL_HOST_RE") || die "restic could not list $snapshot: no such snapshot, or the repository is unreachable"
  [ -n "$picked" ] || die "no snapshot $snapshot${host:+ of host $host} in the repository" 2
  read -r id from at _ <<<"$picked"
  log "restoring snapshot ${id:0:8} of host $from, made at $at"
  restic_run -v "$WORK:/restore" -- restore "$id" --target /restore >/dev/null
  files=$WORK/backup
  for f in db.dump counts.json env install.conf; do
    [ -f "$files/$f" ] || die "snapshot $snapshot has no $f"
  done
  version=$(env_get "$files/install.conf" VERSION) || version=
  [ "$version" = "$CFG_VERSION" ] ||
    die "the snapshot was made by $version, this server has $CFG_VERSION: run install.sh --prefix $OPT_PREFIX --version $version --no-start, then restore.sh again" 2

  placed=$(place_tenant_files "$files" "$ENV_FILE" "$files/env" "$APP_DIR")
  if [ -n "$placed" ]; then log "tenant worker files from the snapshot: $(names "$placed")"; fi
  missing=$(tenant_files_missing "$ENV_FILE" "$files/env" "$APP_DIR")
  [ -z "$missing" ] ||
    die "the tenant worker is on (COMPOSE_PROFILES=tenant), this server lacks $(names "$missing") and the snapshot does not hold them (made before backups included them, or they were missing when it was made): copy the certificate and its password file there from where you keep them (docs/operations/mail-node.md, section 6e), owner $TENANT_WORKER_UID, mode 0400, then run restore.sh again" 2
  restore_secrets "$files"
  restore_database "$files"
  restore_redis "$files"
  counts=$(<"$files/counts.json")
  check_restored "$counts"
  rm -rf "$WORK"
  WORK=''
  log "snapshot ${id:0:8} of host $from ($at) restored in $((SECONDS - started))s"
  if [ "$no_start" = 1 ]; then
    # Never point to install.sh here: a panel started from a rehearsal would back up into the
    # shared repository next to the live one.
    log "standby: the panel is not started (--no-start). After a rehearsal remove it: docker compose -p $CFG_PROJECT down -v"
    log "for the move itself, once the old server is frozen and its final backup made: $APP_DIR/scripts/deploy/restore.sh <snapshot of the move> --prefix $OPT_PREFIX"
    return 0
  fi
  bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX"
  log "restore done in $((SECONDS - started))s"
}

main "$@"; exit $?
