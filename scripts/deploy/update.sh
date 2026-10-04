#!/usr/bin/env bash
# Updates the panel to another commit (image tag sha-<12>):
#   1. checks: the panel ready, the commit exists, the images pulled before anything stops, free
#      space for the last dump;
#   2. a pre-update backup: backups/pre-update-<old>.dump (the last 3 are kept) and, with the
#      restic keys, a snapshot tagged pre-update;
#   3. install.sh --version <new>: checkout, MAILEXPERT_VERSION, up, migrations at start, the
#      readiness and version checks (MAILEXPERT_READY_TIMEOUT, 600 s by default here).
# A version that does not become ready is left as it is: going back is a decision for a person
# (the runbook's "Откат обновления": stop, restore the pre-update dump, install.sh --version <old>),
# because anything written after the update would be lost.
#
#   update.sh sha-<commit>|latest [--prefix /opt/mailexpert]
#   update.sh --version sha-<commit>|latest [--prefix /opt/mailexpert]
#   update.sh --check sha-<commit>|latest [--prefix /opt/mailexpert]   (status.sh --target: read-only)
#
# latest is the build the owner promoted (the git tag `latest`, lib/channel.sh); it is turned into
# that commit's sha-<12> first, and the server runs that tag, never `latest`.
#
# When the Caddy image changes between the two commits (deploy/edge/Dockerfile) and Caddy runs
# here, the new edge image is pulled before the backup like the panel's, the pinned EDGE_IMAGE is
# kept in <prefix>/state/edge-image.previous and install.sh pins the new one.
#
# After an update it lists, from the files that changed between the two commits, the steps a
# person takes outside the panel ("next:": the mail node's host scripts) and context ("info:":
# migrations, the edge image, what install.sh did by itself).
#
# Exit codes:
#   0 updated (or already at that version);
#   1 failure after the switch began: install.sh ran and the new version did not become ready; the
#     server may run neither version (the log says whether migrations were applied);
#   2 invalid input or a state that forbids an update (not root, standby, not ready, no such
#     commit, not enough space, a PostgreSQL major change): nothing changed;
#   3 failure before the switch (an image that does not pull, the pre-update backup, any other
#     command): nothing changed, the old version runs.
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
# shellcheck source=lib/status.sh
. "$LIB_DIR/status.sh"
# shellcheck source=lib/channel.sh
. "$LIB_DIR/channel.sh"
exit_on_unexpected_failure

# 1 from the moment install.sh is started: before that every failure leaves the server unchanged
# and exits 3 (nothing_changed_exit), whatever failed (die, ensure_image, the ERR trap).
SWITCHED=0
# shellcheck disable=SC2317,SC2329 # run by the EXIT trap below (SC2317 in older shellcheck)
nothing_changed_exit() {
  if [ "$SWITCHED" = 0 ] && [ "$1" = 1 ]; then
    printf '[mailexpert] nothing was changed: the old version still runs\n' >&2
    exit 3
  fi
}
trap 'nothing_changed_exit $?' EXIT

READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-600}

usage() {
  cat <<'EOF'
Usage: update.sh sha-<first 12 characters of the commit>|latest [--prefix /opt/mailexpert]
       update.sh --version sha-<commit>|latest [--prefix /opt/mailexpert]
       update.sh --check sha-<commit>|latest [--prefix /opt/mailexpert]

Backs up, switches to the new version with install.sh and checks it. A version that does not
become ready is left as it is and the way back is printed: see the runbook, "Откат обновления",
or rollback.sh. latest is the build the owner promoted; the server runs its sha-<12>.
--check changes nothing: it runs status.sh --target <version> (exit 0 ready to update, 1 problems).
MAILEXPERT_READY_TIMEOUT: seconds to wait for readiness (default 600).
Exit codes: 0 updated; 1 the new version did not become ready (after the switch); 2 invalid
input or state, nothing changed; 3 failure before the switch, nothing changed.
EOF
}

