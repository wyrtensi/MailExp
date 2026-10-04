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

main() {
  local prefix=/opt/mailexpert to='' dump='' confirm='' db scratch kept full stamp edge profiles answer
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
  if is_standby; then die "standby server: the panel does not run here" 2; fi
  [ "$to" != "$CFG_VERSION" ] || die "the panel is at $to already" 2
  if [ -z "$dump" ]; then dump=$BACKUP_DIR/pre-update-$to.dump; fi
  [ -s "$dump" ] || die "no dump at $dump (update.sh keeps the last 3 as backups/pre-update-<version>.dump; an older one: restore.sh from restic)" 2
  db=$(env_get "$ENV_FILE" DB_NAME) || db=mailexpert
  [ -n "$db" ] || db=mailexpert
  [[ $db =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "DB_NAME '$db' is not a plain database name; follow the runbook by hand" 2
  scratch=${db}_rollback
  take_lock "$STATE_DIR/update.lock" 10 "another update.sh, rollback.sh or restore.sh"
  git -C "$APP_DIR" fetch --quiet origin 2>/dev/null || warn "git fetch failed in $APP_DIR"
  full=$(git -C "$APP_DIR" rev-parse --verify --quiet "${to#sha-}^{commit}") || die "commit ${to#sha-} is not in $CFG_REPO_URL" 2
  # Old code on a newer schema is what this script undoes, so the target's migrations are not
  # compared with the database here: the dump brings the schema of that version.
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-backend:$to"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-frontend:$to"
  profiles=$(env_get "$ENV_FILE" COMPOSE_PROFILES) || profiles=''
  if has_profile "$profiles" tenant; then ensure_image "$CFG_IMAGE_PREFIX/mailexpert-tenant-worker:$to"; fi
  edge=$(previous_edge_image "$to") || edge=''

  log "rollback: $CFG_VERSION -> $to (commit $full)"
  log "the database $db is replaced by $dump; everything written since that dump is lost"
  if [ -n "$edge" ]; then log "the Caddy image goes back to $edge"; fi
  if [ -z "$confirm" ]; then
    [ -t 0 ] || die "no terminal to confirm in: pass --confirm $to once a person has decided" 2
    printf '[mailexpert] type the version to go back to (%s) to continue: ' "$to" >&2
    IFS= read -r answer || answer=''
    confirm=$answer
  fi
  [ "$confirm" = "$to" ] || die "not confirmed: nothing was changed" 2

  STOPPED=1
  log "stopping backend and frontend"
  app_compose stop backend frontend >/dev/null
  log "restoring $dump into $scratch"
  if ! printf 'DROP DATABASE IF EXISTS "%s";\nCREATE DATABASE "%s";\n' "$scratch" "$scratch" | admin_psql >/dev/null; then
    restart_old
    die "cannot create the database $scratch; the database $db is unchanged and the panel was started again"
  fi
  if ! restore_into "$scratch" <"$dump"; then
    restart_old
    die "the dump did not restore into $scratch; the database $db is unchanged and the panel was started again (drop $scratch by hand)"
  fi
  stamp=$(date -u +%Y%m%d%H%M%S)
  kept=${db}_before_rollback_$stamp
  if ! admin_psql >/dev/null <<SQL; then
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE "$db" RENAME TO "$kept";
ALTER DATABASE "$scratch" RENAME TO "$db";
COMMIT;
SQL
    restart_old
    die "the databases could not be swapped; $db is unchanged (the restored copy is $scratch) and the panel was started again"
  fi
  log "the database $db is now the dump; the one it replaced is kept as $kept (drop it once sure: dropdb $kept in the postgres container)"
  if [ -n "$edge" ]; then env_set "$EDGE_ENV" EDGE_IMAGE "$edge"; fi
  log "switching the code and images to $to"
  if ! MAILEXPERT_READY_TIMEOUT=$READY_TIMEOUT bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$to"; then
    die "install.sh --version $to failed; the database already holds the dump: fix what install.sh reported and run it again"
  fi
  log "rolled back to $to"
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
