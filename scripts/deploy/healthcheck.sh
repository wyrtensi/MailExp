#!/usr/bin/env bash
# Checks the panel every 5 minutes (mailexpert-health.timer): readiness, containers, free disk,
# the age of the last backup, the host updater (a problem when mailexpert-updater.path is installed
# but not active) and, with Caddy and a public certificate, its expiry. On success it
# pings HEALTHCHECK_PING_URL, otherwise <url>/fail with the list of problems. The monitoring
# service alerts the owner (in Telegram, through its own integration) on a failure and when the
# pings stop, so a server that is down, or cannot run this script, is noticed too.
#
# Exit codes: 0 healthy (or skipped: a standby server, an update, rollback or restore running),
# 1 problems found, 2 invalid input.
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
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib/health.sh
. "$LIB_DIR/health.sh"
exit_on_unexpected_failure

# Free space below this share of a disk is a problem.
MIN_FREE_PCT=${MAILEXPERT_MIN_FREE_PCT:-15}

usage() {
  cat <<'EOF'
Usage: healthcheck.sh [--prefix /opt/mailexpert]

Checks readiness, containers, free disk (MAILEXPERT_MIN_FREE_PCT, default 15), the age of the
last backup, the host updater (mailexpert-updater.path installed but not active) and the
certificate of <DIRECT_HOST>; pings HEALTHCHECK_PING_URL (or <url>/fail).
Exit codes: 0 healthy or skipped, 1 problems found, 2 invalid input.
EOF
}

# cert_expiry_epoch: the expiry of the certificate Caddy serves for <DIRECT_HOST>, from curl's
# TLS report.
cert_expiry_epoch() {
  local raw
  raw=$(curl -sv -o /dev/null -m 10 --resolve "$CFG_DIRECT_HOST:443:127.0.0.1" "https://$CFG_DIRECT_HOST/api/health" 2>&1 |
    sed -n 's/^\* *expire date: //p' | head -n 1)
  [ -n "$raw" ] || return 1
  date -d "$raw" +%s
}

# collect_problems: one line per problem.
collect_problems() {
  local now ps services root path used finished='' since='' expiry foreign kind project line
  local -a paths=(/)
  now=$(date +%s)
  panel_ready || echo "ready: http://127.0.0.1:$CFG_HTTP_PORT/api/health/ready does not answer 200"
  if ps=$(app_compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null); then
    service_problems frontend backend postgres redis <<<"$ps"
  else
    echo "containers: docker compose ps failed for $CFG_PROJECT"
  fi
  # Inside ||: a Docker that does not answer is reported by the lines above and below, it must not
  # end this function (the ERR trap) before the /fail ping.
  for kind in panel edge; do
    foreign=$("${kind}_foreign_objects" 2>/dev/null) || foreign=''
    project=$CFG_PROJECT
    if [ "$kind" = edge ]; then project=$CFG_EDGE_PROJECT; fi
    while IFS= read -r line; do
      if [ -n "$line" ]; then echo "ownership: compose project $project holds another owner's $line"; fi
    done <<<"$foreign"
  done
  services=$(edge_services)
  if [ -n "$services" ]; then
    if ps=$(edge_compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null); then
      # shellcheck disable=SC2086 # one service name per word
      service_problems $services <<<"$ps"
    else
      echo "containers: docker compose ps failed for $CFG_EDGE_PROJECT"
    fi
  fi
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=''
  if [ -n "$root" ]; then paths+=("$root"); fi
  for path in "${paths[@]}"; do
    used=$(df -P "$path" 2>/dev/null | awk 'NR == 2 {print $5}') || used=''
    disk_problem "$path" "$used" "$MIN_FREE_PCT"
  done
  if backup_configured "$ENV_FILE"; then
    if [ -f "$STATE_DIR/backup-last.json" ]; then
      finished=$(json_number finished_epoch <"$STATE_DIR/backup-last.json") || finished=''
    fi
    if [ -f "$STATE_DIR/backup-since" ]; then since=$(<"$STATE_DIR/backup-since"); fi
    backup_age_problem "$now" "$finished" "$since"
  else
    echo "backup: not configured (add the restic keys with configure.sh, then run install.sh)"
  fi
  updater_problem "$(updater_state)"
  if grep -qx caddy <<<"$services" && [ "$CFG_EDGE_TLS" = acme ]; then
    expiry=$(cert_expiry_epoch) || expiry=''
    cert_problem "$CFG_DIRECT_HOST" "$now" "$expiry"
  fi
}

main() {
  local prefix=/opt/mailexpert url problems line
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  [[ $MIN_FREE_PCT =~ ^[0-9]+$ ]] || die "MAILEXPERT_MIN_FREE_PCT must be a number" 2
  [ "$(id -u)" = 0 ] || die "run healthcheck.sh as root"
  load_install "$prefix"
  if is_standby; then
    log "standby server: health check skipped"
    return 0
  fi
  if lock_held "$STATE_DIR/update.lock"; then
    log "an update, rollback or restore is running: health check skipped"
    return 0
  fi
  url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=
  problems=$(collect_problems)
  if [ -z "$problems" ]; then
    send_ping "$url" success healthy
    log "healthy"
    return 0
  fi
  while IFS= read -r line; do
    printf '[mailexpert] problem: %s\n' "$line" >&2
  done <<<"$problems"
  send_ping "$url" fail "$problems"
  # exit, not return: a nonzero return from main would trip the ERR trap and print a
  # spurious "a command failed" line.
  exit 1
}

main "$@"; exit $?
