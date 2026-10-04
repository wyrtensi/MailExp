#!/usr/bin/env bash
# Backup, restore, update and rollback scenario of the deploy e2e test. Runs inside the throwaway
# Docker-in-Docker container started by e2e.sh and must never run on a host with real data.
# Server A is the compose project me-e2e-a in /e2e/a; server B, installed once A is frozen, is
# me-e2e-b in /e2e/b; rclone's S3 server in the project me-e2e-s3 stands in for the S3 provider.
# Everything it creates is removed at exit.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
# A failure inside a `$(...)` command substitution (derive_version's git calls, run as
# `V_OK=$(derive_version ...)`) would otherwise only abort the script if it were the
# substitution's last command; inherit_errexit makes -e apply inside command substitutions too,
# so a failing git call there stops the whole run instead of being silently swallowed.
shopt -s inherit_errexit

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$TEST_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=../lib/env.sh
. "$DEPLOY_DIR/lib/env.sh"
# shellcheck source=../lib/config.sh
. "$DEPLOY_DIR/lib/config.sh"
# shellcheck source=../lib/app.sh
. "$DEPLOY_DIR/lib/app.sh"
# shellcheck source=../lib/backup.sh
. "$DEPLOY_DIR/lib/backup.sh"
# shellcheck source=../lib/ops.sh
. "$DEPLOY_DIR/lib/ops.sh"
# shellcheck source=e2e-lib.sh
. "$TEST_DIR/e2e-lib.sh"

A_PROJECT=me-e2e-a B_PROJECT=me-e2e-b S3_PROJECT=me-e2e-s3
A=/e2e/a B=/e2e/b ORIGIN=/e2e/origin.git WORK=/e2e/work STAGE=/e2e/stage
A_PORT=18081 B_PORT=18082 S3_PORT=19000
BUCKET=me-e2e-backups
VERSION='' IMAGE_PREFIX='' REPO_URL='' S3_IMAGE=''

while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=$2 && shift 2 ;;
    --image-prefix) IMAGE_PREFIX=$2 && shift 2 ;;
    --repo-url) REPO_URL=$2 && shift 2 ;;
    --s3-image) S3_IMAGE=$2 && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
if [ -z "$VERSION" ] || [ -z "$IMAGE_PREFIX" ] || [ -z "$REPO_URL" ] || [ -z "$S3_IMAGE" ]; then
  die "--version, --image-prefix, --repo-url and --s3-image are required" 2
fi

for p in "$A_PROJECT" "$B_PROJECT" "$S3_PROJECT"; do
  case $p in mailexpert | edge) fail "refusing to run as project $p" ;; esac
  [ -z "$(labelled ps "$p")$(labelled volume "$p")" ] || fail "project $p already has containers or volumes"
done
for d in "$A" "$B" "$ORIGIN" "$WORK" "$STAGE"; do
  [ ! -e "$d" ] || fail "$d already exists"
done

teardown() {
  local status=$? p
  docker ps -aq --filter label=mailexpert.verify | xargs -r docker rm -fv >/dev/null
  for p in "$A_PROJECT" "$B_PROJECT" "$S3_PROJECT"; do remove_project "$p"; done
  rm -rf "$A" "$B" "$ORIGIN" "$WORK" "$STAGE"
  exit "$status"
}
trap teardown EXIT

# deploy <script> <args...>: a deploy script of the commit under test.
deploy() {
  local script=$1
  shift
  bash "$DEPLOY_DIR/$script" "$@"
}

# on <prefix> <command...>: a command with that install loaded (paths, compose), in a subshell.
on() {
  local prefix=$1
  shift
  (
    load_install "$prefix"
    "$@"
  )
}

# expect_exit <code> <command...>: runs a command (a deploy script: its own process, so its own
# errexit), shows its output, keeps it in OUT and fails unless the exit code is <code>.
expect_exit() {
  local want=$1 code=0
  shift
  OUT=$("$@" 2>&1) || code=$?
  printf '%s\n' "$OUT"
  [ "$code" = "$want" ] || fail "${2:-$1} exited $code, expected $want"
}

# credential <prefix> encrypt|check: e2e-credential.mjs in the backend image of that panel.
credential() {
  on "$1" app_compose run --rm --no-deps -T -e E2E_PLAIN -e E2E_EMAIL \
    -v "$TEST_DIR/e2e-credential.mjs:/app/e2e-credential.mjs:ro" --entrypoint node backend \
    e2e-credential.mjs "$2" 2>/dev/null | tail -n 1
}

