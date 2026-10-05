#!/usr/bin/env bats
# configure.sh: owner secrets from stdin, never from arguments, never printed.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  CONFIGURE=$DEPLOY_DIR/configure.sh
  # The shapes Cloudflare hands out: a 64-hex AUD tag and a tunnel token (base64 of {a, t, s}).
  AUD=$(printf 'a%.0s' {1..32})$(printf '0%.0s' {1..32})
  TOKEN=$(tunnel_token value456)
}

# tunnel_token <secret> [json]: a token shaped like Cloudflare's, the JSON replaceable.
tunnel_token() {
  local json=${2:-"{\"a\":\"0123456789abcdef0123456789abcdef\",\"t\":\"11111111-2222-4333-8444-555555555555\",\"s\":\"$1\"}"}
  printf '%s' "$json" | base64 | tr -d '\n'
}

@test "stores app and edge secrets in their files and prints no value" {
  run bash "$CONFIGURE" --prefix "$P" <<EOF
# owner secrets
CF_ACCESS_ISSUER=https://team-x.cloudflareaccess.com
CF_ACCESS_AUDIENCE=$AUD

TUNNEL_TOKEN=$TOKEN
DNS_API_TOKEN=dns-value-789
HEALTHCHECK_PING_URL=https://hc-ping.example.com/ping-value-000
EOF
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" CF_ACCESS_AUDIENCE)" = "$AUD" ]
  [ "$(env_get "$P/.env" HEALTHCHECK_PING_URL)" = https://hc-ping.example.com/ping-value-000 ]
  [ "$(env_get "$P/edge/.env" TUNNEL_TOKEN)" = "$TOKEN" ]
  [ "$(env_get "$P/edge/.env" DNS_API_TOKEN)" = dns-value-789 ]
  run env_get "$P/.env" TUNNEL_TOKEN
  [ "$status" -eq 1 ]
  [[ $output != *value* ]]
  [ "$(stat -c %a "$P/.env")" = 600 ] && [ "$(stat -c %a "$P/edge/.env")" = 600 ] && [ "$(stat -c %a "$P/edge")" = 700 ]
}

@test "output never contains a value" {
  run bash "$CONFIGURE" --prefix "$P" <<<"AUTH_GOOGLE_CLIENT_SECRET=very-secret-value"
  [ "$status" -eq 0 ]
  [[ $output == *AUTH_GOOGLE_CLIENT_SECRET* && $output != *very-secret-value* ]]
}

@test "owner secrets are replaced on rotation" {
  bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$(tunnel_token old-secret)"
  bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$(tunnel_token new-secret)"
  [ "$(env_get "$P/edge/.env" TUNNEL_TOKEN)" = "$(tunnel_token new-secret)" ]
}

@test "CF_ACCESS_AUDIENCE must be a 64-hex AUD tag; the value is never echoed" {
  for bad in aud-value-123 "${AUD}0" "${AUD:1}" "$(tr a A <<<"$AUD")" "${AUD:0:63}g"; do
    run bash "$CONFIGURE" --prefix "$P" <<<"CF_ACCESS_AUDIENCE=$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"CF_ACCESS_AUDIENCE: must be the Application Audience (AUD) tag"* ]]
    [[ $output != *"$bad"* ]]
  done
  [ ! -e "$P/.env" ]
}

@test "TUNNEL_TOKEN must be base64 of a JSON object with a, t and s; the value is never echoed" {
  local -a bad=(
    tunnel-value-456==
    "$(printf 'x%.0s' {1..60})"
    "$(tunnel_token s '{"a":"0123456789abcdef0123456789abcdef","t":"11111111-2222-4333-8444-555555555555"}')"
    "$(tunnel_token s '{"account":"0123456789abcdef0123456789abcdef","tunnel":"11111111-2222-4333-8444-555555555555","s":"x"}')"
    "$(tunnel_token s '{"a":"","t":"11111111-2222-4333-8444-555555555555","s":"secret-secret"}')"
    "$(printf 'not json at all, but long enough to pass the length check' | base64 | tr -d '\n')"
  )
  for value in "${bad[@]}"; do
    run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$value"
    [ "$status" -eq 2 ]
    [[ $output == *"TUNNEL_TOKEN: must be the token of a remotely managed tunnel"* ]]
    [[ $output != *"$value"* ]]
  done
  [ ! -e "$P/edge/.env" ]
}

@test "a tunnel token without its base64 padding is accepted" {
  local padded unpadded
  # 'ab' makes the JSON length leave padding on the base64 form.
  for secret in ab abc abcd; do
    padded=$(tunnel_token "$secret")
    unpadded=${padded%%=*}
    run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$unpadded"
    [ "$status" -eq 0 ]
  done
}

@test "CRLF input is accepted" {
  run bash "$CONFIGURE" --prefix "$P" <<<$'AUTH_GOOGLE_CLIENT_ID=id-1\r'
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" AUTH_GOOGLE_CLIENT_ID)" = id-1 ]
}

@test "one bad line writes nothing" {
  run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$TOKEN"$'\nNOT_A_KEY=x'
  [ "$status" -eq 2 ]
  [[ $output == *NOT_A_KEY* ]]
  [ ! -e "$P/.env" ] && [ ! -e "$P/edge/.env" ]
}

@test "a line that is not KEY=VALUE is reported without its content" {
  run bash "$CONFIGURE" --prefix "$P" <<<"eyJhbGciOiJIUzI1NiJ9secretpart=="
  [ "$status" -eq 2 ]
  [[ $output != *secretpart* ]]
  run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN spacedsecret"
  [ "$status" -eq 2 ]
  [[ $output != *spacedsecret* ]]
}

