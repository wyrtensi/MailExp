#!/usr/bin/env bash
# Backs up the mail node (docs/operations/mail-node.md, section 7) into a restic repository on any
# S3-compatible storage, the same kind as the panel's backups but its own repository and password:
#   1. mailcow's own helper-scripts/backup_and_restore.sh dumps crypt, redis, rspamd, postfix and
#      mysql into /var/backups/mailexpert-node/mailcow (small next to the mail; there must be room
#      for it and a reserve), checked file by file, since that script exits 0 when a step fails,
#      and the crypt and database archives listed: the mail_crypt keys and the database's files
#      must be in them;
#   2. the dump, with mailcow's configuration files, node.env and meta.json (the mailcow commit,
#      the number of mailboxes), and the vmail volume itself (read-only, file by file: no local copy
#      of the mail, and restic deduplicates maildir files from night to night) go into one snapshot
#      of this node's restic host (mailexpert-node-<hex>), tags mailcow and the run's tag;
#   3. retention: the last 5 pre-update snapshots (the node agent's update); otherwise 7 daily,
#      4 weekly and 6 monthly snapshots, and every move and pre-update snapshot; the nightly
#      run on Sunday also prunes;
#   4. on Sundays (and with --verify), once the local dump is gone: a restic check reading back part
#      of the data (NODE_BACKUP_READ_SUBSET, 5% by default) and a restore of the dump and one
#      mailbox, a different one each week, into a temporary directory: archives listed, files
#      compared;
#   5. state/backup-last.json written (time, sizes, durations, whether restic missed files).
# Every phase is bounded (NODE_BACKUP_DUMP_TIMEOUT, NODE_BACKUP_PUSH_TIMEOUT,
# NODE_BACKUP_VERIFY_TIMEOUT); restic containers of a run killed from outside are removed, and
# stale restic locks unlocked, by the next run (and by --cleanup, the unit's ExecStopPost). Pings
# NODE_BACKUP_PING_URL at the start, on success and on failure. Nightly by
# mailexpert-node-backup.timer (cron without systemd), installed by setup.sh once the restic keys
# are stored. A repository that holds the panel's snapshots is refused.
#
#   node-backup.sh [--tag nightly|manual|move] [--verify]
#   node-backup.sh --status              the last backup and whether it is too old (exit 1 then)
#   node-backup.sh --show-recovery-key   RESTIC_REPOSITORY and RESTIC_PASSWORD, to keep elsewhere
#   node-backup.sh --forget-host <host>  after a move: the old node's snapshots, all but its move
#                                        snapshot (forgotten now, pruned on Sunday)
#   node-backup.sh --cleanup             containers a killed run left (the unit's ExecStopPost)
#
# --tag move is the last backup before a move (section 8): postfix-mailcow and dovecot-mailcow must
# be stopped first. Their containers and the watchdog's then get the restart policy "no" (the
# watchdog is stopped too), the snapshot must be complete (restic reading every file), and once
# they are checked to be still down the node is standby: its backup stops, eop-ranges.sh closes the
# mail ports. setup.sh --end-standby undoes all of it if the move is called off.
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
# Where the cron line writes the output (systemd keeps it in the journal).
NODE_BACKUP_LOG=${MAILEXPERT_NODE_BACKUP_LOG:-/var/log/mailexpert-node-backup.log}
PING_URL='' STARTED=0 DUMP_ROOT='' DUMP_DIR='' VERIFY_DIR='' VERIFY_SECONDS='' MAILCOW_REF=unknown
MAILBOXES='' DUMP_KB=0
# The node's restic containers carry a label, so the next run finds what a killed one left.
RESTIC_DOCKER_ARGS=(--label "$NODE_BACKUP_LABEL")

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# shellcheck disable=SC2317,SC2329 # called from finish, which only the EXIT trap invokes
# log_hint: where this run's output is: the journal under systemd, the log file under cron.
log_hint() {
  if [ -n "${INVOCATION_ID:-}" ]; then echo "journalctl -u mailexpert-node-backup"; else echo "$NODE_BACKUP_LOG"; fi
}