# snapshots_here [restic filter...]: the snapshots of that server's restic host as JSON (inside
# `on`).
snapshots_here() {
  load_restic_env
  load_restic_host mailexpert
  restic_run -- snapshots --json --host "$RESTIC_HOST" "$@"
}

backup_keys() {
  printf 'RESTIC_REPOSITORY=s3:http://127.0.0.1:%s/%s\nRESTIC_PASSWORD=%s\nAWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' \
    "$S3_PORT" "$BUCKET" "$RESTIC_PW" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
}

export S3_ACCESS_KEY=e2e-s3-user S3_SECRET_KEY E2E_EMAIL=box@example.test E2E_PLAIN
S3_SECRET_KEY=$(gen_hex 16)
E2E_PLAIN=e2e-mailbox-password-$(gen_hex 4)
RESTIC_PW=$(gen_hex 24)

# 1. rclone's S3 server stands in for S3 (restic creates the bucket); a bare origin repository
# lets the update stages add commits. `$REPO_URL` is a bundle of the host checkout's HEAD, which
# may itself be a shallow clone (locally, or from a CI checkout with a shallow default) — cloning
# it leaves `$ORIGIN` with a detached HEAD and no branch, so a later `git push` out of it has
# nothing to negotiate against and walks the full (possibly incomplete, beyond the shallow
# boundary) history instead of just the new commits. Giving it a real branch at that same commit
# makes every later push self-contained: negotiation only ever needs objects at or after this
# tip, never anything from the host clone's own ancestry.
docker run -d --name me-e2e-s3 --label "com.docker.compose.project=$S3_PROJECT" -p "127.0.0.1:$S3_PORT:9000" \
  "$S3_IMAGE" serve s3 /data --addr :9000 --auth-key "$S3_ACCESS_KEY,$S3_SECRET_KEY" >/dev/null
# Any HTTP answer means it listens: an unsigned request gets an error status, not 200.
s3_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$S3_PORT/")" != 000 ]; }
for _ in $(seq 60); do
  if s3_up; then break; fi
  sleep 1
done
s3_up || fail "the S3 server did not start"
git clone --bare --quiet "$REPO_URL" "$ORIGIN"
HEAD_SHA=$(git -C "$ORIGIN" rev-parse HEAD)
[ "sha-${HEAD_SHA:0:12}" = "$VERSION" ] || fail "the bundle's HEAD is not $VERSION"
git -C "$ORIGIN" update-ref refs/heads/main "$HEAD_SHA"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
pass "the S3 server and the origin repository"

# 2. Server A without restic keys: the panel runs, install.sh warns that backups are off.
expect_exit 0 deploy install.sh --prefix "$A" --version "$VERSION" --image-prefix "$IMAGE_PREFIX" \
  --repo-url "$ORIGIN" --project "$A_PROJECT" --http-port "$A_PORT" --no-system --no-edge --local-auth \
  --signin direct --direct-host a.example.test
[[ $OUT == *"backups are off"* ]] || fail "no warning about missing backups"
pass "server A runs without backups and says so"

# 3. The restic keys through configure.sh; the next install.sh creates the repository. Without a
# terminal the recovery key is not printed; --show-recovery-key prints it on request.
out=$(backup_keys | deploy configure.sh --prefix "$A" 2>&1)
[[ $out != *"$RESTIC_PW"* && $out != *"$S3_SECRET_KEY"* ]] || fail "configure.sh printed a restic secret"
expect_exit 0 deploy install.sh --prefix "$A"
[[ $OUT == *"creating the restic repository"* ]] || fail "the repository was not created"
[[ $OUT == *"--show-recovery-key"* && $OUT != *"$RESTIC_PW"* ]] || fail "the recovery key without a terminal"
[ -f "$A/state/backup-since" ] || fail "state/backup-since is missing"
expect_exit 0 deploy backup.sh --prefix "$A" --show-recovery-key
[[ $OUT == *"RESTIC_PASSWORD=$RESTIC_PW"* ]] || fail "--show-recovery-key"
expect_exit 0 deploy install.sh --prefix "$A"
[[ $OUT == *"repository opens"* && $OUT != *"recovery key"* && $OUT != *"creating the restic repository"* ]] ||
  fail "a rerun: repository, recovery key or a re-init"
