#!/usr/bin/env bash
# The node agent's update job (docs/operations/mail-node.md, section 7a): brings the node's scripts
# to the commit the panel runs. Started by node-agent.sh, detached from it (a transient systemd unit
# or setsid nohup), from a copy in $NODE_STATE/update-run-<job id>/: setup.sh restarts the agent and
# installs new versions of these files while the update runs.
#
# 1. The checkout and the commit. The node's checkout (/opt/mailexpert-node-src, where setup.sh
#    runs from) must fetch from the official repository (its origin is
#    https://github.com/wyrtensi/MailExpert, or NODE_UPDATE_ORIGIN in node.env, which only root
#    writes; otherwise untrusted_origin) and hold no changes to tracked files (local_changes). The
#    commit: 40 hex digits, in the history of origin/main after a fetch (not_in_main otherwise): the
#    panel chooses a version, it cannot bring code of its own. It must also be the checkout's own
#    commit or a newer one: the update never takes the node back (not_newer).
# 2. node-backup.sh --tag pre-update. The node's backup is required: without restic keys in
#    node.env the update fails with backup_not_configured and changes nothing; a failed backup
#    stops it too (backup_failed). A standby node (moved away) is not updated (node_standby).
# 3. The checkout goes to <sha> (detached) and setup.sh runs without options (it reuses the values
#    in node.env). When it fails, the checkout goes back to the commit before and setup.sh runs
#    again: failed, rolled_back (rollback_failed when that fails too).
# 4. mailcow_update_if_pinned: mailcow's own update (PR D; nothing yet), bounded like a step. When
#    it fails, mailcow is started again (docker compose up -d) and the checks still run:
#    mailcow_update_failed.
# 5. Checks: postfix-mailcow, dovecot-mailcow and nginx-mailcow run, eop-ranges.sh passes (the
#    firewall and the ports); otherwise post_check_failed. Then a status report (the new scripts
#    commit) and succeeded.
# Each step goes to the panel as the job's step with the end of the output, at least every 15
# seconds, and into $NODE_STATE/update-<job id>.json (state, step, error, the process id, the
# commit before the update), which the agent reads after its restart; the full output is in
# $NODE_STATE/update-<job id>.log (0600; the last five are kept). The bounds of the steps are the
# panel's (UPDATE_STEP_BOUNDS_MS in backend/src/services/mailNode/nodeAgent.js).
#
# Usage: node-update.sh <job id> <sha>   (run by node-agent.sh, not by hand)
# Exit codes: 0 the update ended (succeeded or failed, reported), 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The agent's functions (load_conf, panel, report, send_status) and the libraries it loads.
# shellcheck source=node-agent.sh
. "$SCRIPT_DIR/node-agent.sh"

# The official repository, as the node's checkout names its origin.
OFFICIAL_ORIGIN_RE='^https://github\.com/wyrtensi/MailExpert(\.git)?/?$'
SETUP_TIMEOUT=${MAILEXPERT_NODE_UPDATE_SETUP_TIMEOUT:-1800}
FETCH_TIMEOUT=300
# node-backup.sh waits up to an hour for another backup's lock, on top of the backup's own bound.
BACKUP_LOCK_WAIT=3600
MAILCOW_TIMEOUT=${MAILEXPERT_NODE_UPDATE_MAILCOW_TIMEOUT:-1800}
CHECK_TIMEOUT=600
KEEP_LOGS=5
UPDATE_ID=''
UPDATE_LOG=''
PREVIOUS=''
SRC=''

# scripts_src: the node's checkout of the repository, as setup.sh recorded it (the one it runs from).
scripts_src() {
  local file=$NODE_DIR/scripts-src
  if [ -n "${MAILEXPERT_NODE_SRC:-}" ]; then
    echo "$MAILEXPERT_NODE_SRC"
  elif [ -s "$file" ]; then
    head -n 1 "$file"
  else
    echo /opt/mailexpert-node-src
  fi
}

# step <text>: the step the panel and the state file show.
step() {
  log "$1"
  write_update_state "$UPDATE_ID" running "$1" '' "$$" "$PREVIOUS"
  report "$UPDATE_ID" running "$1" "$UPDATE_LOG" || true
}

# finish <succeeded|failed> <step> [<error>]: the result, kept in the state file until the panel
# took it (the agent delivers it otherwise), then the end of the run.
finish() {
  local state=$1 text=$2 error=${3:-}
  if [ "$state" = succeeded ]; then log "$text"; else warn "$text${error:+ ($error)}"; fi
  write_update_state "$UPDATE_ID" "$state" "$text" "$error" "$$" "$PREVIOUS"
  if report "$UPDATE_ID" "$state" "$text" "$UPDATE_LOG" "$error"; then
    rm -f "$(update_state_file "$UPDATE_ID")"
    rm -rf "$(update_run_dir "$UPDATE_ID")"
  fi
  exit 0
}

