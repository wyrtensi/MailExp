#!/usr/bin/env bats
# The mail node's backup and restore (node-backup.sh, node-restore.sh, setup.sh --backup-keys), with
# docker, restic (inside the docker mock), git, curl and systemctl mocked and mailcow's
# backup_and_restore.sh replaced by a fixture that keeps its layout and its questions: what goes
# into the snapshot, how a broken dump or upload fails, the weekly verification, the state file and
# pings, the move, and a restore onto a fresh node.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  load mail-node/helper
  mail_node_setup
  node_backup_setup
  BACKUP=$NODE_SCRIPTS/node-backup.sh
  RESTORE=$NODE_SCRIPTS/node-restore.sh
  SETUP=$NODE_SCRIPTS/setup.sh
}

configured() {
  write_node_env
  write_backup_keys
}

vmail() { printf '%s\n' "$MOCK_DIR/volumes/mailcowdockerized_vmail-vol-1"; }

# --- Decisions without Docker -------------------------------------------------------------------

@test "compose_project: COMPOSE_PROJECT_NAME cleaned as mailcow's script does" {
  [ "$(compose_project "$MC/mailcow.conf")" = mailcowdockerized ]
  printf 'COMPOSE_PROJECT_NAME=mail cow.x\n' >"$BATS_TEST_TMPDIR/c.conf"
  [ "$(compose_project "$BATS_TEST_TMPDIR/c.conf")" = mailcowx ]
  printf 'MAILCOW_HOSTNAME=mail.example.com\n' >"$BATS_TEST_TMPDIR/c.conf"
  run compose_project "$BATS_TEST_TMPDIR/c.conf"
  [ "$status" -eq 1 ]
  [ "$(mailcow_volume mailcowdockerized vmail)" = mailcowdockerized_vmail-vol-1 ]
}

@test "node_backup_checks: nightly verifies on Sundays only, other tags on request" {
  [ "$(node_backup_checks 7 nightly 0)" = verify ]
  [ "$(node_backup_checks 1 nightly 0)" = none ]
  [ "$(node_backup_checks 6 nightly 0)" = none ]
  [ "$(node_backup_checks 7 manual 0)" = none ]
  [ "$(node_backup_checks 3 manual 1)" = verify ]
  [ "$(node_backup_checks 3 move 0)" = none ]
}

