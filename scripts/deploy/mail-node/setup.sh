#!/usr/bin/env bash
# Sets up the mail node host for MailExpert (R-39, docs/operations/mail-node.md sections 3 and 4):
# the parts of mailcow that have no API, and the firewall in front of it. Idempotent: a second run
# with the same options changes nothing and restarts nothing.
#
# - mailcow.conf: SKIP_CLAMD=y, SKIP_OLEFY=y, SKIP_FTS=y (EOP scans for viruses and macros,
#   MailExpert searches its own copy), ENABLE_IPV6=false (D-13; generate_config.sh and mailcow's
#   update.sh turn it on by themselves when the host has IPv6) and every mail port published on IPv4
#   only (SMTP_PORT=0.0.0.0:25 and so on; an address already given, <NODE_IP>:25, stays): without an
#   address Docker publishes on [::] too, through docker-proxy, past DOCKER-USER. Other lines stay.
#   A change needs a full `docker compose down && docker compose up -d` of mailcow, which this
#   script does not do.
# - data/conf/postfix/extra.cf: relayhost = <EOP_HOST> (decision D-12), other lines kept; restarts
#   postfix-mailcow only when the line changed. Without --eop-host (no tenant yet) it is skipped.
# - data/conf/dovecot/extra.conf: dovecot-extra.conf as one block between markers; restarts
#   dovecot-mailcow only when the block changed (IMAP sessions drop for a moment). A copy appended by
#   hand earlier becomes the block; the same settings anywhere else stop the script before it
#   changes anything. A restart that failed is tried again by the next run.
# - /etc/mailexpert-node/node.env (0600): what eop-ranges.sh needs, among it the installation's
#   ClientRequestId for the Microsoft 365 endpoints web service, made once and kept.
# - eop-ranges.sh with its libraries in /opt/mailexpert-node, run once now, then hourly by the
#   systemd timer mailexpert-eop-ranges (cron when the host has no systemd), and
#   mailexpert-node-firewall at boot before Docker. They keep the ipsets of the EOP ranges and the
#   DOCKER-USER rules for traffic to mailcow's published ports: 25 only from EOP, 587 and 993 only
#   from the panel, 110, 143, 465, 995 and 4190 from nobody. The port 25 rules go in only once the
#   EOP set is filled. Other DOCKER-USER rules on these ports (an earlier setup by hand) are listed.
# - The node's backup (section 7), once its restic keys are in node.env: node-backup.sh and
#   node-restore.sh installed next to eop-ranges.sh, the restic repository opened (created when it
#   does not exist yet), the recovery key shown once in a terminal, and the nightly
#   mailexpert-node-backup timer (cron without systemd). --backup-keys reads the keys as KEY=VALUE
#   lines on stdin, never as arguments: RESTIC_REPOSITORY, RESTIC_PASSWORD (kept once stored),
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION, NODE_BACKUP_PING_URL and the
#   optional NODE_BACKUP_READ_SUBSET, NODE_BACKUP_DUMP_TIMEOUT, NODE_BACKUP_PUSH_TIMEOUT,
#   NODE_BACKUP_VERIFY_TIMEOUT, NODE_BACKUP_RESERVE_PERCENT, NODE_BACKUP_RESERVE_GB,
#   NODE_BACKUP_PARTIAL_LIMIT. The unit's TimeoutStartSec (the cron line's timeout) is the sum of the
#   run's bounds; under cron the output goes to /var/log/mailexpert-node-backup.log (0600, rotated
#   weekly by logrotate).
# - A server node-restore.sh restored is marked live: node-restore.sh never restores over it again.
# - The old node of a move stays standby (mail ports closed, backup skipped) until --end-standby:
#   the move was called off; the restart policies of postfix, dovecot and the watchdog go back to
#   always and mailcow is started (docker compose up -d) before the firewall opens again.
#
# Usage: setup.sh --panel-ip <PANEL_IP> [--panel-ip ...] [--eop-host <EOP_HOST>]
#                 [--mailcow-dir /opt/mailcow-dockerized] [--ping-url <Healthchecks URL>]
#                 [--client-request-id <GUID>] [--backup-keys < file] [--end-standby] [--dry-run]
#
# Options given once are kept in node.env: a later run without them uses the same values. Run it
# again after every mailcow update. --dry-run prints the changes (diffs; for mailcow.conf only the
# keys it sets, the file holds passwords) and the firewall rules, and changes nothing.
# Exit codes: 0 done, 1 a step failed, 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/../lib
# shellcheck source=../lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=../lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=../lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"
exit_on_unexpected_failure

