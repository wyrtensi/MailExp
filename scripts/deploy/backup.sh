#!/usr/bin/env bash
# Backs up the panel into the restic repository named in .env (any S3-compatible storage): a
# pg_dump with the row counts taken in the same database snapshot, plus .env, edge/.env and
# install.conf, which hold the keys that make the dump usable, and, with the tenant profile on,
# the tenant worker's PFX and its password file: everything restore.sh needs on a fresh server.
# restic encrypts the repository with RESTIC_PASSWORD, kept on the server and by the owner (the
# recovery key).
#
# Nightly by mailexpert-backup.timer; by hand; by update.sh (--tag pre-update --keep-dump); before
# a move, once the panel is stopped (--with-redis --tag move; the server then turns standby, see
# mark_moved_away). Pings BACKUP_PING_URL (or HEALTHCHECK_PING_URL) at the start, on success and
# on failure.
#
# Exit codes: 0 done (or skipped on a standby server), 1 failure, 2 invalid input.
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

# How long to wait for the locks (take_backup_locks): another backup.sh (update.sh's pre-update
# backup may meet a nightly one), an update, a rollback, a restore, install.sh or configure.sh.
LOCK_TIMEOUT=${MAILEXPERT_BACKUP_LOCK_TIMEOUT:-3600}
SCRATCH_IMAGE=postgres:16-alpine
PING_URL='' STARTED=0 STAGING='' VERIFY_DIR='' VERIFY_CONTAINER='' VERIFY_SECONDS=''
BACKUP_FD='' UPDATE_FD='' INSTALL_FD='' UPDATE_INHERITED=0

usage() {
  cat <<'EOF'
Usage: backup.sh [--prefix /opt/mailexpert] [--tag nightly] [--verify] [--with-redis]
                 [--keep-dump <absolute path>]
       backup.sh [--prefix /opt/mailexpert] --show-recovery-key

--tag           restic tag: nightly (default, the timer), manual, pre-update, move, ...;
                after a successful move backup this server turns standby (its timers stop)
--verify        after the backup, restore it into a scratch database and check it; the nightly
                backup does this on Sundays and a restic check of 5% of the data on other days
--with-redis    also Redis (sessions, idempotency keys): for a move, once the panel is stopped
--keep-dump     also keep the database dump at this path (update.sh); without the restic keys
                only this local dump is made
--show-recovery-key
                print RESTIC_REPOSITORY and RESTIC_PASSWORD to store them outside the server
Exit codes: 0 done or skipped on a standby server, 1 failure, 2 invalid input.
EOF
}

# shellcheck disable=SC2317,SC2329 # invoked only through `trap finish EXIT` in main, not called directly
finish() {
  local status=$?
  if [ -n "$VERIFY_CONTAINER" ]; then docker rm -fv "$VERIFY_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$VERIFY_DIR" ]; then rm -rf "$VERIFY_DIR"; fi
  if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ "$status" != 0 ] && [ "$STARTED" = 1 ]; then
    send_ping "$PING_URL" fail "backup.sh failed with exit $status; see journalctl -u mailexpert-backup"
  fi
  exit "$status"
}

