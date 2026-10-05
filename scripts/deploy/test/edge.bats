#!/usr/bin/env bats
# Edge files: the rendered Caddyfile and the edge compose project directory.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  install_defaults
  CFG_VERSION=sha-0123456789ab CFG_SIGNIN=direct CFG_DIRECT_HOST=panel.example.com
  T=$REPO_DIR/deploy/edge/Caddyfile.tmpl
  E=$BATS_TEST_TMPDIR/edge
}

@test "caddy_site_address uses the parent zone wildcard when there is one" {
  [ "$(caddy_site_address panel.example.com)" = '*.example.com' ]
  [ "$(caddy_site_address a.b.example.co.uk)" = '*.b.example.co.uk' ]
  [ "$(caddy_site_address example.com)" = example.com ]
}

@test "the DNS-01 Caddyfile" {
  run render_caddyfile "$T"
  [ "$status" -eq 0 ]
  [[ $output == *'*.example.com {'* ]]
  [[ $output == *'@app host panel.example.com'* ]]
  [[ $output == *'reverse_proxy 127.0.0.1:8080'* ]]
  [[ $output == *'dns cloudflare {env.DNS_API_TOKEN}'* ]]
  [[ $output == *'abort'* && $output == *'admin off'* ]]
  [[ $output != *'issuer internal'* && $output != *'email '* ]]
  run ! grep -E '@[A-Z_]+@' <<<"$output"
}

@test "the internal-CA Caddyfile with a custom port and an ACME email" {
  CFG_EDGE_TLS=internal CFG_HTTP_PORT=18080 CFG_ACME_EMAIL=ops@example.com
  run render_caddyfile "$T"
  [[ $output == *'issuer internal'* && $output != *'dns cloudflare'* ]]
  [[ $output == *'reverse_proxy 127.0.0.1:18080'* && $output == *'email ops@example.com'* ]]
}

@test "write_edge_files lays out the edge directory once" {
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  cmp "$REPO_DIR/deploy/edge/compose.yml" "$E/compose.yml"
  [ "$(stat -c %a "$E")" = 700 ]
  [ "$(env_get "$E/.env" COMPOSE_PROJECT_NAME)" = edge ]
  [ "$(env_get "$E/.env" COMPOSE_PROFILES)" = caddy ]
  [ "$(env_get "$E/.env" EDGE_IMAGE)" = local.invalid/mailexpert-edge:sha-0123456789ab ]
  grep -q '@app host panel.example.com' "$E/Caddyfile"
  before=$(cat "$E/.env" "$E/Caddyfile" "$E/compose.yml" | sha256sum)
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$(cat "$E/.env" "$E/Caddyfile" "$E/compose.yml" | sha256sum)" = "$before" ]
}

@test "write_edge_files keeps owner secrets and writes no Caddyfile for a tunnel-only edge" {
  mkdir -p "$E"
  printf 'TUNNEL_TOKEN=abc\n' >"$E/.env"
  CFG_SIGNIN=cf CFG_CF_HOST=cf.example.com
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$(env_get "$E/.env" TUNNEL_TOKEN)" = abc ]
  [ "$(env_get "$E/.env" COMPOSE_PROFILES)" = tunnel ]
  [ ! -e "$E/Caddyfile" ]
}

@test "caddy_restart_needed survives an interrupted run until the applied Caddyfile is recorded" {
  S=$BATS_TEST_TMPDIR/state/caddyfile.applied
  mkdir -p "$BATS_TEST_TMPDIR/state"
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  # A container created by this run has loaded the current file: nothing to restart.
  run caddy_restart_needed "$E/Caddyfile" "$S" 0
  [ "$status" -eq 1 ]
  # A running container without a record (an install from before the record existed) restarts once.
  caddy_restart_needed "$E/Caddyfile" "$S" 1
  caddy_record_applied "$E/Caddyfile" "$S"
  [ "$(stat -c %a "$S")" = 600 ]
  run caddy_restart_needed "$E/Caddyfile" "$S" 1
  [ "$status" -eq 1 ]
  # The Caddyfile changes and the run stops before Caddy restarts: every later run still restarts.
  CFG_DIRECT_HOST=other.example.com
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  caddy_restart_needed "$E/Caddyfile" "$S" 1
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  caddy_restart_needed "$E/Caddyfile" "$S" 1
  caddy_record_applied "$E/Caddyfile" "$S"
  run caddy_restart_needed "$E/Caddyfile" "$S" 1
  [ "$status" -eq 1 ]
}

# --- Cloudflare Access in front of <CF_HOST> ---

ISSUER=https://team-x.cloudflareaccess.com
LOGIN='https://team-x.cloudflareaccess.com/cdn-cgi/access/login/cf.example.com?kid=abc&redirect_url=%2Fapi%2Fhealth'

# verdict <curl exit> <code> <location> <www-authenticate> [issuer]: state, team and message as
# globals.
verdict() {
  IFS=$'\t' read -r STATE TEAM MESSAGE < <(cf_access_verdict "$1" "$2" "$3" "$4" cf.example.com 8080 "${5-$ISSUER}")
}

