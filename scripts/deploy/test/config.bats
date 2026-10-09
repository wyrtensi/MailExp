#!/usr/bin/env bats
# install.sh input: flags, install.conf, validation and what follows from the sign-in mode.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  C=$BATS_TEST_TMPDIR/install.conf
  install_defaults
}

configure() {
  install_defaults
  parse_install_args "$@"
  resolve_install_config "$C"
}

keys_of() { awk '{print $2}' | sort | paste -sd' ' -; }

@test "flags fill the configuration, hosts and emails are lowercased" {
  configure --version sha-0123456789ab --signin direct --direct-host Panel.Example.com --admin-email 'Admin@Example.com, b@example.com'
  [ "$CFG_VERSION" = sha-0123456789ab ]
  [ "$CFG_SIGNIN" = direct ]
  [ "$CFG_DIRECT_HOST" = panel.example.com ]
  [ "$CFG_ADMIN_EMAILS" = admin@example.com,b@example.com ]
  [ "$CFG_PROJECT" = mailexpert ] && [ "$CFG_EDGE_PROJECT" = mailexpert-edge ] && [ "$CFG_HTTP_PORT" = 8080 ]
  [ "$CFG_EDGE" = 1 ] && [ "$CFG_EDGE_TLS" = acme ] && [ "$CFG_SYSTEM" = 1 ] && [ "$CFG_LOCAL_AUTH" = 0 ]
  [ "$CFG_IMAGE_PREFIX" = ghcr.io/wyrtensi ]
  [ "$OPT_PREFIX" = /opt/mailexpert ] && [ "$OPT_START" = 1 ]
}

@test "unknown flags and missing values exit 2" {
  run parse_install_args --bogus
  [ "$status" -eq 2 ]
  run parse_install_args --version
  [ "$status" -eq 2 ]
  run parse_install_args --version --signin cf
  [ "$status" -eq 2 ]
  [[ $output == *"--version needs a value"* ]]
}

@test "install.conf supplies what the flags omit, flags win" {
  printf 'VERSION=sha-0123456789ab\nSIGNIN=cf\nCF_HOST=cf.example.com\nHTTP_PORT=18080\n' >"$C"
  configure --signin both --direct-host panel.example.com
  [ "$CFG_VERSION" = sha-0123456789ab ]
  [ "$CFG_SIGNIN" = both ]
  [ "$CFG_CF_HOST" = cf.example.com ]
  [ "$CFG_DIRECT_HOST" = panel.example.com ]
  [ "$CFG_HTTP_PORT" = 18080 ]
}

@test "install.conf round-trips and never stores --prefix or --no-start" {
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth --no-system --no-start --prefix /srv/me
  [ "$OPT_PREFIX" = /srv/me ] && [ "$OPT_START" = 0 ]
  write_install_conf "$C"
  run env_get "$C" PREFIX
  [ "$status" -eq 1 ]
  run env_get "$C" START
  [ "$status" -eq 1 ]
  configure
  [ "$CFG_SIGNIN" = direct ] && [ "$CFG_LOCAL_AUTH" = 1 ] && [ "$CFG_SYSTEM" = 0 ] && [ "$OPT_START" = 1 ]
}

@test "a complete install validates" {
  configure --version sha-0123456789ab --signin both --cf-host cf.example.com --direct-host panel.example.com --admin-email admin@example.com
  validate_install_config
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  validate_install_config
}

expect_invalid() {
  local msg=$1
  shift
  configure "$@"
  run validate_install_config
  [ "$status" -eq 2 ] || { echo "accepted: $*"; return 1; }
  [[ $output == *"$msg"* ]] || { echo "unexpected message: $output"; return 1; }
}

