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
# shellcheck source=lib/system.sh
. "$LIB_DIR/system.sh"
exit_on_unexpected_failure

# How often a running update's result is rewritten (updatedAt and the log tail), in seconds.
PROGRESS_INTERVAL=${MAILEXPERT_UPDATER_INTERVAL:-5}
# How long a run waits for another updater.sh to finish, in seconds (well inside the service's
# TimeoutStartSec of 4 hours). Waiting instead of leaving at once: a request left in the spool would
# make the path unit start this service again and again until its start limit.
LOCK_WAIT=${MAILEXPERT_UPDATER_LOCK_WAIT:-3600}
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

# set_result <id> <name=<JSON value>...>: sets the fields of the result of the request in hand and
# writes result/<id>.json whole, to a temporary file in the same directory renamed over it, so the
# backend never reads half a file. The result is kept in memory (RESULT_ID, RESULT_JSON) and never
# read back from the spool: a result file is only ever written fresh, for a request taken in this
# run, so a request reusing the id of a finished one cannot change what that one says.
RESULT_ID='' RESULT_JSON='{}'
set_result() {
  local id=$1 tmp next
  shift
  if [ "$id" != "$RESULT_ID" ]; then RESULT_ID=$id RESULT_JSON='{}'; fi
  if ! next=$(result_merge "$(now)" "$@" <<<"$RESULT_JSON"); then
    warn "cannot write the result of $id"
    return 0
  fi
  RESULT_JSON=$next
  tmp=$(mktemp "$RESULT_DIR/.result.XXXXXX")
  printf '%s\n' "$RESULT_JSON" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$RESULT_DIR/$id.json"
}

