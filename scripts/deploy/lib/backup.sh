# shellcheck shell=bash
# Backups: restic in a pinned container against any S3-compatible repository, retention,
# monitoring pings and state/backup-last.json. Needs common.sh and env.sh; the functions that run
# Docker also need app.sh. Pure functions first (bats covers them).

# 0.17.1+ reports "repository does not exist" as exit 10 and a wrong password as exit 12, which
# ensure_backup_repo relies on; a pinned image gives every server and the e2e test the same restic.
# shellcheck disable=SC2034 # read by the deploy scripts and e2e.sh
RESTIC_IMAGE=restic/restic:0.18.0
# The restic host of this server's snapshots: generated once per server (load_restic_host), so
# retention (`forget --host`) only ever thins out this server's own snapshots. Two servers that
# share the repository, the old and the new one around a move, can never evict each other's.
RESTIC_HOST=''
RESTIC_KEYS=(RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)
# The health check fails when the last backup is older: nightly at 03:30 plus slack.
BACKUP_MAX_AGE=$((26 * 3600))
# How long ensure_backup_repo's `restic cat config` may take. restic 0.18 retries a backend error
# it does not know to be permanent with an exponential backoff for up to 15 minutes, and no option
# changes that (cmd/restic/global.go: retry.New(be, 15*time.Minute, ...)). A bucket that does not
# exist yet is such an error: the S3 backend counts only NoSuchKey, InvalidRange and AccessDenied
# as permanent (internal/backend/s3/s3.go IsPermanentError), not NoSuchBucket, so every first
# install would wait out the 15 minutes. A healthy probe is a few round trips; 30 s still rides out
# a short hiccup (retries after about 1, 2, 4, 8 and 16 s) before a first install moves on to
# `restic init`, which creates the bucket.
RESTIC_PROBE_TIMEOUT=30
# How long ensure_backup_repo's `restic init` may take: the same 15-minute retries apply to it.
# Creating a repository is a handful of small writes.
RESTIC_INIT_TIMEOUT=60

# restic_repository_ok <url>: s3:https://<endpoint>/<bucket>[/<path>]; plain http only on the
# loopback (the S3 stand-in of the e2e test).
restic_repository_ok() {
  [[ $1 =~ ^s3:https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]] ||
    [[ $1 =~ ^s3:http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]]
}

# backup_configured <env file>: status 0 when the four restic keys are set.
backup_configured() {
  [ -z "$(env_missing "$1" "${RESTIC_KEYS[@]}")" ]
}

# backup_checks <weekday 1-7> <tag> <verify 0|1>: what follows a backup. verify: restore into a
# scratch database and decrypt; check: restic reads back 5% of the data; none. The nightly
# backup verifies on Sundays and checks on the other days; other tags only with --verify.
backup_checks() {
  if [ "$3" = 1 ]; then
    echo verify
  elif [ "$2" != nightly ]; then
    echo none
  elif [ "$1" = 7 ]; then
    echo verify
  else
    echo check
  fi
}

# prune_today <weekday 1-7> <tag>: status 0 when forget also prunes (the nightly run on Sunday).
prune_today() {
  [ "$2" = nightly ] && [ "$1" = 7 ]
}

# json_number <key>: the integer value of <key> in the one-line JSON on stdin (jq -c or psql
# json_build_object output); status 1 when the key is absent.
json_number() {
  local value
  value=$(sed -n "s/.*\"$1\" *: *\(-\{0,1\}[0-9][0-9]*\).*/\1/p" | head -n 1)
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

# backup_age_problem <now> <last success epoch or ''> <backups configured since epoch or ''>
# [max seconds]: prints the problem, nothing when the last backup is recent enough. A server
# whose backups were just configured is not a problem before its first night.
backup_age_problem() {
  local now=$1 finished=$2 since=$3 max=${4:-$BACKUP_MAX_AGE}
  if [[ $finished =~ ^[0-9]+$ ]]; then
    if [ $((now - finished)) -gt "$max" ]; then
      echo "backup: the last successful backup is $(((now - finished) / 3600)) hours old"
    fi
  elif [[ $since =~ ^[0-9]+$ ]]; then
    if [ $((now - since)) -gt "$max" ]; then
      echo "backup: no successful backup in the $(((now - since) / 3600)) hours since backups were configured"
    fi
  else
    echo "backup: no successful backup recorded"
  fi
  return 0
}

backup_tag_ok() {
  [[ $1 =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]
}

# restic_host_ok <name>: a restic host name: letters, digits, '.', '_' and '-', no leading '-'.
restic_host_ok() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]
}

