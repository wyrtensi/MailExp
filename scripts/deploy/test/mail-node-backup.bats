#!/usr/bin/env bats
# The mail node's backup and restore (node-backup.sh, node-restore.sh, setup.sh --backup-keys and
# --end-standby, eop-ranges.sh on a standby node), with docker, restic (inside the docker mock), git,
# curl and systemctl mocked and mailcow's backup_and_restore.sh replaced by a fixture that keeps its
# layout and its questions: what goes into the snapshot, how a broken dump or upload fails, the
# weekly verification, bounds and leftovers, the state file and pings, the move and its standby, and
# restores onto a fresh node, rehearsals, updates and retries.

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
marker() { env_get "$MAILEXPERT_NODE_STATE/restored" "$1"; }
latest_id() { basename "$(cat "$MOCK_DIR/repo/latest")"; }

# repo_copy <snapshot id> <new id prefix of 8 hex> <host> <tag...>: a copy of a snapshot under
# another host or tags (another node's, a later one).
repo_copy() {
  local from=$1 id=$2$(printf 'c%.0s' $(seq 56)) host=$3
  shift 3
  cp -a "$MOCK_DIR/repo/$from" "$MOCK_DIR/repo/$id"
  printf '%s\n' "$host" >"$MOCK_DIR/repo/$id.host"
  printf '%s\n' "$@" >"$MOCK_DIR/repo/$id.tags"
}

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

@test "archive_problems: the mail_crypt key pair and a database file in the archives" {
  [ -z "$(archive_problems $'/crypt/ecprivkey.pem\n/crypt/ecpubkey.pem' $'/backup_mariadb/\n/backup_mariadb/ibdata1')" ]
  run archive_problems '/crypt/ecpubkey.pem' '/backup_mariadb/'
  [ "$output" = $'backup_crypt.tar.zst has no ecprivkey.pem\nbackup_mariadb.tar.zst holds no database file' ]
  run archive_problems '/crypt/old-ecprivkey.pem.bak' $'/backup_mariadb/\n/backup_mariadb/mysql/'
  [[ $output == *"no ecprivkey.pem"* && $output == *"no database file"* ]]
}

@test "free space: the dump's need plus a reserve of the larger of a share and a fixed amount" {
  [ "$(dump_need_kb 1000 500)" = 2750 ]
  [ "$(space_reserve_kb 104857600 10 2)" = 10485760 ]
  [ "$(space_reserve_kb 10485760 10 2)" = 2097152 ]
  [ "$(space_reserve_kb 10485760 0 0)" = 0 ]
  [ -z "$(space_problem 2750 2850 100 /var/backups/x)" ]
  run space_problem 204800 307200 204800 /var/backups/x
  [ "$output" = "not enough free space for the dump of mailcow in /var/backups/x: about 200 MB needed and 200 MB to stay free (NODE_BACKUP_RESERVE_PERCENT, NODE_BACKUP_RESERVE_GB), 300 MB free" ]
  [[ $(space_problem 10 5 0 /x "the restore check") == *"for the restore check in /x"* ]]
}

@test "bounds: a whole run is the sum of its phases and an hour; partial runs counted in a row" {
  [ "$(node_backup_total_timeout 3600 43200 7200)" = 63000 ]
  [ "$(partial_count 0 1)" = 1 ]
  [ "$(partial_count 2 1)" = 3 ]
  [ "$(partial_count 2 0)" = 0 ]
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
  [ -z "$(node_backup_key_problem NODE_BACKUP_VERIFY_TIMEOUT 3600)" ]
  [ -z "$(node_backup_key_problem NODE_BACKUP_RESERVE_PERCENT 15)" ]
  [ -n "$(node_backup_key_problem NODE_BACKUP_RESERVE_PERCENT 100)" ]
  [ -z "$(node_backup_key_problem NODE_BACKUP_RESERVE_GB 0)" ]
  [ -n "$(node_backup_key_problem NODE_BACKUP_PARTIAL_LIMIT 0)" ]
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
  [ "$(printf '%s\n' '{"message_type":"node","type":"file","size":3000}' '{"message_type":"node","type":"dir","size":0}' \
    '{"message_type":"node","type":"file","size":100}' | snapshot_size_kb)" = 4 ]
}

@test "mailcow_restore_prompts_ok: mailcow 2026-09's questions, the fixture's, and nothing else" {
  mailcow_restore_prompts_ok "$MOCK_FIXTURES/mailcow-2026-09-prompts"
  mailcow_restore_prompts_ok "$MC/helper-scripts/backup_and_restore.sh"
  sed 's/Select a dataset to restore/Pick the data/' "$MOCK_FIXTURES/mailcow-2026-09-prompts" >"$BATS_TEST_TMPDIR/other"
  run mailcow_restore_prompts_ok "$BATS_TEST_TMPDIR/other"
  [ "$status" -eq 1 ]
  { cat "$MOCK_FIXTURES/mailcow-2026-09-prompts"; echo 'read -p "Really? " x'; } >"$BATS_TEST_TMPDIR/other"
  run mailcow_restore_prompts_ok "$BATS_TEST_TMPDIR/other"
  [ "$status" -eq 1 ]
  run mailcow_restore_prompts_ok "$BATS_TEST_TMPDIR/missing"
  [ "$status" -eq 1 ]
}

