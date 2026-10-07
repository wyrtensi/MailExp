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
  queue_job '{"id":"10","kind":"reboot","params":{}}'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(job_reports 10 | jq -c '{state, step, error}')" = '{"state":"failed","step":"unknown job kind","error":"unknown_kind"}' ]
  queue_job '{"id":"x; rm -rf /","kind":"status"}'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [[ $output == *"without a valid id"* ]]
  queue_job 'not json at all'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [[ $output == *"without a valid id"* ]]
}

@test "a refused status report does not stop the poll" {
  write_agent_env
  export MOCK_POST_STATUS=500
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [[ $output == *"POST /api/node-agent/status: HTTP 500"* ]]
  [ "$(agent_requests | cut -d' ' -f1-2 | tail -n 1)" = 'GET /api/node-agent/next?wait=50' ]
}

@test "a stopped agent stops its backup and reports the job failed" {
  write_agent_env
  queue_job '{"id":"12","kind":"backup","params":{"tag":"manual"}}'
  export MOCK_BACKUP_SECONDS=10
  bash "$AGENT" --once 3>&- &
  pid=$!
  for _ in $(seq 50); do
    if grep -q -- '--tag manual' "$MOCK_DIR/backup-calls" 2>/dev/null; then break; fi
    sleep 0.1
  done
  kill -TERM "$pid"
  rc=0
  wait "$pid" || rc=$?
  [ "$rc" -eq 143 ]
  [ "$(job_reports 12 | tail -n 1 | jq -c '{state, error}')" = '{"state":"failed","error":"agent_stopped"}' ]
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

# --- The update job (node-update.sh) ------------------------------------------------------------

OLD_SHA=1111111111111111111111111111111111111111
NEW_SHA=2222222222222222222222222222222222222222

# update_setup: the installed scripts, the node's checkout of the repository at OLD_SHA with its
# setup.sh mocked (it fails at the commits in MOCK_SETUP_FAIL), origin/main's history, git for that
# checkout, systemd-run and setsid running the update at once, eop-ranges.sh mocked, mailcow up.
update_setup() {
  write_agent_env
  export MAILEXPERT_NODE_SRC=$BATS_TEST_TMPDIR/src
  export MAILEXPERT_NODE_AGENT_UPDATE_WAIT=0
  export MOCK_RUNNING='postfix-mailcow dovecot-mailcow nginx-mailcow'
  local file bin=$BATS_TEST_TMPDIR/agent-bin
  for file in node-agent.sh node-update.sh lib.sh; do cp "$NODE_SCRIPTS/$file" "$MAILEXPERT_NODE_DIR/$file"; done
  for file in common.sh env.sh; do cp "$DEPLOY_DIR/lib/$file" "$MAILEXPERT_NODE_DIR/$file"; done
  printf '%s\n' "$OLD_SHA" >"$MAILEXPERT_NODE_DIR/scripts-commit"
  printf '%s\n' "$OLD_SHA" >"$MOCK_DIR/src-head"
  printf '%s\n' "$OLD_SHA" "$NEW_SHA" >"$MOCK_DIR/main-history"
  mkdir -p "$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node"
  cat >"$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node/setup.sh" <<'EOF'
#!/usr/bin/env bash
head=$(cat "$MOCK_DIR/src-head")
printf 'setup.sh %s at %s\n' "$*" "$head" >>"$MOCK_DIR/setup-calls"
printf '[mailexpert] systemd: mailexpert-node-agent.service enabled\n'
if [[ " ${MOCK_SETUP_FAIL:-} " == *" $head "* ]]; then printf '[mailexpert] error: iptables-restore failed\n'; exit 1; fi
printf '%s\n' "$head" >"$MAILEXPERT_NODE_DIR/scripts-commit"
EOF
  cat >"$MAILEXPERT_NODE_DIR/eop-ranges.sh" <<'EOF'
#!/usr/bin/env bash
printf 'eop-ranges.sh\n' >>"$MOCK_DIR/eop-calls"
printf '[mailexpert] firewall rules in place\n'
exit "${MOCK_EOP_RC:-0}"
EOF
  cat >"$bin/git" <<'EOF'
#!/usr/bin/env bash
# The node's checkout: its commit in $MOCK_DIR/src-head, origin/main's history in main-history
# (oldest first), its origin MOCK_ORIGIN, its changed files MOCK_GIT_STATUS.
if [ "${1:-}" = -C ] && [ "${2:-}" = "$MAILEXPERT_NODE_SRC" ]; then
  shift 2
  printf 'git %s\n' "$*" >>"$MOCK_DIR/git-calls"
  line() { grep -nx "$1" "$MOCK_DIR/main-history" | cut -d: -f1; }
  case "$*" in
    "rev-parse --is-inside-work-tree") echo true ;;
    "remote get-url origin") echo "${MOCK_ORIGIN:-https://github.com/wyrtensi/MailExpert.git}" ;;
    "status --porcelain --untracked-files=no") printf '%s' "${MOCK_GIT_STATUS:-}" ;;
    "fetch --quiet origin") [ "${MOCK_FETCH_RC:-0}" = 0 ] || { echo 'fatal: unable to access' >&2; exit 128; } ;;
    "merge-base --is-ancestor "*" origin/main") grep -qx "$3" "$MOCK_DIR/main-history" ;;
    "merge-base --is-ancestor "*)
      a=$(line "$3") b=$(line "$4")
      [ -n "$a" ] && [ -n "$b" ] && [ "$a" -le "$b" ]
      ;;
    "rev-parse HEAD") cat "$MOCK_DIR/src-head" ;;
    "checkout --quiet --detach "*) printf '%s\n' "$4" >"$MOCK_DIR/src-head" ;;
    *) exit 1 ;;
  esac
  exit
