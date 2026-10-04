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
DOCKER_DAEMON_JSON=${MAILEXPERT_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}

# The Microsoft 365 endpoints web service, worldwide instance (eop-panel-requirements.md, 2.10).
# shellcheck disable=SC2034 # read by eop-ranges.sh
EOP_ENDPOINTS=https://endpoints.office.com
# The ipsets the port 25 rules match.
EOP_SET4=mailexpert-eop4
EOP_SET6=mailexpert-eop6
# The node's chain and its alternate: a change is built in the one DOCKER-USER does not jump to,
# then the jump moves, so the active rules are never taken away before their replacement is in.
NODE_CHAIN=MAILEXPERT-NODE
NODE_CHAIN_ALT=MAILEXPERT-NODE-2
# mailcow's bridge (docker-compose.yml: driver_opts com.docker.network.bridge.name). A packet that
# leaves through it without having come in through it is traffic to a published port; mailcow's
# own mail going out (to EOP, port 25) and traffic between its containers never match. Unlike an
# external interface name, nothing has to be guessed, and a second uplink is covered too.
MAILCOW_BRIDGE=br-mailcow
# Container ports (DOCKER-USER sees the packet after Docker's DNAT, so a host port moved with
# SMTP_PORT=<NODE_IP>:25 or SUBMISSION_PORT=10587 is still matched): 25 only from EOP, submission
# and IMAPS only from the panel (refused with a TCP reset, so a client trying another address gives
# up at once), the other mail ports from nobody.
PANEL_PORTS=587,993
CLOSED_PORTS=110,143,465,995,4190
# mailcow.conf's published mail ports and the container port of each (generate_config.sh).
MAILCOW_PORT_VARS=(SMTP_PORT:25 SMTPS_PORT:465 SUBMISSION_PORT:587 IMAP_PORT:143 IMAPS_PORT:993
  POP_PORT:110 POPS_PORT:995 SIEVE_PORT:4190)
# The widest networks accepted: an EOP range (Microsoft publishes /14 to /17 and /48) and a panel
# address (as the panel's fail2ban setting, R-13).
EOP_MIN_PREFIX4=8
EOP_MIN_PREFIX6=24
PANEL_MIN_PREFIX4=24
PANEL_MIN_PREFIX6=48

# Managed blocks in files the owner may edit too.
DOVECOT_BEGIN='# BEGIN MailExpert: dovecot-extra.conf (managed by scripts/deploy/mail-node/setup.sh, do not edit)'
DOVECOT_END='# END MailExpert: dovecot-extra.conf'

ranges_file() { printf '%s/eop-ranges.txt\n' "$NODE_STATE"; }
# Left by node-backup.sh --tag move on the old node of a move: its backup stops, eop-ranges.sh
# closes mailcow's mail ports to everyone and pings only when postfix or dovecot run again (the new
# node pings the same checks). setup.sh --end-standby removes it.
node_standby_file() { printf '%s/standby\n' "$NODE_STATE"; }
# The services that must stay down on a standby node: they would take mail the new node never sees.
# The watchdog restarts a mail service it finds unhealthy.
# shellcheck disable=SC2034 # read by eop-ranges.sh, node-backup.sh and setup.sh
STANDBY_SERVICES=(postfix-mailcow dovecot-mailcow watchdog-mailcow)

# mailcow_running <mailcow dir> <service...>: the given services that run, one per line.
mailcow_running() {
  local dir=$1 service
  shift
  for service in "$@"; do
    if [ -n "$(cd "$dir" && docker compose ps -q "$service" 2>/dev/null)" ]; then echo "$service"; fi
  done
  return 0
}