@test "restore_problem: fresh, in-progress, rehearsal and live servers" {
  # No marker: only a fresh server, never --update.
  [ -z "$(restore_problem 0 '' '' 0 node-a 10 'mailcow,nightly')" ]
  [[ $(restore_problem 1 '' '' 0 node-a 10 'mailcow,nightly') == *"has not restored this server before"* ]]
  # Live: never again.
  [[ $(restore_problem 1 live node-a 5 node-a 10 'mailcow,move') == *"live node"* ]]
  [[ $(restore_problem 0 live node-a 5 node-a 10 'mailcow,move') == *"live node"* ]]
  # Rehearsal: --update only, forward, same node or a move snapshot.
  [[ $(restore_problem 0 rehearsal node-a 5 node-a 10 'mailcow,nightly') == *"with --update"* ]]
  [ -z "$(restore_problem 1 rehearsal node-a 5 node-a 10 'mailcow,nightly')" ]
  [[ $(restore_problem 1 rehearsal node-a 5 node-a 5 'mailcow,nightly') == *"not newer"* ]]
  [[ $(restore_problem 1 rehearsal node-a 5 node-b 10 'mailcow,nightly') == *"only a snapshot of the same node or a move snapshot"* ]]
  [ -z "$(restore_problem 1 rehearsal node-a 5 node-b 10 'mailcow,move')" ]
  # In progress: again, from the same or a newer snapshot.
  [ -z "$(restore_problem 0 in-progress node-a 5 node-a 5 'mailcow,nightly')" ]
  [ -z "$(restore_problem 1 in-progress node-a 5 node-a 7 'mailcow,move')" ]
  [[ $(restore_problem 0 in-progress node-a 5 node-a 4 'mailcow,nightly') == *"older"* ]]
  [[ $(restore_problem 0 odd node-a 5 node-a 6 'mailcow') == *"unknown state"* ]]
}

@test "snapshots: the panel's and the nodes' hosts apart" {
  J='[{"id":"a1","hostname":"mailexpert-0123456789abcdef","time":"2026-10-03T03:30:00Z","tags":["nightly"]},
{"id":"b2","hostname":"mailexpert-node-0123456789abcdef","time":"2026-10-04T02:30:00+02:00","tags":["mailcow","move"]},
{"id":"c3","hostname":"mailexpert-node-fedcba9876543210","time":"2026-10-04T01:00:00Z","tags":["mailcow","nightly"]}]'
  read -r id host _ epoch tags <<<"$(snapshots_pick "$PANEL_HOST_RE" <<<"$J")"
  [ "$id $host $tags" = "a1 mailexpert-0123456789abcdef nightly" ]
  read -r id host _ epoch tags <<<"$(snapshots_pick "$NODE_HOST_RE" <<<"$J")"
  # 02:30+02:00 is 00:30Z, older than c3's 01:00Z.
  [ "$id $host $tags" = "c3 mailexpert-node-fedcba9876543210 mailcow,nightly" ]
  [ "$epoch" = "$(date -u -d 2026-10-04T01:00:00Z +%s 2>/dev/null || echo "$epoch")" ]
  [ "$(panel_hosts <<<"$J")" = mailexpert-0123456789abcdef ]
  [ "$(node_hosts mailcow <<<"$J")" = $'mailexpert-node-0123456789abcdef\nmailexpert-node-fedcba9876543210' ]
  [ -z "$(panel_hosts <<<'[]')" ]
}

