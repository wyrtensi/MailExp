#!/usr/bin/env bats
# Real backup CLI with a synthetic dump provider; no database or restic repository.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/state" "$P/backups" "$BATS_TEST_TMPDIR/bin"
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-lock-test HTTP_PORT=18090 SYSTEM=0 REPO_URL=https://github.com/wyrtensi/MailExpert.git >"$P/install.conf"
  printf 'COMPOSE_PROFILES=\n' >"$P/.env"
  cat >"$BATS_TEST_TMPDIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *:/out)
      out=${arg%:/out}
      printf 'synthetic old schema\n' >"$out/db.dump"
      printf '{"schema_migrations":1}\n' >"$out/counts.json"
      printf '%s\n' "$*" >>"$DUMP_LOG"
      ;;
  esac
done
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH" DUMP_LOG=$BATS_TEST_TMPDIR/dump.log
  export MAILEXPERT_BACKUP_LOCK_TIMEOUT=0
}

@test "backup refuses to dump while installation holds its metadata/schema lock" {
  exec 8>"$P/state/install.lock"
  flock -n 8
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump"
  [ "$status" -eq 1 ]
  [ ! -e "$DUMP_LOG" ]
  [ ! -e "$P/kept.dump" ]
}

@test "backup refuses to dump while rollback or restore holds the update lock" {
  exec 8>"$P/state/update.lock"
  flock -n 8
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump"
  [ "$status" -eq 1 ]
  [ ! -e "$DUMP_LOG" ]
  [ ! -e "$P/kept.dump" ]
}

@test "pre-update backup completes while its parent holds the update lock" {
  exec 8>"$P/state/update.lock"
  flock -n 8
  MAILEXPERT_UPDATE_LOCK_FD=8 run timeout 5 bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag pre-update --keep-dump "$P/kept.dump"
  [ "$status" -eq 0 ]
  [ "$(cat "$P/kept.dump")" = 'synthetic old schema' ]
  # The child must not release the parent's exclusion of other update processes.
  run bash -c 'exec 7>"$1"; flock -n 7' _ "$P/state/update.lock"
  [ "$status" -eq 1 ]
}

@test "backup rejects an inherited descriptor for another installation" {
  exec 8>"$BATS_TEST_TMPDIR/other.lock"
  flock -n 8
  MAILEXPERT_UPDATE_LOCK_FD=8 run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump"
  [ "$status" -eq 2 ]
  [[ $output == *'does not match this installation'* ]]
  [ ! -e "$DUMP_LOG" ]
}

@test "backup rejects a malformed inherited descriptor" {
  MAILEXPERT_UPDATE_LOCK_FD=invalid run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump"
  [ "$status" -eq 2 ]
  [ ! -e "$DUMP_LOG" ]
}

@test "deployment lock descriptors remain held after acquiring all three locks" {
  take_lock "$P/state/update.lock" 0 update UPDATE_LOCK_FD
  take_install_lock "$P/state" 0 backup.sh
  take_lock "$P/state/backup.lock" 0 backup
  for lock in update install backup; do
    run bash -c 'exec 7>"$1"; flock -n 7' _ "$P/state/$lock.lock"
    [ "$status" -eq 1 ]
  done
  [ "$P/state/update.lock" -ef "/proc/self/fd/$UPDATE_LOCK_FD" ]
}

@test "backup waits for installation and reloads the deployed compose metadata" {
  mkdir "$P/gate"
  bash -c '
    source "$1/lib/common.sh"
    take_install_lock "$2/state" 0 install.sh
    touch "$2/gate/ready"
    while [ ! -e "$2/gate/release" ]; do sleep 0.05; done
    sed -i "s/PROJECT=me-lock-test/PROJECT=me-lock-new/;s/sha-0123456789ab/sha-abcdef012345/" "$2/install.conf"
  ' _ "$DEPLOY_DIR" "$P" &
  local installer=$! backup
  for _ in {1..100}; do
    [ ! -e "$P/gate/ready" ] || break
    sleep 0.05
  done
  [ -e "$P/gate/ready" ]
  MAILEXPERT_BACKUP_LOCK_TIMEOUT=5 bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump" >"$P/backup.log" 2>&1 &
  backup=$!
  for _ in {1..100}; do
    if grep -q 'waiting for' "$P/backup.log"; then break; fi
    sleep 0.05
  done
  touch "$P/gate/release"
  wait "$installer"
  wait "$backup"
  [[ $(cat "$DUMP_LOG") == *'-p me-lock-new '* ]]
}