# estimate_dump_bytes: the size of the last dump, or of the database when there is none yet.
estimate_dump_bytes() {
  if [ -f "$STATE_DIR/backup-last.json" ] && json_number dump_bytes <"$STATE_DIR/backup-last.json"; then
    return 0
  fi
  printf 'SELECT pg_database_size(current_database());\n' | app_psql
}

# prune_local_dumps: keeps the 3 newest pre-update dumps.
prune_local_dumps() {
  local list f
  # shellcheck disable=SC2012 # our own names: pre-update-sha-<hex>.dump
  list=$(ls -1t "$BACKUP_DIR"/pre-update-*.dump 2>/dev/null || true)
  [ -n "$list" ] || return 0
  while IFS= read -r f; do rm -f -- "$f"; done < <(stale_local_dumps 3 <<<"$list")
}

# check_index_warning <since>: the backend's warning about an invalid index that a migration
# without a transaction can leave behind.
check_index_warning() {
  local line
  line=$(app_compose logs --no-log-prefix --since "$1" backend 2>&1 | grep -m 1 'Index idx_messages_provider_thread is' || true)
  if [ -n "$line" ]; then warn "$line"; fi
}

# print_update_notes <old commit> <new commit>: "next:" for the steps a person takes outside
# update.sh, "info:" for context.
print_update_notes() {
  local changed tenant=0 profiles line
  changed=$(git -C "$APP_DIR" diff --name-only "$1" "$2" 2>/dev/null) || return 0
  profiles=$(env_get "$ENV_FILE" COMPOSE_PROFILES) || profiles=''
  if has_profile "$profiles" tenant; then tenant=1; fi
  while IFS= read -r line; do
    case $line in
      "next "*) log "next: ${line#next }" ;;
      "info "*) log "info: ${line#info }" ;;
    esac
  done < <(update_notes "$tenant" "$(edge_services | paste -sd, -)" <<<"$changed")
}

# check_data_images <old commit> <new commit>: refuses a PostgreSQL major change, which update.sh
# cannot carry over (the old data directory does not start on a new major version).
check_data_images() {
  local kind service from to
  while read -r kind service from _ to; do
    if [ "$kind" = problem ]; then
      die "$service changes from $from to $to between these versions: a new PostgreSQL major version needs a dump and a restore into a new volume, which update.sh does not do" 2
    fi
  done < <(data_image_changes <(git -C "$APP_DIR" show "$1:docker-compose.yml" 2>/dev/null) \
    <(git -C "$APP_DIR" show "$2:docker-compose.yml" 2>/dev/null))
}

# applied_migrations: the number of applied migrations, empty when the database does not answer.
applied_migrations() {
  migration_count 2>/dev/null | tr -d '[:space:]' || true
}

# run_install <version>: install.sh of the current checkout switches to <version> (and continues
# with that commit's installer).
run_install() {
  MAILEXPERT_READY_TIMEOUT=$READY_TIMEOUT bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$1"
}