@test "the firewall of a standby node closes every mail port, with no set" {
  [ "$(FIREWALL_CLOSED=1 firewall_rules 4 203.0.113.10)" = "-o br-mailcow ! -i br-mailcow -p tcp --dport 25 -j DROP
-o br-mailcow ! -i br-mailcow -p tcp -m multiport --dports 587,993 -j REJECT --reject-with tcp-reset
-o br-mailcow ! -i br-mailcow -p tcp -m multiport --dports 110,143,465,995,4190 -j DROP" ]
  FIREWALL_CLOSED=1
  run firewall_apply 4 0 203.0.113.10
  [ "$status" -eq 0 ]
  chain4 | lacks 'match-set|203\.0\.113\.10'
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
  # vmail by volume name, read-only, never through mailcow's tar; restic containers labelled.
  calls | grep -q -- '-v mailcowdockerized_vmail-vol-1:/vmail:ro'
  calls | grep 'restic/restic' | grep -q -- '--label mailexpert.node-backup=1'
  calls | lacks '^mailcow backup.*vmail'
  restic_calls | grep -q '^unlock$'
  restic_calls | grep -qE '^backup --json --host mailexpert-node-[0-9a-f]{16} --tag mailcow --tag manual /backup /vmail$'
  restic_calls | grep -qE '^forget --host mailexpert-node-[0-9a-f]{16} --tag mailcow --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --keep-tag move$'
  restic_calls | lacks '^(check|restore)'
  SNAP=$(cat "$MOCK_DIR/repo/latest")
  [ -f "$SNAP/backup/backup_mariadb.tar.zst" ] && [ -f "$SNAP/backup/mailcow.conf" ]
  [ -f "$SNAP/backup/mailexpert/node.env" ] && [ -f "$SNAP/backup/mailexpert/ssl/cert.pem" ]
  [ "$(jq -r .mailcow_commit "$SNAP/backup/mailexpert/meta.json")" = "$MOCK_GIT_HEAD" ]
  [ "$(jq -r .mailboxes "$SNAP/backup/mailexpert/meta.json")" = 2 ]
  [ -f "$SNAP/vmail/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S" ]
  [ ! -e "$MAILEXPERT_NODE_BACKUP_DIR/mailcow" ]
  STATE=$MAILEXPERT_NODE_STATE/backup-last.json
  [ "$(jq -r .tag "$STATE")" = manual ]
  [ "$(jq -r .verified "$STATE")" = false ]
  [ "$(jq -r .partial "$STATE")" = false ]
  [ "$(jq -r .processed_bytes "$STATE")" = 4096 ]
  [ "$(jq -r .mailcow "$STATE")" = 2026-09 ]
  [[ $(jq -r .snapshot "$STATE") == "$(basename "$SNAP")" ]]
  [ "$(pings | sed -n 1p)" = 'https://hc.example.com/ping/node-backup/start ' ]
  pings | sed -n 2p | grep -q '^https://hc.example.com/ping/node-backup snapshot 00000001 (manual): 4096 bytes, 1024 new'
  [[ $output != *correct-horse* && $output != *example-secret* && $output != *not-a-real-password* ]]
  calls | lacks 'not-a-real-password'
  run bash "$BACKUP" --status
  [ "$status" -eq 0 ]
}

@test "--verify: a read-back check, the dump and one mailbox restored into a temporary directory" {
  configured
  run bash "$BACKUP" --tag manual --verify
  [ "$status" -eq 0 ]
  restic_calls | grep -q '^check --read-data-subset=5%$'
  restic_calls | grep -qE '^ls --json --recursive 0+1c+ /vmail/example.com/(alice|bob)$'
  restic_calls | grep -qE '^restore 0+1c+ --target /restore --verify --include /backup --include /vmail/example.com/(alice|bob)$'
  # Every verify call of restic is bounded.
  [ "$(calls | grep 'restic/restic' | grep -E ' restic (check|restore|ls) ' | grep -cv '/usr/bin/timeout restic/restic:0.18.0 7200 restic')" = 0 ]
  [[ $output == *"one mailbox (1 files)"* ]]
  [ "$(jq -r .verified "$MAILEXPERT_NODE_STATE/backup-last.json")" = true ]
  [[ $(jq -r .restore_seconds "$MAILEXPERT_NODE_STATE/backup-last.json") =~ ^[0-9]+$ ]]
  [ -z "$(ls -A "$MAILEXPERT_NODE_BACKUP_DIR" | grep -v '^mailcow-backup.log$' || true)" ]
  pings | sed -n 2p | grep -q 'verified, restored in'
  printf 'NODE_BACKUP_READ_SUBSET=1/12\nNODE_BACKUP_VERIFY_TIMEOUT=900\n' >>"$MAILEXPERT_NODE_CONF"
  run bash "$BACKUP" --tag manual --verify
  restic_calls | grep -q '^check --read-data-subset=1/12$'
  calls | grep -q '/usr/bin/timeout restic/restic:0.18.0 900 restic check'
}

@test "--verify fails when an archive does not read back, restic check finds a problem, or the disk is short" {
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

@test "the dump needs room and the reserve: too little stops the run before mailcow's script" {
  configured
  printf 'NODE_BACKUP_RESERVE_PERCENT=99\n' >>"$MAILEXPERT_NODE_CONF"
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"not enough free space for the dump of mailcow"*"to stay free"* ]]
  calls | lacks '^mailcow backup'
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
  unset MOCK_MAILCOW_DROP
  export MOCK_MAILCOW_EMPTY_DB=1
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"backup_mariadb.tar.zst holds no database file"* ]]
  unset MOCK_MAILCOW_EMPTY_DB
  rm "$MOCK_DIR/volumes/mailcowdockerized_crypt-vol-1/ecprivkey.pem"
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"backup_crypt.tar.zst has no ecprivkey.pem"* ]]
  restic_calls | lacks '^backup'
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