pass "repository created; recovery key shown on request, then never again; a rerun does not re-init"

# 3b. A wrong RESTIC_PASSWORD is reported without ever touching restic init: ensure_backup_repo
# treats restic's wrong-password exit code (12) specially and never creates a repository it
# cannot read the existing one of. A is running already, so it is a warning, not a failure: a
# rerun (or an update) never turns a running panel into a failed install over the repository.
cp -p "$A/.env" "$A/.env.keep"
env_set "$A/.env" RESTIC_PASSWORD "$(gen_hex 24)"
expect_exit 0 deploy install.sh --prefix "$A"
mv -f "$A/.env.keep" "$A/.env"
[[ $OUT == *"warning: backups: RESTIC_PASSWORD does not open"* ]] || fail "a wrong RESTIC_PASSWORD was not reported as a warning"
[[ $OUT != *"creating the restic repository"* ]] || fail "a wrong RESTIC_PASSWORD triggered init"
on "$A" panel_ready || fail "A is not ready after the rerun with a wrong RESTIC_PASSWORD"
pass "a wrong RESTIC_PASSWORD on a running server is a warning and leaves the repository alone"

# 4. Test data: a user and a mailbox whose password is encrypted with A's ENCRYPTION_KEY.
cipher=$(credential "$A" encrypt)
[[ $cipher == enc:v1:* ]] || fail "encrypt: $cipher"
on "$A" app_psql >/dev/null <<SQL
WITH owner AS (INSERT INTO users (username, is_admin) VALUES ('e2e-owner', true) RETURNING id)
INSERT INTO email_accounts (added_by, name, email_address, auth_user, auth_pass, enabled)
SELECT id, 'E2E box', '$E2E_EMAIL', '$E2E_EMAIL', '$cipher', false FROM owner;
SQL
[ "$(credential "$A" check)" = match ] || fail "the stored credential does not decrypt on A"
pass "test data: a mailbox with an encrypted password"

# 5. A manual backup: one snapshot, backup-last.json, nothing left in staging.
expect_exit 0 deploy backup.sh --prefix "$A" --tag manual
last=$(<"$A/state/backup-last.json")
[ "$(jq -r .tag <<<"$last")" = manual ] || fail "backup-last.json tag: $last"
[ "$(jq -r .counts.email_accounts <<<"$last")" = 1 ] || fail "backup-last.json counts: $last"
[ "$(jq -r .verified <<<"$last")" = false ] || fail "backup-last.json verified: $last"
[ "$(on "$A" snapshots_here --tag manual | jq length)" = 1 ] || fail "one manual snapshot expected"
[ ! -e "$A/backups/staging" ] || fail "staging was left behind"
pass "manual backup"

# 6. --verify: restore into a scratch database, no pending migration, the credential decrypts
# with the key from the snapshot; nothing printed but counts, nothing left behind.
expect_exit 0 deploy backup.sh --prefix "$A" --tag manual --verify
[[ $OUT == *"counts match"* && $OUT == *'"migrationsApplied":0'* && $OUT == *'"failed":0'* ]] || fail "verify output"
[[ $OUT != *"$E2E_PLAIN"* ]] || fail "verify printed a credential"
[ "$(jq -r .verified "$A/state/backup-last.json")" = true ] || fail "backup-last.json verified"
[ -z "$(docker ps -aq --filter label=mailexpert.verify)" ] || fail "the scratch database was left behind"
[ -z "$(find "$A/backups" -maxdepth 1 -name 'verify-*')" ] || fail "verify files were left behind"
pass "backup --verify"

# 7. The check fails when the key in the snapshot does not decrypt the data.
cp -p "$A/.env" "$A/.env.keep"
wrong=$(gen_hex 32)
env_set "$A/.env" ENCRYPTION_KEY "$wrong"
expect_exit 1 deploy backup.sh --prefix "$A" --tag e2e-bad-key --verify
mv -f "$A/.env.keep" "$A/.env"
[[ $OUT == *"failed the check"* ]] || fail "a key that does not decrypt was not detected"
pass "verify detects a key that does not decrypt the data"

