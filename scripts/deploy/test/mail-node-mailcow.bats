#!/usr/bin/env bats
# mailcow brought to the version the release pins (node-update.sh mailcow_update_if_pinned) and
# mailcow's version in the status report (node-agent.sh mailcow_json). Real git: a bare repository
# plays mailcow's official one (tags 2026-09 and 2026-09a, a newer commit where a test adds it), the
# mailcow directory is a clone of it. mailcow's update.sh is a mock committed in that repository: it
# merges origin/master as the real one does (a "Before update" commit of local changes, then an
# "After update" merge), and turns ENABLE_IPV6 on. docker and setup.sh are mocks.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  load mail-node/helper
  mail_node_setup
  # Real git for the mailcow checkout.
  rm -f "$BATS_TEST_TMPDIR/bin/git"
  export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
  export GIT_CONFIG_GLOBAL=$BATS_TEST_TMPDIR/gitconfig
  git config --global init.defaultBranch master
  git config --global advice.detachedHead false
  export MAILEXPERT_MAILCOW_UPSTREAM=$BATS_TEST_TMPDIR/upstream.git
  export MAILEXPERT_NODE_UPDATE_MAILCOW_HEALTH_WAIT=0
  export MAILEXPERT_NODE_UPDATE_MAILCOW_HEALTH_POLL=1
  export MAILEXPERT_NODE_SRC=$BATS_TEST_TMPDIR/src
  export MOCK_CONTAINERS='postfix-mailcow\trunning\thealthy\ndovecot-mailcow\trunning\thealthy\nnginx-mailcow\trunning\t\n'
  local bin=$BATS_TEST_TMPDIR/mailcow-bin
  mkdir -p "$bin"
  cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "compose ps -a --format"*) printf '%b' "$MOCK_CONTAINERS" ;;
  *) exec "$BATS_TEST_TMPDIR/bin/docker" "$@" ;;
esac
EOF
  chmod +x "$bin/docker"
  export PATH=$bin:$PATH
  make_upstream
  clone_mailcow 2026-09
  pin 2026-09a
  write_node_env
}

# make_upstream: mailcow's repository: 2026-09, then 2026-09a, master at 2026-09a.
make_upstream() {
  local work=$BATS_TEST_TMPDIR/upstream-work
  git init -q --bare "$MAILEXPERT_MAILCOW_UPSTREAM"
  git init -q "$work"
  printf 'mailcow.conf\n' >"$work/.gitignore"
  cat >"$work/update.sh" <<'EOF'
#!/usr/bin/env bash
# mailcow's update.sh as the node's update sees it.
printf 'update.sh %s\n' "$*" >>"$MOCK_DIR/update-calls"
if [ -t 0 ]; then echo 'stdin is a terminal' >>"$MOCK_DIR/update-calls"; fi
n=$(($(cat "$MOCK_DIR/update-count" 2>/dev/null || echo 0) + 1))
echo "$n" >"$MOCK_DIR/update-count"
if [ "$n" -le "${MOCK_UPDATE_EXIT2:-0}" ]; then echo '_modules have been updated. Please restart the update script.'; exit 2; fi
[ "${MOCK_UPDATE_RC:-0}" = 0 ] || exit "$MOCK_UPDATE_RC"
[ "${MOCK_UPDATE_NOOP:-0}" = 0 ] || exit 0
git rev-parse --abbrev-ref HEAD >"$MOCK_DIR/update-branch"
git add -u
git commit -qam "Before update" >/dev/null || true
git fetch -q origin
git config merge.defaultToUpstream true
git merge -q -Xtheirs -m "After update" || exit 1
sed -i 's/^ENABLE_IPV6=.*/ENABLE_IPV6=true/' mailcow.conf
EOF
  chmod +x "$work/update.sh"
  printf 'v1\n' >"$work/version"
  printf 'conf\n' >"$work/local.cf"
  git -C "$work" add -A
  git -C "$work" commit -qm 2026-09
  git -C "$work" tag 2026-09
  printf 'v2\n' >"$work/version"
  git -C "$work" commit -qam 2026-09a
  git -C "$work" tag 2026-09a
  git -C "$work" remote add origin "$MAILEXPERT_MAILCOW_UPSTREAM"
  git -C "$work" push -q origin master --tags
}

commit_of() { git -C "$MAILEXPERT_MAILCOW_UPSTREAM" rev-parse "$1^{commit}"; }

# upstream_newer: mailcow releases 2026-10 after the pin.
upstream_newer() {
  local work=$BATS_TEST_TMPDIR/upstream-work
  printf 'v3\n' >"$work/version"
  git -C "$work" commit -qam 2026-10
  git -C "$work" tag 2026-10
  git -C "$work" push -q origin master --tags
}

