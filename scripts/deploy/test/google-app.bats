#!/usr/bin/env bats
# google-app.sh argument handling: usage, validation and how it picks add vs list, before it ever
# reaches docker (this only exercises what fails before load_install/app_compose are called; the
# actual container call is exercised by hand against an installed panel, not here).

bats_require_minimum_version 1.5.0

setup() {
  load helper
  SCRIPT=$DEPLOY_DIR/google-app.sh
  JSON=$BATS_TEST_TMPDIR/client.json
  printf '%s' '{"web":{"client_id":"1-a.apps.googleusercontent.com","client_secret":"s"}}' >"$JSON"
}

@test "--help prints usage and exits 0 without root" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ $output == *"Usage: google-app.sh add"* ]]
}

@test "no command is an error" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ $output == *"a command is required"* ]]
}

@test "an unknown command is an error" {
  run bash "$SCRIPT" bogus
  [ "$status" -eq 2 ]
  [[ $output == *"unknown command: bogus"* ]]
}

@test "only one command is accepted" {
  run bash "$SCRIPT" add "$JSON" list
  [ "$status" -eq 2 ]
  [[ $output == *"one command only"* ]]
}

@test "add without a file is an error" {
  run bash "$SCRIPT" add
  [ "$status" -eq 2 ]
  [[ $output == *"needs the path to the client JSON file"* ]]
}

@test "add with a missing file is an error and does not print its content" {
  run bash "$SCRIPT" add "$BATS_TEST_TMPDIR/does-not-exist.json"
  [ "$status" -eq 2 ]
  [[ $output == *"no such file"* ]]
}

@test "an extra positional argument after the file is rejected" {
  run bash "$SCRIPT" add "$JSON" extra
  [ "$status" -eq 2 ]
  [[ $output == *"unknown argument: extra"* ]]
}

@test "--prefix must be an absolute path without spaces" {
  run bash "$SCRIPT" add "$JSON" --prefix "relative/path"
  [ "$status" -eq 2 ]
  [[ $output == *"--prefix must be an absolute path"* ]]
  run bash "$SCRIPT" list --prefix "/has space"
  [ "$status" -eq 2 ]
}

@test "--label and --user-limit need a value" {
  run bash "$SCRIPT" add "$JSON" --label
  [ "$status" -eq 2 ]
  [[ $output == *"--label needs a value"* ]]
  run bash "$SCRIPT" add "$JSON" --user-limit
  [ "$status" -eq 2 ]
  [[ $output == *"--user-limit needs a value"* ]]
}

@test "--user-limit must be a positive whole number" {
  for bad in 0 -1 1.5 abc; do
    run bash "$SCRIPT" add "$JSON" --user-limit "$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"--user-limit must be a positive whole number"* ]]
  done
}

@test "an unknown flag is rejected" {
  run bash "$SCRIPT" list --bogus
  [ "$status" -eq 2 ]
  [[ $output == *"unknown argument: --bogus"* ]]
}

@test "a valid add and a valid list pass every argument check (root/install.conf come next, not tested here)" {
  run bash "$SCRIPT" add "$JSON" --label "My App" --user-limit 42
  [[ $output != *"see --help"* && $output != *"needs the path"* && $output != *"no such file"* ]]
  run bash "$SCRIPT" list
  [[ $output != *"see --help"* ]]
}

@test "show, enable, close, disable and delete need exactly one app id" {
  for cmd in show enable close disable delete; do
    run bash "$SCRIPT" "$cmd"
    [ "$status" -eq 2 ]
    [[ $output == *"$cmd needs its arguments"* ]]
    run bash "$SCRIPT" "$cmd" an-id extra
    [ "$status" -eq 2 ]
    [[ $output == *"unknown argument: extra"* ]]
  done
}

@test "set-limit needs an id and a positive whole number" {
  run bash "$SCRIPT" set-limit an-id
  [ "$status" -eq 2 ]
  for bad in 0 1.5 abc; do
    run bash "$SCRIPT" set-limit an-id "$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"set-limit needs a positive whole number"* ]]
  done
}

@test "set-label needs an id and a label, and a label may be named like a command" {
  run bash "$SCRIPT" set-label an-id
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" set-label an-id list
  [[ $output != *"one command only"* && $output != *"needs its arguments"* ]]
}

@test "replace-secret needs an id and a readable secret file or -" {
  run bash "$SCRIPT" replace-secret an-id
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" replace-secret an-id "$BATS_TEST_TMPDIR/missing.txt"
  [ "$status" -eq 2 ]
  [[ $output == *"no such file"* ]]
  run bash "$SCRIPT" replace-secret an-id -
  [[ $output != *"needs its arguments"* && $output != *"no such file"* ]]
}

