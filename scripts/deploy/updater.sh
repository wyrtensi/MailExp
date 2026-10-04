#!/usr/bin/env bash
# The host side of "update from the panel". mailexpert-updater.path starts it (through
# mailexpert-updater.service, as root) when the backend drops a request into the spool:
#
#   <prefix>/state/update-spool/request/<uuid>.json   written by the backend container (uid 1000)
#   <prefix>/state/update-spool/result/<uuid>.json    written here; the container reads it
#
# The request directory is the boundary between a container that may be compromised and root on
# the host, so a request is untrusted input (lib/updater.sh decides what passes):
#   - every entry is first renamed into <prefix>/state/updater/incoming (root only): from then on
#     the container can neither change which file is read nor swap it for a link; a rename moves a
#     symbolic link as a link, never what it points to;
#   - the staged entry is checked with stat, which does not follow links: a regular file of the
#     backend's uid, one link, 1..4096 bytes; it is read once, as data, and only {action, target}
#     of an exactly-shaped JSON object is used;
#   - the target is checked against git: forward only (a descendant of the running commit) and
#     only the promoted build or a commit on origin/main;
#   - status.sh --target must report no problem; then update.sh does the update with its own
#     lock, backup and checks. A request never reaches a shell, an argument list or a path except
#     as the validated sha-<12>.
#
# Per run: every *.json is taken out of the spool (an undrained spool would retrigger the path
# unit at once), at most one check and one update are carried out, the rest are refused.
#
# After a failed switch (update.sh exit 1) the panel goes back by itself only when it is known that
# no migration ran: status.sh read the schema, nothing was pending, and the count of applied
# migrations did not change. Then install.sh --version <old> loses nothing. Otherwise it stops and
# the result points at the runbook and rollback.sh: restoring the dump loses data, a person decides.
#
# This file is rewritten by the checkout of the new version while it runs: everything is defined
# before main starts, and main is called on one line.
#
#   updater.sh [--prefix /opt/mailexpert]
#
# Exit codes: 0 the spool was handled (whatever the requests' outcomes), 2 invalid input, 1 failure.
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
# shellcheck source=lib/channel.sh
. "$LIB_DIR/channel.sh"
# shellcheck source=lib/updater.sh
. "$LIB_DIR/updater.sh"
exit_on_unexpected_failure

# How often a running update's result is rewritten (updatedAt and the log tail), in seconds.
PROGRESS_INTERVAL=${MAILEXPERT_UPDATER_INTERVAL:-5}
# A *.tmp the backend is still writing is left alone this long; older ones are removed.
TMP_GRACE_MIN=5

SPOOL='' REQUEST_DIR='' RESULT_DIR='' WORK_DIR='' STAGE_DIR='' INSTALL_OK=0 INSTALL_ERROR=''