# 8. The nightly backup (default tag): a restic check, or on Sunday a verify.
expect_exit 0 deploy backup.sh --prefix "$A"
[[ $OUT == *"restic check of 5% of the data passed"* || $OUT == *"counts match"* ]] || fail "nightly check"
[ "$(jq -r .tag "$A/state/backup-last.json")" = nightly ] || fail "nightly tag"
a_host=$(<"$A/state/restic-host")
[[ $a_host =~ ^mailexpert-[0-9a-f]{16}$ ]] || fail "A's restic host: $a_host"
[ "$(on "$A" snapshots_here | jq -r 'map(.hostname) | unique | join(" ")')" = "$a_host" ] || fail "A's snapshots are not under its own host"
pass "nightly backup, every snapshot of A under A's own restic host"

# 9. Health of A: healthy after its backups; a stale backup and a stopped service are problems
# the output names. The disk threshold is 0 here: CI runners' disks are often more than 85%
# full; disk_problem itself is covered by bats.
export MAILEXPERT_MIN_FREE_PCT=0
expect_exit 0 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *healthy* ]] || fail "health output"
cp -p "$A/state/backup-last.json" "$A/state/backup-last.keep"
stale=$(($(date +%s) - 27 * 3600))
jq -c --argjson t "$stale" '.finished_epoch = $t' "$A/state/backup-last.keep" >"$A/state/backup-last.json"
expect_exit 1 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *"problem: backup: the last successful backup is 27 hours old"* ]] || fail "a stale backup was not reported"
mv -f "$A/state/backup-last.keep" "$A/state/backup-last.json"
on "$A" app_compose stop redis >/dev/null 2>&1
expect_exit 1 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *"problem: containers: redis is exited"* && $OUT == *"problem: ready:"* ]] || fail "a stopped redis was not reported"
on "$A" app_compose start redis >/dev/null 2>&1
for _ in $(seq 60); do
  if on "$A" panel_ready; then break; fi
  sleep 2
done
expect_exit 0 deploy healthcheck.sh --prefix "$A"
pass "health check: healthy, stale backup, stopped service"

# 10. The move starts: A is frozen (backend and frontend stop) and makes the final backup. After it
# A is standby: its nightly backup and health check skip, so it neither pages the owner nor keeps
# writing snapshots of the frozen database next to the new server's. A's generated keys are noted
# only to compare after the move.
a_key=$(env_get "$A/.env" ENCRYPTION_KEY)
a_db=$(env_get "$A/.env" DB_PASSWORD)
a_vapid=$(env_get "$A/.env" VAPID_PUBLIC_KEY)
on "$A" app_compose stop backend frontend >/dev/null 2>&1
expect_exit 0 deploy backup.sh --prefix "$A" --tag move
[ -f "$A/state/standby" ] || fail "A is not standby after the move backup"
[[ $OUT == *"standby now"* && $OUT == *"install.sh --prefix $A"* ]] || fail "the move backup did not explain standby and its undo"
a_move=$(jq -r .snapshot "$A/state/backup-last.json")
expect_exit 0 deploy backup.sh --prefix "$A"
[[ $OUT == *"backup skipped"* ]] || fail "A's nightly backup ran after the move backup"
expect_exit 0 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *"standby server"* ]] || fail "A's health check ran after the move backup"
a_snapshots=$(on "$A" snapshots_here | jq -r 'map(.id) | sort | join(" ")')
pass "the move backup leaves A standby: its nightly backup and health check skip"

# 11. Server B, prepared for the move: the same version, --no-start. Standby: the timers' scripts
# skip it. Its generated keys differ from A's; configure.sh refuses A's ENCRYPTION_KEY and names
# restore.sh.
expect_exit 0 deploy install.sh --prefix "$B" --version "$VERSION" --image-prefix "$IMAGE_PREFIX" \
  --repo-url "$ORIGIN" --project "$B_PROJECT" --http-port "$B_PORT" --no-system --no-edge --local-auth \
  --signin direct --direct-host b.example.test --no-start
