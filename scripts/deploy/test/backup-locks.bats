#!/usr/bin/env bats
# Real backup CLI with a synthetic dump provider and a stub restic; no database or repository.
# The stubs record which deployment locks another process could take at the dump and at the
# upload (PROBE_LOG), and the monitoring pings (PING_LOG).

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
# probe <phase>: whether another process could take each lock exclusively right now.
probe() {
  local lock line=$1
  for lock in update install backup; do
    if bash -c 'exec 7>"$1"; flock -n 7' _ "$P/state/$lock.lock"; then line+=" $lock=free"; else line+=" $lock=held"; fi
  done
  printf '%s\n' "$line" >>"$PROBE_LOG"
}
# docker ps: the ownership check (lib/app.sh panel_exec_problem); STUB_CONTAINERS lists the panel
# project's containers ("<name>\037<working dir>\037<install ID>" lines; none by default).
if [ "$1" = ps ]; then
  printf '%s\n' "$*" >>"$P/ps.log"
  if [ -n "${STUB_DOCKER_PS_STATUS:-}" ]; then echo "Cannot connect to the Docker daemon" >&2; exit "$STUB_DOCKER_PS_STATUS"; fi
  if [ -n "${STUB_CONTAINERS:-}" ]; then printf "$STUB_CONTAINERS\n"; fi
  exit 0
fi
case " $* " in
  *" backup --json "*)
    probe upload
    printf '{"message_type":"summary","snapshot_id":"0123456789abcdef"}\n'
    exit 0
    ;;
esac
for arg in "$@"; do
  case "$arg" in
    *:/out)
      probe dump
      if [ -n "${PROBE_HEALTH:-}" ]; then bash "$DEPLOY_DIR/healthcheck.sh" --prefix "$P" >>"$HEALTH_LOG" 2>&1 || true; fi
      out=${arg%:/out}
      printf 'synthetic old schema\n' >"$out/db.dump"
      printf '{"schema_migrations":1}\n' >"$out/counts.json"
      printf '%s\n' "$*" >>"$DUMP_LOG"
      ;;
  esac
done
exit 0
STUB
  cat >"$BATS_TEST_TMPDIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
case " $* " in *"/api/health/ready"*) exit 7 ;; esac
while [ $# -gt 0 ]; do
  if [ "$1" = -K ]; then cat "$2" >>"$PING_LOG"; shift; fi
  shift
done
cat >/dev/null
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker" "$BATS_TEST_TMPDIR/bin/curl"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH" P DEPLOY_DIR DUMP_LOG=$BATS_TEST_TMPDIR/dump.log \
    PROBE_LOG=$BATS_TEST_TMPDIR/probe.log PING_LOG=$BATS_TEST_TMPDIR/ping.log HEALTH_LOG=$BATS_TEST_TMPDIR/health.log
  export MAILEXPERT_BACKUP_LOCK_TIMEOUT=0
}

# configure_restic: the four restic keys (placeholders: the stub never reaches a repository) and
# a ping URL of the backup's own.
configure_restic() {
  printf '%s\n' COMPOSE_PROFILES= RESTIC_REPOSITORY=s3:https://s3.example.com/backups RESTIC_PASSWORD=test-only \
    AWS_ACCESS_KEY_ID=test-only AWS_SECRET_ACCESS_KEY=test-only BACKUP_PING_URL=https://hc.example.com/ping/backup >"$P/.env"
}

