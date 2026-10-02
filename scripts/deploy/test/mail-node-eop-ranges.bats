#!/usr/bin/env bats
# eop-ranges.sh (R-40): the EOP ranges of the mail node host from recorded answers of the Microsoft
# 365 endpoints web service (2026-10-02, version 2026081400): version check, parsing, atomic swap of
# the ipsets, the plain list for the panel, the node checks, Healthchecks pings and never applying a
# bad list.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  load mail-node/helper
  mail_node_setup
  EOP_RANGES=$NODE_SCRIPTS/eop-ranges.sh
  write_node_env
  # IPv4 only, as setup.sh leaves mailcow (D-13).
  sed -i 's/^ENABLE_IPV6=.*/ENABLE_IPV6=false/' "$MC/mailcow.conf"
}

V4='40.92.0.0/15 40.107.0.0/16 52.100.0.0/14 104.47.0.0/17'
V6='2a01:111:f400::/48 2a01:111:f403::/48'
FAIL_PING='https://hc.example.com/ping/eop-check/fail eop-ranges:'

@test "the version of the recorded answer, its undocumented serviceArea and any new field skipped" {
  [ "$(eop_latest_version <"$MOCK_FIXTURES/version.json")" = 2026081400 ]
  [ "$(eop_latest_version <<<'{"instance":"Worldwide","serviceArea":"O365Default","latest":"2026100100","somethingNew":{"a":1}}')" = 2026100100 ]
  [ "$(eop_latest_version <<<'[{"instance":"China","latest":"2026073100"},{"instance":"Worldwide","latest":"2026081400"}]')" = 2026081400 ]
  for bad in '{}' '{"latest":"20260814"}' '{"latest":"latest"}' '[]' 'not json' ''; do
    run eop_latest_version <<<"$bad"
    [ "$status" -eq 1 ]
  done
}

@test "the recorded endpoints answer gives the Exchange entry with TCP 25, IPv4 first, not chosen by id" {
  run eop_ranges_from_endpoints <"$MOCK_FIXTURES/endpoints.json"
  [ "$status" -eq 0 ]
  [ "$(echo $output)" = "$V4 $V6" ]
  # Entry 9 (TCP 443) lists 52.238.78.88/32 next to the same ranges; it is not port 25.
  [[ $output != *52.238.78.88* ]]
}

@test "a port list with blanks counts, an entry of another service area does not" {
  run eop_ranges_from_endpoints <<<'[
    {"id":2,"serviceArea":"Exchange","tcpPorts":"143, 25 ,993","ips":["198.51.100.0/24","2001:DB8::/32"]},
    {"id":56,"serviceArea":"Common","tcpPorts":"25","ips":["192.0.2.0/24"]},
    {"id":10,"serviceArea":"Exchange","tcpPorts":"25","ips":["198.51.100.0/24"],"brandNew":true}]'
  [ "$status" -eq 0 ]
  [ "$output" = $'198.51.100.0/24\n2001:db8::/32' ]
}

@test "an empty, IPv6-only, malformed, too wide or non-list answer gives no list" {
  local bad
  for bad in '[]' '{}' 'not json' \
    '[{"serviceArea":"Exchange","tcpPorts":"25"}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":[]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["2a01:111:f400::/48"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["40.92.0.0/15","40.107.0.0/33"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["40.92.0.0"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["300.1.2.0/24"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["0.0.0.0/0"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["40.0.0.0/7"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["40.92.0.0/15","2a01::/16"]}]' \
    '[{"serviceArea":"Exchange","tcpPorts":"25","ips":["40.92.0.0/15","eop.example.com/24"]}]'; do
    run eop_ranges_from_endpoints <<<"$bad"
    [ "$status" -eq 1 ]
    [ -z "$output" ]
  done
  # The narrowest allowed widths pass.
  [ "$(eop_ranges_check <<<$'40.0.0.0/8\n2a01::/24')" = $'40.0.0.0/8\n2a01::/24' ]
}