@test "dump_problems: every archive, mailcow.conf and the architecture marker" {
  D=$BATS_TEST_TMPDIR/dump
  mkdir -p "$D"
  for f in mailcow.conf "${MAILCOW_ARCHIVES[@]}"; do printf 'x\n' >"$D/$f"; done
  touch "$D/.x86_64"
  [ -z "$(dump_problems "$D")" ]
  rm "$D/backup_mariadb.tar.zst"
  : >"$D/backup_redis.tar.zst"
  rm "$D/.x86_64"
  run dump_problems "$D"
  [ "$output" = "backup_redis.tar.zst is empty
backup_mariadb.tar.zst is missing
the architecture marker (.x86_64 or .aarch64) is missing" ]
}

@test "free space: twice the database plus the other volumes, with a margin" {
  [ "$(dump_need_kb 1000 500)" = 2750 ]
  [ -z "$(space_problem 2750 2750 /var/backups/x)" ]
  [ "$(space_problem 204800 102400 /var/backups/x)" = "not enough free space for mailcow's dump in /var/backups/x: about 200 MB needed, 100 MB free" ]
}

@test "the keys setup.sh --backup-keys takes, and their values" {
  for good in 5% 0.5% 100% 1/12 3/3; do read_subset_ok "$good"; done
  for bad in 0% 101% 5 x% 0/3 4/3 /2 '5 %'; do
    run read_subset_ok "$bad"
    [ "$status" -eq 1 ]
  done
  [ -z "$(node_backup_key_problem RESTIC_REPOSITORY s3:https://s3.example.com/b/node)" ]
  [ -n "$(node_backup_key_problem RESTIC_REPOSITORY /srv/restic)" ]
  [ -n "$(node_backup_key_problem RESTIC_PASSWORD short)" ]
  [ -n "$(node_backup_key_problem NODE_BACKUP_PING_URL http://hc.example.com/x)" ]
  [ -z "$(node_backup_key_problem NODE_BACKUP_PUSH_TIMEOUT 86400)" ]
  [ -n "$(node_backup_key_problem NODE_BACKUP_PUSH_TIMEOUT 5)" ]
  [[ $(node_backup_key_problem EOP_HOST x) == *"not a node backup key"* ]]
}

@test "parse_backup_keys: accepted lines out, problems named without values, the password kept once stored" {
  write_node_env
  run parse_backup_keys "$MAILEXPERT_NODE_CONF" "$BATS_TEST_TMPDIR/out" < <(printf '%s\n' '# comment' \
    RESTIC_REPOSITORY=s3:https://s3.example.com/b/node RESTIC_PASSWORD=correct-horse-battery-staple $'AWS_ACCESS_KEY_ID=AKIA\r')
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/out")" = $'RESTIC_REPOSITORY=s3:https://s3.example.com/b/node\nRESTIC_PASSWORD=correct-horse-battery-staple\nAWS_ACCESS_KEY_ID=AKIA' ]
  run parse_backup_keys "$MAILEXPERT_NODE_CONF" "$BATS_TEST_TMPDIR/out" < <(printf '%s\n' 'not a pair secret-value' RESTIC_PASSWORD=short-secret EOP_HOST=x)
  [ "$status" -eq 2 ]
  [[ $output == *"line 1 is not KEY=VALUE"* && $output == *"RESTIC_PASSWORD: must be at least 16"* && $output == *"EOP_HOST: is not a node backup key"* ]]
  [[ $output != *secret-value* && $output != *short-secret* ]]
  write_backup_keys
  run parse_backup_keys "$MAILEXPERT_NODE_CONF" "$BATS_TEST_TMPDIR/out" <<<'RESTIC_PASSWORD=another-long-password-here'
  [ "$status" -eq 2 ]
  [[ $output == *"already has a different one"* && $output != *another-long* ]]
  run parse_backup_keys "$MAILEXPERT_NODE_CONF" "$BATS_TEST_TMPDIR/out" <<<'RESTIC_PASSWORD=correct-horse-battery-staple'
  [ "$status" -eq 0 ]
}

@test "mailbox_children: the directories under a path, recursive listing or not, mailcow's own skipped" {
  run mailbox_children /vmail <<'EOF'
{"message_type":"snapshot","struct_type":"snapshot"}
{"message_type":"node","struct_type":"node","type":"dir","path":"/vmail/example.org"}
{"message_type":"node","struct_type":"node","type":"dir","path":"/vmail/example.com"}
{"message_type":"node","struct_type":"node","type":"dir","path":"/vmail/example.com/alice"}
{"message_type":"node","struct_type":"node","type":"dir","path":"/vmail/_garbage"}
{"message_type":"node","struct_type":"node","type":"file","path":"/vmail/.lock"}
{"struct_type":"node","type":"dir","path":"/vmail/old-format.net"}
EOF
  [ "$output" = $'example.com\nexample.org\nold-format.net' ]
  [ "$(pick_rotating 0 a b c)" = a ]
  [ "$(pick_rotating 08 a b c)" = c ]
  [ "$(pick_rotating 53 a b)" = b ]
  run pick_rotating 1
  [ "$status" -eq 1 ]
}

@test "mailcow_restore_prompts_ok: the questions node-restore.sh answers, and nothing else" {
  mailcow_restore_prompts_ok "$MC/helper-scripts/backup_and_restore.sh"
  sed 's/Select a dataset to restore/Pick the data/' "$MC/helper-scripts/backup_and_restore.sh" >"$BATS_TEST_TMPDIR/other"
  run mailcow_restore_prompts_ok "$BATS_TEST_TMPDIR/other"
  [ "$status" -eq 1 ]
  { cat "$MC/helper-scripts/backup_and_restore.sh"; echo 'read -p "Really? " x'; } >"$BATS_TEST_TMPDIR/other"
  run mailcow_restore_prompts_ok "$BATS_TEST_TMPDIR/other"
  [ "$status" -eq 1 ]
  run mailcow_restore_prompts_ok "$BATS_TEST_TMPDIR/missing"
  [ "$status" -eq 1 ]
}

@test "restore_log_problems: the lines of data sets not restored, colours removed" {
  printf '%s\n' '/crypt/x' $'\e[31mError: No backup file found for redis (searched for .tar.zst and .tar.gz)\e[0m' \
    'Could not determine SQL image version, skipping restore...' 'Restoring ... Error-free' >"$BATS_TEST_TMPDIR/log"
  run restore_log_problems "$BATS_TEST_TMPDIR/log"
  [ "$output" = $'Error: No backup file found for redis (searched for .tar.zst and .tar.gz)\nCould not determine SQL image version, skipping restore...' ]
}

@test "load_restic_host: the node's host carries its own prefix" {
  STATE_DIR=$BATS_TEST_TMPDIR/s
  mkdir -p "$STATE_DIR"
  load_restic_host "$NODE_RESTIC_HOST_PREFIX" 2>/dev/null
  [[ $RESTIC_HOST =~ ^mailexpert-node-[0-9a-f]{16}$ ]]
}

# --- node-backup.sh -----------------------------------------------------------------------------

@test "a backup: mailcow dumps all but vmail, one snapshot of the dump and the vmail volume, the local dump goes" {
  configured
  export MOCK_GIT_HEAD=0123456789abcdef0123456789abcdef01234567
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  calls | grep -q '^mailcow backup crypt redis rspamd postfix mysql$'
  # vmail by volume name, read-only, never through mailcow's tar.
  calls | grep -q -- '-v mailcowdockerized_vmail-vol-1:/vmail:ro'
  calls | lacks '^mailcow backup.*vmail'
  restic_calls | grep -qE '^backup --json --host mailexpert-node-[0-9a-f]{16} --tag mailcow --tag manual /backup /vmail$'
  restic_calls | grep -qE '^forget --host mailexpert-node-[0-9a-f]{16} --tag mailcow --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --keep-tag move$'
  restic_calls | lacks '^(check|restore)'
  SNAP=$(cat "$MOCK_DIR/repo/latest")
  [ -f "$SNAP/backup/backup_mariadb.tar.zst" ] && [ -f "$SNAP/backup/mailcow.conf" ]
  [ -f "$SNAP/backup/mailexpert/node.env" ] && [ -f "$SNAP/backup/mailexpert/ssl/cert.pem" ]
  [ "$(jq -r .mailcow_commit "$SNAP/backup/mailexpert/meta.json")" = "$MOCK_GIT_HEAD" ]
  [ -f "$SNAP/vmail/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S" ]
  [ ! -e "$MAILEXPERT_NODE_BACKUP_DIR/mailcow" ]
  STATE=$MAILEXPERT_NODE_STATE/backup-last.json
  [ "$(jq -r .tag "$STATE")" = manual ]
  [ "$(jq -r .verified "$STATE")" = false ]
  [ "$(jq -r .processed_bytes "$STATE")" = 4096 ]
  [ "$(jq -r .mailcow "$STATE")" = 2026-09 ]
  [[ $(jq -r .snapshot "$STATE") == "$(basename "$SNAP")" ]]
  [ "$(pings | sed -n 1p)" = 'https://hc.example.com/ping/node-backup/start ' ]
  pings | sed -n 2p | grep -q '^https://hc.example.com/ping/node-backup snapshot 00000001 (manual): 4096 bytes, 1024 new'
  [[ $output != *correct-horse* && $output != *example-secret* ]]
  run bash "$BACKUP" --status
  [ "$status" -eq 0 ]
}

@test "--verify: a read-back check, the dump and one mailbox restored into a temporary directory" {
  configured
  run bash "$BACKUP" --tag manual --verify
  [ "$status" -eq 0 ]
  restic_calls | grep -q '^check --read-data-subset=5%$'
  restic_calls | grep -qE '^restore 0+1c+ --target /restore --verify --include /backup --include /vmail/example.com/(alice|bob)$'
  [[ $output == *"one mailbox (1 files)"* ]]
  [ "$(jq -r .verified "$MAILEXPERT_NODE_STATE/backup-last.json")" = true ]
  [[ $(jq -r .restore_seconds "$MAILEXPERT_NODE_STATE/backup-last.json") =~ ^[0-9]+$ ]]
  [ -z "$(ls -A "$MAILEXPERT_NODE_BACKUP_DIR" | grep -v '^mailcow-backup.log$' || true)" ]
  pings | sed -n 2p | grep -q 'verified, restored in'
  printf 'NODE_BACKUP_READ_SUBSET=1/12\n' >>"$MAILEXPERT_NODE_CONF"
  run bash "$BACKUP" --tag manual --verify
  restic_calls | grep -q '^check --read-data-subset=1/12$'
}

@test "--verify fails when an archive does not read back or restic check finds a problem" {
  configured
  export MOCK_TAR_STATUS=2
  run bash "$BACKUP" --tag manual --verify
  [ "$status" -eq 1 ]
  [[ $output == *"one of mailcow's archives does not read back whole"* ]]
  pings | tail -n 1 | grep -q '^https://hc.example.com/ping/node-backup/fail '
  [ ! -e "$MAILEXPERT_NODE_STATE/backup-last.json" ]
  [ -z "$(ls -A "$MAILEXPERT_NODE_BACKUP_DIR" | grep -v '^mailcow-backup.log$' || true)" ]
  export MOCK_TAR_STATUS=0 MOCK_RESTIC_CHECK=1
  run bash "$BACKUP" --tag manual --verify
  [ "$status" -eq 1 ]
  [[ $output == *"restic check --read-data-subset=5% found a problem"* ]]
}

@test "an incomplete dump of mailcow stops the backup before anything is uploaded" {
  configured
  export MOCK_MAILCOW_DROP=mysql
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"mailcow's backup is incomplete (backup_mariadb.tar.zst is missing)"* ]]
  restic_calls | lacks '^backup'
  pings | tail -n 1 | grep -q '/fail '
  [ ! -e "$MAILEXPERT_NODE_BACKUP_DIR/mailcow" ]
}