usage() {
  cat <<'EOF'
Usage: updater.sh [--prefix /opt/mailexpert]

Run by mailexpert-updater.service when the panel asks for a check or an update. It takes every
request out of <prefix>/state/update-spool/request, checks it, runs status.sh --target and, for
an update, update.sh, and writes the outcome into <prefix>/state/update-spool/result.
Logs of each run: <prefix>/state/updater/<request id>.log.
EOF
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

json_str() { jq -cn --arg v "$1" '$v'; }

# set_result <id> <name=<JSON value>...>: merges the fields into result/<id>.json, written to a
# temporary file in the same directory and renamed, so the backend never reads half a file.
set_result() {
  local id=$1 file tmp current='{}'
  shift
  file=$RESULT_DIR/$id.json
  if [ -f "$file" ] && [ ! -L "$file" ]; then current=$(<"$file"); fi
  tmp=$(mktemp "$RESULT_DIR/.result.XXXXXX")
  if ! result_merge "$(now)" "$@" <<<"$current" >"$tmp"; then
    rm -f "$tmp"
    warn "cannot write the result of $id"
    return 0
  fi
  chmod 644 "$tmp"
  mv -f "$tmp" "$file"
}

# json_or_null <value>: a JSON string, or null for an empty value.
json_or_null() {
  if [ -n "$1" ]; then json_str "$1"; else echo null; fi
}

# refuse <id> <action or empty> <target or empty> <message>
refuse() {
  log "request $1 refused: $4"
  set_result "$1" "id=$(json_str "$1")" "action=$(json_or_null "$2")" "target=$(json_or_null "$3")" \
    "state=\"refused\"" "message=$(json_str "$4")" "finishedAt=$(json_str "$(now)")"
}

# prepare_spool: the spool's directories as install.sh makes them; a request directory that is
# not a directory (a link) is left alone and nothing is read.
prepare_spool() {
  mkdir -p "$WORK_DIR" "$STAGE_DIR"
  chmod 700 "$WORK_DIR" "$STAGE_DIR"
  local dir
  for dir in "$RESULT_DIR" "$REQUEST_DIR"; do
    if [ ! -d "$dir" ] || [ -L "$dir" ]; then die "$dir is missing or not a directory; run install.sh"; fi
  done
}

# stage_requests: moves every *.json out of the request directory into the staging directory and
# removes anything that is not a request (a *.tmp younger than TMP_GRACE_MIN is being written).
stage_requests() {
  local path name junk
  while IFS= read -r -d '' path; do
    name=${path##*/}
    if [[ $name == *.tmp ]] && [ -n "$(find "$path" -maxdepth 0 -mmin "-$TMP_GRACE_MIN" 2>/dev/null)" ]; then
      continue
    fi
    if ! request_name_ok "$name"; then
      # Out of the container's reach first, then removed (rm never follows a link).
      log "removing ${name//[^A-Za-z0-9._-]/?} from the request directory: not a request"
      junk=$(mktemp -u "$STAGE_DIR/junk.XXXXXX")
      mv -f -- "$path" "$junk" && rm -rf -- "$junk"
      continue
    fi
    rm -rf -- "${STAGE_DIR:?}/$name"
    mv -f -- "$path" "$STAGE_DIR/$name"
  done < <(find "$REQUEST_DIR" -mindepth 1 -maxdepth 1 -print0)
}

# staged_in_order: the staged request names, oldest first.
staged_in_order() {
  local path
  for path in "$STAGE_DIR"/*.json; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    printf '%s %s\n' "$(stat -c %Y -- "$path" 2>/dev/null || echo 0)" "${path##*/}"
  done | sort -n | cut -d' ' -f2
}

# read_staged <name>: PARSED = "<action> <target>" of a staged request; on a refusal status 1,
# the reason in PARSED and the action it names (when it names one) in BAD_ACTION. Not in a
# subshell: it sets both.
PARSED='' BAD_ACTION=''
read_staged() {
  local path=$STAGE_DIR/$1 id=${1%.json} st problem content type uid size links
  PARSED='' BAD_ACTION=''
  st=$(stat -c '%F|%u|%s|%h' -- "$path") || { PARSED="cannot stat it"; return 1; }
  IFS='|' read -r type uid size links <<<"$st"
  problem=$(request_file_problem "$type" "$uid" "$size" "$links")
  if [ -n "$problem" ]; then PARSED=$problem; return 1; fi
  content=$(head -c "$MAX_REQUEST_BYTES" -- "$path")
  log "request $id from $(request_actor <<<"$content")"
  if ! PARSED=$(parse_request "$id" <<<"$content"); then
    BAD_ACTION=$(jq -r 'if type == "object" and (.action == "check" or .action == "update") then .action else "" end' 2>/dev/null <<<"$content") || BAD_ACTION=''
    PARSED="not a valid request"
    return 1
  fi
}

# check_target <target>: empty when the panel may move to <target>, otherwise the reason. Fetches
# origin and the tag latest first.
check_target() {
  local commit=${1#sha-} full head is_head=0 descendant=0 is_latest=0 on_main=0 latest=''
  if is_standby; then echo "standby server: the panel does not run here"; return 0; fi
  if lock_held "$STATE_DIR/update.lock"; then echo "an update, rollback or restore is running now"; return 0; fi
  if ! git -C "$APP_DIR" fetch --quiet origin 2>/dev/null; then echo "git fetch failed in $APP_DIR"; return 0; fi
  fetch_latest_tag 2>/dev/null || true
  full=$(git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}" 2>/dev/null) || {
    echo "commit $commit is not in $CFG_REPO_URL"
    return 0
  }
  head=$(git -C "$APP_DIR" rev-parse HEAD)
  if [ "$head" = "$full" ]; then is_head=1; fi
  if git -C "$APP_DIR" merge-base --is-ancestor "$head" "$full" 2>/dev/null; then descendant=1; fi
  latest=$(latest_commit 2>/dev/null) || latest=''
  if [ -n "$latest" ] && [ "$latest" = "$full" ]; then is_latest=1; fi
  if git -C "$APP_DIR" merge-base --is-ancestor "$full" refs/remotes/origin/main 2>/dev/null; then on_main=1; fi
  target_verdict "$is_head" "$descendant" "$is_latest" "$on_main"
}

# preflight <id> <target> <log>: status.sh --target into the result; leaves the verdict (ready,
# blocked, error) in VERDICT and the summary in PREFLIGHT. Not in a subshell: it sets both.
PREFLIGHT=null VERDICT=''
preflight() {
  local id=$1 target=$2 logfile=$3 out code=0
  out=$(bash "$SCRIPT_DIR/status.sh" --prefix "$OPT_PREFIX" --target "$target" --json 2>>"$logfile") || code=$?
  VERDICT=$(preflight_verdict "$code" <<<"$out")
  if [ "$VERDICT" = error ]; then PREFLIGHT=null; else PREFLIGHT=$(preflight_summary <<<"$out"); fi
  set_result "$id" "preflight=$PREFLIGHT"
}

do_check() {
  local id=$1 target=$2 logfile=$WORK_DIR/$1.log reason verdict message
  set_result "$id" "id=$(json_str "$id")" "action=\"check\"" "target=$(json_str "$target")" \
    "state=\"checking\"" "from=$(json_str "$CFG_VERSION")" "receivedAt=$(json_str "$(now)")" \
    "logFile=$(json_str "$logfile")" "journal=\"journalctl -u mailexpert-updater.service\""
  reason=$(check_target "$target")
  if [ -n "$reason" ]; then refuse "$id" check "$target" "$reason"; return 0; fi
  preflight "$id" "$target" "$logfile"
  verdict=$VERDICT
  case $verdict in
    ready) message="ready to update to $target" ;;
    blocked) message="status.sh found problems that block an update to $target" ;;
    *) message="status.sh failed; see $logfile" ;;
  esac
  log "check $id: $verdict"
  set_result "$id" "state=$(json_str "$verdict")" "message=$(json_str "$message")" "finishedAt=$(json_str "$(now)")"
}

