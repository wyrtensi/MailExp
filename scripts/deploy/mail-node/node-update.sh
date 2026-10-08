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
# 4. mailcow_update_if_pinned: mailcow brought to the version deploy/mailcow-version of that
#    commit pins, by mailcow's own update.sh, when the node is behind it and it is the head of
#    mailcow's master (see the function), bounded like a step. When it fails, setup.sh runs again
#    (update.sh may have left ENABLE_IPV6=true), mailcow is started again (docker compose up -d) and
#    the checks still run: mailcow_update_failed, or mailcow_past_pin when update.sh took mailcow
#    past the pin (a newer mailcow was released while it ran).
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
# Caps of the parts of mailcow's update: a run of update.sh, the wait for healthy containers. Each
# part also gets no more than what is left of MAILCOW_TIMEOUT less MAILCOW_RESERVE (mailcow_budget),
# so all of them end before the step's own bound.
MAILCOW_UPDATE_SH_TIMEOUT=${MAILEXPERT_NODE_UPDATE_MAILCOW_SH_TIMEOUT:-1200}
MAILCOW_HEALTH_WAIT=${MAILEXPERT_NODE_UPDATE_MAILCOW_HEALTH_WAIT:-300}
MAILCOW_HEALTH_POLL=${MAILEXPERT_NODE_UPDATE_MAILCOW_HEALTH_POLL:-5}
MAILCOW_RESERVE=60
MAILCOW_DEADLINE=0
CHECK_TIMEOUT=600
# A process group stopped past its bound gets TERM, then KILL this many seconds later.
KILL_GRACE=${MAILEXPERT_NODE_UPDATE_KILL_GRACE:-30}
GROUP_PID=''
KEEP_LOGS=5
UPDATE_ID=''
UPDATE_LOG=''
PREVIOUS=''
SRC=''

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

# start_group <command...>: the command (a function too) started in the background in a process
# group of its own (job control on just for the start), its process id in GROUP_PID: a stop reaches
# everything it started (docker compose under update.sh, setup.sh's children), not only itself.
start_group() {
  set -m
  "$@" &
  GROUP_PID=$!
  set +m
}