@test "cf_access_verdict: a redirect to the issuer's team is ok and says what it does not prove" {
  verdict 0 302 "$LOGIN" ''
  [ "$STATE" = ok ] && [ "$TEAM" = team-x.cloudflareaccess.com ]
  [[ $MESSAGE == *"behind Cloudflare Access"*"does not test the tunnel route"* ]]
  # Access's managed OAuth answers non-browser clients 401 with the team in WWW-Authenticate.
  verdict 0 401 '' 'Bearer resource_metadata="https://team-x.cloudflareaccess.com/.well-known/oauth-protected-resource"'
  [ "$STATE" = ok ] && [ "$TEAM" = team-x.cloudflareaccess.com ]
  # Without an issuer (--local-auth) any team is accepted.
  verdict 0 302 "https://other.cloudflareaccess.com/cdn-cgi/access/login/x" '' ''
  [ "$STATE" = ok ] && [ "$TEAM" = other.cloudflareaccess.com ]
}

@test "cf_access_verdict: another team than CF_ACCESS_ISSUER is a mismatch with the fix" {
  verdict 0 302 "https://Team-Y.cloudflareaccess.com/cdn-cgi/access/login/cf.example.com" ''
  [ "$STATE" = team_mismatch ] && [ "$TEAM" = team-y.cloudflareaccess.com ]
  [[ $MESSAGE == *"CF_ACCESS_ISSUER names team-x.cloudflareaccess.com"*"invalid identity token"*"CF_ACCESS_ISSUER=https://team-y.cloudflareaccess.com"* ]]
}

@test "cf_access_verdict: DNS, network, tunnel and origin failures name the next step" {
  verdict 6 000 '' ''
  [ "$STATE" = dns_missing ] && [ "$TEAM" = - ]
  [[ $MESSAGE == *"cf.example.com does not resolve"*"cf.example.com -> http://127.0.0.1:8080"*"propagating"* ]]
  verdict 28 000 '' ''
  [ "$STATE" = unreachable ] && [[ $MESSAGE == *"curl exit 28"* ]]
  verdict 0 530 '' ''
  [ "$STATE" = tunnel_down ] && [[ $MESSAGE == *"530 (error 1033)"*"cloudflared logs"* ]]
  verdict 0 502 '' ''
  [ "$STATE" = origin_error ] && [[ $MESSAGE == *"http://127.0.0.1:8080"* ]]
  for state in dns_missing unreachable tunnel_down origin_error; do cf_access_transient "$state"; done
  for state in ok access_missing redirect_elsewhere team_mismatch; do
    if cf_access_transient "$state"; then false; fi
  done
}

@test "cf_access_verdict: the panel answering by itself means Access is missing" {
  verdict 0 200 '' ''
  [ "$STATE" = access_missing ]
  [[ $MESSAGE == *"answers 200 without Cloudflare Access"*"self-hosted Access application for cf.example.com"* ]]
  verdict 0 401 '' 'Basic realm="x"'
  [ "$STATE" = access_missing ]
  # A team domain in the query of another host is not Access.
  verdict 0 302 "https://login.example.net/?next=team-x.cloudflareaccess.com" ''
  [ "$STATE" = redirect_elsewhere ] && [[ $MESSAGE == *"redirects to https://login.example.net,"* ]]
}

@test "cf_access_check asks https://<host>/api/health once, without cookies or redirects" {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  cat >"$BATS_TEST_TMPDIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CURL_LOG"
[ "${STUB_CURL_EXIT:-0}" = 0 ] || { printf '000\037\037'; exit "$STUB_CURL_EXIT"; }
printf '%s\037%s\037%s' "$STUB_CODE" "${STUB_LOCATION:-}" "${STUB_AUTH:-}"
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/curl"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH" CURL_LOG=$BATS_TEST_TMPDIR/curl.log
  STUB_CODE=302 STUB_LOCATION=$LOGIN run cf_access_check cf.example.com 8080 "$ISSUER"
  [[ $output == ok$'\t'team-x.cloudflareaccess.com$'\t'* ]]
  grep -qx 'https://cf.example.com/api/health' "$CURL_LOG"
  grep -qx -- '--max-time' "$CURL_LOG"
  run grep -cE -- '^(-L|--location|-b|--cookie|-c|--cookie-jar)$' "$CURL_LOG"
  [ "$output" = 0 ]
  # An empty redirect URL between two fields does not shift the header into its place.
  STUB_CODE=401 STUB_AUTH='Bearer realm="https://team-x.cloudflareaccess.com"' run cf_access_check cf.example.com 8080 "$ISSUER"
  [[ $output == ok$'\t'* ]]
  STUB_CURL_EXIT=6 run cf_access_check cf.example.com 8080 "$ISSUER"
  [[ $output == dns_missing$'\t'* ]]
}
