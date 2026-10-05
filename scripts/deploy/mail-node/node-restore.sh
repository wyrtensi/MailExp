#!/usr/bin/env bash
# Restores a mail node backup (node-backup.sh) onto a fresh server: a move of the node, or a node
# rebuilt after a loss (docs/operations/mail-node.md, sections 7 and 8).
#
# Before it: Docker on the new server, this repository checked out, and mailcow cloned into
# --mailcow-dir at the version the backup was made on (the script names it and refuses another
# one), `ln -s mailcow.conf .env && ./generate_config.sh` run there (it writes files mailcow needs
# besides mailcow.conf, which the backup's then replaces), and nothing of mailcow started yet. The restic
# keys come from node.env when this server has one, otherwise as KEY=VALUE lines on stdin
# (RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and, when the
# storage needs it, AWS_DEFAULT_REGION): never as arguments.
#
# What it does:
#   1. restores the snapshot's /backup (mailcow's dump and the node's files) into a temporary
#      directory under /var/backups/mailexpert-node;
#   2. puts mailcow.conf (with the .env link mailcow expects), data/conf, data/assets/ssl,
#      data/hooks and docker-compose.override.yml in place, exactly as the snapshot has them: what
#      those directories hold here but the snapshot does not (or as another kind: a directory for a
#      file), and an override the snapshot does not have, is moved, never deleted, into one holding
#      directory of the run outside mailcow's checkout,
#      /var/backups/mailexpert-node/pre-restore-<epoch>/ (0700, the same paths under it), each path
#      logged; mailcow's data/web/inc/vars.local.inc.php and data/web/css/build/0081-custom-mailcow.css
#      when the snapshot has them; node.env only when this server has none;
#   3. pulls mailcow's images and starts it, which creates its volumes;
#   4. restores vmail straight from the repository into the vmail volume, Dovecot stopped: only
#      files missing or changed are downloaded, and mail no longer in the snapshot is removed;
#   5. runs mailcow's own `backup_and_restore.sh restore` for crypt, mysql, redis, rspamd and
#      postfix, answering its questions (restore point, all data sets, the SQL restore's
#      confirmation) after checking that this mailcow version asks exactly those;
#   6. starts mailcow whole again; --resync then has Dovecot rebuild its indexes of every mailbox.
# Afterwards: setup.sh (firewall, EOP ranges, timers; node.env from the backup holds the panel's
# addresses and the EOP host), the A record of <MAIL_HOST> and the PTR, then the checks of
# section 8.
#
# Then it checks the result itself, whatever mailcow's script printed: the mail_crypt keys are in
# the crypt volume, and the database answers with the number of mailboxes the backup recorded.
#
# A move with a lot of mail restores twice, so that the mail is mostly in place before the old
# node stops: --rehearsal first, from a nightly snapshot while the old node still works (Postfix's
# data set, the mail queue, is left out: the queued mail would go out a second time; at the end
# postfix-mailcow, ofelia-mailcow (it runs the sync jobs) and the watchdog are stopped with the
# restart policy "no"), then --update from the move snapshot, which only downloads what changed
# since. What the script did on a server is kept in /var/lib/mailexpert-node/restored (STATE):
#   in-progress  a restore that stopped half way: run it again (the same or a newer snapshot of the
#                same node, or a move snapshot);
#   rehearsal    only --update, from a newer snapshot of the same node or a move snapshot;
#   live         a restore that is not a rehearsal, or setup.sh on the server: never again.
# A server without the file must be fresh (no vmail or mysql volume, mailcow not running).
#
# latest without --host is refused when the repository holds snapshots of several nodes (they are
# listed): a move leaves the old node's next to the new one's.
#
#   node-restore.sh latest|<snapshot id> [--host <restic host>] [--mailcow-dir DIR]
#                   [--rehearsal | --update] [--resync]
#
# latest is the newest snapshot of the node (--host, as restic snapshots lists them). The node and
# time restored are printed.
#
# Exit codes: 0 restored, 1 failure, 2 invalid input or not a fresh server (nothing changed).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
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