SYSTEMD_DIR=${MAILEXPERT_SYSTEMD_DIR:-/etc/systemd/system}
CRON_FILE=${MAILEXPERT_CRON_FILE:-/etc/cron.d/mailexpert-node}
BACKUP_CRON_FILE=${MAILEXPERT_BACKUP_CRON_FILE:-/etc/cron.d/mailexpert-node-backup}
BACKUP_LOG=${MAILEXPERT_NODE_BACKUP_LOG:-/var/log/mailexpert-node-backup.log}
LOGROTATE_FILE=${MAILEXPERT_LOGROTATE_FILE:-/etc/logrotate.d/mailexpert-node-backup}
UNITS=(mailexpert-eop-ranges.service mailexpert-eop-ranges.timer mailexpert-node-firewall.service)
BACKUP_UNITS=(mailexpert-node-backup.service mailexpert-node-backup.timer)
# Set by setup_node_backups: 1 once the restic keys are in node.env and the repository opens; the
# problem when a first setup of backups could not open or create it.
BACKUPS_ON=0
BACKUP_PROBLEM=''
MAX_PANEL_IPS=10

usage() {
  sed -n '2,/^# shellcheck/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

mailcow_compose() { (cd "$MAILCOW_DIR" && docker compose "$@"); }
service_running() { [ -n "$(mailcow_compose ps -q "$1" 2>/dev/null)" ]; }
restart_marker() { printf '%s/restart-pending-%s\n' "$NODE_STATE" "$1"; }

# restart_service <service>: restarts a running mailcow service (a stopped one reads its files when
# it starts). A failed restart leaves a marker, and the next run tries again.
restart_service() {
  local service=$1
  if ! service_running "$service"; then
    rm -f "$(restart_marker "$service")"
    log "$service is not running: it reads its files when it starts"
    return 0
  fi
  if mailcow_compose restart "$service" >/dev/null; then
    rm -f "$(restart_marker "$service")"
    log "$service restarted"
  else
    mkdir -p "$NODE_STATE"
    : >"$(restart_marker "$service")"
    warn "$service did not restart; the next run of setup.sh tries again"
  fi
}

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

# show_diff <path> <old file or missing> <new file>
show_diff() {
  local old=$2
  [ -f "$old" ] || old=/dev/null
  diff -u -L "a$1" -L "b$1" "$old" "$3" || true
}

# changed <old file or missing> <new file>
changed() { [ ! -f "$1" ] || ! cmp -s "$1" "$2"; }

ensure_tools() {
  local -a missing=()
  local tool
  for tool in docker curl jq ipset iptables flock diff cmp ss; do
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
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null || die "apt-get update failed"
  apt-get install -y -qq curl jq ipset iptables util-linux diffutils iproute2 >/dev/null || die "apt-get install failed"
}

install_scripts() {
  install -d -m 755 "$NODE_DIR"
  install -m 755 "$SCRIPT_DIR/eop-ranges.sh" "$NODE_DIR/eop-ranges.sh"
  install -m 644 "$SCRIPT_DIR/lib.sh" "$NODE_DIR/lib.sh"
  install -m 644 "$LIB_DIR/common.sh" "$NODE_DIR/common.sh"
  install -m 644 "$LIB_DIR/env.sh" "$NODE_DIR/env.sh"
  install -m 755 "$SCRIPT_DIR/node-backup.sh" "$NODE_DIR/node-backup.sh"
  install -m 755 "$SCRIPT_DIR/node-restore.sh" "$NODE_DIR/node-restore.sh"
  install -m 644 "$SCRIPT_DIR/backup-lib.sh" "$NODE_DIR/backup-lib.sh"
  install -m 644 "$LIB_DIR/backup.sh" "$NODE_DIR/backup.sh"
}

# setup_node_backups: with the restic keys in node.env the repository is opened (created when it
# does not exist yet), the start of backups recorded for the age check and the recovery key shown
# once. A repository that neither opens nor can be created fails the first setup of backups (the
# owner is there to fix the keys: BACKUP_PROBLEM, reported once the firewall's schedule is in place,
# the backup timer is not installed) and is a warning afterwards: the nightly run and its ping
# report it. Without the keys the node runs without backups.
setup_node_backups() {
  local problem set_up=0 since
  node_backup_env
  if ! backup_configured "$NODE_CONF"; then
    log "backups: off; give setup.sh --backup-keys the restic keys on stdin (docs/operations/mail-node.md, section 7)"
    return 0
  fi
  since=$(node_backup_since_file)
  if [ -f "$since" ]; then set_up=1; fi
  load_restic_env
  ensure_image "$RESTIC_IMAGE"
  if ! problem=$(ensure_backup_repo); then
    if [ "$(backup_setup_failure "$set_up" 0)" != warning ]; then
      BACKUP_PROBLEM=$problem
      return 0
    fi
    warn "backups: $problem"
  fi
  if [ ! -f "$since" ]; then date +%s >"$since"; fi
  load_restic_host "$NODE_RESTIC_HOST_PREFIX"
  show_recovery_key_once "$NODE_DIR/node-backup.sh --show-recovery-key"
  BACKUPS_ON=1
}

# end_standby: the move was called off: the mail services may restart and run again; the firewall
# opens with the eop-ranges.sh run that follows.
end_standby() {
  rm -f "$(node_standby_file)"
  mailcow_restart_policy "$MAILCOW_DIR" always "${STANDBY_SERVICES[@]}" || die "docker update --restart=always failed for ${STANDBY_SERVICES[*]}"
  (cd "$MAILCOW_DIR" && docker compose up -d >/dev/null) || die "docker compose up -d failed in $MAILCOW_DIR"
  log "standby ended: ${STANDBY_SERVICES[*]} restart again, mailcow is up, the mail ports open with the firewall below"
}

# render_backup_template <template>: a backup unit or cron file with @DIR@, @TIMEOUT@ (the bound
# of a whole run, from node.env's bounds) and @LOG@ replaced.
render_backup_template() {
  local total
  total=$(node_backup_total_timeout "$(node_setting NODE_BACKUP_DUMP_TIMEOUT "$NODE_BACKUP_DUMP_TIMEOUT_DEFAULT")" \
    "$(node_setting NODE_BACKUP_PUSH_TIMEOUT "$NODE_BACKUP_PUSH_TIMEOUT_DEFAULT")" \
    "$(node_setting NODE_BACKUP_VERIFY_TIMEOUT "$NODE_BACKUP_VERIFY_TIMEOUT_DEFAULT")")
  render_template "$1" "$NODE_DIR" | sed -e "s|@TIMEOUT@|$total|g" -e "s|@LOG@|$BACKUP_LOG|g"
}

# systemctl_do <args...>: systemctl with its own error message shown; a failure stops the run.
systemctl_do() {
  systemctl "$@" >/dev/null || die "systemctl $* failed"
}

# install_schedule: the hourly run and the one at boot.
install_schedule() {
  local unit target tmp timer_changed=0 backup_timer_changed=0
  local -a units
  if [ "$(init_system)" = systemd ]; then
    units=("${UNITS[@]}")
    if [ "$BACKUPS_ON" = 1 ]; then units+=("${BACKUP_UNITS[@]}"); fi
    tmp=$(mktemp)
    for unit in "${units[@]}"; do
      target=$SYSTEMD_DIR/$unit
      case $unit in
        mailexpert-node-backup.*) render_backup_template "$SCRIPT_DIR/systemd/$unit" >"$tmp" ;;
        *) render_template "$SCRIPT_DIR/systemd/$unit" "$NODE_DIR" >"$tmp" ;;
      esac
      if changed "$target" "$tmp"; then
        install -m 644 "$tmp" "$target"
        log "systemd: $unit written"
        [ "$unit" != mailexpert-eop-ranges.timer ] || timer_changed=1
        [ "$unit" != mailexpert-node-backup.timer ] || backup_timer_changed=1
      fi
    done
    rm -f "$tmp"
    systemctl_do daemon-reload
    systemctl_do enable mailexpert-node-firewall.service
    systemctl_do enable --now mailexpert-eop-ranges.timer
    # A timer already running keeps its old schedule until restarted.
    if [ "$timer_changed" = 1 ]; then systemctl_do restart mailexpert-eop-ranges.timer; fi
    log "systemd: mailexpert-eop-ranges.timer (hourly) and mailexpert-node-firewall.service (boot, before Docker) enabled"
    if [ "$BACKUPS_ON" = 1 ]; then
      systemctl_do enable --now mailexpert-node-backup.timer
      if [ "$backup_timer_changed" = 1 ]; then systemctl_do restart mailexpert-node-backup.timer; fi
      log "systemd: mailexpert-node-backup.timer (nightly, 02:30) enabled"
    fi
  else
    tmp=$(mktemp)
    render_template "$SCRIPT_DIR/cron/mailexpert-node" "$NODE_DIR" >"$tmp"
    if changed "$CRON_FILE" "$tmp"; then
      install -m 644 "$tmp" "$CRON_FILE"
      log "cron: $CRON_FILE written (no systemd on this host)"
    fi
    if [ "$BACKUPS_ON" = 1 ]; then
      render_backup_template "$SCRIPT_DIR/cron/mailexpert-node-backup" >"$tmp"
      if changed "$BACKUP_CRON_FILE" "$tmp"; then
        install -m 644 "$tmp" "$BACKUP_CRON_FILE"
        log "cron: $BACKUP_CRON_FILE written (nightly backup, no systemd on this host)"
      fi
      if [ ! -e "$BACKUP_LOG" ]; then install -m 600 /dev/null "$BACKUP_LOG"; fi
      sed "s|@LOG@|$BACKUP_LOG|g" "$SCRIPT_DIR/logrotate/mailexpert-node-backup" >"$tmp"
      if changed "$LOGROTATE_FILE" "$tmp"; then
        install -D -m 644 "$tmp" "$LOGROTATE_FILE"
        log "logrotate: $LOGROTATE_FILE written ($BACKUP_LOG weekly)"
      fi
    fi
    rm -f "$tmp"
    warn "cron: at boot the firewall comes back about a minute after the start (@reboot), not before Docker"
  fi
}