# mailcow_restart_policy <mailcow dir> <no|always> <service...>: the restart policy of the
# services' containers (docker update; compose does not track it, so `docker compose up -d` keeps
# it). Status 1 when a container refused.
mailcow_restart_policy() {
  local dir=$1 policy=$2 ids
  shift 2
  ids=$(cd "$dir" && docker compose ps -aq "$@" 2>/dev/null) || ids=''
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # one id per word
  docker update --restart="$policy" $ids >/dev/null
}
version_file() { printf '%s/eop-version\n' "$NODE_STATE"; }
firewall_state_file() { printf '%s/firewall-%s.rules\n' "$NODE_STATE" "$1"; }
firewall_chain_file() { printf '%s/firewall-%s.chain\n' "$NODE_STATE" "$1"; }

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

# cidr_family <cidr> [min prefix IPv4] [min prefix IPv6]: 4 or 6; status 1 for anything that is not
# an address with a prefix within its family's length and no wider than the minimum given.
cidr_family() {
  local address=${1%/*} prefix=${1##*/} min4=${2:-0} min6=${3:-0}
  [[ $1 == */* && $prefix =~ ^[0-9]{1,3}$ ]] || return 1
  prefix=$((10#$prefix))
  if is_ipv4 "$address" && [ "$prefix" -le 32 ] && [ "$prefix" -ge "$min4" ]; then
    echo 4
  elif is_ipv6 "$address" && [ "$prefix" -le 128 ] && [ "$prefix" -ge "$min6" ]; then
    echo 6
  else
    return 1
  fi
}

# eop_cidr_family <cidr>: cidr_family for an EOP range: nothing wider than /8 (IPv4) or /24 (IPv6).
eop_cidr_family() { cidr_family "$1" "$EOP_MIN_PREFIX4" "$EOP_MIN_PREFIX6"; }

# is_panel_network <address or cidr>: a panel address the firewall lets in: an address, or a
# network no wider than /24 (IPv4) or /48 (IPv6).
is_panel_network() {
  case $1 in
    */*) cidr_family "$1" "$PANEL_MIN_PREFIX4" "$PANEL_MIN_PREFIX6" >/dev/null ;;
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

# eop_ranges_check: the CIDRs on stdin (one per line) as a list the node may apply, printed IPv4
# first without repeats, IPv6 lowercased. Status 1, printing nothing, for a malformed or too wide
# CIDR, or no IPv4 range at all: such a list is never applied.
eop_ranges_check() {
  local cidr family
  local -a v4=() v6=()
  while IFS= read -r cidr; do
    [ -n "$cidr" ] || continue
    family=$(eop_cidr_family "$cidr") || return 1
    if [ "$family" = 4 ]; then v4+=("$cidr"); else v6+=("${cidr,,}"); fi
  done
  [ "${#v4[@]}" -gt 0 ] || return 1
  printf '%s\n' "${v4[@]}" "${v6[@]}" | awk '!seen[$0]++'
}

# eop_ranges_from_endpoints: the CIDRs of an `endpoints` answer on stdin, checked by
# eop_ranges_check: the entries of the Exchange service area whose tcpPorts list (comma separated,
# blanks around) carries 25, never chosen by id. The same filter as rangesFromEndpoints in
# backend/src/services/mailNode/eopRanges.js. Status 1, printing nothing, for an answer that is not
# a list or a list eop_ranges_check refuses.
eop_ranges_from_endpoints() {
  local raw
  raw=$(jq -r '
    if type != "array" then error("not a list") else . end
    | .[] | select(type == "object" and .serviceArea == "Exchange")
    | select([(.tcpPorts // "") | tostring | split(",")[] | gsub("^\\s+|\\s+$"; "")] | any(. == "25"))
    | (.ips // [])[] | tostring' 2>/dev/null) || return 1
  eop_ranges_check <<<"$raw"
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

# kv_changes <old file> <new file> <KEY...>: "KEY: old -> new" for each given key whose value
# differs. Only these keys: a diff of mailcow.conf would print its passwords as context.
kv_changes() {
  local old=$1 new=$2 key a b
  shift 2
  for key in "$@"; do
    a=$(env_get "$old" "$key" 2>/dev/null) || a='(none)'
    b=$(env_get "$new" "$key" 2>/dev/null) || b='(none)'
    [ "$a" = "$b" ] || printf '%s: %s -> %s\n' "$key" "$a" "$b"
  done
}

# ipv4_binding <value of a *_PORT setting> <container port>: the setting published on IPv4 only.
# A bare port (or none) becomes 0.0.0.0:<port>; an IPv4 address with a port (<NODE_IP>:25) stays;
# an IPv6 binding becomes 0.0.0.0 with its port. Without an address Docker publishes on [::] too,
# through docker-proxy, past DOCKER-USER, and the connection reaches mailcow from the bridge's
# gateway, which mailcow's mynetworks trusts.
ipv4_binding() {
  local value=$1 port=$2
  if [[ $value =~ ^[0-9]+$ ]]; then
    printf '0.0.0.0:%s\n' "$value"
  elif [[ $value =~ ^([0-9.]+):([0-9]+)$ ]] && is_ipv4 "${BASH_REMATCH[1]}"; then
    printf '%s\n' "$value"
  elif [[ $value =~ :([0-9]+)$ ]]; then
    printf '0.0.0.0:%s\n' "${BASH_REMATCH[1]}"
  else
    printf '0.0.0.0:%s\n' "$port"
  fi
}

# mailcow_settings <mailcow.conf>: the KEY=VALUE lines setup.sh puts into mailcow.conf: the
# services EOP and the panel make redundant, IPv6 off (D-13) and every mail port on IPv4 only.
mailcow_settings() {
  local pair key port value
  printf '%s\n' SKIP_CLAMD=y SKIP_OLEFY=y SKIP_FTS=y ENABLE_IPV6=false
  for pair in "${MAILCOW_PORT_VARS[@]}"; do
    key=${pair%%:*} port=${pair#*:}
    value=$(env_get "$1" "$key" 2>/dev/null) || value=''
    printf '%s=%s\n' "$key" "$(ipv4_binding "$value" "$port")"
  done
}

# mailcow_host_ports <mailcow.conf>: the host ports of mailcow's mail services, one per line.
mailcow_host_ports() {
  local pair key value
  for pair in "${MAILCOW_PORT_VARS[@]}"; do
    key=${pair%%:*}
    value=$(env_get "$1" "$key" 2>/dev/null) || value=${pair#*:}
    printf '%s\n' "${value##*:}"
  done
}

# ipv6_listeners <mailcow.conf>: the mail ports something listens on over IPv6 ([::]:25, *:25 or
# an IPv6 address), from `ss -ltn`, one per line. With ENABLE_IPV6=false there must be none.
ipv6_listeners() {
  local ports
  ports=$(mailcow_host_ports "$1" | paste -sd'|' -)
  { ss -ltnH 2>/dev/null || true; } | awk '{print $4}' |
    { grep -E "^(\[[0-9a-fA-F:.%a-z]*\]|\*):($ports)$" || true; } | sed 's/.*://' | sort -un
}

# mailcow_ipv6_enabled <mailcow.conf>: status 0 when mailcow runs with IPv6 (ENABLE_IPV6=true).
mailcow_ipv6_enabled() {
  local value
  value=$(env_get "$1" ENABLE_IPV6 2>/dev/null) || return 1
  [ "${value,,}" = true ]
}

# docker_nftables: status 0 when Docker runs its nftables firewall backend: no DOCKER-USER chain
# then, and these rules would not filter anything.
docker_nftables() {
  [ -f "$DOCKER_DAEMON_JSON" ] && grep -qE '"firewall-backend"[[:space:]]*:[[:space:]]*"nftables"' "$DOCKER_DAEMON_JSON"
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

# replace_file <file> <new content file>: the file gets the new content through a temporary file
# next to it and a rename, so a full disk or a crash never leaves it cut short; the owner and mode
# of the file it replaces are kept (mailcow's containers rely on them).
replace_file() {
  local file=$1 src=$2 tmp mode owner
  mkdir -p "$(dirname "$file")"
  tmp=$(mktemp "$file.XXXXXX") || return 1
  if ! cat "$src" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [ -e "$file" ]; then
    if ! { mode=$(stat -c %a "$file") && owner=$(stat -c %u:%g "$file") && chmod "$mode" "$tmp" && chown "$owner" "$tmp"; }; then
      rm -f "$tmp"
      return 1
    fi
  else
    chmod 644 "$tmp"
  fi
  mv -f "$tmp" "$file"
}

# --- The firewall ------------------------------------------------------------------------------

ipt() { if [ "$1" = 4 ]; then shift; iptables -w "$@"; else shift; ip6tables -w "$@"; fi; }

# firewall_rules <family 4|6> [panel networks...]: the rules of the node's chain, one per line, as
# arguments after `-A <chain>`: only traffic to a published port (out through mailcow's bridge,
# not in through it). Panel networks of the other family are left out.
firewall_rules() {
  local family=$1 net set match="-o $MAILCOW_BRIDGE ! -i $MAILCOW_BRIDGE"
  shift
  # A standby node (eop-ranges.sh sets FIREWALL_CLOSED): every mail port closed to everyone.
  if [ "${FIREWALL_CLOSED:-0}" = 1 ]; then
    printf -- '%s -p tcp --dport 25 -j DROP\n' "$match"
    printf -- '%s -p tcp -m multiport --dports %s -j REJECT --reject-with tcp-reset\n' "$match" "$PANEL_PORTS"
    printf -- '%s -p tcp -m multiport --dports %s -j DROP\n' "$match" "$CLOSED_PORTS"
    return 0
  fi
  if [ "$family" = 4 ]; then set=$EOP_SET4; else set=$EOP_SET6; fi
  printf -- '%s -p tcp --dport 25 -m set --match-set %s src -j RETURN\n' "$match" "$set"
  printf -- '%s -p tcp --dport 25 -j DROP\n' "$match"
  for net in "$@"; do
    [ "$(network_family "$net")" = "$family" ] || continue
    printf -- '%s -p tcp -m multiport --dports %s -s %s -j RETURN\n' "$match" "$PANEL_PORTS" "$net"
  done
  printf -- '%s -p tcp -m multiport --dports %s -j REJECT --reject-with tcp-reset\n' "$match" "$PANEL_PORTS"
  printf -- '%s -p tcp -m multiport --dports %s -j DROP\n' "$match" "$CLOSED_PORTS"
}

# set_count <set>: the number of entries of an ipset; status 1 when it does not exist.
set_count() {
  local out
  out=$(ipset list -t "$1" 2>/dev/null) || return 1
  sed -n 's/^Number of entries: *//p' <<<"$out" | head -n 1
}

# set_members <set>: the entries of an ipset, sorted, one per line; status 1 when it does not exist.
set_members() {
  local out
  out=$(ipset list "$1" 2>/dev/null) || return 1
  sed -n '/^Members:/,$p' <<<"$out" | sed '1d;/^$/d' | awk '{print $1}' | sort
}

# active_chain <family>: the node chain DOCKER-USER jumps to (the main name first); status 1 for none.
active_chain() {
  local chain
  for chain in "$NODE_CHAIN" "$NODE_CHAIN_ALT"; do
    if ipt "$1" -C DOCKER-USER -j "$chain" 2>/dev/null; then
      echo "$chain"
      return 0
    fi
  done
  return 1
}

# chain_snapshot <family> <chain>: the chain as iptables prints it, its name replaced, to compare
# what is there with what the last build left.
chain_snapshot() {
  ipt "$1" -S "$2" 2>/dev/null | sed -E "s/^(-[NA]) $2( |\$)/\\1 @CHAIN@\\2/"
}

# firewall_apply <family> <create 0|1> [panel networks...]: the node's rules in force: one chain
# with these rules and one jump to it from DOCKER-USER.
# - Unchanged rules, the chain as the last build left it (compared as iptables prints it, so a
#   flushed or edited chain is rebuilt) and exactly one jump: nothing is done ("unchanged").
# - Otherwise the rules go into the other chain of the pair, DOCKER-USER jumps to it first, and only
#   then the old jump goes and the old chain is emptied and deleted ("changed"). An old chain that
#   cannot be deleted (something else refers to it) stays empty; the next change builds into it.
# - DOCKER-USER missing: create 1 (at boot, before Docker starts; Docker keeps the chain) makes it,
#   otherwise status 1: Docker is not running or uses its nftables backend.
# - Status 1, nothing changed, while the IPv4 EOP set is missing or empty (the port 25 rule would
#   shut EOP out) or the IPv6 one is missing.
firewall_apply() {
  local family=$1 create=$2 set count wanted active target other jumps line
  shift 2
  if [ "$family" = 4 ]; then set=$EOP_SET4; else set=$EOP_SET6; fi
  count=$(set_count "$set") || count=''
  if [ "${FIREWALL_CLOSED:-0}" = 1 ]; then
    : # the closed rules match no set
  elif ! [[ $count =~ ^[0-9]+$ ]] || { [ "$family" = 4 ] && [ "$count" -eq 0 ]; }; then
    warn "firewall (IPv$family): the EOP set $set is missing${count:+ or empty}; the rules are not installed"
    return 1
  fi
  if ! ipt "$family" -S DOCKER-USER >/dev/null 2>&1; then
    if [ "$create" != 1 ]; then
      warn "firewall (IPv$family): no DOCKER-USER chain (Docker is not running, or runs its nftables backend)"
      return 1
    fi
    ipt "$family" -N DOCKER-USER || return 1
  fi
  wanted=$(firewall_rules "$family" "$@")
  active=$(active_chain "$family") || active=''
  jumps=$(ipt "$family" -S DOCKER-USER 2>/dev/null | grep -cE -- "-j ($NODE_CHAIN|$NODE_CHAIN_ALT)\$" || true)
  if [ -n "$active" ] && [ "$jumps" = 1 ] && [ -f "$(firewall_state_file "$family")" ] &&
    [ "$(<"$(firewall_state_file "$family")")" = "$wanted" ] && [ -f "$(firewall_chain_file "$family")" ] &&
    [ "$(chain_snapshot "$family" "$active")" = "$(<"$(firewall_chain_file "$family")")" ]; then
    echo unchanged
    return 0
  fi
  if [ "$active" = "$NODE_CHAIN" ]; then target=$NODE_CHAIN_ALT other=$NODE_CHAIN; else target=$NODE_CHAIN other=$NODE_CHAIN_ALT; fi
  # Every step checked on its own: the caller may run this where errexit does not apply.
  if ipt "$family" -S "$target" >/dev/null 2>&1; then
    while ipt "$family" -C DOCKER-USER -j "$target" 2>/dev/null; do ipt "$family" -D DOCKER-USER -j "$target" || return 1; done
    ipt "$family" -F "$target" || return 1
  else
    ipt "$family" -N "$target" || return 1
  fi
  while IFS= read -r line; do
    # shellcheck disable=SC2086 # one rule, split into its arguments
    ipt "$family" -A "$target" $line || { warn "firewall (IPv$family): a rule was refused; the rules in force stay"; return 1; }
  done <<<"$wanted"
  ipt "$family" -I DOCKER-USER 1 -j "$target" || return 1
  while ipt "$family" -C DOCKER-USER -j "$other" 2>/dev/null; do
    ipt "$family" -D DOCKER-USER -j "$other" || return 1
  done
  if ipt "$family" -S "$other" >/dev/null 2>&1; then
    ipt "$family" -F "$other" || return 1
    ipt "$family" -X "$other" 2>/dev/null || warn "firewall (IPv$family): the old chain $other is still referred to; it stays, empty"
  fi
  mkdir -p "$NODE_STATE"
  printf '%s\n' "$wanted" >"$(firewall_state_file "$family")"
  chain_snapshot "$family" "$target" >"$(firewall_chain_file "$family")"
  echo changed
}

# foreign_port_rules <family>: rules of DOCKER-USER, other than the jump to the node's chain, that
# name one of mailcow's mail ports: left from setting the firewall up by hand. They run before or
# after the node's chain and can open or close what it decides.
foreign_port_rules() {
  ipt "$1" -S DOCKER-USER 2>/dev/null |
    grep -vE -- "^-N DOCKER-USER$|-j ($NODE_CHAIN|$NODE_CHAIN_ALT)\$" |
    grep -E -- '--dports? ([0-9:]+,)*(25|465|587|143|993|110|995|4190)(,| |$)' || true
}

# set_replace <family> <file with CIDRs>: the family's EOP set holds exactly the file's CIDRs of
# that family, swapped in at once: a temporary set is filled, then `ipset swap` exchanges the two,
# so the port 25 rule never sees a half-filled set. No CIDR of the family: status 1 (IPv4; nothing
# changed) or an empty IPv6 set (the IPv6 rules then let nobody in on 25). Status 2 when ipset
# refused (the live set is swapped only after the new one is filled whole).
set_replace() {
  local family=$1 file=$2 set name inet cidrs cidr
  if [ "$family" = 4 ]; then set=$EOP_SET4 inet=inet; else set=$EOP_SET6 inet=inet6; fi
  if [ "$family" = 4 ]; then cidrs=$(grep -v ':' "$file" || true); else cidrs=$(grep ':' "$file" || true); fi
  [ -n "$cidrs" ] || [ "$family" = 6 ] || return 1
  name=$set-new
  {
    printf 'create %s hash:net family %s -exist\n' "$name" "$inet"
    printf 'flush %s\n' "$name"
    if [ -n "$cidrs" ]; then
      while IFS= read -r cidr; do printf 'add %s %s\n' "$name" "$cidr"; done <<<"$cidrs"
    fi
  } | ipset restore || return 2
  ipset create "$set" hash:net family "$inet" -exist || return 2
  ipset swap "$name" "$set" || return 2
  ipset destroy "$name" || return 2
}

# set_matches <family> <file>: the family's set holds exactly the file's CIDRs of that family.
set_matches() {
  local family=$1 file=$2 set want have
  if [ "$family" = 4 ]; then set=$EOP_SET4; else set=$EOP_SET6; fi
  have=$(set_members "$set") || return 1
  if [ "$family" = 4 ]; then want=$(grep -v ':' "$file" | sort || true); else want=$(grep ':' "$file" | sort || true); fi
  [ "$have" = "$want" ]
}

# --- Configuration -----------------------------------------------------------------------------

# node_panel_ips: the panel networks stored in node.env, one per line.
node_panel_ips() {
  local value
  value=$(env_get "$NODE_CONF" PANEL_IPS 2>/dev/null) || return 0
  tr ',' '\n' <<<"$value" | sed '/^$/d'
}

# node_firewall <family> [create 0|1]: firewall_apply with the panel addresses node.env holds.
node_firewall() {
  local -a ips
  mapfile -t ips < <(node_panel_ips)
  if [ "${#ips[@]}" -eq 0 ]; then
    warn "firewall: no panel address in $NODE_CONF; run setup.sh with --panel-ip"
    return 1
  fi
  firewall_apply "$1" "${2:-0}" "${ips[@]}"
}

# render_template <template> <install dir>: a unit or cron file with @DIR@ replaced.
render_template() {
  local text
  text=$(<"$1")
  printf '%s\n' "${text//@DIR@/"$2"}"
}
