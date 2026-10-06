#!/usr/bin/env bash
# The node agent's update job (docs/operations/mail-node.md, section 7a): brings the node's scripts
# to the commit the panel runs. Started by node-agent.sh, detached from it (a transient systemd unit
# or setsid nohup), from a copy in $NODE_STATE/update-run-<job id>/: setup.sh restarts the agent and
# installs new versions of these files while the update runs.
#
# 1. The commit: 40 hex digits, fetched from the official repository into the node's checkout
#    (/opt/mailexpert-node-src, where setup.sh runs from) and in the history of its main
#    (git merge-base --is-ancestor <sha> origin/main): the panel chooses a version, it cannot bring
#    code of its own. Otherwise: failed, not_in_main, nothing changed.
# 2. node-backup.sh --tag pre-update. The node's backup is required: without restic keys in
#    node.env the update fails with backup_not_configured and changes nothing; a failed backup
#    stops it too (backup_failed). A standby node (moved away) is not updated (node_standby).
# 3. The checkout goes to <sha> (detached) and setup.sh runs without options (it reuses the values
#    in node.env). When it fails, the checkout goes back to the commit before and setup.sh runs
#    again: failed, rolled_back (rollback_failed when that fails too).
# 4. mailcow_update_if_pinned: the hook for mailcow's own update (PR D); nothing yet.
# 5. Checks: postfix-mailcow, dovecot-mailcow and nginx-mailcow run, eop-ranges.sh passes (the
#    firewall and the ports). Then a status report (the new scripts commit) and succeeded.
# Each step goes to the panel as the job's step with the end of the output, at least every 15
# seconds, and into $NODE_STATE/update-<job id>.json (state, step, error, the process id), which the
# agent reads after its restart; the full output is in $NODE_STATE/update-<job id>.log (0600; the
# last five are kept).
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

SETUP_TIMEOUT=${MAILEXPERT_NODE_UPDATE_SETUP_TIMEOUT:-1800}
FETCH_TIMEOUT=300
CHECK_TIMEOUT=600
KEEP_LOGS=5
UPDATE_ID=''
UPDATE_LOG=''
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
  write_update_state "$UPDATE_ID" running "$1" '' "$$"
  report "$UPDATE_ID" running "$1" "$UPDATE_LOG" || true
}

# finish <succeeded|failed> <step> [<error>]: the result, kept in the state file until the panel
# took it (the agent delivers it otherwise), then the end of the run.
finish() {
  local state=$1 text=$2 error=${3:-}
  if [ "$state" = succeeded ]; then log "$text"; else warn "$text${error:+ ($error)}"; fi
  write_update_state "$UPDATE_ID" "$state" "$text" "$error" "$$"
  if report "$UPDATE_ID" "$state" "$text" "$UPDATE_LOG" "$error"; then
    rm -f "$(update_state_file "$UPDATE_ID")"
    rm -rf "$(update_run_dir "$UPDATE_ID")"
  fi
  exit 0
}

# run_step <text> <command...>: the command with its output in the log, reported while it runs;
# its exit status.
run_step() {
  local text=$1 pid rc=0 waited=0
  shift
  step "$text"
  printf '\n== %s\n' "$text" >>"$UPDATE_LOG"
  "$@" >>"$UPDATE_LOG" 2>&1 </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
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

# mailcow_update_if_pinned: mailcow brought to the version the release pins
# (deploy/mailcow-version), when it differs from the node's. Nothing yet: mailcow's own update is
# PR D of the node agent series (docs/superpowers/specs/2026-10-06-node-agent-updates-design.md),
# which fills this in. Status 0: nothing to do.
mailcow_update_if_pinned() {
  return 0
}

# post_checks: the mail services run and eop-ranges.sh passes. Prints the first problem.
post_checks() {
  local missing service
  local -a wanted=(postfix-mailcow dovecot-mailcow nginx-mailcow)
  for service in "${wanted[@]}"; do
    if ! mailcow_running "$(mailcow_dir)" "$service" | grep -qx "$service"; then missing+="${missing:+ }$service"; fi
  done
  if [ -n "${missing:-}" ]; then
    echo "not running: $missing"
    return 1
  fi
  if ! run_step "check: eop-ranges.sh (firewall and ports)" timeout "$CHECK_TIMEOUT" "$NODE_DIR/eop-ranges.sh"; then
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

update_main() {
  local sha=${2:-} previous problem
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
  run_step "git fetch origin" timeout "$FETCH_TIMEOUT" git -C "$SRC" fetch --quiet origin ||
    finish failed "git fetch in $SRC failed" fetch_failed
  git -C "$SRC" merge-base --is-ancestor "$sha" origin/main >>"$UPDATE_LOG" 2>&1 ||
    finish failed "${sha:0:12} is not in the history of origin/main: refused" not_in_main

  if [ -f "$(node_standby_file)" ]; then
    finish failed "the node is standby (moved away): not updated" node_standby
  fi
  env_get "$NODE_CONF" RESTIC_REPOSITORY >/dev/null 2>&1 ||
    finish failed "the node's backup is not set up (setup.sh --backup-keys): no update without a pre-update backup" backup_not_configured
  run_step "node-backup.sh --tag pre-update" timeout -k 60 "$(backup_timeout)" "$NODE_DIR/node-backup.sh" --tag pre-update ||
    finish failed "the pre-update backup failed: $(last_step "$UPDATE_LOG"); the node is unchanged" backup_failed

  previous=$(git -C "$SRC" rev-parse HEAD 2>/dev/null) || previous=''
  is_sha "$previous" || finish failed "the commit of $SRC is unknown; the node is unchanged" src_missing
  checkout "$sha" >>"$UPDATE_LOG" 2>&1 ||
    finish failed "git checkout ${sha:0:12} failed (changes in $SRC?); the node is unchanged" checkout_failed
  if ! run_step "setup.sh at ${sha:0:12}" run_setup; then
    problem=$(last_step "$UPDATE_LOG")
    if checkout "$previous" >>"$UPDATE_LOG" 2>&1 && run_step "rollback: setup.sh at ${previous:0:12}" run_setup; then
      send_status || true
      finish failed "setup.sh failed ($problem); rolled back to ${previous:0:12}" rolled_back
    fi
    send_status || true
    finish failed "setup.sh failed ($problem) and so did the rollback to ${previous:0:12}: see $UPDATE_LOG" rollback_failed
  fi

  step "mailcow: the version the release pins"
  mailcow_update_if_pinned >>"$UPDATE_LOG" 2>&1 ||
    finish failed "mailcow's update failed: $(last_step "$UPDATE_LOG")" mailcow_update_failed

  step "checks: mailcow's services, the firewall"
  problem=$(post_checks) || finish failed "the node is updated to ${sha:0:12}, but a check failed: $problem" post_check_failed
  send_status || true
  finish succeeded "the node's scripts are at ${sha:0:12}"
}

update_main "$@"