[ -f "$B/state/standby" ] || fail "install.sh --no-start did not mark B as standby"
[ -z "$(labelled ps "$B_PROJECT")" ] || fail "install.sh --no-start started containers"
[ "$(env_get "$B/.env" ENCRYPTION_KEY)" != "$a_key" ] || fail "B has A's key before the restore"
expect_exit 0 deploy healthcheck.sh --prefix "$B"
[[ $OUT == *"standby server"* ]] || fail "the health check did not skip a standby server"
expect_exit 0 deploy backup.sh --prefix "$B"
[[ $OUT == *"backup skipped"* ]] || fail "the backup did not skip a standby server"
out=$(backup_keys | deploy configure.sh --prefix "$B" 2>&1)
[[ $out != *"$RESTIC_PW"* ]] || fail "configure.sh printed RESTIC_PASSWORD"
set +e
out=$(printf 'ENCRYPTION_KEY=%s\n' "$a_key" | deploy configure.sh --prefix "$B" 2>&1)
code=$?
set -e
if [ "$code" != 2 ] || [[ $out != *restore.sh* ]]; then fail "configure.sh with A's ENCRYPTION_KEY: exit $code"; fi
pass "server B prepared: standby, its own keys, configure.sh points to restore.sh"

# 12. The rehearsal: restore the latest snapshot without starting: the newest of any host, here
# A's move snapshot, and the output names its host. A host without snapshots is refused. A's
# generated keys replace B's; B keeps its project and port; the database and the credential check
# pass; the hint never points to install.sh (a started rehearsal would back up next to A).
b_host=$(<"$B/state/restic-host")
[ "$b_host" != "$a_host" ] || fail "B got A's restic host"
expect_exit 2 deploy restore.sh latest --prefix "$B" --host mailexpert-none --no-start
[[ $OUT == *"no snapshot latest of host mailexpert-none"* ]] || fail "restore.sh --host without snapshots"
expect_exit 0 deploy restore.sh latest --prefix "$B" --no-start
[[ $OUT == *"restoring snapshot ${a_move:0:8} of host $a_host"* ]] || fail "restore.sh did not pick and name A's move snapshot"
[[ $OUT == *"down -v"* && $OUT != *"install.sh --prefix"* ]] || fail "the rehearsal hint"
[ "$(env_get "$B/.env" ENCRYPTION_KEY)" = "$a_key" ] || fail "ENCRYPTION_KEY was not restored"
[ "$(env_get "$B/.env" DB_PASSWORD)" = "$a_db" ] || fail "DB_PASSWORD was not restored"
[ "$(env_get "$B/.env" VAPID_PUBLIC_KEY)" = "$a_vapid" ] || fail "the VAPID keys were not restored"
[ "$(env_get "$B/.env" COMPOSE_PROJECT_NAME)" = "$B_PROJECT" ] || fail "COMPOSE_PROJECT_NAME changed"
[ "$(env_get "$B/.env" APP_HTTP_PORT)" = "$B_PORT" ] || fail "APP_HTTP_PORT changed"
[ "$(stat -c %a "$B/.env.pre-restore")" = 600 ] || fail ".env.pre-restore"
[[ $OUT == *'"failed":0'* && $OUT != *"$E2E_PLAIN"* && $OUT != *"$a_key"* ]] || fail "restore output"
[ -f "$B/state/standby" ] || fail "B left standby before it started"
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$B_PROJECT" --filter label=com.docker.compose.service=backend)" ] ||
  fail "the backend runs after --no-start"
[ ! -e "$B/state/restore" ] || fail "restored files were left behind"
pass "restore --no-start (rehearsal)"

