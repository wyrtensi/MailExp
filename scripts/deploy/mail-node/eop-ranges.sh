#!/usr/bin/env bash
# Keeps the EOP ranges of the mail node host current (R-40, eop-panel-requirements.md section
# 2.10): port 25 of mailcow is open only to Exchange Online Protection, and Microsoft changes that
# list now and then. Runs every hour from mailexpert-eop-ranges.timer (or cron), installed by
# setup.sh, and at boot with --restore.
#
# Each run asks the Microsoft 365 endpoints web service for the worldwide `version`, with the
# installation's own ClientRequestId (a GUID kept in node.env; without one the service answers 400).
# The same version as last time is no request more: the sets are compared with the saved list and
# refilled from it if they differ. A new version fetches `endpoints` (Exchange service area, entries
# whose tcpPorts carry 25), checks every CIDR and then swaps the ipsets the firewall matches at once
# (ipset swap). An empty, malformed or too wide list, an HTTP error (400, 429, 5xx) or no answer
# changes nothing: the last good list stays. The result also goes to a plain file, one CIDR per line
# (/var/lib/mailexpert-node/eop-ranges.txt), the same list the panel applies as mailcow forwarding
# hosts (R-12); a new version puts `eop_ranges_version_changed <old>-><new>` into the ping, the
# signal to bump the panel's copy.
#
# On the old node of a move (standby after node-backup.sh --tag move) a run asks Microsoft nothing:
# it closes mailcow's mail ports (25, 587, 993 and the rest) to everyone and pings EOP_RANGES_PING_URL
# only to fail, when postfix-mailcow, dovecot-mailcow or the watchdog run again: mail could reach the
# old node and never the new one, which pings the same check otherwise.
#
# Every run then checks the node and pings EOP_RANGES_PING_URL (node.env): success, or /fail with
# every problem, and exit 1:
# - the firewall rules are in place (rebuilt when they differ from what the last build left);
# - IPv4 always, IPv6 when mailcow runs with it or Docker has an IPv6 DOCKER-USER chain;
# - mailcow.conf still has the ENABLE_IPV6 that setup.sh set (mailcow's update.sh may turn it on);
# - with IPv6 off, nothing listens on mailcow's mail ports over IPv6 (docker-proxy on [::] would
#   bypass the firewall).
#
#   eop-ranges.sh             check the version, update the sets when it changed, check the node
#   eop-ranges.sh --force     fetch the ranges even when the version did not change
#   eop-ranges.sh --dry-run   print what would change; change and ping nothing
#   eop-ranges.sh --restore   at boot, before Docker: the sets from the last good list and the
#                             firewall rules (neither survives a reboot); asks Microsoft nothing
#
# Exit codes: 0 done or unchanged, 1 a step failed or the node has a problem, 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Installed by setup.sh next to the shared libraries, or run from a checkout of the repository.
if [ -f "$SCRIPT_DIR/common.sh" ]; then LIB_DIR=$SCRIPT_DIR; else LIB_DIR=$SCRIPT_DIR/../lib; fi
# shellcheck source=../lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=../lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# fetch <path> <output file>: GET from the web service with the ClientRequestId; prints the HTTP
# status (000 when there was no answer). The id goes through a curl config on a descriptor.
fetch() {
  local path=$1 out=$2 sep='?'
  [[ $path == *\?* ]] && sep='&'
  curl -sS -m 30 -o "$out" -w '%{http_code}' \
    -K <(printf 'url = "%s%s%sclientrequestid=%s"\n' "$EOP_ENDPOINTS" "$path" "$sep" "$CLIENT_ID") 2>/dev/null || true
}

# http_problem <what> <status>: why a web service answer is not usable.
http_problem() {
  case $2 in
    200) return 1 ;;
    400) echo "$1: HTTP 400 from the web service (the ClientRequestId is missing or not a GUID)" ;;
    429) echo "$1: HTTP 429 from the web service (too many requests; it asks to slow down)" ;;
    000 | '') echo "$1: no answer from $EOP_ENDPOINTS" ;;
    *) echo "$1: HTTP $2 from the web service" ;;
  esac
}

PING_URL=''
STANDBY_PING=''
FIREWALL_CLOSED=0
DRY_RUN=0
TMP_DIR=''
RESTORE=0
fail() {
  local reason=$1
  trap - ERR
  printf '[mailexpert] error: %s\n' "$reason" >&2
  if [ "$DRY_RUN" = 0 ]; then send_ping "$PING_URL" fail "eop-ranges: $reason"; fi
  exit 1
}
# A failure before anything was changed.
fail_keep() { fail "$1; the current EOP ranges stay"; }
# A command that fails outside fail() (ipset, iptables, a full disk) ends the run the same way: one
# line with the location, never the command (no secrets on the command lines here, but the same
# rule as the other deploy scripts), and a /fail ping.
set -E
trap 'fail "a command failed with status $? at ${BASH_SOURCE[0]##*/}:$LINENO"' ERR
trap '[ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"' EXIT

