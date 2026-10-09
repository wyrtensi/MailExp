#!/usr/bin/env bats
# rollback.sh: going back to the version before an update with its pre-update dump. Full runs
# against a git checkout with stubs for docker and curl and a fake install.sh in the checkout.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  SCRIPT=$DEPLOY_DIR/rollback.sh
}

commit() {
  git -C "$1" add -A >/dev/null
  git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m "$2"
  git -C "$1" rev-parse HEAD
}

stub_install() {
  if [ "$(id -u)" != 0 ]; then skip "needs root"; fi
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
line="$*"
case " $* " in
  *" exec -T postgres "*) line="$line <<< $(cat | tr '\n' ' ')" ;;
esac
printf '%s\n' "$line" >>"$DOCKER_LOG"
case " $line " in
  *" image inspect "*) exit 1 ;;
  *" pull "*) exit "${STUB_PULL:-0}" ;;
  *"pg_restore"*) exit "${STUB_RESTORE:-0}" ;;
  *"pg_database_size"*) echo "${STUB_DB_BYTES:-1048576}" ;;
  *"RENAME TO"*)
    # STUB_SWAP_FAILS: how many swap attempts fail (the database still in use).
    n=$(cat "$SWAP_COUNT" 2>/dev/null || echo 0)
    echo $((n + 1)) >"$SWAP_COUNT"
    [ "$n" -ge "${STUB_SWAP_FAILS:-0}" ] || exit 1 ;;
esac
exit 0
STUB_EOF
  printf '#!/usr/bin/env bash\nexit 0\n' >"$STUB/curl"
  chmod +x "$STUB/docker" "$STUB/curl"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log INSTALL_LOG=$BATS_TEST_TMPDIR/install.log
  export SWAP_COUNT=$BATS_TEST_TMPDIR/swaps

  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/app/scripts/deploy" "$P/state" "$P/backups" "$P/edge"
  git -C "$P/app" init -q -b main
  # STUB_OLD_UNITS=<unit templates>: like install.sh of a version older than the per-project unit
  # names, the fake writes the units under the default names for its prefix and restarts the path unit.
  cat >"$P/app/scripts/deploy/install.sh" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$INSTALL_LOG"
if [ -n "${STUB_OLD_UNITS:-}" ]; then
  for f in "$STUB_OLD_UNITS"/mailexpert-*; do sed "s#@PREFIX@#$2#g" "$f" >"$MAILEXPERT_SYSTEMD_DIR/${f##*/}"; done
  systemctl restart mailexpert-updater.path
fi
exit "${STUB_INSTALL:-0}"
STUB_EOF
  OLD=$(commit "$P/app" one)
  printf 'x\n' >"$P/app/README"
  NEW=$(commit "$P/app" two)
  git -C "$P/app" checkout -q --detach "$NEW"
  git -C "$P/app" remote add origin "$P/app"
  printf '%s\n' "VERSION=sha-${NEW:0:12}" SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-test HTTP_PORT=18090 SYSTEM=0 "REPO_URL=$P/app" >"$P/install.conf"
  printf '%s\n' COMPOSE_PROFILES= DB_NAME=mailexpert >"$P/.env"
  printf 'EDGE_IMAGE=ghcr.io/x/edge@sha256:new\n' >"$P/edge/.env"
  printf 'PGDMP' >"$P/backups/pre-update-sha-${OLD:0:12}.dump"
}

@test "input: --to is required and checked, --help works" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --to 0123456789ab
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --to sha-0123456789ab --bogus
  [ "$status" -eq 2 ]
}

@test "no dump, the current version, no confirmation: exit 2 and nothing touched" {
  stub_install
  run bash "$SCRIPT" --prefix "$P" --to sha-0123456789ab --confirm sha-0123456789ab
  [ "$status" -eq 2 ]
  [[ $output == *"no dump at"* ]]
  run bash "$SCRIPT" --prefix "$P" --to "sha-${NEW:0:12}"
  [ "$status" -eq 2 ]
  [[ $output == *"install.conf says sha-${NEW:0:12} already"*"finish it with install.sh --prefix $P"* ]]
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *"pass --confirm sha-${OLD:0:12}"* ]]
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm sha-ffffffffffff
  [ "$status" -eq 2 ]
  [[ $output == *"not confirmed"* ]]
  ! grep -q " stop " "$DOCKER_LOG"
  [ ! -e "$INSTALL_LOG" ]
}