# clone_mailcow <tag>: the node's mailcow as the docs' clone leaves it, detached at the tag, with
# the test's mailcow.conf and data/ kept.
clone_mailcow() {
  local tmp=$BATS_TEST_TMPDIR/clone
  rm -rf "$MC/.git"
  git clone -q "$MAILEXPERT_MAILCOW_UPSTREAM" "$tmp"
  git -C "$tmp" checkout -q "$1"
  cp -a "$tmp/." "$MC/"
  rm -rf "$tmp"
}

# pin <tag>: the node's MailExpert checkout pins that mailcow release; its setup.sh is a mock that
# puts ENABLE_IPV6=false back.
pin() {
  mkdir -p "$MAILEXPERT_NODE_SRC/deploy" "$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node"
  printf 'MAILCOW_TAG=%s\nMAILCOW_COMMIT=%s\n' "$1" "$(commit_of "$1")" >"$MAILEXPERT_NODE_SRC/deploy/mailcow-version"
  cat >"$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node/setup.sh" <<'EOF'
#!/usr/bin/env bash
printf 'setup.sh %s\n' "$*" >>"$MOCK_DIR/setup-calls"
sed -i 's/^ENABLE_IPV6=.*/ENABLE_IPV6=false/' "$MAILCOW_DIR_FOR_TEST/mailcow.conf"
exit "${MOCK_SETUP_RC:-0}"
EOF
  chmod +x "$MAILEXPERT_NODE_SRC/scripts/deploy/mail-node/setup.sh"
  export MAILCOW_DIR_FOR_TEST=$MC
}

run_hook() {
  run bash -c '. "$1"; mailcow_update_if_pinned' _ "$NODE_SCRIPTS/node-update.sh"
}
mailcow_json_now() { bash -c '. "$1"; mailcow_json' _ "$NODE_SCRIPTS/node-agent.sh"; }
update_calls() { cat "$MOCK_DIR/update-calls" 2>/dev/null; }
base() { git -C "$MC" merge-base HEAD origin/master; }

@test "mailcow: a detached clone at an older tag goes to master and is updated to the pin" {
  # A tracked file changed by hand: update.sh commits it and merges master over it.
  printf 'conf changed here\n' >"$MC/local.cf"
  run_hook
  [ "$status" -eq 0 ]
  [ "$(update_calls)" = 'update.sh --force --skip-ping-check --skip-start' ]
  [ "$(cat "$MOCK_DIR/update-branch")" = master ]
  [ "$(git -C "$MC" rev-parse --abbrev-ref master@{upstream})" = origin/master ]
  # HEAD is update.sh's merge commit; the release it holds is the pin.
  [ "$(base)" = "$(commit_of 2026-09a)" ]
  [ "$(git -C "$MC" rev-parse HEAD)" != "$(commit_of 2026-09a)" ]
  [ "$(cat "$MC/version")" = v2 ]
  [ "$(cat "$MC/local.cf")" = 'conf changed here' ]
  # setup.sh again before the start: our mailcow.conf settings back, then one start.
  [ "$(cat "$MOCK_DIR/setup-calls")" = 'setup.sh ' ]
  grep -qx 'ENABLE_IPV6=false' "$MC/mailcow.conf"
  calls | grep -q "^docker compose up -d --remove-orphans (in $MC)$"
  [[ $output == *"stopped and started again within "*" UTC"* ]]
  [[ $output == *"mailcow updated to 2026-09a"* ]]
  lacks 'not-a-real-password' <<<"$output"
}

@test "mailcow: at the pin already, nothing runs" {
  clone_mailcow 2026-09a
  run_hook
  [ "$status" -eq 0 ]
  [[ $output == *"mailcow already at 2026-09a"* ]]
  [ -z "$(update_calls)" ]
  [ ! -e "$MOCK_DIR/setup-calls" ]
}

@test "mailcow: a release without a pin leaves mailcow alone" {
  rm "$MAILEXPERT_NODE_SRC/deploy/mailcow-version"
  run_hook
  [ "$status" -eq 0 ]
  [[ $output == *"pins no mailcow version"* ]]
  [ -z "$(update_calls)" ]
}

@test "mailcow: a newer mailcow on master than the pin is not installed (mailcow_pin_not_latest)" {
  upstream_newer
  run_hook
  [ "$status" -eq 0 ]
  [[ $output == *"mailcow_pin_not_latest"* ]]
  [ -z "$(update_calls)" ]
  [ "$(git -C "$MC" rev-parse HEAD)" = "$(commit_of 2026-09)" ]
}