@test "invalid input is reported with the flag to fix" {
  local ok=(--signin direct --direct-host panel.example.com --admin-email admin@example.com)
  expect_invalid "--version" --version sha-0123 "${ok[@]}"
  expect_invalid "--version" --version v3.3.0 "${ok[@]}"
  expect_invalid "--signin" --version sha-0123456789ab --signin tunnel --admin-email admin@example.com
  expect_invalid "--cf-host" --version sha-0123456789ab --signin cf --admin-email admin@example.com
  expect_invalid "--direct-host" --version sha-0123456789ab --signin direct --direct-host https://panel.example.com --admin-email admin@example.com
  expect_invalid "--direct-host" --version sha-0123456789ab --signin direct --direct-host bad_host.example.com --admin-email admin@example.com
  expect_invalid "must differ" --version sha-0123456789ab --signin both --cf-host a.example.com --direct-host a.example.com --admin-email admin@example.com
  expect_invalid "--admin-email is required" --version sha-0123456789ab --signin direct --direct-host panel.example.com
  expect_invalid "not an email" --version sha-0123456789ab --signin direct --direct-host panel.example.com --admin-email nobody
  expect_invalid "--http-port" --version sha-0123456789ab "${ok[@]}" --http-port 80
  expect_invalid "--project" --version sha-0123456789ab "${ok[@]}" --project MailExpert
  expect_invalid "must differ" --version sha-0123456789ab "${ok[@]}" --project mailexpert-edge
  expect_invalid "--edge-tls" --version sha-0123456789ab "${ok[@]}" --edge-tls letsencrypt
  expect_invalid "--prefix" --version sha-0123456789ab "${ok[@]}" --prefix relative/dir
}

@test "app_settings per sign-in mode" {
  configure --version sha-0123456789ab --signin cf --cf-host cf.example.com --admin-email admin@example.com
  run app_settings
  [[ $output == *$'\nAPP_URL=https://cf.example.com\nAPP_ALT_URLS=\nAUTH_MODE=google\n'* ]]
  [[ $output == *"GOOGLE_REDIRECT_URI=https://cf.example.com/oauth/google/callback"* ]]
  [[ $output == *"MAILEXPERT_VERSION=sha-0123456789ab"* ]]
  [[ $output == *"COMPOSE_PROJECT_NAME=mailexpert"* && $output == *"APP_HTTP_PORT=8080"* ]]
  [[ $output == *"UPDATE_SPOOL_HOST_DIR=/opt/mailexpert/state/update-spool"* ]]
  configure --version sha-0123456789ab --signin both --cf-host cf.example.com --direct-host panel.example.com --admin-email admin@example.com
  run app_settings
  [[ $output == *$'APP_URL=https://cf.example.com\nAPP_ALT_URLS=https://panel.example.com\n'* ]]
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  run app_settings
  [[ $output == *"APP_URL=https://panel.example.com"* && $output == *"AUTH_MODE=local"* ]]
}

@test "owner secrets required per mode" {
  configure --signin cf
  [ "$(required_owner_secrets | keys_of)" = "CF_ACCESS_AUDIENCE CF_ACCESS_ISSUER TUNNEL_TOKEN" ]
  configure --signin direct
  [ "$(required_owner_secrets | keys_of)" = "AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET DNS_API_TOKEN" ]
  configure --signin direct --edge-tls internal
  [ "$(required_owner_secrets | keys_of)" = "AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET" ]
  configure --signin both
  [ "$(required_owner_secrets | keys_of)" = "AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET CF_ACCESS_AUDIENCE CF_ACCESS_ISSUER DNS_API_TOKEN TUNNEL_TOKEN" ]
  configure --signin both --local-auth
  [ "$(required_owner_secrets | keys_of)" = "DNS_API_TOKEN TUNNEL_TOKEN" ]
  configure --signin both --local-auth --no-edge
  [ -z "$(required_owner_secrets)" ]
  configure --signin cf --no-edge
  [ "$(required_owner_secrets | keys_of)" = "CF_ACCESS_AUDIENCE CF_ACCESS_ISSUER" ]
  [ "$(required_owner_secrets | awk '$2 == "TUNNEL_TOKEN" || $2 == "DNS_API_TOKEN" {print $1}' | sort -u)" = "" ]
  configure --signin both
  [ "$(required_owner_secrets | awk '$2 ~ /TOKEN$/ {print $1}' | sort -u)" = edge ]
}