# new_log <file>: the run's log, readable by root only.
new_log() {
  (umask 077 && : >>"$1")
  chmod 600 "$1"
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

# remove_entry <path>: out of the container's reach first, then removed (rm never follows a link).
remove_entry() {
  local junk
  junk=$(mktemp -u "$STAGE_DIR/junk.XXXXXX")
  if mv -f -- "$1" "$junk" 2>/dev/null; then rm -rf -- "$junk"; fi
}

# stage_requests: moves at most MAX_REQUESTS_PER_RUN *.json out of the request directory into the
# staging directory and removes everything else: entries that are not requests (a *.tmp younger
# than TMP_GRACE_MIN is being written and stays) and the requests beyond the limit, which get no
# result, only one line in the journal.
stage_requests() {
  local path name taken=0 junk=0 dropped=0
  while IFS= read -r -d '' path; do
    name=${path##*/}
    if [[ $name == *.tmp ]] && [ -n "$(find "$path" -maxdepth 0 -mmin "-$TMP_GRACE_MIN" 2>/dev/null)" ]; then
      continue
    fi
    if ! request_name_ok "$name"; then
      remove_entry "$path"
      junk=$((junk + 1))
      continue
    fi
    if [ "$taken" -ge "$MAX_REQUESTS_PER_RUN" ]; then
      remove_entry "$path"
      dropped=$((dropped + 1))
      continue
    fi
    rm -rf -- "${STAGE_DIR:?}/$name"
    # The container may remove it meanwhile: then there is nothing to take.
    mv -f -- "$path" "$STAGE_DIR/$name" 2>/dev/null || continue
    taken=$((taken + 1))
  done < <(find "$REQUEST_DIR" -mindepth 1 -maxdepth 1 -print0)
  if [ "$junk" -gt 0 ]; then log "removed $junk entries from the request directory that are not requests"; fi
  if [ "$dropped" -gt 0 ]; then log "removed $dropped requests beyond $MAX_REQUESTS_PER_RUN in one run, without results"; fi
  return 0
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
  local commit=${1#sha-} full head is_head=0 descendant=0 is_latest=0 on_main=0 latest='' rolled=0 reason
  if is_standby; then echo "standby server: the panel does not run here"; return 0; fi
  if lock_held "$STATE_DIR/update.lock"; then echo "an update, rollback or restore is running now"; return 0; fi
  if ! git -C "$APP_DIR" fetch --quiet origin 2>/dev/null; then echo "git fetch failed in $APP_DIR"; return 0; fi
  # A tag left in the checkout by an earlier fetch is not what origin promotes now (the owner may
  # have moved or withdrawn it): without a fresh fetch nothing counts as latest.
  if ! fetch_latest_tag 2>/dev/null; then
    echo "cannot fetch the tag latest from $(redact_url "$CFG_REPO_URL"): the panel installs only the build the tag names now"
    return 0
  fi
  full=$(git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}" 2>/dev/null) || {
    echo "commit $commit is not in $(redact_url "$CFG_REPO_URL")"
    return 0
  }
  head=$(git -C "$APP_DIR" rev-parse HEAD)
  if [ "$head" = "$full" ]; then is_head=1; fi
  if git -C "$APP_DIR" merge-base --is-ancestor "$head" "$full" 2>/dev/null; then descendant=1; fi
  latest=$(latest_commit 2>/dev/null) || latest=''
  if [ -n "$latest" ] && [ "$latest" = "$full" ]; then is_latest=1; fi
  if git -C "$APP_DIR" merge-base --is-ancestor "$full" refs/remotes/origin/main 2>/dev/null; then on_main=1; fi
  if [ "$(rolled_back_version "$STATE_DIR")" = "$1" ]; then rolled=1; fi
  reason=$(target_verdict "$is_head" "$descendant" "$is_latest" "$on_main" "$rolled")
  if [ -z "$reason" ] && [ "$(channel_images_state "$1")" = differ ]; then
    reason="the registry's latest images are not the images of $1 (a promotion half done?)"
  fi
  printf '%s' "$reason"
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
  new_log "$logfile"
  set_result "$id" "id=$(json_str "$id")" "action=\"check\"" "target=$(json_str "$target")" \
    "state=\"checking\"" "from=$(json_str "$CFG_VERSION")" "receivedAt=$(json_str "$(now)")" \
    "logFile=$(json_str "$logfile")" "journal=$(json_str "journalctl -u $(unit_name updater service)")"
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
  local next auto=false edge installed=0 units=''
  new_log "$logfile"
  set_result "$id" "id=$(json_str "$id")" "action=\"update\"" "target=$(json_str "$target")" \
    "state=\"checking\"" "from=$(json_str "$from")" "receivedAt=$(json_str "$(now)")" \
    "logFile=$(json_str "$logfile")" "journal=$(json_str "journalctl -u $(unit_name updater service)")"
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
  # Counted the same way before and after (as update.sh does), right before the switch.
  before=$(migration_count 2>/dev/null | tr -d '[:space:]') || before=''
  log "update $id: $from -> $target"
  set_result "$id" "state=\"updating\"" "startedAt=$(json_str "$(now)")" "autoRollback=$auto" \
    "message=$(json_str "updating $from -> $target")"
  run_logged "$id" "$logfile" bash "$SCRIPT_DIR/update.sh" "$target" --prefix "$OPT_PREFIX" || code=$?
  next=$(log_next <"$logfile" | jq -Rcs 'split("\n") | map(select(. != ""))')
  case $code in
    0)
      set_result "$id" "state=\"succeeded\"" "exitCode=0" "next=$next" "finishedAt=$(json_str "$(now)")" \
        "message=$(json_str "updated to $target")"
      rm -f "$STATE_DIR/rolled-back-version"
      write_updater_status "$target"
      return 0
      ;;
    1) ;;
    2 | 3)
      set_result "$id" "state=\"failed\"" "exitCode=$code" "finishedAt=$(json_str "$(now)")" \
        "message=$(json_str "update.sh stopped before the switch (exit $code): nothing was changed, $from still runs")"
      return 0
      ;;
    *)
      # Not one of update.sh's codes (killed, a signal): what it changed is unknown, no rollback.
      set_result "$id" "state=\"failed\"" "exitCode=$code" "finishedAt=$(json_str "$(now)")" \
        "message=$(json_str "update.sh ended with exit $code; the state of the panel is unknown, nothing was rolled back: check status.sh, then the runbook or rollback.sh --to $from over SSH")"
      return 0
      ;;
  esac
  # Exit 1: the switch began and $target did not become ready.
  after=$(migration_count 2>/dev/null | tr -d '[:space:]') || after=''
  if [ "$auto" != true ] || [ -z "$before" ] || [ "$after" != "$before" ]; then
    set_result "$id" "state=\"failed\"" "exitCode=$code" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready (exit $code); migrations ran or cannot be ruled out, so nothing was rolled back: follow the runbook or run rollback.sh --to $from over SSH")"
    return 0
  fi
  log "update $id: rolling back to $from (no migration ran)"
  set_result "$id" "state=\"rolling_back\"" "exitCode=$code" \
    "message=$(json_str "$target did not become ready; no migration ran, going back to $from")"
  # $from may predate the per-project unit names: its install.sh then writes the units of the
  # default names, which may belong to another install on this host (the default project), for
  # this prefix. They are saved first and put back after it, whatever its outcome.
  if ! save_foreign_fixed_units >>"$logfile" 2>&1; then
    warn "update $id: could not save the systemd units of another install on this host; not rolling back"
    set_result "$id" "state=\"rollback_failed\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready; going back to $from was not started: the systemd units of another install on this host could not be saved first (see the updater log); follow the runbook over SSH")"
    return 0
  fi
  edge=$(previous_edge_image "$from") || edge=''
  if [ -n "$edge" ]; then env_set "$EDGE_ENV" EDGE_IMAGE "$edge"; fi
  # A nightly backup that waited for update.sh may be dumping the database now (backup.sh holds
  # install.lock only for its dump): install.sh waits for it up to an hour, backup.sh's own bound,
  # instead of its default 10 minutes, so the dump of a large database does not fail the rollback.
  if run_logged "$id" "$logfile" env MAILEXPERT_LOCK_TIMEOUT=3600 bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$from"; then
    installed=1
  fi
  # The other install's units go back; the suffixed units of the kinds now under the default
  # names must not run next to them. The service this run is in is not stopped, only its path
  # unit and the files go.
  if ! units_after_downgrade >>"$logfile" 2>&1; then
    warn "update $id: the systemd units of another install on this host could not all be put back; see $logfile"
    units="; the systemd units of another install on this host that install.sh of $from rewrote could not all be put back, so that install's updater, backup or health check may serve this one: see the updater log over SSH"
  fi
  if [ "$installed" = 1 ]; then
    record_rolled_back "$STATE_DIR" "$target"
    write_updater_status "$from"
    set_result "$id" "state=\"rolled_back\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready; the panel went back to $from, nothing was lost$units")"
  else
    set_result "$id" "state=\"rollback_failed\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "$target did not become ready and going back to $from failed: follow the runbook over SSH$units")"
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
  write_updater_installed "${SPOOL%/update-spool}" "$1"
}

