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

# old_units <prefix> <name...>: the default-name units an install.sh older than the per-project
# names writes for <prefix>.
old_units() {
  local prefix=$1 name kind unit
  shift
  for name in "$@"; do
    if [ "$name" = updater ]; then kind=path; else kind=timer; fi
    for unit in service "$kind"; do
      render_unit "$APP_DIR/deploy/systemd/mailexpert-$name.$unit" "$prefix" >"$SYSTEMD_DIR/mailexpert-$name.$unit"
    done
  done
}

@test "remove_project_units_after_downgrade: an older version's default-name units of this prefix replace the suffixed ones" {
  CFG_PROJECT=p2
  install_units 2>/dev/null
  old_units "$OPT_PREFIX" updater backup
  : >"$SYSTEMCTL_LOG"
  run remove_project_units_after_downgrade
  [ "$status" -eq 0 ]
  [ "$(units)" = "mailexpert-backup.service mailexpert-backup.timer mailexpert-health-p2.service mailexpert-health-p2.timer mailexpert-updater.path mailexpert-updater.service" ]
  # Only the path unit and the timer are disabled: a running service (the updater itself) is not stopped.
  [ "$(paste -sd'|' "$SYSTEMCTL_LOG")" = "disable --now mailexpert-updater-p2.path|disable --now mailexpert-backup-p2.timer|daemon-reload" ]
  [[ $output == *"systemd units: removed mailexpert-updater-p2.path, the installed version uses mailexpert-updater.path"* ]]
}

@test "remove_project_units_after_downgrade: default-name units of another prefix, or the default project, change nothing" {
  CFG_PROJECT=p2
  install_units 2>/dev/null
  old_units "${OPT_PREFIX}2" updater backup health
  : >"$SYSTEMCTL_LOG"
  remove_project_units_after_downgrade
  [ -e "$SYSTEMD_DIR/mailexpert-updater-p2.path" ] && [ -e "$SYSTEMD_DIR/mailexpert-backup-p2.timer" ]
  [ -e "$SYSTEMD_DIR/mailexpert-health-p2.timer" ]
  [ ! -s "$SYSTEMCTL_LOG" ]
  CFG_PROJECT=mailexpert
  old_units "$OPT_PREFIX" updater
  remove_project_units_after_downgrade
  [ -e "$SYSTEMD_DIR/mailexpert-updater.path" ]
  [ ! -s "$SYSTEMCTL_LOG" ]
}

# systemctl_stub: the systemctl stub that also answers: is-active fails for the units in
# STUB_INACTIVE, is-enabled for those in STUB_DISABLED, and the command named in
# STUB_SYSTEMCTL_FAIL (daemon-reload) fails.
systemctl_stub() {
  cat >"$BATS_TEST_TMPDIR/sbin/systemctl" <<'STUB_EOF'
#!/usr/bin/env bash
case $1 in
  is-active) [[ " ${STUB_INACTIVE:-} " != *" ${!#} "* ]]; exit ;;
  is-enabled) [[ " ${STUB_DISABLED:-} " != *" ${!#} "* ]]; exit ;;
esac
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
[ "$1" != "${STUB_SYSTEMCTL_FAIL:-}" ]
STUB_EOF
  chmod +x "$BATS_TEST_TMPDIR/sbin/systemctl"
}

# two_installs <name...>: the default project's units of <name...> for ${OPT_PREFIX}2 under the
# default names, and this version's suffixed units of project p2 for $OPT_PREFIX; the units as
# they are then are copied to $BATS_TEST_TMPDIR/before.
two_installs() {
  old_units "${OPT_PREFIX}2" "$@"
  CFG_PROJECT=p2
  install_units 2>/dev/null
  rm -rf "$BATS_TEST_TMPDIR/before"
  cp -r "$SYSTEMD_DIR" "$BATS_TEST_TMPDIR/before"
  systemctl_stub
  : >"$SYSTEMCTL_LOG"
}

# default_units_unchanged: the default-name units are byte for byte what two_installs found.
default_units_unchanged() {
  local f
  for f in "$BATS_TEST_TMPDIR"/before/mailexpert-{updater,backup,health}.*; do
    [ -e "$f" ] || continue
    cmp "$f" "$SYSTEMD_DIR/$(basename "$f")"
  done
}

