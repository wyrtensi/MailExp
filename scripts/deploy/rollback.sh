#!/usr/bin/env bash
# Takes the panel back to the version it ran before an update, with the database of that moment:
# the runbook's "Откат обновления" (docs/operations/deployment.md) as one script.
#   1. checks: root, not standby, no other update or restore, the pre-update dump of that version,
#      the commit, its images pulled before anything stops;
#   2. a confirmation: the version typed again (or --confirm <version> when a person already
#      decided, for example an agent after the owner's yes);
#   3. backend and frontend stop; the dump is restored into a new database <db>_rollback, which
#      then takes the place of the current one by renaming; the current one is kept as
#      <db>_before_rollback_<time> (drop it by hand once sure);
#   4. the Caddy image an update replaced is restored (state/edge-image.previous);
#   5. install.sh --version <old>: checkout, images, start, readiness.
#
# Everything written to the panel since the update is lost (users, rules, journal entries, mailbox
# connections); mail itself is on the providers' servers and syncs again. Never run by the panel:
# going back is a person's decision.
#
#   rollback.sh --to sha-<12> [--prefix /opt/mailexpert] [--dump <file>] [--confirm sha-<12>]
#
# Exit codes: 0 rolled back; 1 failure after the panel was stopped (the output says what state the
# database is in); 2 invalid input or a state that forbids it (nothing changed); 3 failure before
# anything was stopped (an image that does not pull, any other command): nothing changed.
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
# shellcheck source=lib/ops.sh
. "$LIB_DIR/ops.sh"
# shellcheck source=lib/status.sh
. "$LIB_DIR/status.sh"
# shellcheck source=lib/system.sh
. "$LIB_DIR/system.sh"
# shellcheck source=lib/updater.sh
. "$LIB_DIR/updater.sh"
exit_on_unexpected_failure

# 1 once backend and frontend are stopped: before that every failure exits 3, nothing changed.
STOPPED=0
# shellcheck disable=SC2317,SC2329 # run by the EXIT trap below
nothing_changed_exit() {
  if [ "$STOPPED" = 0 ] && [ "$1" = 1 ]; then
    printf '[mailexpert] nothing was changed: the panel still runs as before\n' >&2
    exit 3
  fi
}
trap 'nothing_changed_exit $?' EXIT

READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-600}

usage() {
  cat <<'EOF'
Usage: rollback.sh --to sha-<12> [--prefix /opt/mailexpert] [--dump <file>] [--confirm sha-<12>]

Goes back to the version that ran before an update: restores its pre-update dump
(<prefix>/backups/pre-update-<version>.dump, or --dump) into a new database, swaps it in by
renaming, restores the Caddy image the update replaced, then install.sh --version <version>.
Everything written since the update is lost. Asks to type the version unless --confirm names it.
Exit codes: 0 rolled back; 1 failure after the panel was stopped; 2 invalid input or state,
nothing changed; 3 failure before anything was stopped, nothing changed.
EOF
}

# admin_psql: psql on the maintenance database as the panel's database user, SQL on stdin.
admin_psql() {
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  app_compose exec -T postgres sh -c 'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres'
}

# restore_into <database>: pg_restore of the dump on stdin into <database>.
restore_into() {
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  app_compose exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error --single-transaction' sh "$1"
}

# restart_old: brings the stopped services back on the version that ran, after a failure that
# left the database as it was.
restart_old() {
  app_compose start backend frontend >/dev/null 2>&1 || warn "could not start backend and frontend again: run install.sh --prefix $OPT_PREFIX"
}