fi
exec "$MOCK_SHARED_BIN/git" "$@"
EOF
  # Both start the update and return once it ended, so a test reads its result at once.
  cat >"$bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DIR/systemd-run"
while [ "${1#--}" != "$1" ]; do shift; done
"$@" || true
EOF
  cat >"$bin/setsid" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DIR/setsid"
[ "$1" != nohup ] || shift
exec "$@"
EOF
  chmod +x "$bin/git" "$bin/systemd-run" "$bin/setsid" "$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node/setup.sh" \
    "$MAILEXPERT_NODE_DIR"/*.sh
}

queue_update() { queue_job "{\"id\":\"42\",\"kind\":\"update\",\"params\":{\"sha\":\"${1:-$NEW_SHA}\"}}"; }
# The last report of job 42: its state, error and step.
last_report() { job_reports 42 | tail -n 1; }
src_head() { cat "$MOCK_DIR/src-head"; }

@test "update: backup, checkout, setup.sh, checks, then the new commit's status and succeeded" {
  update_setup
  write_backup_keys
  queue_update
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(src_head)" = "$NEW_SHA" ]
  grep -qx 'node-backup.sh --tag pre-update' "$MOCK_DIR/backup-calls"
  [ "$(cat "$MOCK_DIR/setup-calls")" = "setup.sh  at $NEW_SHA" ]
  grep -qx 'git fetch --quiet origin' "$MOCK_DIR/git-calls"
  grep -qx "git merge-base --is-ancestor $NEW_SHA origin/main" "$MOCK_DIR/git-calls"
  grep -q 'eop-ranges.sh' "$MOCK_DIR/eop-calls"
  # Detached from the agent: a transient unit per job, from the copy in the state directory.
  grep -q -- "--unit=mailexpert-node-update-42 .*/bin/bash $MAILEXPERT_NODE_STATE/update-run-42/node-update.sh 42 $NEW_SHA" "$MOCK_DIR/systemd-run"
  [ "$(jq -r .state <<<"$(last_report)")" = succeeded ]
  [ "$(jq -r .step <<<"$(last_report)")" = "the node's scripts are at ${NEW_SHA:0:12}" ]
  job_reports 42 | jq -r .step | grep -q '^node-backup.sh --tag pre-update$'
  job_reports 42 | jq -r .step | grep -q "^setup.sh at ${NEW_SHA:0:12}$"
  # The status report after it names the new commit.
  [ "$(agent_requests | sed -n 's|^POST /api/node-agent/status ||p' | tail -n 1 | jq -r .scriptsCommit)" = "$NEW_SHA" ]
  # Delivered: no state file and no copy left; the log stays, 0600.
  [ ! -e "$MAILEXPERT_NODE_STATE/update-42.json" ]
  [ ! -e "$MAILEXPERT_NODE_STATE/update-run-42" ]
  [ "$(stat -c %a "$MAILEXPERT_NODE_STATE/update-42.log")" = 600 ]
  grep -q '== setup.sh at' "$MAILEXPERT_NODE_STATE/update-42.log"
  lacks "$TOKEN" <"$MAILEXPERT_NODE_STATE/update-42.log"
}

