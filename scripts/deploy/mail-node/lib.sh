# shellcheck shell=bash
# The mail node host's own pieces (docs/operations/mail-node.md, sections 3 and 4): the files of
# mailcow that have no API, the firewall in front of mailcow's published ports and the EOP ranges
# it lets in. Shared by setup.sh (R-39) and eop-ranges.sh (R-40); sourced, never executed. Needs
# common.sh and env.sh (log, die, env_get, env_set) loaded first.

# Where things live on the host; the tests move them.
NODE_CONF=${MAILEXPERT_NODE_CONF:-/etc/mailexpert-node/node.env}
NODE_STATE=${MAILEXPERT_NODE_STATE:-/var/lib/mailexpert-node}
# shellcheck disable=SC2034 # read by setup.sh
NODE_DIR=${MAILEXPERT_NODE_DIR:-/opt/mailexpert-node}

# The Microsoft 365 endpoints web service, worldwide instance (eop-panel-requirements.md, 2.10).
# shellcheck disable=SC2034 # read by eop-ranges.sh
EOP_ENDPOINTS=https://endpoints.office.com
# The ipsets the port 25 rules match, and the chain DOCKER-USER jumps to.
EOP_SET4=mailexpert-eop4
EOP_SET6=mailexpert-eop6
NODE_CHAIN=MAILEXPERT-NODE
# Container ports (DOCKER-USER sees the packet after Docker's DNAT, so a host port moved with
# SMTP_PORT=<NODE_IP>:25 or SUBMISSION_PORT=10587 is still matched): 25 only from EOP, submission
# and IMAPS only from the panel, the other mail ports from nobody.
PANEL_PORTS=587,993
CLOSED_PORTS=110,143,465,995,4190

# Managed blocks in files the owner may edit too.
DOVECOT_BEGIN='# BEGIN MailExpert: dovecot-extra.conf (managed by scripts/deploy/mail-node/setup.sh, do not edit)'
DOVECOT_END='# END MailExpert: dovecot-extra.conf'

ranges_file() { printf '%s/eop-ranges.txt\n' "$NODE_STATE"; }
version_file() { printf '%s/eop-version\n' "$NODE_STATE"; }
firewall_state_file() { printf '%s/firewall-%s.rules\n' "$NODE_STATE" "$1"; }