# swap_databases <db> <restored copy> <name for the replaced one>: the restored copy takes the
# place of <db>. New connections to <db> are refused first (the health check or anything else
# would otherwise reconnect between the terminate and the rename); the terminate is asynchronous,
# so the rename is retried a few times. Status 1 when it did not happen: <db> is unchanged and
# takes connections again.
swap_databases() {
  local db=$1 scratch=$2 kept=$3 try
  printf 'ALTER DATABASE "%s" WITH ALLOW_CONNECTIONS false;\n' "$db" | admin_psql >/dev/null || return 1
  for try in 1 2 3 4 5; do
    if admin_psql >/dev/null 2>&1 <<SQL; then
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();
SELECT pg_sleep(1);
BEGIN;
ALTER DATABASE "$db" RENAME TO "$kept";
ALTER DATABASE "$scratch" RENAME TO "$db";
COMMIT;
SQL
      printf 'ALTER DATABASE "%s" WITH ALLOW_CONNECTIONS true;\n' "$kept" | admin_psql >/dev/null 2>&1 || true
      return 0
    fi
    log "the database $db is still in use (try $try of 5)"
  done
  printf 'ALTER DATABASE "%s" WITH ALLOW_CONNECTIONS true;\n' "$db" | admin_psql >/dev/null 2>&1 || true
  return 1
}

# database_bytes <db>: the size of <db>, empty when it cannot be read.
database_bytes() {
  printf "SELECT pg_database_size('%s');\n" "$1" | app_psql 2>/dev/null | tr -d '[:space:]' || true
}

# after_install <version> <version left>: what the panel and the host updater are told once the
# old version runs: the version left is not offered again until a newer build is promoted, and a
# version without updater.sh gets no updater units.
after_install() {
  record_rolled_back "$STATE_DIR" "$2"
  if [ ! -f "$APP_DIR/scripts/deploy/updater.sh" ]; then
    remove_updater "$1"
  elif [ -f "$STATE_DIR/update-spool/result/updater.json" ]; then
    write_updater_installed "$STATE_DIR" "$1"
  fi
}