# kill_group <pid>: the process group of start_group stopped: TERM, KILL after KILL_GRACE seconds.
kill_group() {
  local pid=$1 waited=0
  kill -TERM -- "-$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$KILL_GRACE" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# run_group <seconds> <command...>: the command in its own process group, stopped whole past the
# bound; its exit status, 124 past the bound.
run_group() {
  local limit=$1 pid rc=0 waited=0
  shift
  start_group "$@"
  pid=$GROUP_PID
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      printf '[mailexpert] error: %s ran past %ss; stopped\n' "$1" "$limit" >&2
      kill_group "$pid"
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" || rc=$?
  return "$rc"
}

# run_step [--timeout <seconds>] <text> <command...>: the command with its output in the log, in
# its own process group, reported while it runs; its exit status (124 when it ran past the timeout:
# the whole group is stopped).
run_step() {
  local limit=0 text pid rc=0 waited=0 elapsed=0
  if [ "$1" = --timeout ]; then limit=$2 && shift 2; fi
  text=$1
  shift
  step "$text"
  printf '\n== %s\n' "$text" >>"$UPDATE_LOG"
  start_group "$@" >>"$UPDATE_LOG" 2>&1 </dev/null
  pid=$GROUP_PID
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    elapsed=$((elapsed + 1))
    if [ "$limit" -gt 0 ] && [ "$elapsed" -ge "$limit" ]; then
      printf '[mailexpert] error: %s ran past %ss; stopped\n' "$text" "$limit" >>"$UPDATE_LOG"
      kill_group "$pid"
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

# last_output <log>: the last line a command wrote to the log (its error, as a rule): no step
# header, "[mailexpert] " dropped, URLs without user information (error_tail), cut to 160
# characters; "no output" when there is none.
last_output() {
  local line
  line=$(grep -v -e '^== ' -e '^[[:space:]]*$' "$1" 2>/dev/null | error_tail) || line=''
  line=${line#\[mailexpert\] }
  printf '%s' "${line:-no output}" | cut -c1-160
}

# shellcheck disable=SC2317,SC2329 # invoked through run_step
# run_setup [<seconds>]: setup.sh of the checkout as it is now, without options, bounded
# (SETUP_TIMEOUT by default).
run_setup() {
  run_group "${1:-$SETUP_TIMEOUT}" "$SRC/scripts/deploy/mail-node/setup.sh"
}

# checkout <sha>: the node's checkout at the commit, detached.
checkout() {
  git -C "$SRC" checkout --quiet --detach "$1"
}

# bad_containers: reads mailcow_containers lines on stdin and prints, on one line, the containers
# that do not run or are unhealthy or still starting ("<service>: <state>, ..."), nothing when none.
bad_containers() {
  awk -F'\t' 'NF && ($2 != "running" || $3 == "unhealthy" || $3 == "starting") {
    printf "%s%s: %s", (n++ ? ", " : ""), $1, ($2 != "running" ? $2 : $3) }'
}

LAST_ERROR=''
# with_error <command...>: the command (a function too) with its error output still in the log;
# the last line of that output is kept in LAST_ERROR (cut to 200 characters), for the warning that
# names the cause.
with_error() {
  local file rc=0
  file=$(mktemp)
  "$@" 2>"$file" || rc=$?
  cat "$file" >&2
  LAST_ERROR=$(error_tail <"$file")
  rm -f "$file"
  return "$rc"
}

# compose_error: reads the output of docker compose on stdin and prints its last line that names
# an error (error, failed, unhealthy), or its last line when none does; cut to 200 characters.
compose_error() {
  local out line
  out=$(sed '/^[[:space:]]*$/d')
  line=$(grep -iE 'error|fail|unhealthy' <<<"$out" | tail -n 1) || line=''
  if [ -z "$line" ]; then line=$(tail -n 1 <<<"$out"); fi
  line=${line#"${line%%[![:space:]]*}"}
  printf '%s\n' "${line:0:200}"
}

# mailcow_wait_healthy <seconds>: every container of mailcow runs and none is unhealthy or still
# starting, within the seconds. Prints what is not, and fails, past them.
mailcow_wait_healthy() {
  local limit=$1 waited=0 lines bad
  while :; do
    lines=$(mailcow_containers) || lines=''
    bad=$(bad_containers <<<"$lines")
    if [ -n "$lines" ] && [ -z "$bad" ]; then return 0; fi
    if [ "$waited" -ge "$limit" ]; then
      echo "${bad:-no containers}"
      return 1
    fi
    sleep "$MAILCOW_HEALTH_POLL"
    waited=$((waited + MAILCOW_HEALTH_POLL))
  done
}

# mailcow_budget <cap seconds>: the seconds a part of mailcow's update may take: the cap, or what
# is left before MAILCOW_DEADLINE when that is less (at least 1).
mailcow_budget() {
  local left=$((MAILCOW_DEADLINE - $(date +%s)))
  if [ "$left" -lt 1 ]; then left=1; fi
  if [ "$1" -lt "$left" ]; then echo "$1"; else echo "$left"; fi
}

# shellcheck disable=SC2317,SC2329 # invoked through run_group
# update_sh_in <mailcow dir>: mailcow's update.sh run from its directory (it refuses another),
# unattended: --force answers its questions, --skip-ping-check (the node may block ICMP),
# --skip-start (setup.sh puts our settings back into mailcow.conf before mailcow starts: one stop
# instead of two); stdin is /dev/null.
update_sh_in() {
  cd "$1" && ./update.sh --force --skip-ping-check --skip-start </dev/null
}

# mailcow_update_sh <mailcow dir>: update.sh in a process group of its own, bounded (a stop past
# the bound reaches docker compose and whatever else it started). It exits 2 once when its own
# _modules changed ("restart the update script"): run again once.
mailcow_update_sh() {
  local rc=0 run
  for run in 1 2; do
    rc=0
    run_group "$(mailcow_budget "$MAILCOW_UPDATE_SH_TIMEOUT")" update_sh_in "$1" || rc=$?
    if [ "$rc" != 2 ] || [ "$run" = 2 ]; then break; fi
    log "mailcow: update.sh updated its own modules (exit 2); running it again"
  done
  return "$rc"
}

# same_repository <url> <url>: the same repository, with or without .git and a trailing slash.
same_repository() {
  local a=${1%/} b=${2%/}
  [ "${a%.git}" = "${b%.git}" ]
}

# shellcheck disable=SC2317,SC2329 # invoked through run_step
# mailcow_update_if_pinned: mailcow brought to the version the release pins
# (deploy/mailcow-version of the node's checkout, at the commit the update just checked out; never
# a version the panel names). Only mailcow's own update.sh moves it, and that script can only go
# to the head of mailcow's master: the update runs only while that head is the pinned commit. It
# skips (status 0, a warning in the log) when there is no pin, mailcow is at the pin already, the
# node runs a newer or another mailcow (never taken back), or mailcow released a newer, untested
# version (mailcow_pin_not_latest: the next MailExpert release confirms it). Otherwise:
#   - origin set to mailcow's official repository (update.sh --force does the same), master
#     fetched; a detached checkout (a clone at a tag) becomes the branch master at the same commit
#     (no file changes; update.sh needs a branch tracking origin/master);
#   - update.sh (mailcow_update_sh): it fetches the images, stops mailcow, commits local changes
#     ("Before update on ...") and merges master (-Xtheirs), and removes the mailcow images no
#     longer used (docker_garbage);
#   - setup.sh again (update.sh turns ENABLE_IPV6 on by itself when the host has IPv6 and adds new
#     keys), docker compose up -d, every container healthy, mailcow at the pin.
# Mail is not accepted from update.sh's stop to the start (minutes; EOP queues and retries for
# 24 hours): the log names that window. mailcow.conf values are never printed. Every part is
# bounded by what is left of MAILCOW_TIMEOUT (mailcow_budget). Status 1 on a failure, 3 when
# update.sh took mailcow past the pin (a newer mailcow was released while it ran:
# mailcow_past_pin); mailcow may be stopped then, and the caller starts it again.
# Run by hand: SRC=<checkout> and node-update.sh sourced (docs/operations/mail-node.md, 7a).
mailcow_update_if_pinned() {
  local src dir tag pin base relation branch hostname origin started stopped problem changed limit output rc bad
  MAILCOW_DEADLINE=$(($(date +%s) + MAILCOW_TIMEOUT - MAILCOW_RESERVE))
  SRC=${SRC:-$(scripts_src)}
  src=$SRC
  dir=$(mailcow_dir)
  if [ ! -f "$src/deploy/mailcow-version" ]; then
    log "mailcow: this release pins no mailcow version; not touched"
    return 0
  fi
  if ! tag=$(mailcow_pin "$src" MAILCOW_TAG) || ! pin=$(mailcow_pin "$src" MAILCOW_COMMIT); then
    warn "mailcow: $src/deploy/mailcow-version has no valid MAILCOW_TAG and MAILCOW_COMMIT"
    return 1
  fi
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    warn "mailcow: $dir is not a git checkout of mailcow"
    return 1
  }
  base=$(mailcow_base "$dir") || base=''
  if [ "$base" = "$pin" ] && [ "$(mailcow_relation "$dir" "$base" "$pin")" = match ]; then
    log "mailcow already at $tag"
    return 0
  fi

  origin=$(git -C "$dir" remote get-url origin 2>/dev/null) || origin=''
  if ! same_repository "$origin" "$MAILCOW_UPSTREAM"; then
    log "mailcow: origin set to the official repository $MAILCOW_UPSTREAM (update.sh --force does the same)"
    if [ -n "$origin" ]; then
      with_error git -C "$dir" remote set-url origin "$MAILCOW_UPSTREAM"
    else
      with_error git -C "$dir" remote add origin "$MAILCOW_UPSTREAM"
    fi || { warn "mailcow: could not set origin in $dir${LAST_ERROR:+: $LAST_ERROR}"; return 1; }
  fi
  # A clone of one tag (git clone --branch <tag> --single-branch) fetches only that tag: origin's
  # branches never reach refs/remotes/origin/, and master cannot track origin/master.
  if ! git -C "$dir" config --get-all remote.origin.fetch 2>/dev/null |
    grep -qE '^\+?refs/heads/(\*|master):refs/remotes/origin/(\*|master)$'; then
    log "mailcow: origin fetched no branches (a clone of one tag); its fetch now maps them too: +refs/heads/*:refs/remotes/origin/*"
    with_error git -C "$dir" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' || {
      warn "mailcow: could not add the branches to origin's fetch in $dir${LAST_ERROR:+: $LAST_ERROR}"
      return 1
    }
  fi
  with_error git -C "$dir" fetch --quiet origin +refs/heads/master:refs/remotes/origin/master || {
    warn "mailcow: git fetch of master from $MAILCOW_UPSTREAM failed${LAST_ERROR:+: $LAST_ERROR}"
    return 1
  }
  base=$(mailcow_base "$dir") || base=''
  [[ $base =~ ^[0-9a-f]{40}$ ]] || { warn "mailcow: the commit of $dir is unknown"; return 1; }
  relation=$(mailcow_relation "$dir" "$base" "$pin")
  case $relation in
    match) log "mailcow already at $tag"; return 0 ;;
    newer)
      warn "mailcow: the node runs ${base:0:12}, newer than $tag that this release confirms (updated by hand?): not taken back"
      return 0
      ;;
    diverged)
      warn "mailcow: the node runs ${base:0:12}, not in the history of $tag: not touched"
      return 0
      ;;
  esac
  if [ "$(git -C "$dir" rev-parse refs/remotes/origin/master)" != "$pin" ]; then
    warn "mailcow_pin_not_latest: mailcow released a newer version than $tag, not tested with this release; mailcow stays at ${base:0:12} until a MailExpert release confirms one"
    return 0
  fi

  # update.sh asks about a host name without a subdomain and ends before it stops anything; it
  # reads /dev/tty for a SYSCTL_IPV6_DISABLED=1 line (an option mailcow dropped), and waits there
  # when a terminal runs it.
  if grep -q 'SYSCTL_IPV6_DISABLED=1' "$dir/mailcow.conf" 2>/dev/null; then
    warn "mailcow: mailcow.conf has SYSCTL_IPV6_DISABLED=1, which mailcow no longer uses and update.sh stops to ask about: remove the line, then update again"
    return 1
  fi
  hostname=$(env_get "$dir/mailcow.conf" MAILCOW_HOSTNAME 2>/dev/null) || hostname=''
  hostname=${hostname//[^.]/}
  if [ "${#hostname}" -lt 2 ]; then
    warn "mailcow: MAILCOW_HOSTNAME in mailcow.conf is not a host name with a subdomain; update.sh would stop to ask: update mailcow by hand"
    return 1
  fi
  branch=$(git -C "$dir" symbolic-ref -q --short HEAD) || branch=''
  case $branch in
    master) ;;
    '')
      # A clone's master is origin/master (a clone checked out at a tag): moving it loses nothing.
      # Commits of its own that neither HEAD nor origin/master hold would be lost: not touched.
      if git -C "$dir" rev-parse -q --verify refs/heads/master >/dev/null &&
        ! git -C "$dir" merge-base --is-ancestor refs/heads/master HEAD &&
        ! git -C "$dir" merge-base --is-ancestor refs/heads/master refs/remotes/origin/master; then
        warn "mailcow: $dir is detached and its branch master holds commits of its own: update mailcow by hand"
        return 1
      fi
      log "mailcow: $dir is detached at ${base:0:12}; the branch master now points there (no file changes)"
      with_error git -C "$dir" checkout --quiet -B master || {
        warn "mailcow: git checkout -B master failed${LAST_ERROR:+: $LAST_ERROR}"
        return 1
      }
      ;;
    *)
      warn "mailcow: $dir is on the branch $branch, not master: update mailcow by hand"
      return 1
      ;;
  esac
  with_error git -C "$dir" branch --quiet --set-upstream-to=origin/master master || {
    warn "mailcow: could not make master track origin/master${LAST_ERROR:+: $LAST_ERROR}"
    return 1
  }

  # The tracked files update.sh commits before its merge ("Before update on ..."): names only.
  changed=$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null | cut -c4- | head -n 20 | paste -sd' ' -) || changed=''
  if [ -n "$changed" ]; then log "mailcow: local changes update.sh commits before its merge: $changed"; fi

  started=$(date -u +%H:%M:%S)
  log "mailcow: update.sh to $tag; mail is not accepted from its stop until the start below (EOP queues it and retries)"
  mailcow_update_sh "$dir" || {
    warn "mailcow: update.sh failed (exit $?); its output is above in this log"
    return 1
  }
  log "mailcow: setup.sh again (mailcow.conf: our settings back)"
  run_setup "$(mailcow_budget "$SETUP_TIMEOUT")" || {
    warn "mailcow: setup.sh after update.sh failed (exit $?); its output is above in this log"
    return 1
  }
  # The output of `up` goes to the log as it is; on a failure the warning names its last error
  # line and the containers that do not run or are unhealthy.
  output=$(mktemp)
  rc=0
  (cd "$dir" && run_group "$(mailcow_budget "$CHECK_TIMEOUT")" docker compose up -d --remove-orphans) >"$output" 2>&1 || rc=$?
  cat "$output"
  if [ "$rc" != 0 ]; then
    problem=$(compose_error <"$output")
    rm -f "$output"
    bad=$(mailcow_containers | bad_containers) || bad=''
    warn "mailcow: docker compose up -d failed (exit $rc): ${problem:-no output}${bad:+; not running or unhealthy: $bad}; next: docker compose logs --tail 50 <service> in $dir"
    return 1
  fi
  rm -f "$output"
  stopped=$(date -u +%H:%M:%S)
  log "mailcow: stopped and started again within $started-$stopped UTC (update.sh stops it after fetching the images)"
  limit=$(mailcow_budget "$MAILCOW_HEALTH_WAIT")
  problem=$(mailcow_wait_healthy "$limit") || {
    warn "mailcow: containers not healthy after ${limit}s: $problem; next: docker compose ps and docker compose logs --tail 50 <service> in $dir"
    return 1
  }
  base=$(mailcow_base "$dir") || base=''
  relation=$(mailcow_relation "$dir" "$base" "$pin")
  if [ "$relation" = newer ]; then
    warn "mailcow_past_pin: update.sh took mailcow to ${base:0:12}, past $tag: mailcow released a newer version while it ran, not tested with this release"
    return 3
  fi
  if [ "$relation" != match ]; then
    warn "mailcow: after update.sh it is at ${base:0:12}, not $tag (${pin:0:12})"
    return 1
  fi
  log "mailcow updated to $tag"
}

