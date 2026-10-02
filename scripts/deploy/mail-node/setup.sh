#!/usr/bin/env bash
# Sets up the mail node host for MailExpert (R-39, docs/operations/mail-node.md sections 3 and 4):
# the parts of mailcow that have no API, and the firewall in front of it. Idempotent: a second run
# with the same options changes nothing and restarts nothing.
#
# - mailcow.conf: SKIP_CLAMD=y, SKIP_OLEFY=y, SKIP_FTS=y (EOP scans for viruses and macros,
#   MailExpert searches its own copy) and ENABLE_IPV6=false, written explicitly (generate_config.sh
#   turns it on by itself when the host has IPv6). Other lines stay. A change needs a full
#   `docker compose down && docker compose up -d` of mailcow, which this script does not do.
# - data/conf/postfix/extra.cf: relayhost = <EOP_HOST> (decision D-12), other lines kept; restarts
#   postfix-mailcow only when the line changed. Without --eop-host (no tenant yet) it is skipped.
# - data/conf/dovecot/extra.conf: dovecot-extra.conf as one block between markers; restarts
#   dovecot-mailcow only when the block changed (IMAP sessions drop for a moment). A copy appended by
#   hand earlier becomes the block; the same settings anywhere else stop the script before it
#   changes anything.
# - /etc/mailexpert-node/node.env (0600): what eop-ranges.sh needs, among it the installation's
#   ClientRequestId for the Microsoft 365 endpoints web service, made once and kept.
# - eop-ranges.sh with its libraries in /opt/mailexpert-node, run once now, then hourly by the
#   systemd timer mailexpert-eop-ranges (cron when the host has no systemd), and
#   mailexpert-node-firewall at boot. They keep the ipsets of the EOP ranges and the DOCKER-USER
#   rules: port 25 only from EOP, 587 and 993 only from the panel, 110, 143, 465, 995 and 4190 from
#   nobody, on the external interface only. The port 25 rules go in only once the EOP set is filled.
#
# Usage: setup.sh --panel-ip <PANEL_IP> [--panel-ip ...] [--eop-host <EOP_HOST>]
#                 [--mailcow-dir /opt/mailcow-dockerized] [--ext-if <interface>]
#                 [--ping-url <Healthchecks URL>] [--client-request-id <GUID>] [--dry-run]
#
# Options given once are kept in node.env: a later run without them uses the same values.
# --dry-run prints the changes as diffs (and the firewall rules) and changes nothing.
# Exit codes: 0 done, 1 a step failed, 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/../lib
# shellcheck source=../lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=../lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
exit_on_unexpected_failure

SYSTEMD_DIR=${MAILEXPERT_SYSTEMD_DIR:-/etc/systemd/system}
CRON_FILE=${MAILEXPERT_CRON_FILE:-/etc/cron.d/mailexpert-node}
MAILCOW_SETTINGS=(SKIP_CLAMD=y SKIP_OLEFY=y SKIP_FTS=y ENABLE_IPV6=false)
UNITS=(mailexpert-eop-ranges.service mailexpert-eop-ranges.timer mailexpert-node-firewall.service)
MAX_PANEL_IPS=10

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

mailcow_compose() { (cd "$MAILCOW_DIR" && docker compose "$@"); }
service_running() { [ -n "$(mailcow_compose ps -q "$1" 2>/dev/null)" ]; }

# init_system: systemd when it runs the host, cron otherwise.
init_system() {
  if [ -n "${MAILEXPERT_NODE_INIT:-}" ]; then
    echo "$MAILEXPERT_NODE_INIT"
  elif command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    echo systemd
  else
    echo cron
  fi
}

default_ext_if() {
  ip -o route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") {print $(i + 1); exit}}'
}

# show_diff <path> <old file or missing> <new file>
show_diff() {
  local old=$2
  [ -f "$old" ] || old=/dev/null
  diff -u -L "a$1" -L "b$1" "$old" "$3" || true
}

# changed <old file or missing> <new file>
changed() { [ ! -f "$1" ] || ! cmp -s "$1" "$2"; }

# write_keep_mode <file> <new content file>: cat, not mv: the file keeps its owner and mode, which
# mailcow's containers rely on.
write_keep_mode() {
  mkdir -p "$(dirname "$1")"
  cat "$2" >"$1"
}