# progress <id> <log>: the log tail into the result while update.sh or install.sh runs.
progress() {
  set_result "$1" "log=$(log_tail <"$2" | jq -Rcs 'split("\n") | map(select(. != ""))')"
}

# run_logged <id> <log> <command...>: runs the command detached from this shell's output, with
# its output appended to the log, rewriting the result every PROGRESS_INTERVAL seconds. Its exit
# code is the status.
run_logged() {
  local id=$1 logfile=$2 pid code=0
  shift 2
  "$@" >>"$logfile" 2>&1 </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    progress "$id" "$logfile"
    sleep "$PROGRESS_INTERVAL"
  done
  wait "$pid" || code=$?
  progress "$id" "$logfile"
  return "$code"
}

do_update() {
  local id=$1 target=$2 logfile=$WORK_DIR/$1.log from=$CFG_VERSION reason verdict code=0 before after
  local next auto=false edge
  set_result "$id" "id=$(json_str "$id")" "action=\"update\"" "target=$(json_str "$target")" \
    "state=\"checking\"" "from=$(json_str "$from")" "receivedAt=$(json_str "$(now)")" \
    "logFile=$(json_str "$logfile")" "journal=\"journalctl -u mailexpert-updater.service\""
  reason=$(check_target "$target")
  if [ -n "$reason" ]; then refuse "$id" update "$target" "$reason"; return 0; fi
  preflight "$id" "$target" "$logfile"
  verdict=$VERDICT
  if [ "$verdict" != ready ]; then
    log "update $id: preflight $verdict, nothing done"
    set_result "$id" "state=$(json_str "$verdict")" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "the update was not started: status.sh --target $( [ "$verdict" = blocked ] && echo 'found problems' || echo 'failed')")"
    return 0
  fi
  if auto_rollback_allowed "$PREFLIGHT"; then auto=true; fi
  before=$(jq -r '.migrationsApplied // empty' <<<"$PREFLIGHT")
  log "update $id: $from -> $target"
  set_result "$id" "state=\"updating\"" "startedAt=$(json_str "$(now)")" "autoRollback=$auto" \
    "message=$(json_str "updating $from -> $target")"
  run_logged "$id" "$logfile" bash "$SCRIPT_DIR/update.sh" "$target" --prefix "$OPT_PREFIX" || code=$?
  next=$(log_next <"$logfile" | jq -Rcs 'split("\n") | map(select(. != ""))')
  case $code in
    0)
      set_result "$id" "state=\"succeeded\"" "exitCode=0" "next=$next" "finishedAt=$(json_str "$(now)")" \
        "message=$(json_str "updated to $target")"
      write_updater_status "$target"
      return 0
      ;;
    2 | 3)
      set_result "$id" "state=\"failed\"" "exitCode=$code" "finishedAt=$(json_str "$(now)")" \
        "message=$(json_str "update.sh stopped before the switch (exit $code): nothing was changed, $from still runs")"
      return 0
      ;;
  esac
  after=$(migration_count 2>/dev/null | tr -d '[:space:]') || after=''
  if [ "$auto" != true ] || [ -z "$before" ] || [ "$after" != "$before" ]; then
    set_result "$id" "state=\"failed\"" "exitCode=$code" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready (exit $code); migrations ran or cannot be ruled out, so nothing was rolled back: follow the runbook or run rollback.sh --to $from over SSH")"
    return 0
  fi
  log "update $id: rolling back to $from (no migration ran)"
  set_result "$id" "state=\"rolling_back\"" "exitCode=$code" \
    "message=$(json_str "$target did not become ready; no migration ran, going back to $from")"
  edge=$(previous_edge_image "$from") || edge=''
  if [ -n "$edge" ]; then env_set "$EDGE_ENV" EDGE_IMAGE "$edge"; fi
  if run_logged "$id" "$logfile" bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$from"; then
    set_result "$id" "state=\"rolled_back\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready; the panel went back to $from, nothing was lost")"
  else
    set_result "$id" "state=\"rollback_failed\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready and going back to $from failed: follow the runbook over SSH")"
  fi
}