# mailcow_ipv6_off: mailcow.conf says ENABLE_IPV6=false (decision D-13).
mailcow_ipv6_off() {
  [ "$(env_get "$(mailcow_dir)/mailcow.conf" ENABLE_IPV6 2>/dev/null)" = false ]
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
  local sha=${2:-} problem checks_problem='' rc error
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
    finish failed "git fetch in $SRC failed: $(last_output "$UPDATE_LOG"); the node is unchanged" fetch_failed
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
    finish failed "git checkout ${sha:0:12} failed: $(last_output "$UPDATE_LOG"); the node is unchanged" checkout_failed
  if ! run_step "setup.sh at ${sha:0:12}" run_setup; then
    problem=$(last_step "$UPDATE_LOG")
    if checkout "$PREVIOUS" >>"$UPDATE_LOG" 2>&1 && run_step "rollback: setup.sh at ${PREVIOUS:0:12}" run_setup; then
      send_status || true
      finish failed "setup.sh failed ($problem); rolled back to ${PREVIOUS:0:12}" rolled_back
    fi
    send_status || true
    finish failed "setup.sh failed ($problem) and so did the rollback to ${PREVIOUS:0:12}: see $UPDATE_LOG" rollback_failed
  fi

  rc=0
  run_step --timeout "$MAILCOW_TIMEOUT" "mailcow: the version the release pins" mailcow_update_if_pinned || rc=$?
  if [ "$rc" != 0 ]; then
    problem=$(last_step "$UPDATE_LOG")
    error=mailcow_update_failed
    if [ "$rc" = 3 ]; then error=mailcow_past_pin; fi
    # update.sh may have left its own mailcow.conf (ENABLE_IPV6=true, D-13): ours back before the start.
    run_step "mailcow: setup.sh after the failed update" run_setup || true
    mailcow_ipv6_off || warn "mailcow.conf has ENABLE_IPV6 other than false after setup.sh: mailcow listens on IPv6 past the firewall (D-13); run setup.sh by hand"
    run_step --timeout "$CHECK_TIMEOUT" "mailcow: docker compose up -d after the failed update" mailcow_up || true
    checks_problem=$(post_checks) || true
    send_status || true
    finish failed "mailcow's update failed ($problem)${checks_problem:+; $checks_problem}; the scripts are at ${sha:0:12}" "$error"
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
