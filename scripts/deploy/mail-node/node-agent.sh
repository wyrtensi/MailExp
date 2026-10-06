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
BACKUP_TIMEOUT_DEFAULT=21600
MAX_BACKOFF=300
# The end of a job's output sent to the panel (the panel keeps 8000 characters).
LOG_LINES=40
LOG_BYTES=7000
WORK=''
PANEL_URL=''
LAST_STATUS=0
BACKOFF=0

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# shellcheck disable=SC2317,SC2329 # invoked only through the EXIT trap
cleanup() {
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
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
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$PROGRESS_EVERY" ]; then
      waited=0
      report "$id" running "$(last_step "$log")" "$log" || true
    fi
  done
  wait "$pid" || rc=$?
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
  local file=$1 id kind tag
  id=$(jq -r '.id // empty' "$file" 2>/dev/null) || id=''
  if ! [[ $id =~ ^[0-9]{1,18}$ ]]; then
    warn "the panel sent a job without a valid id; ignored"
    return 0
  fi
  kind=$(jq -r '.kind // empty' "$file")
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
    *)
      warn "job $id: unknown kind; reported failed"
      report "$id" failed "unknown job kind" '' unknown_kind || true
      ;;
  esac
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
  now=$(date +%s)
  if [ $((now - LAST_STATUS)) -ge "$STATUS_EVERY" ]; then
    if send_status; then LAST_STATUS=$now; else return 1; fi
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
  load_conf
  if [ "$once" = 1 ]; then
    round
    return
  fi
  log "agent started: $PANEL_URL"
  while :; do
    if round; then BACKOFF=0; else backoff; fi
  done
}

main "$@"