@test "an image that does not pull: exit 3 before anything stops" {
  stub_install
  STUB_PULL=1 run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 3 ]
  [[ $output == *"nothing was changed"* ]]
  ! grep -q " stop " "$DOCKER_LOG"
}

@test "a rollback: pull, stop, restore into a new database, swap by renaming, edge image, install.sh" {
  stub_install
  printf 'sha-%s ghcr.io/x/edge@sha256:old\n' "${OLD:0:12}" >"$P/state/edge-image.previous"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  pull=$(grep -n " pull " "$DOCKER_LOG" | head -1 | cut -d: -f1)
  stop=$(grep -n " stop backend frontend" "$DOCKER_LOG" | cut -d: -f1)
  create=$(grep -n 'CREATE DATABASE "mailexpert_rollback"' "$DOCKER_LOG" | cut -d: -f1)
  restore=$(grep -n "pg_restore" "$DOCKER_LOG" | cut -d: -f1)
  swap=$(grep -n 'ALTER DATABASE "mailexpert_rollback" RENAME TO "mailexpert"' "$DOCKER_LOG" | cut -d: -f1)
  [ "$pull" -lt "$stop" ] && [ "$stop" -lt "$create" ] && [ "$create" -lt "$restore" ] && [ "$restore" -lt "$swap" ]
  grep -q 'ALTER DATABASE "mailexpert" RENAME TO "mailexpert_before_rollback_' "$DOCKER_LOG"
  [ "$(cat "$INSTALL_LOG")" = "--prefix $P --version sha-${OLD:0:12}" ]
  [ "$(env_get "$P/edge/.env" EDGE_IMAGE)" = ghcr.io/x/edge@sha256:old ]
  [[ $output == *"kept as mailexpert_before_rollback_"* ]]
  # Connections to the live database are refused before the swap; the version left is recorded,
  # and a version without updater.sh is not told it has one.
  grep -q 'ALTER DATABASE "mailexpert" WITH ALLOW_CONNECTIONS false' "$DOCKER_LOG"
  [ "$(cat "$P/state/rolled-back-version")" = "sha-${NEW:0:12}" ]
  [ ! -e "$P/state/update-spool/result/updater.json" ]
  [ ! -e "$P/state/rollback-in-progress" ]
}

@test "a rollback to a version with the default unit names removes this project's suffixed units" {
  stub_install
  local units=$BATS_TEST_TMPDIR/systemd name kind unit
  mkdir -p "$units"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$SYSTEMCTL_LOG"\n' >"$STUB/systemctl"
  chmod +x "$STUB/systemctl"
  export MAILEXPERT_SYSTEMD_DIR=$units SYSTEMCTL_LOG=$BATS_TEST_TMPDIR/systemctl.log
  # The version gone back to has updater.sh and wrote its units under the default names for $P;
  # this version's units of project me-test are still there.
  printf '#!/bin/sh\n' >"$P/app/scripts/deploy/updater.sh"
  chmod +x "$P/app/scripts/deploy/updater.sh"
  for name in updater backup health; do
    if [ "$name" = updater ]; then kind=path; else kind=timer; fi
    for unit in service "$kind"; do
      render_unit "$REPO_DIR/deploy/systemd/mailexpert-$name.$unit" "$P" >"$units/mailexpert-$name.$unit"
      : >"$units/mailexpert-$name-me-test.$unit"
    done
  done
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  [ "$(cd "$units" && ls -1 | paste -sd' ' -)" = "mailexpert-backup.service mailexpert-backup.timer mailexpert-health.service mailexpert-health.timer mailexpert-updater.path mailexpert-updater.service" ]
  grep -qx "disable --now mailexpert-updater-me-test.path" "$SYSTEMCTL_LOG"
  grep -qx "disable --now mailexpert-backup-me-test.timer" "$SYSTEMCTL_LOG"
  grep -qx "disable --now mailexpert-health-me-test.timer" "$SYSTEMCTL_LOG"
  [ ! -e "$P/state/foreign-units" ]
}

