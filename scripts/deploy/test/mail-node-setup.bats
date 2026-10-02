#!/usr/bin/env bats
# setup.sh (R-39) and the firewall of the mail node host, with docker, iptables, ip6tables, ipset,
# curl and systemctl mocked: mailcow.conf, extra.cf and Dovecot's extra.conf patched in place,
# restarts only on a change, the DOCKER-USER rules swapped in whole, the timer installed, and a dry
# run that only prints.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  load mail-node/helper
  mail_node_setup
  SETUP=$NODE_SCRIPTS/setup.sh
  export MOCK_RUNNING='postfix-mailcow dovecot-mailcow'
}

first_run() {
  run bash "$SETUP" --mailcow-dir "$MC" --eop-host EOP-Tenant.mail.protection.outlook.com --panel-ip 203.0.113.10 \
    --ping-url https://hc.example.com/ping/eop-check
}

# --- The firewall rules ------------------------------------------------------------------------

@test "the rules: port 25 from the EOP set, the panel's ports from the panel, on the external interface only" {
  run firewall_rules 4 eth0 203.0.113.10 198.51.100.0/28 2001:db8::10
  [ "$status" -eq 0 ]
  [ "$output" = "-i eth0 -p tcp --dport 25 -m set --match-set mailexpert-eop4 src -j RETURN
-i eth0 -p tcp --dport 25 -j DROP
-i eth0 -p tcp -m multiport --dports 587,993 -s 203.0.113.10 -j RETURN
-i eth0 -p tcp -m multiport --dports 587,993 -s 198.51.100.0/28 -j RETURN
-i eth0 -p tcp -m multiport --dports 587,993 -j DROP
-i eth0 -p tcp -m multiport --dports 110,143,465,995,4190 -j DROP" ]
  run firewall_rules 6 eth0 203.0.113.10 2001:db8::10
  [[ $output == *"--match-set mailexpert-eop6 src"* && $output == *"-s 2001:db8::10 -j RETURN"* && $output != *203.0.113.10* ]]
}

@test "the firewall waits for a filled EOP set" {
  run firewall_apply 4 eth0 203.0.113.10
  [ "$status" -eq 1 ]
  [[ $output == *"missing or empty"* ]]
  [ ! -e "$MOCK_DIR/ipt4/MAILEXPERT-NODE" ]
  printf 'create mailexpert-eop4 hash:net family inet\n' | ipset restore
  run firewall_apply 4 eth0 203.0.113.10
  [ "$status" -eq 1 ]
  [ ! -e "$MOCK_DIR/ipt4/MAILEXPERT-NODE" ]
}

@test "the chain is swapped in whole, with one jump, and an unchanged chain is left alone" {
  printf 'create mailexpert-eop4 hash:net family inet\nadd mailexpert-eop4 40.92.0.0/15\n' | ipset restore
  printf -- '-j RETURN\n' >"$MOCK_DIR/ipt4/DOCKER-USER"
  run firewall_apply 4 eth0 203.0.113.10
  [ "$status" -eq 0 ]
  [ "$output" = changed ]
  [ "$(docker_user4)" = $'-j MAILEXPERT-NODE\n-j RETURN' ]
  [ "$(chain4)" = "$(firewall_rules 4 eth0 203.0.113.10)" ]
  : >"$MOCK_DIR/calls"
  run firewall_apply 4 eth0 203.0.113.10
  [ "$output" = unchanged ]
  calls | lacks ' -(N|A|I|D|F|X|E) '
  # A new panel address: a new chain first, then the old one goes.
  run firewall_apply 4 eth0 203.0.113.20
  [ "$output" = changed ]
  [ "$(docker_user4)" = $'-j MAILEXPERT-NODE\n-j RETURN' ]
  chain4 | grep -q -- '-s 203.0.113.20 -j RETURN'
  chain4 | lacks '203\.0\.113\.10'
  [ ! -e "$MOCK_DIR/ipt4/MAILEXPERT-NODE-NEW" ]
  [ "$(calls | grep -n -- '-I DOCKER-USER 1 -j MAILEXPERT-NODE-NEW' | cut -d: -f1)" -lt "$(calls | grep -n -- '-D DOCKER-USER -j MAILEXPERT-NODE$' | cut -d: -f1)" ]
}

@test "a refused rule leaves the old chain and its jump in place" {
  printf 'create mailexpert-eop4 hash:net family inet\nadd mailexpert-eop4 40.92.0.0/15\n' | ipset restore
  firewall_apply 4 eth0 203.0.113.10
  export MOCK_IPT_REFUSE=203.0.113.99
  run firewall_apply 4 eth0 203.0.113.99
  [ "$status" -eq 1 ]
  [ "$(chain4)" = "$(firewall_rules 4 eth0 203.0.113.10)" ]
  grep -qx -- '-j MAILEXPERT-NODE' "$MOCK_DIR/ipt4/DOCKER-USER"
}

# --- mailcow's files ---------------------------------------------------------------------------

@test "mailcow.conf: the four settings set in place, other lines kept, missing ones appended" {
  run kv_render "$MC/mailcow.conf" SKIP_CLAMD=y SKIP_OLEFY=y SKIP_FTS=y ENABLE_IPV6=false
  [ "$status" -eq 0 ]
  [ "$output" = "# ------------------------------
# mailcow web ui configuration
# ------------------------------
MAILCOW_HOSTNAME=mail.example.com
DBPASS=not-a-real-password
SMTP_PORT=25
ENABLE_IPV6=false
SKIP_CLAMD=y
SKIP_FTS=y
SKIP_OLEFY=y" ]
  printf 'SKIP_FTS=n\n#SKIP_FTS=n\nSKIP_FTS=y\n' >"$BATS_TEST_TMPDIR/dup.conf"
  [ "$(kv_render "$BATS_TEST_TMPDIR/dup.conf" SKIP_FTS=y)" = $'SKIP_FTS=y\n#SKIP_FTS=n' ]
}

@test "the Dovecot block: added once, a copy appended by hand becomes the block, other lines kept" {
  local block=$NODE_SCRIPTS/dovecot-extra.conf
  printf 'mail_max_userip_connections = 50\n' >"$BATS_TEST_TMPDIR/extra.conf"
  dovecot_render "$BATS_TEST_TMPDIR/extra.conf" "$block" >"$BATS_TEST_TMPDIR/once"
  [ "$(head -n 1 "$BATS_TEST_TMPDIR/once")" = 'mail_max_userip_connections = 50' ]
  [ "$(grep -c '^# BEGIN MailExpert' "$BATS_TEST_TMPDIR/once")" -eq 1 ]
  [ "$(dovecot_render "$BATS_TEST_TMPDIR/once" "$block")" = "$(cat "$BATS_TEST_TMPDIR/once")" ]
  # The runbook's earlier step: the file appended verbatim.
  { printf 'mail_max_userip_connections = 50\n'; cat "$block"; } >"$BATS_TEST_TMPDIR/by-hand"
  [ "$(dovecot_render "$BATS_TEST_TMPDIR/by-hand" "$block")" = "$(cat "$BATS_TEST_TMPDIR/once")" ]
  # No file yet.
  run dovecot_render "$BATS_TEST_TMPDIR/none" "$block"
  [ "$status" -eq 0 ]
  [[ ${lines[0]} == '# BEGIN MailExpert'* ]]
}

@test "the Dovecot block refuses settings of its own outside it" {
  printf 'service imap {\n  process_limit = 1500\n}\n' >"$BATS_TEST_TMPDIR/extra.conf"
  run dovecot_render "$BATS_TEST_TMPDIR/extra.conf" "$NODE_SCRIPTS/dovecot-extra.conf"
  [ "$status" -eq 3 ]
  [[ $output == *"1:service imap {"* && $output == *"2:  process_limit = 1500"* ]]
}

# --- setup.sh ----------------------------------------------------------------------------------

@test "a dry run prints every change and writes nothing" {
  cp -r "$MC" "$BATS_TEST_TMPDIR/before"
  run bash "$SETUP" --mailcow-dir "$MC" --eop-host eop-tenant.mail.protection.outlook.com --panel-ip 203.0.113.10 --dry-run
  [ "$status" -eq 0 ]
  [[ $output == *"-ENABLE_IPV6=true"*"+ENABLE_IPV6=false"* ]]
  [[ $output == *"+SKIP_OLEFY=y"* ]]
  [[ $output == *"+relayhost = eop-tenant.mail.protection.outlook.com"* ]]
  [[ $output == *"+# BEGIN MailExpert: dovecot-extra.conf"* ]]
  [[ $output == *"-A MAILEXPERT-NODE -i eth0 -p tcp --dport 25 -m set --match-set mailexpert-eop4 src -j RETURN"* ]]
  [[ $output != *"mailexpert-eop6"* ]]
  diff -r "$BATS_TEST_TMPDIR/before" "$MC"
  [ ! -e "$MAILEXPERT_NODE_CONF" ]
  [ ! -e "$MAILEXPERT_NODE_DIR" ]
  [ -z "$(calls)" ]
  [ -z "$(requests)" ]
}

@test "the first run sets up mailcow's files, the EOP ranges, the firewall and the timer" {
  first_run
  [ "$status" -eq 0 ]
  # mailcow.conf patched in place: same mode, other lines kept.
  [ "$(stat -c %a "$MC/mailcow.conf")" = 640 ]
  grep -qx 'ENABLE_IPV6=false' "$MC/mailcow.conf"
  grep -qx 'SKIP_OLEFY=y' "$MC/mailcow.conf"
  grep -qx 'DBPASS=not-a-real-password' "$MC/mailcow.conf"
  [[ $output == *"run 'docker compose down && docker compose up -d' in $MC"* ]]
  [ "$(cat "$MC/data/conf/postfix/extra.cf")" = $'myhostname = mail.example.com\nrelayhost = eop-tenant.mail.protection.outlook.com' ]
  grep -q '^# BEGIN MailExpert: dovecot-extra.conf' "$MC/data/conf/dovecot/extra.conf"
  # Each changed file restarted its own container, in the mailcow directory.
  [ "$(calls | grep -c "docker compose restart postfix-mailcow (in $MC)")" -eq 1 ]
  [ "$(calls | grep -c "docker compose restart dovecot-mailcow (in $MC)")" -eq 1 ]
  # node.env: owner-only, the panel address, a GUID made once.
  [ "$(stat -c %a "$MAILEXPERT_NODE_CONF")" = 600 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" PANEL_IPS)" = 203.0.113.10 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" EXT_IF)" = eth0 ]
  is_guid "$(env_get "$MAILEXPERT_NODE_CONF" EOP_CLIENT_REQUEST_ID)"
  [[ $output != *"hc.example.com/ping/eop-check"* ]]
  # The ranges, then the firewall.
  [ "$(set_entries mailexpert-eop4 | wc -l)" -eq 4 ]
  [ "$(chain4)" = "$(firewall_rules 4 eth0 203.0.113.10)" ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE' ]
  [ ! -e "$MOCK_DIR/ipset/mailexpert-eop6" ]
  [ -s "$MAILEXPERT_NODE_STATE/eop-ranges.txt" ]
  [[ $(pings) == 'https://hc.example.com/ping/eop-check eop-ranges: version 2026081400'* ]]
  # Installed copies and units that point at them.
  [ -x "$MAILEXPERT_NODE_DIR/eop-ranges.sh" ]
  [ -f "$MAILEXPERT_NODE_DIR/common.sh" ]
  grep -qx "ExecStart=$MAILEXPERT_NODE_DIR/eop-ranges.sh" "$MAILEXPERT_SYSTEMD_DIR/mailexpert-eop-ranges.service"
  grep -qx "ExecStart=$MAILEXPERT_NODE_DIR/eop-ranges.sh --restore" "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-firewall.service"
  calls | grep -qx 'systemctl enable --now mailexpert-eop-ranges.timer'
  calls | grep -qx 'systemctl enable mailexpert-node-firewall.service'
}

@test "a second run changes nothing and restarts nothing, with the stored options" {
  first_run
  id=$(env_get "$MAILEXPERT_NODE_CONF" EOP_CLIENT_REQUEST_ID)
  : >"$MOCK_DIR/calls"
  run bash "$SETUP"
  [ "$status" -eq 0 ]
  [[ $output == *"mailcow.conf: unchanged"* && $output == *"extra.cf: unchanged"* && $output == *"dovecot extra.conf: unchanged"* ]]
  calls | lacks 'compose restart'
  calls | lacks '^ipset restore'
  calls | lacks ' -(N|A|I|D|E) '
  [ "$(env_get "$MAILEXPERT_NODE_CONF" EOP_CLIENT_REQUEST_ID)" = "$id" ]
  [[ $output != *"written"* ]]
}

@test "a new panel address replaces the old one in node.env and in the chain" {
  first_run
  run bash "$SETUP" --panel-ip 203.0.113.20,198.51.100.0/28
  [ "$status" -eq 0 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" PANEL_IPS)" = 203.0.113.20,198.51.100.0/28 ]
  [ "$(chain4)" = "$(firewall_rules 4 eth0 203.0.113.20 198.51.100.0/28)" ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE' ]
}

@test "without --eop-host extra.cf is left alone; stopped containers are not restarted" {
  export MOCK_RUNNING=''
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [ "$status" -eq 0 ]
  [[ $output == *"extra.cf: skipped, no --eop-host yet"* ]]
  [ "$(cat "$MC/data/conf/postfix/extra.cf")" = 'myhostname = mail.example.com' ]
  calls | lacks 'compose restart'
  [[ $output != *"docker compose down"* ]]
}

@test "the first EOP fetch failing installs no firewall" {
  export MOCK_VERSION_STATUS=429
  first_run
  [ "$status" -eq 1 ]
  [[ $output == *"no EOP ranges yet: the firewall rules are not installed"* ]]
  [ ! -e "$MOCK_DIR/ipt4/MAILEXPERT-NODE" ]
  [ -z "$(docker_user4)" ]
}

@test "a later EOP fetch failing keeps the ranges and the firewall" {
  first_run
  export MOCK_VERSION_STATUS=429
  run bash "$SETUP"
  [ "$status" -eq 0 ]
  [[ $output == *"the EOP ranges already in place stay"* ]]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE' ]
}

@test "Dovecot settings outside the block stop the run before anything is written" {
  printf 'service imap {\n  process_limit = 1500\n}\n' >"$MC/data/conf/dovecot/extra.conf"
  cp -r "$MC" "$BATS_TEST_TMPDIR/before"
  first_run
  [ "$status" -eq 2 ]
  [[ $output == *"remove these lines by hand"* && $output == *"process_limit = 1500"* ]]
  diff -r "$BATS_TEST_TMPDIR/before" "$MC"
  [ ! -e "$MAILEXPERT_NODE_CONF" ]
}

@test "bad input is refused with status 2" {
  run bash "$SETUP" --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  [[ $output == *"--panel-ip is required"* ]]
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.300
  [ "$status" -eq 2 ]
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --eop-host 'not a host'
  [ "$status" -eq 2 ]
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --client-request-id 1234
  [ "$status" -eq 2 ]
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --ping-url http://hc.example.com/x
  [ "$status" -eq 2 ]
  run bash "$SETUP" --mailcow-dir "$BATS_TEST_TMPDIR/nowhere" --panel-ip 203.0.113.10
  [ "$status" -eq 2 ]
  [[ $output == *"mailcow.conf not found"* ]]
  [ ! -e "$MAILEXPERT_NODE_CONF" ]
}

@test "a given ClientRequestId is kept" {
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --client-request-id 0a1b2c3d-0000-4000-8000-000000000001
  [ "$status" -eq 0 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" EOP_CLIENT_REQUEST_ID)" = 0a1b2c3d-0000-4000-8000-000000000001 ]
  requests | grep -q 'clientrequestid=0a1b2c3d-0000-4000-8000-000000000001$'
}

@test "without systemd the schedule is a cron file" {
  export MAILEXPERT_NODE_INIT=cron
  first_run
  [ "$status" -eq 0 ]
  grep -qx "17 \* \* \* \* root $MAILEXPERT_NODE_DIR/eop-ranges.sh" "$MAILEXPERT_CRON_FILE"
  grep -q "@reboot root sleep 60 && $MAILEXPERT_NODE_DIR/eop-ranges.sh --restore" "$MAILEXPERT_CRON_FILE"
  calls | lacks systemctl
}
