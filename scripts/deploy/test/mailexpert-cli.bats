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
  [[ $output == *"mailbox, domain"* ]]
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

@test "--help after the group belongs to the CLI, not the wrapper" {
  # Not root in the test shell: the wrapper goes on to the container instead of printing its own
  # usage, and stops at the root check.
  if [ "$(id -u)" = 0 ]; then skip "runs as root"; fi
  run bash "$SCRIPT" domain --help
  [ "$status" -eq 1 ]
  [[ $output == *"run mailexpert-cli.sh as root"* ]]
}

@test "a missing installation is reported with exit 2" {
  if [ "$(id -u)" != 0 ]; then skip "needs root to get past the root check"; fi
  run bash "$SCRIPT" --prefix "$BATS_TEST_TMPDIR/none" domain list
  [ "$status" -eq 2 ]
  [[ $output == *"install.conf is missing"* ]]
}