@test "mailcow's script failing or running past its bound is named" {
  configured
  export MOCK_MAILCOW_STATUS=1
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"mailcow's backup failed (exit 1;"*"see $MAILEXPERT_NODE_BACKUP_DIR/mailcow-backup.log"* ]]
  unset MOCK_MAILCOW_STATUS
  printf 'NODE_BACKUP_DUMP_TIMEOUT=1\n' >>"$MAILEXPERT_NODE_CONF"
  printf '#!/usr/bin/env bash\nsleep 5\n' >"$MC/helper-scripts/backup_and_restore.sh"
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"ran past NODE_BACKUP_DUMP_TIMEOUT (1s)"* ]]
}

@test "the upload: a failure stops the run, unreadable files only warn" {
  configured
  export MOCK_RESTIC_BACKUP=1
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"restic backup failed (exit 1"* ]]
  [ ! -e "$MAILEXPERT_NODE_STATE/backup-last.json" ]
  export MOCK_RESTIC_BACKUP=3
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  [[ $output == *"the snapshot is saved without them"* ]]
  [ -f "$MAILEXPERT_NODE_STATE/backup-last.json" ]
}

@test "without the restic keys the run fails and says how to add them" {
  write_node_env
  printf 'NODE_BACKUP_PING_URL=https://hc.example.com/ping/node-backup\n' >>"$MAILEXPERT_NODE_CONF"
  run bash "$BACKUP"
  [ "$status" -eq 1 ]
  [[ $output == *"node backups are not configured: give setup.sh --backup-keys"* ]]
  pings | tail -n 1 | grep -q '/fail '
  run bash "$BACKUP" --status
  [ "$status" -eq 1 ]
  [[ $output == *"no successful backup recorded"* ]]
}