mailcow_conf() {
  local dir
  dir=$(env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null) || dir=/opt/mailcow-dockerized
  printf '%s/mailcow.conf\n' "$dir"
}

# families: 4, and 6 when mailcow runs with IPv6, Docker has an IPv6 DOCKER-USER chain, or (at boot,
# before Docker) the IPv6 rules were in place before.
families() {
  echo 4
  if mailcow_ipv6_enabled "$(mailcow_conf)" || ipt 6 -S DOCKER-USER >/dev/null 2>&1 ||
    { [ "$RESTORE" = 1 ] && [ -f "$(firewall_state_file 6)" ]; }; then
    echo 6
  fi
}

# sets_match <file>: every family's set holds exactly the file's ranges of that family.
sets_match() {
  local family
  for family in $(families); do set_matches "$family" "$1" || return 1; done
}

# apply_sets <file>: every family's set holds the file's ranges of that family.
apply_sets() {
  local file=$1 family rc
  for family in $(families); do
    rc=0
    set_replace "$family" "$file" || rc=$?
    case $rc in
      0) ;;
      1) fail_keep "the list has no IPv4 range" ;;
      *) fail "ipset refused the new IPv$family set; the live set stays as it was" ;;
    esac
  done
}

# save_list <file> <version>: the plain list for the panel, then the version (the version last: a
# run cut short fetches again), each through a temporary file and a rename.
save_list() {
  local file=$1 version=$2
  cp "$file" "$(ranges_file).tmp"
  chmod 644 "$(ranges_file).tmp"
  mv -f "$(ranges_file).tmp" "$(ranges_file)"
  printf '%s\n' "$version" >"$(version_file).tmp"
  mv -f "$(version_file).tmp" "$(version_file)"
}

# saved_list <out file>: the saved list, checked as a fresh one is; status 1 when it is missing,
# empty or would not pass.
saved_list() {
  [ -s "$(ranges_file)" ] && eop_ranges_check <"$(ranges_file)" >"$1"
}

# node_problems: one line per problem of the firewall and of mailcow's IPv6 setting.
node_problems() {
  local family result conf want have listeners
  conf=$(mailcow_conf)
  for family in $(families); do
    if result=$(node_firewall "$family" "$RESTORE"); then
      [ "$result" = unchanged ] || log "firewall (IPv$family): rules put in place"
    else
      echo "firewall (IPv$family): the rules are not in place"
    fi
  done
  [ -f "$conf" ] || { echo "$conf is missing"; return 0; }
  want=$(env_get "$NODE_CONF" MAILCOW_ENABLE_IPV6 2>/dev/null) || want=''
  have=$(env_get "$conf" ENABLE_IPV6 2>/dev/null) || have=''
  if [ -n "$want" ] && [ "${have,,}" != "${want,,}" ]; then
    echo "mailcow.conf has ENABLE_IPV6=${have:-(none)}, setup.sh set $want (mailcow's update.sh changes it): run setup.sh again, then docker compose down && docker compose up -d"
  fi
  if [ "$RESTORE" = 0 ] && ! mailcow_ipv6_enabled "$conf"; then
    listeners=$(ipv6_listeners "$conf" | paste -sd, -)
    if [ -n "$listeners" ]; then
      echo "ports $listeners listen on IPv6 while mailcow runs without it: that traffic bypasses the firewall; run setup.sh (it binds them to IPv4), then docker compose down && docker compose up -d"
    fi
  fi
}

# finish <message>: the node checks, then the ping: success with the message, or /fail with the
# problems (and the message).
finish() {
  local message=$1 problems
  problems=$(node_problems)
  if [ -n "$problems" ]; then
    fail "$(paste -sd';' - <<<"$problems" | sed 's/;/; /g')${message:+ ($message)}"
  fi
  [ -z "$message" ] || send_ping "$PING_URL" success "eop-ranges: $message"
}

# standby_run: the hourly run of a standby node: the closed firewall and the node checks; /fail
# (the only ping) when a mail service runs again.
standby_run() {
  local problems running dir
  [ "$DRY_RUN" = 0 ] || { log "dry run: a standby node only closes its mail ports"; return 0; }
  problems=$(node_problems)
  dir=$(env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null) || dir=/opt/mailcow-dockerized
  running=$(mailcow_running "$dir" "${STANDBY_SERVICES[@]}" | paste -sd' ' -)
  if [ -n "$running" ]; then
    send_ping "$STANDBY_PING" fail "eop-ranges: standby node (moved away) runs $running: stop them (docker compose stop $running in $dir); mail must reach the new node only"
    die "standby node runs $running: stop them; mail must reach the new node only"
  fi
  if [ -n "$problems" ]; then die "$(paste -sd';' - <<<"$problems" | sed 's/;/; /g')"; fi
  log "standby node: mail ports closed, postfix and dovecot stopped"
}