# shellcheck disable=SC2317,SC2329 # invoked only through `trap finish EXIT` in main
finish() {
  local status=$?
  if [ -n "$VERIFY_DIR" ]; then rm -rf "$VERIFY_DIR"; fi
  if [ -n "$DUMP_ROOT" ]; then rm -rf "$DUMP_ROOT"; fi
  if [ "$status" != 0 ] && [ "$STARTED" = 1 ]; then
    send_ping "$PING_URL" fail "node-backup.sh failed with exit $status; see $(log_hint)"
  fi
  exit "$status"
}

mailcow_compose() { (cd "$MAILCOW_DIR" && docker compose "$@"); }

# volume_kb <volume>: the size of a Docker volume on disk, in kB; 0 when it does not exist.
volume_kb() {
  local path
  path=$(volume_path "$1") || { echo 0; return 0; }
  du -sk "$path" 2>/dev/null | awk '{print $1 + 0}' || echo 0
}

# check_space <need kB> [what]: <need> fits in NODE_BACKUP_DIR with the reserve left free.
check_space() {
  local need=$1 size free reserve problem
  read -r size free < <(df -Pk "$NODE_BACKUP_DIR" | awk 'NR == 2 {print $2, $4}')
  reserve=$(space_reserve_kb "${size:-0}" "$(node_setting NODE_BACKUP_RESERVE_PERCENT "$NODE_BACKUP_RESERVE_PERCENT_DEFAULT")" \
    "$(node_setting NODE_BACKUP_RESERVE_GB "$NODE_BACKUP_RESERVE_GB_DEFAULT")")
  problem=$(space_problem "$need" "${free:-0}" "$reserve" "$NODE_BACKUP_DIR" "${2:-}")
  [ -z "$problem" ] || die "$problem"
}

# dump_need: the space mailcow's dump needs, from the sizes of its volumes.
dump_need() {
  local mysql=0 other=0 name
  for name in "${MAILCOW_COMPONENTS[@]}"; do
    if [ "$name" = mysql ]; then
      mysql=$(volume_kb "$(mailcow_volume "$PROJECT" mysql)")
    else
      other=$((other + $(volume_kb "$(mailcow_volume "$PROJECT" "$name")")))
    fi
  done
  dump_need_kb "$mysql" "$other"
}

# archive_list <dir> <archive>: tar -t of one of mailcow's archives, in mailcow's backup image
# (restic's has no zstd), bounded.
archive_list() {
  timeout "$NODE_BACKUP_SHORT_TIMEOUT" docker run --rm --network none -v "$1:/backup:ro" "$MAILCOW_BACKUP_IMAGE" \
    tar --use-compress-program=zstd -tf "/backup/$2" 2>/dev/null
}

# dump_mailcow <timeout>: mailcow's backup of everything but vmail into a fresh directory, which
# DUMP_DIR names afterwards. Its output (tar lists every file) goes to a log next to the dump.
dump_mailcow() {
  local timeout=$1 location=$NODE_BACKUP_DIR/mailcow log=$NODE_BACKUP_DIR/mailcow-backup.log code=0 started
  local -a dirs
  local script=$MAILCOW_DIR/helper-scripts/backup_and_restore.sh problems crypt mariadb
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
    remove_leftovers
    die "mailcow's backup ran past NODE_BACKUP_DUMP_TIMEOUT (${timeout}s) and was stopped; see $log"
  fi
  [ "$code" = 0 ] ||
    die "mailcow's backup failed (exit $code; it pulls $MAILCOW_BACKUP_IMAGE, so ghcr.io must be reachable); see $log"
  mapfile -t dirs < <(find "$location" -mindepth 1 -maxdepth 1 -type d -name 'mailcow-*')
  [ "${#dirs[@]}" = 1 ] || die "mailcow's backup left ${#dirs[@]} directories in $location instead of one; see $log"
  problems=$(dump_problems "${dirs[0]}")
  [ -z "$problems" ] || die "mailcow's backup is incomplete ($(paste -sd';' - <<<"$problems")); see $log"
  crypt=$(archive_list "${dirs[0]}" backup_crypt.tar.zst) || crypt=''
  mariadb=$(archive_list "${dirs[0]}" backup_mariadb.tar.zst) || mariadb=''
  problems=$(archive_problems "$crypt" "$mariadb")
  [ -z "$problems" ] || die "mailcow's backup is incomplete ($(paste -sd';' - <<<"$problems")); see $log"
  DUMP_DIR=${dirs[0]}
}