# 13. Going live: install.sh starts B; the mailbox password decrypts with the restored key.
expect_exit 0 deploy install.sh --prefix "$B"
[ ! -f "$B/state/standby" ] || fail "B is still standby"
[ "$(curl -fsS "http://127.0.0.1:$B_PORT/api/health/ready" | jq -r .status)" = ready ] || fail "B is not ready"
[ "$(credential "$B" check)" = match ] || fail "the credential does not decrypt on B"
[ "$(on "$B" app_psql <<<"SELECT count(*) FROM users WHERE username = 'e2e-owner';")" = 1 ] || fail "the user did not move"
pass "B runs with A's data and keys"

# 14. B backs up into the same repository under its own host and its verify passes; its retention
# leaves every snapshot of A in place (one shared host would have kept only the newest of the
# day); a second restore is refused and changes nothing. Server A is wiped afterwards.
expect_exit 0 deploy backup.sh --prefix "$B" --tag manual --verify
[ "$(on "$B" snapshots_here | jq -r 'map(.hostname) | unique | join(" ")')" = "$b_host" ] || fail "B's snapshot is not under B's host"
[ "$(on "$A" snapshots_here | jq -r 'map(.id) | sort | join(" ")')" = "$a_snapshots" ] || fail "B's retention removed snapshots of A"
expect_exit 0 deploy backup.sh --prefix "$B" --tag manual
[ "$(on "$A" snapshots_here | jq -r 'map(.id) | sort | join(" ")')" = "$a_snapshots" ] || fail "B's second backup removed snapshots of A"
remove_project "$A_PROJECT"
rm -rf "$A"
expect_exit 2 deploy restore.sh latest --prefix "$B"
[[ $OUT == *"_postgres_data exists"* ]] || fail "restore.sh did not refuse a server with a database"
[ "$(credential "$B" check)" = match ] || fail "the refused restore changed B"
pass "B backs up; restore.sh refuses a server with a database"

# 15. Versions to update to: commits on top of HEAD in the origin repository, and images for them
# (HEAD's backend image plus the migration and its own BUILD_SHA; HEAD's frontend retagged).
# ok: one new migration that works; fail: one that fails inside its transaction.
mkdir -p "$STAGE"
printf 'CREATE TABLE e2e_update_marker (id integer);
' >"$STAGE/9998_e2e_update_marker.sql"
printf 'SELECT 1 / 0;
' >"$STAGE/9999_e2e_update_fails.sql"
git clone --quiet "$ORIGIN" "$WORK"

# derive_version <name> <migration file...>: prints the sha-<12> tag of the new version.
derive_version() {
  local name=$1 sha tag cid f
  shift
  git -C "$WORK" checkout --quiet --detach "$HEAD_SHA"
  for f in "$@"; do
    cp "$f" "$WORK/backend/migrations/"
    git -C "$WORK" add "backend/migrations/${f##*/}"
  done
  git -C "$WORK" -c user.name=e2e -c user.email=e2e@example.test commit --quiet --allow-empty -m "e2e: $name"
  sha=$(git -C "$WORK" rev-parse HEAD)
  git -C "$WORK" push --quiet origin "HEAD:refs/heads/e2e-$name" || fail "derive_version $name: push to e2e-$name failed"
  tag=sha-${sha:0:12}
  cid=$(docker create "$IMAGE_PREFIX/mailexpert-backend:$VERSION")
  for f in "$@"; do docker cp "$f" "$cid:/app/migrations/${f##*/}"; done
  docker commit --change "ENV BUILD_SHA=$sha" "$cid" "$IMAGE_PREFIX/mailexpert-backend:$tag" >/dev/null
  docker rm "$cid" >/dev/null
  docker tag "$IMAGE_PREFIX/mailexpert-frontend:$VERSION" "$IMAGE_PREFIX/mailexpert-frontend:$tag"
  printf '%s
' "$tag"
}
V_OK=$(derive_version ok "$STAGE/9998_e2e_update_marker.sql")
V_FAIL=$(derive_version fail "$STAGE/9999_e2e_update_fails.sql")
base=$(on "$B" migration_count)
running_sha() { curl -fsS "http://127.0.0.1:$B_PORT/api/version" | jq -r .sha; }
pass "versions ok ($V_OK) and fail ($V_FAIL)"

# 16. Update to ok: a pre-update backup (local dump and snapshot), the new migration, ready.
expect_exit 0 deploy update.sh "$V_OK" --prefix "$B"
sha=$(running_sha)
[ "sha-${sha:0:12}" = "$V_OK" ] || fail "B runs $sha after the update"
[ "$(on "$B" migration_count)" = $((base + 1)) ] || fail "the new migration was not applied"
[ -f "$B/backups/pre-update-$VERSION.dump" ] || fail "no local pre-update dump"
[ "$(on "$B" snapshots_here --tag pre-update | jq length)" = 1 ] || fail "no pre-update snapshot"
[ "$(credential "$B" check)" = match ] || fail "the credential after the update"
pass "update to a version with a new migration"

# 17. Update to fail: it never becomes ready; update.sh leaves it as it is, keeps the pre-update
# dump and prints the way back. A shorter wait keeps the test fast.
export MAILEXPERT_READY_TIMEOUT=90
expect_exit 1 deploy update.sh "$V_FAIL" --prefix "$B"
[[ $OUT == *"did not become ready"* && $OUT == *"pre-update-$V_OK.dump"* && $OUT == *"--version $V_OK"* ]] ||
  fail "no way back printed after a failed update"
[ -f "$B/backups/pre-update-$V_OK.dump" ] || fail "no pre-update dump before the failed update"
pass "a failed update is left as it is and prints the way back"

pass "backup e2e passed"
