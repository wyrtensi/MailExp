#!/usr/bin/env bash
# Backs up the mail node (docs/operations/mail-node.md, section 7) into a restic repository on any
# S3-compatible storage, the same kind as the panel's backups but its own repository and password:
#   1. mailcow's own helper-scripts/backup_and_restore.sh dumps crypt, redis, rspamd, postfix and
#      mysql into /var/backups/mailexpert-node/mailcow (small next to the mail), checked file by
#      file, since that script exits 0 when a step fails;
#   2. the dump, with mailcow's configuration files and node.env, and the vmail volume itself
#      (read-only, file by file: no local copy of the mail, and restic deduplicates maildir files
#      from night to night) go into one snapshot of this node's restic host
#      (mailexpert-node-<hex>), tags mailcow and the run's tag;
#   3. retention: 7 daily, 4 weekly and 6 monthly snapshots, and every move snapshot; the nightly
#      run on Sunday also prunes;
#   4. on Sundays (and with --verify) a restic check reading back part of the data
#      (NODE_BACKUP_READ_SUBSET, 5% by default) and a restore of the dump and one mailbox, a
#      different one each week, into a temporary directory: archives listed, files compared;
#   5. the local dump is removed, state/backup-last.json written (time, sizes, durations).
# Pings NODE_BACKUP_PING_URL at the start, on success and on failure. Nightly by
# mailexpert-node-backup.timer, installed by setup.sh once the restic keys are stored.
#
#   node-backup.sh [--tag nightly|manual|move] [--verify]
#   node-backup.sh --status              the last backup and whether it is too old (exit 1 then)
#   node-backup.sh --show-recovery-key   RESTIC_REPOSITORY and RESTIC_PASSWORD, to keep elsewhere
#
# --tag move is the last backup before a move (section 8): postfix-mailcow and dovecot-mailcow
# must be stopped first, and afterwards this node is standby (its timer skips) until setup.sh
# runs on it again.
#
# Exit codes: 0 done (or skipped on a standby node), 1 failure, 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Installed by setup.sh next to the shared libraries, or run from a checkout of the repository.
if [ -f "$SCRIPT_DIR/common.sh" ]; then LIB_DIR=$SCRIPT_DIR; else LIB_DIR=$SCRIPT_DIR/../lib; fi
# shellcheck source=../lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=../lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=../lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"
exit_on_unexpected_failure

# How long a manual run waits for the nightly one (and the other way round).
LOCK_TIMEOUT=${MAILEXPERT_NODE_BACKUP_LOCK_TIMEOUT:-3600}
PING_URL='' STARTED=0 DUMP_ROOT='' DUMP_DIR='' VERIFY_DIR='' VERIFY_SECONDS='' MAILCOW_REF=unknown

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# shellcheck disable=SC2317,SC2329 # invoked only through `trap finish EXIT` in main
finish() {
  local status=$?
  if [ -n "$VERIFY_DIR" ]; then rm -rf "$VERIFY_DIR"; fi
  if [ -n "$DUMP_ROOT" ]; then rm -rf "$DUMP_ROOT"; fi
  if [ "$status" != 0 ] && [ "$STARTED" = 1 ]; then
    send_ping "$PING_URL" fail "node-backup.sh failed with exit $status; see journalctl -u mailexpert-node-backup"
  fi
  exit "$status"
}

mailcow_compose() { (cd "$MAILCOW_DIR" && docker compose "$@"); }
service_running() { [ -n "$(mailcow_compose ps -q "$1" 2>/dev/null)" ]; }

# volume_kb <volume>: the size of a Docker volume on disk, in kB; 0 when it does not exist.
volume_kb() {
  local path
  path=$(docker volume inspect -f '{{.Mountpoint}}' "$1" 2>/dev/null) || { echo 0; return 0; }
  du -sk "$path" 2>/dev/null | awk '{print $1 + 0}' || echo 0
}

