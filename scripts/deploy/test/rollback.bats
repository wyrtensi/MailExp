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
case " $* " in
  *" image inspect "*) exit 1 ;;
  *" pull "*) exit "${STUB_PULL:-0}" ;;
  *"pg_restore"*) exit "${STUB_RESTORE:-0}" ;;
esac
exit 0
STUB_EOF
  printf '#!/usr/bin/env bash\nexit 0\n' >"$STUB/curl"
  chmod +x "$STUB/docker" "$STUB/curl"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log INSTALL_LOG=$BATS_TEST_TMPDIR/install.log

  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/app/scripts/deploy" "$P/state" "$P/backups" "$P/edge"
  git -C "$P/app" init -q -b main
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$INSTALL_LOG"\nexit "${STUB_INSTALL:-0}"\n' >"$P/app/scripts/deploy/install.sh"
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
  [[ $output == *"is at sha-${NEW:0:12} already"* ]]
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