# warn_foreign_rules: other DOCKER-USER rules on mailcow's mail ports (left from the runbook's
# earlier setup by hand) decide before or after the node's chain.
warn_foreign_rules() {
  local family rules
  for family in 4 6; do
    rules=$(foreign_port_rules "$family")
    [ -n "$rules" ] || continue
    warn "DOCKER-USER (IPv$family) has other rules on mailcow's mail ports; remove them by hand (and from netfilter-persistent's saved rules):"
    printf '  %s\n' "$rules" >&2
  done
}

main() {
  local eop_host='' ping_url='' client_id='' net mailcow_conf extra_cf dovecot_conf tmp
  local conflicts rc=0 restart_note='' family rules service listeners
  local -a panel_ips=() given_ips=() parts=() settings=() keys=()
  local stored_conf=0 backup_keys=0 end_standby=0 line
  DRY_RUN=0
  MAILCOW_DIR=''
  while [ $# -gt 0 ]; do
    case $1 in
      --mailcow-dir | --eop-host | --panel-ip | --ping-url | --client-request-id)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        case $1 in
          --mailcow-dir) MAILCOW_DIR=${2%/} ;;
          --eop-host) eop_host=${2,,} ;;
          --panel-ip) IFS=',' read -r -a parts <<<"$2" && given_ips+=("${parts[@]}") ;;
          --ping-url) ping_url=$2 ;;
          --client-request-id) client_id=$2 ;;
        esac
        shift 2
        ;;
      --dry-run) DRY_RUN=1 && shift ;;
      --backup-keys) backup_keys=1 && shift ;;
      --end-standby) end_standby=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  [ "$(id -u)" = 0 ] || die "run setup.sh as root"

  # What a previous run stored fills what this one was not given.
  if [ -f "$NODE_CONF" ]; then stored_conf=1; fi
  [ -n "$MAILCOW_DIR" ] || MAILCOW_DIR=$(env_get "$NODE_CONF" MAILCOW_DIR 2>/dev/null) || MAILCOW_DIR=/opt/mailcow-dockerized
  [ -n "$eop_host" ] || eop_host=$(env_get "$NODE_CONF" EOP_HOST 2>/dev/null) || eop_host=''
  [ -n "$ping_url" ] || ping_url=$(env_get "$NODE_CONF" EOP_RANGES_PING_URL 2>/dev/null) || ping_url=''
  [ -n "$client_id" ] || client_id=$(env_get "$NODE_CONF" EOP_CLIENT_REQUEST_ID 2>/dev/null) || client_id=''
  if [ "${#given_ips[@]}" -gt 0 ]; then
    for net in "${given_ips[@]}"; do
      net=${net//[[:space:]]/}
      [ -n "$net" ] || continue
      is_panel_network "$net" ||
        die "--panel-ip: $net is not an IPv4 or IPv6 address, or a network no wider than /$PANEL_MIN_PREFIX4 (IPv4) or /$PANEL_MIN_PREFIX6 (IPv6)" 2
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
  if docker_nftables; then
    die "Docker runs its nftables firewall backend ($DOCKER_DAEMON_JSON): there is no DOCKER-USER chain for these rules; switch Docker back to iptables or firewall the node by hand" 1
  fi
  ensure_tools

  mailcow_conf=$MAILCOW_DIR/mailcow.conf
  extra_cf=$MAILCOW_DIR/data/conf/postfix/extra.cf
  dovecot_conf=$MAILCOW_DIR/data/conf/dovecot/extra.conf
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # the directory is known now
  trap "rm -rf '$tmp'" EXIT

  # The plan: every file as it should be, before anything is written.
  mapfile -t settings < <(mailcow_settings "$mailcow_conf")
  keys=("${settings[@]%%=*}")
  kv_render "$mailcow_conf" "${settings[@]}" >"$tmp/mailcow.conf"
  if [ -n "$eop_host" ]; then
    if [ -f "$extra_cf" ]; then cat "$extra_cf" >"$tmp/extra.cf"; fi
    sh "$SCRIPT_DIR/extra-cf.sh" set "$tmp/extra.cf" relayhost "$eop_host"
  fi
  if ! dovecot_render "$dovecot_conf" "$SCRIPT_DIR/dovecot-extra.conf" >"$tmp/dovecot.conf"; then
    conflicts=$(<"$tmp/dovecot.conf")
    die "$dovecot_conf sets what dovecot-extra.conf sets, outside its block; remove these lines by hand and run again:
$conflicts" 2
  fi
  # node.env: an EXT_IF from an earlier version is no longer used.
  if [ "$stored_conf" = 1 ]; then grep -v '^EXT_IF=' "$NODE_CONF" >"$tmp/node.env" || true; fi
  env_set "$tmp/node.env" MAILCOW_DIR "$MAILCOW_DIR"
  env_set "$tmp/node.env" MAILCOW_ENABLE_IPV6 false
  env_set "$tmp/node.env" EOP_CLIENT_REQUEST_ID "$client_id"
  env_set "$tmp/node.env" PANEL_IPS "$(IFS=,; echo "${panel_ips[*]}")"
  if [ -n "$eop_host" ]; then env_set "$tmp/node.env" EOP_HOST "$eop_host"; fi
  if [ -n "$ping_url" ]; then env_set "$tmp/node.env" EOP_RANGES_PING_URL "$ping_url"; fi
  if [ "$backup_keys" = 1 ]; then
    if [ -t 0 ]; then log "--backup-keys: paste KEY=VALUE lines, then press Ctrl-D"; fi
    parse_backup_keys "$NODE_CONF" "$tmp/backup-keys" || die "--backup-keys: nothing was written" 2
    while IFS= read -r line; do
      env_set "$tmp/node.env" "${line%%=*}" "${line#*=}"
    done <"$tmp/backup-keys"
    rm -f "$tmp/backup-keys"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    log "dry run: nothing is changed"
    if changed "$mailcow_conf" "$tmp/mailcow.conf"; then
      printf '%s (only the keys setup.sh sets):\n' "$mailcow_conf"
      kv_changes "$mailcow_conf" "$tmp/mailcow.conf" "${keys[@]}" | sed 's/^/  /'
    fi
    if [ -n "$eop_host" ]; then show_diff "$extra_cf" "$extra_cf" "$tmp/extra.cf"; else log "extra.cf: skipped, no --eop-host yet"; fi
    show_diff "$dovecot_conf" "$dovecot_conf" "$tmp/dovecot.conf"
    # node.env holds the ping URL, which carries its check's key: keys only.
    if changed "$NODE_CONF" "$tmp/node.env"; then log "$NODE_CONF: would be written (keys: $(cut -d= -f1 "$tmp/node.env" | paste -sd' ' -))"; fi
    for family in 4 6; do
      [ "$family" = 4 ] || ipt 6 -S DOCKER-USER >/dev/null 2>&1 || continue
      printf 'IPv%s chain %s (DOCKER-USER jumps to it):\n' "$family" "$NODE_CHAIN"
      while IFS= read -r rules; do
        printf '  -A %s %s\n' "$NODE_CHAIN" "$rules"
      done < <(firewall_rules "$family" "${panel_ips[@]}")
    done
    warn_foreign_rules
    log "schedule: $(init_system), hourly eop-ranges.sh and eop-ranges.sh --restore at boot, from $NODE_DIR"
    if backup_configured "$tmp/node.env"; then
      log "backups: the restic repository would be opened or created, and node-backup.sh run nightly at 02:30"
    else
      log "backups: off (no restic keys; give them with --backup-keys on stdin)"
    fi
    return 0
  fi

  # mailcow.conf: in effect at the next full down and up of mailcow.
  if changed "$mailcow_conf" "$tmp/mailcow.conf"; then
    kv_changes "$mailcow_conf" "$tmp/mailcow.conf" "${keys[@]}" | sed 's/^/  mailcow.conf /' >&2
    replace_file "$mailcow_conf" "$tmp/mailcow.conf" || die "could not write $mailcow_conf"
    if service_running postfix-mailcow; then
      restart_note="mailcow.conf changed: run 'docker compose down && docker compose up -d' in $MAILCOW_DIR (a restart is not enough)"
    fi
    log "mailcow.conf: services, ENABLE_IPV6 and the IPv4 port bindings set"
  else
    log "mailcow.conf: unchanged"
  fi

  if [ -z "$eop_host" ]; then
    log "extra.cf: skipped, no --eop-host yet (run again with it once the first domain's MX is known)"
  elif changed "$extra_cf" "$tmp/extra.cf"; then
    show_diff "$extra_cf" "$extra_cf" "$tmp/extra.cf" >&2
    replace_file "$extra_cf" "$tmp/extra.cf" || die "could not write $extra_cf"
    log "extra.cf: relayhost = $eop_host"
    restart_service postfix-mailcow
  else
    log "extra.cf: unchanged"
  fi

  if changed "$dovecot_conf" "$tmp/dovecot.conf"; then
    show_diff "$dovecot_conf" "$dovecot_conf" "$tmp/dovecot.conf" >&2
    replace_file "$dovecot_conf" "$tmp/dovecot.conf" || die "could not write $dovecot_conf"
    log "dovecot extra.conf: written (IMAP sessions reconnect after the restart)"
    restart_service dovecot-mailcow
  else
    log "dovecot extra.conf: unchanged"
  fi
  # Restarts an earlier run could not do.
  for service in postfix-mailcow dovecot-mailcow; do
    if [ -f "$(restart_marker "$service")" ]; then restart_service "$service"; fi
  done

  install -d -m 700 "$(dirname "$NODE_CONF")"
  if changed "$NODE_CONF" "$tmp/node.env"; then
    install -m 600 "$tmp/node.env" "$NODE_CONF"
    log "$NODE_CONF: written"
  fi
  install -d -m 755 "$NODE_STATE"
  install_scripts

  # The EOP ranges first, the firewall with them: eop-ranges.sh fills the sets, then puts the
  # chain in place and checks the node; it never installs the port 25 rules while a set is empty.
  if [ -f "$(node_standby_file)" ]; then
    if [ "$end_standby" = 1 ]; then
      end_standby
    else
      warn "this node is standby (it made its move backup): its mail ports stay closed and its backup skipped; --end-standby if the move is called off"
    fi
  fi
  # A server node-restore.sh restored serves mail from now on: never restored over again.
  node_backup_env
  if [ -f "$(restore_marker_file)" ] && [ "$(env_get "$(restore_marker_file)" STATE 2>/dev/null || true)" != live ]; then
    mark_restore_live
    log "this server's restore is marked live: node-restore.sh does not restore over it any more"
  fi
  "$NODE_DIR/eop-ranges.sh" || rc=$?
  if [ "$rc" != 0 ]; then
    if active_chain 4 >/dev/null; then
      warn "eop-ranges.sh reported a problem (above); the EOP ranges and firewall rules in place stay"
    else
      die "eop-ranges.sh failed and no firewall rules are in place: fix the cause above and run setup.sh again" 1
    fi
  fi
  if [ -f "$(node_standby_file)" ]; then
    log "firewall: standby, every mail port closed"
  else
    log "firewall: port 25 from EOP only, ${PANEL_PORTS} from ${panel_ips[*]} only, ${CLOSED_PORTS} closed"
  fi
  warn_foreign_rules
  setup_node_backups
  install_schedule
  if [ -n "$BACKUP_PROBLEM" ]; then
    die "backups: $BACKUP_PROBLEM; the keys are stored in $NODE_CONF: fix the storage or the keys (--backup-keys) and run setup.sh again"
  fi
  if ! mailcow_ipv6_enabled "$tmp/mailcow.conf"; then
    listeners=$(ipv6_listeners "$tmp/mailcow.conf" | paste -sd, -)
    if [ -n "$listeners" ]; then
      warn "ports $listeners still listen on IPv6 (docker-proxy on [::]), past the firewall: run 'docker compose down && docker compose up -d' in $MAILCOW_DIR"
    fi
  fi
  if [ -n "$restart_note" ]; then warn "$restart_note"; fi
  log "done"
}

main "$@"; exit $?