# check_space: mailcow's dump fits next to what is on the disk.
check_space() {
  local mysql=0 other=0 name need free problem
  for name in "${MAILCOW_COMPONENTS[@]}"; do
    if [ "$name" = mysql ]; then
      mysql=$(volume_kb "$(mailcow_volume "$PROJECT" mysql)")
    else
      other=$((other + $(volume_kb "$(mailcow_volume "$PROJECT" "$name")")))
    fi
  done
  need=$(dump_need_kb "$mysql" "$other")
  free=$(df -Pk "$NODE_BACKUP_DIR" | awk 'NR == 2 {print $4}')
  problem=$(space_problem "$need" "${free:-0}" "$NODE_BACKUP_DIR")
  [ -z "$problem" ] || die "$problem"
}

# dump_mailcow <timeout>: mailcow's backup of everything but vmail into a fresh directory, which
# DUMP_DIR names afterwards. Its output (tar lists every file) goes to a log next to the dump.
dump_mailcow() {
  local timeout=$1 location=$NODE_BACKUP_DIR/mailcow log=$NODE_BACKUP_DIR/mailcow-backup.log code=0 started
  local -a dirs
  local script=$MAILCOW_DIR/helper-scripts/backup_and_restore.sh problems
  [ -x "$script" ] || die "$script not found or not executable: is $MAILCOW_DIR a mailcow checkout?"
  rm -rf "$location"
  # mailcow's script refuses a location others cannot read; the parent (0700) keeps them out.
  mkdir -m 755 "$location"
  DUMP_ROOT=$location
  started=$SECONDS
  MAILCOW_BACKUP_LOCATION=$location timeout "$timeout" "$script" backup "${MAILCOW_COMPONENTS[@]}" >"$log" 2>&1 </dev/null || code=$?
  chmod 600 "$log"
  # By the time taken, not by timeout's own exit status (GNU 124, BusyBox the signal's).
  if [ "$code" != 0 ] && { [ "$code" = 124 ] || [ $((SECONDS - started)) -ge "$timeout" ]; }; then
    die "mailcow's backup ran past NODE_BACKUP_DUMP_TIMEOUT (${timeout}s) and was stopped; see $log"
  fi
  [ "$code" = 0 ] ||
    die "mailcow's backup failed (exit $code; it pulls $MAILCOW_BACKUP_IMAGE, so ghcr.io must be reachable); see $log"
  mapfile -t dirs < <(find "$location" -mindepth 1 -maxdepth 1 -type d -name 'mailcow-*')
  [ "${#dirs[@]}" = 1 ] || die "mailcow's backup left ${#dirs[@]} directories in $location instead of one; see $log"
  problems=$(dump_problems "${dirs[0]}")
  [ -z "$problems" ] || die "mailcow's backup is incomplete ($(paste -sd';' - <<<"$problems")); see $log"
  DUMP_DIR=${dirs[0]}
}

# add_node_files <dump dir>: what a new node needs besides mailcow's dump: mailcow's configuration
# files and certificates, its compose override, node.env and the mailcow commit (meta.json).
add_node_files() {
  local dir=$1/mailexpert commit describe
  mkdir -m 700 "$dir"
  if [ -d "$MAILCOW_DIR/data/conf" ]; then cp -a "$MAILCOW_DIR/data/conf" "$dir/conf"; fi
  if [ -d "$MAILCOW_DIR/data/assets/ssl" ]; then cp -a "$MAILCOW_DIR/data/assets/ssl" "$dir/ssl"; fi
  if [ -f "$MAILCOW_DIR/docker-compose.override.yml" ]; then cp -p "$MAILCOW_DIR/docker-compose.override.yml" "$dir/"; fi
  cp -p "$NODE_CONF" "$dir/node.env"
  commit=$(git -C "$MAILCOW_DIR" rev-parse HEAD 2>/dev/null) || commit=unknown
  describe=$(git -C "$MAILCOW_DIR" describe --tags --always 2>/dev/null) || describe=unknown
  jq -n --arg commit "$commit" --arg describe "$describe" --arg project "$PROJECT" --arg arch "$(uname -m)" \
    '{mailcow_commit: $commit, mailcow_version: $describe, compose_project: $project, arch: $arch}' >"$dir/meta.json"
  MAILCOW_REF=$describe
}