@test "--tag move: only with postfix and dovecot stopped, then the node is standby until setup.sh" {
  configured
  export MOCK_RUNNING='postfix-mailcow dovecot-mailcow'
  run bash "$BACKUP" --tag move
  [ "$status" -eq 1 ]
  [[ $output == *"--tag move: postfix-mailcow still runs"* ]]
  restic_calls | lacks '^backup'
  export MOCK_RUNNING=''
  run bash "$BACKUP" --tag move
  [ "$status" -eq 0 ]
  restic_calls | grep -q -- '--tag mailcow --tag move /backup /vmail$'
  [ -f "$MAILEXPERT_NODE_STATE/standby" ]
  : >"$MOCK_DIR/restic"
  run bash "$BACKUP"
  [ "$status" -eq 0 ]
  [[ $output == *"standby node"* ]]
  [ ! -s "$MOCK_DIR/restic" ]
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [ ! -e "$MAILEXPERT_NODE_STATE/standby" ]
}

@test "--show-recovery-key prints the repository and password on request only" {
  configured
  run bash "$BACKUP" --show-recovery-key
  [ "$status" -eq 0 ]
  [[ $output == *"RESTIC_PASSWORD=correct-horse-battery-staple"* ]]
  [ -f "$MAILEXPERT_NODE_STATE/recovery-key.shown" ]
}