restore() {
  saved_list "$TMP_DIR/saved.txt" || fail "no valid saved list in $(ranges_file): run eop-ranges.sh without --restore"
  apply_sets "$TMP_DIR/saved.txt"
  finish ''
  log "restored $(grep -vc ':' "$TMP_DIR/saved.txt" || true) IPv4 and $(grep -c ':' "$TMP_DIR/saved.txt" || true) IPv6 EOP ranges"
}

main() {
  local mode=update tmp status problem version stored='' count4 count6 diff_out changed=''
  while [ $# -gt 0 ]; do
    case $1 in
      --force) mode=force ;;
      --dry-run) DRY_RUN=1 ;;
      --restore) mode=restore RESTORE=1 ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
    shift
  done
  [ "$(id -u)" = 0 ] || die "run eop-ranges.sh as root"
  for tool in curl jq ipset iptables flock ss; do command -v "$tool" >/dev/null || die "$tool is required (setup.sh installs it)" 2; done
  [ -f "$NODE_CONF" ] || die "$NODE_CONF is missing: run setup.sh first" 2
  PING_URL=$(env_get "$NODE_CONF" EOP_RANGES_PING_URL 2>/dev/null) || PING_URL=''
  if [ -f "$(node_standby_file)" ]; then
    log "standby node (moved away): mail ports closed to everyone, the check is pinged only if postfix or dovecot run"
    STANDBY_PING=$PING_URL PING_URL='' FIREWALL_CLOSED=1
  fi
  CLIENT_ID=$(env_get "$NODE_CONF" EOP_CLIENT_REQUEST_ID 2>/dev/null) || CLIENT_ID=''
  mkdir -p "$NODE_STATE"
  take_lock "$NODE_STATE/eop-ranges.lock" 120 "another eop-ranges.sh"
  TMP_DIR=$(mktemp -d)
  tmp=$TMP_DIR
  if docker_nftables; then
    fail "Docker runs its nftables firewall backend ($DOCKER_DAEMON_JSON): there is no DOCKER-USER chain and these rules would filter nothing; switch Docker back to iptables or firewall the node by hand"
  fi
  if [ "$mode" = restore ]; then
    restore
    return 0
  fi
  if [ "$FIREWALL_CLOSED" = 1 ]; then
    standby_run
    return 0
  fi
  is_guid "$CLIENT_ID" || fail_keep "EOP_CLIENT_REQUEST_ID in $NODE_CONF is not a GUID"

  status=$(fetch /version/Worldwide "$tmp/version.json")
  if problem=$(http_problem version "$status"); then fail_keep "$problem"; fi
  version=$(eop_latest_version <"$tmp/version.json") || fail_keep "version: the answer has no version of ten digits"
  if [ -f "$(version_file)" ]; then stored=$(<"$(version_file)"); fi
  if [ "$mode" != force ] && [ "$version" = "$stored" ] && saved_list "$tmp/saved.txt"; then
    log "EOP ranges: version $version unchanged"
    if [ "$DRY_RUN" = 1 ]; then return 0; fi
    if ! sets_match "$tmp/saved.txt"; then
      log "EOP ranges: the sets differ from the saved list; filled again from it"
      apply_sets "$tmp/saved.txt"
    fi
    finish "version $version unchanged"
    return 0
  fi

  status=$(fetch '/endpoints/Worldwide?ServiceAreas=Exchange' "$tmp/endpoints.json")
  if problem=$(http_problem endpoints "$status"); then fail_keep "$problem"; fi
  eop_ranges_from_endpoints <"$tmp/endpoints.json" >"$tmp/ranges.txt" ||
    fail_keep "endpoints: no Exchange entry with TCP 25 and an IPv4 range, or a malformed or too wide range"
  count4=$(grep -vc ':' "$tmp/ranges.txt" || true)
  count6=$(grep -c ':' "$tmp/ranges.txt" || true)
  if [ "$DRY_RUN" = 1 ]; then
    log "EOP ranges: version ${stored:-none} -> $version, $count4 IPv4 and $count6 IPv6 ranges (dry run: nothing changed)"
    diff_out=$(diff -u "$(ranges_file)" "$tmp/ranges.txt" 2>/dev/null || true)
    if [ -f "$(ranges_file)" ]; then printf '%s\n' "${diff_out:-(the ranges are the same)}"; else cat "$tmp/ranges.txt"; fi
    return 0
  fi
  apply_sets "$tmp/ranges.txt"
  save_list "$tmp/ranges.txt" "$version"
  log "EOP ranges: version ${stored:-none} -> $version, $count4 IPv4 and $count6 IPv6 ranges in place"
  # The panel keeps its own copy (backend eopRanges.js): a new version is the signal to bump it.
  if [ -n "$stored" ] && [ "$stored" != "$version" ]; then
    changed="eop_ranges_version_changed $stored->$version, "
    warn "the EOP ranges changed ($stored -> $version): update the panel's copy (backend/scripts/update-eop-ranges.mjs)"
  fi
  finish "${changed}version $version, $count4 IPv4 and $count6 IPv6 ranges"
}

main "$@"
