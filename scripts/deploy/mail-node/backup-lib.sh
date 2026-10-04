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
  NODE_BACKUP_PING_URL NODE_BACKUP_READ_SUBSET NODE_BACKUP_DUMP_TIMEOUT NODE_BACKUP_PUSH_TIMEOUT)
# Defaults of the bounds: mailcow's dump (the database and the small volumes), the upload (the
# first one carries all the mail), and the share of the repository the weekly check reads back.
NODE_BACKUP_DUMP_TIMEOUT_DEFAULT=3600
NODE_BACKUP_PUSH_TIMEOUT_DEFAULT=43200
NODE_BACKUP_READ_SUBSET_DEFAULT=5%

node_backup_last_file() { printf '%s/backup-last.json\n' "$NODE_STATE"; }
node_backup_since_file() { printf '%s/backup-since\n' "$NODE_STATE"; }

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
    NODE_BACKUP_DUMP_TIMEOUT | NODE_BACKUP_PUSH_TIMEOUT)
      [[ $2 =~ ^[1-9][0-9]{1,5}$ ]] || echo "must be a number of seconds (10 to 999999)"
      ;;
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

# space_problem <need kB> <free kB> <dir>: the problem when <dir> has too little room; else nothing.
space_problem() {
  if [ "$2" -lt "$1" ]; then
    echo "not enough free space for mailcow's dump in $3: about $(($1 / 1024)) MB needed, $(($2 / 1024)) MB free"
  fi
  return 0
}

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
# (node-restore.sh would answer the wrong question).
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

# restore_log_problems <log of mailcow's restore>: the lines that say a data set was not restored
# (mailcow's script goes on and exits 0 after them), without colour codes; nothing when there are
# none. rspamd skipped for another CPU architecture is not one: its learned data starts afresh.
restore_log_problems() {
  local esc
  esc=$(printf '\033')
  sed "s/$esc\[[0-9;]*m//g" "$1" | grep -E '^(Error|Could not|Cannot find)' || true
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
# <processed bytes> <added bytes> <mailcow ref> <restore seconds or ''>: state/backup-last.json, for
# node-backup.sh --status, the hourly node check (eop-ranges.sh) and the owner (the size and time
# a move takes).
write_node_backup_last() {
  local file tmp now
  file=$(node_backup_last_file)
  now=$(date +%s)
  tmp=$(mktemp "$file.XXXXXX")
  jq -cn --arg snapshot "$1" --arg tag "$2" --argjson seconds "$3" --argjson dump_seconds "$4" \
    --argjson dump_bytes "$5" --argjson push_seconds "$6" --argjson processed "$7" --argjson added "$8" \
    --arg mailcow "$9" --arg restore "${10}" --argjson now "$now" \
    '{finished_epoch: $now, finished_at: ($now | todate), snapshot: $snapshot, tag: $tag,
      seconds: $seconds, dump_seconds: $dump_seconds, dump_bytes: $dump_bytes,
      push_seconds: $push_seconds, processed_bytes: $processed, added_bytes: $added, mailcow: $mailcow,
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

# node_setting <key> <default>: a node.env value, or the default.
node_setting() {
  local value
  value=$(env_get "$NODE_CONF" "$1" 2>/dev/null) || value=''
  printf '%s\n' "${value:-$2}"
}
