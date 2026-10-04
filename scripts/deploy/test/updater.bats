#!/usr/bin/env bats
# updater.sh, the host side of "update from the panel", and its decisions (lib/updater.sh): the
# spool is the boundary between the backend container and root, so most of this file is about
# what it refuses. The full runs use a real git checkout, the real status.sh with stubs for id,
# docker and curl, and a fake update.sh/install.sh.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/status.sh"
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/updater.sh"
}

ID1=11111111-1111-4111-8111-111111111111
ID2=22222222-2222-4222-8222-222222222222

# --- lib/updater.sh ---

@test "request_name_ok takes only <uuid>.json" {
  request_name_ok "$ID1.json"
  ! request_name_ok "$ID1.tmp"
  ! request_name_ok "$ID1"
  ! request_name_ok "../$ID1.json"
  ! request_name_ok "11111111-1111-4111-8111-11111111111G.json"
  ! request_name_ok "x.json"
  ! request_name_ok ".json"
}

@test "request_file_problem: only a regular file of the backend's uid, one link, 1..4096 bytes" {
  [ -z "$(request_file_problem 'regular file' 1000 120 1)" ]
  [[ $(request_file_problem 'symbolic link' 1000 10 1) == "not a regular file (symbolic link)" ]]
  [[ $(request_file_problem 'fifo' 1000 0 1) == "not a regular file (fifo)" ]]
  [[ $(request_file_problem 'directory' 1000 4096 2) == "not a regular file"* ]]
  [[ $(request_file_problem 'regular file' 0 120 1) == "owned by uid 0"* ]]
  [[ $(request_file_problem 'regular empty file' 1000 0 1) == "size 0 "* ]]
  [[ $(request_file_problem 'regular file' 1000 4097 1) == "size 4097 "* ]]
  [[ $(request_file_problem 'regular file' 1000 120 2) == "has 2 links" ]]
}

request() {
  printf '{"id":"%s","action":"%s","target":"%s","requestedAt":"2026-10-05T10:00:00Z","requestedBy":"%s"}' \
    "${1:-$ID1}" "${2:-update}" "${3:-sha-0123456789ab}" "${4:-admin@example.com}"
}

@test "parse_request takes exactly the five fields and prints action and target" {
  [ "$(request | parse_request "$ID1")" = "update sha-0123456789ab" ]
  [ "$(request "$ID1" check | parse_request "$ID1")" = "check sha-0123456789ab" ]
}

@test "parse_request refuses every other shape" {
  ! request | parse_request "$ID2"
  ! request "$ID1" rollback | parse_request "$ID1"
  ! request "$ID1" update 'sha-0123456789ab; rm -rf /' | parse_request "$ID1"
  ! request "$ID1" update latest | parse_request "$ID1"
  ! request "$ID1" update SHA-0123456789AB | parse_request "$ID1"
  ! request "$ID1" update 'sha-0123456789ab\n' | parse_request "$ID1"
  ! printf '{"id":"%s","action":"update","target":"sha-0123456789ab\\n","requestedAt":"x","requestedBy":"x"}' "$ID1" | parse_request "$ID1"
  ! printf '{"id":"%s","action":"update","target":"sha-0123456789ab","requestedAt":"x","requestedBy":"x","extra":1}' "$ID1" | parse_request "$ID1"
  ! printf '{"id":"%s","action":"update","target":"sha-0123456789ab","requestedAt":"x"}' "$ID1" | parse_request "$ID1"
  ! printf '{"id":"%s","action":"update","target":"sha-0123456789ab","requestedAt":1,"requestedBy":"x"}' "$ID1" | parse_request "$ID1"
  ! printf '[1,2]' | parse_request "$ID1"
  ! printf 'not json' | parse_request "$ID1"
  ! printf '' | parse_request "$ID1"
  ! request "$ID1" update sha-0123456789ab "$(printf 'x%.0s' {1..300})" | parse_request "$ID1"
}