# run_step [--timeout <seconds>] <text> <command...>: the command with its output in the log,
# reported while it runs; its exit status (124 when it ran past the timeout and was stopped).
run_step() {
  local limit=0 text pid rc=0 waited=0 elapsed=0
  if [ "$1" = --timeout ]; then limit=$2 && shift 2; fi
  text=$1
  shift
  step "$text"
  printf '\n== %s\n' "$text" >>"$UPDATE_LOG"
  "$@" >>"$UPDATE_LOG" 2>&1 </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    elapsed=$((elapsed + 1))
    if [ "$limit" -gt 0 ] && [ "$elapsed" -ge "$limit" ]; then
      printf '[mailexpert] error: %s ran past %ss; stopped\n' "$text" "$limit" >>"$UPDATE_LOG"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    if [ "$waited" -ge "$PROGRESS_EVERY" ]; then
      waited=0
      report "$UPDATE_ID" running "$text: $(last_step "$UPDATE_LOG")" "$UPDATE_LOG" || true
    fi
  done
  wait "$pid" || rc=$?
  return "$rc"
}

# shellcheck disable=SC2317,SC2329 # invoked through run_step
# run_setup: setup.sh of the checkout as it is now, without options.
run_setup() {
  timeout -k 60 "$SETUP_TIMEOUT" "$SRC/scripts/deploy/mail-node/setup.sh"
}

# checkout <sha>: the node's checkout at the commit, detached.
checkout() {
  git -C "$SRC" checkout --quiet --detach "$1"
}

# shellcheck disable=SC2317,SC2329 # invoked through run_step
# mailcow_update_if_pinned: mailcow brought to the version the release pins
# (deploy/mailcow-version), when it differs from the node's. Nothing yet: mailcow's own update is
# PR D of the node agent series (docs/superpowers/specs/2026-10-06-node-agent-updates-design.md),
# which fills this in. Status 0: nothing to do.
mailcow_update_if_pinned() {
  return 0
}

# shellcheck disable=SC2317,SC2329 # invoked through run_step
# mailcow_up: mailcow's containers started again after its update failed.
mailcow_up() {
  cd "$(mailcow_dir)" && docker compose up -d
}

# post_checks: the mail services run and eop-ranges.sh passes. Prints the first problem.
post_checks() {
  local missing='' service
  local -a wanted=(postfix-mailcow dovecot-mailcow nginx-mailcow)
  for service in "${wanted[@]}"; do
    if ! mailcow_running "$(mailcow_dir)" "$service" | grep -qx "$service"; then missing+="${missing:+ }$service"; fi
  done
  if [ -n "$missing" ]; then
    echo "not running: $missing"
    return 1
  fi
  if ! run_step --timeout "$CHECK_TIMEOUT" "check: eop-ranges.sh (firewall and ports)" "$NODE_DIR/eop-ranges.sh"; then
    echo "eop-ranges.sh found a problem: $(last_step "$UPDATE_LOG")"
    return 1
  fi
}

