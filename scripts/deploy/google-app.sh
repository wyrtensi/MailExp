#!/usr/bin/env bash
# Manages the Google OAuth apps used to connect Gmail mailboxes: everything the panel's
# Settings -> Integrations -> "Google apps" screen does. A thin wrapper: it locates the installed
# panel the way the other deploy scripts do, then runs the backend container's own CLI
# (src/cli/googleApp.js), which does the parsing, validation and the work. Secrets (the client JSON
# of add, the new secret of replace-secret) are piped from a local file or stdin straight into the
# container and are never an argument, so they never sit in shell history or the process list.
#
#   google-app.sh add client_secret_<id>.apps.googleusercontent.com.json [--prefix /opt/mailexpert]
#                     [--label LABEL] [--user-limit N]
#   google-app.sh list [--json] [--prefix /opt/mailexpert]
#   google-app.sh show <id> [--json]            used and free seats, mailboxes, status
#   google-app.sh enable|close|disable <id>     status active / closed / disabled
#   google-app.sh delete <id> --yes             refused while mailboxes are bound
#   google-app.sh set-limit <id> <N>
#   google-app.sh set-label <id> <label>
#   google-app.sh replace-secret <id> <secret file | ->   new client secret from a file or stdin
#
# Exit codes: 0 done, 1 refused (unknown app, app still has mailboxes, invalid value), 2 invalid
# input or a wrapper error (not root, no installation, containers of another owner in the panel's
# compose project: the same as mailexpert-cli.sh), 3 the CLI failed (database or Redis down) or
# docker could not be asked. A label that starts with - goes after --:
# google-app.sh set-label <id> -- -label.
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
Usage: google-app.sh add <client JSON file> [--prefix /opt/mailexpert] [--label LABEL] [--user-limit N]
       google-app.sh list [--json] [--prefix /opt/mailexpert]
       google-app.sh show <id> [--json]
       google-app.sh enable|close|disable <id>
       google-app.sh delete <id> --yes
       google-app.sh set-limit <id> <N>
       google-app.sh set-label <id> <label>
       google-app.sh replace-secret <id> <secret file | ->
       (add -- before arguments that start with -)

The same operations as the panel's Settings -> Integrations -> "Google apps" screen. <id> is the
app id printed by list. add reads the OAuth client JSON downloaded from Google Cloud Console
(Credentials -> OAuth client -> Download JSON; named client_secret_<id>.apps.googleusercontent.com.json).
--label defaults to the JSON project_id, --user-limit defaults to 100. disable flags the app's
mailboxes for reconnect through another app; delete is refused while mailboxes are bound.
replace-secret reads the new client secret (plain text) from a file, or from stdin with "-"; it is
never an argument; on a terminal it is typed without echo.
A label (or any argument) that starts with - goes after --, e.g. set-label <id> -- -label.
Exit codes: 0 done, 1 refused (unknown app, app still has mailboxes, invalid value), 2 invalid
input or a wrapper error (not root, no installation, containers of another owner in the panel's
compose project), 3 the CLI failed (database or Redis down) or docker could not be asked.
EOF
}