@test "request_actor keeps only safe characters" {
  [ "$(request "$ID1" update sha-0123456789ab 'a$(id)`b`@x.y' | request_actor)" = 'aidb@x.y' ]
}

@test "target_verdict: only the promoted latest, on main, forward, not rolled back" {
  [ -z "$(target_verdict 0 1 1 1 0)" ]
  [[ $(target_verdict 1 1 1 1 0) == "the panel already runs this version" ]]
  [[ $(target_verdict 0 1 0 1 0) == "not the promoted latest build"* ]]
  [[ $(target_verdict 0 1 1 0 0) == "the tag latest names a commit outside main"* ]]
  [[ $(target_verdict 0 0 1 1 0) == "not a descendant of the running commit"* ]]
  [[ $(target_verdict 0 1 1 1 1) == "this version was rolled back"* ]]
}

@test "spool_uid and rolled_back_version read only well-formed records" {
  S=$BATS_TEST_TMPDIR/s
  mkdir -p "$S"
  [ "$(spool_uid "$S")" = 1000 ]
  echo 1001 >"$S/spool-uid"
  [ "$(spool_uid "$S")" = 1001 ]
  echo 0 >"$S/spool-uid"
  [ "$(spool_uid "$S")" = 1000 ]
  echo 'x; rm' >"$S/spool-uid"
  [ "$(spool_uid "$S")" = 1000 ]
  [ -z "$(rolled_back_version "$S")" ]
  record_rolled_back "$S" sha-0123456789ab
  [ "$(rolled_back_version "$S")" = sha-0123456789ab ]
  echo 'sha-zz' >"$S/rolled-back-version"
  [ -z "$(rolled_back_version "$S")" ]
}