# handle <name>: one staged request: refused, checked or carried out. A request whose id already
# has a result is dropped without writing anything: results are never overwritten.
CHECKED=0 UPDATED=0 CURRENT_ID=''
handle() {
  local name=$1 id=${1%.json} action target
  if [ -e "$RESULT_DIR/$id.json" ] || [ -L "$RESULT_DIR/$id.json" ]; then
    rm -rf -- "${STAGE_DIR:?}/$name"
    log "request $id dropped: a result with this id exists already"
    return 0
  fi
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
  [ -n "$CURRENT_ID" ] && [ "$CURRENT_ID" = "$RESULT_ID" ] || return 0
  if jq -e '.terminal == false' >/dev/null 2>&1 <<<"$RESULT_JSON"; then
    set_result "$CURRENT_ID" "state=\"error\"" "finishedAt=$(json_str "$(now)")" \
      "message=$(json_str "updater.sh stopped unexpectedly; see journalctl -u $(unit_name updater service) and status.sh")"
  fi
}

main() {
  local prefix=/opt/mailexpert name fd waited
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
  [[ $LOCK_WAIT =~ ^[0-9]+$ ]] || die "MAILEXPERT_UPDATER_LOCK_WAIT must be a number of seconds" 2
  [ "$(id -u)" = 0 ] || die "run updater.sh as root" 2
  SPOOL=$prefix/state/update-spool REQUEST_DIR=$SPOOL/request RESULT_DIR=$SPOOL/result
  WORK_DIR=$prefix/state/updater STAGE_DIR=$WORK_DIR/incoming
  SPOOL_UID=$(spool_uid "$prefix/state")
  prepare_spool
  # One run at a time. A second run (the path unit fired again, for example the updater units of
  # a newly installed version while the old service still runs the update) waits for the first
  # and then handles what is left in the spool. Nothing the first run starts (update.sh, install.sh)
  # runs updater.sh, so it never waits for itself.
  exec {fd}>"$WORK_DIR/updater.lock"
  waited=0
  until flock -n "$fd"; do
    if [ "$waited" -eq 0 ]; then log "another updater.sh runs; waiting up to ${LOCK_WAIT}s for it to finish"; fi
    if [ "$waited" -ge "$LOCK_WAIT" ]; then
      log "another updater.sh still runs after ${LOCK_WAIT}s; leaving the spool to it"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
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