main() {
  local prefix=/opt/mailexpert to='' dump='' confirm='' db scratch kept full stamp edge profiles answer
  local from marker docker_root free_kb dump_bytes db_bytes problem swapped=0 errors
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix | --to | --dump | --confirm)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        case $1 in
          --prefix) prefix=$2 ;;
          --to) to=$2 ;;
          --dump) dump=$2 ;;
          --confirm) confirm=$2 ;;
        esac
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown argument: $1 (see --help)" 2 ;;
    esac
  done
  [[ $to =~ ^sha-[0-9a-f]{12}$ ]] || die "--to must be sha-<first 12 characters of the commit> (see --help)" 2
  [[ $READY_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_READY_TIMEOUT must be a number of seconds" 2
  [ "$(id -u)" = 0 ] || die "run rollback.sh as root" 2
  load_install "$prefix"
  from=$CFG_VERSION
  marker=$STATE_DIR/rollback-in-progress
  if is_standby; then die "standby server: the panel does not run here" 2; fi
  # install.sh records the version before it switches, so an interrupted rollback reads as done.
  [ "$to" != "$from" ] ||
    die "install.conf says $to already: if a rollback to it was interrupted, finish it with install.sh --prefix $OPT_PREFIX (the database already holds the dump)" 2
  db=$(env_get "$ENV_FILE" DB_NAME) || db=mailexpert
  [ -n "$db" ] || db=mailexpert
  [[ $db =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "DB_NAME '$db' is not a plain database name; follow the runbook by hand" 2
  scratch=${db}_rollback
  # A run interrupted after the swap: the database already holds the dump; only the code is left.
  if [ -f "$marker" ] && [ "$(sed -n 1p "$marker")" = "$to" ] && [ "$(sed -n 3p "$marker")" = "$from" ]; then swapped=1; fi
  if [ "$swapped" = 0 ]; then
    if [ -z "$dump" ]; then dump=$BACKUP_DIR/pre-update-$to.dump; fi
    [ -s "$dump" ] || die "no dump at $dump (update.sh keeps the last 3 as backups/pre-update-<version>.dump; an older one: restore.sh from restic)" 2
  fi
  # 10 minutes: a backup holds the lock (shared) while it dumps the database.
  take_lock "$STATE_DIR/update.lock" 600 "another update.sh, rollback.sh or restore.sh, or a backup's database dump,"
  if ! errors=$(git -C "$APP_DIR" fetch --quiet origin 2>&1); then
    warn "git fetch failed in $APP_DIR: $(error_tail <<<"$errors"); going on with the commits already fetched"
  fi
  full=$(git -C "$APP_DIR" rev-parse --verify --quiet "${to#sha-}^{commit}") || die "commit ${to#sha-} is not in $(redact_url "$CFG_REPO_URL")" 2
  if git -C "$APP_DIR" show "$full:scripts/deploy/lib/app.sh" 2>/dev/null | local_compose_ignored; then
    local_compose_warning "$to"
  fi
  # Old code on a newer schema is what this script undoes, so the target's migrations are not
  # compared with the database here: the dump brings the schema of that version.
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-backend:$to"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-frontend:$to"
  profiles=$(env_get "$ENV_FILE" COMPOSE_PROFILES) || profiles=''
  if has_profile "$profiles" tenant; then ensure_image "$CFG_IMAGE_PREFIX/mailexpert-tenant-worker:$to"; fi
  edge=$(previous_edge_image "$to") || edge=''
  if [ "$swapped" = 0 ]; then
    # The restored copy sits next to the live database until the swap, and the dump stays.
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || docker_root=''
    [ -n "$docker_root" ] && [ -d "$docker_root" ] || docker_root=$OPT_PREFIX
    free_kb=$(df -Pk "$docker_root" | awk 'NR == 2 {print $4}')
    dump_bytes=$(stat -c %s "$dump")
    db_bytes=$(database_bytes "$db")
    [[ $db_bytes =~ ^[0-9]+$ ]] || die "cannot read the size of the database $db (is postgres running?)" 2
    problem=$(rollback_space_problem "$free_kb" "$dump_bytes" "$db_bytes")
    [ -z "$problem" ] || die "$problem" 2
  fi

  log "rollback: $from -> $to (commit $full)"
  if [ "$swapped" = 1 ]; then
    log "an earlier run already swapped the database; only the code and images are switched now"
  else
    log "the database $db is replaced by $dump; everything written since that dump is lost"
  fi
  if [ -n "$edge" ]; then log "the Caddy image goes back to $edge"; fi
  if [ -z "$confirm" ]; then
    [ -t 0 ] || die "no terminal to confirm in: pass --confirm $to once a person has decided" 2
    printf '[mailexpert] type the version to go back to (%s) to continue: ' "$to" >&2
    IFS= read -r answer || answer=''
    confirm=$answer
  fi
  [ "$confirm" = "$to" ] || die "not confirmed: nothing was changed" 2

  STOPPED=1
  if [ "$swapped" = 0 ]; then
    log "stopping backend and frontend"
    app_compose stop backend frontend >/dev/null
    log "restoring $dump into $scratch"
    # client_min_messages: no NOTICE about a scratch database that is not there, in the output.
    if ! printf 'SET client_min_messages = warning;\nDROP DATABASE IF EXISTS "%s";\nCREATE DATABASE "%s";\n' "$scratch" "$scratch" | admin_psql >/dev/null; then
      restart_old
      die "cannot create the database $scratch; the database $db is unchanged and the panel was started again"
    fi
    if ! restore_into "$scratch" <"$dump"; then
      restart_old
      die "the dump did not restore into $scratch; the database $db is unchanged and the panel was started again (drop $scratch by hand)"
    fi
    stamp=$(date -u +%Y%m%d%H%M%S)
    # PostgreSQL names are at most 63 bytes: the database name is cut to 30 characters here.
    kept=${db:0:30}_before_rollback_$stamp
    if ! swap_databases "$db" "$scratch" "$kept"; then
      restart_old
      die "the databases could not be swapped; $db is unchanged (the restored copy is $scratch) and the panel was started again"
    fi
    printf '%s\n%s\n%s\n' "$to" "$kept" "$from" >"$marker"
    log "the database $db is now the dump; the one it replaced is kept as $kept (drop it once sure: dropdb $kept in the postgres container)"
  fi
  if [ -n "$edge" ]; then env_set "$EDGE_ENV" EDGE_IMAGE "$edge"; fi
  log "switching the code and images to $to"
  if ! MAILEXPERT_READY_TIMEOUT=$READY_TIMEOUT bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$to"; then
    die "install.sh --version $to failed; the database already holds the dump: fix what install.sh reported and run install.sh --prefix $OPT_PREFIX"
  fi
  after_install "$to" "$from"
  rm -f "$marker"
  log "rolled back to $to; the panel will not offer $from again until a newer build is promoted"
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
