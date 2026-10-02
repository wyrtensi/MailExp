# Loaded by the mail node .bats files after helper.bash: the node's library, the mocks of docker,
# iptables, ip6tables, ipset, curl and systemctl first on PATH, a mailcow directory as
# generate_config.sh leaves it, and every path of the node under the test's temporary directory.
NODE_SCRIPTS=$DEPLOY_DIR/mail-node
MOCK_FIXTURES=$BATS_TEST_DIRNAME/mail-node
export MOCK_FIXTURES

mail_node_setup() {
  local bin=$BATS_TEST_TMPDIR/bin
  export MOCK_DIR=$BATS_TEST_TMPDIR/mock
  mkdir -p "$bin" "$MOCK_DIR"
  cp "$MOCK_FIXTURES"/mocks/* "$bin/"
  cp "$bin/iptables" "$bin/ip6tables"
  chmod +x "$bin"/*
  export PATH=$bin:$PATH
  export MAILEXPERT_NODE_CONF=$BATS_TEST_TMPDIR/etc/node.env
  export MAILEXPERT_NODE_STATE=$BATS_TEST_TMPDIR/state
  export MAILEXPERT_NODE_DIR=$BATS_TEST_TMPDIR/opt
  export MAILEXPERT_SYSTEMD_DIR=$BATS_TEST_TMPDIR/systemd
  export MAILEXPERT_CRON_FILE=$BATS_TEST_TMPDIR/cron.d/mailexpert-node
  export MAILEXPERT_NODE_INIT=systemd
  export MOCK_VERSION_FILE=$MOCK_FIXTURES/version.json
  export MOCK_ENDPOINTS_FILE=$MOCK_FIXTURES/endpoints.json
  mkdir -p "$MAILEXPERT_SYSTEMD_DIR" "$BATS_TEST_TMPDIR/cron.d"
  MC=$BATS_TEST_TMPDIR/mailcow
  mkdir -p "$MC/data/conf/postfix" "$MC/data/conf/dovecot"
  cat >"$MC/mailcow.conf" <<'EOF'
# ------------------------------
# mailcow web ui configuration
# ------------------------------
MAILCOW_HOSTNAME=mail.example.com
DBPASS=not-a-real-password
SMTP_PORT=25
ENABLE_IPV6=true
SKIP_CLAMD=n
SKIP_FTS=n
EOF
  chmod 640 "$MC/mailcow.conf"
  printf 'myhostname = mail.example.com\n' >"$MC/data/conf/postfix/extra.cf"
  # Docker made its chain.
  mkdir -p "$MOCK_DIR/ipt4" "$MOCK_DIR/ipt6"
  : >"$MOCK_DIR/ipt4/DOCKER-USER"
  : >"$MOCK_DIR/ipt6/DOCKER-USER"
  # These libraries are what setup.sh loads; the tests call their functions directly too.
  # shellcheck source=/dev/null
  source "$NODE_SCRIPTS/lib.sh"
}

# The node's chain as the mock holds it, and DOCKER-USER.
chain4() { cat "$MOCK_DIR/ipt4/MAILEXPERT-NODE"; }
docker_user4() { cat "$MOCK_DIR/ipt4/DOCKER-USER"; }
set_entries() { cat "$MOCK_DIR/ipset/$1"; }
calls() { cat "$MOCK_DIR/calls" 2>/dev/null; }
pings() { cat "$MOCK_DIR/pings" 2>/dev/null; }
requests() { cat "$MOCK_DIR/requests" 2>/dev/null; }

# lacks <extended regex>: fails when a line of stdin matches. A plain `! grep` does not fail a
# bats test unless it is the test's last line.
lacks() {
  local hit
  hit=$(grep -E -- "$1" || true)
  [ -z "$hit" ] || { printf 'unexpected: %s\n' "$hit" >&2; return 1; }
}

# A node.env as setup.sh writes it.
write_node_env() {
  mkdir -p "$(dirname "$MAILEXPERT_NODE_CONF")"
  cat >"$MAILEXPERT_NODE_CONF" <<EOF
MAILCOW_DIR=$MC
EOP_CLIENT_REQUEST_ID=6f1c2a64-0d55-4a5e-9a11-3b2f6f0f7c21
PANEL_IPS=203.0.113.10
EXT_IF=eth0
EOP_RANGES_PING_URL=https://hc.example.com/ping/eop-check
EOF
}

# The recorded endpoints answer with the Exchange entry of TCP 25 changed by a jq filter.
endpoints_with() {
  jq "map(if .serviceArea == \"Exchange\" and .tcpPorts == \"25\" then $1 else . end)" "$MOCK_FIXTURES/endpoints.json" >"$BATS_TEST_TMPDIR/endpoints.json"
  export MOCK_ENDPOINTS_FILE=$BATS_TEST_TMPDIR/endpoints.json
}