@test "options are only accepted by the commands that use them" {
  run bash "$SCRIPT" list --yes
  [ "$status" -eq 2 ]
  [[ $output == *"--yes applies to delete only"* ]]
  run bash "$SCRIPT" disable an-id --json
  [ "$status" -eq 2 ]
  [[ $output == *"--json applies to list and show only"* ]]
  run bash "$SCRIPT" show an-id --user-limit 5
  [ "$status" -eq 2 ]
  [[ $output == *"apply to add only"* ]]
}

# --- routing past the root check: id and docker stubbed on PATH; docker records its arguments and
# --- whatever arrives on its stdin, so file vs stdin vs /dev/null can be told apart.

stub_docker() {
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  printf '#!/usr/bin/env bash\n[ "$1" = -u ] && echo 0 || command -p id "$@"\n' >"$STUB/id"
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
case " $* " in
  *" node "*)
    printf '%s\n' "$*" >>"$DOCKER_LOG"
    cat >"$STDIN_LOG"
    exit "${STUB_CLI_STATUS:-0}"
    ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/id" "$STUB/docker"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log STDIN_LOG=$BATS_TEST_TMPDIR/stdin.log
  : >"$DOCKER_LOG"
  : >"$STDIN_LOG"
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P"
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 \
    PROJECT=me-test HTTP_PORT=18090 >"$P/install.conf"
}

@test "add pipes the client JSON file into the container and keeps it out of the arguments" {
  stub_docker
  run bash "$SCRIPT" add "$JSON" --prefix "$P" --label "My App"
  [ "$status" -eq 0 ]
  grep -q -- "exec -T backend node src/cli/googleApp.js add --label My App" "$DOCKER_LOG"
  [ "$(cat "$STDIN_LOG")" = "$(cat "$JSON")" ]
  ! grep -q "client_secret" "$DOCKER_LOG"
}

@test "commands without a secret get /dev/null, not the caller's stdin" {
  stub_docker
  for cmd in "list" "show an-id" "disable an-id" "delete an-id --yes" "set-limit an-id 5" "set-label an-id Name"; do
    : >"$DOCKER_LOG"
    # shellcheck disable=SC2086
    run bash "$SCRIPT" $cmd --prefix "$P" <<<"leaked-from-caller"
    [ "$status" -eq 0 ]
    [ ! -s "$STDIN_LOG" ]
    grep -q -- "node src/cli/googleApp.js ${cmd%% *}" "$DOCKER_LOG"
  done
}

@test "replace-secret reads a file into the container, or the caller's stdin with -" {
  stub_docker
  printf '%s' 'GOCSPX-from-file' >"$BATS_TEST_TMPDIR/secret.txt"
  run bash "$SCRIPT" replace-secret an-id "$BATS_TEST_TMPDIR/secret.txt" --prefix "$P" <<<"ignored"
  [ "$status" -eq 0 ]
  [ "$(cat "$STDIN_LOG")" = "GOCSPX-from-file" ]
  grep -q -- "googleApp.js replace-secret an-id\$" "$DOCKER_LOG"
  run bash "$SCRIPT" replace-secret an-id - --prefix "$P" <<<"GOCSPX-from-stdin"
  [ "$status" -eq 0 ]
  [ "$(cat "$STDIN_LOG")" = "GOCSPX-from-stdin" ]
  ! grep -q "GOCSPX" "$DOCKER_LOG"
}

@test "-- lets a label start with a dash and is forwarded after the options" {
  stub_docker
  run bash "$SCRIPT" set-label --prefix "$P" -- an-id -draft
  [ "$status" -eq 0 ]
  grep -q -- "googleApp.js set-label -- an-id -draft" "$DOCKER_LOG"
  # Without --, the wrapper forwards the word and the CLI refuses it as an option (backend tests).
  run bash "$SCRIPT" set-label an-id -draft --prefix "$P"
  grep -q -- "googleApp.js set-label an-id -draft" "$DOCKER_LOG"
}

@test "the CLI's exit codes 1, 2 and 3 pass through" {
  stub_docker
  for code in 1 2 3; do
    STUB_CLI_STATUS=$code run bash "$SCRIPT" list --prefix "$P"
    [ "$status" -eq "$code" ]
  done
}

@test "--help lists every command" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  for cmd in show enable close disable delete set-limit set-label replace-secret; do
    [[ $output == *"$cmd"* ]]
  done
}
