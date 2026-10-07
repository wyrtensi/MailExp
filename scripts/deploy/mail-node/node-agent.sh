#!/usr/bin/env bash
# The mail node agent (docs/operations/mail-node.md, section 7a): a service on the node host that
# takes jobs from the panel. It calls the panel over HTTPS (no port opens on the node, nothing goes
# into mailcow's nginx): GET <PANEL_URL>/api/node-agent/next waits up to 50 seconds for a job; the
# agent runs it and reports to POST /api/node-agent/jobs/<id> its state, step and the end of its
# output. It runs only the kinds below, whatever the panel sends:
#   status   the node's status report (POST /api/node-agent/status): the commit of the node scripts,
#            mailcow's version, its containers, and node-backup.sh --status (the last backup and
#            whether it is too old);
#   backup   node-backup.sh --tag manual (the panel's "Back up mail now"), bounded by
#            NODE_AGENT_BACKUP_TIMEOUT seconds (6 hours); a status report follows.
#   update   the node's scripts to the commit the panel runs (params.sha, 40 hex digits): run by
#            node-update.sh (see there), detached from the agent, because setup.sh restarts the
#            agent when its files change. The agent copies node-update.sh and its libraries to
#            $NODE_STATE/update-run-<job id>/ and starts it as the transient systemd unit
#            mailexpert-node-update-<job id> (systemd-run), or with setsid nohup on a host without
#            systemd; neither is stopped with the agent. The update reports to the panel itself
#            and keeps its state in $NODE_STATE/update-<job id>.json. While that file says the
#            update runs and its process lives, the agent does not poll (the panel would take the
#            agent's poll for a restart and fail the job it still runs) and sends no status report;
#            it waits. An update whose process died is reported failed (update_interrupted, with
#            the commit to go back to by hand); a final state the update could not deliver (the
#            panel down) is delivered by the agent, which polls again only once the panel took
#            it (until then it backs off as after any error).
# Any other kind is reported failed. A status report goes out at the start and every 10 minutes.
# Errors (the panel down, a refused token) back off up to 5 minutes.
#
# /etc/mailexpert-node/agent.env (0600, written by setup.sh --panel-url --agent-token-file):
#   PANEL_URL=https://<PANEL_HOST>   AGENT_TOKEN=<token>
#   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET   optional: a Cloudflare Access service token, sent
#                                                  as CF-Access-Client-Id / CF-Access-Client-Secret
# The token and the Access secret go to curl in a 0600 config file, never on its command line, and
# are never printed. TLS is verified; only https is used.
#
# Usage: node-agent.sh [--once]
#   --once  one round (a status report when due, one poll, the job it brought) and exit
# node-update.sh sources this file for its functions: main runs only when it is executed.
# Run by the systemd unit mailexpert-node-agent (Restart=always), or on a host without systemd by
# cron every minute under flock (a running agent keeps the lock).
# Exit codes: 0 done (--once), 1 a failure, 2 invalid configuration.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Installed by setup.sh next to the shared libraries, or run from a checkout of the repository.
if [ -f "$SCRIPT_DIR/common.sh" ]; then LIB_DIR=$SCRIPT_DIR; else LIB_DIR=$SCRIPT_DIR/../lib; fi
# shellcheck source=../lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=../lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

AGENT_CONF=${MAILEXPERT_NODE_AGENT_CONF:-$(dirname "$NODE_CONF")/agent.env}
POLL_WAIT=${MAILEXPERT_NODE_AGENT_POLL_WAIT:-50}
STATUS_EVERY=${MAILEXPERT_NODE_AGENT_STATUS_EVERY:-600}
PROGRESS_EVERY=${MAILEXPERT_NODE_AGENT_PROGRESS_EVERY:-15}
# How long a round waits while an update runs, instead of polling.
UPDATE_WAIT=${MAILEXPERT_NODE_AGENT_UPDATE_WAIT:-15}
# A state file the update has not put its process id in yet is taken as starting this long.
UPDATE_START_GRACE=120
# The variables that move the node's paths (the tests): handed to an update started by systemd-run,
# whose unit does not inherit the agent's environment.
UPDATE_ENV_VARS=(MAILEXPERT_NODE_CONF MAILEXPERT_NODE_STATE MAILEXPERT_NODE_DIR MAILEXPERT_NODE_AGENT_CONF
  MAILEXPERT_NODE_SRC MAILEXPERT_NODE_INIT MAILEXPERT_NODE_AGENT_PROGRESS_EVERY)