# Locks. backup.lock: one backup.sh at a time, held to the end (the staging directory and the
# restic repository are shared). update.lock and install.lock: held only for the capture, while
# the database is dumped and .env, edge/.env, install.conf and the tenant files are copied next
# to the dump, so the snapshot never mixes a schema or keys that update.sh, rollback.sh,
# restore.sh, install.sh or configure.sh are changing. They are released before the upload, the retention and the checks,
# which can take hours: an installer (the updater's automatic rollback among them) then waits
# only for a dump. update.lock is held shared, so lock_held, which the health check, the updater
# and status.sh ask, does not mistake a backup for an update.
#
# take_backup_locks: all three or none, polled once a second for up to LOCK_TIMEOUT. A backup
# never holds one of them while it waits for another: update.sh holds update.lock while its
# pre-update backup waits for backup.lock, so a nightly backup that sat on backup.lock waiting
# for update.lock would block that update. The pre-update backup does not open update.lock again
# (it would wait for its own parent): it uses the descriptor update.sh hands over in
# MAILEXPERT_UPDATE_LOCK_FD, checked to be this installation's update.lock, and never unlocks it.
# Status 1 when the wait ran out.
take_backup_locks() {
  local waited=0 fd=${MAILEXPERT_UPDATE_LOCK_FD:-}
  command -v flock >/dev/null || die "flock is required"
  if [ -n "$fd" ]; then
    [[ $fd =~ ^[0-9]+$ ]] || die "invalid inherited update lock descriptor" 2
    [ "$STATE_DIR/update.lock" -ef "/proc/self/fd/$fd" ] ||
      die "inherited update lock descriptor does not match this installation" 2
    # Exclusive on the parent's own open file description: a no-op while the parent holds it.
    flock -n "$fd" || die "inherited update lock is unavailable"
    UPDATE_FD=$fd UPDATE_INHERITED=1
  else
    exec {UPDATE_FD}>"$STATE_DIR/update.lock"
  fi
  exec {BACKUP_FD}>"$STATE_DIR/backup.lock"
  exec {INSTALL_FD}>"$STATE_DIR/install.lock"
  until try_backup_locks; do
    if [ "$waited" -eq 0 ]; then log "waiting for another backup, an update, a rollback, a restore, install.sh or configure.sh to finish"; fi
    [ "$waited" -lt "$LOCK_TIMEOUT" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# try_backup_locks: one attempt at all three locks; on failure the ones it got are released.
try_backup_locks() {
  flock -n "$BACKUP_FD" || return 1
  if [ "$UPDATE_INHERITED" = 1 ] || flock -n -s "$UPDATE_FD"; then
    if flock -n -s "$INSTALL_FD"; then return 0; fi
    if [ "$UPDATE_INHERITED" = 0 ]; then flock -u "$UPDATE_FD"; fi
  fi
  flock -u "$BACKUP_FD"
  return 1
}

# release_capture_locks: update.lock and install.lock go once the capture is staged; closed too,
# so the restic containers do not inherit them. An inherited update.lock stays with update.sh.
release_capture_locks() {
  flock -u "$INSTALL_FD"
  exec {INSTALL_FD}>&-
  if [ "$UPDATE_INHERITED" = 0 ]; then
    flock -u "$UPDATE_FD"
    exec {UPDATE_FD}>&-
  fi
}

# stage_files <dir> <with redis 0|1>: what goes into the snapshot next to the dump.
stage_files() {
  local dir=$1
  cp -p "$ENV_FILE" "$dir/env"
  if [ -f "$EDGE_ENV" ]; then cp -p "$EDGE_ENV" "$dir/edge.env"; fi
  cp -p "$OPT_PREFIX/install.conf" "$dir/install.conf"
  stage_tenant_files "$dir" "$ENV_FILE" "$APP_DIR"
  if [ "$2" = 1 ]; then
    app_compose exec -T redis redis-cli SAVE >/dev/null
    app_compose cp redis:/data/dump.rdb "$dir/redis.rdb"
    chmod 600 "$dir/redis.rdb"
    log "redis: dump.rdb added"
  fi
}

# forget_old <weekday> <tag>: the last 5 pre-update snapshots; otherwise 7 daily, 4 weekly and 6
# monthly, and every pre-update and move snapshot outside that policy. Only this server's own
# snapshots (--host), so a server never thins out another one's history in a shared repository.
# The nightly run on Sunday also prunes, which frees the space of forgotten snapshots.
forget_old() {
  local -a prune=()
  if prune_today "$1" "$2"; then prune=(--prune); fi
  restic_run -- forget --host "$RESTIC_HOST" --tag pre-update --keep-last 5 >/dev/null
  restic_run -- forget --host "$RESTIC_HOST" --keep-daily 7 --keep-weekly 4 --keep-monthly 6 \
    --keep-tag pre-update --keep-tag move "${prune[@]}" >/dev/null
}

wait_scratch_db() {
  for _ in $(seq 60); do
    if docker exec "$VERIFY_CONTAINER" pg_isready -q -h 127.0.0.1 -U mailexpert -d mailexpert; then return 0; fi
    sleep 1
  done
  die "verify: the scratch database did not start in 60s"
}

# verify_snapshot <snapshot>: the snapshot restored into a scratch PostgreSQL without network,
# its row counts compared with the ones taken at dump time, then the backend image of this
# version run against it: no migration may be pending, and every stored credential must decrypt
# with ENCRYPTION_KEY from the same snapshot. Only counts are printed. Sets VERIFY_SECONDS, the
# restore time: the main part of the downtime of a move.
verify_snapshot() {
  local snapshot=$1 id files expected restored key mailboxes expect=0 result started
  id=$(gen_hex 4)
  VERIFY_DIR=$BACKUP_DIR/verify-$id
  VERIFY_CONTAINER=$CFG_PROJECT-verify-$id
  mkdir -m 700 "$VERIFY_DIR"
  mkdir -m 700 "$VERIFY_DIR/data" "$VERIFY_DIR/files"
  restic_run -v "$VERIFY_DIR/files:/restore" -- restore "$snapshot" --target /restore \
    --include /backup/env --include /backup/counts.json >/dev/null
  files=$VERIFY_DIR/files/backup
  expected=$(<"$files/counts.json")
  key=$(env_get "$files/env" ENCRYPTION_KEY) || key=
  [ -n "$key" ] || die "verify: the snapshot has no ENCRYPTION_KEY in its .env"
  ensure_image "$SCRATCH_IMAGE"
  docker run -d --name "$VERIFY_CONTAINER" --label "mailexpert.verify=$CFG_PROJECT" --network none \
    -e POSTGRES_USER=mailexpert -e POSTGRES_DB=mailexpert -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$VERIFY_DIR/data:/var/lib/postgresql/data" "$SCRATCH_IMAGE" >/dev/null
  wait_scratch_db
  started=$SECONDS
  restic_run -- dump "$snapshot" /backup/db.dump |
    docker exec -i "$VERIFY_CONTAINER" pg_restore -U mailexpert -d mailexpert --no-owner --exit-on-error --single-transaction
  VERIFY_SECONDS=$((SECONDS - started))
  restored=$(docker exec -i "$VERIFY_CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U mailexpert -d mailexpert <"$LIB_DIR/counts.sql")
  [ "$restored" = "$expected" ] || die "verify: row counts differ after the restore (dump: $expected, restored: $restored)"
  mailboxes=$(json_number email_accounts <<<"$expected") || mailboxes=0
  if [ "$mailboxes" -gt 0 ]; then expect=1; fi
  result=$(ENCRYPTION_KEY=$key VERIFY_EXPECT_MAILBOX=$expect docker run --rm --network "container:$VERIFY_CONTAINER" \
    -e ENCRYPTION_KEY -e VERIFY_EXPECT_MAILBOX -e DB_HOST=127.0.0.1 -e DB_USER=mailexpert -e DB_NAME=mailexpert \
    -v "$LIB_DIR/verify-restore.mjs:/app/verify-restore.mjs:ro" --entrypoint node "$BACKEND_IMAGE" verify-restore.mjs) ||
    die "verify: the restored data failed the check: $result"
  log "verify: restored in ${VERIFY_SECONDS}s, counts match, $result"
}

main() {
  local prefix=/opt/mailexpert tag=nightly verify=0 redis=0 keep='' show_key=0 local_only=0
  local started seconds bytes counts snapshot weekday checks ping_note=''
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix | --tag | --keep-dump)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        case $1 in
          --prefix) prefix=$2 ;;
          --tag) tag=$2 ;;
          --keep-dump) keep=$2 ;;
        esac
        shift 2
        ;;
      --verify) verify=1 && shift ;;
      --with-redis) redis=1 && shift ;;
      --show-recovery-key) show_key=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  backup_tag_ok "$tag" || die "--tag must be lowercase letters, digits and '-'" 2
  if [ -n "$keep" ] && [[ ! $keep =~ ^/[A-Za-z0-9._/-]+$ ]]; then die "--keep-dump needs an absolute path without spaces" 2; fi
  [ "$(id -u)" = 0 ] || die "run backup.sh as root"
  load_install "$prefix"

  if [ "$show_key" = 1 ]; then
    backup_configured "$ENV_FILE" || die "backups are not configured, so there is no recovery key" 2
    print_recovery_key
    : >"$STATE_DIR/recovery-key.shown"
    return 0
  fi
  if is_standby; then
    log "standby server (install.sh --no-start or restore.sh): backup skipped"
    return 0
  fi
  if ! take_backup_locks; then
    # A skipped backup is a failed one for the monitoring (unless it was only a local dump).
    if backup_configured "$ENV_FILE" || [ -z "$keep" ]; then
      send_ping "$(backup_ping_url)" fail "backup.sh gave up after ${LOCK_TIMEOUT}s waiting for another backup, an update, a rollback, a restore, install.sh or configure.sh"
    fi
    die "gave up after ${LOCK_TIMEOUT}s waiting for another backup, an update, a rollback, a restore, install.sh or configure.sh"
  fi
  # The capture: an installation may have changed the version, the images and .env while the
  # backup waited. Nothing below may change until release_capture_locks.
  load_install "$prefix"
  if is_standby; then
    log "standby server: backup skipped"
    return 0
  fi
  trap finish EXIT
  PING_URL=$(backup_ping_url)
  if ! backup_configured "$ENV_FILE" && [ -n "$keep" ]; then
    warn "backups are not configured: only the local dump $keep is made"
    local_only=1
  else
    send_ping "$PING_URL" start
    STARTED=1
    backup_configured "$ENV_FILE" ||
      die "backups are not configured: add RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with configure.sh, then run install.sh"
  fi

  mkdir -p "$BACKUP_DIR"
  STAGING=$BACKUP_DIR/staging
  rm -rf "$STAGING"
  mkdir -m 700 "$STAGING"
  started=$SECONDS
  dump_database "$STAGING"
  seconds=$((SECONDS - started))
  bytes=$(stat -c %s "$STAGING/db.dump")
  counts=$(<"$STAGING/counts.json")
  log "database dumped in ${seconds}s, $bytes bytes, rows: $counts"
  if [ -n "$keep" ]; then
    cp -p "$STAGING/db.dump" "$keep"
    log "dump kept at $keep"
  fi
  [ "$local_only" = 0 ] || return 0

  stage_files "$STAGING" "$redis"
  if [ -n "$TENANT_STAGE_MISSING" ]; then
    # The move's snapshot is the one the new server restores: without these files its tenant
    # worker cannot start. Fail before the upload, so this server stays active.
    if [ "$tag" = move ]; then
      die "move: the tenant profile is on and $TENANT_STAGE_MISSING missing here: put the files back (docs/operations/mail-node.md, section 6e) or turn the profile off, then run the move backup again; this server stays active"
    fi
    ping_note="; warning: tenant profile on, missing and not in this snapshot: $TENANT_STAGE_MISSING"
  fi
  load_restic_env
  load_restic_host mailexpert
  release_capture_locks
  log "database and files captured; updates and installations may run again"
  ensure_image "$RESTIC_IMAGE"
  snapshot=$(restic_run -v "$STAGING:/backup:ro" -- backup --json --host "$RESTIC_HOST" --tag "$tag" /backup |
    jq -r 'select(.message_type == "summary") | .snapshot_id')
  [ -n "$snapshot" ] || die "restic reported no snapshot"
  log "snapshot ${snapshot:0:8} stored (tag $tag)"
  weekday=$(date +%u)
  forget_old "$weekday" "$tag"
  checks=$(backup_checks "$weekday" "$tag" "$verify")
  case $checks in
    verify) verify_snapshot "$snapshot" ;;
    check)
      restic_run -- check --read-data-subset=5% >/dev/null
      log "restic check of 5% of the data passed"
      ;;
  esac
  write_backup_last "$snapshot" "$tag" "$bytes" "$seconds" "$counts" "$VERIFY_SECONDS"
  send_ping "$PING_URL" success "snapshot ${snapshot:0:8} ($tag): dump $bytes bytes in ${seconds}s${VERIFY_SECONDS:+, verified, restored in ${VERIFY_SECONDS}s}$ping_note"
  log "backup done"
  if [ "$tag" = move ]; then mark_moved_away "$snapshot"; fi
}

# mark_moved_away <snapshot>: after the final backup of a move this server is the old one. It
# becomes standby, so its timers stop: its nightly backups of the frozen database would land in the
# repository next to the new server's, and its health check would page about a panel stopped on
# purpose.
mark_moved_away() {
  set_standby
  log "move: snapshot ${1:0:8} is the one to restore on the new server: restore.sh ${1:0:8} --prefix <prefix>"
  log "move: this server is standby now, its nightly backup and health check are skipped"
  log "move: if the move is called off, run the panel here again with: $APP_DIR/scripts/deploy/install.sh --prefix $OPT_PREFIX (it clears the standby marker)"
}

# One line: bash has read it whole before main runs (update.sh checks out other commits).
main "$@"; exit $?