# close_inherited_fds: descriptors the agent's start left open (cron's flock lock among them), so
# the restarted agent can take its lock while the update runs.
close_inherited_fds() {
  local fd n
  for fd in "/proc/$$/fd/"*; do
    n=${fd##*/}
    [[ $n =~ ^[0-9]+$ ]] || continue
    if [ "$n" -gt 2 ] && [ "$n" -lt 255 ]; then eval "exec $n>&-" 2>/dev/null || true; fi
  done
}

# prune_logs: the last KEEP_LOGS update logs stay.
prune_logs() {
  local old
  # shellcheck disable=SC2012 # the names are update-<digits>.log
  old=$(ls -1t "$NODE_STATE"/update-*.log 2>/dev/null | tail -n +$((KEEP_LOGS + 1))) || old=''
  if [ -n "$old" ]; then printf '%s\n' "$old" | xargs -r rm -f; fi
}

# trusted_origin: the checkout's origin is the official repository, or the one node.env names.
trusted_origin() {
  local origin allowed
  origin=$(git -C "$SRC" remote get-url origin 2>/dev/null) || return 1
  allowed=$(env_get "$NODE_CONF" NODE_UPDATE_ORIGIN 2>/dev/null) || allowed=''
  if [ -n "$allowed" ]; then [ "$origin" = "$allowed" ]; else [[ $origin =~ $OFFICIAL_ORIGIN_RE ]]; fi
}

update_main() {
  local sha=${2:-} problem checks_problem=''
  UPDATE_ID=${1:-}
  is_job_id "$UPDATE_ID" || die "usage: node-update.sh <job id> <sha>" 2
  is_sha "$sha" || die "the commit must be 40 hex digits" 2
  close_inherited_fds
  install -d "$NODE_STATE"
  UPDATE_LOG=$(update_log_file "$UPDATE_ID")
  : >>"$UPDATE_LOG"
  chmod 600 "$UPDATE_LOG"
  exec >>"$UPDATE_LOG" 2>&1
  WORK=$(mktemp -d)
  trap cleanup EXIT
  # A stop (a shutdown) leaves the state file running: the agent reports update_interrupted.
  load_conf
  prune_logs
  SRC=$(scripts_src)

  step "checking the commit ${sha:0:12} in the official repository"
  git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    finish failed "$SRC is not a checkout of the repository" src_missing
  trusted_origin ||
    finish failed "the origin of $SRC is not the official repository (NODE_UPDATE_ORIGIN in node.env allows another)" untrusted_origin
  # Untracked files do not count: a checkout never touches them, and one in its way fails it.
  [ -z "$(git -C "$SRC" status --porcelain --untracked-files=no 2>/dev/null || echo error)" ] ||
    finish failed "$SRC has local changes (git status): commit, stash or drop them first; the node is unchanged" local_changes
  run_step --timeout "$FETCH_TIMEOUT" "git fetch origin" git -C "$SRC" fetch --quiet origin ||
    finish failed "git fetch in $SRC failed" fetch_failed
  git -C "$SRC" merge-base --is-ancestor "$sha" origin/main >>"$UPDATE_LOG" 2>&1 ||
    finish failed "${sha:0:12} is not in the history of origin/main: refused" not_in_main
  PREVIOUS=$(git -C "$SRC" rev-parse HEAD 2>/dev/null) || PREVIOUS=''
  is_sha "$PREVIOUS" || finish failed "the commit of $SRC is unknown; the node is unchanged" src_missing
  git -C "$SRC" merge-base --is-ancestor "$PREVIOUS" "$sha" >>"$UPDATE_LOG" 2>&1 ||
    finish failed "the node is at ${PREVIOUS:0:12}, which ${sha:0:12} does not follow: the update never takes the node back" not_newer

  if [ -f "$(node_standby_file)" ]; then
    finish failed "the node is standby (moved away): not updated" node_standby
  fi
  env_get "$NODE_CONF" RESTIC_REPOSITORY >/dev/null 2>&1 ||
    finish failed "the node's backup is not set up (setup.sh --backup-keys): no update without a pre-update backup" backup_not_configured
  run_step --timeout "$(($(backup_timeout) + BACKUP_LOCK_WAIT))" "node-backup.sh --tag pre-update" \
    "$NODE_DIR/node-backup.sh" --tag pre-update ||
    finish failed "the pre-update backup failed: $(last_step "$UPDATE_LOG"); the node is unchanged" backup_failed

  checkout "$sha" >>"$UPDATE_LOG" 2>&1 ||
    finish failed "git checkout ${sha:0:12} failed; the node is unchanged" checkout_failed
  if ! run_step "setup.sh at ${sha:0:12}" run_setup; then
    problem=$(last_step "$UPDATE_LOG")
    if checkout "$PREVIOUS" >>"$UPDATE_LOG" 2>&1 && run_step "rollback: setup.sh at ${PREVIOUS:0:12}" run_setup; then
      send_status || true
      finish failed "setup.sh failed ($problem); rolled back to ${PREVIOUS:0:12}" rolled_back
    fi
    send_status || true
    finish failed "setup.sh failed ($problem) and so did the rollback to ${PREVIOUS:0:12}: see $UPDATE_LOG" rollback_failed
  fi

  if ! run_step --timeout "$MAILCOW_TIMEOUT" "mailcow: the version the release pins" mailcow_update_if_pinned; then
    problem=$(last_step "$UPDATE_LOG")
    run_step --timeout "$CHECK_TIMEOUT" "mailcow: docker compose up -d after the failed update" mailcow_up || true
    checks_problem=$(post_checks) || true
    send_status || true
    finish failed "mailcow's update failed ($problem)${checks_problem:+; $checks_problem}; the scripts are at ${sha:0:12}" mailcow_update_failed
  fi

  step "checks: mailcow's services, the firewall"
  if ! problem=$(post_checks); then
    send_status || true
    finish failed "the node is updated to ${sha:0:12}, but a check failed: $problem" post_check_failed
  fi
  send_status || true
  finish succeeded "the node's scripts are at ${sha:0:12}"
}

# Tests source this file to replace a step; run, it updates.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then update_main "$@"; fi