@test "redact_url drops user information from a repository URL" {
  [ "$(redact_url https://user:t0ken@github.com/o/r.git)" = https://github.com/o/r.git ]
  [ "$(redact_url https://github.com/o/r.git)" = https://github.com/o/r.git ]
  [ "$(redact_url /srv/repo)" = /srv/repo ]
}

@test "rollback_space_problem needs the database plus the dump" {
  [ -z "$(rollback_space_problem 3000 1048576 1048576)" ]
  [[ $(rollback_space_problem 1024 1048576 1048576) == "free space: 1 MB, the rollback needs 2 MB"* ]]
}

@test "preflight_verdict and preflight_summary read status.sh --json" {
  [ "$(preflight_verdict 0 <<<'{"problems":[],"warnings":["w"]}')" = ready ]
  [ "$(preflight_verdict 1 <<<'{"problems":["p"]}')" = blocked ]
  [ "$(preflight_verdict 1 <<<'{"error":"script_failure","exit_code":1}')" = error ]
  [ "$(preflight_verdict 2 <<<'{"error":"invalid_input_or_no_installation","exit_code":2}')" = error ]
  [ "$(preflight_verdict 0 <<<'garbage')" = error ]
  run preflight_summary <<<'{"problems":[],"warnings":[],"next":["n"],"info":[],"migrations_applied":3,"target":{"pending_migrations":[]}}'
  [ "$(jq -c . <<<"$output")" = '{"ok":true,"problems":[],"warnings":[],"next":["n"],"info":[],"pendingMigrations":[],"migrationsApplied":3}' ]
  run preflight_summary <<<'{"problems":["p"],"migrations_applied":null,"target":{"pending_migrations":null}}'
  [ "$(jq -c '[.ok, .pendingMigrations, .migrationsApplied]' <<<"$output")" = '[false,null,null]' ]
}

@test "auto_rollback_allowed only when it is known that nothing migrates" {
  auto_rollback_allowed '{"pendingMigrations":[],"migrationsApplied":3}'
  ! auto_rollback_allowed '{"pendingMigrations":["0091_x"],"migrationsApplied":3}'
  ! auto_rollback_allowed '{"pendingMigrations":null,"migrationsApplied":3}'
  ! auto_rollback_allowed '{"pendingMigrations":[],"migrationsApplied":null}'
  ! auto_rollback_allowed 'null'
}

@test "log_tail keeps the scripts' own lines, never one that looks like a secret" {
  run log_tail <<<$'docker noise\n[mailexpert] backup before the update\n  RESTIC_PASSWORD=hunter2\n[mailexpert] SESSION_SECRET=abc\n[mailexpert] updated'
  [ "$output" = $'[mailexpert] backup before the update\n[mailexpert] updated' ]
  run log_next <<<$'[mailexpert] next: mail node: x\n[mailexpert] info: y'
  [ "$output" = "mail node: x" ]
}

@test "result_merge sets fields, updatedAt and terminal" {
  run result_merge 2026-10-05T10:00:00Z 'state="checking"' 'id="x"' <<<'{}'
  [ "$(jq -c . <<<"$output")" = '{"state":"checking","id":"x","updatedAt":"2026-10-05T10:00:00Z","terminal":false}' ]
  run result_merge 2026-10-05T10:01:00Z 'state="succeeded"' 'exitCode=0' <<<"$output"
  [ "$(jq -c '[.id, .state, .exitCode, .terminal]' <<<"$output")" = '["x","succeeded",0,true]' ]
}

@test "prepare_update_spool: request is the backend's, result root's; a link is replaced" {
  if [ "$(id -u)" != 0 ]; then skip "needs root (chown)"; fi
  mkdir -p "$BATS_TEST_TMPDIR/state" "$BATS_TEST_TMPDIR/elsewhere"
  mkdir -p "$BATS_TEST_TMPDIR/state/update-spool"
  ln -s "$BATS_TEST_TMPDIR/elsewhere" "$BATS_TEST_TMPDIR/state/update-spool/request"
  prepare_update_spool "$BATS_TEST_TMPDIR/state"
  [ ! -L "$BATS_TEST_TMPDIR/state/update-spool/request" ]
  [ "$(stat -c '%u %a' "$BATS_TEST_TMPDIR/state/update-spool/request")" = "1000 700" ]
  [ "$(stat -c '%u %a' "$BATS_TEST_TMPDIR/state/update-spool/result")" = "0 755" ]
  [ "$(stat -c '%u %a' "$BATS_TEST_TMPDIR/elsewhere")" != "1000 700" ]
  chmod 777 "$BATS_TEST_TMPDIR/state/update-spool/request"
  prepare_update_spool "$BATS_TEST_TMPDIR/state"
  [ "$(stat -c '%u %a' "$BATS_TEST_TMPDIR/state/update-spool/request")" = "1000 700" ]
}

# --- updater.sh input ---

@test "--help, bad input and not root" {
  run bash "$DEPLOY_DIR/updater.sh" --help
  [ "$status" -eq 0 ]
  run bash "$DEPLOY_DIR/updater.sh" --prefix relative
  [ "$status" -eq 2 ]
  run bash "$DEPLOY_DIR/updater.sh" --bogus
  [ "$status" -eq 2 ]
  if [ "$(id -u)" != 0 ]; then
    run bash "$DEPLOY_DIR/updater.sh" --prefix /opt/x
    [ "$status" -eq 2 ]
    [[ $output == *"run updater.sh as root"* ]]
  fi
}

# --- full runs: a git checkout, stubs for docker and curl, a fake update.sh and install.sh ---

commit() {
  git -C "$1" add -A >/dev/null
  git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m "$2"
  git -C "$1" rev-parse HEAD
}

stub_install() {
  if [ "$(id -u)" != 0 ]; then skip "needs root: request files are owned by the backend's uid"; fi
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case " $* " in
  *" ps "*"{{.Service}} {{.State}} {{.Health}}"*)
    printf '%s\n' "frontend running healthy" "backend running healthy" "postgres running healthy" "redis running healthy" ;;
  *" ps "*"{{.Service}} {{.Image}}"*)
    printf '%s\n' "frontend ghcr.io/wyrtensi/mailexpert-frontend:$STUB_TAG" "backend ghcr.io/wyrtensi/mailexpert-backend:$STUB_TAG" ;;
  *" exec -T postgres "*)
    sql=$(cat)
    case $sql in
      *"count(*) FROM schema_migrations"*)
        if [ -s "$STUB_COUNT_FILE" ]; then cat "$STUB_COUNT_FILE"; else printf '%s\n' $STUB_APPLIED | grep -c .; fi ;;
      *schema_migrations*) printf '%s\n' $STUB_APPLIED ;;
      *integration_config*) echo ok ;;
    esac ;;
  *" info "*) exit 1 ;;
  *" image inspect "*) exit 1 ;;
  *" manifest inspect "*) [ "${STUB_MANIFEST:-ok}" = ok ] || { echo "no such manifest" >&2; exit 1; } ;;