@test "units_after_downgrade: another install's default-name units rewritten by an older install.sh go back; this project keeps its own" {
  two_installs updater backup health
  # The other install's updater path unit is enabled and active, its backup timer active but
  # disabled, its health timer enabled but stopped.
  STUB_DISABLED=mailexpert-backup.timer STUB_INACTIVE=mailexpert-health.timer save_foreign_fixed_units 2>/dev/null
  [ -d "$STATE_DIR/foreign-units/updater" ] && [ -d "$STATE_DIR/foreign-units/health" ]
  # install.sh of a version older than the per-project names: the default names, for this prefix.
  old_units "$OPT_PREFIX" updater backup health
  : >"$SYSTEMCTL_LOG"
  run units_after_downgrade
  [ "$status" -eq 0 ]
  default_units_unchanged
  grep -qx "ExecStart=${OPT_PREFIX}2/app/scripts/deploy/backup.sh --prefix ${OPT_PREFIX}2" "$SYSTEMD_DIR/mailexpert-backup.service"
  grep -qx "PathExistsGlob=${OPT_PREFIX}2/state/update-spool/request/\*.json" "$SYSTEMD_DIR/mailexpert-updater.path"
  for f in "$SYSTEMD_DIR"/mailexpert-{updater,backup,health}.*; do
    if unit_runs_prefix "$f" "$OPT_PREFIX"; then false; fi
  done
  # This project's suffixed units stay, and serve $OPT_PREFIX.
  [ "$(units)" = "mailexpert-backup-p2.service mailexpert-backup-p2.timer mailexpert-backup.service mailexpert-backup.timer mailexpert-health-p2.service mailexpert-health-p2.timer mailexpert-health.service mailexpert-health.timer mailexpert-updater-p2.path mailexpert-updater-p2.service mailexpert-updater.path mailexpert-updater.service" ]
  unit_runs_prefix "$SYSTEMD_DIR/mailexpert-updater-p2.path" "$OPT_PREFIX"
  unit_runs_prefix "$SYSTEMD_DIR/mailexpert-backup-p2.service" "$OPT_PREFIX"
  # Each path unit and timer gets back its enabled and active state; no service is touched (the
  # updater may be running inside one).
  [ "$(paste -sd'|' "$SYSTEMCTL_LOG")" = "daemon-reload|enable mailexpert-updater.path|reset-failed mailexpert-updater.path|restart mailexpert-updater.path|disable mailexpert-backup.timer|reset-failed mailexpert-backup.timer|restart mailexpert-backup.timer|enable mailexpert-health.timer|stop mailexpert-health.timer" ]
  [[ $output == *"mailexpert-updater.path belongs to another install on this host and is back as it was; this install keeps mailexpert-updater-p2.path"* ]]
  [ ! -e "$STATE_DIR/foreign-units" ]
}

@test "units_after_downgrade: an install.sh that left the other install's units alone changes nothing" {
  two_installs updater backup health
  save_foreign_fixed_units 2>/dev/null
  units_after_downgrade
  default_units_unchanged
  [ -e "$SYSTEMD_DIR/mailexpert-updater-p2.path" ] && [ -e "$SYSTEMD_DIR/mailexpert-health-p2.timer" ]
  [ ! -s "$SYSTEMCTL_LOG" ]
  [ ! -e "$STATE_DIR/foreign-units" ]
}

@test "units_after_downgrade: a kind the other install does not have goes to the default names, as before" {
  two_installs updater
  save_foreign_fixed_units 2>/dev/null
  [ -d "$STATE_DIR/foreign-units/updater" ] && [ ! -e "$STATE_DIR/foreign-units/backup" ]
  old_units "$OPT_PREFIX" updater backup health
  units_after_downgrade 2>/dev/null
  default_units_unchanged
  [ -e "$SYSTEMD_DIR/mailexpert-updater-p2.path" ]
  [ ! -e "$SYSTEMD_DIR/mailexpert-backup-p2.timer" ] && [ ! -e "$SYSTEMD_DIR/mailexpert-health-p2.timer" ]
  unit_runs_prefix "$SYSTEMD_DIR/mailexpert-backup.service" "$OPT_PREFIX"
  [ "$(paste -sd'|' "$SYSTEMCTL_LOG")" = "daemon-reload|enable mailexpert-updater.path|reset-failed mailexpert-updater.path|restart mailexpert-updater.path|disable --now mailexpert-backup-p2.timer|disable --now mailexpert-health-p2.timer|daemon-reload" ]
}

