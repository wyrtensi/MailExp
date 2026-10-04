# shellcheck shell=bash
# shellcheck disable=SC2034 # the settings below are read by the scripts that source this file
# The mail node's backup (docs/operations/mail-node.md, section 7): what node-backup.sh,
# node-restore.sh, setup.sh and eop-ranges.sh share. Needs common.sh, env.sh, the panel's
# lib/backup.sh (restic in its pinned container, retention helpers, pings) and lib.sh (NODE_CONF,
# NODE_STATE) loaded first. Pure functions first (bats covers them).
#
# What a snapshot holds (one restic snapshot per run, host mailexpert-node-<hex>, tags mailcow and
# nightly / manual / move):
#   /backup   what mailcow's helper-scripts/backup_and_restore.sh makes of crypt (the mail_crypt
#             keys, without which vmail cannot be read), redis (DKIM keys among the rest), rspamd,
#             postfix and mysql, its copy of mailcow.conf and the architecture marker; next to it
#             mailexpert/: data/conf, data/assets/ssl, docker-compose.override.yml, node.env and
#             meta.json (the mailcow commit the backup was made on);
#   /vmail    the vmail volume itself, read-only, file by file: mailcow's script would write it as
#             one more local tar of the whole mail first (a second full copy on the node's disk),
#             and a compressed tar of all mail deduplicates poorly from night to night, where
#             maildir files, which never change once written, deduplicate almost completely.

NODE_BACKUP_DIR=${MAILEXPERT_NODE_BACKUP_DIR:-/var/backups/mailexpert-node}
# The image mailcow's script runs tar in (DEBIAN_DOCKER_IMAGE there); the weekly verification
# lists the archives with it, since restic's image has no zstd.
MAILCOW_BACKUP_IMAGE=ghcr.io/mailcow/backup:latest
# mailcow's components the script backs up, and the archive each one leaves.
MAILCOW_COMPONENTS=(crypt redis rspamd postfix mysql)
MAILCOW_ARCHIVES=(backup_crypt.tar.zst backup_redis.tar.zst backup_rspamd.tar.zst backup_postfix.tar.zst
  backup_mariadb.tar.zst)
NODE_BACKUP_TAG=mailcow
NODE_RESTIC_HOST_PREFIX=mailexpert-node
# What setup.sh --backup-keys stores in node.env (secrets on stdin, never as arguments).
NODE_BACKUP_KEYS=(RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  NODE_BACKUP_PING_URL NODE_BACKUP_READ_SUBSET NODE_BACKUP_DUMP_TIMEOUT NODE_BACKUP_PUSH_TIMEOUT
  NODE_BACKUP_VERIFY_TIMEOUT NODE_BACKUP_RESERVE_PERCENT NODE_BACKUP_RESERVE_GB NODE_BACKUP_PARTIAL_LIMIT)
# Defaults of the bounds: mailcow's dump (the database and the small volumes), the upload (the
# first one carries all the mail), the weekly verification (each restic call of it), and the share
# of the repository it reads back.
NODE_BACKUP_DUMP_TIMEOUT_DEFAULT=3600
NODE_BACKUP_PUSH_TIMEOUT_DEFAULT=43200
NODE_BACKUP_VERIFY_TIMEOUT_DEFAULT=7200
NODE_BACKUP_READ_SUBSET_DEFAULT=5%
# retention (forget, and prune on Sundays) and the small restic calls (unlock, listings).
NODE_BACKUP_FORGET_TIMEOUT=3600
NODE_BACKUP_SHORT_TIMEOUT=600
# What must stay free on the disk besides the dump: the larger of a share of the file system and a
# fixed amount, so a dump never fills the disk mailcow writes mail to.
NODE_BACKUP_RESERVE_PERCENT_DEFAULT=10
NODE_BACKUP_RESERVE_GB_DEFAULT=2
# Runs in a row whose snapshot lacks files restic could not read (mail moved while it read) before
# the run fails its ping.
NODE_BACKUP_PARTIAL_LIMIT_DEFAULT=3
# The label of the node's restic containers, and the name mailcow's script gives its own.
NODE_BACKUP_LABEL=mailexpert.node-backup=1
MAILCOW_BACKUP_CONTAINER=mailcow-backup
# The node's restic hosts: snapshots of other hosts (the panel's) are not the node's to back up into
# or restore from.
NODE_HOST_RE='^mailexpert-node-'