esac
exit 0
STUB_EOF
  cat >"$STUB/curl" <<'STUB_EOF'
#!/usr/bin/env bash
case " $* " in
  *"/api/health/ready"*) exit 0 ;;
  *"/api/version"*) printf '{"version":"x","sha":"%s"}\n' "$STUB_SHA" ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/docker" "$STUB/curl"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log

  # The deploy scripts, with update.sh replaced by a fake that logs and exits STUB_UPDATE.
  D=$BATS_TEST_TMPDIR/deploy
  cp -r "$DEPLOY_DIR" "$D"
  cat >"$D/update.sh" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$UPDATE_LOG"
printf '[mailexpert] backup before the update\n[mailexpert] updating -> %s\n' "$1" >&2
printf '[mailexpert] next: mail node: its host scripts changed\n' >&2
if [ -n "${STUB_COUNT_AFTER:-}" ]; then echo "$STUB_COUNT_AFTER" >"$STUB_COUNT_FILE"; fi
exit "${STUB_UPDATE:-0}"
STUB_EOF
  export UPDATE_LOG=$BATS_TEST_TMPDIR/update.log INSTALL_LOG=$BATS_TEST_TMPDIR/install.log
  # Empty: the count follows STUB_APPLIED; the fake update.sh writes STUB_COUNT_AFTER into it.
  export STUB_COUNT_FILE=$BATS_TEST_TMPDIR/count
  : >"$STUB_COUNT_FILE"

  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P/app/backend/migrations" "$P/app/scripts/deploy" "$P/state" "$P/backups" "$P/edge"
  git -C "$P/app" init -q -b main
  printf 'select 1;\n' >"$P/app/backend/migrations/0001_a.sql"
  printf 'services:\n  postgres:\n    image: postgres:16-alpine\n' >"$P/app/docker-compose.yml"
  # The checkout's own install.sh (the auto-rollback runs it): a fake that logs.
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$INSTALL_LOG"\necho "[mailexpert] install.sh $*" >&2\nexit "${STUB_INSTALL:-0}"\n' >"$P/app/scripts/deploy/install.sh"
  OLD=$(commit "$P/app" one)
  printf 'x\n' >"$P/app/README"
  NEW=$(commit "$P/app" two)
  printf 'select 2;\n' >"$P/app/backend/migrations/0002_b.sql"
  MIG=$(commit "$P/app" three)
  git -C "$P/app" checkout -q -b side "$OLD"
  printf 'y\n' >"$P/app/SIDE"
  SIDE=$(commit "$P/app" side)
  git -C "$P/app" checkout -q --detach "$NEW"
  git -C "$P/app" remote add origin "$P/app"
  git -C "$P/app" fetch -q origin
  # The owner promoted MIG.
  git -C "$P/app" tag latest "$MIG"
  printf '%s\n' COMPOSE_PROFILES= SESSION_SECRET=do-not-print-me >"$P/.env"
  at_version "$NEW"
  export STUB_APPLIED=0001_a
  prepare_update_spool "$P/state"
  REQ=$P/state/update-spool/request RES=$P/state/update-spool/result
}