@test "edge services, profiles and firewall per mode" {
  configure --signin direct
  [ "$(edge_services | paste -sd' ' -)" = caddy ] && [ "$(edge_profiles)" = caddy ]
  [ "$(ufw_allowed_ports 22 | paste -sd' ' -)" = "22/tcp 80/tcp 443/tcp 443/udp" ]
  configure --signin cf
  [ "$(edge_services | paste -sd' ' -)" = cloudflared ] && [ "$(edge_profiles)" = tunnel ]
  [ "$(ufw_allowed_ports 22 2222 | paste -sd' ' -)" = "22/tcp 2222/tcp" ]
  configure --signin both
  [ "$(edge_services | paste -sd' ' -)" = "caddy cloudflared" ] && [ "$(edge_profiles)" = caddy,tunnel ]
  configure --signin both --no-edge
  [ -z "$(edge_services)" ] && [ -z "$(edge_profiles)" ]
  [ "$(ufw_allowed_ports 22 | paste -sd' ' -)" = "22/tcp" ]
}

@test "ssh_ports keeps 22 and adds the listening, configured and current session ports" {
  [ "$(ssh_ports "" "" "" | paste -sd' ' -)" = 22 ]
  [ "$(ssh_ports "" $'2222\n22' "203.0.113.5 50000 198.51.100.7 2200" | paste -sd' ' -)" = "22 2200 2222" ]
  [ "$(ssh_ports $'4022\n4023' "" "" | paste -sd' ' -)" = "22 4022 4023" ]
  [ "$(ssh_ports "not-a-port" "not-a-port" "" | paste -sd' ' -)" = 22 ]
}

@test "ss_ssh_ports reads the ports sshd listens on from ss" {
  ss_out='LISTEN 0      128    0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=4025,fd=3))
LISTEN 0      128       [::]:2222    [::]:* users:(("sshd",pid=4025,fd=4))
LISTEN 0      4096   [::]:4022 [::]:* users:(("systemd",pid=1,fd=50),("sshd",pid=900,fd=3))
LISTEN 0      4096   0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=11,fd=7))
LISTEN 0      4096   0.0.0.0:2200 0.0.0.0:* users:(("sshd-session",pid=12,fd=7))
LISTEN 0      4096   127.0.0.1:8080 0.0.0.0:*'
  [ "$(ss_ssh_ports <<<"$ss_out" | paste -sd' ' -)" = "2222 4022" ]
  [ -z "$(ss_ssh_ports <<<'')" ]
}

@test "socket_listen_ports reads ssh.socket ListenStream ports" {
  [ "$(socket_listen_ports <<<'[::]:22 (Stream)')" = 22 ]
  [ "$(socket_listen_ports <<<$'0.0.0.0:2222 (Stream)\n[::]:2222 (Stream)' | paste -sd' ' -)" = 2222 ]
  [ "$(socket_listen_ports <<<'Listen=[::]:4022 (Stream) 0.0.0.0:22 (Stream)' | paste -sd' ' -)" = "22 4022" ]
  [ "$(socket_listen_ports <<<'2200 (Stream)')" = 2200 ]
  [ -z "$(socket_listen_ports <<<'/run/sshd.sock (Stream)')" ]
  [ -z "$(socket_listen_ports <<<'')" ]
}

@test "ufw_enable_safe needs an allowed port with an SSH listener unless ufw is active" {
  ufw_enable_safe 0 $'22\n2222' 22 2222
  ufw_enable_safe 0 2222 22 2222
  run ufw_enable_safe 0 '' 22
  [ "$status" -eq 1 ]
  run ufw_enable_safe 0 4022 22 2222
  [ "$status" -eq 1 ]
  ufw_enable_safe 1 '' 22
}

