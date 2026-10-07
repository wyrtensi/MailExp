#!/usr/bin/env bats
# mailexpert-cli.sh argument handling before it ever reaches docker: usage, the wrapper's own
# --prefix and what it refuses up front. The container call itself (and the CLI's exit codes
# passing through) is exercised by hand against an installed panel; the CLI is covered by the
# backend's tests (backend/src/cli).

bats_require_minimum_version 1.5.0

setup() {
  load helper
  SCRIPT=$DEPLOY_DIR/mailexpert-cli.sh
}

@test "--help prints usage and exits 0 without root" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ $output == *"Usage: mailexpert-cli.sh"* ]]
  [[ $output == *"mailbox, domain"* && $output == *"jobs, access"* && $output == *"node, eop, seats, agent"* ]]
}

@test "no group is an error" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ $output == *"a group and a command are required"* ]]
  run bash "$SCRIPT" --prefix /opt/mailexpert
  [ "$status" -eq 2 ]
}

@test "a group that cannot be one is refused before docker" {
  run bash "$SCRIPT" 'domain;id'
  [ "$status" -eq 2 ]
  [[ $output == *"unknown group"* ]]
}

@test "--prefix needs an absolute path without spaces" {
  run bash "$SCRIPT" --prefix
  [ "$status" -eq 2 ]
  [[ $output == *"--prefix needs a value"* ]]
  run bash "$SCRIPT" --prefix relative/path domain list
  [ "$status" -eq 2 ]
  [[ $output == *"--prefix must be an absolute path"* ]]
  run bash "$SCRIPT" --prefix "/has space" domain list
  [ "$status" -eq 2 ]
}

@test "not root is a wrapper error: exit 2" {
  if [ "$(id -u)" = 0 ]; then skip "runs as root"; fi
  run bash "$SCRIPT" domain --help
  [ "$status" -eq 2 ]
  [[ $output == *"run mailexpert-cli.sh as root"* ]]
}

@test "a missing installation is reported with exit 2" {
  stub_root
  run bash "$SCRIPT" --prefix "$BATS_TEST_TMPDIR/none" domain list
  [ "$status" -eq 2 ]
  [[ $output == *"install.conf is missing"* ]]
}

# --- past the root check and install.conf, with docker and id stubbed on PATH ---

# id -u answers 0; docker logs its arguments and answers as the STUB_* variables say.
stub_root() {
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  printf '#!/usr/bin/env bash\n[ "$1" = -u ] && echo 0 || command -p id "$@"\n' >"$STUB/id"
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case " $* " in
  *" ps "*) printf '%s\n' "${STUB_SERVICES-backend}"; exit "${STUB_PS_STATUS:-0}" ;;
  # docker compose exec forwards stdin: a call that reads it would take what the CLI should get.
  *" test -f "*) if [ -n "${STUB_READ_STDIN:-}" ]; then cat >/dev/null; fi; exit "${STUB_TEST_STATUS:-0}" ;;
  *" node "*) if [ -n "${STUB_CLI_SLEEP:-}" ]; then sleep "$STUB_CLI_SLEEP"; fi; echo "cli says hi"; if [ -n "${STUB_READ_STDIN:-}" ]; then echo "cli read: $(cat)"; fi; echo "cli warns" >&2; exit "${STUB_CLI_STATUS:-0}" ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/id" "$STUB/docker"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P"
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 \
    PROJECT=me-test HTTP_PORT=18090 >"$P/install.conf"
}

@test "runs the CLI in the backend container with -T without a terminal and passes the arguments through" {
  stub_root
  run bash "$SCRIPT" --prefix "$P" mailbox show 'a b@example.com' --json
  [ "$status" -eq 0 ]
  [[ $output == *"cli says hi"* ]]
  grep -q -- "exec -T backend node src/cli/mailexpert.js mailbox show a b@example.com --json" "$DOCKER_LOG"
  grep -q -- "-p me-test" "$DOCKER_LOG"
}

@test "stdin reaches the CLI whole: the checks before it do not read it" {
  stub_root
  STUB_READ_STDIN=1 run bash "$SCRIPT" --prefix "$P" access token <<<"token-from-stdin"
  [ "$status" -eq 0 ]
  [[ $output == *"cli read: token-from-stdin"* ]]
  [[ $(grep -c "token-from-stdin" "$DOCKER_LOG") = 0 ]]
}

@test "the CLI's exit codes 1, 2 and 3 pass through unchanged" {
  stub_root
  for code in 1 2 3; do
    STUB_CLI_STATUS=$code run bash "$SCRIPT" --prefix "$P" domain list
    [ "$status" -eq "$code" ]
    [[ $output != *"a command failed"* ]]
  done
}