BACKUP_TIMEOUT_DEFAULT=21600
MAX_BACKOFF=300
# The end of a job's output sent to the panel (the panel keeps 8000 characters).
LOG_LINES=40
LOG_BYTES=7000
WORK=''
PANEL_URL=''
LAST_STATUS=0
BACKOFF=0
# The job being run and its backup process, for the stop handler.
CURRENT_JOB=''
CURRENT_PID=''

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# shellcheck disable=SC2317,SC2329 # invoked only through the EXIT trap
cleanup() {
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}

# shellcheck disable=SC2317,SC2329 # invoked only through the TERM and INT traps
# on_stop: the agent is stopped (systemd, a reboot, setup.sh restarting it): the backup it runs is
# stopped and its job reported failed, if the panel answers. The panel also fails a job left
# running at the agent's next poll.
on_stop() {
  trap - TERM INT
  if [ -n "$CURRENT_PID" ]; then kill "$CURRENT_PID" 2>/dev/null || true; fi
  if [ -n "$CURRENT_JOB" ]; then
    report "$CURRENT_JOB" failed "the agent was stopped" '' agent_stopped || true
  fi
  exit 143
}

# load_conf: agent.env checked and turned into curl's config file (the headers with the secrets).
load_conf() {
  local token id='' secret=''
  [ -f "$AGENT_CONF" ] || die "$AGENT_CONF not found: connect the agent with setup.sh --panel-url <URL> --agent-token-file <file>" 2
  PANEL_URL=$(env_get "$AGENT_CONF" PANEL_URL) || die "$AGENT_CONF: PANEL_URL is missing" 2
  PANEL_URL=${PANEL_URL%/}
  is_panel_url "$PANEL_URL" || die "$AGENT_CONF: PANEL_URL must be https://<host>[:port]" 2
  token=$(env_get "$AGENT_CONF" AGENT_TOKEN) || die "$AGENT_CONF: AGENT_TOKEN is missing" 2
  is_agent_token "$token" || die "$AGENT_CONF: AGENT_TOKEN is not a node agent token" 2
  id=$(env_get "$AGENT_CONF" CF_ACCESS_CLIENT_ID 2>/dev/null) || id=''
  secret=$(env_get "$AGENT_CONF" CF_ACCESS_CLIENT_SECRET 2>/dev/null) || secret=''
  if { [ -n "$id" ] && [ -z "$secret" ]; } || { [ -z "$id" ] && [ -n "$secret" ]; }; then
    die "$AGENT_CONF: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET go together" 2
  fi
  {
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    if [ -n "$id" ]; then
      printf 'header = "CF-Access-Client-Id: %s"\n' "$id"
      printf 'header = "CF-Access-Client-Secret: %s"\n' "$secret"
    fi
  } >"$WORK/auth.conf"
  chmod 600 "$WORK/auth.conf"
}

# panel <method> <path> <body file or ''> <output file> <max seconds>: one call to the panel; prints
# the HTTP status (000 when there was no answer).
panel() {
  local method=$1 path=$2 body=$3 out=$4 max=$5 conf=$WORK/call.conf
  {
    cat "$WORK/auth.conf"
    printf 'url = "%s%s"\n' "$PANEL_URL" "$path"
    printf 'request = "%s"\n' "$method"
    if [ -n "$body" ]; then printf 'header = "Content-Type: application/json"\n'; fi
  } >"$conf"
  local -a args=(-sS --proto '=https' --max-time "$max" -K "$conf" -o "$out" -w '%{http_code}')
  local code
  if [ -n "$body" ]; then args+=(--data-binary "@$body"); fi
  code=$(curl "${args[@]}" 2>/dev/null) || code=000
  printf '%s' "$code"
}