@test "ufw_rules_cover_port finds any rule for the port in ufw status and ufw show added" {
  status_out='Status: active

To                         Action      From
--                         ------      ----
2222/tcp                   ALLOW       203.0.113.5
80,443/tcp                 ALLOW       Anywhere
OpenSSH                    ALLOW       Anywhere
3000:3100/tcp              ALLOW       Anywhere
198.51.100.1 2200/tcp      ALLOW       Anywhere
80,443/tcp (v6)            ALLOW       Anywhere (v6)'
  ufw_rules_cover_port 2222 <<<"$status_out"
  ufw_rules_cover_port 22 <<<"$status_out"
  ufw_rules_cover_port 3050 <<<"$status_out"
  ufw_rules_cover_port 2200 <<<"$status_out"
  ufw_rules_cover_port 443 <<<"$status_out"
  run ufw_rules_cover_port 4022 <<<"$status_out"
  [ "$status" -eq 1 ]
  run ufw_rules_cover_port 203 <<<"$status_out"
  [ "$status" -eq 1 ]
  added_out="Added user rules (see 'ufw status' for running firewall):
ufw allow from 203.0.113.5 to any port 2222 proto tcp
ufw limit 4022/tcp"
  ufw_rules_cover_port 2222 <<<"$added_out"
  ufw_rules_cover_port 4022 <<<"$added_out"
  run ufw_rules_cover_port 22 <<<"$added_out"
  [ "$status" -eq 1 ]
  run ufw_rules_cover_port 22 <<<'Status: inactive'
  [ "$status" -eq 1 ]
}

@test "port_conflicts ignores a caddy only while the edge's own caddy runs" {
  ss_out='LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=10,fd=6))
LISTEN 0 4096 [::]:443 [::]:* users:(("caddy",pid=11,fd=7))
LISTEN 0 100 0.0.0.0:25 0.0.0.0:* users:(("docker-proxy",pid=12,fd=4))
LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*'
  [ "$(port_conflicts 1 80 443 <<<"$ss_out")" = "80 nginx" ]
  [ "$(port_conflicts 1 25 <<<"$ss_out")" = "25 docker-proxy" ]
  [ "$(port_conflicts 1 8080 <<<"$ss_out")" = "8080 unknown" ]
  [ -z "$(port_conflicts 1 443 993 <<<"$ss_out")" ]
  # No caddy of this install's edge runs: a caddy on 443 is someone else's.
  [ "$(port_conflicts 0 443 <<<"$ss_out")" = "443 caddy" ]
  [ "$(port_conflicts 0 80 443 <<<"$ss_out" | paste -sd';' -)" = "80 nginx;443 caddy" ]
}

@test "loopback_port_holders: listeners a bind of 127.0.0.1:<port> collides with" {
  ss_out='LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("docker-proxy",pid=10,fd=6))
LISTEN 0 4096 0.0.0.0:8081 0.0.0.0:* users:(("nginx",pid=11,fd=7))
LISTEN 0 4096 *:8082 *:* users:(("node",pid=12,fd=4))
LISTEN 0 4096 [::]:8083 [::]:*
LISTEN 0 4096 10.0.0.5:8084 0.0.0.0:* users:(("nginx",pid=13,fd=4))
LISTEN 0 4096 [::1]:8085 [::]:* users:(("nginx",pid=14,fd=4))
LISTEN 0 4096 127.0.0.1:18080 0.0.0.0:* users:(("other",pid=15,fd=4))'
  [ "$(loopback_port_holders 8080 <<<"$ss_out")" = "8080 docker-proxy" ]
  [ "$(loopback_port_holders 8081 <<<"$ss_out")" = "8081 nginx" ]
  [ "$(loopback_port_holders 8082 <<<"$ss_out")" = "8082 node" ]
  [ "$(loopback_port_holders 8083 <<<"$ss_out")" = "8083 unknown" ]
  [ -z "$(loopback_port_holders 8084 <<<"$ss_out")" ]
  [ -z "$(loopback_port_holders 8085 <<<"$ss_out")" ]
  [ -z "$(loopback_port_holders 8086 <<<"$ss_out")" ]
}