@test "the first run fills the IPv4 set, writes the list and the version, puts the firewall in place and pings" {
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  [ ! -e "$MOCK_DIR/ipset/mailexpert-eop6" ]
  [ "$(echo $(cat "$MAILEXPERT_NODE_STATE/eop-ranges.txt"))" = "$V4 $V6" ]
  [ "$(cat "$MAILEXPERT_NODE_STATE/eop-version")" = 2026081400 ]
  # Both calls carry the installation's own ClientRequestId.
  [ "$(requests | grep -c 'clientrequestid=6f1c2a64-0d55-4a5e-9a11-3b2f6f0f7c21$')" -eq 2 ]
  requests | grep -q '/endpoints/Worldwide?ServiceAreas=Exchange&clientrequestid='
  # The set is filled whole aside, then swapped in.
  calls | grep -q '^ipset swap mailexpert-eop4-new mailexpert-eop4$'
  [ ! -e "$MOCK_DIR/ipset/mailexpert-eop4-new" ]
  grep -qx -- '-j MAILEXPERT-NODE' "$MOCK_DIR/ipt4/DOCKER-USER"
  [ "$(chain4)" = "$(firewall_rules 4 203.0.113.10)" ]
  [ "$(pings)" = 'https://hc.example.com/ping/eop-check eop-ranges: version 2026081400, 4 IPv4 and 2 IPv6 ranges' ]
}

@test "the same version again is a no-op that only asks for the version" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/calls" && : >"$MOCK_DIR/requests" && : >"$MOCK_DIR/pings"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [[ $output == *"version 2026081400 unchanged"* ]]
  [ "$(requests | wc -l)" -eq 1 ]
  calls | lacks '^ipset (restore|swap)'
  calls | lacks ' -(N|A|I|D|F|X) '
  [ "$(pings)" = 'https://hc.example.com/ping/eop-check eop-ranges: version 2026081400 unchanged' ]
}

@test "the same version with sets that differ from the saved list refills them from it, without asking for the ranges" {
  bash "$EOP_RANGES"
  sed -i '/104.47/d' "$MOCK_DIR/ipset/mailexpert-eop4"
  : >"$MOCK_DIR/requests"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [[ $output == *"filled again from it"* ]]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  [ "$(requests | wc -l)" -eq 1 ]
}

@test "a new version with a new field in the answer swaps in the new ranges and says the panel's copy is behind" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/pings"
  jq '.latest = "2026100100" | .addedLater = ["x"]' "$MOCK_FIXTURES/version.json" >"$BATS_TEST_TMPDIR/version.json"
  export MOCK_VERSION_FILE=$BATS_TEST_TMPDIR/version.json
  endpoints_with '.ips = ["40.92.0.0/15", "52.100.0.0/14", "198.51.100.0/24", "2a01:111:f400::/48"]'
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(echo $(set_entries mailexpert-eop4))" = '40.92.0.0/15 52.100.0.0/14 198.51.100.0/24' ]
  [ "$(cat "$MAILEXPERT_NODE_STATE/eop-version")" = 2026100100 ]
  [ "$(echo $(cat "$MAILEXPERT_NODE_STATE/eop-ranges.txt"))" = '40.92.0.0/15 52.100.0.0/14 198.51.100.0/24 2a01:111:f400::/48' ]
  [ "$(calls | grep -c '^ipset swap')" -eq 2 ]
  [[ $output == *"update the panel's copy"* ]]
  [ "$(pings)" = 'https://hc.example.com/ping/eop-check eop-ranges: eop_ranges_version_changed 2026081400->2026100100, version 2026100100, 3 IPv4 and 1 IPv6 ranges' ]
}