# at_version <commit>: the panel runs <commit>: checkout, install.conf and what the stubs report.
at_version() {
  git -C "$P/app" checkout -q --detach "$1"
  printf '%s\n' "VERSION=sha-${1:0:12}" SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE=0 \
    PROJECT=me-test HTTP_PORT=18090 SYSTEM=0 "REPO_URL=$P/app" >"$P/install.conf"
  export STUB_TAG=sha-${1:0:12} STUB_SHA=$1
}

# put_request <id> <action> <target>: a request as the backend writes it.
put_request() {
  request "$1" "$2" "$3" >"$REQ/$1.json"
  chown 1000:1000 "$REQ/$1.json"
}

run_updater() {
  MAILEXPERT_UPDATER_INTERVAL=1 run --separate-stderr bash "$D/updater.sh" --prefix "$P"
}

result() { jq -r "$2" "$RES/$1.json"; }

@test "a check of a newer commit on main: ready, with the preflight; the spool is drained" {
  stub_install
  put_request "$ID1" check "sha-${MIG:0:12}"
  run_updater
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$REQ")" ]
  [ "$(result "$ID1" .state)" = ready ]
  [ "$(result "$ID1" .terminal)" = true ]
  [ "$(result "$ID1" .from)" = "sha-${NEW:0:12}" ]
  [ "$(result "$ID1" '.preflight.pendingMigrations | join(",")')" = 0002_b ]
  [ "$(result "$ID1" .preflight.migrationsApplied)" = 1 ]
  [ "$(stat -c %a "$RES/$ID1.json")" = 644 ]
  [ "$(jq -r .installed "$RES/updater.json")" = true ]
  [ ! -e "$UPDATE_LOG" ]
  [[ $stderr == *"request $ID1 from admin@example.com"* ]]
}

id_n() { printf 'bbbbbbbb-bbbb-4bbb-8bbb-%012d' "$1"; }

@test "refusals: a commit on main that is not latest, a downgrade, the running version, an unknown commit" {
  stub_install
  git -C "$P/app" tag -f latest "$MIG" >/dev/null
  at_version "$OLD"
  put_request "$(id_n 1)" update "sha-${NEW:0:12}"
  run_updater
  [ "$(result "$(id_n 1)" .state)" = refused ]
  [[ $(result "$(id_n 1)" .message) == "not the promoted latest build"*"update.sh over SSH"* ]]
  at_version "$MIG"
  git -C "$P/app" tag -f latest "$NEW" >/dev/null
  put_request "$(id_n 2)" update "sha-${NEW:0:12}"
  run_updater
  [[ $(result "$(id_n 2)" .message) == "not a descendant of the running commit"* ]]
  put_request "$(id_n 3)" check "sha-${MIG:0:12}"
  run_updater
  [ "$(result "$(id_n 3)" .message)" = "the panel already runs this version" ]
  put_request "$(id_n 4)" check sha-0123456789ab
  run_updater
  [[ $(result "$(id_n 4)" .message) == "commit 0123456789ab is not in "* ]]
  [ ! -e "$UPDATE_LOG" ]
}

@test "the tag latest on a commit outside main is refused" {
  stub_install
  at_version "$OLD"
  git -C "$P/app" tag -f latest "$SIDE" >/dev/null
  put_request "$ID1" check "sha-${SIDE:0:12}"
  run_updater
  [ "$(result "$ID1" .state)" = refused ]
  [[ $(result "$ID1" .message) == "the tag latest names a commit outside main"* ]]
}

@test "a request with the id of an existing result is dropped and the result stays as it was" {
  stub_install
  printf '{"id":"%s","action":"update","state":"succeeded","terminal":true}\n' "$ID1" >"$RES/$ID1.json"
  before=$(cat "$RES/$ID1.json")
  put_request "$ID1" update "sha-0123456789ab"
  run_updater
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$REQ")" ]
  [ "$(cat "$RES/$ID1.json")" = "$before" ]
  [[ $stderr == *"request $ID1 dropped: a result with this id exists already"* ]]
}

