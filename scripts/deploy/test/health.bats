#!/usr/bin/env bats
# Health decisions over what docker compose ps, df and curl report.

bats_require_minimum_version 1.5.0

setup() {
  load helper
}

@test "service_problems: missing, stopped, restarting and unhealthy services" {
  ps=$'frontend running healthy\nbackend restarting \npostgres running unhealthy\nredis exited '
  run service_problems frontend backend postgres redis edge-missing <<<"$ps"
  [ "$status" -eq 0 ]
  [ "$output" = $'containers: backend is restarting\ncontainers: postgres is unhealthy\ncontainers: redis is exited\ncontainers: edge-missing does not exist' ]
}

# stub_systemctl <absent|active|inactive>: a host that systemd runs (MAILEXPERT_SYSTEMD=1) and a
# systemctl that knows the updater path unit in that state; the units it was asked about go to
# $SYSTEMCTL_LOG.
stub_systemctl() {
  mkdir -p "$BATS_TEST_TMPDIR/sbin"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >>"$SYSTEMCTL_LOG"' 'case $1 in' \
    '  cat) [ "$UPDATER_UNIT" != absent ] ;;' '  is-active) [ "$UPDATER_UNIT" = active ] ;;' 'esac' \
    >"$BATS_TEST_TMPDIR/sbin/systemctl"
  chmod +x "$BATS_TEST_TMPDIR/sbin/systemctl"
  export UPDATER_UNIT=$1 PATH="$BATS_TEST_TMPDIR/sbin:$PATH" MAILEXPERT_SYSTEMD=1
  export SYSTEMCTL_LOG=$BATS_TEST_TMPDIR/systemctl.log
}

@test "updater_state: no_systemd on a host that systemd does not run, whatever systemctl says" {
  stub_systemctl inactive
  [ "$(MAILEXPERT_SYSTEMD=0 updater_state)" = no_systemd ]
}

@test "updater_state: not_installed, active and inactive from systemctl, also with --no-system" {
  CFG_SYSTEM=0
  stub_systemctl absent
  [ "$(updater_state)" = not_installed ]
  stub_systemctl active
  [ "$(updater_state)" = active ]
  stub_systemctl inactive
  [ "$(updater_state)" = inactive ]
  grep -qx 'cat mailexpert-updater.path' "$SYSTEMCTL_LOG"
}

@test "updater_state: another project asks for its own unit" {
  CFG_PROJECT=p2
  stub_systemctl active
  [ "$(updater_state)" = active ]
  grep -qx 'cat mailexpert-updater-p2.path' "$SYSTEMCTL_LOG"
  run ! grep -q 'mailexpert-updater.path' "$SYSTEMCTL_LOG"
}

@test "updater_state: no_systemd without systemctl" {
  export MAILEXPERT_SYSTEMD=1
  local PATH=$BATS_TEST_TMPDIR/empty
  [ "$(updater_state)" = no_systemd ]
}

@test "updater_problem: only an installed but inactive path unit is a problem" {
  run updater_problem inactive
  [ "$output" = "updater: mailexpert-updater.path is installed but not active, so update requests from the panel are not served (systemctl enable --now mailexpert-updater.path)" ]
  for state in active not_installed no_systemd; do
    [ -z "$(updater_problem "$state")" ]
  done
  CFG_PROJECT=p2
  run updater_problem inactive
  [ "$output" = "updater: mailexpert-updater-p2.path is installed but not active, so update requests from the panel are not served (systemctl enable --now mailexpert-updater-p2.path)" ]
}

@test "service_problems: healthy, starting and services without a health check are fine" {
  ps=$'frontend running healthy\nbackend running starting\ncloudflared running '
  [ -z "$(service_problems frontend backend cloudflared <<<"$ps")" ]
}

@test "service_problems does not mistake a prefix for a service" {
  [ "$(service_problems redis <<<'redis-extra running healthy')" = "containers: redis does not exist" ]
}

@test "disk_problem" {
  [ -z "$(disk_problem / 85% 15)" ]
  [ "$(disk_problem / 86% 15)" = "disk: / is 86% full, less than 15% free" ]
  [ -z "$(disk_problem /var/lib/docker 99% 0)" ]
  [ "$(disk_problem / '' 15)" = "disk: cannot read the usage of /" ]
  [ -z "$(disk_problem / 50%)" ]
}

@test "cert_problem" {
  now=1800000000
  [ -z "$(cert_problem panel.example.com "$now" $((now + 30 * 86400)))" ]
  [ "$(cert_problem panel.example.com "$now" $((now + 10 * 86400)))" = "certificate: panel.example.com expires in 10 days" ]
  [ "$(cert_problem panel.example.com "$now" '')" = "certificate: cannot read the expiry date of panel.example.com" ]
}