node_backup_last_file() { printf '%s/backup-last.json\n' "$NODE_STATE"; }
node_backup_since_file() { printf '%s/backup-since\n' "$NODE_STATE"; }
node_backup_partial_file() { printf '%s/backup-partial-count\n' "$NODE_STATE"; }
# What node-restore.sh did on this server: KEY=VALUE lines STATE (in-progress, rehearsal, live),
# SNAPSHOT, HOST (the node it came from), EPOCH (the snapshot's time), AT.
restore_marker_file() { printf '%s/restored\n' "$NODE_STATE"; }

# node_backup_total_timeout <dump> <push> <verify>: the bound of a whole run, which the systemd unit
# (TimeoutStartSec) and the cron line (timeout) get: every phase's own bound and an hour of slack.
node_backup_total_timeout() {
  echo $(($1 + $2 + $3 + NODE_BACKUP_FORGET_TIMEOUT + 3 * NODE_BACKUP_SHORT_TIMEOUT + 3600))
}

# compose_project <mailcow.conf>: COMPOSE_PROJECT_NAME as mailcow's script cleans it (the prefix of
# its volume names); status 1 when there is none.
compose_project() {
  local name
  name=$(env_get "$1" COMPOSE_PROJECT_NAME 2>/dev/null) || return 1
  name=$(printf '%s' "$name" | tr -cd '0-9A-Za-z_-')
  [ -n "$name" ] || return 1
  printf '%s\n' "$name"
}

# mailcow_volume <project> <name>: the Docker volume of a mailcow data set (vmail, mysql, ...).
mailcow_volume() { printf '%s_%s-vol-1\n' "$1" "$2"; }

# node_backup_key_problem <key> <value>: why a value setup.sh --backup-keys is given is refused;
# nothing when it is fine.
node_backup_key_problem() {
  case $1 in
    RESTIC_REPOSITORY) restic_repository_ok "$2" || echo "must be s3:https://<endpoint>/<bucket>[/<path>]" ;;
    RESTIC_PASSWORD) [ "${#2}" -ge 16 ] || echo "must be at least 16 characters" ;;
    NODE_BACKUP_PING_URL) [[ $2 == https://* && $2 != *[[:space:]\"\'\$\#\\]* ]] || echo "must be an https URL" ;;
    NODE_BACKUP_READ_SUBSET) read_subset_ok "$2" || echo "must be a percentage (5%) or n/t (1/12)" ;;
    NODE_BACKUP_DUMP_TIMEOUT | NODE_BACKUP_PUSH_TIMEOUT | NODE_BACKUP_VERIFY_TIMEOUT)
      [[ $2 =~ ^[1-9][0-9]{1,5}$ ]] || echo "must be a number of seconds (10 to 999999)"
      ;;
    NODE_BACKUP_RESERVE_PERCENT) [[ $2 =~ ^[0-9]{1,2}$ ]] || echo "must be a percentage of the disk, 0 to 99" ;;
    NODE_BACKUP_RESERVE_GB) [[ $2 =~ ^[0-9]{1,4}$ ]] || echo "must be a number of GB, 0 to 9999" ;;
    NODE_BACKUP_PARTIAL_LIMIT) [[ $2 =~ ^[1-9][0-9]?$ ]] || echo "must be a number of runs, 1 to 99" ;;
    AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_DEFAULT_REGION) [ -n "$2" ] || echo "must not be empty" ;;
    *) echo "is not a node backup key (${NODE_BACKUP_KEYS[*]})" ;;
  esac
}