@test "a flood: at most 10 requests per run get a result, the rest are removed with one log line" {
  stub_install
  for i in $(seq 1 15); do put_request "$(id_n "$i")" check "sha-${MIG:0:12}"; done
  run_updater
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$REQ")" ]
  [ "$(find "$RES" -name 'bbbbbbbb-*.json' | wc -l)" -eq 10 ]
  [[ $stderr == *"removed 5 requests beyond 10 in one run, without results"* ]]
}

@test "the version a person rolled back from is refused" {
  stub_install
  record_rolled_back "$P/state" "sha-${MIG:0:12}"
  put_request "$ID1" check "sha-${MIG:0:12}"
  run_updater
  [ "$(result "$ID1" .state)" = refused ]
  [[ $(result "$ID1" .message) == "this version was rolled back"* ]]
  [ "$(jq -r .rolledBack "$RES/updater.json")" = "sha-${MIG:0:12}" ]
}

@test "the owner check follows the uid install.sh recorded" {
  stub_install
  echo 1001 >"$P/state/spool-uid"
  put_request "$ID1" check "sha-${MIG:0:12}"
  run_updater
  [[ $(result "$ID1" .message) == *"owned by uid 1000, not the backend's 1001"* ]]
}

@test "untrusted entries: junk names removed, links, fifos, foreign owners, big or bad files refused" {
  stub_install
  : >"$P/secret"
  ln -s "$P/secret" "$REQ/$ID1.json"
  mkfifo "$REQ/$ID2.json"
  printf 'x' >"$REQ/notes.txt"
  ln -s /etc "$REQ/link"
  mkdir "$REQ/dir.json"
  ID3=33333333-3333-4333-8333-333333333333 ID4=44444444-4444-4444-8444-444444444444
  ID5=55555555-5555-4555-8555-555555555555 ID6=66666666-6666-4666-8666-666666666666
  request "$ID3" check "sha-${MIG:0:12}" >"$REQ/$ID3.json"
  head -c 5000 /dev/zero | tr '\0' ' ' >"$REQ/$ID4.json"
  chown 1000:1000 "$REQ/$ID4.json"
  request "$ID1" check "sha-${MIG:0:12}" >"$REQ/$ID5.json"
  chown 1000:1000 "$REQ/$ID5.json"
  printf '{"id":"%s","action":"update"}' "$ID6" >"$REQ/$ID6.json"
  chown 1000:1000 "$REQ/$ID6.json"
  run_updater
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$REQ")" ]
  [ -z "$(ls -A "$P/state/updater/incoming")" ]
  [ -f "$P/secret" ] && [ -d /etc ]
  [[ $(result "$ID1" .message) == *"not a regular file (symbolic link)"* ]]
  [[ $(result "$ID2" .message) == *"not a regular file (fifo)"* ]]
  [[ $(result "$ID3" .message) == *"owned by uid 0"* ]]
  [[ $(result "$ID4" .message) == *"size 5000 "* ]]
  [[ $(result "$ID5" .message) == *"not a valid request"* ]]
  [ "$(result "$ID6" .action)" = update ]
  [ "$(result "$ID6" .target)" = null ]
  for id in "$ID1" "$ID2" "$ID3" "$ID4" "$ID5" "$ID6"; do [ "$(result "$id" .state)" = refused ]; done
  [ ! -e "$UPDATE_LOG" ]
}

@test "a *.tmp being written is left alone, an old one removed" {
  stub_install
  printf '{' >"$REQ/$ID1.tmp"
  printf '{' >"$REQ/$ID2.tmp"
  touch -d "@$(($(date +%s) - 600))" "$REQ/$ID2.tmp"
  run_updater
  [ -e "$REQ/$ID1.tmp" ]
  [ ! -e "$REQ/$ID2.tmp" ]
}

