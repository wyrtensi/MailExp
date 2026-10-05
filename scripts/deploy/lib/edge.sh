# shellcheck shell=bash
# Files of the edge compose project in <prefix>/edge: compose.yml (copied from the checkout),
# Caddyfile (rendered from deploy/edge/Caddyfile.tmpl) and the non-secret keys of edge/.env.

# caddy_site_address <host>: the parent zone wildcard for hosts with three or more labels, which
# keeps the exact host name out of certificate transparency logs; otherwise the host itself.
caddy_site_address() {
  local parent=${1#*.}
  if [[ $parent == *.* ]]; then
    printf '*.%s\n' "$parent"
  else
    printf '%s\n' "$1"
  fi
}

# render_caddyfile <template>: the Caddyfile for CFG_DIRECT_HOST on stdout.
render_caddyfile() {
  local text issuer global='' site
  text=$(<"$1") || die "cannot read $1"
  case $CFG_EDGE_TLS in
    acme) issuer='dns cloudflare {env.DNS_API_TOKEN}' ;;
    internal) issuer='issuer internal' ;;
    *) die "unknown edge TLS mode: $CFG_EDGE_TLS" ;;
  esac
  if [ -n "$CFG_ACME_EMAIL" ]; then global="email $CFG_ACME_EMAIL"; fi
  site=$(caddy_site_address "$CFG_DIRECT_HOST")
  text=${text//@GLOBAL_EMAIL@/"$global"}
  text=${text//@SITE@/"$site"}
  text=${text//@DIRECT_HOST@/"$CFG_DIRECT_HOST"}
  text=${text//@HTTP_PORT@/"$CFG_HTTP_PORT"}
  text=${text//@TLS_ISSUER@/"$issuer"}
  printf '%s\n' "$text"
}

# write_edge_files <app dir> <edge dir> <edge image>. Whether Caddy has loaded the Caddyfile is
# decided by caddy_restart_needed, not here: a run can stop between writing and restarting.
write_edge_files() {
  local app_dir=$1 edge_dir=$2 image=$3 env=$2/.env new
  mkdir -p "$edge_dir"
  chmod 700 "$edge_dir"
  cp "$app_dir/deploy/edge/compose.yml" "$edge_dir/compose.yml"
  env_set "$env" COMPOSE_PROJECT_NAME "$CFG_EDGE_PROJECT"
  new=$(edge_profiles)
  env_set "$env" COMPOSE_PROFILES "$new"
  env_set "$env" EDGE_IMAGE "$image"
  if edge_services | grep -qx caddy; then
    new=$(render_caddyfile "$app_dir/deploy/edge/Caddyfile.tmpl")
    if [ ! -f "$edge_dir/Caddyfile" ] || [ "$new" != "$(<"$edge_dir/Caddyfile")" ]; then
      printf '%s\n' "$new" >"$edge_dir/Caddyfile"
    fi
  fi
}

# caddy_restart_needed <Caddyfile> <applied record> <container existed before up 0|1>: status 0
# when the running Caddy may still serve an older Caddyfile. The record holds the hash of the
# Caddyfile that Caddy last loaded and is written only after a successful start or restart, so
# a run that stops in between leaves the restart to the next run.
caddy_restart_needed() {
  local file=$1 record=$2 existed=$3 applied
  [ "$existed" = 1 ] || return 1
  applied=$(cat "$record" 2>/dev/null) || return 0
  [ "$applied" != "$(sha256sum <"$file")" ]
}

# caddy_record_applied <Caddyfile> <applied record>
caddy_record_applied() {
  local file=$1 record=$2 tmp
  tmp=$(mktemp "$record.XXXXXX")
  chmod 600 "$tmp"
  sha256sum <"$file" >"$tmp"
  mv -f "$tmp" "$record"
}

# --- Cloudflare Access in front of <CF_HOST> (install.sh verify_edge, status.sh) ---
#
# An unauthenticated request to a host behind Access is answered by Cloudflare itself: a redirect
# to https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/login/..., or, with Access's managed OAuth
# on, 401 with a WWW-Authenticate header whose resource_metadata points to
# https://<host>/.well-known/oauth-protected-resource (the team is then not named, so it is not
# compared). Either proves that the host
# resolves to Cloudflare and that an Access application covers it. It does not prove the tunnel
# route: Access answers before the request reaches the tunnel. Only a signed-in visit does that.

# cf_access_probe <host>: one request to https://<host>/api/health without cookies and without
# following redirects. Prints "<curl exit> <http code> <redirect url> <www-authenticate>",
# separated by CF_PROBE_SEP (not a tab: read would merge the empty fields between tabs).
# %header{} needs curl 7.84 or newer (Ubuntu 24.04 has 8.5).
CF_PROBE_SEP=$'\x1f'
cf_access_probe() {
  local out status=0 s=$CF_PROBE_SEP
  out=$(curl -sS -o /dev/null --max-time 10 --proto '=https' -H 'Accept: text/html' \
    -w "%{http_code}$s%{redirect_url}$s%header{www-authenticate}" "https://$1/api/health" 2>/dev/null) || status=$?
  printf '%s%s%s\n' "$status" "$s" "$out"
}

# cf_team_host <text>: the first <team>.cloudflareaccess.com host in it, lower-cased.
cf_team_host() {
  grep -oiE '[a-z0-9-]+\.cloudflareaccess\.com' <<<"$1" | head -n 1 | tr '[:upper:]' '[:lower:]' || true
}

# cf_redirect_team <redirect url>: the host of the URL when it is <team>.cloudflareaccess.com,
# empty otherwise (a team domain in the query of another host does not count).
cf_redirect_team() {
  local host
  host=$(sed -E 's#^[A-Za-z]+://([^/:?#]+).*#\1#' <<<"$1" | tr '[:upper:]' '[:lower:]')
  if [[ $host =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]]; then printf '%s\n' "$host"; fi
  return 0
}

# cf_oauth_resource_metadata <www-authenticate> <host>: status 0 when the header points to the
# OAuth protected resource metadata of <host> itself, as Access's managed OAuth answers a client it
# takes for a non-browser one (resource_metadata="https://<host>/.well-known/oauth-protected-resource").
cf_oauth_resource_metadata() {
  local auth=${1,,}
  auth=${auth//\"/}
  [[ $auth == *"resource_metadata=https://$2/.well-known/oauth-protected-resource"* ]]
}

# cf_access_verdict <curl exit> <http code> <redirect url> <www-authenticate> <host> <port>
# <CF_ACCESS_ISSUER or empty>: prints "<state>\t<team host or ->\t<message>". States: ok,
# dns_missing, unreachable, tunnel_down, origin_error, access_missing, redirect_elsewhere,
# team_mismatch. Every message but ok names the next step. Without an issuer (--local-auth) the
# team is not compared.
cf_access_verdict() {
  local rc=$1 code=$2 location=$3 auth=$4 host=$5 port=$6 issuer=$7 team='' want=''
  local route="the tunnel's public hostname (published application route) $host -> http://127.0.0.1:$port"
  if [ -n "$issuer" ]; then want=$(cf_team_host "$issuer"); fi
  if [ "$rc" = 6 ]; then
    printf 'dns_missing\t-\t%s does not resolve: add %s in Zero Trust, which creates the DNS record; if it was just added, DNS may still be propagating: run status.sh again in a few minutes\n' "$host" "$route"
    return 0
  fi
  if [ "$rc" != 0 ]; then
    printf 'unreachable\t-\thttps://%s cannot be reached (curl exit %s): check that its DNS record is proxied by Cloudflare (orange cloud) and that this server has outbound HTTPS\n' "$host" "$rc"
    return 0
  fi
  case $code in
    3??) team=$(cf_redirect_team "$location") ;;
    401) team=$(cf_team_host "$auth") ;;
  esac
  if [ -z "$team" ] && [ "$code" = 401 ] && cf_oauth_resource_metadata "$auth" "$host"; then
    printf 'ok\t-\thttps://%s is behind Cloudflare Access (managed OAuth answered; it does not name the team, so CF_ACCESS_ISSUER was not compared); this does not test the tunnel route itself: sign in once to see the panel\n' "$host"
    return 0
  fi
  if [ -z "$team" ]; then
    case $code in
      530)
        printf 'tunnel_down\t-\tCloudflare answers 530 (error 1033) for %s: no running connector serves it; check the cloudflared logs and that %s is a route of the tunnel whose token this server has\n' "$host" "$host"
        ;;
      502 | 503 | 504)
        printf 'origin_error\t-\tCloudflare answers %s for %s: the tunnel does not reach the panel; the route must point to http://127.0.0.1:%s and the panel must be running\n' "$code" "$host" "$port"
        ;;
      3??)
        printf 'redirect_elsewhere\t-\thttps://%s redirects to %s, not to Cloudflare Access: create the self-hosted Access application for %s (docs/operations/cloudflare.md)\n' "$host" "$(cut -d/ -f1-3 <<<"$location")" "$host"
        ;;
      *)
        printf 'access_missing\t-\thttps://%s/api/health answers %s without Cloudflare Access: create the self-hosted Access application for %s with an Allow policy (docs/operations/cloudflare.md); until then nothing checks who signs in there (a 403 can also be a Cloudflare security rule answering first)\n' "$host" "$code" "$host"
        ;;
    esac
    return 0
  fi
  if [ -n "$want" ] && [ "$team" != "$want" ]; then
    printf 'team_mismatch\t%s\tAccess for %s belongs to %s, but CF_ACCESS_ISSUER names %s: every sign-in would be refused as an invalid identity token; store CF_ACCESS_ISSUER=https://%s with configure.sh and run install.sh again\n' "$team" "$host" "$team" "$want" "$team"
    return 0
  fi
  printf 'ok\t%s\thttps://%s is behind Cloudflare Access (%s); this does not test the tunnel route itself: sign in once to see the panel\n' "$team" "$host" "$team"
}