# post_json <path> <json file>: status 0 on a 2xx answer.
post_json() {
  local code
  code=$(panel POST "$1" "$2" "$WORK/post.out" 30)
  case $code in
    2??) return 0 ;;
    *) warn "POST $1: HTTP $code"; return 1 ;;
  esac
}

# --- The status report --------------------------------------------------------------------------

scripts_commit() {
  local file=$NODE_DIR/scripts-commit
  if [ -s "$file" ]; then head -n 1 "$file"; else echo unknown; fi
}

mailcow_dir() { env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null || echo /opt/mailcow-dockerized; }

mailcow_version() { git -C "$(mailcow_dir)" describe --tags --always 2>/dev/null || echo unknown; }

# mailcow_containers: one line per container of mailcow's compose project: service, state, health.
mailcow_containers() {
  (cd "$(mailcow_dir)" && docker compose ps -a --format $'{{.Service}}\t{{.State}}\t{{.Health}}') 2>/dev/null
}

# containers_json: {total, running, problems: ["service: state"]} from mailcow_containers.
containers_json() {
  local lines
  lines=$(mailcow_containers) || lines=''
  printf '%s\n' "$lines" | jq -R -s -c '
    [split("\n")[] | select(length > 0) | split("\t") | {service: .[0], state: (.[1] // ""), health: (.[2] // "")}]
    | {total: length,
       running: ([.[] | select(.state == "running" and .health != "unhealthy")] | length),
       problems: [.[] | select(.state != "running" or .health == "unhealthy")
                  | "\(.service): \(if .health == "unhealthy" then "unhealthy" else .state end)"]}'
}

# backup_json: node-backup.sh --status: its JSON (the last backup), whether it passed, and its
# problem line (the age check).
backup_json() {
  local last ok=false problem='' configured=false rc=0
  if env_get "$NODE_CONF" RESTIC_REPOSITORY >/dev/null 2>&1; then configured=true; fi
  last=$("$NODE_DIR/node-backup.sh" --status 2>"$WORK/backup-status.err") || rc=$?
  if [ "$rc" = 0 ]; then ok=true; fi
  problem=$(grep -v '^\[mailexpert\] no successful backup' "$WORK/backup-status.err" | tail -n 1 | sed 's/^\[mailexpert\] \(error: \)\{0,1\}//') || problem=''
  printf '%s' "$last" | jq -c . >/dev/null 2>&1 || last='null'
  [ -n "$last" ] || last='null'
  jq -cn --argjson configured "$configured" --argjson ok "$ok" --arg problem "$problem" --argjson last "$last" \
    '{configured: $configured, ok: $ok, problem: (if $problem == "" then null else $problem end), last: $last}'
}

# send_status: the status report, built and posted.
send_status() {
  local file=$WORK/status.json
  jq -cn --arg commit "$(scripts_commit)" --arg mailcow "$(mailcow_version)" \
    --argjson containers "$(containers_json)" --argjson backup "$(backup_json)" \
    '{scriptsCommit: $commit, mailcowVersion: $mailcow, containers: $containers, backup: $backup}' >"$file"
  post_json /api/node-agent/status "$file"
}

# --- Jobs ---------------------------------------------------------------------------------------

is_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }
is_job_id() { [[ $1 =~ ^[0-9]{1,18}$ ]]; }
update_state_file() { printf '%s/update-%s.json\n' "$NODE_STATE" "$1"; }
update_run_dir() { printf '%s/update-run-%s\n' "$NODE_STATE" "$1"; }
update_log_file() { printf '%s/update-%s.log\n' "$NODE_STATE" "$1"; }

# write_update_state <job id> <state> <step> [<error>] [<pid>] [<previous commit>]: the update's
# state file, replaced whole (written next to it, then moved), so a reader never sees half of it.
write_update_state() {
  local file tmp
  file=$(update_state_file "$1")
  tmp=$file.tmp
  install -d "$NODE_STATE"
  jq -cn --arg id "$1" --arg state "$2" --arg step "$3" --arg error "${4:-}" --arg pid "${5:-}" --arg previous "${6:-}" \
    '{id: $id, state: $state, step: $step, error: (if $error == "" then null else $error end),
      pid: (if $pid == "" then null else ($pid | tonumber) end),
      previous: (if $previous == "" then null else $previous end)}' >"$tmp"
  mv -f "$tmp" "$file"
}

# update_alive <state file>: the update's process still runs (or it is starting).
update_alive() {
  local file=$1 pid age
  pid=$(jq -r '.pid // empty' "$file" 2>/dev/null) || pid=''
  if [ -z "$pid" ]; then
    age=$(($(date +%s) - $(stat -c %Y "$file" 2>/dev/null || echo 0)))
    [ "$age" -lt "$UPDATE_START_GRACE" ]
    return
  fi
  [[ $pid =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # The process id may have been reused by now: it must still be the update.
  if [ -r "/proc/$pid/cmdline" ]; then tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'node-update.sh'; fi
}

# deliver_update_state <state file>: a final state the update left undelivered, or the failure of
# an update whose process died, reported to the panel; the files go once the panel took it (or
# answered that the job is no longer running there).
deliver_update_state() {
  local file=$1 id state step error previous code body=$WORK/update-report.json tail=''
  id=$(jq -r '.id // empty' "$file" 2>/dev/null) || id=''
  if ! is_job_id "$id"; then rm -f "$file"; return 0; fi
  state=$(jq -r '.state // empty' "$file")
  step=$(jq -r '.step // ""' "$file")
  error=$(jq -r '.error // ""' "$file")
  previous=$(jq -r '.previous // ""' "$file")
  is_sha "$previous" || previous=''
  case $state in
    succeeded | failed) ;;
    *)
      state=failed error=update_interrupted
      step="the update stopped${previous:+ (it started from $previous: git checkout of it and setup.sh go back by hand)} at: $step"
      ;;
  esac
  if [ -f "$(update_log_file "$id")" ]; then tail=$(tail -n "$LOG_LINES" "$(update_log_file "$id")" | tail -c "$LOG_BYTES"); fi
  jq -cn --arg state "$state" --arg step "${step:0:200}" --arg log "$tail" --arg error "$error" \
    '{state: $state, step: $step} + (if $log == "" then {} else {log: $log} end)
     + (if $error == "" then {} else {error: $error} end)' >"$body"
  code=$(panel POST "/api/node-agent/jobs/$id" "$body" "$WORK/post.out" 30)
  case $code in
    2?? | 404 | 409)
      rm -f "$file"
      rm -rf "$(update_run_dir "$id")"
      log "job $id: update $state delivered to the panel"
      ;;
    *) warn "job $id: the update's result was not delivered (HTTP $code); tried again next round"; return 1 ;;
  esac
}

