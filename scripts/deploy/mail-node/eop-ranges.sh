#!/usr/bin/env bash
# Keeps the EOP ranges of the mail node host current (R-40, eop-panel-requirements.md section
# 2.10): port 25 of mailcow is open only to Exchange Online Protection, and Microsoft changes that
# list now and then. Runs every hour from mailexpert-eop-ranges.timer (or cron), installed by
# setup.sh.
#
# Each run asks the Microsoft 365 endpoints web service for the worldwide `version`, with the
# installation's own ClientRequestId (a GUID kept in node.env; without one the service answers 400).
# The same version as last time, with the sets filled, is a no-op. A new one fetches `endpoints`
# (Exchange service area, entries whose tcpPorts carry 25), checks every CIDR and then swaps the
# ipsets the firewall matches at once (ipset swap): IPv4 always, IPv6 only when mailcow runs with
# it. An empty or malformed list, an HTTP error (400, 429, 5xx) or no answer changes nothing: the
# last good list stays. The result also goes to a plain file, one CIDR per line
# (/var/lib/mailexpert-node/eop-ranges.txt), the same list the panel applies as mailcow forwarding
# hosts (R-12). EOP_RANGES_PING_URL in node.env gets a Healthchecks ping: success, or /fail with the
# reason.
#
#   eop-ranges.sh             check the version, update the sets when it changed
#   eop-ranges.sh --force     fetch the ranges even when the version did not change
#   eop-ranges.sh --dry-run   print what would change; change and ping nothing
#   eop-ranges.sh --restore   at boot: fill the sets from the last good list and put the firewall
#                             rules back (neither survives a reboot); asks Microsoft nothing
#
# Exit codes: 0 done or unchanged, 1 the update failed (the old list stays), 2 invalid input.
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
DRY_RUN=0
TMP_DIR=''
fail() {
  local reason=$1
  trap - ERR
  printf '[mailexpert] error: %s; the current EOP ranges stay\n' "$reason" >&2
  if [ "$DRY_RUN" = 0 ]; then send_ping "$PING_URL" fail "eop-ranges: $reason; the current list stays"; fi
  exit 1
}
# A command that fails outside fail() (ipset, iptables, a full disk) ends the run the same way: one
# line with the location, never the command (no secrets on the command lines here, but the same
# rule as the other deploy scripts), and a /fail ping.
set -E
trap 'fail "a command failed with status $? at ${BASH_SOURCE[0]##*/}:$LINENO"' ERR
trap '[ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"' EXIT

ipv6_on() {
  local dir
  dir=$(env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null) || dir=/opt/mailcow-dockerized
  mailcow_ipv6_enabled "$dir/mailcow.conf"
}

families() { echo 4; if ipv6_on; then echo 6; fi; }

# sets_filled: every family's set exists and is not empty.
sets_filled() {
  local family set count
  for family in $(families); do
    if [ "$family" = 4 ]; then set=$EOP_SET4; else set=$EOP_SET6; fi
    count=$(set_count "$set") || return 1
    [[ $count =~ ^[0-9]+$ ]] && [ "$count" -gt 0 ] || return 1
  done
}

# apply_sets <file>: every family's set holds the file's ranges of that family.
apply_sets() {
  local file=$1 family rc
  for family in $(families); do
    rc=0
    set_replace "$family" "$file" || rc=$?
    case $rc in
      0) ;;
      1)
        [ "$family" = 6 ] || fail "the list has no IPv4 range"
        warn "the list has no IPv6 range: the IPv6 set keeps what it had"
        ;;
      *) fail "ipset refused the new IPv$family set" ;;
    esac
  done
}

# save_list <file> <version>: the plain list for the panel, then the version (the version last: a
# run cut short before it fetches again).
save_list() {
  local file=$1 version=$2
  install -m 644 "$file" "$(ranges_file)"
  printf '%s\n' "$version" >"$(version_file).tmp"
  mv -f "$(version_file).tmp" "$(version_file)"
}

ensure_firewall() {
  local family result
  for family in $(families); do
    if result=$(node_firewall "$family"); then
      [ "$result" = unchanged ] || log "firewall (IPv$family): rules put in place"
    else
      warn "firewall (IPv$family): not in place"
    fi
  done
}

restore() {
  local file
  file=$(ranges_file)
  [ -s "$file" ] || fail "no saved list in $file: run eop-ranges.sh without --restore"
  apply_sets "$file"
  ensure_firewall
  log "restored $(grep -vc ':' "$file" || true) IPv4 and $(grep -c ':' "$file" || true) IPv6 EOP ranges from $file"
}

main() {
  local mode=update tmp status problem version stored='' count4 count6 diff_out
  while [ $# -gt 0 ]; do
    case $1 in
      --force) mode=force ;;
      --dry-run) DRY_RUN=1 ;;
      --restore) mode=restore ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
    shift
  done
  [ "$(id -u)" = 0 ] || die "run eop-ranges.sh as root"
  for tool in curl jq ipset flock; do command -v "$tool" >/dev/null || die "$tool is required (setup.sh installs it)" 2; done
  [ -f "$NODE_CONF" ] || die "$NODE_CONF is missing: run setup.sh first" 2
  PING_URL=$(env_get "$NODE_CONF" EOP_RANGES_PING_URL 2>/dev/null) || PING_URL=''
  CLIENT_ID=$(env_get "$NODE_CONF" EOP_CLIENT_REQUEST_ID 2>/dev/null) || CLIENT_ID=''
  mkdir -p "$NODE_STATE"
  take_lock "$NODE_STATE/eop-ranges.lock" 120 "another eop-ranges.sh"
  if [ "$mode" = restore ]; then
    restore
    return 0
  fi
  is_guid "$CLIENT_ID" || fail "EOP_CLIENT_REQUEST_ID in $NODE_CONF is not a GUID"

  TMP_DIR=$(mktemp -d)
  tmp=$TMP_DIR
  status=$(fetch /version/Worldwide "$tmp/version.json")
  if problem=$(http_problem version "$status"); then fail "$problem"; fi
  version=$(eop_latest_version <"$tmp/version.json") || fail "version: the answer has no version of ten digits"
  if [ -f "$(version_file)" ]; then stored=$(<"$(version_file)"); fi
  if [ "$mode" != force ] && [ "$version" = "$stored" ] && [ -s "$(ranges_file)" ] && sets_filled; then
    log "EOP ranges: version $version unchanged"
    if [ "$DRY_RUN" = 1 ]; then return 0; fi
    ensure_firewall
    send_ping "$PING_URL" success "eop-ranges: version $version unchanged"
    return 0
  fi

  status=$(fetch '/endpoints/Worldwide?ServiceAreas=Exchange' "$tmp/endpoints.json")
  if problem=$(http_problem endpoints "$status"); then fail "$problem"; fi
  eop_ranges_from_endpoints <"$tmp/endpoints.json" >"$tmp/ranges.txt" ||
    fail "endpoints: no Exchange entry with TCP 25 and an IPv4 range, or a malformed range"
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
  ensure_firewall
  log "EOP ranges: version ${stored:-none} -> $version, $count4 IPv4 and $count6 IPv6 ranges in place"
  send_ping "$PING_URL" success "eop-ranges: version $version, $count4 IPv4 and $count6 IPv6 ranges"
}

main "$@"