# parse_backup_keys <current node.env> <output file>: KEY=VALUE lines on stdin, as setup.sh
# --backup-keys reads them, checked; the accepted ones are written to <output file>. Every problem
# goes to stderr without the value, and the status is 2 when there is one (nothing is to be
# stored then). RESTIC_PASSWORD is accepted only when node.env has none or the same: a different
# one would not change the repository, only lock this node out of it.
parse_backup_keys() {
  local current_file=$1 out=$2 line key value problem current n=0
  local -a errors=()
  : >"$out"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    if [ "$key" = "$line" ] || ! [[ $key =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      errors+=("line $n is not KEY=VALUE (content not shown)")
      continue
    fi
    value=${line#*=}
    if [ -z "$value" ]; then errors+=("$key: empty value") && continue; fi
    if ! env_value_ok "$value"; then
      errors+=("$key: the value must be one token without spaces, quotes, \$, # or backslash")
      continue
    fi
    problem=$(node_backup_key_problem "$key" "$value")
    if [ -n "$problem" ]; then errors+=("$key: $problem") && continue; fi
    if [ "$key" = RESTIC_PASSWORD ]; then
      current=$(env_get "$current_file" RESTIC_PASSWORD 2>/dev/null) || current=''
      if [ -n "$current" ] && [ "$current" != "$value" ]; then
        errors+=("RESTIC_PASSWORD: $current_file already has a different one; it is never replaced here (correct a wrong one by hand)")
        continue
      fi
    fi
    printf '%s=%s\n' "$key" "$value" >>"$out"
  done
  if [ "${#errors[@]}" -gt 0 ]; then
    printf '[mailexpert] error: %s\n' "${errors[@]}" >&2
    return 2
  fi
  [ -s "$out" ] || { printf '[mailexpert] error: --backup-keys: no KEY=VALUE lines on stdin\n' >&2; return 2; }
}

# read_subset_ok <value>: what restic check --read-data-subset takes: a percentage up to 100 or n/t.
read_subset_ok() {
  if [[ $1 =~ ^[0-9]{1,3}(\.[0-9]{1,2})?%$ ]]; then
    awk -v p="${1%\%}" 'BEGIN { exit !(p > 0 && p <= 100) }'
  elif [[ $1 =~ ^([1-9][0-9]{0,3})/([1-9][0-9]{0,3})$ ]]; then
    [ "${BASH_REMATCH[1]}" -le "${BASH_REMATCH[2]}" ]
  else
    return 1
  fi
}

# node_backup_checks <weekday 1-7> <tag> <verify 0|1>: verify (a restic check reading back part of
# the data, and a restore of /backup and one mailbox into a temporary directory) or none. The
# nightly backup verifies on Sundays, like the panel's; other tags only with --verify. Unlike the
# panel there is no daily read-back: on a node with a lot of mail, reading 5% of the repository every
# night is real traffic from the storage.
node_backup_checks() {
  if [ "$3" = 1 ] || { [ "$2" = nightly ] && [ "$1" = 7 ]; }; then echo verify; else echo none; fi
}

# dump_problems <dir>: what is wrong with the dump mailcow's script left in <dir>, one line each;
# nothing when it is complete. The script has no `set -e`: a step that failed (a volume not found,
# the database refusing mariabackup) leaves a missing or empty archive and exit status 0.
dump_problems() {
  local dir=$1 name
  for name in mailcow.conf "${MAILCOW_ARCHIVES[@]}"; do
    if [ ! -e "$dir/$name" ]; then
      echo "$name is missing"
    elif [ ! -s "$dir/$name" ]; then
      echo "$name is empty"
    fi
  done
  # restore compares it with the architecture of the server it restores on (rspamd's data).
  if ! compgen -G "$dir/.x86_64" >/dev/null && ! compgen -G "$dir/.aarch64" >/dev/null; then
    echo "the architecture marker (.x86_64 or .aarch64) is missing"
  fi
  return 0
}

# dump_need_kb <mysql kB> <other volumes kB>: the free space mailcow's dump needs, an upper bound:
# mariabackup copies the database inside its container and tar writes it again (twice its size),
# the other archives are at most the size of their volumes; 10% on top.
dump_need_kb() {
  echo $(((2 * $1 + $2) * 11 / 10))
}

# space_reserve_kb <file system size kB> <percent> <GB>: what must stay free: the larger of the share
# and the fixed amount.
space_reserve_kb() {
  local share=$(($1 * $2 / 100)) fixed=$(($3 * 1024 * 1024))
  if [ "$share" -gt "$fixed" ]; then echo "$share"; else echo "$fixed"; fi
}

# space_problem <need kB> <free kB> <reserve kB> <dir> [what]: the problem when <dir> cannot take
# <what> (mailcow's dump) and still keep the reserve free; else nothing.
space_problem() {
  local what=${5:-the dump of mailcow}
  if [ "$2" -lt $(($1 + $3)) ]; then
    echo "not enough free space for $what in $4: about $(($1 / 1024)) MB needed and $(($3 / 1024)) MB to stay free (NODE_BACKUP_RESERVE_PERCENT, NODE_BACKUP_RESERVE_GB), $(($2 / 1024)) MB free"
  fi
  return 0
}

# archive_problems <crypt listing> <mariadb listing>: what the listings (tar -t) of mailcow's crypt
# and database archives lack, one line each: the mail_crypt key pair (without it vmail is
# unreadable), and at least one file of the database (mariabackup that failed leaves an empty
# directory, and tar archives it without a word).
archive_problems() {
  local crypt=$1 mariadb=$2 key
  for key in ecprivkey.pem ecpubkey.pem; do
    grep -qE "(^|/)$key\$" <<<"$crypt" || echo "backup_crypt.tar.zst has no $key"
  done
  grep -qE '(^|/)backup_mariadb/.*[^/]$' <<<"$mariadb" || echo "backup_mariadb.tar.zst holds no database file"
  return 0
}

# snapshot_size_kb: the size of the files of `restic ls --json` on stdin, in kB.
snapshot_size_kb() {
  jq -s '[.[] | select(((.message_type // .struct_type) == "node") and .type == "file") | (.size // 0)] | add // 0 | (. / 1024 | ceil)' 2>/dev/null || echo 0
}

# panel_hosts: the panel's restic hosts among the snapshots of `restic snapshots --json` on stdin,
# one per line: a repository the panel backs up into is not the node's.
panel_hosts() {
  jq -r --arg re "$PANEL_HOST_RE" '.[] | .hostname | select(test($re))' 2>/dev/null | sort -u
}

# node_hosts <tag>: the node hosts with snapshots of the tag in `restic snapshots --json` on stdin.
node_hosts() {
  jq -r --arg re "$NODE_HOST_RE" --arg tag "$1" \
    '.[] | select(((.tags // []) | index($tag)) != null) | .hostname | select(test($re))' 2>/dev/null | sort -u
}

# restore_problem <update 0|1> <marker state or ''> <marker host> <marker epoch> <target host>
# <target epoch> <target tags>: why node-restore.sh must not restore this snapshot onto a server it
# restored before; nothing when it may. Without a marker the fresh server check decides.
#   in-progress: a restore that stopped half way; it may be run again, from the same or a newer
#                snapshot of the same node (or a move snapshot).
#   rehearsal:   only --update, from a newer snapshot of the same node or a move snapshot.
#   live:        never: this node serves mail (a restore over it would roll it back).
restore_problem() {
  local update=$1 state=$2 host=$3 epoch=$4 thost=$5 tepoch=$6 ttags=$7
  case $state in
    '') [ "$update" = 0 ] || echo "--update: node-restore.sh has not restored this server before; a server it did not restore is never overwritten" ;;
    live) echo "this server is a live node (restored and set up, or restored from a move snapshot): node-restore.sh never restores over it" ;;
    rehearsal | in-progress)
      if [ "$state" = rehearsal ] && [ "$update" = 0 ]; then
        echo "node-restore.sh restored this server for a rehearsal; bring it to a newer snapshot with --update"
      elif [ "$thost" != "$host" ] && [[ ,$ttags, != *,move,* ]]; then
        echo "the snapshot is of node $thost, the server holds node $host: only a snapshot of the same node or a move snapshot"
      elif [ "$state" = rehearsal ] && [ "$tepoch" -le "$epoch" ]; then
        echo "the snapshot is not newer than the one the rehearsal restored: --update only moves forward"
      elif [ "$tepoch" -lt "$epoch" ]; then
        echo "the snapshot is older than the one the interrupted restore started with"
      fi
      ;;
    *) echo "$(restore_marker_file) has an unknown state $state: look at it and remove it by hand" ;;
  esac
  return 0
}