# cf_access_check <host> <port> <CF_ACCESS_ISSUER or empty>: probe and verdict, one line as
# cf_access_verdict prints it.
cf_access_check() {
  local rc code location auth
  IFS=$CF_PROBE_SEP read -r rc code location auth < <(cf_access_probe "$1")
  cf_access_verdict "$rc" "${code:-000}" "${location:-}" "${auth:-}" "$1" "$2" "$3"
}

# cf_access_transient <state>: status 0 for the states a short wait can fix (DNS, the connector
# coming up); a missing Access application or a wrong team needs a person.
cf_access_transient() {
  case $1 in dns_missing | unreachable | tunnel_down | origin_error) return 0 ;; esac
  return 1
}

# cf_access_wait <host> <port> <CF_ACCESS_ISSUER or empty> <timeout seconds> [interval, default 5]:
# install.sh's check. Repeats cf_access_check while the state is one time can fix and the timeout
# has not passed; logs an ok, warns about anything else with its next step. Never fails: DNS and
# the connector can take minutes, and status.sh repeats the check.
cf_access_wait() {
  local host=$1 port=$2 issuer=$3 interval=${5:-5} state team message deadline=$((SECONDS + $4))
  while :; do
    IFS=$'\t' read -r state team message < <(cf_access_check "$host" "$port" "$issuer")
    if [ "$state" = ok ]; then
      log "edge: $message"
      return 0
    fi
    if ! cf_access_transient "$state" || [ "$SECONDS" -ge "$deadline" ]; then break; fi
    sleep "$interval"
  done
  warn "edge: $message"
  warn "edge: the install goes on; check again later with status.sh (docs/operations/cloudflare.md)"
  return 0
}