@test "units_after_downgrade: a timer install.sh added next to the other install's lone service is disabled and removed" {
  two_installs
  render_unit "$APP_DIR/deploy/systemd/mailexpert-backup.service" "${OPT_PREFIX}2" >"$SYSTEMD_DIR/mailexpert-backup.service"
  cp "$SYSTEMD_DIR/mailexpert-backup.service" "$BATS_TEST_TMPDIR/before/"
  save_foreign_fixed_units 2>/dev/null
  [ "$(ls -A "$STATE_DIR/foreign-units/backup")" = mailexpert-backup.service ]
  old_units "$OPT_PREFIX" backup
  units_after_downgrade 2>/dev/null
  default_units_unchanged
  [ ! -e "$SYSTEMD_DIR/mailexpert-backup.timer" ]
  [ -e "$SYSTEMD_DIR/mailexpert-backup-p2.timer" ] && [ -e "$SYSTEMD_DIR/mailexpert-backup-p2.service" ]
  [ "$(paste -sd'|' "$SYSTEMCTL_LOG")" = "disable --now mailexpert-backup.timer|daemon-reload" ]
}

@test "units_after_downgrade: a restore that fails keeps the saved copies and this project's units, and says so" {
  two_installs updater backup health
  save_foreign_fixed_units 2>/dev/null
  old_units "$OPT_PREFIX" updater backup health
  STUB_SYSTEMCTL_FAIL=daemon-reload run units_after_downgrade
  [ "$status" -eq 1 ]
  [[ $output == *"warning: systemd units: the units of another install on this host that install.sh rewrote for $OPT_PREFIX could not all be put back (updater backup health); their saved copies are in $STATE_DIR/foreign-units"* ]]
  [ -d "$STATE_DIR/foreign-units/updater" ]
  [ -e "$SYSTEMD_DIR/mailexpert-updater-p2.path" ] && [ -e "$SYSTEMD_DIR/mailexpert-backup-p2.timer" ]
  run ! grep -q "disable --now" "$SYSTEMCTL_LOG"
  # A later run keeps what was saved while the default-name units serve this prefix.
  old_units "$OPT_PREFIX" updater backup health
  save_foreign_fixed_units 2>/dev/null
  grep -qx "ExecStart=${OPT_PREFIX}2/app/scripts/deploy/backup.sh --prefix ${OPT_PREFIX}2" "$STATE_DIR/foreign-units/backup/mailexpert-backup.service"
  units_after_downgrade 2>/dev/null
  default_units_unchanged
  [ ! -e "$STATE_DIR/foreign-units" ]
}

@test "save_foreign_fixed_units: a copy left by a failed restore is replaced by another install's current units, dropped when there are none" {
  two_installs updater backup health
  save_foreign_fixed_units 2>/dev/null
  # Fixed by hand meanwhile: the other install has moved to ${OPT_PREFIX}3, and has no health units.
  old_units "${OPT_PREFIX}3" updater backup
  rm -f "$SYSTEMD_DIR"/mailexpert-health.*
  save_foreign_fixed_units 2>/dev/null
  grep -qx "ExecStart=${OPT_PREFIX}3/app/scripts/deploy/backup.sh --prefix ${OPT_PREFIX}3" "$STATE_DIR/foreign-units/backup/mailexpert-backup.service"
  grep -qx "PathExistsGlob=${OPT_PREFIX}3/state/update-spool/request/\*.json" "$STATE_DIR/foreign-units/updater/mailexpert-updater.path"
  [ ! -e "$STATE_DIR/foreign-units/health" ]
  [ "$(ls -A "$STATE_DIR/foreign-units")" = "backup
updater" ]
}

@test "save_foreign_fixed_units: nothing for the default project or for default-name units of this prefix" {
  old_units "${OPT_PREFIX}2" updater backup health
  CFG_PROJECT=mailexpert save_foreign_fixed_units
  [ ! -e "$STATE_DIR/foreign-units" ]
  old_units "$OPT_PREFIX" updater backup health
  CFG_PROJECT=p2 save_foreign_fixed_units
  [ ! -e "$STATE_DIR/foreign-units" ]
}