@test "update: a commit outside origin/main is refused, nothing runs" {
  update_setup
  write_backup_keys
  queue_update 3333333333333333333333333333333333333333
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"not_in_main"}' ]
  [ "$(src_head)" = "$OLD_SHA" ]
  lacks 'pre-update' <"$MOCK_DIR/backup-calls"
  [ ! -e "$MOCK_DIR/setup-calls" ]
}

@test "update: a commit that is not 40 hex digits never starts the update" {
  update_setup
  queue_update '1111111111111111111111111111111111111111; rm -rf /'
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"sha_invalid"}' ]
  [ ! -e "$MOCK_DIR/systemd-run" ]
}

@test "update: without the node's backup it fails and changes nothing" {
  update_setup
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"backup_not_configured"}' ]
  [ "$(src_head)" = "$OLD_SHA" ]
  lacks 'pre-update' <"$MOCK_DIR/backup-calls"
  [ ! -e "$MOCK_DIR/setup-calls" ]
}

@test "update: a failed pre-update backup stops it before the checkout" {
  update_setup
  write_backup_keys
  export MOCK_BACKUP_RC=1
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"backup_failed"}' ]
  [ "$(src_head)" = "$OLD_SHA" ]
  [ ! -e "$MOCK_DIR/setup-calls" ]
}

@test "update: setup.sh failing at the new commit rolls back to the previous one" {
  update_setup
  write_backup_keys
  export MOCK_SETUP_FAIL=$NEW_SHA
  queue_update
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_DIR/setup-calls")" = "setup.sh  at $NEW_SHA"$'\n'"setup.sh  at $OLD_SHA" ]
  [ "$(src_head)" = "$OLD_SHA" ]
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"rolled_back"}' ]
  [[ $(jq -r .step <<<"$(last_report)") == *"iptables-restore failed"*"rolled back to ${OLD_SHA:0:12}"* ]]
  [ "$(cat "$MAILEXPERT_NODE_DIR/scripts-commit")" = "$OLD_SHA" ]
}

@test "update: a rollback that fails too is reported as such" {
  update_setup
  write_backup_keys
  export MOCK_SETUP_FAIL="$NEW_SHA $OLD_SHA"
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"rollback_failed"}' ]
}

@test "update: a failed check after setup.sh is reported, the new commit stays" {
  update_setup
  write_backup_keys
  export MOCK_RUNNING='postfix-mailcow nginx-mailcow'
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"post_check_failed"}' ]
  [[ $(jq -r .step <<<"$(last_report)") == *"not running: dovecot-mailcow"* ]]
  [ "$(src_head)" = "$NEW_SHA" ]
}

@test "update: without systemd it starts with setsid nohup" {
  update_setup
  write_backup_keys
  export MAILEXPERT_NODE_INIT=cron
  queue_update
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  grep -qx "nohup /bin/bash $MAILEXPERT_NODE_STATE/update-run-42/node-update.sh 42 $NEW_SHA" "$MOCK_DIR/setsid"
  # setsid ran it in the background: wait for its end.
  for _ in $(seq 1 50); do
    [ -e "$MAILEXPERT_NODE_STATE/update-42.json" ] || break
    sleep 0.2
  done
  [ "$(jq -r .state <<<"$(last_report)")" = succeeded ]
  [ ! -e "$MOCK_DIR/systemd-run" ]
}