@test "the upload: a failure stops the run; unreadable files are a partial snapshot, failed after a limit" {
  configured
  export MOCK_RESTIC_BACKUP=1
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"restic backup failed (exit 1"* ]]
  [ ! -e "$MAILEXPERT_NODE_STATE/backup-last.json" ]
  printf 'NODE_BACKUP_PARTIAL_LIMIT=2\n' >>"$MAILEXPERT_NODE_CONF"
  export MOCK_RESTIC_BACKUP=3
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  [[ $output == *"the snapshot is saved without them (1 run(s) in a row)"* ]]
  [ "$(jq -r .partial "$MAILEXPERT_NODE_STATE/backup-last.json")" = true ]
  pings | tail -n 1 | grep -q '^https://hc.example.com/ping/node-backup snapshot .*; partial: restic could not read some files (1 run(s) in a row)$'
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"could not read some files 2 runs in a row"* ]]
  pings | tail -n 1 | grep -q '/fail '
  [ "$(jq -r .partial "$MAILEXPERT_NODE_STATE/backup-last.json")" = true ]
  export MOCK_RESTIC_BACKUP=0
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  [ "$(cat "$MAILEXPERT_NODE_STATE/backup-partial-count")" = 0 ]
  [ "$(jq -r .partial "$MAILEXPERT_NODE_STATE/backup-last.json")" = false ]
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

@test "a repository that holds the panel's snapshots is refused" {
  configured
  repo_snapshot 0000000a mailexpert-0123456789abcdef nightly
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 1 ]
  [[ $output == *"holds the panel's snapshots (mailexpert-0123456789abcdef)"* ]]
  restic_calls | lacks '^backup'
  calls | lacks '^mailcow backup'
}

@test "containers a killed run left are removed: at the start, and by --cleanup" {
  configured
  export MOCK_LEFTOVER=deadbeef0001 MOCK_MAILCOW_BACKUP_LEFTOVER=1
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  calls | grep -q '^docker rm -f deadbeef0001 '
  calls | grep -q '^docker rm -f mailcow-backup '
  [[ $output == *"removed restic containers an earlier run left behind"* ]]
  : >"$MOCK_DIR/calls"
  run bash "$BACKUP" --cleanup
  [ "$status" -eq 0 ]
  calls | grep -q -- '--filter label=mailexpert.node-backup=1'
  calls | grep -q '^docker rm -f deadbeef0001 '
}

@test "--tag move: services down and kept down, a complete snapshot, then standby" {
  configured
  export MOCK_RUNNING='postfix-mailcow dovecot-mailcow'
  run bash "$BACKUP" --tag move
  [ "$status" -eq 1 ]
  [[ $output == *"--tag move: postfix-mailcow dovecot-mailcow still runs"* ]]
  restic_calls | lacks '^backup'
  calls | lacks 'docker update'
  export MOCK_RUNNING=''
  run bash "$BACKUP" --tag move
  [ "$status" -eq 0 ]
  calls | grep -q '^docker update --restart=no id-postfix-mailcow id-dovecot-mailcow id-watchdog-mailcow '
  calls | grep -q 'compose stop watchdog-mailcow'
  restic_calls | grep -q -- '--tag mailcow --tag move /backup /vmail$'
  [ -f "$MAILEXPERT_NODE_STATE/standby" ]
  [[ $output == *"node-restore.sh 00000001 --host mailexpert-node-"* && $output == *"setup.sh --end-standby"* ]]
  : >"$MOCK_DIR/restic"
  run bash "$BACKUP"
  [ "$status" -eq 0 ]
  [[ $output == *"standby node"* ]]
  [ ! -s "$MOCK_DIR/restic" ]
}

@test "--tag move: a partial snapshot or a service that came back fails, and the node is not standby" {
  configured
  export MOCK_RESTIC_BACKUP=3
  run bash "$BACKUP" --tag move
  [ "$status" -eq 1 ]
  [[ $output == *"a move needs a complete snapshot"* ]]
  [ ! -e "$MAILEXPERT_NODE_STATE/standby" ]
  pings | tail -n 1 | grep -q '/fail '
  export MOCK_RESTIC_BACKUP=0 MOCK_MAILCOW_STARTS=postfix-mailcow
  run bash "$BACKUP" --tag move
  [ "$status" -eq 1 ]
  [[ $output == *"--tag move: postfix-mailcow runs again"* ]]
  [ ! -e "$MAILEXPERT_NODE_STATE/standby" ]
}