main() {
  local prefix=/opt/mailexpert target='' old dump free_kb bytes problem since url check=0 old_head profiles
  local before after changed edge_image='' edge_previous=''
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix | --version)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        if [ "$1" = --prefix ]; then
          prefix=$2
        else
          if [ -n "$target" ]; then die "one version only" 2; fi
          target=$2
        fi
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      --check) check=1 && shift ;;
      sha-* | latest)
        if [ -n "$target" ]; then die "one version only" 2; fi
        target=$1
        shift
        ;;
      *) die "unknown argument: $1 (see --help)" 2 ;;
    esac
  done
  [[ $target =~ ^sha-[0-9a-f]{12}$ || $target == latest ]] ||
    die "usage: update.sh sha-<first 12 characters of the commit>|latest [--prefix <prefix>]" 2
  if [ "$check" = 1 ]; then
    exec bash "$SCRIPT_DIR/status.sh" --prefix "$prefix" --target "$target"
  fi
  [[ $READY_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_READY_TIMEOUT must be a number of seconds" 2
  [ "$(id -u)" = 0 ] || die "run update.sh as root" 2
  load_install "$prefix"
  if [ "$target" = latest ]; then
    target=$(resolve_latest) || die "cannot resolve the channel latest; name the version (sha-<12>)" 2
    log "latest is $target"
  fi
  old=$CFG_VERSION
  if [ "$target" = "$old" ]; then
    log "already at $target"
    return 0
  fi
  if is_standby; then die "standby server: the panel does not run here; install.sh --version sets its version" 2; fi
  take_lock "$STATE_DIR/update.lock" 10 "another update.sh or restore.sh"
  panel_ready || die "the panel is not ready now; fix that before updating" 2
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" rev-parse --verify --quiet "${target#sha-}^{commit}" >/dev/null ||
    die "commit ${target#sha-} is not in $(redact_url "$CFG_REPO_URL")" 2
  check_data_images HEAD "${target#sha-}"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-backend:$target"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-frontend:$target"
  # The tenant worker runs the same tag; pulled here so that a missing image stops the update
  # before the backup and before anything is switched, not in the middle of `up`.
  profiles=$(env_get "$ENV_FILE" COMPOSE_PROFILES) || profiles=''
  if has_profile "$profiles" tenant; then ensure_image "$CFG_IMAGE_PREFIX/mailexpert-tenant-worker:$target"; fi
  # The Caddy image follows the panel when it changes: pulled here, before the backup, like the
  # panel's own images.
  changed=$(git -C "$APP_DIR" diff --name-only HEAD "${target#sha-}")
  if edge_image_changes "$(edge_services | paste -sd, -)" <<<"$changed"; then
    edge_image=$CFG_IMAGE_PREFIX/mailexpert-edge:$target
    ensure_image "$edge_image"
  fi
  free_kb=$(df -Pk "$OPT_PREFIX" | awk 'NR == 2 {print $4}')
  bytes=$(estimate_dump_bytes)
  problem=$(space_problem "$free_kb" "$bytes")
  [ -z "$problem" ] || die "$problem" 2

  dump=$BACKUP_DIR/pre-update-$old.dump
  log "backup before the update"
  bash "$SCRIPT_DIR/backup.sh" --prefix "$OPT_PREFIX" --tag pre-update --keep-dump "$dump" ||
    die "the backup before the update failed; nothing was changed"
  prune_local_dumps
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  old_head=$(git -C "$APP_DIR" rev-parse HEAD)
  url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=
  before=$(applied_migrations)
  if [ -n "$edge_image" ]; then
    edge_previous=$(env_get "$EDGE_ENV" EDGE_IMAGE) || edge_previous=''
    if [ -n "$edge_previous" ]; then save_previous_edge_image "$old" "$edge_previous"; fi
    # Empty: install.sh pins the image of the new version by its digest.
    env_set "$EDGE_ENV" EDGE_IMAGE ''
    log "the Caddy image changes: $edge_image replaces ${edge_previous:-the unpinned image} (kept in $STATE_DIR/edge-image.previous)"
  fi
  log "updating $old -> $target"
  SWITCHED=1
  if ! run_install "$target"; then
    send_ping "$url" fail "the update to $target did not become ready"
    warn "$target did not become ready; nothing was rolled back"
    log "the backend log: docker compose -p $CFG_PROJECT logs backend"
    if [ -n "$edge_previous" ]; then
      log "the Caddy image was replaced as well; going back restores $edge_previous (rollback.sh does it, or set EDGE_IMAGE in $EDGE_ENV)"
    fi
    after=$(applied_migrations)
    if [ -n "$before" ] && [ "$before" = "$after" ]; then
      log "no migration was recorded as applied ($after before and after): unless the backend log shows a migration that failed halfway, going back is install.sh --prefix $OPT_PREFIX --version $old and nothing is lost (the pre-update dump $dump stays in case it is needed)"
    else
      log "migrations were applied or cannot be counted (${before:-?} before, ${after:-?} now): to go back to $old (what was written since the update is lost): stop backend and frontend, restore $dump into the database, then run install.sh --prefix $OPT_PREFIX --version $old (runbook: \"Откат обновления\")"
    fi
    exit 1
  fi
  check_index_warning "$since"
  send_ping "$url" success "updated to $target"
  log "updated to $target; the pre-update dump is $dump"
  print_update_notes "$old_head" "${target#sha-}"
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