# update_pending: 0 nothing pending (the agent may poll); 1 an update runs (the agent waits); 2 an
# update ended and the panel did not take its result yet (the agent backs off and tries again).
# Delivers what ended updates left behind.
update_pending() {
  local file pending=0
  for file in "$NODE_STATE"/update-*.json; do
    [ -f "$file" ] || continue
    case $(jq -r '.state // empty' "$file" 2>/dev/null) in
      succeeded | failed) ;;
      *)
        if update_alive "$file"; then pending=1 && continue; fi
        ;;
    esac
    if ! deliver_update_state "$file" && [ "$pending" = 0 ]; then pending=2; fi
  done
  return "$pending"
}

# detach_mode: systemd (a transient unit) when systemd runs the host, setsid otherwise.
detach_mode() {
  case ${MAILEXPERT_NODE_INIT:-} in
    systemd) echo systemd ;;
    cron) echo setsid ;;
    *) if command -v systemd-run >/dev/null && [ -d /run/systemd/system ]; then echo systemd; else echo setsid; fi ;;
  esac
}

# start_update <job id> <sha>: node-update.sh started detached from the agent, from a copy that
# setup.sh cannot replace under it (it installs new versions of the same files).
start_update() {
  local id=$1 sha=$2 dir file var
  local -a env_args=()
  dir=$(update_run_dir "$id")
  if [ ! -f "$NODE_DIR/node-update.sh" ]; then
    report "$id" failed "node-update.sh is not installed: run setup.sh on the node" '' update_not_installed || true
    return 0
  fi
  rm -rf "$dir"
  install -d -m 700 "$dir"
  for file in node-update.sh node-agent.sh lib.sh common.sh env.sh; do
    if ! cp "$NODE_DIR/$file" "$dir/$file" 2>/dev/null; then
      rm -rf "$dir"
      report "$id" failed "$file is missing in $NODE_DIR: run setup.sh on the node" '' update_not_installed || true
      return 0
    fi
  done
  write_update_state "$id" starting "starting the update"
  report "$id" running "starting the update to ${sha:0:12}" || true
  if [ "$(detach_mode)" = systemd ]; then
    for var in "${UPDATE_ENV_VARS[@]}"; do
      if [ -n "${!var:-}" ]; then env_args+=("--setenv=$var=${!var}"); fi
    done
    if ! systemd-run --quiet --collect --unit="mailexpert-node-update-$id" "${env_args[@]}" \
      /bin/bash "$dir/node-update.sh" "$id" "$sha" >/dev/null 2>&1; then
      rm -f "$(update_state_file "$id")"
      rm -rf "$dir"
      report "$id" failed "systemd-run could not start the update" '' update_not_started || true
      return 0
    fi
  else
    setsid nohup /bin/bash "$dir/node-update.sh" "$id" "$sha" </dev/null >/dev/null 2>&1 &
  fi
  log "job $id: update to ${sha:0:12} started ($(detach_mode))"
}

