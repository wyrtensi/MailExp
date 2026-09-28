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