is_command() {
  case $1 in
    add | list | show | enable | close | disable | delete | set-limit | set-label | replace-secret) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  local prefix=/opt/mailexpert command='' label='' user_limit='' json=0 yes=0 dashdash=0
  local -a positional=() pos_args=()
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      --label)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--label needs a value" 2; fi
        label=$2
        shift 2
        ;;
      --user-limit)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--user-limit needs a value" 2; fi
        user_limit=$2
        shift 2
        ;;
      --json)
        json=1
        shift
        ;;
      --yes)
        yes=1
        shift
        ;;
      --)
        dashdash=1
        shift
        # Everything after -- is an argument, never an option: the first word is the command
        # when none came before it.
        while [ $# -gt 0 ]; do
          if [ -z "$command" ]; then
            is_command "$1" || die "unknown command: $1 (see --help)" 2
            command=$1
          else
            positional+=("$1")
          fi
          shift
        done
        ;;
      -h | --help) usage && return 0 ;;
      -)
        positional+=("$1")
        shift
        ;;
      --*) die "unknown argument: $1 (see --help)" 2 ;;
      *)
        if [ -z "$command" ]; then
          is_command "$1" || die "unknown command: $1 (see --help)" 2
          command=$1
        elif is_command "$1" && [ "$command" != set-label ]; then
          die "one command only (see --help)" 2
        else
          positional+=("$1")
        fi
        shift
        ;;
    esac
  done

  [ -n "$command" ] || die "a command is required (see --help)" 2
  is_prefix "$prefix" || die "--prefix must be an absolute path without spaces or .. segments" 2
  [[ -z $user_limit || $user_limit =~ ^[1-9][0-9]*$ ]] || die "--user-limit must be a positive whole number" 2
  if [ -n "$label$user_limit" ] && [ "$command" != add ]; then
    die "--label and --user-limit apply to add only (see set-label, set-limit)" 2
  fi
  if [ "$json" = 1 ] && [ "$command" != list ] && [ "$command" != show ]; then die "--json applies to list and show only" 2; fi
  if [ "$yes" = 1 ] && [ "$command" != delete ]; then die "--yes applies to delete only" 2; fi

  local want=1 file='' stdin_source=none
  local -a cli_args=("$command")
  case $command in
    list) want=0 ;;
    set-limit | set-label | replace-secret) want=2 ;;
    *) want=1 ;;
  esac
  if [ "$command" = add ] && [ "${#positional[@]}" -lt 1 ]; then die "add needs the path to the client JSON file (see --help)" 2; fi
  [ "${#positional[@]}" -ge "$want" ] || die "$command needs its arguments (see --help)" 2
  [ "${#positional[@]}" -le "$want" ] || die "unknown argument: ${positional[$want]} (see --help)" 2

  case $command in
    add)
      file=${positional[0]}
      [ -f "$file" ] || die "no such file: $file" 2
      [ -r "$file" ] || die "cannot read $file" 2
      stdin_source='file'
      if [ -n "$label" ]; then cli_args+=(--label "$label"); fi
      if [ -n "$user_limit" ]; then cli_args+=(--user-limit "$user_limit"); fi
      ;;
    list) ;;
    set-limit)
      [[ ${positional[1]} =~ ^[1-9][0-9]*$ ]] || die "set-limit needs a positive whole number" 2
      pos_args=("${positional[@]}")
      ;;
    replace-secret)
      pos_args=("${positional[0]}")
      if [ "${positional[1]}" = - ]; then
        stdin_source='stdin'
      else
        file=${positional[1]}
        [ -f "$file" ] || die "no such file: $file" 2
        [ -r "$file" ] || die "cannot read $file" 2
        stdin_source='file'
      fi
      ;;
    *) pos_args=("${positional[@]}") ;;
  esac
  if [ "$json" = 1 ]; then cli_args+=(--json); fi
  if [ "$yes" = 1 ]; then cli_args+=(--yes); fi
  if [ "$dashdash" = 1 ] && [ "${#pos_args[@]}" -gt 0 ]; then cli_args+=(--); fi
  if [ "${#pos_args[@]}" -gt 0 ]; then cli_args+=("${pos_args[@]}"); fi

  [ "$(id -u)" = 0 ] || die "run google-app.sh as root" 2
  load_install "$prefix"
  # Before the secret is read or piped anywhere: exec would reach a neighbour's backend of the same
  # compose project name (lib/app.sh panel_exec_problem).
  guard_panel_exec 2 3

  # The CLI's own status (1 refused, 2 invalid input, 3 failed) is the script's: capture it, since
  # the ERR trap would otherwise turn every nonzero status into 1.
  local status=0
  case $stdin_source in
    file) app_compose exec -T backend node src/cli/googleApp.js "${cli_args[@]}" <"$file" || status=$? ;;
    stdin)
      if [ -t 0 ]; then
        # A terminal: read the secret without echo and hand it over as stdin (a here-string is
        # not an argument, so it stays out of the process list).
        local secret=''
        IFS= read -rsp "New client secret (input hidden): " secret || die "no secret was read" 2
        printf '\n' >&2
        [ -n "$secret" ] || die "the secret is empty" 2
        app_compose exec -T backend node src/cli/googleApp.js "${cli_args[@]}" <<<"$secret" || status=$?
      else
        app_compose exec -T backend node src/cli/googleApp.js "${cli_args[@]}" || status=$?
      fi
      ;;
    *) app_compose exec -T backend node src/cli/googleApp.js "${cli_args[@]}" </dev/null || status=$? ;;
  esac
  return "$status"
}

status=0
main "$@" || status=$?
exit "$status"