# --- setup.sh --backup-keys ---------------------------------------------------------------------

@test "setup.sh --backup-keys: keys from stdin into node.env, the repository created, the nightly timer" {
  export MOCK_RESTIC_CAT=10
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --backup-keys < <(printf '%s\n' \
    RESTIC_REPOSITORY=s3:https://s3.example.com/node-backups/node RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key \
    NODE_BACKUP_PING_URL=https://hc.example.com/ping/node-backup)
  [ "$status" -eq 0 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" RESTIC_PASSWORD)" = correct-horse-battery-staple ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" PANEL_IPS)" = 203.0.113.10 ]
  restic_calls | grep -q '^init --repository-version 2$'
  [[ $(cat "$MAILEXPERT_NODE_STATE/restic-host") =~ ^mailexpert-node-[0-9a-f]{16}$ ]]
  [ -f "$MAILEXPERT_NODE_STATE/backup-since" ]
  [ -x "$MAILEXPERT_NODE_DIR/node-backup.sh" ] && [ -x "$MAILEXPERT_NODE_DIR/node-restore.sh" ]
  [ -f "$MAILEXPERT_NODE_DIR/backup-lib.sh" ] && [ -f "$MAILEXPERT_NODE_DIR/backup.sh" ]
  grep -q "^ExecStart=$MAILEXPERT_NODE_DIR/node-backup.sh$" "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.service"
  grep -q '^OnCalendar=\*-\*-\* 02:30:00$' "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.timer"
  calls | grep -q '^systemctl enable --now mailexpert-node-backup.timer$'
  # No terminal: the key is not printed, the command that shows it is.
  [[ $output == *"node-backup.sh --show-recovery-key"* ]]
  [[ $output != *correct-horse* && $output != *example-secret* ]]
  # Installed, the scripts find their libraries next to them.
  run bash "$MAILEXPERT_NODE_DIR/node-backup.sh" --tag manual
  [ "$status" -eq 0 ]
}

@test "setup.sh --backup-keys refuses bad keys and writes nothing" {
  write_node_env
  cp "$MAILEXPERT_NODE_CONF" "$BATS_TEST_TMPDIR/before"
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --backup-keys <<<'RESTIC_REPOSITORY=/srv/restic'
  [ "$status" -eq 2 ]
  cmp -s "$MAILEXPERT_NODE_CONF" "$BATS_TEST_TMPDIR/before"
  calls | lacks '^systemctl'
}

@test "setup.sh without the keys: no backup timer, a note how to turn backups on" {
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [ "$status" -eq 0 ]
  [[ $output == *"backups: off; give setup.sh --backup-keys"* ]]
  [ ! -e "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.timer" ]
  calls | lacks 'mailexpert-node-backup'
}

@test "setup.sh without systemd: the nightly backup is a cron file of its own" {
  configured
  export MAILEXPERT_NODE_INIT=cron
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [ "$status" -eq 0 ]
  grep -q "^30 2 \* \* \* root $MAILEXPERT_NODE_DIR/node-backup.sh$" "$MAILEXPERT_BACKUP_CRON_FILE"
  grep -q '^MAILTO=""$' "$MAILEXPERT_BACKUP_CRON_FILE"
}

# --- node-restore.sh ----------------------------------------------------------------------------

# fresh_node: what a new server has before the restore: mailcow cloned (compose file and its
# script), no mailcow.conf, no volumes, no node.env.
fresh_node() {
  rm -rf "$MOCK_DIR/volumes" "$MAILEXPERT_NODE_CONF" "$MC/mailcow.conf" "$MC/data" "$MAILEXPERT_NODE_STATE"
  : >"$MOCK_DIR/calls"
}

keys() {
  printf '%s\n' RESTIC_REPOSITORY=s3:https://s3.example.com/node-backups/node RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key
}

@test "a node backup restores onto a fresh node: files, vmail, mailcow's restore answered" {
  configured
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 0 ]
  [[ $output == *"restoring snapshot 00000001 of node mailexpert-node-"* ]]
  [ "$(env_get "$MC/mailcow.conf" MAILCOW_HOSTNAME)" = mail.example.com ]
  [ "$(readlink "$MC/.env")" = mailcow.conf ]
  [ -f "$MC/data/conf/postfix/extra.cf" ] && [ -f "$MC/data/assets/ssl/cert.pem" ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" PANEL_IPS)" = 203.0.113.10 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" MAILCOW_DIR)" = "$MC" ]
  [ -f "$(vmail)/example.com/bob/Maildir/cur/1700000001.M2.mail:2,S" ]
  restic_calls | grep -qE '^restore 0+1c+ --target /restore --include /vmail --overwrite if-changed --delete --verify$'
  calls | grep -q -- '-v mailcowdockerized_vmail-vol-1:/restore/vmail '
  [ -f "$MOCK_DIR/mailcow-restored/backup_postfix.tar.zst" ]
  [ "$(cut -d' ' -f2 "$MAILEXPERT_NODE_STATE/restored")" = 0 ]
  calls | grep -q '^mailcow restore answers: 1 0 y$'
  [ -f "$MOCK_DIR/mailcow-restored/backup_mariadb.tar.zst" ]
  # Dovecot stopped before the mail comes back, mailcow up again at the end.
  [ "$(calls | grep -n 'compose stop dovecot-mailcow' | cut -d: -f1)" -lt "$(calls | grep -n '^mailcow restore answers' | cut -d: -f1)" ]
  calls | tail -n 1 | grep -q 'compose up -d'
  [[ $output != *correct-horse* ]]
}

