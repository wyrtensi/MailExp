#!/usr/bin/env bash
# Runs the panel CLI (backend/src/cli/mailexpert.js) in the installed panel's backend container:
# the panel's administrator actions from the host's command line. A thin wrapper: it locates the
# installed panel the way the other deploy scripts do and passes every other argument through
# unchanged; the CLI inside the container checks them, acts through the panel's own services and
# journals the actor "cli".
#
#   mailexpert-cli.sh [--prefix /opt/mailexpert] [--] <group> <command> [options]
#   mailexpert-cli.sh domain list
#   mailexpert-cli.sh mailbox show anna@example.com --json
#
# --prefix is the wrapper's own option and comes before the group. In a terminal the container
# gets one too (the CLI's confirmations can ask); in a pipe or a script it does not, and an action
# that asks for confirmation then needs --yes.
#
# Exit codes: the CLI's own (0 done, 1 refused, 2 usage or a missing confirmation, 3 a failure);
# 2 as well when the wrapper's input or the installation is not right.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
exit_on_unexpected_failure

usage() {
  cat <<'EOF'
Usage: mailexpert-cli.sh [--prefix /opt/mailexpert] [--] <group> <command> [options]

Runs the panel CLI in the installed panel's backend container. Groups: mailbox, domain,
tenant, quarantine, jobs. "mailexpert-cli.sh <group> --help" lists a group's commands (it
needs the installed panel); options such as --json, --yes and --as go after the command.
--prefix is this wrapper's own option and comes first (default /opt/mailexpert).
Exit codes: the CLI's (0 done, 1 refused, 2 usage or a missing confirmation, 3 a failure).
EOF
}

main() {
  local prefix=/opt/mailexpert
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      --)
        shift
        break
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) break ;;
    esac
  done

  [ $# -gt 0 ] || die "a group and a command are required (see --help)" 2
  [[ $1 =~ ^[a-z][a-z-]*$ ]] || die "unknown group: $1 (see --help)" 2
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2

  [ "$(id -u)" = 0 ] || die "run mailexpert-cli.sh as root"
  load_install "$prefix"

  # A terminal on both ends: the container gets one, so a confirmation can be asked. Otherwise -T
  # keeps the output clean for a pipe (--json) and the CLI never waits for an answer.
  local -a tty=(-T)
  if [ -t 0 ] && [ -t 1 ]; then tty=(); fi
  local status=0
  app_compose exec "${tty[@]}" backend node src/cli/mailexpert.js "$@" || status=$?
  # exit, not return: a non-zero return would trip the ERR trap and turn the CLI's 1, 2 or 3 into 1.
  exit "$status"
}

main "$@"