@test "after a restart the agent delivers a result the update could not, and fails a dead update" {
  update_setup
  mkdir -p "$MAILEXPERT_NODE_STATE"
  printf '{"id":"42","state":"succeeded","step":"the node'"'"'s scripts are at 222222222222","error":null,"pid":1}\n' >"$MAILEXPERT_NODE_STATE/update-42.json"
  printf '[mailexpert] done\n' >"$MAILEXPERT_NODE_STATE/update-42.log"
  mkdir -p "$MAILEXPERT_NODE_STATE/update-run-42"
  # An update whose process is gone (a reboot): failed, update_interrupted, with the commit it
  # started from for a rollback by hand.
  printf '{"id":"43","state":"running","step":"setup.sh at 222222222222","error":null,"pid":999999,"previous":"%s"}\n' "$OLD_SHA" >"$MAILEXPERT_NODE_STATE/update-43.json"
  run bash "$AGENT" --once
  [ "$status" -eq 0 ]
  [ "$(jq -c '{state, log}' <<<"$(last_report)")" = '{"state":"succeeded","log":"[mailexpert] done"}' ]
  [ "$(job_reports 43 | jq -c '{state, error}')" = '{"state":"failed","error":"update_interrupted"}' ]
  [[ $(job_reports 43 | jq -r .step) == *"setup.sh at 222222222222"* ]]
  [[ $(job_reports 43 | jq -r .step) == *"it started from $OLD_SHA: git checkout of it and setup.sh"* ]]
  [ ! -e "$MAILEXPERT_NODE_STATE/update-42.json" ]
  [ ! -e "$MAILEXPERT_NODE_STATE/update-43.json" ]
  [ ! -e "$MAILEXPERT_NODE_STATE/update-run-42" ]
  # Nothing runs any more: the agent polls again.
  agent_requests | grep -q '^GET /api/node-agent/next'
}

@test "while the update runs the restarted agent neither polls nor reports; an undelivered result is kept" {
  update_setup
  mkdir -p "$MAILEXPERT_NODE_STATE"
  bash -c "exec -a node-update.sh bash -c 'while :; do sleep 1; done'" </dev/null >/dev/null 2>&1 3>&- &
  pid=$!
  printf '{"id":"42","state":"running","step":"setup.sh","error":null,"pid":%s}\n' "$pid" >"$MAILEXPERT_NODE_STATE/update-42.json"
  run bash "$AGENT" --once
  kill "$pid" 2>/dev/null || true
  [ "$status" -eq 0 ]
  [ -z "$(agent_requests)" ]
  [ -e "$MAILEXPERT_NODE_STATE/update-42.json" ]
  # A result the panel did not take stays, and the agent does not poll before it is delivered:
  # the round fails (the agent backs off).
  printf '{"id":"42","state":"failed","step":"x","error":"rolled_back","pid":1}\n' >"$MAILEXPERT_NODE_STATE/update-42.json"
  export MOCK_POST_STATUS=503
  run bash "$AGENT" --once
  [ "$status" -eq 1 ]
  [ -e "$MAILEXPERT_NODE_STATE/update-42.json" ]
  agent_requests | lacks '^GET /api/node-agent/next'
  export MOCK_PANEL_DOWN=1
  run bash "$AGENT" --once
  unset MOCK_PANEL_DOWN
  [ "$status" -eq 1 ]
  [ -e "$MAILEXPERT_NODE_STATE/update-42.json" ]
  # A panel that already failed the job (409) takes it as delivered.
  export MOCK_POST_STATUS=409
  run bash "$AGENT" --once
  [ ! -e "$MAILEXPERT_NODE_STATE/update-42.json" ]
}

@test "setup.sh installs node-update.sh next to the agent" {
  printf '%s\n' "$TOKEN" >"$BATS_TEST_TMPDIR/token"
  setup_with_agent --panel-url https://panel.example.com --agent-token-file "$BATS_TEST_TMPDIR/token"
  [ "$status" -eq 0 ]
  [ -x "$MAILEXPERT_NODE_DIR/node-update.sh" ]
}