@test "400 without a GUID: refused before asking, and the service's own 400 keeps the list" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/requests" && : >"$MOCK_DIR/pings"
  sed -i 's/^EOP_CLIENT_REQUEST_ID=.*/EOP_CLIENT_REQUEST_ID=/' "$MAILEXPERT_NODE_CONF"
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"not a GUID"* ]]
  [ -z "$(requests)" ]
  [[ $(pings) == "$FAIL_PING EOP_CLIENT_REQUEST_ID"* ]]
  # The service answers 400 to a request without the id (the mock does what the service does).
  write_node_env
  export MOCK_VERSION_STATUS=400
  run bash "$EOP_RANGES" --force
  [ "$status" -eq 1 ]
  [[ $output == *"HTTP 400"*"ClientRequestId"* ]]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  [ "$(cat "$MAILEXPERT_NODE_STATE/eop-version")" = 2026081400 ]
}

@test "429 keeps the list and the version, and pings fail" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/pings"
  jq '.latest = "2026100100"' "$MOCK_FIXTURES/version.json" >"$BATS_TEST_TMPDIR/version.json"
  export MOCK_VERSION_FILE=$BATS_TEST_TMPDIR/version.json MOCK_ENDPOINTS_STATUS=429
  before=$(cat "$MAILEXPERT_NODE_STATE/eop-ranges.txt")
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"HTTP 429"* ]]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  [ "$(cat "$MAILEXPERT_NODE_STATE/eop-ranges.txt")" = "$before" ]
  [ "$(cat "$MAILEXPERT_NODE_STATE/eop-version")" = 2026081400 ]
  [[ $(pings) == "$FAIL_PING endpoints: HTTP 429"* ]]
}

@test "an empty, malformed or too wide list is never applied" {
  bash "$EOP_RANGES"
  for filter in '.ips = []' '.ips = ["2a01:111:f400::/48"]' '.ips = ["40.92.0.0/15", "40.92.0.0/40"]' '.ips = ["0.0.0.0/0"]' '.tcpPorts = "443"'; do
    endpoints_with "$filter"
    run bash "$EOP_RANGES" --force
    [ "$status" -eq 1 ]
    [[ $output == *"the current EOP ranges stay"* ]]
    [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  done
  printf '[]' >"$BATS_TEST_TMPDIR/empty.json"
  export MOCK_ENDPOINTS_FILE=$BATS_TEST_TMPDIR/empty.json
  run bash "$EOP_RANGES" --force
  [ "$status" -eq 1 ]
  [ "$(echo $(cat "$MAILEXPERT_NODE_STATE/eop-ranges.txt"))" = "$V4 $V6" ]
}

@test "no answer at all keeps the list" {
  export MOCK_VERSION_STATUS=000
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"no answer from https://endpoints.office.com"* ]]
  [ ! -e "$MOCK_DIR/ipset/mailexpert-eop4" ]
  [ ! -e "$MOCK_DIR/ipt4/MAILEXPERT-NODE" ]
}

@test "IPv6 gets its own set and chain when mailcow runs with IPv6" {
  sed -i 's/^ENABLE_IPV6=.*/ENABLE_IPV6=true/' "$MC/mailcow.conf"
  sed -i 's/^MAILCOW_ENABLE_IPV6=.*/MAILCOW_ENABLE_IPV6=true/' "$MAILEXPERT_NODE_CONF"
  with_ipv6_docker_user
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(echo $(set_entries mailexpert-eop6))" = "$V6" ]
  grep -qx -- '-j MAILEXPERT-NODE' "$MOCK_DIR/ipt6/DOCKER-USER"
  grep -q -- '--match-set mailexpert-eop6 src -j RETURN' "$MOCK_DIR/ipt6/MAILEXPERT-NODE"
}

@test "an IPv6 DOCKER-USER gets the IPv6 rules even with IPv6 off in mailcow" {
  with_ipv6_docker_user
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  grep -qx -- '-j MAILEXPERT-NODE' "$MOCK_DIR/ipt6/DOCKER-USER"
}

@test "IPv6 without IPv6 ranges: an empty set, port 25 closed to IPv6, and no fetch every hour" {
  with_ipv6_docker_user
  endpoints_with '.ips = ["40.92.0.0/15"]'
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ -z "$(set_entries mailexpert-eop6)" ]
  grep -q -- '--dport 25 -j DROP' "$MOCK_DIR/ipt6/MAILEXPERT-NODE"
  : >"$MOCK_DIR/requests"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(requests | wc -l)" -eq 1 ]
}