ensure_tools() {
  local -a missing=()
  local tool
  for tool in docker curl jq ipset iptables flock diff cmp ip; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  [ "${#missing[@]}" -gt 0 ] || return 0
  if [ "$DRY_RUN" = 1 ]; then
    warn "missing: ${missing[*]} (a real run installs them with apt-get)"
    return 0
  fi
  if ! command -v apt-get >/dev/null || [[ " ${missing[*]} " == *" docker "* ]]; then
    die "missing: ${missing[*]} (Docker comes with mailcow; apt-get install curl jq ipset iptables util-linux diffutils iproute2)" 2
  fi
  log "installing curl jq ipset iptables util-linux diffutils iproute2"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl jq ipset iptables util-linux diffutils iproute2 >/dev/null
}

install_scripts() {
  install -d -m 755 "$NODE_DIR"
  install -m 755 "$SCRIPT_DIR/eop-ranges.sh" "$NODE_DIR/eop-ranges.sh"
  install -m 644 "$SCRIPT_DIR/lib.sh" "$NODE_DIR/lib.sh"
  install -m 644 "$LIB_DIR/common.sh" "$NODE_DIR/common.sh"
  install -m 644 "$LIB_DIR/env.sh" "$NODE_DIR/env.sh"
}

# install_schedule: the hourly run and the one at boot.
install_schedule() {
  local unit target tmp
  if [ "$(init_system)" = systemd ]; then
    tmp=$(mktemp)
    for unit in "${UNITS[@]}"; do
      target=$SYSTEMD_DIR/$unit
      render_template "$SCRIPT_DIR/systemd/$unit" "$NODE_DIR" >"$tmp"
      if changed "$target" "$tmp"; then
        install -m 644 "$tmp" "$target"
        log "systemd: $unit written"
      fi
    done
    rm -f "$tmp"
    systemctl daemon-reload
    systemctl enable mailexpert-node-firewall.service >/dev/null 2>&1
    systemctl enable --now mailexpert-eop-ranges.timer >/dev/null 2>&1
    log "systemd: mailexpert-eop-ranges.timer (hourly) and mailexpert-node-firewall.service (boot) enabled"
  else
    tmp=$(mktemp)
    render_template "$SCRIPT_DIR/cron/mailexpert-node" "$NODE_DIR" >"$tmp"
    if changed "$CRON_FILE" "$tmp"; then
      install -m 644 "$tmp" "$CRON_FILE"
      log "cron: $CRON_FILE written (no systemd on this host)"
    fi
    rm -f "$tmp"
  fi
}