@test "a backend container that is not running is exit 3 before the CLI" {
  stub_root
  STUB_SERVICES=postgres run bash "$SCRIPT" --prefix "$P" domain list
  [ "$status" -eq 3 ]
  [[ $output == *"backend container is not running"* ]]
  ! grep -q " node " "$DOCKER_LOG"
}

@test "an image without the CLI is exit 3 with a hint to update" {
  stub_root
  STUB_TEST_STATUS=1 run bash "$SCRIPT" --prefix "$P" domain list
  [ "$status" -eq 3 ]
  [[ $output == *"has no CLI"* ]]
}

@test "docker failing to start the command (125-127) is exit 3" {
  stub_root
  STUB_CLI_STATUS=126 run bash "$SCRIPT" --prefix "$P" domain list
  [ "$status" -eq 3 ]
  [[ $output == *"docker could not run the CLI"* ]]
}

@test "agent token --out FILE writes the token to a new 0600 file on the host, the CLI printing it with --out -" {
  stub_root
  local file=$BATS_TEST_TMPDIR/agent-token
  run --separate-stderr bash "$SCRIPT" --prefix "$P" agent token issue --out "$file" --yes
  [ "$status" -eq 0 ]
  grep -q -- "exec -T backend node src/cli/mailexpert.js agent token issue --out - --yes" "$DOCKER_LOG"
  [ "$(cat "$file")" = "cli says hi" ]
  [ "$(stat -c %a "$file")" = 600 ]
  [[ $output != *"cli says hi"* ]]
  [[ $stderr == *"token written to $file"* ]]
  rm -f "$file"
  run bash "$SCRIPT" --prefix "$P" agent token issue --out="$file"
  [ "$status" -eq 0 ]
  grep -q -- "agent token issue --out=-" "$DOCKER_LOG"
}

@test "agent token --out never writes over a file, and removes its file when the CLI fails" {
  stub_root
  local file=$BATS_TEST_TMPDIR/taken
  echo keep >"$file"
  run bash "$SCRIPT" --prefix "$P" agent token issue --out "$file"
  [ "$status" -eq 2 ]
  [[ $output == *"exists already"* ]]
  [ "$(cat "$file")" = keep ]
  [ ! -e "$DOCKER_LOG" ] || [ "$(grep -c " node " "$DOCKER_LOG")" = 0 ]
  STUB_CLI_STATUS=1 run bash "$SCRIPT" --prefix "$P" agent token issue --out "$BATS_TEST_TMPDIR/new"
  [ "$status" -eq 1 ]
  [ ! -e "$BATS_TEST_TMPDIR/new" ]
}

# TERM only: a background job of a non-interactive shell starts with INT ignored, and an ignored
# signal cannot be trapped, so INT (Ctrl-C in a terminal, same trap) cannot be sent here.
@test "agent token --out removes its file when the wrapper is stopped with TERM" {
  stub_root
  local file=$BATS_TEST_TMPDIR/stopped pid code=0
  STUB_CLI_SLEEP=2 bash "$SCRIPT" --prefix "$P" agent token issue --out "$file" --yes 2>/dev/null &
  pid=$!
  for _ in $(seq 50); do
    if [ -e "$file" ]; then break; fi
    sleep 0.1
  done
  [ -e "$file" ]
  kill -s TERM "$pid"
  wait "$pid" || code=$?
  [ "$code" -eq 143 ]
  [ ! -e "$file" ]
}

@test "only agent token takes --out as a host file; --out - and other commands pass through unchanged" {
  # shellcheck source=/dev/null
  source "$SCRIPT"
  [ "$(token_out_file agent token issue --out /root/t)" = /root/t ]
  [ "$(token_out_file agent token issue --out=/root/t --yes)" = /root/t ]
  run token_out_file agent token issue --out -
  [ "$status" -ne 0 ]
  run token_out_file agent token issue
  [ "$status" -ne 0 ]
  run token_out_file agent status --out /root/t
  [ "$status" -ne 0 ]
  run token_out_file mailbox list --out /root/t
  [ "$status" -ne 0 ]
}

@test "the container gets a terminal only with one on both ends and without --json" {
  # shellcheck source=/dev/null
  source "$SCRIPT"
  [ "$(exec_tty_flag 1 1 domain list)" = "" ]
  [ "$(exec_tty_flag 1 1 domain list --json)" = "-T" ]
  [ "$(exec_tty_flag 0 1 domain list)" = "-T" ]
  [ "$(exec_tty_flag 1 0 domain list)" = "-T" ]
}