@test "mailcow: a node newer than the pin is never taken back" {
  upstream_newer
  clone_mailcow 2026-10
  run_hook
  [ "$status" -eq 0 ]
  [[ $output == *"newer than 2026-09a"* ]]
  [ -z "$(update_calls)" ]
}

@test "mailcow: a node outside master's history is not touched" {
  git -C "$MC" checkout -q --orphan other
  git -C "$MC" commit -qm other
  run_hook
  [ "$status" -eq 0 ]
  [[ $output == *"not in the history of 2026-09a"* ]]
  [ -z "$(update_calls)" ]
}

@test "mailcow: update.sh exiting 2 for its new modules runs once more" {
  export MOCK_UPDATE_EXIT2=1
  run_hook
  [ "$status" -eq 0 ]
  [ "$(update_calls | wc -l)" -eq 2 ]
  [ "$(base)" = "$(commit_of 2026-09a)" ]
}

@test "mailcow: a failed update.sh fails the step" {
  export MOCK_UPDATE_RC=1
  run_hook
  [ "$status" -eq 1 ]
  [[ $output == *"update.sh failed (exit 1)"* ]]
  [ ! -e "$MOCK_DIR/setup-calls" ]
}

@test "mailcow: update.sh that did not reach the pin fails the step" {
  export MOCK_UPDATE_NOOP=1
  run_hook
  [ "$status" -eq 1 ]
  [[ $output == *"not 2026-09a"* ]]
}

@test "mailcow: containers not healthy after the start fail the step" {
  export MOCK_CONTAINERS='postfix-mailcow\trunning\thealthy\ndovecot-mailcow\trunning\tunhealthy\nsogo-mailcow\texited\t\n'
  run_hook
  [ "$status" -eq 1 ]
  [[ $output == *"not healthy after 0s: dovecot-mailcow: unhealthy, sogo-mailcow: exited"* ]]
}

@test "mailcow: a host name without a subdomain stops before update.sh, without printing it" {
  sed -i 's/^MAILCOW_HOSTNAME=.*/MAILCOW_HOSTNAME=example.com/' "$MC/mailcow.conf"
  run_hook
  [ "$status" -eq 1 ]
  [[ $output == *"not a host name with a subdomain"* ]]
  lacks 'example\.com' <<<"$output"
  [ -z "$(update_calls)" ]
}

@test "mailcow: a branch other than master is left to the administrator" {
  git -C "$MC" checkout -q -b custom
  run_hook
  [ "$status" -eq 1 ]
  [[ $output == *"on the branch custom, not master"* ]]
  [ -z "$(update_calls)" ]
}

@test "mailcow: another origin is set back to the official repository first" {
  git -C "$MC" remote set-url origin https://example.com/fork.git
  run_hook
  [ "$status" -eq 0 ]
  [ "$(git -C "$MC" remote get-url origin)" = "$MAILEXPERT_MAILCOW_UPSTREAM" ]
  [ "$(base)" = "$(commit_of 2026-09a)" ]
}

@test "status: mailcow's release, tag, the pin and master's head, and how they compare" {
  run mailcow_json_now
  [ "$status" -eq 0 ]
  [ "$(jq -c '{tag, pinTag, relation}' <<<"$output")" = '{"tag":"2026-09","pinTag":"2026-09a","relation":"behind"}' ]
  [ "$(jq -r .commit <<<"$output")" = "$(commit_of 2026-09)" ]
  [ "$(jq -r .pinCommit <<<"$output")" = "$(commit_of 2026-09a)" ]
  [ "$(jq -r .upstreamCommit <<<"$output")" = "$(commit_of 2026-09a)" ]
  # After the update with local changes: HEAD is a merge commit, the release is still named.
  printf 'conf changed here\n' >"$MC/local.cf"
  run_hook
  run mailcow_json_now
  [ "$(jq -c '{tag, relation}' <<<"$output")" = '{"tag":"2026-09a","relation":"match"}' ]
  [ "$(jq -r .commit <<<"$output")" = "$(commit_of 2026-09a)" ]
}

@test "status: a mailcow newer than the pin, and one the node cannot read" {
  upstream_newer
  clone_mailcow 2026-10
  git -C "$MC" fetch -q origin
  run mailcow_json_now
  [ "$(jq -c '{tag, relation}' <<<"$output")" = '{"tag":"2026-10","relation":"newer"}' ]
  rm -rf "$MC/.git"
  run mailcow_json_now
  [ "$(jq -c '{commit, tag, relation}' <<<"$output")" = '{"commit":null,"tag":null,"relation":"unknown"}' ]
}