@test "a firewall that cannot be put in place fails the hourly run" {
  export MOCK_IPT_REFUSE='-j RETURN'
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"firewall (IPv4): the rules are not in place"* ]]
  [[ $(pings) == "$FAIL_PING firewall (IPv4): the rules are not in place"* ]]
  # Without DOCKER-USER (Docker stopped, or its nftables backend) the hourly run does not make one.
  unset MOCK_IPT_REFUSE
  rm -f "$MOCK_DIR/ipt4/DOCKER-USER"
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"no DOCKER-USER chain"* ]]
  [ ! -e "$MOCK_DIR/ipt4/DOCKER-USER" ]
}

@test "a chain flushed or edited behind the run's back is rebuilt, the jump never missing" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/ipt4/MAILEXPERT-NODE"
  : >"$MOCK_DIR/calls"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [[ $output == *"rules put in place"* ]]
  [ "$(chain4)" = "$(firewall_rules 4 203.0.113.10)" ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE-2' ]
  [ "$(chains4)" = MAILEXPERT-NODE-2 ]
  # The jump to the new chain went in before the old one was taken out.
  [ "$(calls | grep -n -- '-I DOCKER-USER 1 -j MAILEXPERT-NODE-2' | cut -d: -f1)" -lt "$(calls | grep -n -- '-D DOCKER-USER -j MAILEXPERT-NODE$' | cut -d: -f1)" ]
  # A rule taken out by hand.
  sed -i '/--dport 25 -j DROP/d' "$MOCK_DIR/ipt4/MAILEXPERT-NODE-2"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(chain4)" = "$(firewall_rules 4 203.0.113.10)" ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE' ]
}

@test "an old chain that cannot be deleted stays empty, and the next change builds into it" {
  bash "$EOP_RANGES"
  export MOCK_IPT_X_FAIL=MAILEXPERT-NODE
  sed -i 's/^PANEL_IPS=.*/PANEL_IPS=203.0.113.20/' "$MAILEXPERT_NODE_CONF"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE-2' ]
  [ -z "$(cat "$MOCK_DIR/ipt4/MAILEXPERT-NODE")" ]
  sed -i 's/^PANEL_IPS=.*/PANEL_IPS=203.0.113.30/' "$MAILEXPERT_NODE_CONF"
  : >"$MOCK_DIR/calls"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE' ]
  chain4 | grep -q 203.0.113.30
  # The chain in force was never left without its jump.
  calls | lacks '-D DOCKER-USER -j MAILEXPERT-NODE$'
}

@test "mailcow.conf turned back to IPv6 (mailcow's update.sh) fails the run" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/pings"
  sed -i 's/^ENABLE_IPV6=.*/ENABLE_IPV6=true/' "$MC/mailcow.conf"
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"mailcow.conf has ENABLE_IPV6=true, setup.sh set false"* ]]
  [[ $(pings) == "$FAIL_PING"*"mailcow.conf has ENABLE_IPV6=true"* ]]
}

@test "a mail port listening on IPv6 while mailcow runs without it fails the run" {
  printf '0.0.0.0:25\n0.0.0.0:587\n' >"$MOCK_DIR/listeners"
  run bash "$EOP_RANGES"
  [ "$status" -eq 0 ]
  printf '0.0.0.0:25\n[::]:25\n[::]:993\n*:4190\n[::1]:8080\n' >"$MOCK_DIR/listeners"
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"ports 25,993,4190 listen on IPv6"* ]]
  # A host port moved in mailcow.conf is the one looked at.
  sed -i 's/^SMTP_PORT=.*/SMTP_PORT=0.0.0.0:2525/' "$MC/mailcow.conf"
  printf '[::]:2525\n' >"$MOCK_DIR/listeners"
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"ports 2525 listen on IPv6"* ]]
}