main() {
  local eop_host='' ext_if='' ping_url='' client_id='' net mailcow_conf extra_cf dovecot_conf tmp
  local conflicts rc=0 restart_note='' family rules
  local -a panel_ips=() given_ips=() parts=()
  local stored_conf=0
  DRY_RUN=0
  MAILCOW_DIR=''
  while [ $# -gt 0 ]; do
    case $1 in
      --mailcow-dir | --eop-host | --panel-ip | --ext-if | --ping-url | --client-request-id)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        case $1 in
          --mailcow-dir) MAILCOW_DIR=${2%/} ;;
          --eop-host) eop_host=${2,,} ;;
          --panel-ip) IFS=',' read -r -a parts <<<"$2" && given_ips+=("${parts[@]}") ;;
          --ext-if) ext_if=$2 ;;
          --ping-url) ping_url=$2 ;;
          --client-request-id) client_id=$2 ;;
        esac
        shift 2
        ;;
      --dry-run) DRY_RUN=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  [ "$(id -u)" = 0 ] || die "run setup.sh as root"

  # What a previous run stored fills what this one was not given.
  if [ -f "$NODE_CONF" ]; then stored_conf=1; fi
  [ -n "$MAILCOW_DIR" ] || MAILCOW_DIR=$(env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null) || MAILCOW_DIR=/opt/mailcow-dockerized
  [ -n "$eop_host" ] || eop_host=$(env_get "$NODE_CONF" EOP_HOST 2>/dev/null) || eop_host=''
  [ -n "$ext_if" ] || ext_if=$(env_get "$NODE_CONF" EXT_IF 2>/dev/null) || ext_if=''
  [ -n "$ping_url" ] || ping_url=$(env_get "$NODE_CONF" EOP_RANGES_PING_URL 2>/dev/null) || ping_url=''
  [ -n "$client_id" ] || client_id=$(env_get "$NODE_CONF" EOP_CLIENT_REQUEST_ID 2>/dev/null) || client_id=''
  if [ "${#given_ips[@]}" -gt 0 ]; then
    for net in "${given_ips[@]}"; do
      net=${net//[[:space:]]/}
      [ -n "$net" ] || continue
      is_network "$net" || die "--panel-ip: $net is not an IPv4 or IPv6 address or network" 2
      [[ " ${panel_ips[*]} " == *" ${net,,} "* ]] || panel_ips+=("${net,,}")
    done
  else
    mapfile -t panel_ips < <(node_panel_ips)
  fi

  [ -f "$MAILCOW_DIR/mailcow.conf" ] || die "$MAILCOW_DIR/mailcow.conf not found: run mailcow's generate_config.sh first, or give --mailcow-dir" 2
  if [ -n "$eop_host" ] && ! is_hostname "$eop_host"; then die "--eop-host: $eop_host is not a host name" 2; fi
  [ "${#panel_ips[@]}" -gt 0 ] || die "--panel-ip is required: the address the panel reaches the node from (587, 993)" 2
  [ "${#panel_ips[@]}" -le "$MAX_PANEL_IPS" ] || die "--panel-ip: at most $MAX_PANEL_IPS addresses" 2
  if [ -n "$ping_url" ] && [[ $ping_url != https://* || $ping_url == *[[:space:]\"\'\$\#\\]* ]]; then
    die "--ping-url must be an https URL" 2
  fi
  if [ -n "$client_id" ]; then
    is_guid "$client_id" || die "--client-request-id must be a GUID" 2
  else
    client_id=$(new_guid)
  fi
  [ -n "$ext_if" ] || ext_if=$(default_ext_if)
  [[ $ext_if =~ ^[A-Za-z0-9_.@-]{1,15}$ ]] || die "the external interface is unknown: give --ext-if" 2
  ensure_tools

  mailcow_conf=$MAILCOW_DIR/mailcow.conf
  extra_cf=$MAILCOW_DIR/data/conf/postfix/extra.cf
  dovecot_conf=$MAILCOW_DIR/data/conf/dovecot/extra.conf
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # the directory is known now
  trap "rm -rf '$tmp'" EXIT

  # The plan: every file as it should be, before anything is written.
  kv_render "$mailcow_conf" "${MAILCOW_SETTINGS[@]}" >"$tmp/mailcow.conf"
  if [ -n "$eop_host" ]; then
    if [ -f "$extra_cf" ]; then cat "$extra_cf" >"$tmp/extra.cf"; fi
    sh "$SCRIPT_DIR/extra-cf.sh" set "$tmp/extra.cf" relayhost "$eop_host"
  fi
  if ! dovecot_render "$dovecot_conf" "$SCRIPT_DIR/dovecot-extra.conf" >"$tmp/dovecot.conf"; then
    conflicts=$(<"$tmp/dovecot.conf")
    die "$dovecot_conf sets what dovecot-extra.conf sets, outside its block; remove these lines by hand and run again:
$conflicts" 2
  fi
  if [ "$stored_conf" = 1 ]; then cp "$NODE_CONF" "$tmp/node.env"; fi
  env_set "$tmp/node.env" MAILCOW_DIR "$MAILCOW_DIR"
  env_set "$tmp/node.env" EOP_CLIENT_REQUEST_ID "$client_id"
  env_set "$tmp/node.env" PANEL_IPS "$(IFS=,; echo "${panel_ips[*]}")"
  env_set "$tmp/node.env" EXT_IF "$ext_if"
  if [ -n "$eop_host" ]; then env_set "$tmp/node.env" EOP_HOST "$eop_host"; fi
  if [ -n "$ping_url" ]; then env_set "$tmp/node.env" EOP_RANGES_PING_URL "$ping_url"; fi

  if [ "$DRY_RUN" = 1 ]; then
    log "dry run: nothing is changed"
    show_diff "$mailcow_conf" "$mailcow_conf" "$tmp/mailcow.conf"
    if [ -n "$eop_host" ]; then show_diff "$extra_cf" "$extra_cf" "$tmp/extra.cf"; else log "extra.cf: skipped, no --eop-host yet"; fi
    show_diff "$dovecot_conf" "$dovecot_conf" "$tmp/dovecot.conf"
    # node.env holds the ping URL, which carries its check's key: keys only.
    if changed "$NODE_CONF" "$tmp/node.env"; then log "$NODE_CONF: would be written (keys: $(cut -d= -f1 "$tmp/node.env" | paste -sd' ' -))"; fi
    for family in 4 6; do
      [ "$family" = 4 ] || mailcow_ipv6_enabled "$tmp/mailcow.conf" || continue
      printf 'IPv%s chain %s (DOCKER-USER jumps to it):\n' "$family" "$NODE_CHAIN"
      while IFS= read -r rules; do
        printf '  -A %s %s\n' "$NODE_CHAIN" "$rules"
      done < <(firewall_rules "$family" "$ext_if" "${panel_ips[@]}")
    done
    log "schedule: $(init_system), hourly eop-ranges.sh and eop-ranges.sh --restore at boot, from $NODE_DIR"
    return 0
  fi

  # mailcow.conf: in effect at the next full down and up of mailcow.
  if changed "$mailcow_conf" "$tmp/mailcow.conf"; then
    show_diff "$mailcow_conf" "$mailcow_conf" "$tmp/mailcow.conf" >&2
    write_keep_mode "$mailcow_conf" "$tmp/mailcow.conf"
    if service_running postfix-mailcow; then
      restart_note="mailcow.conf changed: run 'docker compose down && docker compose up -d' in $MAILCOW_DIR (a restart is not enough)"
    fi
    log "mailcow.conf: SKIP_CLAMD, SKIP_OLEFY, SKIP_FTS and ENABLE_IPV6 set"
  else
    log "mailcow.conf: unchanged"
  fi

  if [ -z "$eop_host" ]; then
    log "extra.cf: skipped, no --eop-host yet (run again with it once the first domain's MX is known)"
  elif changed "$extra_cf" "$tmp/extra.cf"; then
    show_diff "$extra_cf" "$extra_cf" "$tmp/extra.cf" >&2
    write_keep_mode "$extra_cf" "$tmp/extra.cf"
    if service_running postfix-mailcow; then
      mailcow_compose restart postfix-mailcow >/dev/null
      log "extra.cf: relayhost = $eop_host, postfix-mailcow restarted"
    else
      log "extra.cf: relayhost = $eop_host (postfix-mailcow is not running: it reads it at its start)"
    fi
  else
    log "extra.cf: unchanged"
  fi

  if changed "$dovecot_conf" "$tmp/dovecot.conf"; then
    show_diff "$dovecot_conf" "$dovecot_conf" "$tmp/dovecot.conf" >&2
    write_keep_mode "$dovecot_conf" "$tmp/dovecot.conf"
    if service_running dovecot-mailcow; then
      mailcow_compose restart dovecot-mailcow >/dev/null
      log "dovecot extra.conf: written, dovecot-mailcow restarted (IMAP sessions reconnect)"
    else
      log "dovecot extra.conf: written (dovecot-mailcow is not running: it reads it at its start)"
    fi
  else
    log "dovecot extra.conf: unchanged"
  fi

  install -d -m 700 "$(dirname "$NODE_CONF")"
  if changed "$NODE_CONF" "$tmp/node.env"; then
    install -m 600 "$tmp/node.env" "$NODE_CONF"
    log "$NODE_CONF: written"
  fi
  install -d -m 755 "$NODE_STATE"
  install_scripts

  # The EOP ranges first, the firewall with them: eop-ranges.sh fills the sets, then puts the
  # chain in place; it never installs the port 25 rules while a set is empty.
  "$NODE_DIR/eop-ranges.sh" || rc=$?
  if [ "$rc" != 0 ]; then
    if sets_ready; then
      warn "eop-ranges.sh failed; the EOP ranges already in place stay"
    else
      die "eop-ranges.sh failed and there are no EOP ranges yet: the firewall rules are not installed; fix the cause and run setup.sh again" 1
    fi
  fi
  for family in 4 6; do
    [ "$family" = 4 ] || mailcow_ipv6_enabled "$mailcow_conf" || continue
    node_firewall "$family" >/dev/null || die "firewall (IPv$family): the rules are not in place" 1
  done
  log "firewall: port 25 from EOP only, ${PANEL_PORTS} from ${panel_ips[*]} only, ${CLOSED_PORTS} closed (on $ext_if)"
  install_schedule
  if [ -n "$restart_note" ]; then warn "$restart_note"; fi
  log "done"
}

# sets_ready: the IPv4 EOP set exists and is not empty.
sets_ready() {
  local count
  count=$(set_count "$EOP_SET4") || return 1
  [[ $count =~ ^[0-9]+$ ]] && [ "$count" -gt 0 ]
}

main "$@"; exit $?
