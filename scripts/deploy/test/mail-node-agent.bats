#!/usr/bin/env bats
# The mail node agent: node-agent.sh against a curl mock that plays the panel (the token only in
# curl's config file, the status report, the jobs it runs and refuses, the backoff) and setup.sh's
# --panel-url and --agent-token-file (agent.env 0600, the token never printed, the unit or the cron
# line, a second run that restarts nothing).

bats_require_minimum_version 1.5.0

TOKEN=mxna_TestTokenTestTokenTestTokenTestToken123
CF_SECRET=cf-secret-0123456789abcdef

setup() {
  load helper
  load mail-node/helper
  mail_node_setup
  AGENT=$NODE_SCRIPTS/node-agent.sh
  export MAILEXPERT_NODE_AGENT_CONF=$BATS_TEST_TMPDIR/etc/agent.env
  export MAILEXPERT_AGENT_CRON_FILE=$BATS_TEST_TMPDIR/cron.d/mailexpert-node-agent
  export MAILEXPERT_NODE_AGENT_LOG=$BATS_TEST_TMPDIR/node-agent.log
  export MAILEXPERT_AGENT_LOGROTATE_FILE=$BATS_TEST_TMPDIR/logrotate.d/mailexpert-node-agent
  export MAILEXPERT_NODE_AGENT_PROGRESS_EVERY=1
  export MOCK_GIT_HEAD=0123456789abcdef0123456789abcdef01234567
  # The agent's own mocks first: curl as the panel, docker's container list, node-backup.sh.
  local bin=$BATS_TEST_TMPDIR/agent-bin
  export MOCK_SHARED_BIN=$BATS_TEST_TMPDIR/bin
  mkdir -p "$bin" "$MAILEXPERT_NODE_DIR" "$(dirname "$MAILEXPERT_NODE_AGENT_CONF")"
  cat >"$bin/curl" <<'EOF'
#!/usr/bin/env bash
# The panel for node-agent.sh: the URL, method and headers come in the config file (-K). Any other
# URL (the Microsoft endpoints setup.sh's eop-ranges.sh reads) goes to the shared curl mock.
# eop-ranges.sh hands its config on a descriptor, read once: it is copied to a file first.
orig=("$@")
out='' conf='' body=''
for ((i = 0; i < $#; i++)); do
  if [ "${orig[$i]}" = -K ]; then
    conf=$MOCK_DIR/curl-conf.$$
    cat "${orig[$((i + 1))]}" >"$conf"
    orig[$((i + 1))]=$conf
  fi
done
if ! grep -q '^url = "https://panel.example.com/' "$conf" 2>/dev/null; then exec "$MOCK_SHARED_BIN/curl" "${orig[@]}"; fi
printf '%s\n' "$*" >>"$MOCK_DIR/agent-argv"
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2 && shift ;;
    -K) shift ;;
    --data-binary) body=${2#@} && shift ;;
    -w | --max-time | --proto) shift ;;
  esac
  shift
done
cat "$conf" >>"$MOCK_DIR/agent-conf"
url=$(sed -n 's/^url = "\(.*\)"$/\1/p' "$conf")
method=$(sed -n 's/^request = "\(.*\)"$/\1/p' "$conf")
printf '%s %s %s\n' "$method" "${url#https://panel.example.com}" "$([ -n "$body" ] && cat "$body")" >>"$MOCK_DIR/agent-requests"
[ "${MOCK_PANEL_DOWN:-0}" = 1 ] && exit 7
case $url in
  */api/node-agent/next*)
    if [ -n "${MOCK_NEXT_STATUS:-}" ]; then printf '{}' >"$out"; printf '%s' "$MOCK_NEXT_STATUS"; exit 0; fi
    if [ -f "$MOCK_DIR/next.json" ]; then mv "$MOCK_DIR/next.json" "$out"; printf 200; else : >"$out"; printf 204; fi
    ;;
  *) printf '{"ok":true}' >"$out"; printf '%s' "${MOCK_POST_STATUS:-200}" ;;