# load_restic_host [prefix, default mailexpert]: RESTIC_HOST from state/restic-host, which is
# written once, the first time it is needed (install.sh, or the first backup.sh of a server
# installed before the file existed), and never replaced: state/ describes this server and is not
# part of a snapshot, so a server restored from another one's snapshot keeps its own host. The
# first writer wins (ln fails on an existing file), so two scripts starting at once agree on one
# name. The mail node's backup (mail-node/node-backup.sh) uses the prefix mailexpert-node.
load_restic_host() {
  local file=$STATE_DIR/restic-host prefix=${1:-mailexpert} tmp host
  if [ ! -e "$file" ]; then
    tmp=$(mktemp "$file.XXXXXX")
    chmod 600 "$tmp"
    printf '%s-%s\n' "$prefix" "$(gen_hex 8)" >"$tmp"
    if ln "$tmp" "$file" 2>/dev/null; then log "backups: the restic host of this server is $(<"$file")"; fi
    rm -f "$tmp"
  fi
  host=$(<"$file")
  restic_host_ok "$host" || die "$file does not hold a restic host name; restore it (restic snapshots lists the hosts) instead of deleting it"
  RESTIC_HOST=$host
}

# backup_repo_action <exit code of `restic cat config`>: what ensure_backup_repo does next.
# open: the repository already opens (0). wrong-password: RESTIC_PASSWORD does not open it (12,
# "wrong password", documented since restic 0.17.1) — never answered with init. init: any other
# code, whatever the reason (an empty bucket: 10; a bucket that does not exist yet: the probe
# cut off by RESTIC_PROBE_TIMEOUT, 1 with "context canceled"; a transient failure) — `restic init`
# refuses to touch a repository that already exists, so retrying with init is always safe, and the
# backend-specific exit code for "not there yet" does not have to be enumerated here.
backup_repo_action() {
  case $1 in
    0) echo open ;;
    12) echo wrong-password ;;
    *) echo init ;;
  esac
}

# backup_setup_failure <repository set up here before 0|1> <panel running before this run 0|1>:
# what a repository that neither opens nor can be created means for install.sh. fatal on the first
# setup of a server that was not running (a new install: the owner is there to fix the keys);
# otherwise a warning: the panel already runs (an update, a rollback, a rerun), and a storage
# hiccup must not turn a ready panel into a rollback or a stopped one. The nightly backup and the
# health check report a repository that stays broken.
backup_setup_failure() {
  if [ "$1" = 1 ] || [ "$2" = 1 ]; then echo warning; else echo fatal; fi
}

# restic_error_summary: one line of restic's stderr (on stdin) for an error message: the first
# "returned error, retrying" line when restic retried, since it names the backend's own reason
# where the last line of a run cut off by a timeout only says "context canceled"; else the last
# non-empty line.
restic_error_summary() {
  local line last='' first_retry=''
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    last=$line
    if [ -z "$first_retry" ] && [[ $line == *" returned error, retrying after "* ]]; then
      first_retry=$line
    fi
  done
  printf '%s\n' "${first_retry:-$last}"
}

# --- The functions below run Docker and need app.sh (load_install or set_install_paths). ---

# load_restic_env: exports the restic keys from .env. The values stay in the environment of this
# process and its children; restic_run hands containers the names, never the values.
load_restic_env() {
  local key value
  for key in "${RESTIC_KEYS[@]}" AWS_DEFAULT_REGION; do
    value=$(env_get "$ENV_FILE" "$key") || value=
    if [ -n "$value" ]; then
      export "$key=$value"
    else
      unset "$key"
    fi
  done
}

# restic_run [-t <seconds>] [-v <host path>:<container path>[:ro]]... -- <restic arguments>:
# restic in its pinned container on the host network (the repository may be on the loopback),
# with its cache in state/restic-cache. -t: the image's BusyBox timeout sends restic SIGTERM after
# <seconds>; restic cancels its requests and exits non-zero, and --rm removes the container.
restic_run() {
  local -a mounts=() run=("$RESTIC_IMAGE")
  while :; do
    case ${1:-} in
      -v) mounts+=(-v "$2") ;;
      -t) run=(--entrypoint /usr/bin/timeout "$RESTIC_IMAGE" "$2" restic) ;;
      *) break ;;
    esac
    shift 2
  done
  [ "${1:-}" = -- ] || die "restic_run: -- expected before the restic arguments"
  shift
  mkdir -p "$STATE_DIR/restic-cache"
  docker run --rm --network host \
    -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e RESTIC_CACHE_DIR=/cache -v "$STATE_DIR/restic-cache:/cache" "${mounts[@]}" "${run[@]}" "$@"
}

# pick_snapshot <latest|id> <host or ''> [tag]: prints "<id> <host> <time>" of the snapshot to
# restore: the newest one (by time, whatever the time zone of the server that made it) or the one
# named, among the snapshots of that host and with that tag when they are given. Shared by
# restore.sh and the mail node's node-restore.sh.
pick_snapshot() {
  local -a filter=()
  if [ -n "$2" ]; then filter=(--host "$2"); fi
  if [ -n "${3:-}" ]; then filter+=(--tag "$3"); fi
  if [ "$1" != latest ]; then filter+=("$1"); fi
  restic_run -- snapshots --json "${filter[@]}" | jq -r '
    def epoch: capture("^(?<d>[0-9-]+T[0-9:]+)(?<f>[.][0-9]+)?(?<z>Z|[+-][0-9]{2}:[0-9]{2})$")
      | (.d + "Z" | fromdateiso8601)
        - (if .z == "Z" then 0 else (.z[0:1] + "1" | tonumber) * ((.z[1:3] | tonumber) * 3600 + (.z[4:6] | tonumber) * 60) end);
    if length == 0 then empty else max_by([(.time | epoch), .time]) | "\(.id) \(.hostname) \(.time)" end'
}