@test "a standby node: ports closed, pings only when mail services run; setup.sh keeps it until --end-standby" {
  configured
  run bash "$BACKUP" --tag move
  [ "$status" -eq 0 ]
  : >"$MOCK_DIR/pings"
  run bash "$NODE_SCRIPTS/eop-ranges.sh"
  [[ $output == *"standby node (moved away): mail ports closed"* ]]
  chain4 | grep -q -- '--dport 25 -j DROP'
  chain4 | lacks 'match-set|203\.0\.113\.10'
  pings | lacks 'eop-check'
  requests | lacks 'endpoints'
  export MOCK_RUNNING=postfix-mailcow
  run bash "$NODE_SCRIPTS/eop-ranges.sh"
  [ "$status" -eq 1 ]
  pings | grep -q '^https://hc.example.com/ping/eop-check/fail eop-ranges: standby node (moved away) runs postfix-mailcow'
  export MOCK_RUNNING=''
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [[ $output == *"this node is standby"*"--end-standby"* ]]
  [ -f "$MAILEXPERT_NODE_STATE/standby" ]
  chain4 | lacks 'match-set'
  : >"$MOCK_DIR/calls"
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --end-standby
  [ ! -e "$MAILEXPERT_NODE_STATE/standby" ]
  calls | grep -q '^docker update --restart=always id-postfix-mailcow id-dovecot-mailcow id-watchdog-mailcow '
  calls | grep -q "compose up -d (in $MC)"
  chain4 | grep -q -- '--match-set mailexpert-eop4 src -j RETURN'
}

@test "--show-recovery-key prints the repository and password on request only" {
  configured
  run bash "$BACKUP" --show-recovery-key
  [ "$status" -eq 0 ]
  [[ $output == *"RESTIC_PASSWORD=correct-horse-battery-staple"* ]]
  [ -f "$MAILEXPERT_NODE_STATE/recovery-key.shown" ]
}

@test "--forget-host: the old node's snapshots go but its move snapshot" {
  configured
  run bash "$BACKUP" --tag manual
  repo_copy "$(latest_id)" 0000000a mailexpert-node-dddddddddddddddd mailcow move
  repo_copy "$(latest_id)" 0000000b mailexpert-node-eeeeeeeeeeeeeeee mailcow nightly
  run bash "$BACKUP" --forget-host mailexpert-node-dddddddddddddddd
  [ "$status" -eq 0 ]
  restic_calls | grep -q '^forget --host mailexpert-node-dddddddddddddddd --tag mailcow --keep-tag move$'
  run bash "$BACKUP" --forget-host mailexpert-node-eeeeeeeeeeeeeeee
  [ "$status" -eq 2 ]
  [[ $output == *"has no move snapshot"* ]]
  run bash "$BACKUP" --forget-host "$(cat "$MAILEXPERT_NODE_STATE/restic-host")"
  [ "$status" -eq 2 ]
  run bash "$BACKUP" --forget-host mailexpert-0123456789abcdef
  [ "$status" -eq 2 ]
}

# --- setup.sh --backup-keys ---------------------------------------------------------------------