esac
EOF
  cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "compose ps -a --format"*) printf '%b' "${MOCK_CONTAINERS:-postfix-mailcow\trunning\t\ndovecot-mailcow\trunning\thealthy\n}" ;;
  *) exec "$MOCK_SHARED_BIN/docker" "$@" ;;
esac
EOF
  cat >"$MAILEXPERT_NODE_DIR/node-backup.sh" <<'EOF'
#!/usr/bin/env bash
printf 'node-backup.sh %s\n' "$*" >>"$MOCK_DIR/backup-calls"
if [ "$1" = --status ]; then
  if [ -f "$MOCK_DIR/backup-last.json" ]; then cat "$MOCK_DIR/backup-last.json"; fi
  if [ -n "${MOCK_BACKUP_PROBLEM:-}" ]; then printf '[mailexpert] %s\n' "$MOCK_BACKUP_PROBLEM" >&2; exit 1; fi
  exit 0
fi
printf '[mailexpert] dump: mailcow backup_and_restore.sh\n'
sleep "${MOCK_BACKUP_SECONDS:-0}"
printf '[mailexpert] restic: 5 GB processed\n'
if [ "${MOCK_BACKUP_RC:-0}" != 0 ]; then printf '[mailexpert] error: restic backup failed\n'; fi
exit "${MOCK_BACKUP_RC:-0}"
EOF
  chmod +x "$bin"/* "$MAILEXPERT_NODE_DIR/node-backup.sh"
  export PATH=$bin:$PATH
  write_node_env
}

write_agent_env() {
  printf 'PANEL_URL=https://panel.example.com\nAGENT_TOKEN=%s\n' "$TOKEN" >"$MAILEXPERT_NODE_AGENT_CONF"
  chmod 600 "$MAILEXPERT_NODE_AGENT_CONF"
}
queue_job() { printf '%s' "$1" >"$MOCK_DIR/next.json"; }
agent_requests() { cat "$MOCK_DIR/agent-requests" 2>/dev/null; }
job_reports() { agent_requests | grep "^POST /api/node-agent/jobs/$1 " | cut -d' ' -f3-; }

# --- node-agent.sh ------------------------------------------------------------------------------

@test "a round: the status report, then a poll; the token only in curl's config file" {
  write_agent_env
  printf '{"finished_epoch":1759632060,"finished_at":"2026-10-05T02:41:00Z","tag":"nightly","processed_bytes":5368709120}\n' >"$MOCK_DIR/backup-last.json"
  write_backup_keys
  export MOCK_CONTAINERS='postfix-mailcow\trunning\t\nclamd-mailcow\texited\t\nrspamd-mailcow\trunning\tunhealthy\n'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [[ $output != *"$TOKEN"* ]]
  [ "$(agent_requests | cut -d' ' -f1-2)" = $'POST /api/node-agent/status\nGET /api/node-agent/next?wait=50' ]
  # Never on the command line; with TLS verified and https only.
  lacks "$TOKEN" <"$MOCK_DIR/agent-argv"
  lacks '(^| )(-k|--insecure)( |$)' <"$MOCK_DIR/agent-argv"
  grep -q -- '--proto =https' "$MOCK_DIR/agent-argv"
  grep -qx "header = \"Authorization: Bearer $TOKEN\"" "$MOCK_DIR/agent-conf"
  lacks 'CF-Access' <"$MOCK_DIR/agent-conf"
  report=$(agent_requests | sed -n 's|^POST /api/node-agent/status ||p')
  [ "$(jq -r .scriptsCommit <<<"$report")" = unknown ]
  [ "$(jq -r .mailcowVersion <<<"$report")" = 2026-09 ]
  [ "$(jq -c .containers <<<"$report")" = '{"total":3,"running":1,"problems":["clamd-mailcow: exited","rspamd-mailcow: unhealthy"]}' ]
  [ "$(jq -c '.backup | {configured, ok, problem, tag: .last.tag}' <<<"$report")" = '{"configured":true,"ok":true,"problem":null,"tag":"nightly"}' ]
}

@test "the status report names the scripts commit and a backup that is too old" {
  write_agent_env
  printf '%s\n' "$MOCK_GIT_HEAD" >"$MAILEXPERT_NODE_DIR/scripts-commit"
  export MOCK_BACKUP_PROBLEM='the last node backup is 30 hours old'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  report=$(agent_requests | sed -n 's|^POST /api/node-agent/status ||p')
  [ "$(jq -r .scriptsCommit <<<"$report")" = "$MOCK_GIT_HEAD" ]
  [ "$(jq -c '.backup' <<<"$report")" = '{"configured":false,"ok":false,"problem":"the last node backup is 30 hours old","last":null}' ]
}

@test "the Cloudflare Access service token goes into the config file as headers" {
  write_agent_env
  printf 'CF_ACCESS_CLIENT_ID=abc123.access\nCF_ACCESS_CLIENT_SECRET=%s\n' "$CF_SECRET" >>"$MAILEXPERT_NODE_AGENT_CONF"
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  grep -qx 'header = "CF-Access-Client-Id: abc123.access"' "$MOCK_DIR/agent-conf"
  grep -qx "header = \"CF-Access-Client-Secret: $CF_SECRET\"" "$MOCK_DIR/agent-conf"
  lacks "$CF_SECRET" <"$MOCK_DIR/agent-argv"
  [[ $output != *"$CF_SECRET"* ]]
}

@test "a backup job runs node-backup.sh --tag manual, reports its progress and result, then the status" {
  write_agent_env
  queue_job '{"id":"7","kind":"backup","params":{"tag":"manual"}}'
  export MOCK_BACKUP_SECONDS=2
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(grep -c 'node-backup.sh --tag manual' "$MOCK_DIR/backup-calls")" -eq 1 ]
  [ "$(job_reports 7 | head -n 1 | jq -c .)" = '{"state":"running","step":"node-backup.sh --tag manual"}' ]
  job_reports 7 | sed -n '2p' | jq -e '.state == "running" and .step == "dump: mailcow backup_and_restore.sh"'
  last=$(job_reports 7 | tail -n 1)
  [ "$(jq -r .state <<<"$last")" = succeeded ]
  [ "$(jq -r .step <<<"$last")" = 'restic: 5 GB processed' ]
  [ "$(jq -r .log <<<"$last")" = $'[mailexpert] dump: mailcow backup_and_restore.sh\n[mailexpert] restic: 5 GB processed' ]
  # A status report after the backup, so the panel shows the new one.
  [ "$(agent_requests | tail -n 1 | cut -d' ' -f1-2)" = 'POST /api/node-agent/status' ]
}

@test "a failed backup is reported failed with its exit status and the end of its output" {
  write_agent_env
  queue_job '{"id":"8","kind":"backup","params":{"tag":"manual"}}'
  export MOCK_BACKUP_RC=1
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  last=$(job_reports 8 | tail -n 1)
  [ "$(jq -c '{state, error, step}' <<<"$last")" = '{"state":"failed","error":"exit_1","step":"error: restic backup failed"}' ]
}

@test "a backup tag other than manual and an unknown kind are refused, nothing runs" {
  write_agent_env
  queue_job '{"id":"9","kind":"backup","params":{"tag":"move"}}'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(job_reports 9 | jq -c '{state, error}')" = '{"state":"failed","error":"tag_not_allowed"}' ]
  [ ! -e "$MOCK_DIR/backup-calls" ] || lacks '--tag' <"$MOCK_DIR/backup-calls"
  queue_job '{"id":"10","kind":"update","params":{"sha":"abc"}}'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(job_reports 10 | jq -c '{state, step, error}')" = '{"state":"failed","step":"unknown job kind","error":"unknown_kind"}' ]
  queue_job '{"id":"x; rm -rf /","kind":"status"}'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [[ $output == *"without a valid id"* ]]
}

@test "a status job sends the report and succeeds" {
  write_agent_env
  queue_job '{"id":"11","kind":"status","params":{}}'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(agent_requests | grep -c '^POST /api/node-agent/status ')" -eq 2 ]
  [ "$(job_reports 11 | jq -r .state)" = succeeded ]
}

@test "a refused token or an unreachable panel fails the round, without the token in the message" {
  write_agent_env
  export MOCK_NEXT_STATUS=401
  run bash "$AGENT" --once
  [ "$status" -eq 1 ]
  [[ $output == *"refused the agent's token (HTTP 401)"* ]]
  [[ $output != *"$TOKEN"* ]]
  unset MOCK_NEXT_STATUS
  export MOCK_PANEL_DOWN=1
  run bash "$AGENT" --once
  [ "$status" -eq 1 ]
  [[ $output == *"HTTP 000"* ]]
}

@test "a missing or invalid agent.env stops the agent with exit 2" {
  run bash "$AGENT" --once
  [ "$status" -eq 2 ]
  [[ $output == *"agent.env not found"* ]]
  printf 'PANEL_URL=http://panel.example.com\nAGENT_TOKEN=%s\n' "$TOKEN" >"$MAILEXPERT_NODE_AGENT_CONF"
  run bash "$AGENT" --once
  [ "$status" -eq 2 ]
  [[ $output == *"must be https"* ]]
  printf 'PANEL_URL=https://panel.example.com\nAGENT_TOKEN=short\n' >"$MAILEXPERT_NODE_AGENT_CONF"
  run bash "$AGENT" --once
  [ "$status" -eq 2 ]
  printf 'PANEL_URL=https://panel.example.com\nAGENT_TOKEN=%s\nCF_ACCESS_CLIENT_ID=abc\n' "$TOKEN" >"$MAILEXPERT_NODE_AGENT_CONF"
  run bash "$AGENT" --once
  [ "$status" -eq 2 ]
  [[ $output == *"go together"* ]]
  [ ! -e "$MOCK_DIR/agent-requests" ]
}

# --- setup.sh -----------------------------------------------------------------------------------

setup_with_agent() {
  run bash "$NODE_SCRIPTS/setup.sh" --mailcow-dir "$MC" --panel-ip 203.0.113.10 "$@"
  # Shown by bats when the test fails.
  printf '%s\n' "$output"
}

@test "setup.sh connects the agent: agent.env 0600 from the token file, the unit, the token never printed" {
  printf '%s\n' "$TOKEN" >"$BATS_TEST_TMPDIR/token"
  setup_with_agent --panel-url https://Panel.Example.com/ --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 0 ]
  [[ $output != *"$TOKEN"* ]]
  [ "$(stat -c %a "$MAILEXPERT_NODE_AGENT_CONF")" = 600 ]
  [ "$(env_get "$MAILEXPERT_NODE_AGENT_CONF" PANEL_URL)" = https://panel.example.com ]
  [ "$(env_get "$MAILEXPERT_NODE_AGENT_CONF" AGENT_TOKEN)" = "$TOKEN" ]
  [ -x "$MAILEXPERT_NODE_DIR/node-agent.sh" ]
  [ "$(cat "$MAILEXPERT_NODE_DIR/scripts-commit")" = "$MOCK_GIT_HEAD" ]
  grep -qx "ExecStart=$MAILEXPERT_NODE_DIR/node-agent.sh" "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-agent.service"
  grep -qx 'Restart=always' "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-agent.service"
  calls | grep -qx 'systemctl enable --now mailexpert-node-agent.service'
  calls | grep -qx 'systemctl restart mailexpert-node-agent.service'
  # A second run with the stored values changes nothing and restarts nothing.
  : >"$MOCK_DIR/calls"
  setup_with_agent
  [ "$status" -eq 0 ]
  calls | lacks 'restart mailexpert-node-agent'
  calls | grep -qx 'systemctl enable --now mailexpert-node-agent.service'
  [ "$(env_get "$MAILEXPERT_NODE_AGENT_CONF" AGENT_TOKEN)" = "$TOKEN" ]
  # A new token (a rotation) restarts the agent with it; the Access keys come from the same file.
  printf 'AGENT_TOKEN=%s2\nCF_ACCESS_CLIENT_ID=abc123.access\nCF_ACCESS_CLIENT_SECRET=%s\n' "$TOKEN" "$CF_SECRET" >"$BATS_TEST_TMPDIR/token"
  : >"$MOCK_DIR/calls"
  setup_with_agent --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 0 ]
  [[ $output != *"$CF_SECRET"* ]]
  [ "$(env_get "$MAILEXPERT_NODE_AGENT_CONF" AGENT_TOKEN)" = "${TOKEN}2" ]
  [ "$(env_get "$MAILEXPERT_NODE_AGENT_CONF" CF_ACCESS_CLIENT_SECRET)" = "$CF_SECRET" ]
  calls | grep -qx 'systemctl restart mailexpert-node-agent.service'
}

@test "setup.sh without the agent's options leaves it off" {
  setup_with_agent
  [ "$status" -eq 0 ]
  [ ! -e "$MAILEXPERT_NODE_AGENT_CONF" ]
  [ ! -e "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-agent.service" ]
  calls | lacks 'node-agent'
}

@test "setup.sh refuses an incomplete or invalid agent setup before changing anything" {
  printf '%s\n' "$TOKEN" >"$BATS_TEST_TMPDIR/token"
  setup_with_agent --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 2 ]
  [[ $output == *"needs --panel-url"* ]]
  setup_with_agent --panel-url https://panel.example.com
  [ "$status" -eq 2 ]
  [[ $output == *"needs --agent-token-file"* ]]
  setup_with_agent --panel-url http://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 2 ]
  setup_with_agent --panel-url https://panel.example.com/path --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 2 ]
  printf 'not a token at all\n' >"$BATS_TEST_TMPDIR/bad"
  setup_with_agent --panel-url https://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/bad"
  [ "$status" -eq 2 ]
  [[ $output != *"not a token at all"* ]]
  printf 'AGENT_TOKEN=%s\nSOMETHING=else\n' "$TOKEN" >"$BATS_TEST_TMPDIR/bad"
  setup_with_agent --panel-url https://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/bad"
  [ "$status" -eq 2 ]
  [[ $output == *"unknown key SOMETHING"* ]]
  setup_with_agent --panel-url https://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/missing"
  [ "$status" -eq 2 ]
  [ ! -e "$MAILEXPERT_NODE_AGENT_CONF" ]
  [ ! -e "$MAILEXPERT_NODE_DIR/node-agent.sh" ]
}

@test "setup.sh --dry-run names agent.env's keys, never the token" {
  printf '%s\n' "$TOKEN" >"$BATS_TEST_TMPDIR/token"
  setup_with_agent --panel-url https://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/token" --dry-run
  [ "$status" -eq 0 ]
  [[ $output == *"would be written (keys: PANEL_URL AGENT_TOKEN)"* ]]
  [[ $output == *"node agent: systemd, calling https://panel.example.com"* ]]
  [[ $output != *"$TOKEN"* ]]
  [ ! -e "$MAILEXPERT_NODE_AGENT_CONF" ]
}

@test "without systemd the agent is a cron line under flock, with its log rotated" {
  export MAILEXPERT_NODE_INIT=cron
  printf '%s\n' "$TOKEN" >"$BATS_TEST_TMPDIR/token"
  setup_with_agent --panel-url https://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 0 ]
  grep -qx "\* \* \* \* \* root flock -n /run/mailexpert-node-agent.lock $MAILEXPERT_NODE_DIR/node-agent.sh >>$MAILEXPERT_NODE_AGENT_LOG 2>&1" "$MAILEXPERT_AGENT_CRON_FILE"
  grep -qx 'MAILTO=""' "$MAILEXPERT_AGENT_CRON_FILE"
  [ "$(stat -c %a "$MAILEXPERT_NODE_AGENT_LOG")" = 600 ]
  grep -qx "$MAILEXPERT_NODE_AGENT_LOG {" "$MAILEXPERT_AGENT_LOGROTATE_FILE"
  [ ! -e "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-agent.service" ]
}