# How long mailcow's restore of the small data sets may take.
RESTORE_TIMEOUT=${MAILEXPERT_NODE_RESTORE_TIMEOUT:-3600}
# How often, 5 s apart, the restored database is asked for its mailboxes while it starts.
DB_TRIES=${MAILEXPERT_NODE_RESTORE_DB_TRIES:-36}
# What a rehearsal stops: the mail queue's delivery, the sync jobs and other scheduled jobs, and the
# watchdog, which would start them again.
REHEARSAL_SERVICES=(postfix-mailcow ofelia-mailcow watchdog-mailcow)
WORK=''
REHEARSAL=0
RESTORE_LOG=''
# Where this run sets aside what data/conf and data/assets/ssl hold but the snapshot does not.
HOLD_DIR=''

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# shellcheck disable=SC2317,SC2329 # invoked only through `trap cleanup EXIT` in main
cleanup() {
  local status=$?
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  exit "$status"
}

mailcow_compose() { (cd "$MAILCOW_DIR" && docker compose "$@"); }

# read_keys: the restic keys from KEY=VALUE lines on stdin, exported for restic_run; other keys
# and comments are skipped. Values are never printed.
read_keys() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    key=${line%%=*} value=${line#*=}
    case $key in
      RESTIC_REPOSITORY | RESTIC_PASSWORD | AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_DEFAULT_REGION)
        export "$key=$value"
        ;;
    esac
  done
  for key in "${RESTIC_KEYS[@]}"; do
    [ -n "${!key:-}" ] ||
      die "the restic keys are missing: RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as KEY=VALUE lines on stdin" 2
  done
  restic_repository_ok "$RESTIC_REPOSITORY" || die "RESTIC_REPOSITORY must be s3:https://<endpoint>/<bucket>[/<path>]" 2
}

# fresh_server_problem <project>: why this is not a server to restore onto; nothing when it is.
fresh_server_problem() {
  local volume name
  for name in vmail mysql; do
    volume=$(mailcow_volume "$1" "$name")
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      echo "the volume $volume exists already: this is not a fresh mailcow (node-restore.sh never overwrites mail)"
      return 0
    fi
  done
  if [ -n "$(mailcow_compose ps -q 2>/dev/null)" ]; then echo "mailcow runs already in $MAILCOW_DIR"; fi
  return 0
}

# entry_kind <path>: link, dir or file, without following a symbolic link.
entry_kind() {
  if [ -L "$1" ]; then echo link; elif [ -d "$1" ]; then echo dir; else echo file; fi
}

# set_aside <path relative to MAILCOW_DIR>: moved, never deleted, into this run's holding directory
# NODE_BACKUP_DIR/pre-restore-<epoch> (0700 inside NODE_BACKUP_DIR's 0700: certificates' keys may be
# among it) under the same path. Not inside mailcow's checkout: its update.sh commits what is
# untracked there when a merge conflicts. Copied (owners, modes and times kept), then removed, so
# NODE_BACKUP_DIR may be on another file system.
set_aside() {
  local rel=$1 n=1 base
  if [ -z "$HOLD_DIR" ]; then
    base=$NODE_BACKUP_DIR/pre-restore-$(date +%s)
    HOLD_DIR=$base
    until mkdir -m 700 "$HOLD_DIR" 2>/dev/null; do
      [ "$n" -lt 100 ] || die "could not create a holding directory $base-<n>"
      n=$((n + 1)) && HOLD_DIR=$base-$n
    done
  fi
  mkdir -p "$HOLD_DIR/$(dirname "$rel")"
  cp -a "$MAILCOW_DIR/$rel" "$HOLD_DIR/$rel" || die "could not copy $MAILCOW_DIR/$rel aside into $HOLD_DIR"
  rm -rf "${MAILCOW_DIR:?}/$rel"
  if [ -e "$MAILCOW_DIR/$rel" ] || [ -L "$MAILCOW_DIR/$rel" ]; then
    die "could not remove $MAILCOW_DIR/$rel (its copy is in $HOLD_DIR)"
  fi
  log "not in the snapshot, set aside: $rel"
}