# prune_results: keeps the KEEP_RESULTS newest results (and logs of the same requests).
prune_results() {
  local f
  # shellcheck disable=SC2012 # our own names: <uuid>.json
  ls -1t "$RESULT_DIR"/????????-????-????-????-????????????.json 2>/dev/null | tail -n +"$((KEEP_RESULTS + 1))" |
    while IFS= read -r f; do
      rm -f -- "$f" "$WORK_DIR/$(basename "$f" .json).log"
    done || true
}

# write_updater_status <version>: result/updater.json, how the panel knows the mechanism is there.
write_updater_status() {
  write_updater_installed "$RESULT_DIR" "$1"
}

# handle <name>: one staged request: refused, checked or carried out.
CHECKED=0 UPDATED=0 CURRENT_ID=''
handle() {
  local name=$1 id=${1%.json} action target
  if ! read_staged "$name"; then
    rm -rf -- "${STAGE_DIR:?}/$name"
    refuse "$id" "$BAD_ACTION" '' "the request was refused: $PARSED"
    return 0
  fi
  rm -f -- "$STAGE_DIR/$name"
  read -r action target <<<"$PARSED"
  if [ "$INSTALL_OK" = 0 ]; then
    refuse "$id" "$action" "$target" "the installation cannot be read: $INSTALL_ERROR"
  elif [ "$action" = check ]; then
    if [ "$CHECKED" = 1 ]; then refuse "$id" check "$target" "one check per run; ask again"; return 0; fi
    CHECKED=1
    CURRENT_ID=$id
    do_check "$id" "$target"
  else
    if [ "$UPDATED" = 1 ]; then refuse "$id" update "$target" "another update was handled in this run"; return 0; fi
    UPDATED=1
    CURRENT_ID=$id
    do_update "$id" "$target"
  fi
  CURRENT_ID=''
}

# finish_on_exit: a run that dies with a request in hand leaves a final state, so the panel does
# not wait for it.
# shellcheck disable=SC2317,SC2329 # run by the EXIT trap
finish_on_exit() {
  local file
  [ -n "$CURRENT_ID" ] || return 0
  file=$RESULT_DIR/$CURRENT_ID.json
  if [ -f "$file" ] && jq -e '.terminal == false' >/dev/null 2>&1 <"$file"; then
    set_result "$CURRENT_ID" "state=\"error\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "updater.sh stopped unexpectedly; see journalctl -u mailexpert-updater.service and status.sh")"
  fi
}

main() {
  local prefix=/opt/mailexpert name fd
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown argument: $1 (see --help)" 2 ;;
    esac
  done
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
  [[ $PROGRESS_INTERVAL =~ ^[1-9][0-9]*$ ]] || die "MAILEXPERT_UPDATER_INTERVAL must be a number of seconds" 2
  [ "$(id -u)" = 0 ] || die "run updater.sh as root" 2
  SPOOL=$prefix/state/update-spool REQUEST_DIR=$SPOOL/request RESULT_DIR=$SPOOL/result
  WORK_DIR=$prefix/state/updater STAGE_DIR=$WORK_DIR/incoming
  prepare_spool
  exec {fd}>"$WORK_DIR/updater.lock"
  if ! flock -n "$fd"; then
    log "another updater.sh runs; it handles the spool"
    return 0
  fi
  # Drained before anything that can fail, so a broken installation cannot make the path unit
  # retrigger in a loop.
  stage_requests
  trap finish_on_exit EXIT
  if INSTALL_ERROR=$( (load_install "$prefix") 2>&1 >/dev/null); then
    load_install "$prefix"
    INSTALL_OK=1
    write_updater_status "$CFG_VERSION"
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    handle "$name"
  done < <(staged_in_order)
  prune_results
}

# One line: the checkout of the new version rewrites this file while it runs.
main "$@"; exit $?