@test "a new install's edge project is mailexpert-edge; an install.conf with edge keeps it" {
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  [ "$CFG_EDGE_PROJECT" = mailexpert-edge ]
  write_install_conf "$C"
  [ "$(env_get "$C" EDGE_PROJECT)" = mailexpert-edge ]
  # An existing install: install.conf names edge, a rerun without flags keeps it.
  printf 'VERSION=sha-0123456789ab\nSIGNIN=direct\nDIRECT_HOST=panel.example.com\nEDGE_PROJECT=edge\n' >"$C"
  configure
  [ "$CFG_EDGE_PROJECT" = edge ]
  write_install_conf "$C"
  [ "$(env_get "$C" EDGE_PROJECT)" = edge ]
  # An install.conf without the key predates the new default: its edge runs as edge.
  printf 'VERSION=sha-0123456789ab\nSIGNIN=direct\nDIRECT_HOST=panel.example.com\n' >"$C"
  configure
  [ "$CFG_EDGE_PROJECT" = edge ]
  # The flag always wins (the move to the new name).
  configure --edge-project mailexpert-edge
  [ "$CFG_EDGE_PROJECT" = mailexpert-edge ]
}

@test "generic_name_notes: one info line per project name without the mailexpert prefix" {
  OPT_PREFIX=/opt/me
  [ -z "$(generic_name_notes)" ]
  CFG_PROJECT=mailexpert-two CFG_EDGE_PROJECT=mailexpert_edge2
  [ -z "$(generic_name_notes)" ]
  CFG_PROJECT=mailexpert CFG_EDGE_PROJECT=edge
  run generic_name_notes
  [ "${#lines[@]}" -eq 1 ]
  [[ $output == *"the edge's compose project 'edge' has no mailexpert prefix"* ]]
  [[ $output == *"docker compose -p edge --project-directory /opt/me/edge down, then install.sh --prefix /opt/me --edge-project mailexpert-edge"* ]]
  # Without an edge there is no edge project to name.
  CFG_EDGE=0
  [ -z "$(generic_name_notes)" ]
  CFG_PROJECT=panel
  run generic_name_notes
  [ "${#lines[@]}" -eq 1 ]
  [[ $output == *"the panel's compose project 'panel' has no mailexpert prefix"*"volume panel_postgres_data"* ]]
}

@test "resource_shortfalls" {
  [ -z "$(resource_shortfalls 4 8000000 50000000)" ]
  [ -z "$(resource_shortfalls 2 3900000 21000000)" ]
  [ "$(resource_shortfalls 1 2000000 1000000 | wc -l)" -eq 3 ]
}

@test "version_matches compares the tag with the full sha" {
  version_matches sha-0123456789ab 0123456789abcdef0123456789abcdef01234567
  run ! version_matches sha-0123456789ab 1123456789abcdef0123456789abcdef01234567
  run ! version_matches sha-0123456789ab dev
  run ! version_matches latest 0123456789abcdef0123456789abcdef01234567
}

@test "render_unit substitutes the prefix" {
  printf 'ExecStart=@PREFIX@/app/x.sh --prefix @PREFIX@\n' >"$BATS_TEST_TMPDIR/u.service"
  [ "$(render_unit "$BATS_TEST_TMPDIR/u.service" /opt/mailexpert)" = "ExecStart=/opt/mailexpert/app/x.sh --prefix /opt/mailexpert" ]
}

@test "unit_name: the default project keeps the fixed names, another project gets a suffix" {
  [ "$CFG_PROJECT" = mailexpert ]
  [ "$(unit_name updater path)" = mailexpert-updater.path ]
  [ "$(unit_name updater service)" = mailexpert-updater.service ]
  [ "$(unit_name backup timer)" = mailexpert-backup.timer ]
  [ "$(unit_name health service)" = mailexpert-health.service ]
  CFG_PROJECT=node
  [ "$(unit_name updater path)" = mailexpert-updater-node.path ]
  [ "$(unit_name backup timer)" = mailexpert-backup-node.timer ]
  [ "$(unit_name health service)" = mailexpert-health-node.service ]
  unset CFG_PROJECT
  [ "$(unit_name updater service)" = mailexpert-updater.service ]
}