@test "a move restores twice: a rehearsal without the mail queue, then --update brings only the difference" {
  configured
  run bash "$BACKUP" --tag manual
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" --rehearsal < <(keys)
  [ "$status" -eq 0 ]
  [ ! -e "$MOCK_DIR/mailcow-restored/backup_postfix.tar.zst" ]
  [ -f "$MOCK_DIR/mailcow-restored/backup_mariadb.tar.zst" ]
  [[ $output == *"rehearsal: do not run setup.sh yet"* ]]
  # A plain restore on it is refused; an update is what it takes.
  run bash "$RESTORE" latest --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  [[ $output == *"bring it to a newer snapshot with --update"* ]]
  # The old node got mail and lost some before its move backup.
  rm "$(vmail)/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S"
  mkdir -p "$(vmail)/example.com/carol/Maildir/cur"
  printf 'Subject: three\n' >"$(vmail)/example.com/carol/Maildir/cur/1700000002.M3.mail:2,S"
  run bash "$BACKUP" --tag move
  [ "$status" -eq 0 ]
  # The rehearsal's copy still has the old state.
  printf 'Subject: one\n' >"$(vmail)/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S"
  rm -rf "$MOCK_DIR/mailcow-restored"
  run bash "$RESTORE" "$(basename "$(cat "$MOCK_DIR/repo/latest")")" --mailcow-dir "$MC" --update
  [ "$status" -eq 0 ]
  [ ! -e "$(vmail)/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S" ]
  [ -f "$(vmail)/example.com/carol/Maildir/cur/1700000002.M3.mail:2,S" ]
  [ -f "$MOCK_DIR/mailcow-restored/backup_postfix.tar.zst" ]
  [ "$(cut -c1-8 "$MAILEXPERT_NODE_STATE/restored")" = 00000002 ]
  run bash "$RESTORE" latest --rehearsal --update --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
}