# forget_old <weekday> <tag>: this node's own snapshots only (--host), the ones of the mailcow tag.
forget_old() {
  local -a prune=()
  if prune_today "$1" "$2"; then prune=(--prune); fi
  restic_run -- forget --host "$RESTIC_HOST" --tag "$NODE_BACKUP_TAG" --keep-daily 7 --keep-weekly 4 \
    --keep-monthly 6 --keep-tag move "${prune[@]}" >/dev/null
}

# verify_snapshot <snapshot> <read subset>: restic reads back part of the repository, then the dump
# and one mailbox are restored into a temporary directory (restic compares every file it wrote),
# mailcow's archives are listed whole, and mailcow.conf names the host. Sets VERIFY_SECONDS.
verify_snapshot() {
  local snapshot=$1 subset=$2 week domain='' box='' started problems files=0
  local -a domains boxes include=(--include /backup)
  restic_run -- check --read-data-subset="$subset" >/dev/null ||
    die "verify: restic check --read-data-subset=$subset found a problem in the repository (run it by hand to see which)"
  VERIFY_DIR=$NODE_BACKUP_DIR/verify-$(gen_hex 4)
  mkdir -m 700 "$VERIFY_DIR"
  week=$(date +%V)
  mapfile -t domains < <(restic_run -- ls --json "$snapshot" /vmail | mailbox_children /vmail)
  if [ "${#domains[@]}" -gt 0 ]; then
    domain=$(pick_rotating "$week" "${domains[@]}")
    mapfile -t boxes < <(restic_run -- ls --json "$snapshot" "/vmail/$domain" | mailbox_children "/vmail/$domain")
    if [ "${#boxes[@]}" -gt 0 ]; then
      box=$(pick_rotating "$week" "${boxes[@]}")
      include+=(--include "/vmail/$domain/$box")
    fi
  fi
  started=$SECONDS
  restic_run -v "$VERIFY_DIR:/restore" -- restore "$snapshot" --target /restore --verify "${include[@]}" >/dev/null ||
    die "verify: restic could not restore the dump and a mailbox of snapshot ${snapshot:0:8}"
  VERIFY_SECONDS=$((SECONDS - started))
  problems=$(dump_problems "$VERIFY_DIR/backup")
  [ -z "$problems" ] || die "verify: the restored dump is incomplete ($(paste -sd';' - <<<"$problems"))"
  [ -n "$(env_get "$VERIFY_DIR/backup/mailcow.conf" MAILCOW_HOSTNAME 2>/dev/null || true)" ] ||
    die "verify: the restored mailcow.conf has no MAILCOW_HOSTNAME"
  [ -f "$VERIFY_DIR/backup/mailexpert/meta.json" ] || die "verify: the restored dump has no mailexpert/meta.json"
  ensure_image "$MAILCOW_BACKUP_IMAGE"
  docker run --rm --network none -v "$VERIFY_DIR/backup:/backup:ro" "$MAILCOW_BACKUP_IMAGE" /bin/sh -c \
    'for f in /backup/*.tar.zst; do tar --use-compress-program=zstd -tf "$f" >/dev/null || { echo "${f#/backup/}"; exit 1; }; done' >/dev/null ||
    die "verify: one of mailcow's archives does not read back whole (tar -t failed)"
  if [ -n "$box" ]; then
    files=$(find "$VERIFY_DIR/vmail/$domain/$box" -type f | wc -l)
    [ "$files" -gt 0 ] || die "verify: the mailbox restored without files"
    log "verify: restored in ${VERIFY_SECONDS}s: the dump (archives read back whole) and one mailbox ($files files)"
  elif [ "${#domains[@]}" -eq 0 ]; then
    log "verify: restored in ${VERIFY_SECONDS}s: the dump (archives read back whole); no mailbox in vmail yet"
  else
    log "verify: restored in ${VERIFY_SECONDS}s: the dump (archives read back whole); the domain picked has no mailbox yet"
  fi
}