@test "one check and one update per run, the rest refused" {
  stub_install
  put_request "$ID1" check "sha-${MIG:0:12}"
  touch -d "@$(($(date +%s) - 60))" "$REQ/$ID1.json"
  put_request "$ID2" check "sha-${MIG:0:12}"
  run_updater
  [ "$(result "$ID1" .state)" = ready ]
  [ "$(result "$ID2" .state)" = refused ]
  [ "$(result "$ID2" .message)" = "one check per run; ask again" ]
}

@test "an update while an update or restore holds its lock is refused" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  exec 8>"$P/state/update.lock"
  flock -n 8
  run_updater
  exec 8>&-
  [ "$(result "$ID1" .state)" = refused ]
  [ "$(result "$ID1" .message)" = "an update, rollback or restore is running now" ]
  [ ! -e "$UPDATE_LOG" ]
}

@test "an update blocked by the preflight never runs update.sh" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  STUB_MANIFEST=missing run_updater
  [ "$(result "$ID1" .state)" = blocked ]
  [ "$(result "$ID1" '.preflight.problems | length')" -ge 1 ]
  [ ! -e "$UPDATE_LOG" ]
}

@test "a successful update: update.sh with the target, next steps and the log tail in the result" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  run_updater
  [ "$(cat "$UPDATE_LOG")" = "sha-${MIG:0:12} --prefix $P" ]
  [ "$(result "$ID1" .state)" = succeeded ]
  [ "$(result "$ID1" .exitCode)" = 0 ]
  [ "$(result "$ID1" .autoRollback)" = false ]
  [ "$(result "$ID1" '.next | join("|")')" = "mail node: its host scripts changed" ]
  [ "$(result "$ID1" '.log | map(select(startswith("[mailexpert] backup"))) | length')" = 1 ]
  [ "$(result "$ID1" .logFile)" = "$P/state/updater/$ID1.log" ]
  [ "$(jq -r .version "$RES/updater.json")" = "sha-${MIG:0:12}" ]
  [ "$(stat -c %a "$P/state/updater/$ID1.log")" = 600 ]
  ! grep -rq do-not-print-me "$RES"
}

@test "an exit code update.sh never uses (a signal): failed, no rollback" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  STUB_APPLIED=$'0001_a\n0002_b' STUB_UPDATE=137 run_updater
  [ "$(result "$ID1" .autoRollback)" = true ]
  [ "$(result "$ID1" .state)" = failed ]
  [ "$(result "$ID1" .exitCode)" = 137 ]
  [[ $(result "$ID1" .message) == *"the state of the panel is unknown"* ]]
  [ ! -e "$INSTALL_LOG" ]
}

@test "exit 3 of update.sh: failed, nothing rolled back" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  STUB_UPDATE=3 run_updater
  [ "$(result "$ID1" .state)" = failed ]
  [ "$(result "$ID1" .exitCode)" = 3 ]
  [[ $(result "$ID1" .message) == *"nothing was changed"* ]]
  [ ! -e "$INSTALL_LOG" ]
}

@test "exit 1 without migrations: automatic rollback with install.sh --version <old>" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  # No pending migration: the database already has 0002_b.
  STUB_APPLIED=$'0001_a\n0002_b' STUB_UPDATE=1 run_updater
  [ "$(result "$ID1" .autoRollback)" = true ]
  [ "$(result "$ID1" .state)" = rolled_back ]
  [ "$(result "$ID1" .exitCode)" = 1 ]
  [ "$(cat "$INSTALL_LOG")" = "--prefix $P --version sha-${NEW:0:12}" ]
  # The version left is not offered again until a newer build is promoted.
  [ "$(cat "$P/state/rolled-back-version")" = "sha-${MIG:0:12}" ]
  [ "$(jq -r .rolledBack "$RES/updater.json")" = "sha-${MIG:0:12}" ]
  [ "$(jq -r .version "$RES/updater.json")" = "sha-${NEW:0:12}" ]
}