@test "--update needs a server node-restore.sh restored" {
  configured
  run bash "$BACKUP" --tag manual
  run bash "$RESTORE" latest --mailcow-dir "$MC" --update
  [ "$status" -eq 2 ]
  [[ $output == *"has not restored this server before"* ]]
  calls | lacks 'compose (up|pull|stop)'
}

@test "node-restore.sh refuses a server that has mailcow data, and changes nothing" {
  configured
  run bash "$BACKUP" --tag manual
  : >"$MOCK_DIR/calls"
  run bash "$RESTORE" latest --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  [[ $output == *"mailcowdockerized_vmail-vol-1 exists already: this is not a fresh mailcow"* ]]
  calls | lacks 'compose (up|pull|stop)'
  calls | lacks '^mailcow restore'
}

@test "node-restore.sh refuses another mailcow version than the backup's" {
  configured
  export MOCK_GIT_HEAD=0123456789abcdef0123456789abcdef01234567
  run bash "$BACKUP" --tag manual
  fresh_node
  export MOCK_GIT_HEAD=fedcba9876543210fedcba9876543210fedcba98
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 2 ]
  [[ $output == *"the backup was made on 2026-09 (0123456789ab): git -C $MC checkout 0123456789abcdef0123456789abcdef01234567"* ]]
  [ ! -e "$MC/mailcow.conf" ]
}

@test "node-restore.sh stops when mailcow's restore reports a data set it did not restore" {
  configured
  run bash "$BACKUP" --tag manual
  fresh_node
  export MOCK_MAILCOW_RESTORE_ERROR='Error: No backup file found for redis (searched for .tar.zst and .tar.gz)'
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 1 ]
  [[ $output == *"mailcow's restore failed (exit 0: Error: No backup file found for redis"* ]]
  [ -f "$MAILEXPERT_NODE_BACKUP_DIR/mailcow-restore.log" ]
}

@test "node-restore.sh checks its input and the questions of mailcow's script first" {
  run bash "$RESTORE" --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  run bash "$RESTORE" 'latest; rm' --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  sed -i 's/Select a dataset to restore/Pick the data/' "$MC/helper-scripts/backup_and_restore.sh"
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 2 ]
  [[ $output == *"does not ask the questions node-restore.sh answers"* ]]
  run bash "$RESTORE" latest --mailcow-dir "$BATS_TEST_TMPDIR/nowhere" < <(keys)
  [ "$status" -eq 2 ]
  [[ $output == *"has no docker-compose.yml"* ]]
}
