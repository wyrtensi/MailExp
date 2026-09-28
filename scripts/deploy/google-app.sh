#!/usr/bin/env bash
# Adds a Google OAuth app (used to connect Gmail mailboxes) from the client JSON downloaded from
# Google Cloud Console (Credentials -> OAuth client -> Download JSON), or lists the apps already
# added. A thin wrapper: it locates the installed panel the way the other deploy scripts do, then
# pipes the file into the backend container's own CLI (src/cli/googleApp.js), which does the
# parsing and validation. The client secret is piped from the local file straight into the
# container and is never an argument, so it never sits in shell history or the process list.
#
#   google-app.sh add client_secret_<id>.apps.googleusercontent.com.json [--prefix /opt/mailexpert]
#                     [--label LABEL] [--user-limit N]
#   google-app.sh list [--prefix /opt/mailexpert]
#
# Exit codes: 0 done, 1 the container CLI reported a problem, 2 invalid input.
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
       google-app.sh list [--prefix /opt/mailexpert]

add reads the OAuth client JSON downloaded from Google Cloud Console (Credentials -> OAuth
client -> Download JSON; named client_secret_<id>.apps.googleusercontent.com.json) and adds it
as a Google app, the same as the panel's Settings -> Integrations -> "Google apps" screen.
--label defaults to the JSON project_id, --user-limit defaults to 100.
Exit codes: 0 done, 1 the container CLI reported a problem, 2 invalid input.
EOF
}

main() {
  local prefix=/opt/mailexpert command='' file='' label='' user_limit=''
  local -a cli_args=()
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
      -h | --help) usage && return 0 ;;
      --*) die "unknown argument: $1 (see --help)" 2 ;;
      *)
        if [ -z "$command" ]; then
          command=$1
        elif [ "$command" = add ] && [ -z "$file" ]; then
          file=$1
        elif [ "$1" = add ] || [ "$1" = list ]; then
          die "one command only (add or list)" 2
        else
          die "unknown argument: $1 (see --help)" 2
        fi
        shift
        ;;
    esac
  done

  case $command in
    add | list) ;;
    '') die "a command is required: add or list (see --help)" 2 ;;
    *) die "unknown command: $command (see --help)" 2 ;;
  esac
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
  [[ -z $user_limit || $user_limit =~ ^[1-9][0-9]*$ ]] || die "--user-limit must be a positive whole number" 2

  if [ "$command" = add ]; then
    [ -n "$file" ] || die "add needs the path to the client JSON file (see --help)" 2
    [ -f "$file" ] || die "no such file: $file" 2
    [ -r "$file" ] || die "cannot read $file" 2
    if [ -n "$label" ]; then cli_args+=(--label "$label"); fi
    if [ -n "$user_limit" ]; then cli_args+=(--user-limit "$user_limit"); fi
  fi

  [ "$(id -u)" = 0 ] || die "run google-app.sh as root"
  load_install "$prefix"

  if [ "$command" = add ]; then
    app_compose exec -T backend node src/cli/googleApp.js add "${cli_args[@]}" <"$file"
  else
    app_compose exec -T backend node src/cli/googleApp.js list
  fi
}

main "$@"
exit $?