@test "update: the state file keeps the commit the update started from" {
  update_setup
  write_backup_keys
  queue_update
  # The state file as it was while setup.sh ran: read by the setup.sh mock.
  printf 'cp "$MAILEXPERT_NODE_STATE/update-42.json" "$MOCK_DIR/state-during-setup"\n' >>"$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node/setup.sh"
  run bash "$AGENT" --once
  [ "$(jq -r .previous "$MOCK_DIR/state-during-setup")" = "$OLD_SHA" ]
  [ "$(jq -r .state "$MOCK_DIR/state-during-setup")" = running ]
}

@test "update: a checkout whose origin is not the official repository is refused, unless node.env names it" {
  update_setup
  write_backup_keys
  export MOCK_ORIGIN=https://example.com/someone/MailExpert.git
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"untrusted_origin"}' ]
  lacks 'fetch' <"$MOCK_DIR/git-calls"
  [ "$(src_head)" = "$OLD_SHA" ]
  # A mirror the owner chose, in the root-only node.env.
  printf 'NODE_UPDATE_ORIGIN=https://example.com/someone/MailExpert.git\n' >>"$MAILEXPERT_NODE_CONF"
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -r .state <<<"$(last_report)")" = succeeded ]
}

@test "update: local changes in the checkout are refused" {
  update_setup
  write_backup_keys
  export MOCK_GIT_STATUS=' M scripts/deploy/mail-node/setup.sh'
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"local_changes"}' ]
  [ "$(src_head)" = "$OLD_SHA" ]
  lacks 'pre-update' <"$MOCK_DIR/backup-calls"
}

@test "update: never back to an older commit (not_newer), before any backup" {
  update_setup
  write_backup_keys
  printf '%s\n' "$NEW_SHA" >"$MOCK_DIR/src-head"
  queue_update "$OLD_SHA"
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"not_newer"}' ]
  [ "$(src_head)" = "$NEW_SHA" ]
  lacks 'pre-update' <"$MOCK_DIR/backup-calls"
  [ ! -e "$MOCK_DIR/setup-calls" ]
}

# run_update_with <shell code>: node-update.sh sourced, a step replaced by the code, then the update.
run_update_with() {
  mkdir -p "$MAILEXPERT_NODE_STATE"
  run bash -c '. "$1"; eval "$2"; update_main 42 "$3"' _ "$MAILEXPERT_NODE_DIR/node-update.sh" "$1" "$NEW_SHA"
}

@test "update: a failed mailcow update starts mailcow again, still runs the checks and reports" {
  update_setup
  write_backup_keys
  run_update_with 'mailcow_update_if_pinned() { echo "[mailexpert] error: mailcow update.sh failed"; return 1; }'
  [ "$status" -eq 0 ]
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"mailcow_update_failed"}' ]
  [[ $(jq -r .step <<<"$(last_report)") == *"mailcow update.sh failed"* ]]
  calls | grep -q "^docker compose up -d (in $MC)$"
  grep -q 'eop-ranges.sh' "$MOCK_DIR/eop-calls"
  # The status report after it names the new scripts commit.
  [ "$(agent_requests | sed -n 's|^POST /api/node-agent/status ||p' | tail -n 1 | jq -r .scriptsCommit)" = "$NEW_SHA" ]
}

@test "update: a mailcow update past its bound is stopped" {
  update_setup
  write_backup_keys
  export MAILEXPERT_NODE_UPDATE_MAILCOW_TIMEOUT=2
  run_update_with 'mailcow_update_if_pinned() { sleep 30; }'
  [ "$status" -eq 0 ]
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"mailcow_update_failed"}' ]
  grep -q 'ran past 2s; stopped' "$MAILEXPERT_NODE_STATE/update-42.log"
}

@test "update: a failed check sends the status report too" {
  update_setup
  write_backup_keys
  export MOCK_EOP_RC=1
  queue_update
  run bash "$AGENT" --once
  [ "$(jq -c '{state, error}' <<<"$(last_report)")" = '{"state":"failed","error":"post_check_failed"}' ]
  [ "$(agent_requests | sed -n 's|^POST /api/node-agent/status ||p' | tail -n 1 | jq -r .scriptsCommit)" = "$NEW_SHA" ]
}
