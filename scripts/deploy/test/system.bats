#!/usr/bin/env bats
# install.sh's host side (lib/system.sh): what --no-system leaves out, and the panel's own systemd
# units, named per project, installed into a temporary directory with a systemctl stub.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  export MAILEXPERT_SYSTEMD_DIR=$BATS_TEST_TMPDIR/systemd
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/system.sh"
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/updater.sh"
  install_defaults
  OPT_PREFIX=$BATS_TEST_TMPDIR/opt/me CFG_VERSION=sha-0123456789ab CFG_SYSTEM=0
  set_install_paths
  mkdir -p "$SYSTEMD_DIR" "$APP_DIR/scripts/deploy" "$STATE_DIR/update-spool/result"
  cp -r "$REPO_DIR/deploy" "$APP_DIR/deploy"
  for script in backup.sh healthcheck.sh updater.sh; do
    printf '#!/bin/sh\n' >"$APP_DIR/scripts/deploy/$script"
    chmod +x "$APP_DIR/scripts/deploy/$script"
  done
  mkdir -p "$BATS_TEST_TMPDIR/sbin"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >>"$SYSTEMCTL_LOG"' >"$BATS_TEST_TMPDIR/sbin/systemctl"
  chmod +x "$BATS_TEST_TMPDIR/sbin/systemctl"
  export PATH="$BATS_TEST_TMPDIR/sbin:$PATH" SYSTEMCTL_LOG=$BATS_TEST_TMPDIR/systemctl.log MAILEXPERT_SYSTEMD=1
}

units() { (cd "$SYSTEMD_DIR" && ls -1) | paste -sd' ' -; }

@test "prepare_host: --no-system changes nothing on the host" {
  for f in check_os check_resources install_packages ensure_docker_running ensure_swap enable_unattended_upgrades; do
    eval "$f() { echo $f >>\"\$BATS_TEST_TMPDIR/host\"; }"
  done
  CFG_SYSTEM=0 prepare_host
  [ ! -e "$BATS_TEST_TMPDIR/host" ]
  CFG_SYSTEM=1 prepare_host
  [ "$(paste -sd' ' "$BATS_TEST_TMPDIR/host")" = "check_os check_resources install_packages ensure_docker_running ensure_swap enable_unattended_upgrades" ]
}

@test "install_units: --no-system on a systemd host installs the timers and the updater under the default names" {
  ufw() { echo ufw >>"$BATS_TEST_TMPDIR/host"; }
  apt-get() { echo apt-get >>"$BATS_TEST_TMPDIR/host"; }
  swapon() { echo swapon >>"$BATS_TEST_TMPDIR/host"; }
  run install_units
  [ "$status" -eq 0 ]
  [ "$(units)" = "mailexpert-backup.service mailexpert-backup.timer mailexpert-health.service mailexpert-health.timer mailexpert-updater.path mailexpert-updater.service" ]
  [ ! -e "$BATS_TEST_TMPDIR/host" ]
  grep -qx "ExecStart=$OPT_PREFIX/app/scripts/deploy/backup.sh --prefix $OPT_PREFIX" "$SYSTEMD_DIR/mailexpert-backup.service"
  grep -qx "Unit=mailexpert-updater.service" "$SYSTEMD_DIR/mailexpert-updater.path"
  grep -qx "enable --now mailexpert-backup.timer" "$SYSTEMCTL_LOG"
  grep -qx "enable --now mailexpert-health.timer" "$SYSTEMCTL_LOG"
  grep -qx "restart mailexpert-updater.path" "$SYSTEMCTL_LOG"
  [ "$(jq -r .installed "$STATE_DIR/update-spool/result/updater.json")" = true ]
  [[ $output == *"updater: mailexpert-updater.path watches $STATE_DIR/update-spool/request"* ]]
  [[ $output == *"timer mailexpert-backup: enabled"* ]]
}

@test "install_units: another project gets its own unit names, its path unit starts its own service" {
  CFG_PROJECT=p2
  run install_units
  [ "$status" -eq 0 ]
  [ "$(units)" = "mailexpert-backup-p2.service mailexpert-backup-p2.timer mailexpert-health-p2.service mailexpert-health-p2.timer mailexpert-updater-p2.path mailexpert-updater-p2.service" ]
  grep -qx "Unit=mailexpert-updater-p2.service" "$SYSTEMD_DIR/mailexpert-updater-p2.path"
  grep -qx "PathExistsGlob=$OPT_PREFIX/state/update-spool/request/\*.json" "$SYSTEMD_DIR/mailexpert-updater-p2.path"
  grep -qx "ExecStart=$OPT_PREFIX/app/scripts/deploy/healthcheck.sh --prefix $OPT_PREFIX" "$SYSTEMD_DIR/mailexpert-health-p2.service"
  grep -qx "enable --now mailexpert-backup-p2.timer" "$SYSTEMCTL_LOG"
  grep -qx "enable --now mailexpert-health-p2.timer" "$SYSTEMCTL_LOG"
  grep -qx "restart mailexpert-updater-p2.path" "$SYSTEMCTL_LOG"
  run ! grep -E 'mailexpert-(updater|backup|health)\.' "$SYSTEMCTL_LOG"
}