@test "Docker's nftables backend fails the run loudly" {
  printf '{ "firewall-backend": "nftables" }\n' >"$MAILEXPERT_DOCKER_DAEMON_JSON"
  run bash "$EOP_RANGES"
  [ "$status" -eq 1 ]
  [[ $output == *"nftables firewall backend"* ]]
  [ ! -e "$MOCK_DIR/ipt4/MAILEXPERT-NODE" ]
}

@test "a dry run prints the change and changes nothing" {
  run bash "$EOP_RANGES" --dry-run
  [ "$status" -eq 0 ]
  [[ $output == *"version none -> 2026081400, 4 IPv4 and 2 IPv6 ranges (dry run: nothing changed)"* ]]
  [[ $output == *"104.47.0.0/17"* ]]
  [ ! -e "$MOCK_DIR/ipset" ]
  [ ! -e "$MAILEXPERT_NODE_STATE/eop-version" ]
  [ -z "$(pings)" ]
  bash "$EOP_RANGES"
  endpoints_with '.ips = ["40.92.0.0/15"]'
  run bash "$EOP_RANGES" --dry-run --force
  [[ $output == *"-40.107.0.0/16"* ]]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
}

@test "ipset refusing the new set leaves the live one as it was" {
  bash "$EOP_RANGES"
  : >"$MOCK_DIR/pings"
  endpoints_with '.ips = ["40.92.0.0/15"]'
  export MOCK_IPSET_FAIL=restore
  run bash "$EOP_RANGES" --force
  [ "$status" -eq 1 ]
  [[ $output == *"ipset refused the new IPv4 set"* ]]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  [[ $(pings) == *"/fail eop-ranges: ipset refused"* ]]
}

@test "--restore puts the sets and the firewall back after a reboot, before Docker, without asking Microsoft" {
  bash "$EOP_RANGES"
  # After a reboot: no sets, and before Docker starts no DOCKER-USER either.
  rm -rf "$MOCK_DIR/ipset" "$MOCK_DIR/ipt4"
  mkdir -p "$MOCK_DIR/ipt4"
  : >"$MOCK_DIR/requests"
  run bash "$EOP_RANGES" --restore
  [ "$status" -eq 0 ]
  [ -z "$(requests)" ]
  [ "$(echo $(set_entries mailexpert-eop4))" = "$V4" ]
  [ "$(docker_user4)" = '-j MAILEXPERT-NODE' ]
  [ "$(chain4)" = "$(firewall_rules 4 203.0.113.10)" ]
  calls | grep -q -- '^iptables -N DOCKER-USER$'
}

@test "--restore refuses a missing or invalid saved list, and fails when the firewall does not go in" {
  bash "$EOP_RANGES"
  printf '0.0.0.0/0\n' >"$MAILEXPERT_NODE_STATE/eop-ranges.txt"
  run bash "$EOP_RANGES" --restore
  [ "$status" -eq 1 ]
  [[ $output == *"no valid saved list"* ]]
  rm -f "$MAILEXPERT_NODE_STATE/eop-ranges.txt"
  run bash "$EOP_RANGES" --restore
  [ "$status" -eq 1 ]
  write_node_env
  bash "$EOP_RANGES" --force
  rm -rf "$MOCK_DIR/ipt4" && mkdir -p "$MOCK_DIR/ipt4"
  : >"$MOCK_DIR/pings"
  export MOCK_IPT_REFUSE='-j RETURN'
  run bash "$EOP_RANGES" --restore
  [ "$status" -eq 1 ]
  [[ $(pings) == "$FAIL_PING firewall (IPv4)"* ]]
}

@test "a missing node.env or bad option is refused with status 2" {
  rm -f "$MAILEXPERT_NODE_CONF"
  run bash "$EOP_RANGES"
  [ "$status" -eq 2 ]
  run bash "$EOP_RANGES" --frob
  [ "$status" -eq 2 ]
}