# two_installs_host: one systemd host (a directory and a systemctl stub that logs; the command
# named in STUB_SYSTEMCTL_FAIL fails) with the default project's units for ${P}2 under the
# default names and this version's units of project me-test for $P; a copy in $BATS_TEST_TMPDIR/before.
# The fake install.sh writes the default names for $P, like a version older than the per-project names.
two_installs_host() {
  local name kind unit
  UNITS=$BATS_TEST_TMPDIR/systemd
  mkdir -p "$UNITS" "$P/state"
  cat >"$STUB/systemctl" <<'STUB_EOF'
#!/usr/bin/env bash
case $1 in is-active | is-enabled) exit 0 ;; esac
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
[ "$1" != "${STUB_SYSTEMCTL_FAIL:-}" ]
STUB_EOF
  chmod +x "$STUB/systemctl"
  export MAILEXPERT_SYSTEMD_DIR=$UNITS SYSTEMCTL_LOG=$BATS_TEST_TMPDIR/systemctl.log STUB_OLD_UNITS=$REPO_DIR/deploy/systemd
  printf '#!/bin/sh\n' >"$P/app/scripts/deploy/updater.sh"
  chmod +x "$P/app/scripts/deploy/updater.sh"
  for name in updater backup health; do
    if [ "$name" = updater ]; then kind=path; else kind=timer; fi
    for unit in service "$kind"; do
      render_unit "$REPO_DIR/deploy/systemd/mailexpert-$name.$unit" "${P}2" >"$UNITS/mailexpert-$name.$unit"
      CFG_PROJECT=me-test render_project_unit "$REPO_DIR/deploy/systemd/mailexpert-$name.$unit" "$P" >"$UNITS/mailexpert-$name-me-test.$unit"
    done
  done
  cp -r "$UNITS" "$BATS_TEST_TMPDIR/before"
}

@test "a rollback to a version with the default unit names puts another install's units under them back" {
  stub_install
  two_installs_host
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  # The old install.sh rewrote them for $P; now every unit is as before: the default names serve
  # ${P}2, the suffixed ones $P.
  grep -qx "restart mailexpert-updater.path" "$SYSTEMCTL_LOG"
  diff -r "$BATS_TEST_TMPDIR/before" "$UNITS"
  grep -qx "PathExistsGlob=${P}2/state/update-spool/request/\*.json" "$UNITS/mailexpert-updater.path"
  grep -qx "ExecStart=${P}2/app/scripts/deploy/backup.sh --prefix ${P}2" "$UNITS/mailexpert-backup.service"
  grep -qx "PathExistsGlob=$P/state/update-spool/request/\*.json" "$UNITS/mailexpert-updater-me-test.path"
  grep -qx "ExecStart=$P/app/scripts/deploy/healthcheck.sh --prefix $P" "$UNITS/mailexpert-health-me-test.service"
  [ "$(sed -n '/daemon-reload/,$p' "$SYSTEMCTL_LOG" | grep restart | paste -sd'|' -)" = "restart mailexpert-updater.path|restart mailexpert-backup.timer|restart mailexpert-health.timer" ]
  run ! grep -qE "disable|service" "$SYSTEMCTL_LOG"
  [ ! -e "$P/state/foreign-units" ]
  [ ! -e "$P/state/rollback-in-progress" ]
}

@test "a rollback that cannot put another install's units back says so and exits 1" {
  stub_install
  two_installs_host
  STUB_SYSTEMCTL_FAIL=daemon-reload run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"saved copies are in $P/state/foreign-units"* ]]
  [[ $output == *"error: rolled back to sha-${OLD:0:12}, but the systemd units of another install on this host"*"could not all be put back"* ]]
  [ -d "$P/state/foreign-units/updater" ]
  # This install's suffixed units are kept: nothing is disabled.
  [ -e "$UNITS/mailexpert-updater-me-test.path" ] && [ -e "$UNITS/mailexpert-backup-me-test.timer" ]
  run ! grep -q disable "$SYSTEMCTL_LOG"
  [ ! -e "$P/state/rollback-in-progress" ]
}

@test "a rollback that cannot save another install's units stops before install.sh, and can be run again" {
  stub_install
  two_installs_host
  # Nothing can be created under it.
  : >"$P/state/foreign-units"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"could not save the systemd units of another install on this host"*"install.sh was not run"* ]]
  [ ! -e "$INSTALL_LOG" ]
  diff -r "$BATS_TEST_TMPDIR/before" "$UNITS"
  # The database was swapped: a rerun goes on from there.
  [ -e "$P/state/rollback-in-progress" ]
  rm -f "$P/state/foreign-units"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  [[ $output == *"an earlier run already swapped the database"* ]]
  diff -r "$BATS_TEST_TMPDIR/before" "$UNITS"
}