# add_node_files <dump dir>: what a new node needs besides mailcow's dump: mailcow's configuration
# files and certificates, its compose override, its customizations outside data/conf (web settings,
# CSS, pre-start hooks), node.env, and meta.json: the mailcow commit and
# the number of mailboxes (node-restore.sh checks the restored database against it).
add_node_files() {
  local dir=$1/mailexpert commit describe file
  mkdir -m 700 "$dir"
  if [ -d "$MAILCOW_DIR/data/conf" ]; then cp -a "$MAILCOW_DIR/data/conf" "$dir/conf"; fi
  if [ -d "$MAILCOW_DIR/data/assets/ssl" ]; then cp -a "$MAILCOW_DIR/data/assets/ssl" "$dir/ssl"; fi
  if [ -f "$MAILCOW_DIR/docker-compose.override.yml" ]; then cp -p "$MAILCOW_DIR/docker-compose.override.yml" "$dir/"; fi
  # mailcow's customizations outside data/conf: its web settings and CSS, and the containers'
  # pre-start hooks.
  for file in "${MAILCOW_CUSTOM_FILES[@]}"; do
    if [ -f "$MAILCOW_DIR/data/$file" ]; then
      mkdir -p "$dir/$(dirname "$file")"
      cp -p "$MAILCOW_DIR/data/$file" "$dir/$file"
    fi
  done
  # data/hooks is always recorded, empty when the node has none: node-restore.sh then mirrors it
  # and sets aside hooks an earlier restore left. An older snapshot has no hooks directory at all.
  if [ -d "$MAILCOW_DIR/data/hooks" ]; then
    cp -a "$MAILCOW_DIR/data/hooks" "$dir/hooks"
  else
    mkdir -m 755 "$dir/hooks"
  fi
  cp -p "$NODE_CONF" "$dir/node.env"
  commit=$(git -C "$MAILCOW_DIR" rev-parse HEAD 2>/dev/null) || commit=unknown
  describe=$(git -C "$MAILCOW_DIR" describe --tags --always 2>/dev/null) || describe=unknown
  MAILBOXES=$(mailcow_mailboxes "$MAILCOW_DIR") || MAILBOXES=''
  if [ -z "$MAILBOXES" ]; then warn "mailcow's database did not answer the mailbox count; node-restore.sh will not compare it"; fi
  jq -n --arg commit "$commit" --arg describe "$describe" --arg project "$PROJECT" --arg arch "$(uname -m)" \
    --arg mailboxes "$MAILBOXES" \
    '{mailcow_commit: $commit, mailcow_version: $describe, compose_project: $project, arch: $arch,
      mailboxes: (if $mailboxes == "" then null else ($mailboxes | tonumber) end)}' >"$dir/meta.json"
  MAILCOW_REF=$describe
}

# forget_old <weekday> <tag>: this node's own snapshots only (--host), the ones of the mailcow tag:
# the last 5 pre-update snapshots (the node agent's update, like the panel's backup.sh); otherwise
# 7 daily, 4 weekly and 6 monthly, and every pre-update and move snapshot outside that policy.
forget_old() {
  local -a prune=()
  if prune_today "$1" "$2"; then prune=(--prune); fi
  restic_run -t "$NODE_BACKUP_FORGET_TIMEOUT" -- forget --host "$RESTIC_HOST" --tag "$NODE_BACKUP_TAG,pre-update" \
    --keep-last 5 >/dev/null ||
    die "restic forget (pre-update) failed or ran past ${NODE_BACKUP_FORGET_TIMEOUT}s (the snapshot is stored; retention runs again next night)"
  restic_run -t "$NODE_BACKUP_FORGET_TIMEOUT" -- forget --host "$RESTIC_HOST" --tag "$NODE_BACKUP_TAG" \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --keep-tag move --keep-tag pre-update "${prune[@]}" >/dev/null ||
    die "restic forget failed or ran past ${NODE_BACKUP_FORGET_TIMEOUT}s (the snapshot is stored; retention runs again next night)"
}