# report <job id> <state> <step> [<log file>] [<error>]
report() {
  local id=$1 state=$2 step=$3 log=${4:-} error=${5:-} tail='' file=$WORK/report.json
  if [ -n "$log" ] && [ -f "$log" ]; then tail=$(tail -n "$LOG_LINES" "$log" | tail -c "$LOG_BYTES"); fi
  jq -cn --arg state "$state" --arg step "$step" --arg log "$tail" --arg error "$error" \
    '{state: $state, step: $step} + (if $log == "" then {} else {log: $log} end)
     + (if $error == "" then {} else {error: $error} end)' >"$file"
  post_json "/api/node-agent/jobs/$id" "$file"
}

# last_step <log file>: the node script's last message, for the step the panel shows.
last_step() {
  local line
  line=$(grep '^\[mailexpert\]' "$1" 2>/dev/null | tail -n 1) || line=''
  line=${line#\[mailexpert\] }
  printf '%s' "${line:0:180}"
}

backup_timeout() {
  local value
  value=$(env_get "$AGENT_CONF" NODE_AGENT_BACKUP_TIMEOUT 2>/dev/null) || value=''
  if [[ $value =~ ^[0-9]+$ ]] && [ "$value" -gt 0 ]; then echo "$value"; else echo "$BACKUP_TIMEOUT_DEFAULT"; fi
}

# run_backup <job id> <tag>: node-backup.sh with the job's tag, its output followed and reported.
run_backup() {
  local id=$1 tag=$2 log=$WORK/backup.log pid rc=0 waited=0
  case $tag in
    manual) ;;
    *) report "$id" failed "backup tag not allowed: $tag" '' tag_not_allowed || true; return 0 ;;
  esac
  : >"$log"
  report "$id" running "node-backup.sh --tag $tag" || true
  log "job $id: backup (--tag $tag) started"
  timeout -k 60 "$(backup_timeout)" "$NODE_DIR/node-backup.sh" --tag "$tag" >"$log" 2>&1 &
  pid=$!
  CURRENT_PID=$pid
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$PROGRESS_EVERY" ]; then
      waited=0
      report "$id" running "$(last_step "$log")" "$log" || true
    fi
  done
  wait "$pid" || rc=$?
  CURRENT_PID=''
  if [ "$rc" = 0 ]; then
    report "$id" succeeded "$(last_step "$log")" "$log" || true
    log "job $id: backup done"
  else
    report "$id" failed "$(last_step "$log")" "$log" "exit_$rc" || true
    warn "job $id: backup failed (exit $rc)"
  fi
  send_status || true
  LAST_STATUS=$(date +%s)
}

