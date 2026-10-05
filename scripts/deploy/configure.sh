#!/usr/bin/env bash
# Stores the owner's secrets for install.sh: KEY=VALUE lines on stdin, one per line. Secrets are
# never accepted as arguments (shell history, process list, cloud-init user-data) and values are
# never printed.
#
#   ssh root@<host> /opt/mailexpert/app/scripts/deploy/configure.sh < secrets.env
#
# Exit codes: 0 stored, 1 failure (for example install.sh held the lock too long), 2 invalid input,
# nothing stored (every problem is listed).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"
# shellcheck source=lib/backup.sh
. "$SCRIPT_DIR/lib/backup.sh"
exit_on_unexpected_failure

# How long to wait for a running install.sh, which holds the lock for minutes on a first install.
LOCK_TIMEOUT=${MAILEXPERT_LOCK_TIMEOUT:-600}
[[ $LOCK_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_LOCK_TIMEOUT must be a number of seconds" 2

usage() {
  cat <<'EOF'
Usage: configure.sh [--prefix /opt/mailexpert] < file-with-KEY=VALUE-lines

Panel (<prefix>/.env):     CF_ACCESS_ISSUER, CF_ACCESS_AUDIENCE, AUTH_GOOGLE_CLIENT_ID,
                           AUTH_GOOGLE_CLIENT_SECRET, HEALTHCHECK_PING_URL, BACKUP_PING_URL
Backups (<prefix>/.env):   RESTIC_REPOSITORY (s3:https://<endpoint>/<bucket>[/<path>], any
                           S3-compatible storage), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
                           AWS_DEFAULT_REGION (only when the storage needs one), RESTIC_PASSWORD
Edge (<prefix>/edge/.env): TUNNEL_TOKEN, DNS_API_TOKEN
A key given again replaces the stored value, except RESTIC_PASSWORD and the generated keys
(SESSION_SECRET, ENCRYPTION_KEY, DB_PASSWORD, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY): those are
accepted only when absent or identical. On a new server restore.sh takes the generated keys
from the backup. Then run install.sh again.
EOF
}

# key_target <key>: app, edge or once; status 1 for keys configure.sh does not store.
key_target() {
  local key=$1 known
  for known in "${APP_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo app; return 0; }; done
  for known in "${EDGE_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo edge; return 0; }; done
  for known in "${WRITE_ONCE_KEYS[@]}"; do [ "$known" = "$key" ] && { echo once; return 0; }; done
  return 1
}

# tunnel_token_ok <value>: status 0 when the value looks like the token of a remotely managed
# Cloudflare tunnel: base64 of a JSON object with the account tag "a", the tunnel id "t" and the
# secret "s". Missing padding is tolerated; jq is not needed (configure.sh may run before
# install.sh installed it).
tunnel_token_ok() {
  local token=$1 json field re
  [[ $token =~ ^[A-Za-z0-9+/]{40,}={0,2}$ ]] || return 1
  while [ $((${#token} % 4)) -ne 0 ]; do token+='='; done
  json=$(printf '%s' "$token" | base64 -d 2>/dev/null) || return 1
  for field in a t s; do
    re="\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]+\""
    [[ $json =~ $re ]] || return 1
  done
}

# value_problem <key> <value>: prints what is wrong with the value, nothing when it is fine. The
# messages never quote the value.
value_problem() {
  case $1 in
    CF_ACCESS_ISSUER) [[ $2 =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com$ ]] || echo "must be https://<TEAM>.cloudflareaccess.com" ;;
    CF_ACCESS_AUDIENCE) [[ $2 =~ ^[0-9a-f]{64}$ ]] || echo "must be the Application Audience (AUD) tag of the Access application: 64 lowercase hex characters" ;;
    TUNNEL_TOKEN) tunnel_token_ok "$2" || echo "must be the token of a remotely managed tunnel (the long base64 value after --token in the install command Zero Trust shows)" ;;
    HEALTHCHECK_PING_URL | BACKUP_PING_URL) [[ $2 =~ ^https:// ]] || echo "must be an https:// URL" ;;
    RESTIC_REPOSITORY) restic_repository_ok "$2" || echo "must be s3:https://<endpoint>/<bucket>[/<path>]" ;;
    RESTIC_PASSWORD) [ "${#2}" -ge 16 ] || echo "must be at least 16 characters" ;;
    AWS_DEFAULT_REGION) [[ $2 =~ ^[a-z0-9-]{2,32}$ ]] || echo "must be a region name such as us-east-1" ;;
  esac
  return 0
}

# fail_on_errors <error...>: prints every error and exits 2 when there is any.
fail_on_errors() {
  [ "$#" -gt 0 ] || return 0
  printf '[mailexpert] error: %s\n' "$@" >&2
  die "nothing was written" 2
}

main() {
  local prefix=/opt/mailexpert line key value target problem current file old i n=0
  local -a keys=() values=() targets=() errors=()
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unexpected argument (not shown): secrets are read from stdin as KEY=VALUE lines, never from arguments" 2 ;;
    esac
  done
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
  if [ -t 0 ]; then log "paste KEY=VALUE lines, then press Ctrl-D"; fi

  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    if [ "$key" = "$line" ] || ! [[ $key =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      errors+=("line $n is not KEY=VALUE (content not shown)")
      continue
    fi
    value=${line#*=}
    if ! target=$(key_target "$key"); then errors+=("$key: not a key configure.sh stores"); continue; fi
    if [ -z "$value" ]; then errors+=("$key: empty value"); continue; fi
    if ! env_value_ok "$value"; then
      errors+=("$key: the value must be one token without spaces, quotes, \$, # or backslash")
      continue
    fi
    problem=$(value_problem "$key" "$value")
    if [ -n "$problem" ]; then errors+=("$key: $problem"); continue; fi
    keys+=("$key") values+=("$value") targets+=("$target")
  done
  fail_on_errors "${errors[@]}"
  [ "${#keys[@]}" -gt 0 ] || die "no KEY=VALUE lines on stdin (see --help)" 2

  # install.sh generates keys in the same .env: the checks and the writes below run under its lock.
  mkdir -p "$prefix/edge" "$prefix/state"
  chmod 700 "$prefix/edge" "$prefix/state"
  take_install_lock "$prefix/state" "$LOCK_TIMEOUT" configure.sh
  for i in "${!keys[@]}"; do
    [ "${targets[i]}" = once ] || continue
    current=$(env_get "$prefix/.env" "${keys[i]}") || current=
    if [ -n "$current" ] && [ "$current" != "${values[i]}" ]; then
      errors+=("${keys[i]}: $prefix/.env already has a different value; it is never replaced here (on a new server restore.sh brings ENCRYPTION_KEY and the other generated keys from the backup; a wrong RESTIC_PASSWORD is corrected by hand)")
    fi
  done
  fail_on_errors "${errors[@]}"

  for i in "${!keys[@]}"; do
    if [ "${targets[i]}" = edge ]; then file=$prefix/edge/.env; else file=$prefix/.env; fi
    old=$(env_get "$file" "${keys[i]}") || old=
    if [ "$old" = "${values[i]}" ]; then
      log "${keys[i]}: unchanged"
    else
      env_set "$file" "${keys[i]}" "${values[i]}"
      log "${keys[i]}: stored in $file"
    fi
  done
  log "run install.sh again to apply"
}

main "$@"
exit $?