@test "render_project_unit: the updater path unit starts the service of its own project" {
  local units=$REPO_DIR/deploy/systemd
  run render_project_unit "$units/mailexpert-updater.path" /opt/mailexpert
  [[ $output == *$'\nUnit=mailexpert-updater.service\n'* ]]
  [[ $output == *"PathExistsGlob=/opt/mailexpert/state/update-spool/request/*.json"* ]]
  [ "$output" = "$(render_unit "$units/mailexpert-updater.path" /opt/mailexpert)" ]
  CFG_PROJECT=p2
  run render_project_unit "$units/mailexpert-updater.path" /opt/p2
  [[ $output == *$'\nUnit=mailexpert-updater-p2.service\n'* ]]
  [[ $output != *"mailexpert-updater.service"* ]]
  run render_project_unit "$units/mailexpert-updater.service" /opt/p2
  [[ $output == *"ExecStart=/opt/p2/app/scripts/deploy/updater.sh --prefix /opt/p2"* ]]
  [[ $output == *"systemctl reset-failed mailexpert-updater-p2.service mailexpert-updater-p2.path"* ]]
  [[ $output != *"mailexpert-updater.path"* ]]
}

@test "has_systemd: MAILEXPERT_SYSTEMD overrides the check" {
  MAILEXPERT_SYSTEMD=1 has_systemd
  MAILEXPERT_SYSTEMD=0 run ! has_systemd
  [ "$(MAILEXPERT_SYSTEMD=1 systemd_flag)" = 1 ]
  [ "$(MAILEXPERT_SYSTEMD=0 systemd_flag)" = 0 ]
}

@test "unit_runs_prefix: only a unit of exactly that prefix" {
  local units=$REPO_DIR/deploy/systemd f=$BATS_TEST_TMPDIR/u
  render_unit "$units/mailexpert-backup.service" /opt/me >"$f"
  unit_runs_prefix "$f" /opt/me
  run ! unit_runs_prefix "$f" /opt/me2
  run ! unit_runs_prefix "$f" /opt
  render_unit "$units/mailexpert-updater.path" /opt/me >"$f"
  unit_runs_prefix "$f" /opt/me
  run ! unit_runs_prefix "$f" /opt/m
  render_unit "$units/mailexpert-backup.timer" /opt/me >"$f"
  run ! unit_runs_prefix "$f" /opt/me
  run ! unit_runs_prefix "$BATS_TEST_TMPDIR/missing" /opt/me
}

@test "install.sh --help prints the usage" {
  run bash "$DEPLOY_DIR/install.sh" --help
  [ "$status" -eq 0 ]
  [[ $output == *"Usage: install.sh"* ]]
}

@test "install.sh stops with 2 on invalid input before touching the host" {
  run bash "$DEPLOY_DIR/install.sh" --prefix "$BATS_TEST_TMPDIR/p" --version bad --signin direct --direct-host panel.example.com --admin-email admin@example.com
  [ "$status" -eq 2 ]
  [[ $output == *"--version"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/p" ]
}

@test "exit_on_unexpected_failure maps tool failures to 1 and keeps die and exit codes" {
  common=$DEPLOY_DIR/lib/common.sh
  run bash -c 'set -euo pipefail; . "$1"; exit_on_unexpected_failure; tool() { return 2; }; f() { tool; }; f; echo after' _ "$common"
  [ "$status" -eq 1 ]
  [[ $output == *"failed with status 2"* && $output != *after* ]]
  run bash -c 'set -euo pipefail; . "$1"; exit_on_unexpected_failure; v=$(exit 128); echo after' _ "$common"
  [ "$status" -eq 1 ]
  run bash -c 'set -euo pipefail; . "$1"; exit_on_unexpected_failure; v=$(false) || v=x; [ -n "$(false)" ] || true; echo "$v"' _ "$common"
  [ "$status" -eq 0 ] && [ "$output" = x ]
  run bash -c 'set -euo pipefail; . "$1"; exit_on_unexpected_failure; die "bad input" 2' _ "$common"
  [ "$status" -eq 2 ]
  run bash -c 'set -euo pipefail; . "$1"; exit_on_unexpected_failure; f() { exit 3; }; f' _ "$common"
  [ "$status" -eq 3 ]
}
