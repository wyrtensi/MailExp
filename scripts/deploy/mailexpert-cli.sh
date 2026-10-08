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
#   mailexpert-cli.sh agent token issue --out /root/agent-token --yes
#
# The one exception to "unchanged": `agent token ... --out FILE` names a file on this host, not in
# the container. The wrapper creates FILE itself (0600, never over an existing one), runs the CLI
# with --out - (the token alone on stdout) without a terminal and writes that into FILE; on any
# failure the file is removed. A rotation then needs --yes, as in any script.
#
# --prefix is the wrapper's own option and comes before the group. In a terminal the container
# gets one too (the CLI's confirmations can ask); in a pipe or a script it does not, and an action
# that asks for confirmation then needs --yes. With --json it never gets one either: a terminal
# would merge the CLI's stderr into its stdout and break the JSON.
#
# Exit codes: the CLI's own (0 done, 1 refused, 2 usage or a missing confirmation, 3 a failure);
# 2 when the wrapper's input or the installation is not right (not root included); 3 when docker
# cannot run the CLI (the backend container is not running, the image predates the CLI, docker
# itself failed).
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

CLI_PATH=src/cli/mailexpert.js

usage() {
  cat <<'EOF'
Usage: mailexpert-cli.sh [--prefix /opt/mailexpert] [--] <group> <command> [options]

Runs the panel CLI in the installed panel's backend container. Groups: mailbox, domain,
tenant, quarantine, jobs, access, user, settings, sso, integration, node, eop, seats, agent,
invite, system-email, audit, account, rule.
stdin reaches the CLI (access token, sso add, sso set --secret, integration microsoft set
--secret, node config set --api-key-stdin, system-email set --password-stdin, account create
and account set-connection --password-stdin/--smtp-password-stdin read their secret from it;
rule create and rule set read the rule's JSON from it: their --file is a path in the
container). "mailexpert-cli.sh
<group> --help" lists a group's commands (it needs the installed panel); options such as --json,
--yes and --as go after the command. agent token issue --out FILE writes the token to FILE on
this host (0600).
--prefix is this wrapper's own option and comes first (default /opt/mailexpert).
Exit codes: the CLI's (0 done, 1 refused, 2 usage or a missing confirmation, 3 a failure);
2 for the wrapper's own input, root or installation problems; 3 when docker cannot run the CLI.
EOF
}

# exec_tty_flag <stdin is a terminal: 0|1> <stdout is a terminal: 0|1> <args...>: prints -T when
# the container must get no terminal: no terminal on either end, or --json among the arguments
# (a terminal merges stderr into stdout). Prints nothing when it gets one.
exec_tty_flag() {
  local stdin_tty=$1 stdout_tty=$2 arg
  shift 2
  for arg in "$@"; do
    if [ "$arg" = --json ]; then
      printf '%s\n' -T
      return 0
    fi
  done
  if [ "$stdin_tty" = 1 ] && [ "$stdout_tty" = 1 ]; then return 0; fi
  printf '%s\n' -T
}

# token_out_file <args...>: prints FILE of `agent token ... --out FILE` (or --out=FILE) when FILE is
# a file on this host, not "-"; fails otherwise.
token_out_file() {
  [ "${1-}" = agent ] || return 1
  [ "${2-}" = token ] || return 1
  shift 2
  local value
  while [ $# -gt 0 ]; do
    case $1 in
      --out)
        value=${2-}
        if [ -z "$value" ] || [ "$value" = - ]; then return 1; fi
        printf '%s\n' "$value"
        return 0
        ;;
      --out=*)
        value=${1#--out=}
        if [ -z "$value" ] || [ "$value" = - ]; then return 1; fi
        printf '%s\n' "$value"
        return 0
        ;;
    esac
    shift
  done
  return 1
}


# The token file of `agent token --out` until the CLI has written it whole; removed on the way out.
TOKEN_FILE_PENDING=
# shellcheck disable=SC2317,SC2329 # invoked only through `trap remove_pending_token_file EXIT` in main
remove_pending_token_file() {
  if [ -n "$TOKEN_FILE_PENDING" ]; then rm -f -- "$TOKEN_FILE_PENDING"; fi
}

main() {
  exit_on_unexpected_failure
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

  [ "$(id -u)" = 0 ] || die "run mailexpert-cli.sh as root" 2
  load_install "$prefix"

  # agent token --out FILE: FILE is on this host. The CLI prints the token alone (--out -) and the
  # wrapper writes it there.
  local out_file=""
  if out_file=$(token_out_file "$@"); then
    if [ -e "$out_file" ] || [ -L "$out_file" ]; then die "--out: $out_file exists already: give a new file" 2; fi
    local -a cli_args=()
    local next=0 arg
    for arg in "$@"; do
      if [ "$next" = 1 ]; then
        cli_args+=(-)
        next=0
        continue
      fi
      case $arg in
        --out) cli_args+=("$arg"); next=1 ;;
        --out=*) cli_args+=(--out=-) ;;
        *) cli_args+=("$arg") ;;
      esac
    done
    set -- "${cli_args[@]}"
  else
    out_file=""
  fi

  # Checked first, so that a failure of docker is never read as the CLI's own exit code.
  local running
  running=$(app_compose ps --status running --services 2>/dev/null) || die "docker compose failed for the panel in $prefix" 3
  grep -qx backend <<<"$running" || die "the panel's backend container is not running (start it: docker compose up -d)" 3
  # stdin stays for the CLI itself (`access token` and the sso and integration secrets are read
  # from it): exec would forward it.
  app_compose exec -T backend test -f "$CLI_PATH" </dev/null ||
    die "the installed panel's image has no CLI ($CLI_PATH): update the panel first" 3

  local in_tty=0 out_tty=0 flag
  if [ -t 0 ]; then in_tty=1; fi
  if [ -t 1 ]; then out_tty=1; fi
  flag=$(exec_tty_flag "$in_tty" "$out_tty" "$@")
  local -a tty=()
  if [ -n "$flag" ]; then tty=("$flag"); fi
  local status=0
  if [ -n "$out_file" ]; then
    # Made here, only the owner reads it, never over a file that appeared meanwhile.
    (umask 077 && set -o noclobber && : >"$out_file") 2>/dev/null || die "--out: $out_file could not be created" 2
    # Until the CLI has written it whole, the file goes on any way out: a failure, die, Ctrl-C or
    # TERM (the signal traps exit, which runs the EXIT trap).
    TOKEN_FILE_PENDING=$out_file
    trap remove_pending_token_file EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    app_compose exec -T backend node "$CLI_PATH" "$@" >"$out_file" || status=$?
    if [ "$status" = 0 ]; then
      TOKEN_FILE_PENDING=
      printf 'token written to %s (0600): give it to setup.sh --agent-token-file on the node\n' "$out_file" >&2
    fi
  else
    app_compose exec "${tty[@]}" backend node "$CLI_PATH" "$@" || status=$?
  fi
  # 125 to 127: docker or the container could not start the command at all.
  if [ "$status" -ge 125 ] && [ "$status" -le 127 ]; then
    die "docker could not run the CLI in the backend container (status $status)" 3
  fi
  # exit, not return: a non-zero return would trip the ERR trap and turn the CLI's 1, 2 or 3 into 1.
  exit "$status"
}

# Sourced by the tests for exec_tty_flag and token_out_file; run otherwise.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
