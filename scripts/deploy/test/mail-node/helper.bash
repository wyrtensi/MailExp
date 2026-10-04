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
  # Docker made its IPv4 chain (an IPv6 one only where a test says so: with_ipv6_docker_user).
  mkdir -p "$MOCK_DIR/ipt4" "$MOCK_DIR/ipt6"
  : >"$MOCK_DIR/ipt4/DOCKER-USER"
  export MAILEXPERT_DOCKER_DAEMON_JSON=$BATS_TEST_TMPDIR/daemon.json
  # These libraries are what setup.sh loads; the tests call their functions directly too.
  # shellcheck source=/dev/null
  source "$NODE_SCRIPTS/lib.sh"
}

with_ipv6_docker_user() { : >"$MOCK_DIR/ipt6/DOCKER-USER"; }

# The node's chain in force (whichever of the pair DOCKER-USER jumps to) as the mock holds it, and
# DOCKER-USER.
chain4() {
  local name
  name=$(sed -n 's/^-j \(MAILEXPERT-NODE[-0-9]*\)$/\1/p' "$MOCK_DIR/ipt4/DOCKER-USER" | head -n 1)
  cat "$MOCK_DIR/ipt4/${name:-MAILEXPERT-NODE}"
}
chains4() { ls "$MOCK_DIR/ipt4" | grep MAILEXPERT || true; }
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
MAILCOW_ENABLE_IPV6=false
EOP_CLIENT_REQUEST_ID=6f1c2a64-0d55-4a5e-9a11-3b2f6f0f7c21
PANEL_IPS=203.0.113.10
EOP_RANGES_PING_URL=https://hc.example.com/ping/eop-check
EOF
}

# node_backup_setup: what node-backup.sh and node-restore.sh need on top of mail_node_setup: the
# backup library, mailcow's compose project and its volumes (directories of the docker mock, vmail
# with two mailboxes and mailcow's own _garbage), mailcow's backup script (the fixture), and the
# node's backup directory under the test's temporary directory.
node_backup_setup() {
  export MAILEXPERT_NODE_BACKUP_DIR=$BATS_TEST_TMPDIR/backups
  export MAILEXPERT_BACKUP_CRON_FILE=$BATS_TEST_TMPDIR/cron.d/mailexpert-node-backup
  export MOCK_PROJECT=mailcowdockerized
  printf 'COMPOSE_PROJECT_NAME=mailcowdockerized\n' >>"$MC/mailcow.conf"
  mkdir -p "$MC/helper-scripts" "$MC/data/assets/ssl" "$MC/data/web/inc"
  # What generate_config.sh writes besides mailcow.conf.
  printf '<?php\n' >"$MC/data/web/inc/app_info.inc.php"
  cp "$MOCK_FIXTURES/fake-backup-and-restore" "$MC/helper-scripts/backup_and_restore.sh"
  chmod +x "$MC/helper-scripts/backup_and_restore.sh"
  printf 'services: {}\n' >"$MC/docker-compose.yml"
  printf 'certificate\n' >"$MC/data/assets/ssl/cert.pem"
  local set vmail=$MOCK_DIR/volumes/mailcowdockerized_vmail-vol-1
  for set in crypt redis rspamd postfix mysql; do
    mkdir -p "$MOCK_DIR/volumes/mailcowdockerized_$set-vol-1"
    printf 'data\n' >"$MOCK_DIR/volumes/mailcowdockerized_$set-vol-1/file"
  done
  # mail_crypt's key pair, and the database's two mailboxes (the docker mock's mysql reads it).
  printf 'key\n' >"$MOCK_DIR/volumes/mailcowdockerized_crypt-vol-1/ecprivkey.pem"
  printf 'key\n' >"$MOCK_DIR/volumes/mailcowdockerized_crypt-vol-1/ecpubkey.pem"
  printf '2\n' >"$MOCK_DIR/volumes/mailcowdockerized_mysql-vol-1/mailboxes"
  printf 'DBUSER=mailcow\nDBNAME=mailcow\n' >>"$MC/mailcow.conf"
  export MAILEXPERT_NODE_RESTORE_DB_TRIES=1
  export MAILEXPERT_NODE_BACKUP_LOG=$BATS_TEST_TMPDIR/node-backup.log
  export MAILEXPERT_LOGROTATE_FILE=$BATS_TEST_TMPDIR/logrotate.d/mailexpert-node-backup
  mkdir -p "$vmail/example.com/alice/Maildir/cur" "$vmail/example.com/bob/Maildir/cur" "$vmail/_garbage"
  printf 'Subject: one\n' >"$vmail/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S"
  printf 'Subject: two\n' >"$vmail/example.com/bob/Maildir/cur/1700000001.M2.mail:2,S"
  # shellcheck source=/dev/null
  source "$NODE_SCRIPTS/backup-lib.sh"
}

# A node.env with the backup keys, as setup.sh --backup-keys stores them.
write_backup_keys() {
  cat >>"$MAILEXPERT_NODE_CONF" <<'EOF'
RESTIC_REPOSITORY=s3:https://s3.example.com/node-backups/node
RESTIC_PASSWORD=correct-horse-battery-staple
AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY
AWS_SECRET_ACCESS_KEY=example-secret-access-key
NODE_BACKUP_PING_URL=https://hc.example.com/ping/node-backup
EOF
}

restic_calls() { cat "$MOCK_DIR/restic" 2>/dev/null; }

# repo_snapshot <id prefix of 8 hex> <host> <tag...>: a snapshot made elsewhere (another node, the
# panel) in the restic mock's repository.
repo_snapshot() {
  local id=$1$(printf 'c%.0s' $(seq 56)) host=$2
  shift 2
  mkdir -p "$MOCK_DIR/repo/$id/backup"
  printf '%s\n' "$host" >"$MOCK_DIR/repo/$id.host"
  printf '%s\n' "$@" >"$MOCK_DIR/repo/$id.tags"
}

# The recorded endpoints answer with the Exchange entry of TCP 25 changed by a jq filter.
endpoints_with() {
  jq "map(if .serviceArea == \"Exchange\" and .tcpPorts == \"25\" then $1 else . end)" "$MOCK_FIXTURES/endpoints.json" >"$BATS_TEST_TMPDIR/endpoints.json"
  export MOCK_ENDPOINTS_FILE=$BATS_TEST_TMPDIR/endpoints.json
}