# ensure_backup_repo: opens the repository, creating it (format v2, compressed) only when restic
# reports that it does not exist. A password that does not open an existing repository is never
# answered with a new repository. The probe and init are bounded by RESTIC_PROBE_TIMEOUT and
# RESTIC_INIT_TIMEOUT, so a bucket that does not exist yet, or storage that does not answer, costs
# seconds instead of restic's 15 minutes of retries. Status 1 with the problem on stdout when the
# repository neither opens nor can be created: the caller decides whether that stops it.
ensure_backup_repo() {
  local code=0 probe_err init_err init_code=0
  probe_err=$(restic_run -t "$RESTIC_PROBE_TIMEOUT" -- cat config 2>&1 >/dev/null) || code=$?
  case $(backup_repo_action "$code") in
    open) log "backups: the restic repository opens" ;;
    wrong-password)
      echo "RESTIC_PASSWORD does not open the repository in RESTIC_REPOSITORY; configure.sh never replaces it: correct it in $ENV_FILE by hand"
      return 1
      ;;
    init)
      log "backups: creating the restic repository"
      init_err=$(restic_run -t "$RESTIC_INIT_TIMEOUT" -- init --repository-version 2 2>&1 >/dev/null) || init_code=$?
      if [ "$init_code" != 0 ]; then
        echo "the restic repository could not be opened or created; probe (restic exit $code): $(restic_error_summary <<<"$probe_err"); init (restic exit $init_code): $(restic_error_summary <<<"$init_err")"
        return 1
      fi
      ;;
  esac
}

# print_recovery_key: the one place a secret is printed, on stderr, at the owner's request or
# once at install time in a terminal.
print_recovery_key() {
  local repository password
  repository=$(env_get "$ENV_FILE" RESTIC_REPOSITORY)
  password=$(env_get "$ENV_FILE" RESTIC_PASSWORD)
  {
    printf '\n[mailexpert] RECOVERY KEY. Store it outside this server, for example in a password manager.\n'
    printf '[mailexpert] With it and the S3 access key (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) the backups\n'
    printf '[mailexpert] restore on any server; without it nobody can read them.\n\n'
    printf '  RESTIC_REPOSITORY=%s\n  RESTIC_PASSWORD=%s\n\n' "$repository" "$password"
  } >&2
}

# show_recovery_key_once <command that shows it later>: prints the recovery key the first time,
# and only to a terminal: cloud-init and CI logs must not keep it. install.sh names backup.sh, the
# mail node's setup.sh node-backup.sh.
show_recovery_key_once() {
  local marker=$STATE_DIR/recovery-key.shown
  [ ! -f "$marker" ] || return 0
  if [ -t 2 ]; then
    print_recovery_key
    : >"$marker"
  else
    log "the recovery key has not been shown yet (no terminal); show it with: $1"
  fi
}

# backup_ping_url: BACKUP_PING_URL when the owner keeps a separate daily check for backups,
# otherwise HEALTHCHECK_PING_URL; empty when neither is set.
backup_ping_url() {
  local url
  url=$(env_get "$ENV_FILE" BACKUP_PING_URL) || url=
  if [ -z "$url" ]; then url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=; fi
  printf '%s\n' "$url"
}

# dump_database <dir>: <dir>/db.dump (pg_dump custom format, uncompressed: restic compresses and
# deduplicates across days) and <dir>/counts.json, from one database snapshot, by a one-off
# container of the postgres service. LIB_DIR is the caller's scripts/deploy/lib.
dump_database() {
  app_compose run --rm --no-deps -T -v "$1:/out" -v "$LIB_DIR/pg-dump.sh:/pg-dump.sh:ro" \
    -v "$LIB_DIR/counts.sql:/counts.sql:ro" --entrypoint sh postgres /pg-dump.sh >/dev/null
}

# write_backup_last <snapshot> <tag> <dump bytes> <dump seconds> <counts json> <restore seconds or ''>:
# state/backup-last.json for healthcheck.sh (age), update.sh (free space) and the owner (the
# expected downtime of a move).
write_backup_last() {
  local file=$STATE_DIR/backup-last.json tmp now
  now=$(date +%s)
  tmp=$(mktemp "$file.XXXXXX")
  jq -cn --arg snapshot "$1" --arg tag "$2" --argjson dump_bytes "$3" --argjson dump_seconds "$4" \
    --argjson counts "$5" --arg restore "$6" --argjson now "$now" \
    '{finished_epoch: $now, finished_at: ($now | todate), snapshot: $snapshot, tag: $tag,
      dump_bytes: $dump_bytes, dump_seconds: $dump_seconds, counts: $counts,
      verified: ($restore != ""),
      restore_seconds: (if $restore == "" then null else ($restore | tonumber) end)}' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}