@test "install_units: without systemd nothing is installed and one line says what is missing" {
  MAILEXPERT_SYSTEMD=0 run install_units
  [ "$status" -eq 0 ]
  [ -z "$(units)" ]
  [ ! -e "$SYSTEMCTL_LOG" ]
  [ ! -e "$STATE_DIR/update-spool/result/updater.json" ]
  [ "${#lines[@]}" -eq 1 ]
  [[ $output == *"systemd units: skipped, this host runs without systemd: no update button in the panel, no nightly backup, no health timer"* ]]
  [[ $output == *"backup.sh --prefix $OPT_PREFIX and healthcheck.sh --prefix $OPT_PREFIX from cron, update with update.sh"* ]]
}

@test "install_units: another project removes its own units under the default names, never another install's" {
  render_unit "$APP_DIR/deploy/systemd/mailexpert-updater.path" "$OPT_PREFIX" >"$SYSTEMD_DIR/mailexpert-updater.path"
  render_unit "$APP_DIR/deploy/systemd/mailexpert-updater.service" "$OPT_PREFIX" >"$SYSTEMD_DIR/mailexpert-updater.service"
  render_unit "$APP_DIR/deploy/systemd/mailexpert-health.service" "$OPT_PREFIX" >"$SYSTEMD_DIR/mailexpert-health.service"
  render_unit "$APP_DIR/deploy/systemd/mailexpert-health.timer" "$OPT_PREFIX" >"$SYSTEMD_DIR/mailexpert-health.timer"
  # Another install's: a prefix that starts like this one.
  render_unit "$APP_DIR/deploy/systemd/mailexpert-backup.service" "${OPT_PREFIX}2" >"$SYSTEMD_DIR/mailexpert-backup.service"
  render_unit "$APP_DIR/deploy/systemd/mailexpert-backup.timer" "${OPT_PREFIX}2" >"$SYSTEMD_DIR/mailexpert-backup.timer"
  CFG_PROJECT=p2
  run install_units
  [ "$status" -eq 0 ]
  [ ! -e "$SYSTEMD_DIR/mailexpert-updater.path" ] && [ ! -e "$SYSTEMD_DIR/mailexpert-updater.service" ]
  [ ! -e "$SYSTEMD_DIR/mailexpert-health.service" ] && [ ! -e "$SYSTEMD_DIR/mailexpert-health.timer" ]
  grep -qx "ExecStart=${OPT_PREFIX}2/app/scripts/deploy/backup.sh --prefix ${OPT_PREFIX}2" "$SYSTEMD_DIR/mailexpert-backup.service"
  [ -e "$SYSTEMD_DIR/mailexpert-backup.timer" ]
  grep -qx "disable --now mailexpert-updater.path" "$SYSTEMCTL_LOG"
  grep -qx "disable --now mailexpert-health.timer" "$SYSTEMCTL_LOG"
  run ! grep -q "mailexpert-backup.timer" "$SYSTEMCTL_LOG"
  [ -e "$SYSTEMD_DIR/mailexpert-updater-p2.path" ] && [ -e "$SYSTEMD_DIR/mailexpert-health-p2.timer" ]
}

@test "install_units: the default project keeps its units under the default names" {
  render_unit "$APP_DIR/deploy/systemd/mailexpert-updater.path" "$OPT_PREFIX" >"$SYSTEMD_DIR/mailexpert-updater.path"
  run install_units
  [ "$status" -eq 0 ]
  [ -e "$SYSTEMD_DIR/mailexpert-updater.path" ]
  run ! grep -q "disable" "$SYSTEMCTL_LOG"
}

@test "remove_updater: removes the units of this project only" {
  CFG_PROJECT=p2
  install_units 2>/dev/null
  render_unit "$APP_DIR/deploy/systemd/mailexpert-updater.path" /opt/other >"$SYSTEMD_DIR/mailexpert-updater.path"
  : >"$SYSTEMCTL_LOG"
  run remove_updater sha-aaaaaaaaaaaa
  [ "$status" -eq 0 ]
  [ ! -e "$SYSTEMD_DIR/mailexpert-updater-p2.path" ] && [ ! -e "$SYSTEMD_DIR/mailexpert-updater-p2.service" ]
  [ -e "$SYSTEMD_DIR/mailexpert-updater.path" ]
  [ ! -e "$STATE_DIR/update-spool/result/updater.json" ]
  grep -qx "disable --now mailexpert-updater-p2.path" "$SYSTEMCTL_LOG"
}