# wait_for <file>: up to 5 s for the file to appear.
wait_for() {
  for _ in {1..100}; do
    [ ! -e "$1" ] || return 0
    sleep 0.05
  done
  return 1
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

@test "pre-update backup with restic keeps its parent's update lock through the upload" {
  configure_restic
  exec 8>"$P/state/update.lock"
  flock -n 8
  MAILEXPERT_UPDATE_LOCK_FD=8 run timeout 5 bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag pre-update --keep-dump "$P/kept.dump"
  [ "$status" -eq 0 ]
  [ "$(sed -n 1p "$PROBE_LOG")" = 'dump update=held install=held backup=held' ]
  [ "$(sed -n 2p "$PROBE_LOG")" = 'upload update=held install=free backup=held' ]
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

@test "backup holds update.lock and install.lock only for the capture, not for the upload" {
  configure_restic
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  [ "$(sed -n 1p "$PROBE_LOG")" = 'dump update=held install=held backup=held' ]
  # restic's phase: install.sh (the updater's rollback among them), update.sh and rollback.sh go on.
  [ "$(sed -n 2p "$PROBE_LOG")" = 'upload update=free install=free backup=held' ]
  [[ $output == *'snapshot 01234567 stored (tag manual)'* ]]
}

@test "the health check is not skipped while a backup dumps the database" {
  configure_restic
  PROBE_HEALTH=1 run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  [ -s "$HEALTH_LOG" ]
  run ! grep -q 'health check skipped' "$HEALTH_LOG"
  grep -q 'problem: ready:' "$HEALTH_LOG"
}

@test "lock_held reports an exclusive holder of update.lock, not a backup's shared one" {
  exec 8>"$P/state/update.lock"
  flock -n -s 8
  run ! lock_held "$P/state/update.lock"
  flock -u 8
  bash -c 'exec 7>"$1"; flock -n 7; touch "$2"; sleep 5' _ "$P/state/update.lock" "$BATS_TEST_TMPDIR/held" &
  local holder=$!
  wait_for "$BATS_TEST_TMPDIR/held"
  lock_held "$P/state/update.lock"
  kill "$holder"
}

@test "a backup waiting for an update holds neither backup.lock nor install.lock" {
  configure_restic
  bash -c 'exec 7>"$1"; flock -n 7; touch "$2"; while [ ! -e "$3" ]; do sleep 0.05; done' _ \
    "$P/state/update.lock" "$BATS_TEST_TMPDIR/held" "$BATS_TEST_TMPDIR/release" &
  local updater=$! backup
  wait_for "$BATS_TEST_TMPDIR/held"
  MAILEXPERT_BACKUP_LOCK_TIMEOUT=10 bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual >"$P/backup.log" 2>&1 &
  backup=$!
  for _ in {1..100}; do
    if grep -q 'waiting for' "$P/backup.log"; then break; fi
    sleep 0.05
  done
  grep -q 'waiting for' "$P/backup.log"
  # The updater's rollback (install.sh) and update.sh's pre-update backup are not blocked by it.
  bash -c 'exec 7>"$1"; flock -n 7' _ "$P/state/install.lock"
  bash -c 'exec 7>"$1"; flock -n 7' _ "$P/state/backup.lock"
  touch "$BATS_TEST_TMPDIR/release"
  wait "$updater"
  wait "$backup"
  [ "$(sed -n 1p "$PROBE_LOG")" = 'dump update=held install=held backup=held' ]
}

@test "a backup that gives up waiting for a lock sends a fail ping" {
  configure_restic
  exec 8>"$P/state/update.lock"
  flock -n 8
  run bash "$DEPLOY_DIR/backup.sh" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $output == *'gave up after 0s waiting for'* ]]
  [ ! -e "$DUMP_LOG" ]
  grep -qx 'url = "https://hc.example.com/ping/backup/fail"' "$PING_LOG"
  run ! grep -q 'ping/backup/start' "$PING_LOG"
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
  wait_for "$P/gate/ready"
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
  # The ownership check asks about the project the dump goes to: the reloaded one.
  grep -q -- "label=com.docker.compose.project=me-lock-new " "$P/ps.log"
}

@test "a container of another owner in the panel's project: no dump, exit 1, fail ping" {
  configure_restic
  STUB_CONTAINERS='me-lock-test-postgres-1\037/srv/neighbour/app\037fedcba9876543210' run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --with-redis
  [ "$status" -eq 1 ]
  [[ $output == *"compose project me-lock-test is not only this install's (its directory is $P/app): container me-lock-test-postgres-1 (/srv/neighbour/app, install fedcba9876543210); nothing was run in it"* ]]
  [ ! -e "$DUMP_LOG" ]
  [ ! -e "$PROBE_LOG" ]
  grep -qx 'url = "https://hc.example.com/ping/backup/start"' "$PING_LOG"
  grep -qx 'url = "https://hc.example.com/ping/backup/fail"' "$PING_LOG"
  # A local dump only (update.sh without restic keys): refused the same way, no ping to send.
  rm -f "$PING_LOG"
  printf 'COMPOSE_PROFILES=\n' >"$P/.env"
  STUB_CONTAINERS='x\037\037' run bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --keep-dump "$P/kept.dump"
  [ "$status" -eq 1 ]
  [[ $output == *"container x (no compose working directory)"* ]]
  [ ! -e "$DUMP_LOG" ]
  [ ! -e "$P/kept.dump" ]
  [ ! -e "$PING_LOG" ]
}

@test "docker that does not answer the ownership check: no dump, exit 1, fail ping" {
  configure_restic
  STUB_DOCKER_PS_STATUS=1 run bash "$DEPLOY_DIR/backup.sh" --prefix "$P"
  [ "$status" -eq 1 ]
  [[ $output == *"cannot list Docker's containers to check compose project me-lock-test"* ]]
  [ ! -e "$DUMP_LOG" ]
  grep -qx 'url = "https://hc.example.com/ping/backup/fail"' "$PING_LOG"
}

# --tag manual: the same path as the nightly run up to the checks (a Sunday's verify needs a
# repository the stub does not have).
@test "a backup of this install's own containers passes the check: by directory or install ID" {
  configure_restic
  printf 'INSTALL_ID=0123456789abcdef\n' >>"$P/install.conf"
  STUB_CONTAINERS="me-lock-test-postgres-1\037$P/app\037\nme-lock-test-backend-1\037/moved/app\0370123456789abcdef\nme-lock-test-postgres-run-1\037$P/app/\0370123456789abcdef" \
    run timeout 5 bash "$DEPLOY_DIR/backup.sh" --prefix "$P" --tag manual
  [ "$status" -eq 0 ]
  [ -s "$DUMP_LOG" ]
  grep -q -- "ps -a --filter label=com.docker.compose.project=me-lock-test " "$P/ps.log"
  run ! grep -q 'ping/backup/fail' "$PING_LOG"
}