@test "exit 1 when migrations were pending, or the count changed: stop, no rollback" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  STUB_UPDATE=1 run_updater
  [ "$(result "$ID1" .autoRollback)" = false ]
  [ "$(result "$ID1" .state)" = failed ]
  [[ $(result "$ID1" .message) == *"rollback.sh --to sha-${NEW:0:12}"* ]]
  [ ! -e "$INSTALL_LOG" ]
  put_request "$ID2" update "sha-${MIG:0:12}"
  STUB_APPLIED=$'0001_a\n0002_b' STUB_COUNT_AFTER=3 STUB_UPDATE=1 run_updater
  [ "$(result "$ID2" .autoRollback)" = true ]
  [ "$(result "$ID2" .state)" = failed ]
  [ ! -e "$INSTALL_LOG" ]
}

@test "a failed automatic rollback says so" {
  stub_install
  put_request "$ID1" update "sha-${MIG:0:12}"
  STUB_APPLIED=$'0001_a\n0002_b' STUB_UPDATE=1 STUB_INSTALL=1 run_updater
  [ "$(result "$ID1" .state)" = rollback_failed ]
}

@test "results beyond the newest 20 are pruned" {
  stub_install
  for i in $(seq 1 25); do
    id=$(printf 'aaaaaaaa-aaaa-4aaa-8aaa-%012d' "$i")
    printf '{"id":"%s","state":"ready"}' "$id" >"$RES/$id.json"
    touch -d "@$(($(date +%s) - (30 - i) * 60))" "$RES/$id.json"
  done
  run_updater
  [ "$(find "$RES" -name '*-*.json' | wc -l)" -eq 20 ]
  [ ! -e "$RES/aaaaaaaa-aaaa-4aaa-8aaa-000000000001.json" ]
  [ -e "$RES/updater.json" ]
}

# --- the channel latest (lib/channel.sh) ---

@test "manifest_digests reads an image and a multi-platform index" {
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/channel.sh"
  [ "$(manifest_digests <<<'{"Descriptor":{"digest":"sha256:a"}}')" = sha256:a ]
  [ "$(manifest_digests <<<'[{"Descriptor":{"digest":"sha256:b"}},{"Descriptor":{"digest":"sha256:a"}}]')" = sha256:a,sha256:b ]
}

@test "status.sh --target latest resolves the tag; without one it is a problem" {
  stub_install
  git -C "$P/app" tag -d latest >/dev/null
  run --separate-stderr bash "$DEPLOY_DIR/status.sh" --prefix "$P" --target latest --json
  [ "$status" -eq 1 ]
  [ "$(jq -r '.target.channel' <<<"$output")" = latest ]
  [ "$(jq -r '.problems | map(select(startswith("target: the channel latest cannot be resolved"))) | length' <<<"$output")" = 1 ]
  git -C "$P/app" tag -f latest "$MIG" >/dev/null
  run --separate-stderr bash "$DEPLOY_DIR/status.sh" --prefix "$P" --target latest --json
  [ "$status" -eq 0 ]
  [ "$(jq -r '.target.version' <<<"$output")" = "sha-${MIG:0:12}" ]
  [ "$(jq -r '.target.channel' <<<"$output")" = latest ]
}

@test "update.sh refuses latest when the registry's latest images are another commit's" {
  stub_install
  git -C "$P/app" tag -f latest "$MIG" >/dev/null
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
case " $* " in
  *" manifest inspect -v "*":latest "*) echo '{"Descriptor":{"digest":"sha256:old"}}' ;;
  *" manifest inspect -v "*) echo '{"Descriptor":{"digest":"sha256:new"}}' ;;
  *" image inspect "*) exit 1 ;;
esac
exit 0
STUB_EOF
  run bash "$DEPLOY_DIR/update.sh" latest --prefix "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"the registry's latest images are not the images of sha-${MIG:0:12}"* ]]
  [[ $output == *"cannot resolve the channel latest"* ]]
}