# verify_snapshot <snapshot> <read subset> <timeout>: restic reads back part of the repository,
# then the dump and one mailbox are restored into a temporary directory (restic compares every file
# it wrote; there must be room for them and the reserve), mailcow's archives are listed whole, and
# mailcow.conf names the host. Every restic call is bounded by <timeout>. Sets VERIFY_SECONDS.
verify_snapshot() {
  local snapshot=$1 subset=$2 timeout=$3 week domain='' box='' started problems files=0 need
  local -a domains boxes include=(--include /backup)
  restic_run -t "$timeout" -- check --read-data-subset="$subset" >/dev/null ||
    die "verify: restic check --read-data-subset=$subset found a problem or ran past NODE_BACKUP_VERIFY_TIMEOUT (${timeout}s); run it by hand to see which"
  week=$(date +%V)
  mapfile -t domains < <(restic_run -t "$timeout" -- ls --json "$snapshot" /vmail | mailbox_children /vmail)
  if [ "${#domains[@]}" -gt 0 ]; then
    domain=$(pick_rotating "$week" "${domains[@]}")
    mapfile -t boxes < <(restic_run -t "$timeout" -- ls --json "$snapshot" "/vmail/$domain" | mailbox_children "/vmail/$domain")
    if [ "${#boxes[@]}" -gt 0 ]; then
      box=$(pick_rotating "$week" "${boxes[@]}")
      include+=(--include "/vmail/$domain/$box")
    fi
  fi
  need=$DUMP_KB
  if [ -n "$box" ]; then
    need=$((need + $(restic_run -t "$timeout" -- ls --json --recursive "$snapshot" "/vmail/$domain/$box" | snapshot_size_kb)))
  fi
  check_space "$need" "the restore check"
  VERIFY_DIR=$NODE_BACKUP_DIR/verify-$(gen_hex 4)
  mkdir -m 700 "$VERIFY_DIR"
  started=$SECONDS
  restic_run -t "$timeout" -v "$VERIFY_DIR:/restore" -- restore "$snapshot" --target /restore --verify "${include[@]}" >/dev/null ||
    die "verify: restic could not restore the dump and a mailbox of snapshot ${snapshot:0:8} within NODE_BACKUP_VERIFY_TIMEOUT (${timeout}s)"
  VERIFY_SECONDS=$((SECONDS - started))
  problems=$(dump_problems "$VERIFY_DIR/backup")
  [ -z "$problems" ] || die "verify: the restored dump is incomplete ($(paste -sd';' - <<<"$problems"))"
  [ -n "$(env_get "$VERIFY_DIR/backup/mailcow.conf" MAILCOW_HOSTNAME 2>/dev/null || true)" ] ||
    die "verify: the restored mailcow.conf has no MAILCOW_HOSTNAME"
  [ -f "$VERIFY_DIR/backup/mailexpert/meta.json" ] || die "verify: the restored dump has no mailexpert/meta.json"
  ensure_image "$MAILCOW_BACKUP_IMAGE"
  # shellcheck disable=SC2016 # expanded by the container's shell
  timeout "$timeout" docker run --rm --network none -v "$VERIFY_DIR/backup:/backup:ro" "$MAILCOW_BACKUP_IMAGE" /bin/sh -c \
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

# check_repository: stale locks of a killed run unlocked (restic removes only locks nobody
# refreshed for 30 minutes), and a repository that holds the panel's snapshots refused: one
# password for both would let a mix-up restore the panel's data onto a node or the other way round.
check_repository() {
  local panel
  restic_run -t "$NODE_BACKUP_SHORT_TIMEOUT" -- unlock >/dev/null 2>&1 || warn "restic unlock did not run; a stale lock may stop this run"
  panel=$(restic_run -t "$NODE_BACKUP_SHORT_TIMEOUT" -- snapshots --json | panel_hosts | paste -sd' ' -) ||
    die "restic could not list the snapshots of the repository (unreachable, or a wrong key)"
  [ -z "$panel" ] ||
    die "the repository in RESTIC_REPOSITORY holds the panel's snapshots ($panel): give the node a repository of its own (section 7)"
}

# forget_host <host>: after a move, the old node's snapshots all go but its move snapshot.
forget_host() {
  local host=$1 json
  if ! restic_host_ok "$host" || ! [[ $host =~ $NODE_HOST_RE ]]; then
    die "--forget-host: $host is not a node's restic host (mailexpert-node-...)" 2
  fi
  load_restic_env
  load_restic_host "$NODE_RESTIC_HOST_PREFIX"
  [ "$host" != "$RESTIC_HOST" ] || die "--forget-host: $host is this node's own host" 2
  ensure_image "$RESTIC_IMAGE"
  json=$(restic_run -t "$NODE_BACKUP_SHORT_TIMEOUT" -- snapshots --json --host "$host" --tag move) ||
    die "restic could not list the snapshots of $host"
  [ "$(jq length <<<"$json")" -gt 0 ] || die "--forget-host: $host has no move snapshot; nothing is forgotten" 2
  restic_run -t "$NODE_BACKUP_FORGET_TIMEOUT" -- forget --host "$host" --tag "$NODE_BACKUP_TAG" --keep-tag move >/dev/null ||
    die "restic forget failed"
  log "the snapshots of $host are forgotten but its move snapshot; their space is freed by the Sunday prune"
}

# move_freeze: the old node's mail services may not come back once the move snapshot exists.
move_freeze() {
  local running
  running=$(mailcow_running "$MAILCOW_DIR" postfix-mailcow dovecot-mailcow | paste -sd' ' -)
  [ -z "$running" ] ||
    die "--tag move: $running still runs; stop it first (docker compose stop postfix-mailcow dovecot-mailcow in $MAILCOW_DIR), EOP keeps the mail in its queue"
  mailcow_restart_policy "$MAILCOW_DIR" no "${STANDBY_SERVICES[@]}" ||
    die "--tag move: docker update --restart=no failed for ${STANDBY_SERVICES[*]}"
  mailcow_compose stop watchdog-mailcow >/dev/null 2>&1 || warn "could not stop watchdog-mailcow"
  log "move: ${STANDBY_SERVICES[*]} will not restart by themselves (restart policy no; setup.sh --end-standby restores it)"
}

main() {
  local tag=nightly verify=0 show_key=0 status=0 cleanup=0 forget='' started dump seconds dump_seconds dump_bytes
  local push_started push_seconds code=0 summary snapshot processed added weekday checks subset partial=0
  local dump_timeout push_timeout verify_timeout vmail running count limit body
  while [ $# -gt 0 ]; do
    case $1 in
      --tag | --forget-host)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        if [ "$1" = --tag ]; then tag=$2; else forget=$2; fi
        shift 2
        ;;
      --verify) verify=1 && shift ;;
      --show-recovery-key) show_key=1 && shift ;;
      --status) status=1 && shift ;;
      --cleanup) cleanup=1 && shift ;;
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
  mkdir -p "$NODE_STATE"
  if [ "$cleanup" = 1 ]; then
    take_lock "$NODE_STATE/backup.lock" 60 "another node-backup.sh"
    remove_leftovers
    return 0
  fi
  if [ -n "$forget" ]; then
    backup_configured "$NODE_CONF" || die "node backups are not configured" 2
    take_lock "$NODE_STATE/backup.lock" "$LOCK_TIMEOUT" "another node-backup.sh"
    forget_host "$forget"
    return 0
  fi
  if [ -f "$(node_standby_file)" ]; then
    log "standby node (moved away with --tag move): backup skipped; setup.sh --end-standby on this node ends standby"
    return 0
  fi

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
  remove_leftovers
  dump_timeout=$(node_setting NODE_BACKUP_DUMP_TIMEOUT "$NODE_BACKUP_DUMP_TIMEOUT_DEFAULT")
  push_timeout=$(node_setting NODE_BACKUP_PUSH_TIMEOUT "$NODE_BACKUP_PUSH_TIMEOUT_DEFAULT")
  verify_timeout=$(node_setting NODE_BACKUP_VERIFY_TIMEOUT "$NODE_BACKUP_VERIFY_TIMEOUT_DEFAULT")
  subset=$(node_setting NODE_BACKUP_READ_SUBSET "$NODE_BACKUP_READ_SUBSET_DEFAULT")
  limit=$(node_setting NODE_BACKUP_PARTIAL_LIMIT "$NODE_BACKUP_PARTIAL_LIMIT_DEFAULT")

  load_restic_env
  load_restic_host "$NODE_RESTIC_HOST_PREFIX"
  ensure_image "$RESTIC_IMAGE"
  check_repository
  if [ "$tag" = move ]; then move_freeze; fi

  install -d -m 700 "$NODE_BACKUP_DIR"
  check_space "$(dump_need)"
  started=$SECONDS
  dump_mailcow "$dump_timeout"
  dump=$DUMP_DIR
  dump_seconds=$((SECONDS - started))
  add_node_files "$dump"
  DUMP_KB=$(du -sk "$dump" | awk '{print $1}')
  dump_bytes=$((DUMP_KB * 1024))
  log "mailcow dumped in ${dump_seconds}s, $dump_bytes bytes (without vmail)"

  push_started=$SECONDS
  restic_run -t "$push_timeout" -v "$dump:/backup:ro" -v "$vmail:/vmail:ro" -- backup --json \
    --host "$RESTIC_HOST" --tag "$NODE_BACKUP_TAG" --tag "$tag" /backup /vmail >"$DUMP_ROOT/restic.json" || code=$?
  push_seconds=$((SECONDS - push_started))
  summary=$(jq -c 'select(.message_type == "summary")' "$DUMP_ROOT/restic.json" 2>/dev/null | tail -n 1) || summary=''
  snapshot=$(jq -r '.snapshot_id // empty' <<<"$summary" 2>/dev/null) || snapshot=''
  case $code in
    0) ;;
    # Exit 3: the snapshot is saved, but some files could not be read: mail Dovecot moved or
    # expunged while restic read the volume. A move needs every file (Dovecot is stopped, so this
    # is a real read error); a nightly run counts it.
    3)
      [ "$tag" != move ] ||
        die "restic could not read some files of the stopped node (its messages are above); a move needs a complete snapshot: fix the cause and run --tag move again"
      if [ -n "$snapshot" ]; then partial=1; fi
      ;;
    *)
      remove_leftovers
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
  # The dump is in the snapshot: its space is the restore check's.
  rm -rf "$DUMP_ROOT"
  DUMP_ROOT=''
  weekday=$(date +%u)
  forget_old "$weekday" "$tag"
  checks=$(node_backup_checks "$weekday" "$tag" "$verify")
  if [ "$checks" = verify ]; then verify_snapshot "$snapshot" "$subset" "$verify_timeout"; fi
  seconds=$((SECONDS - started))
  count=0
  if [ -f "$(node_backup_partial_file)" ]; then count=$(<"$(node_backup_partial_file)"); fi
  [[ $count =~ ^[0-9]+$ ]] || count=0
  count=$(partial_count "$count" "$partial")
  printf '%s\n' "$count" >"$(node_backup_partial_file)"
  write_node_backup_last "$snapshot" "$tag" "$seconds" "$dump_seconds" "$dump_bytes" "$push_seconds" \
    "$processed" "$added" "$MAILCOW_REF" "$VERIFY_SECONDS" "$partial"
  body="snapshot ${snapshot:0:8} ($tag): $processed bytes, $added new, in ${seconds}s${VERIFY_SECONDS:+, verified, restored in ${VERIFY_SECONDS}s}"
  if [ "$partial" = 1 ]; then
    warn "restic could not read some files (mail moved while it read the volume); the snapshot is saved without them ($count run(s) in a row)"
    [ "$count" -lt "$limit" ] ||
      die "restic could not read some files $count runs in a row (NODE_BACKUP_PARTIAL_LIMIT $limit): look at its messages above; the snapshots are saved without those files"
    body="$body; partial: restic could not read some files ($count run(s) in a row)"
  fi
  if [ "$tag" = move ]; then
    # Nothing may have come back while the snapshot was made.
    running=$(mailcow_running "$MAILCOW_DIR" postfix-mailcow dovecot-mailcow | paste -sd' ' -)
    [ -z "$running" ] ||
      die "--tag move: $running runs again; mail may have arrived after the snapshot: stop it and run --tag move again"
    : >"$(node_standby_file)"
  fi
  send_ping "$PING_URL" success "$body"
  log "node backup done"
  if [ "$tag" = move ]; then
    log "move: snapshot ${snapshot:0:8} of node $RESTIC_HOST is the one to restore on the new node: node-restore.sh ${snapshot:0:8} --host $RESTIC_HOST"
    log "move: this node is standby now: its backup is skipped, eop-ranges.sh closes the mail ports"
    log "move: if the move is called off: setup.sh --end-standby here (restart policies back, mailcow started, ports open again)"
  fi
}

# One line: bash has read it whole before main runs.
main "$@"; exit $?