is_guid() {
  [[ $1 =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

# new_guid: a random version 4 GUID, for the installation's ClientRequestId.
new_guid() {
  local hex
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
    return
  fi
  hex=$(gen_hex 16)
  printf '%s-%s-4%s-a%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "${hex:17:3}" "${hex:20:12}"
}

is_ipv4() {
  local a b c d
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  [ $((10#$a)) -le 255 ] && [ $((10#$b)) -le 255 ] && [ $((10#$c)) -le 255 ] && [ $((10#$d)) -le 255 ]
}

# A loose IPv6 check: hex groups and colons, at most one "::", at most eight groups.
is_ipv6() {
  local text=$1 rest groups
  [[ $text =~ ^[0-9a-fA-F:]+$ && $text == *:* ]] || return 1
  rest=${text//::/}
  [ $(((${#text} - ${#rest}) / 2)) -le 1 ] || return 1
  [[ $text != *:::* ]] || return 1
  groups=$(tr ':' '\n' <<<"$text" | grep -c .)
  [ "$groups" -le 8 ] && ! tr ':' '\n' <<<"$text" | grep -qE '^.{5,}$'
}

# cidr_family <cidr>: 4 or 6; status 1 for anything that is not an address with a prefix within
# its family's length.
cidr_family() {
  local address=${1%/*} prefix=${1##*/}
  [[ $1 == */* && $prefix =~ ^[0-9]{1,3}$ ]] || return 1
  if is_ipv4 "$address" && [ $((10#$prefix)) -le 32 ]; then
    echo 4
  elif is_ipv6 "$address" && [ $((10#$prefix)) -le 128 ]; then
    echo 6
  else
    return 1
  fi
}

# is_network <address or cidr>: an address the firewall can take as a source (a panel address).
is_network() {
  case $1 in
    */*) cidr_family "$1" >/dev/null ;;
    *) is_ipv4 "$1" || is_ipv6 "$1" ;;
  esac
}

network_family() {
  local address=${1%/*}
  if is_ipv4 "$address"; then echo 4; else echo 6; fi
}

# --- The web service ---------------------------------------------------------------------------

# eop_latest_version: the worldwide instance's version from a `version` answer on stdin (one
# object, or the list of every instance); unknown fields are skipped. Status 1 when there is none
# or it is not the documented ten digits.
eop_latest_version() {
  local version
  version=$(jq -r '
    if type == "object" then .latest
    elif type == "array" then (map(select(type == "object" and .instance == "Worldwide")) | .[0].latest)
    else empty end // empty' 2>/dev/null) || return 1
  [[ $version =~ ^[0-9]{10}$ ]] || return 1
  printf '%s\n' "$version"
}

# eop_ranges_from_endpoints: the CIDRs of an `endpoints` answer on stdin, one per line, IPv4
# first, in the service's order without repeats: the entries of the Exchange service area whose
# tcpPorts list (comma separated, blanks around) carries 25, never chosen by id. The same filter
# as rangesFromEndpoints in backend/src/services/mailNode/eopRanges.js. Status 1, printing nothing,
# for an answer that is not a list, a CIDR that is malformed, or no IPv4 range at all: such a list
# is never applied.
eop_ranges_from_endpoints() {
  local raw cidr family
  local -a v4=() v6=()
  raw=$(jq -r '
    if type != "array" then error("not a list") else . end
    | .[] | select(type == "object" and .serviceArea == "Exchange")
    | select([(.tcpPorts // "") | tostring | split(",")[] | gsub("^\\s+|\\s+$"; "")] | any(. == "25"))
    | (.ips // [])[] | tostring' 2>/dev/null) || return 1
  while IFS= read -r cidr; do
    [ -n "$cidr" ] || continue
    family=$(cidr_family "$cidr") || return 1
    if [ "$family" = 4 ]; then v4+=("$cidr"); else v6+=("${cidr,,}"); fi
  done <<<"$raw"
  [ "${#v4[@]}" -gt 0 ] || return 1
  printf '%s\n' "${v4[@]}" "${v6[@]}" | awk '!seen[$0]++'
}

# --- mailcow's files ---------------------------------------------------------------------------

# kv_render <file> <KEY=VALUE...>: the file with each key set to its value (mailcow.conf, the
# docker compose .env of mailcow), printed. A key that is there gets its value on its first line
# and loses any later one; a missing key is appended. Every other line stays as it is.
kv_render() {
  local file=$1 pair key line
  shift
  local -A want=() seen=()
  local -a order=()
  for pair in "$@"; do
    key=${pair%%=*}
    want[$key]=${pair#*=}
    order+=("$key")
  done
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      key=${line%%=*}
      if [[ $line == *=* && $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ && -n ${want[$key]+x} ]]; then
        if [ -z "${seen[$key]+x}" ]; then
          printf '%s=%s\n' "$key" "${want[$key]}"
          seen[$key]=1
        fi
      else
        printf '%s\n' "$line"
      fi
    done <"$file"
  fi
  for key in "${order[@]}"; do
    [ -n "${seen[$key]+x}" ] || printf '%s=%s\n' "$key" "${want[$key]}"
  done
}

# mailcow_ipv6_enabled <mailcow.conf>: status 0 when mailcow runs with IPv6 (ENABLE_IPV6=true).
mailcow_ipv6_enabled() {
  local value
  value=$(env_get "$1" ENABLE_IPV6 2>/dev/null) || return 1
  [ "${value,,}" = true ]
}

# The settings the managed Dovecot block sets: one of them outside the block would fight it.
DOVECOT_KEYS_RE='^[[:space:]]*(service[[:space:]]+imap-login|service[[:space:]]+imap[[:space:]]*\{|service[[:space:]]+imap-hibernate|imap_hibernate_timeout|process_limit)'

# dovecot_render <extra.conf, may be missing> <dovecot-extra.conf>: mailcow's
# data/conf/dovecot/extra.conf with the panel's settings in one block between the markers, at the
# end; every other line stays. A copy of dovecot-extra.conf appended by hand (the runbook's earlier
# step) becomes the block. Status 3, printing the lines, when settings of the block are set outside
# it: they must go by hand first (Dovecot would read both).
dovecot_render() {
  local file=$1 block=$2 current='' rest content conflicts
  content=$(<"$block")
  if [ -f "$file" ]; then current=$(<"$file"); fi
  rest=$(awk -v b="$DOVECOT_BEGIN" -v e="$DOVECOT_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip { print }' <<<"$current")
  # The whole file appended verbatim earlier: taken out here, written back as the block.
  if [[ -n $rest && $rest == *"$content"* ]]; then rest=${rest/"$content"/}; fi
  conflicts=$(grep -nE "$DOVECOT_KEYS_RE" <<<"$rest" || true)
  if [ -n "$conflicts" ]; then
    printf '%s\n' "$conflicts"
    return 3
  fi
  # Blank lines left at the end (command substitution drops them) or the start do not pile up.
  rest=$(sed '/./,$!d' <<<"$rest")
  if [ -n "$rest" ]; then printf '%s\n\n' "$rest"; fi
  printf '%s\n%s\n%s\n' "$DOVECOT_BEGIN" "$content" "$DOVECOT_END"
}

# --- The firewall ------------------------------------------------------------------------------

ipt() { if [ "$1" = 4 ]; then shift; iptables -w "$@"; else shift; ip6tables -w "$@"; fi; }

# firewall_rules <family 4|6> <external interface> [panel networks...]: the rules of the node's
# chain, one per line, as arguments after `-A MAILEXPERT-NODE`. Only packets that come in on the
# external interface: DOCKER-USER also sees mailcow's own outgoing mail (postfix to EOP, port 25),
# which must pass. Panel networks of the other family are left out.
firewall_rules() {
  local family=$1 ext=$2 net set
  shift 2
  if [ "$family" = 4 ]; then set=$EOP_SET4; else set=$EOP_SET6; fi
  printf -- '-i %s -p tcp --dport 25 -m set --match-set %s src -j RETURN\n' "$ext" "$set"
  printf -- '-i %s -p tcp --dport 25 -j DROP\n' "$ext"
  for net in "$@"; do
    [ "$(network_family "$net")" = "$family" ] || continue
    printf -- '-i %s -p tcp -m multiport --dports %s -s %s -j RETURN\n' "$ext" "$PANEL_PORTS" "$net"
  done
  printf -- '-i %s -p tcp -m multiport --dports %s -j DROP\n' "$ext" "$PANEL_PORTS"
  printf -- '-i %s -p tcp -m multiport --dports %s -j DROP\n' "$ext" "$CLOSED_PORTS"
}

# set_count <set>: the number of entries of an ipset; status 1 when it does not exist.
set_count() {
  local out
  out=$(ipset list -t "$1" 2>/dev/null) || return 1
  sed -n 's/^Number of entries: *//p' <<<"$out" | head -n 1
}

# firewall_apply <family> <external interface> [panel networks...]: the node's chain with these
# rules and one jump to it from DOCKER-USER. Unchanged rules with the chain and the jump in place
# are a no-op (status 0, prints "unchanged"). Otherwise the rules go into a new chain, DOCKER-USER
# jumps to it first, then the old chain goes and the new one takes its name: there is never a moment
# without rules. Refuses (status 1) while the family's EOP set is missing or empty: the port 25 DROP
# would shut EOP out.
firewall_apply() {
  local family=$1 ext=$2 set new=$NODE_CHAIN-NEW state count wanted line
  shift 2
  if [ "$family" = 4 ]; then set=$EOP_SET4; else set=$EOP_SET6; fi
  count=$(set_count "$set") || count=0
  if ! [[ $count =~ ^[0-9]+$ ]] || [ "$count" -eq 0 ]; then
    warn "firewall (IPv$family): the EOP set $set is missing or empty; the rules are not installed"
    return 1
  fi
  ipt "$family" -S DOCKER-USER >/dev/null 2>&1 || { warn "firewall (IPv$family): no DOCKER-USER chain (is Docker running?)"; return 1; }
  wanted=$(firewall_rules "$family" "$ext" "$@")
  state=$(firewall_state_file "$family")
  if [ -f "$state" ] && [ "$(<"$state")" = "$wanted" ] && ipt "$family" -S "$NODE_CHAIN" >/dev/null 2>&1 &&
    ipt "$family" -C DOCKER-USER -j "$NODE_CHAIN" 2>/dev/null; then
    echo unchanged
    return 0
  fi
  # Every step checked on its own: the caller may run this where errexit does not apply.
  if ipt "$family" -S "$new" >/dev/null 2>&1; then
    while ipt "$family" -C DOCKER-USER -j "$new" 2>/dev/null; do ipt "$family" -D DOCKER-USER -j "$new" || return 1; done
    ipt "$family" -F "$new" || return 1
  else
    ipt "$family" -N "$new" || return 1
  fi
  while IFS= read -r line; do
    # shellcheck disable=SC2086 # one rule, split into its arguments
    ipt "$family" -A "$new" $line || { warn "firewall (IPv$family): a rule was refused; the old rules stay"; return 1; }
  done <<<"$wanted"
  ipt "$family" -I DOCKER-USER 1 -j "$new" || return 1
  while ipt "$family" -C DOCKER-USER -j "$NODE_CHAIN" 2>/dev/null; do
    ipt "$family" -D DOCKER-USER -j "$NODE_CHAIN" || return 1
  done
  if ipt "$family" -S "$NODE_CHAIN" >/dev/null 2>&1; then
    ipt "$family" -F "$NODE_CHAIN" || return 1
    ipt "$family" -X "$NODE_CHAIN" || return 1
  fi
  ipt "$family" -E "$new" "$NODE_CHAIN" || return 1
  mkdir -p "$NODE_STATE"
  printf '%s\n' "$wanted" >"$state"
  echo changed
}

# set_replace <family> <file with CIDRs>: the family's EOP set holds exactly the file's CIDRs of
# that family, swapped in at once: a temporary set is filled, then `ipset swap` exchanges the two,
# so the port 25 rule never sees a half-filled set. Status 1 (nothing changed) for no CIDR of the
# family, 2 when ipset refused (the live set is swapped only after the new one is filled whole).
set_replace() {
  local family=$1 file=$2 set name inet cidrs cidr
  if [ "$family" = 4 ]; then set=$EOP_SET4 inet=inet; else set=$EOP_SET6 inet=inet6; fi
  if [ "$family" = 4 ]; then cidrs=$(grep -v ':' "$file" || true); else cidrs=$(grep ':' "$file" || true); fi
  [ -n "$cidrs" ] || return 1
  name=$set-new
  {
    printf 'create %s hash:net family %s -exist\n' "$name" "$inet"
    printf 'flush %s\n' "$name"
    while IFS= read -r cidr; do printf 'add %s %s\n' "$name" "$cidr"; done <<<"$cidrs"
  } | ipset restore || return 2
  ipset create "$set" hash:net family "$inet" -exist || return 2
  ipset swap "$name" "$set" || return 2
  ipset destroy "$name" || return 2
}

# --- Configuration -----------------------------------------------------------------------------

# node_panel_ips: the panel networks stored in node.env, one per line.
node_panel_ips() {
  local value
  value=$(env_get "$NODE_CONF" PANEL_IPS 2>/dev/null) || return 0
  tr ',' '\n' <<<"$value" | sed '/^$/d'
}

# node_firewall <family>: firewall_apply with what node.env holds.
node_firewall() {
  local ext
  local -a ips
  ext=$(env_get "$NODE_CONF" EXT_IF 2>/dev/null) || ext=''
  mapfile -t ips < <(node_panel_ips)
  if [ -z "$ext" ] || [ "${#ips[@]}" -eq 0 ]; then
    warn "firewall: no external interface or panel address in $NODE_CONF; run setup.sh with --panel-ip"
    return 1
  fi
  firewall_apply "$1" "$ext" "${ips[@]}"
}

# render_template <template> <install dir>: a unit or cron file with @DIR@ replaced.
render_template() {
  local text
  text=$(<"$1")
  printf '%s\n' "${text//@DIR@/"$2"}"
}