# mirror_dir <snapshot's copy> <directory relative to MAILCOW_DIR>: the directory becomes exactly
# the snapshot's. What is here but not in the snapshot, or of another kind there (a directory where
# the snapshot has a file, a link where it has a file), is set aside whole (a directory once, with
# what it holds), then the snapshot's files are copied over the rest. The backup copies these
# directories whole, so nothing in them is the server's own to keep.
mirror_dir() {
  local src=$1 rel=$2 dst=$MAILCOW_DIR/$2 path sub
  local -a paths
  mkdir -p "$dst"
  mapfile -d '' -t paths < <(cd "$dst" && find . -mindepth 1 -print0)
  # find lists a directory before what it holds: once it is set aside, those are gone here.
  for path in "${paths[@]}"; do
    sub=${path#./}
    [ -e "$dst/$sub" ] || [ -L "$dst/$sub" ] || continue
    if [ -e "$src/$sub" ] || [ -L "$src/$sub" ]; then
      [ "$(entry_kind "$dst/$sub")" != "$(entry_kind "$src/$sub")" ] || continue
    fi
    set_aside "$rel/$sub"
  done
  cp -a "$src/." "$dst/"
}

# place_files <dir with the restored backup>: mailcow.conf and the node's files where mailcow and
# setup.sh read them. data/conf, data/assets/ssl and data/hooks mirror the snapshot (mirror_dir);
# mailcow's web settings and CSS (MAILCOW_CUSTOM_FILES) are copied when the snapshot has them.
place_files() {
  local src=$1/mailexpert file
  install -m 600 "$1/mailcow.conf" "$MAILCOW_DIR/mailcow.conf"
  ln -sfn mailcow.conf "$MAILCOW_DIR/.env"
  mkdir -p "$MAILCOW_DIR/data/conf" "$MAILCOW_DIR/data/assets"
  if [ -d "$src/conf" ]; then mirror_dir "$src/conf" data/conf; fi
  if [ -d "$src/ssl" ]; then mirror_dir "$src/ssl" data/assets/ssl; fi
  if [ -d "$src/hooks" ]; then mirror_dir "$src/hooks" data/hooks; fi
  for file in "${MAILCOW_CUSTOM_FILES[@]}"; do
    if [ -f "$src/$file" ]; then
      mkdir -p "$MAILCOW_DIR/data/$(dirname "$file")"
      cp -p "$src/$file" "$MAILCOW_DIR/data/$file"
    fi
  done
  # The override is the snapshot's or none: one left by a rehearsal of an older snapshot (or put
  # here before the restore) would start mailcow with settings the restored node no longer has.
  if [ -f "$src/docker-compose.override.yml" ]; then
    cp -p "$src/docker-compose.override.yml" "$MAILCOW_DIR/"
  elif [ -f "$MAILCOW_DIR/docker-compose.override.yml" ]; then
    set_aside docker-compose.override.yml
  fi
  if [ -n "$HOLD_DIR" ]; then
    log "set aside in $HOLD_DIR (the same paths under it): put back by hand what the node still needs"
  fi
  if [ -f "$NODE_CONF" ]; then
    log "$NODE_CONF exists here and stays; the backup's copy is not used"
  elif [ -f "$src/node.env" ]; then
    install -d -m 700 "$(dirname "$NODE_CONF")"
    sed "s|^MAILCOW_DIR=.*|MAILCOW_DIR=$MAILCOW_DIR|" "$src/node.env" >"$NODE_CONF"
    chmod 600 "$NODE_CONF"
    log "$NODE_CONF: taken from the backup (panel addresses, EOP host, pings, restic keys)"
  fi
}

# restore_vmail <snapshot> <volume>: the mail straight from the repository into the volume, while
# Dovecot is stopped; restic restores owners and modes and checks every file it writes. Files of the
# right size and time stay (an update after a rehearsal downloads only what changed), files the
# snapshot does not have go (--delete applies to the included /vmail only).
restore_vmail() {
  local started=$SECONDS
  mailcow_compose stop dovecot-mailcow >/dev/null
  restic_run -v "$2:/restore/vmail" -- restore "$1" --target /restore --include /vmail \
    --overwrite if-changed --delete --verify >/dev/null ||
    die "restic could not restore vmail into $2"
  log "vmail restored in $((SECONDS - started))s"
}

# keep_restore_log <log>: mailcow's output where the owner finds it after a failure.
keep_restore_log() {
  cp "$1" "$NODE_BACKUP_DIR/mailcow-restore.log"
  chmod 600 "$NODE_BACKUP_DIR/mailcow-restore.log"
}

# restore_mailcow <dir with the restored backup>: mailcow's own restore of everything else, its
# questions answered: restore point 1 (the only one in the location), data set 0 (all), and yes to
# the SQL restore, which stops and starts mailcow. (Its `docker run -i` steps may read what is left
# of the answers; the SQL question then reads nothing, and an empty answer is its default, yes.)
# Its exit status says little (it goes on after a step that failed): check_restored decides.
restore_mailcow() {
  local location=$WORK/location log=$WORK/mailcow-restore.log code=0
  mkdir -m 755 "$location"
  # A rehearsal leaves the mail queue out: the old node still delivers it.
  if [ "$REHEARSAL" = 1 ]; then rm -f "$1/backup_postfix.tar.zst"; fi
  mv "$1" "$location/mailcow-restore"
  printf '1\n0\ny\n' | MAILCOW_BACKUP_LOCATION=$location timeout "$RESTORE_TIMEOUT" \
    "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh" restore >"$log" 2>&1 || code=$?
  if [ "$code" != 0 ]; then
    keep_restore_log "$log"
    die "mailcow's restore failed (exit $code); its output: $NODE_BACKUP_DIR/mailcow-restore.log"
  fi
  RESTORE_LOG=$log
}

# check_restored <project> <mailboxes the backup recorded, or ''>: what mailcow's restore must have
# done, checked on the server: the mail_crypt key pair in the crypt volume, and the database
# answering with the backup's number of mailboxes (it may take a while to start).
check_restored() {
  local crypt problems='' count='' try key
  crypt=$(volume_path "$(mailcow_volume "$1" crypt)") || crypt=''
  for key in ecprivkey.pem ecpubkey.pem; do
    if [ -z "$crypt" ] || [ ! -s "$crypt/$key" ]; then problems+="the crypt volume has no $key; "; fi
  done
  for ((try = 1; try <= DB_TRIES; try++)); do
    if count=$(mailcow_mailboxes "$MAILCOW_DIR"); then break; fi
    count=''
    [ "$try" = "$DB_TRIES" ] || sleep 5
  done
  if [ -z "$count" ]; then
    problems+="mailcow's database does not answer; "
  elif [ -n "$2" ] && [ "$count" != "$2" ]; then
    problems+="the database has $count mailboxes, the backup $2; "
  fi
  if [ -n "$problems" ]; then
    keep_restore_log "$RESTORE_LOG"
    die "mailcow's restore is incomplete: ${problems%; }; its output: $NODE_BACKUP_DIR/mailcow-restore.log; run node-restore.sh again (section 8)"
  fi
  log "restored: the mail_crypt keys in place, ${count} mailboxes in the database${2:+ (as in the backup)}"
}

main() {
  local snapshot='' host='' resync=0 update=0 picked id from at epoch tags project commit here problem
  local state='' mhost='' mepoch=0 hosts mailboxes
  MAILCOW_DIR=''
  while [ $# -gt 0 ]; do
    case $1 in
      --host | --mailcow-dir)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        case $1 in
          --host) host=$2 ;;
          --mailcow-dir) MAILCOW_DIR=${2%/} ;;
        esac
        shift 2
        ;;
      --resync) resync=1 && shift ;;
      --rehearsal) REHEARSAL=1 && shift ;;
      --update) update=1 && shift ;;
      -h | --help) usage && return 0 ;;
      -*) die "unknown option: $1 (see --help)" 2 ;;
      *)
        [ -z "$snapshot" ] || die "one snapshot only" 2
        snapshot=$1 && shift
        ;;
    esac
  done
  [ -n "$snapshot" ] || die "name the snapshot: latest or its id (see --help)" 2
  if [ "$REHEARSAL" = 1 ] && [ "$update" = 1 ]; then die "--rehearsal and --update do not go together" 2; fi
  [[ $snapshot == latest || $snapshot =~ ^[0-9a-f]{8,64}$ ]] || die "the snapshot is latest or a hex id" 2
  if [ -n "$host" ]; then restic_host_ok "$host" || die "--host is not a restic host name" 2; fi
  [ "$(id -u)" = 0 ] || die "run node-restore.sh as root"
  [ -n "$MAILCOW_DIR" ] || MAILCOW_DIR=$(env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null) || MAILCOW_DIR=/opt/mailcow-dockerized
  [ -f "$MAILCOW_DIR/docker-compose.yml" ] || die "$MAILCOW_DIR has no docker-compose.yml: clone mailcow there first (section 8)" 2
  mailcow_restore_prompts_ok "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh" ||
    die "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh does not ask the questions node-restore.sh answers (another mailcow version?): restore by hand, section 8" 2
  [ -f "$MAILCOW_DIR/data/web/inc/app_info.inc.php" ] ||
    die "run ln -s mailcow.conf .env && ./generate_config.sh in $MAILCOW_DIR first (with the node's host name; the backup's mailcow.conf replaces the one it writes)" 2

  node_backup_env
  if [ -f "$NODE_CONF" ] && backup_configured "$NODE_CONF"; then
    load_restic_env
  else
    read_keys
  fi
  mkdir -p "$NODE_STATE"
  ensure_image "$RESTIC_IMAGE"
  if [ "$snapshot" = latest ] && [ -z "$host" ]; then
    hosts=$(restic_run -- snapshots --json --tag "$NODE_BACKUP_TAG" | node_hosts "$NODE_BACKUP_TAG") ||
      die "restic could not list the snapshots: the repository is unreachable, or a wrong key"
    if [ "$(grep -c . <<<"$hosts")" -gt 1 ]; then
      die "the repository holds snapshots of several nodes: $(paste -sd' ' - <<<"$hosts"); name one with --host" 2
    fi
  fi
  picked=$(pick_snapshot "$snapshot" "$host" "$NODE_BACKUP_TAG" "$NODE_HOST_RE") ||
    die "restic could not list $snapshot: no such snapshot, or the repository is unreachable"
  [ -n "$picked" ] || die "no node snapshot ($snapshot${host:+ of $host}) in the repository" 2
  read -r id from at epoch tags <<<"$picked"
  log "restoring snapshot ${id:0:8} of node $from, made $at"

  install -d -m 700 "$NODE_BACKUP_DIR"
  WORK=$NODE_BACKUP_DIR/restore-$(gen_hex 4)
  mkdir -m 700 "$WORK"
  trap cleanup EXIT
  restic_run -v "$WORK:/restore" -- restore "$id" --target /restore --include /backup --verify >/dev/null ||
    die "restic could not restore the dump of snapshot ${id:0:8}"
  if [ ! -f "$WORK/backup/mailcow.conf" ] || [ ! -f "$WORK/backup/mailexpert/meta.json" ]; then
    die "snapshot ${id:0:8} is not a node backup (no mailcow.conf or mailexpert/meta.json in /backup)" 2
  fi
  commit=$(jq -r '.mailcow_commit // "unknown"' "$WORK/backup/mailexpert/meta.json")
  here=$(git -C "$MAILCOW_DIR" rev-parse HEAD 2>/dev/null) || here=unknown
  if [ "$commit" != unknown ] && [ "$commit" != "$here" ]; then
    die "mailcow in $MAILCOW_DIR is at ${here:0:12}, the backup was made on $(jq -r '.mailcow_version' "$WORK/backup/mailexpert/meta.json") (${commit:0:12}): git -C $MAILCOW_DIR checkout $commit, then run again; update mailcow after the restore" 2
  fi
  project=$(compose_project "$WORK/backup/mailcow.conf") || die "the backup's mailcow.conf has no COMPOSE_PROJECT_NAME" 2
  if [ -f "$(restore_marker_file)" ]; then
    state=$(env_get "$(restore_marker_file)" STATE 2>/dev/null) || state=unknown
    mhost=$(env_get "$(restore_marker_file)" HOST 2>/dev/null) || mhost=''
    mepoch=$(env_get "$(restore_marker_file)" EPOCH 2>/dev/null) || mepoch=0
    [[ $mepoch =~ ^[0-9]+$ ]] || mepoch=0
  fi
  problem=$(restore_problem "$update" "$state" "$mhost" "$mepoch" "$from" "$epoch" "$tags")
  if [ -z "$problem" ] && [ -z "$state" ]; then problem=$(fresh_server_problem "$project"); fi
  [ -z "$problem" ] || die "$problem" 2
  if [ -n "$state" ]; then log "this server holds a restore ($state) of node $mhost; continuing it with snapshot ${id:0:8}"; fi
  mailboxes=$(jq -r '.mailboxes // empty' "$WORK/backup/mailexpert/meta.json")

  # From here on the server changes: a run that stops can be run again (section 8).
  write_restore_marker in-progress "$id" "$from" "$epoch"
  place_files "$WORK/backup"
  log "mailcow: pulling images and starting (creates the volumes)"
  mailcow_compose pull -q >/dev/null || die "docker compose pull failed in $MAILCOW_DIR"
  mailcow_compose up -d >/dev/null || die "docker compose up -d failed in $MAILCOW_DIR"
  restore_vmail "$id" "$(mailcow_volume "$project" vmail)"
  restore_mailcow "$WORK/backup"
  # A rehearsal's restart policies (no) back to mailcow's own, then everything up.
  if [ "$REHEARSAL" = 0 ]; then mailcow_restart_policy "$MAILCOW_DIR" always "${REHEARSAL_SERVICES[@]}" || true; fi
  mailcow_compose up -d >/dev/null || die "docker compose up -d failed in $MAILCOW_DIR after the restore"
  check_restored "$project" "$mailboxes"
  if [ "$resync" = 1 ]; then
    mailcow_compose exec -T dovecot-mailcow doveadm force-resync -A '*' || warn "doveadm force-resync reported a problem; run it again once Dovecot is up"
  fi
  log "restored snapshot ${id:0:8} of node $from ($at)"
  if [ "$REHEARSAL" = 1 ]; then
    # Nothing leaves a rehearsal: no firewall yet, the old node's certificate and relayhost.
    mailcow_restart_policy "$MAILCOW_DIR" no "${REHEARSAL_SERVICES[@]}" || warn "docker update --restart=no failed"
    mailcow_compose stop "${REHEARSAL_SERVICES[@]}" >/dev/null || warn "could not stop ${REHEARSAL_SERVICES[*]}; stop them by hand"
    write_restore_marker rehearsal "$id" "$from" "$epoch"
    log "rehearsal: ${REHEARSAL_SERVICES[*]} stopped (restart policy no); do not run setup.sh yet; for the move: node-restore.sh <move snapshot> --host $from --update"
    return 0
  fi
  write_restore_marker live "$id" "$from" "$epoch"
  log "next: $SCRIPT_DIR/setup.sh (firewall, EOP ranges, timers), then the A record of the mail host and the PTR (section 8)"
  if [[ ,$tags, == *,move,* ]]; then
    log "after the move is checked: /opt/mailexpert-node/node-backup.sh --forget-host $from (the old node's snapshots but the move one go)"
  fi
}

main "$@"; exit $?
