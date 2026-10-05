#!/usr/bin/env bats
# Decisions of restore.sh and update.sh.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  D=$BATS_TEST_TMPDIR/dest.env
  S=$BATS_TEST_TMPDIR/restored.env
}

@test "merge_restored_keys overwrite: restored values replace local ones" {
  printf '%s\n' ENCRYPTION_KEY=local-key DB_PASSWORD=local-db APP_URL=https://b.example.com >"$D"
  printf '%s\n' ENCRYPTION_KEY=old-key DB_PASSWORD=old-db APP_URL=https://a.example.com >"$S"
  run merge_restored_keys "$D" "$S" overwrite ENCRYPTION_KEY DB_PASSWORD
  [ "$status" -eq 0 ]
  [ "$output" = $'ENCRYPTION_KEY\nDB_PASSWORD' ]
  [ "$(env_get "$D" ENCRYPTION_KEY)" = old-key ] && [ "$(env_get "$D" DB_PASSWORD)" = old-db ]
  [ "$(env_get "$D" APP_URL)" = https://b.example.com ]
  [ "$(stat -c %a "$D")" = 600 ]
}

@test "merge_restored_keys fill: only keys that are empty here" {
  printf '%s\n' AUTH_GOOGLE_CLIENT_ID=new-id AUTH_GOOGLE_CLIENT_SECRET= >"$D"
  printf '%s\n' AUTH_GOOGLE_CLIENT_ID=old-id AUTH_GOOGLE_CLIENT_SECRET=old-secret HEALTHCHECK_PING_URL=https://hc.example.com/x >"$S"
  run merge_restored_keys "$D" "$S" fill AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET HEALTHCHECK_PING_URL
  [ "$output" = $'AUTH_GOOGLE_CLIENT_SECRET\nHEALTHCHECK_PING_URL' ]
  [ "$(env_get "$D" AUTH_GOOGLE_CLIENT_ID)" = new-id ]
  [ "$(env_get "$D" AUTH_GOOGLE_CLIENT_SECRET)" = old-secret ]
}

@test "merge_restored_keys skips keys the snapshot does not have and equal values" {
  printf '%s\n' ENCRYPTION_KEY=same >"$D"
  printf '%s\n' ENCRYPTION_KEY=same VAPID_PUBLIC_KEY= >"$S"
  run merge_restored_keys "$D" "$S" overwrite ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run env_get "$D" VAPID_PUBLIC_KEY
  [ "$status" -eq 1 ]
}

@test "merge_restored_keys refuses an unknown mode" {
  run merge_restored_keys "$D" "$S" replace ENCRYPTION_KEY
  [ "$status" -eq 2 ]
}

@test "tenant_file_targets: nothing with the profile off; this server's paths first, then the snapshot's, then compose's defaults" {
  printf '%s\n' COMPOSE_PROFILES=extra TENANT_CERT_DIR=/srv/certs >"$D"
  printf '%s\n' COMPOSE_PROFILES= TENANT_PFX_PASSWORD_FILE=/srv/secrets/pw >"$S"
  [ -z "$(tenant_file_targets /opt/me/app "$D" "$S")" ]
  printf '%s\n' COMPOSE_PROFILES=tenant TENANT_CERT_DIR=/srv/other TENANT_PFX_PASSWORD_FILE=/srv/other/pw >"$S"
  [ "$(tenant_file_targets /opt/me/app "$D" "$S")" = $'/srv/certs/app.pfx\n/srv/other/pw' ]
  [ "$(tenant_file_targets /opt/me/app "$S")" = $'/srv/other/app.pfx\n/srv/other/pw' ]
  printf '%s\n' COMPOSE_PROFILES=tenant TENANT_CERT_DIR=./certs >"$S"
  [ "$(tenant_file_targets /opt/me/app "$S")" = $'/opt/me/app/certs/app.pfx\n/opt/me/app/tenant-secrets/app.pfx.password' ]
}

@test "space_problem: twice the last dump must be free" {
  [ -z "$(space_problem $((2 * 1024 * 1024)) $((1024 * 1024 * 1024)))" ]
  [ "$(space_problem $((1024 * 1024)) $((1024 * 1024 * 1024)))" = "free space: 1024 MB, the update needs 2048 MB (twice the last dump)" ]
}

@test "stale_local_dumps keeps the newest ones" {
  [ "$(printf '%s\n' d5 d4 d3 d2 d1 | stale_local_dumps 3)" = $'d2\nd1' ]
  [ -z "$(printf '%s\n' d2 d1 | stale_local_dumps 3)" ]
}