# write_restore_marker <state> <snapshot> <host> <epoch>
write_restore_marker() {
  local file
  file=$(restore_marker_file)
  mkdir -p "$NODE_STATE"
  printf 'STATE=%s\nSNAPSHOT=%s\nHOST=%s\nEPOCH=%s\nAT=%s\n' "$1" "$2" "$3" "$4" "$(date +%s)" >"$file.tmp"
  chmod 600 "$file.tmp"
  mv -f "$file.tmp" "$file"
}

# mark_restore_live: a server node-restore.sh restored serves mail now (setup.sh ran on it).
mark_restore_live() {
  local file
  file=$(restore_marker_file)
  [ -f "$file" ] || return 0
  env_set "$file" STATE live
}

# partial_count <runs in a row so far> <partial 0|1>: the new count of partial runs in a row.
partial_count() { if [ "$2" = 1 ]; then echo $(($1 + 1)); else echo 0; fi; }

# mailbox_children <parent>: from `restic ls --json` on stdin, the names of the directories directly
# under <parent> (whether or not restic listed recursively), skipping mailcow's own (_garbage,
# dot directories), sorted.
mailbox_children() {
  jq -r --arg parent "$1" '
    select(((.message_type // .struct_type) == "node") and .type == "dir")
    | .path | select(startswith($parent + "/")) | ltrimstr($parent + "/")
    | select(test("^[^/_.][^/]*$"))' 2>/dev/null | sort -u
}

# pick_rotating <seed> <item...>: one of the items, a different one as the seed moves on (the week
# of the year), so every mailbox comes up in turn.
pick_rotating() {
  local seed=$1
  shift
  [ "$#" -gt 0 ] || return 1
  local -a items=("$@")
  printf '%s\n' "${items[$((10#$seed % ${#items[@]}))]}"
}

# mailcow_restore_prompts_ok <backup_and_restore.sh>: status 0 when mailcow's script asks what
# node-restore.sh answers: the restore point, the data set, and the confirmation that the SQL
# restore stops mailcow. Another version that asks something else is restored by hand instead
# (node-restore.sh would answer the wrong question). Checked against the questions of mailcow
# 2026-09 (test/mail-node/mailcow-2026-09-prompts: its read lines, verbatim).
mailcow_restore_prompts_ok() {
  local file=$1 count
  [ -f "$file" ] || return 1
  count=$(grep -cE 'read -e?p ' "$file" || true)
  [ "$count" = 6 ] &&
    grep -qF 'Select a restore point' "$file" &&
    grep -qF 'Select a dataset to restore' "$file" &&
    grep -qF 'do you want to proceed? [Y|n]' "$file" &&
    grep -qF '[ 0 ] - all' "$file"
}

# node_backup_age <now>: the backup age problem of the node (backup_age_problem of the panel's
# library, with the node's state files); nothing when the last backup is recent enough.
node_backup_age() {
  local finished='' since='' file
  file=$(node_backup_last_file)
  if [ -f "$file" ]; then finished=$(jq -r '.finished_epoch // empty' "$file" 2>/dev/null) || finished=''; fi
  file=$(node_backup_since_file)
  if [ -f "$file" ]; then since=$(<"$file"); fi
  backup_age_problem "$1" "$finished" "$since"
}

# write_node_backup_last <snapshot> <tag> <seconds> <dump seconds> <dump bytes> <push seconds>
# <processed bytes> <added bytes> <mailcow ref> <restore seconds or ''> <partial 0|1>:
# state/backup-last.json, for node-backup.sh --status and the owner (the size and time a move
# takes). partial: restic could not read some files (mail moved while it read the volume).
write_node_backup_last() {
  local file tmp now
  file=$(node_backup_last_file)
  now=$(date +%s)
  tmp=$(mktemp "$file.XXXXXX")
  jq -cn --arg snapshot "$1" --arg tag "$2" --argjson seconds "$3" --argjson dump_seconds "$4" \
    --argjson dump_bytes "$5" --argjson push_seconds "$6" --argjson processed "$7" --argjson added "$8" \
    --arg mailcow "$9" --arg restore "${10}" --argjson partial "$([ "${11:-0}" = 1 ] && echo true || echo false)" \
    --argjson now "$now" \
    '{finished_epoch: $now, finished_at: ($now | todate), snapshot: $snapshot, tag: $tag,
      seconds: $seconds, dump_seconds: $dump_seconds, dump_bytes: $dump_bytes,
      push_seconds: $push_seconds, processed_bytes: $processed, added_bytes: $added, mailcow: $mailcow,
      partial: $partial,
      verified: ($restore != ""),
      restore_seconds: (if $restore == "" then null else ($restore | tonumber) end)}' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# node_backup_env: the panel library's ENV_FILE and STATE_DIR pointed at the node's files, so
# restic_run, load_restic_env, load_restic_host, ensure_backup_repo and the recovery key work
# unchanged.
node_backup_env() {
  # shellcheck disable=SC2034 # read by lib/backup.sh
  ENV_FILE=$NODE_CONF STATE_DIR=$NODE_STATE
}

# --- The functions below run Docker. ---

# volume_path <volume>: where a Docker volume is on the host; status 1 when it does not exist.
volume_path() { docker volume inspect -f '{{.Mountpoint}}' "$1" 2>/dev/null; }

# mailcow_mailboxes <mailcow dir>: the number of mailboxes in mailcow's database (mysql-mailcow, with
# the credentials of mailcow.conf; they go to mysql as an option file on stdin, never on a command
# line); status 1 when the database does not answer.
mailcow_mailboxes() {
  local dir=$1 user pass db count
  user=$(env_get "$dir/mailcow.conf" DBUSER 2>/dev/null) || return 1
  pass=$(env_get "$dir/mailcow.conf" DBPASS 2>/dev/null) || return 1
  db=$(env_get "$dir/mailcow.conf" DBNAME 2>/dev/null) || return 1
  count=$(printf '[client]\nuser=%s\npassword=%s\n' "$user" "$pass" | (cd "$dir" && docker compose exec -T mysql-mailcow \
    mysql --defaults-extra-file=/dev/stdin -D "$db" -N -s -e 'SELECT COUNT(*) FROM mailbox') 2>/dev/null) || return 1
  [[ $count =~ ^[0-9]+$ ]] || return 1
  echo "$count"
}

# remove_leftovers: restic containers of an earlier run that was killed (its systemd unit timed out,
# say) and mailcow's backup container it left; the caller holds the backup lock, so none of them
# belongs to a run still going.
remove_leftovers() {
  local ids
  ids=$(docker ps -aq --filter "label=$NODE_BACKUP_LABEL" 2>/dev/null) || ids=''
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # one id per word
    docker rm -f $ids >/dev/null 2>&1 || true
    warn "removed restic containers an earlier run left behind (it was stopped from outside)"
  fi
  if docker container inspect "$MAILCOW_BACKUP_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$MAILCOW_BACKUP_CONTAINER" >/dev/null 2>&1 || true
    warn "removed the container $MAILCOW_BACKUP_CONTAINER an earlier mailcow dump left behind"
  fi
}

# node_setting <key> <default>: a node.env value, or the default.
node_setting() {
  local value
  value=$(env_get "$NODE_CONF" "$1" 2>/dev/null) || value=''
  printf '%s\n' "${value:-$2}"
}