show_status() {
  local file problem
  file=$(node_backup_last_file)
  if [ -f "$file" ]; then jq . "$file"; else log "no successful backup recorded on this node"; fi
  problem=$(node_backup_age "$(date +%s)")
  if [ -n "$problem" ]; then
    log "$problem"
    return 1
  fi
}

main() {
  local tag=nightly verify=0 show_key=0 status=0 started dump seconds dump_seconds dump_bytes
  local push_started push_seconds code=0 summary snapshot processed added weekday checks subset
  local dump_timeout push_timeout vmail name
  while [ $# -gt 0 ]; do
    case $1 in
      --tag)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        tag=$2
        shift 2
        ;;
      --verify) verify=1 && shift ;;
      --show-recovery-key) show_key=1 && shift ;;
      --status) status=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  backup_tag_ok "$tag" || die "--tag must be lowercase letters, digits and '-'" 2
  [ "$(id -u)" = 0 ] || die "run node-backup.sh as root"
  [ -f "$NODE_CONF" ] || die "$NODE_CONF is missing: run setup.sh first" 2
  node_backup_env

  if [ "$status" = 1 ]; then
    show_status || exit 1
    return 0
  fi
  if [ "$show_key" = 1 ]; then
    backup_configured "$NODE_CONF" || die "node backups are not configured, so there is no recovery key" 2
    print_recovery_key
    mkdir -p "$NODE_STATE"
    : >"$NODE_STATE/recovery-key.shown"
    return 0
  fi
  if [ -f "$(node_standby_file)" ]; then
    log "standby node (moved away with --tag move): backup skipped; setup.sh on this node ends standby"
    return 0
  fi

  mkdir -p "$NODE_STATE"
  take_lock "$NODE_STATE/backup.lock" "$LOCK_TIMEOUT" "another node-backup.sh"
  trap finish EXIT
  PING_URL=$(node_setting NODE_BACKUP_PING_URL '')
  send_ping "$PING_URL" start
  STARTED=1
  backup_configured "$NODE_CONF" ||
    die "node backups are not configured: give setup.sh --backup-keys the restic keys (RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) on stdin"
  MAILCOW_DIR=$(node_setting MAILCOW_DIR /opt/mailcow-dockerized)
  [ -f "$MAILCOW_DIR/mailcow.conf" ] || die "$MAILCOW_DIR/mailcow.conf not found (MAILCOW_DIR in $NODE_CONF)"
  PROJECT=$(compose_project "$MAILCOW_DIR/mailcow.conf") || die "$MAILCOW_DIR/mailcow.conf has no COMPOSE_PROJECT_NAME"
  vmail=$(mailcow_volume "$PROJECT" vmail)
  docker volume inspect "$vmail" >/dev/null 2>&1 || die "the vmail volume $vmail does not exist: is mailcow installed in $MAILCOW_DIR?"
  if [ "$tag" = move ]; then
    for name in postfix-mailcow dovecot-mailcow; do
      ! service_running "$name" ||
        die "--tag move: $name still runs; stop it first (docker compose stop postfix-mailcow dovecot-mailcow in $MAILCOW_DIR), EOP keeps the mail in its queue"
    done
  fi
  dump_timeout=$(node_setting NODE_BACKUP_DUMP_TIMEOUT "$NODE_BACKUP_DUMP_TIMEOUT_DEFAULT")
  push_timeout=$(node_setting NODE_BACKUP_PUSH_TIMEOUT "$NODE_BACKUP_PUSH_TIMEOUT_DEFAULT")
  subset=$(node_setting NODE_BACKUP_READ_SUBSET "$NODE_BACKUP_READ_SUBSET_DEFAULT")

  install -d -m 700 "$NODE_BACKUP_DIR"
  check_space
  started=$SECONDS
  dump_mailcow "$dump_timeout"
  dump=$DUMP_DIR
  dump_seconds=$((SECONDS - started))
  add_node_files "$dump"
  dump_bytes=$(du -sk "$dump" | awk '{print $1 * 1024}')
  log "mailcow dumped in ${dump_seconds}s, $dump_bytes bytes (without vmail)"

  load_restic_env
  load_restic_host "$NODE_RESTIC_HOST_PREFIX"
  ensure_image "$RESTIC_IMAGE"
  push_started=$SECONDS
  restic_run -t "$push_timeout" -v "$dump:/backup:ro" -v "$vmail:/vmail:ro" -- backup --json \
    --host "$RESTIC_HOST" --tag "$NODE_BACKUP_TAG" --tag "$tag" /backup /vmail >"$DUMP_ROOT/restic.json" || code=$?
  push_seconds=$((SECONDS - push_started))
  summary=$(jq -c 'select(.message_type == "summary")' "$DUMP_ROOT/restic.json" 2>/dev/null | tail -n 1) || summary=''
  snapshot=$(jq -r '.snapshot_id // empty' <<<"$summary" 2>/dev/null) || snapshot=''
  case $code in
    0) ;;
    # Exit 3: the snapshot is saved, but some files could not be read: mail Dovecot moved or
    # expunged while restic read the volume. They are in the next night's snapshot.
    3) [ -z "$snapshot" ] || warn "restic could not read some files (mail moved while it read the volume); the snapshot is saved without them" ;;
    *)
      if [ "$push_seconds" -ge "$push_timeout" ]; then
        die "the upload ran past NODE_BACKUP_PUSH_TIMEOUT (${push_timeout}s) and was stopped; the next run continues from what is stored (restic deduplicates)"
      fi
      die "restic backup failed (exit $code, after ${push_seconds}s); its messages are above"
      ;;
  esac
  [ -n "$snapshot" ] || die "restic reported no snapshot"
  processed=$(jq -r '.total_bytes_processed // 0' <<<"$summary")
  added=$(jq -r '.data_added // 0' <<<"$summary")
  log "snapshot ${snapshot:0:8} stored (tag $tag) in ${push_seconds}s: $processed bytes read, $added bytes new"
  weekday=$(date +%u)
  forget_old "$weekday" "$tag"
  checks=$(node_backup_checks "$weekday" "$tag" "$verify")
  if [ "$checks" = verify ]; then verify_snapshot "$snapshot" "$subset"; fi
  seconds=$((SECONDS - started))
  write_node_backup_last "$snapshot" "$tag" "$seconds" "$dump_seconds" "$dump_bytes" "$push_seconds" \
    "$processed" "$added" "$MAILCOW_REF" "$VERIFY_SECONDS"
  send_ping "$PING_URL" success "snapshot ${snapshot:0:8} ($tag): $processed bytes, $added new, in ${seconds}s${VERIFY_SECONDS:+, verified, restored in ${VERIFY_SECONDS}s}"
  log "node backup done"
  if [ "$tag" = move ]; then
    : >"$(node_standby_file)"
    log "move: snapshot ${snapshot:0:8} is the one to restore on the new node: node-restore.sh ${snapshot:0:8}"
    log "move: this node is standby now, its nightly backup is skipped; if the move is called off, start postfix-mailcow and dovecot-mailcow and run setup.sh here again (it ends standby)"
  fi
}

# One line: bash has read it whole before main runs.
main "$@"; exit $?