@test "values with spaces or empty values are refused without echo" {
  run bash "$CONFIGURE" --prefix "$P" <<<"DNS_API_TOKEN=two words"
  [ "$status" -eq 2 ]
  [[ $output != *words* ]]
  run bash "$CONFIGURE" --prefix "$P" <<<"DNS_API_TOKEN="
  [ "$status" -eq 2 ]
}

@test "value checks for the Access issuer and the ping URL" {
  run bash "$CONFIGURE" --prefix "$P" <<<"CF_ACCESS_ISSUER=https://example.com"
  [ "$status" -eq 2 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"HEALTHCHECK_PING_URL=http://hc.example.com/x"
  [ "$status" -eq 2 ]
}

@test "generated secrets: stored when absent, kept when equal, refused when different" {
  key=$(printf 'b%.0s' {1..64})
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$key"
  [ "$status" -eq 0 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$key"
  [ "$status" -eq 0 ]
  [[ $output == *"ENCRYPTION_KEY: unchanged"* ]]
  before=$(sha256sum <"$P/.env")
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$(printf 'c%.0s' {1..64})"
  [ "$status" -eq 2 ]
  [[ $output != *cccc* && $output != *bbbb* ]]
  [ "$(sha256sum <"$P/.env")" = "$before" ]
}

@test "secrets as arguments are refused and not echoed" {
  run bash "$CONFIGURE" --prefix "$P" TUNNEL_TOKEN=argsecret
  [ "$status" -eq 2 ]
  [[ $output != *argsecret* ]]
  [ ! -e "$P/edge/.env" ]
}

@test "empty stdin is an error" {
  run bash "$CONFIGURE" --prefix "$P" </dev/null
  [ "$status" -eq 2 ]
}

@test "waits for install.sh's lock and gives up with exit 1 when it is held too long" {
  mkdir -p "$P/state"
  flock "$P/state/install.lock" sleep 4 &
  sleep 0.5
  MAILEXPERT_LOCK_TIMEOUT=1 run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$TOKEN"
  [ "$status" -eq 1 ]
  [[ $output == *"another install.sh or configure.sh"* && $output != *"$TOKEN"* ]]
  [ ! -e "$P/edge/.env" ]
  run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=$TOKEN"
  [ "$status" -eq 0 ]
  [[ $output == *waiting* ]]
  [ "$(env_get "$P/edge/.env" TUNNEL_TOKEN)" = "$TOKEN" ]
  wait
}

@test "restic keys and the backup ping URL go to .env and no value is printed" {
  run bash "$CONFIGURE" --prefix "$P" <<'EOF'
RESTIC_REPOSITORY=s3:https://s3.example.com/panel-backups/main
RESTIC_PASSWORD=restic-password-value-0001
AWS_ACCESS_KEY_ID=access-key-value-0002
AWS_SECRET_ACCESS_KEY=secret-key-value-0003
AWS_DEFAULT_REGION=eu-central-1
BACKUP_PING_URL=https://hc-ping.example.com/backup-ping-0004
EOF
  [ "$status" -eq 0 ]
  [[ $output == *RESTIC_PASSWORD* && $output != *value-000* && $output != *backup-ping-0004* ]]
  [ "$(env_get "$P/.env" RESTIC_REPOSITORY)" = s3:https://s3.example.com/panel-backups/main ]
  [ "$(env_get "$P/.env" RESTIC_PASSWORD)" = restic-password-value-0001 ]
  [ "$(env_get "$P/.env" AWS_ACCESS_KEY_ID)" = access-key-value-0002 ]
  [ "$(env_get "$P/.env" AWS_SECRET_ACCESS_KEY)" = secret-key-value-0003 ]
  [ "$(env_get "$P/.env" AWS_DEFAULT_REGION)" = eu-central-1 ]
  [ "$(env_get "$P/.env" BACKUP_PING_URL)" = https://hc-ping.example.com/backup-ping-0004 ]
}

@test "the repository must be S3 over https, plain http only on the loopback" {
  for bad in s3:http://s3.example.com/b /srv/restic sftp:backup@example.com:/r s3:https://s3.example.com; do
    run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_REPOSITORY=$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"RESTIC_REPOSITORY: must be s3:https://"* ]]
  done
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_REPOSITORY=s3:http://127.0.0.1:19000/me-e2e-backups"
  [ "$status" -eq 0 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"BACKUP_PING_URL=http://hc.example.com/x"
  [ "$status" -eq 2 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"AWS_DEFAULT_REGION=Not_A_Region"
  [ "$status" -eq 2 ]
}

@test "RESTIC_PASSWORD: at least 16 characters and written once" {
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=too-short"
  [ "$status" -eq 2 ]
  [[ $output != *too-short* ]]
  bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=first-restic-password"
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=first-restic-password"
  [ "$status" -eq 0 ]
  before=$(sha256sum <"$P/.env")
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=second-restic-password"
  [ "$status" -eq 2 ]
  [[ $output == *"RESTIC_PASSWORD: "*"never replaced"* && $output != *first-restic* && $output != *second-restic* ]]
  [ "$(sha256sum <"$P/.env")" = "$before" ]
}

@test "a different generated key points to restore.sh for a move" {
  bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$(printf 'b%.0s' {1..64})"
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$(printf 'c%.0s' {1..64})"
  [ "$status" -eq 2 ]
  [[ $output == *"ENCRYPTION_KEY: "*restore.sh* ]]
}
