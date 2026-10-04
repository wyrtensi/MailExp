#!/usr/bin/env bash
# Restores a mail node backup (node-backup.sh) onto a fresh server: a move of the node, or a node
# rebuilt after a loss (docs/operations/mail-node.md, sections 7 and 8).
#
# Before it: Docker on the new server, this repository checked out, and mailcow cloned into
# --mailcow-dir at the version the backup was made on (the script names it and refuses another
# one); generate_config.sh is not needed and nothing of mailcow may have started yet. The restic
# keys come from node.env when this server has one, otherwise as KEY=VALUE lines on stdin
# (RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and, when the
# storage needs it, AWS_DEFAULT_REGION): never as arguments.
#
# What it does:
#   1. restores the snapshot's /backup (mailcow's dump and the node's files) into a temporary
#      directory under /var/backups/mailexpert-node;
#   2. puts mailcow.conf (with the .env link mailcow expects), data/conf, data/assets/ssl and
#      docker-compose.override.yml in place, and node.env when this server has none;
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
# A move with a lot of mail restores twice, so that the mail is mostly in place before the old
# node stops: --rehearsal first, from a nightly snapshot while the old node still works (Postfix's
# data set, the mail queue, is left out: the queued mail would go out a second time), then
# --update from the move snapshot, which only downloads what changed since. --update runs only on a
# server node-restore.sh restored before; without it such a server is refused like any other with
# mailcow data.
#
#   node-restore.sh latest|<snapshot id> [--host <restic host>] [--mailcow-dir DIR]
#                   [--rehearsal | --update] [--resync]
#
# latest is the newest snapshot of any node in the repository; --host limits the choice to one
# node's snapshots (restic snapshots lists them). The node and time restored are printed.
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
WORK=''
REHEARSAL=0

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

# place_files <dir with the restored backup>: mailcow.conf and the node's files where mailcow and
# setup.sh read them.
place_files() {
  local src=$1/mailexpert
  install -m 600 "$1/mailcow.conf" "$MAILCOW_DIR/mailcow.conf"
  ln -sfn mailcow.conf "$MAILCOW_DIR/.env"
  mkdir -p "$MAILCOW_DIR/data/conf" "$MAILCOW_DIR/data/assets"
  if [ -d "$src/conf" ]; then cp -a "$src/conf/." "$MAILCOW_DIR/data/conf/"; fi
  if [ -d "$src/ssl" ]; then
    mkdir -p "$MAILCOW_DIR/data/assets/ssl"
    cp -a "$src/ssl/." "$MAILCOW_DIR/data/assets/ssl/"
  fi
  if [ -f "$src/docker-compose.override.yml" ]; then cp -p "$src/docker-compose.override.yml" "$MAILCOW_DIR/"; fi
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

# restore_mailcow <dir with the restored backup>: mailcow's own restore of everything else, its
# questions answered: restore point 1 (the only one in the location), data set 0 (all), and yes to
# the SQL restore, which stops and starts mailcow. (Its `docker run -i` steps may read what is left
# of the answers; the SQL question then reads nothing, and an empty answer is its default, yes.)
restore_mailcow() {
  local location=$WORK/location log=$WORK/mailcow-restore.log code=0 problems
  mkdir -m 755 "$location"
  # A rehearsal leaves the mail queue out: the old node still delivers it.
  if [ "$REHEARSAL" = 1 ]; then rm -f "$1/backup_postfix.tar.zst"; fi
  mv "$1" "$location/mailcow-restore"
  printf '1\n0\ny\n' | MAILCOW_BACKUP_LOCATION=$location timeout "$RESTORE_TIMEOUT" \
    "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh" restore >"$log" 2>&1 || code=$?
  problems=$(restore_log_problems "$log")
  if [ "$code" != 0 ] || [ -n "$problems" ]; then
    cp "$log" "$NODE_BACKUP_DIR/mailcow-restore.log"
    chmod 600 "$NODE_BACKUP_DIR/mailcow-restore.log"
    die "mailcow's restore failed (exit $code${problems:+: $(paste -sd';' - <<<"$problems")}); its output: $NODE_BACKUP_DIR/mailcow-restore.log"
  fi
  if [ "$REHEARSAL" = 1 ]; then
    log "mailcow's restore done: crypt, mysql, redis, rspamd (postfix left out: rehearsal)"
  else
    log "mailcow's restore done: crypt, mysql, postfix, redis, rspamd"
  fi
}

restored_marker() { printf '%s/restored\n' "$NODE_STATE"; }

main() {
  local snapshot='' host='' resync=0 update=0 picked id from at project commit here problem
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

  node_backup_env
  if [ -f "$NODE_CONF" ] && backup_configured "$NODE_CONF"; then
    load_restic_env
  else
    read_keys
  fi
  mkdir -p "$NODE_STATE"
  ensure_image "$RESTIC_IMAGE"
  picked=$(pick_snapshot "$snapshot" "$host" "$NODE_BACKUP_TAG") ||
    die "restic could not list $snapshot: no such snapshot, or the repository is unreachable"
  [ -n "$picked" ] || die "no node snapshot ($snapshot${host:+ of $host}) in the repository" 2
  read -r id from at <<<"$picked"
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
  if [ "$update" = 1 ]; then
    [ -f "$(restored_marker)" ] ||
      die "--update: node-restore.sh has not restored this server before; a server it did not restore is never overwritten" 2
    log "updating the restore of $(cut -d' ' -f1 "$(restored_marker)" | cut -c1-8) to snapshot ${id:0:8}"
  else
    if [ -f "$(restored_marker)" ]; then
      problem="node-restore.sh restored this server before; bring it to a newer snapshot with --update"
    else
      problem=$(fresh_server_problem "$project")
    fi
    [ -z "$problem" ] || die "$problem" 2
  fi

  place_files "$WORK/backup"
  log "mailcow: pulling images and starting (creates the volumes)"
  mailcow_compose pull -q >/dev/null || die "docker compose pull failed in $MAILCOW_DIR"
  mailcow_compose up -d >/dev/null || die "docker compose up -d failed in $MAILCOW_DIR"
  restore_vmail "$id" "$(mailcow_volume "$project" vmail)"
  restore_mailcow "$WORK/backup"
  mailcow_compose up -d >/dev/null || die "docker compose up -d failed in $MAILCOW_DIR after the restore"
  if [ "$resync" = 1 ]; then
    mailcow_compose exec -T dovecot-mailcow doveadm force-resync -A '*' || warn "doveadm force-resync reported a problem; run it again once Dovecot is up"
  fi
  printf '%s %s %s\n' "$id" "$REHEARSAL" "$(date +%s)" >"$(restored_marker)"
  log "restored snapshot ${id:0:8} of node $from ($at)"
  if [ "$REHEARSAL" = 1 ]; then
    log "rehearsal: do not run setup.sh yet; for the move, node-restore.sh <move snapshot> --update"
    return 0
  fi
  log "next: $SCRIPT_DIR/setup.sh (firewall, EOP ranges, timers), then the A record of the mail host and the PTR (section 8)"
}

main "$@"; exit $?