@test "setup.sh --backup-keys: keys from stdin into node.env, the repository created, the nightly timer" {
  export MOCK_RESTIC_CAT=10
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --backup-keys < <(printf '%s\n' \
    RESTIC_REPOSITORY=s3:https://s3.example.com/node-backups/node RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key \
    NODE_BACKUP_PING_URL=https://hc.example.com/ping/node-backup NODE_BACKUP_VERIFY_TIMEOUT=3600)
  [ "$status" -eq 0 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" RESTIC_PASSWORD)" = correct-horse-battery-staple ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" PANEL_IPS)" = 203.0.113.10 ]
  restic_calls | grep -q '^init --repository-version 2$'
  [[ $(cat "$MAILEXPERT_NODE_STATE/restic-host") =~ ^mailexpert-node-[0-9a-f]{16}$ ]]
  [ -f "$MAILEXPERT_NODE_STATE/backup-since" ]
  [ -x "$MAILEXPERT_NODE_DIR/node-backup.sh" ] && [ -x "$MAILEXPERT_NODE_DIR/node-restore.sh" ]
  [ -f "$MAILEXPERT_NODE_DIR/backup-lib.sh" ] && [ -f "$MAILEXPERT_NODE_DIR/backup.sh" ]
  UNIT=$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.service
  grep -q "^ExecStart=$MAILEXPERT_NODE_DIR/node-backup.sh$" "$UNIT"
  grep -q "^ExecStopPost=$MAILEXPERT_NODE_DIR/node-backup.sh --cleanup$" "$UNIT"
  # 3600 + 43200 + 3600 (verify) + 3600 + 1800 + 3600
  grep -q '^TimeoutStartSec=59400$' "$UNIT"
  grep -q '^OnCalendar=\*-\*-\* 02:30:00$' "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.timer"
  calls | grep -q '^systemctl enable --now mailexpert-node-backup.timer$'
  # No terminal: the key is not printed, the command that shows it is.
  [[ $output == *"node-backup.sh --show-recovery-key"* ]]
  [[ $output != *correct-horse* && $output != *example-secret* ]]
  # Installed, the scripts find their libraries next to them.
  run bash "$MAILEXPERT_NODE_DIR/node-backup.sh" --tag manual
  [ "$status" -eq 0 ]
}

@test "setup.sh --backup-keys: storage that cannot be set up fails the run after the firewall's schedule" {
  export MOCK_RESTIC_CAT=10 MOCK_RESTIC_INIT=1
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10 --backup-keys < <(printf '%s\n' \
    RESTIC_REPOSITORY=s3:https://s3.example.com/node-backups/node RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key)
  [ "$status" -eq 1 ]
  [[ $output == *"backups: the restic repository could not be opened or created"* ]]
  # The firewall's units are in place, the backup timer is not, the keys are kept for the rerun.
  calls | grep -q '^systemctl enable mailexpert-node-firewall.service$'
  [ -f "$MAILEXPERT_SYSTEMD_DIR/mailexpert-eop-ranges.timer" ]
  [ ! -e "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.timer" ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" RESTIC_PASSWORD)" = correct-horse-battery-staple ]
  [ ! -e "$MAILEXPERT_NODE_STATE/backup-since" ]
  export MOCK_RESTIC_INIT=0
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [ "$status" -eq 0 ]
  [ -f "$MAILEXPERT_SYSTEMD_DIR/mailexpert-node-backup.timer" ]
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

@test "setup.sh without systemd: a bounded cron line writing a rotated log of its own" {
  configured
  export MAILEXPERT_NODE_INIT=cron
  run bash "$SETUP" --mailcow-dir "$MC" --panel-ip 203.0.113.10
  [ "$status" -eq 0 ]
  grep -q "^30 2 \* \* \* root timeout -k 60 63000 $MAILEXPERT_NODE_DIR/node-backup.sh >>$MAILEXPERT_NODE_BACKUP_LOG 2>&1$" "$MAILEXPERT_BACKUP_CRON_FILE"
  grep -q '^MAILTO=""$' "$MAILEXPERT_BACKUP_CRON_FILE"
  [ -f "$MAILEXPERT_NODE_BACKUP_LOG" ]
  grep -q "^$MAILEXPERT_NODE_BACKUP_LOG {$" "$MAILEXPERT_LOGROTATE_FILE"
  grep -q 'create 0600 root root' "$MAILEXPERT_LOGROTATE_FILE"
  # A failure under cron names the log, not the journal.
  export MOCK_MAILCOW_STATUS=1
  unset INVOCATION_ID
  run bash "$BACKUP" --tag manual
  pings | tail -n 1 | grep -q "/fail node-backup.sh failed with exit 1; see $MAILEXPERT_NODE_BACKUP_LOG$"
  export INVOCATION_ID=abc
  run bash "$BACKUP" --tag manual
  pings | tail -n 1 | grep -q '/fail node-backup.sh failed with exit 1; see journalctl -u mailexpert-node-backup$'
}

# --- node-restore.sh ----------------------------------------------------------------------------

# fresh_node: what a new server has before the restore: mailcow cloned (compose file and its
# script) and generate_config.sh run (its own mailcow.conf and files), no volumes, no node.env.
fresh_node() {
  rm -rf "$MOCK_DIR/volumes" "$MAILEXPERT_NODE_CONF" "$MC/data" "$MAILEXPERT_NODE_STATE" "$MOCK_DIR/mailcow-restored"
  printf 'MAILCOW_HOSTNAME=mail.example.com\nDBPASS=generated-here\nCOMPOSE_PROJECT_NAME=mailcowdockerized\n' >"$MC/mailcow.conf"
  mkdir -p "$MC/data/web/inc"
  printf '<?php\n' >"$MC/data/web/inc/app_info.inc.php"
  : >"$MOCK_DIR/calls"
}

keys() {
  printf '%s\n' RESTIC_REPOSITORY=s3:https://s3.example.com/node-backups/node RESTIC_PASSWORD=correct-horse-battery-staple \
    AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY AWS_SECRET_ACCESS_KEY=example-secret-access-key
}

@test "a node backup restores onto a fresh node: files, vmail, mailcow's restore answered and checked" {
  configured
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 0 ]
  [[ $output == *"restoring snapshot 00000001 of node mailexpert-node-"* ]]
  [[ $output == *"the mail_crypt keys in place, 2 mailboxes in the database (as in the backup)"* ]]
  [ "$(env_get "$MC/mailcow.conf" MAILCOW_HOSTNAME)" = mail.example.com ]
  # The backup's mailcow.conf replaced the one generate_config.sh wrote.
  [ "$(env_get "$MC/mailcow.conf" DBPASS)" = not-a-real-password ]
  [ -f "$MC/data/conf/postfix/extra.cf" ] && [ -f "$MC/data/assets/ssl/cert.pem" ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" PANEL_IPS)" = 203.0.113.10 ]
  [ "$(env_get "$MAILEXPERT_NODE_CONF" MAILCOW_DIR)" = "$MC" ]
  [ -f "$(vmail)/example.com/bob/Maildir/cur/1700000001.M2.mail:2,S" ]
  [ -s "$MOCK_DIR/volumes/mailcowdockerized_crypt-vol-1/ecprivkey.pem" ]
  restic_calls | grep -qE '^restore 0+1c+ --target /restore --include /vmail --overwrite if-changed --delete --verify$'
  calls | grep -q -- '-v mailcowdockerized_vmail-vol-1:/restore/vmail '
  calls | grep -q '^mailcow restore answers: 1 0 y$'
  [ -f "$MOCK_DIR/mailcow-restored/backup_postfix.tar.zst" ]
  [ "$(marker STATE)" = live ]
  # Dovecot stopped before the mail comes back.
  [ "$(calls | grep -n 'compose stop dovecot-mailcow' | cut -d: -f1)" -lt "$(calls | grep -n '^mailcow restore answers' | cut -d: -f1)" ]
  [[ $output != *correct-horse* ]]
  [ "$(readlink "$MC/.env")" = mailcow.conf ]
}

@test "--update after a normal restore, or after setup.sh on a rehearsal, is refused" {
  configured
  run bash "$BACKUP" --tag manual
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 0 ]
  run bash "$RESTORE" latest --mailcow-dir "$MC" --update
  [ "$status" -eq 2 ]
  [[ $output == *"this server is a live node"* ]]
  run bash "$RESTORE" latest --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  # A rehearsal, then setup.sh on it: live as well.
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" --rehearsal < <(keys)
  [ "$status" -eq 0 ]
  [ "$(marker STATE)" = rehearsal ]
  run bash "$SETUP" --mailcow-dir "$MC"
  [[ $output == *"marked live"* ]]
  [ "$(marker STATE)" = live ]
  : >"$MOCK_DIR/calls"
  run bash "$RESTORE" latest --mailcow-dir "$MC" --update
  [ "$status" -eq 2 ]
  [[ $output == *"this server is a live node"* ]]
  calls | lacks 'compose (up|pull|stop)'
}

@test "a move restores twice: a rehearsal without the queue and with its jobs stopped, then --update" {
  configured
  run bash "$BACKUP" --tag manual
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" --rehearsal < <(keys)
  [ "$status" -eq 0 ]
  [ ! -e "$MOCK_DIR/mailcow-restored/backup_postfix.tar.zst" ]
  [ -f "$MOCK_DIR/mailcow-restored/backup_mariadb.tar.zst" ]
  [[ $output == *"rehearsal: postfix-mailcow ofelia-mailcow watchdog-mailcow stopped"* ]]
  calls | grep -q '^docker update --restart=no id-postfix-mailcow id-ofelia-mailcow id-watchdog-mailcow '
  calls | tail -n 1 | grep -q 'compose stop postfix-mailcow ofelia-mailcow watchdog-mailcow'
  # A plain restore on it is refused; the same snapshot again too.
  run bash "$RESTORE" latest --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
  [[ $output == *"bring it to a newer snapshot with --update"* ]]
  run bash "$RESTORE" latest --mailcow-dir "$MC" --update
  [ "$status" -eq 2 ]
  [[ $output == *"not newer"* ]]
  FIRST=$(latest_id)
  # Another node's nightly snapshot is not this rehearsal's to update to.
  repo_copy "$FIRST" 0000000a mailexpert-node-cccccccccccccccc mailcow nightly
  run bash "$RESTORE" 0000000a --mailcow-dir "$MC" --update
  [ "$status" -eq 2 ]
  [[ $output == *"only a snapshot of the same node or a move snapshot"* ]]
  rm -rf "$MOCK_DIR/repo/0000000a"*
  # The old node got mail and lost some before its move backup.
  rm "$(vmail)/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S"
  mkdir -p "$(vmail)/example.com/carol/Maildir/cur"
  printf 'Subject: three\n' >"$(vmail)/example.com/carol/Maildir/cur/1700000002.M3.mail:2,S"
  cp "$MOCK_DIR/repo/$FIRST.host" "$MAILEXPERT_NODE_STATE/restic-host"
  run bash "$BACKUP" --tag move
  [ "$status" -eq 0 ]
  # The rehearsal's copy still has the old state.
  printf 'Subject: one\n' >"$(vmail)/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S"
  rm -rf "$MOCK_DIR/mailcow-restored"
  : >"$MOCK_DIR/calls"
  run bash "$RESTORE" "$(latest_id)" --mailcow-dir "$MC" --update
  [ "$status" -eq 0 ]
  [ ! -e "$(vmail)/example.com/alice/Maildir/cur/1700000000.M1.mail:2,S" ]
  [ -f "$(vmail)/example.com/carol/Maildir/cur/1700000002.M3.mail:2,S" ]
  [ -f "$MOCK_DIR/mailcow-restored/backup_postfix.tar.zst" ]
  calls | grep -q '^docker update --restart=always id-postfix-mailcow id-ofelia-mailcow id-watchdog-mailcow '
  [ "$(marker STATE)" = live ]
  [ "$(marker SNAPSHOT)" = "$(latest_id)" ]
  [[ $output == *"node-backup.sh --forget-host mailexpert-node-"* ]]
  run bash "$RESTORE" latest --rehearsal --update --mailcow-dir "$MC"
  [ "$status" -eq 2 ]
}

@test "the compose override is the snapshot's: --update drops one the move snapshot no longer has" {
  configured
  printf 'services: {}\n# old\n' >"$MC/docker-compose.override.yml"
  run bash "$BACKUP" --tag manual
  [ "$status" -eq 0 ]
  FIRST=$(latest_id)
  fresh_node
  rm "$MC/docker-compose.override.yml"
  run bash "$RESTORE" latest --mailcow-dir "$MC" --rehearsal < <(keys)
  [ "$status" -eq 0 ]
  grep -q '# old' "$MC/docker-compose.override.yml"
  # The owner removed the override on the old node before its move backup.
  repo_copy "$FIRST" 0000000a "$(cat "$MOCK_DIR/repo/$FIRST.host")" mailcow move
  rm "$MOCK_DIR/repo/0000000a$(printf 'c%.0s' $(seq 56))/backup/mailexpert/docker-compose.override.yml"
  run bash "$RESTORE" 0000000a --mailcow-dir "$MC" --update
  [ "$status" -eq 0 ]
  [ ! -e "$MC/docker-compose.override.yml" ]
  grep -q '# old' "$MC/docker-compose.override.yml.pre-restore"
  [[ $output == *"docker-compose.override.yml: the snapshot has none"* ]]
}

@test "a restore that stopped half way is run again" {
  configured
  run bash "$BACKUP" --tag manual
  fresh_node
  export MOCK_MAILCOW_RESTORE_SKIP=crypt
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 1 ]
  [[ $output == *"mailcow's restore is incomplete: the crypt volume has no ecprivkey.pem"*"run node-restore.sh again"* ]]
  [ -f "$MAILEXPERT_NODE_BACKUP_DIR/mailcow-restore.log" ]
  [ "$(marker STATE)" = in-progress ]
  unset MOCK_MAILCOW_RESTORE_SKIP
  # The server is no longer fresh, but the marker lets the same restore run again.
  run bash "$RESTORE" latest --mailcow-dir "$MC"
  [ "$status" -eq 0 ]
  [ "$(marker STATE)" = live ]
}