# run_job <job json file>: the job the poll brought, if its kind is one the agent runs.
run_job() {
  local file=$1 id kind tag sha
  id=$(jq -r '.id // empty' "$file" 2>/dev/null) || id=''
  if ! [[ $id =~ ^[0-9]{1,18}$ ]]; then
    warn "the panel sent a job without a valid id; ignored"
    return 0
  fi
  kind=$(jq -r '.kind // empty' "$file" 2>/dev/null) || kind=''
  CURRENT_JOB=$id
  case $kind in
    status)
      if send_status; then
        report "$id" succeeded "status sent" || true
      else
        report "$id" failed "the status report was refused" '' status_failed || true
      fi
      LAST_STATUS=$(date +%s)
      ;;
    backup)
      tag=$(jq -r '.params.tag // "manual"' "$file")
      run_backup "$id" "$tag"
      ;;
    update)
      sha=$(jq -r '.params.sha // empty' "$file" 2>/dev/null) || sha=''
      if is_sha "$sha"; then
        start_update "$id" "$sha"
      else
        report "$id" failed "the update's commit is not 40 hex digits" '' sha_invalid || true
      fi
      ;;
    *)
      warn "job $id: unknown kind; reported failed"
      report "$id" failed "unknown job kind" '' unknown_kind || true
      ;;
  esac
  CURRENT_JOB=''
}

# backoff: waits after an error, twice as long each time up to MAX_BACKOFF.
backoff() {
  if [ "$BACKOFF" -lt 5 ]; then BACKOFF=5; else BACKOFF=$((BACKOFF * 2)); fi
  if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then BACKOFF=$MAX_BACKOFF; fi
  sleep "$BACKOFF"
}

# round: a status report when due, one poll, and the job it brought. Status 1 after an error.
round() {
  local now code out=$WORK/next.json
  # The update runs on its own and reports itself: no poll meanwhile, nor before its result is
  # delivered (see the header).
  local pending=0
  update_pending || pending=$?
  case $pending in
    1) sleep "$UPDATE_WAIT"; return 0 ;;
    2) return 1 ;;
  esac
  now=$(date +%s)
  if [ $((now - LAST_STATUS)) -ge "$STATUS_EVERY" ]; then
    # A refused report is tried again next round; the poll goes on regardless.
    if send_status; then LAST_STATUS=$now; fi
  fi
  code=$(panel GET "/api/node-agent/next?wait=$POLL_WAIT" '' "$out" $((POLL_WAIT + 15)))
  case $code in
    200) run_job "$out" ;;
    204) ;;
    401 | 403) warn "the panel refused the agent's token (HTTP $code): issue a new one in the panel and run setup.sh --agent-token-file"; return 1 ;;
    *) warn "GET /api/node-agent/next: HTTP $code"; return 1 ;;
  esac
}

main() {
  local once=0
  while [ $# -gt 0 ]; do
    case $1 in
      --once) once=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  command -v curl >/dev/null || die "curl is required" 1
  command -v jq >/dev/null || die "jq is required" 1
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap on_stop TERM INT
  load_conf
  if [ "$once" = 1 ]; then
    # In a condition, so a failure inside the round is reported here, not by set -e mid-way.
    if round; then return 0; else return 1; fi
  fi
  log "agent started: $PANEL_URL"
  while :; do
    if round; then BACKOFF=0; else backoff; fi
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