@test "a rollback of the default project leaves the units under the default names to the old install.sh" {
  stub_install
  two_installs_host
  sed -i 's/^PROJECT=me-test$/PROJECT=mailexpert/' "$P/install.conf"
  # The default project of $P owns the default names; another project's units are suffixed.
  rm -f "$UNITS"/*
  for name in updater backup health; do
    if [ "$name" = updater ]; then kind=path; else kind=timer; fi
    for unit in service "$kind"; do
      render_unit "$REPO_DIR/deploy/systemd/mailexpert-$name.$unit" "$P" >"$UNITS/mailexpert-$name.$unit"
      CFG_PROJECT=other render_project_unit "$REPO_DIR/deploy/systemd/mailexpert-$name.$unit" "${P}2" >"$UNITS/mailexpert-$name-other.$unit"
    done
  done
  rm -rf "$BATS_TEST_TMPDIR/before"
  cp -r "$UNITS" "$BATS_TEST_TMPDIR/before"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  diff -r "$BATS_TEST_TMPDIR/before" "$UNITS"
  # Only the old install.sh's own restart: nothing is saved, put back or removed.
  [ "$(cat "$SYSTEMCTL_LOG")" = "restart mailexpert-updater.path" ]
  [ ! -e "$P/state/foreign-units" ]
}

@test "not enough space for the restored copy next to the database: exit 2 before anything stops" {
  stub_install
  STUB_DB_BYTES=999999999999999 run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 2 ]
  [[ $output == *"the rollback needs"* ]]
  ! grep -q " stop " "$DOCKER_LOG"
}

@test "the swap is retried while the database is in use, and given up cleanly" {
  stub_install
  STUB_SWAP_FAILS=2 run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  [[ $output == *"still in use (try 2 of 5)"* ]]
  rm -f "$SWAP_COUNT" "$INSTALL_LOG" "$P/state/rolled-back-version"
  printf '%s\n' "VERSION=sha-${NEW:0:12}" SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-test HTTP_PORT=18090 SYSTEM=0 "REPO_URL=$P/app" >"$P/install.conf"
  STUB_SWAP_FAILS=9 run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"could not be swapped; mailexpert is unchanged"* ]]
  grep -q 'ALTER DATABASE "mailexpert" WITH ALLOW_CONNECTIONS true' "$DOCKER_LOG"
  [ ! -e "$INSTALL_LOG" ]
}

@test "the name kept for the replaced database fits PostgreSQL's 63 bytes" {
  stub_install
  long=abcdefghijabcdefghijabcdefghijabcdefghija
  printf '%s\n' COMPOSE_PROFILES= "DB_NAME=$long" >"$P/.env"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  kept=$(sed -n 's/.*RENAME TO "\([a-z_0-9]*_before_rollback_[0-9]*\)".*/\1/p' "$DOCKER_LOG" | head -1)
  [ -n "$kept" ] && [ "${#kept}" -le 63 ]
}

@test "a run interrupted after the swap: the rerun only switches the code" {
  stub_install
  printf '%s\n%s\n%s\n' "sha-${OLD:0:12}" mailexpert_before_rollback_1 "sha-${NEW:0:12}" >"$P/state/rollback-in-progress"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 0 ]
  [[ $output == *"an earlier run already swapped the database"* ]]
  ! grep -q "pg_restore" "$DOCKER_LOG"
  [ "$(cat "$INSTALL_LOG")" = "--prefix $P --version sha-${OLD:0:12}" ]
  [ ! -e "$P/state/rollback-in-progress" ]
}

@test "a dump that does not restore: the old database stays and the panel starts again" {
  stub_install
  STUB_RESTORE=1 run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"the database mailexpert is unchanged"* ]]
  ! grep -q "RENAME" "$DOCKER_LOG"
  grep -q " start backend frontend" "$DOCKER_LOG"
  [ ! -e "$INSTALL_LOG" ]
}

@test "a DB_NAME that is not a plain name is refused" {
  stub_install
  printf '%s\n' 'DB_NAME=x";drop' >"$P/.env"
  run bash "$SCRIPT" --prefix "$P" --to "sha-${OLD:0:12}" --confirm "sha-${OLD:0:12}"
  [ "$status" -eq 2 ]
  [[ $output == *"is not a plain database name"* ]]
}