@test "the restored database is checked: it must answer, with the backup's number of mailboxes" {
  configured
  run bash "$BACKUP" --tag manual
  fresh_node
  export MOCK_MAILCOW_RESTORE_SKIP=mysql
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 1 ]
  [[ $output == *"mailcow's database does not answer"* ]]
  unset MOCK_MAILCOW_RESTORE_SKIP
  jq '.mailboxes = 5' "$(cat "$MOCK_DIR/repo/latest")/backup/mailexpert/meta.json" >"$BATS_TEST_TMPDIR/meta"
  cp "$BATS_TEST_TMPDIR/meta" "$(cat "$MOCK_DIR/repo/latest")/backup/mailexpert/meta.json"
  run bash "$RESTORE" latest --mailcow-dir "$MC"
  [ "$status" -eq 1 ]
  [[ $output == *"the database has 2 mailboxes, the backup 5"* ]]
}

@test "latest without --host is refused when several nodes have snapshots" {
  configured
  run bash "$BACKUP" --tag manual
  HOST=$(cat "$MAILEXPERT_NODE_STATE/restic-host")
  repo_copy "$(latest_id)" 0000000a mailexpert-node-bbbbbbbbbbbbbbbb mailcow nightly
  fresh_node
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 2 ]
  # The hosts are listed sorted and $HOST is random, so check each one, not their order.
  [[ $output == *"snapshots of several nodes: "*"; name one with --host"* ]]
  [[ $output == *"$HOST"* ]]
  [[ $output == *"mailexpert-node-bbbbbbbbbbbbbbbb"* ]]
  calls | lacks 'compose (up|pull)'
  run bash "$RESTORE" latest --host "$HOST" --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 0 ]
  [[ $output == *"restoring snapshot 00000001 of node $HOST"* ]]
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
  [ ! -e "$MAILEXPERT_NODE_STATE/restored" ]
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
  [ "$(env_get "$MC/mailcow.conf" DBPASS)" = generated-here ]
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
  cp "$MOCK_FIXTURES/fake-backup-and-restore" "$MC/helper-scripts/backup_and_restore.sh"
  rm "$MC/data/web/inc/app_info.inc.php"
  run bash "$RESTORE" latest --mailcow-dir "$MC" < <(keys)
  [ "$status" -eq 2 ]
  [[ $output == *"run ln -s mailcow.conf .env && ./generate_config.sh in $MC first"* ]]
  [ ! -s "$MOCK_DIR/restic" ]
}
