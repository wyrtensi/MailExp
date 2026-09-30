#!/usr/bin/env bash
# Local stand: the whole product on one "server" the size of the target VPS (4 CPUs, 8 GB), for
# trying it by hand. The server is one Docker-in-Docker container, me-stage, with:
# - mailcow (pinned release) as mail.test.local, with a certificate from a stand CA and the node
#   settings of docs/operations/mail-node.md;
# - the panel from the published images, with the production limits of deploy/compose.prod.yml,
#   behind Caddy with its own certificate on https://localhost (port 443 of this computer only).
# Its inner Docker lives in the volume me-stage-docker, so the stand survives a restart of Docker.
#
#   scripts/deploy/test/stage.sh up [--version sha-<12>]   the server, mailcow, the panel, the admin
#   scripts/deploy/test/stage.sh panel [--version sha-<12>] update the panel to another build
#   scripts/deploy/test/stage.sh status
#   scripts/deploy/test/stage.sh down [--purge]             remove the server (--purge: and its data)
#   scripts/deploy/test/stage.sh eop up|down|status|mode|connector|list|inject|logs|queue
#                                   fake Exchange Online Protection as mailcow's relayhost (see below)
#   scripts/deploy/test/stage.sh dns up|down|status|variant <name>|query <type> <name>
#                                   DNS fixtures for the zone stage.test (opt-in, see below)
#
# Secrets live in data/stage.env (ignored by git), written on the first run: the panel's
# SESSION_SECRET, ENCRYPTION_KEY and DB_PASSWORD, the mailcow API key, and the panel's first
# administrator (PANEL_ADMIN_USER, PANEL_ADMIN_PASSWORD; local sign-in). up connects the panel
# to mailcow and adds the domain stage.test. Mail from outside never reaches the stand.
# --version defaults to the checked-out commit, whose images CI publishes after a merge to main.
# Needs about 8 GB of memory for Docker. From Git Bash on Windows it runs as is.
#
# eop and dns work on a stand that is already running and change nothing of it that another command
# needs: eop up starts the container fake-eop (scripts/deploy/test/fake-eop) on mailcow's network as
# eop.test.local and sets relayhost = eop.test.local in mailcow's extra.cf, so all outgoing mail goes
# to it like to EOP; eop down takes the relayhost out again and removes the container. dns starts
# the container stage-dns with the zone stage.test. Both take their files from the repository this
# script is in (a worktree works), and neither reads data/stage.env.
set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$TEST_DIR/../../.." && pwd)
# shellcheck source=../lib/common.sh
. "$TEST_DIR/../lib/common.sh"

NAME=me-stage
VOLUME=me-stage-docker
DIND_IMAGE=docker:29.8.1-dind
CADDY_IMAGE=caddy:2.10-alpine
MAILCOW_REF=2026-09
MAIL_HOST=mail.test.local
DOMAIN=stage.test
URL=https://localhost
STAGE_ENV=$REPO_DIR/data/stage.env
MAILCOW_DIR=/opt/mailcow
MAILCOW_NET=mailcowdockerized_mailcow-network
POSTFIX=mailcowdockerized-postfix-mailcow-1
EOP_NAME=fake-eop
EOP_HOST=eop.test.local
EOP_IMAGE=node:22.20-alpine
DNS_NAME=stage-dns
DNS_IMAGE=alpine:3.22

# Git Bash would rewrite container paths such as /opt for docker.exe; git.exe needs them rewritten.
dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
inner() { dk exec "$NAME" sh -c "$1"; }
running() { [ "$(dk container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ]; }
# The panel as the browser sees it, asked from inside the server, which has curl and jq (the host
# may have no jq): Caddy's 443 is published there as 9443.
panel_sha() { inner "curl -fsk --resolve localhost:9443:127.0.0.1 https://localhost:9443/api/version | jq -r .sha" 2>/dev/null || true; }

stage_env() {
  if [ ! -f "$STAGE_ENV" ]; then
    mkdir -p "$(dirname "$STAGE_ENV")"
    printf '%s\n' "SESSION_SECRET=$(gen_hex 32)" "ENCRYPTION_KEY=$(gen_hex 32)" "DB_PASSWORD=$(gen_hex 24)" \
      "MAILCOW_API_KEY=$(gen_hex 16)-$(gen_hex 8)" PANEL_ADMIN_USER=admin "PANEL_ADMIN_PASSWORD=$(gen_hex 12)" >"$STAGE_ENV"
    log "secrets written to $STAGE_ENV"
  fi
  # shellcheck disable=SC1090 # generated above
  . "$STAGE_ENV"
}

start_server() {
  if dk container inspect "$NAME" >/dev/null 2>&1; then die "$NAME already exists; remove it with: $0 down" 2; fi
  log "starting $NAME (4 CPUs, 8 GB)"
  dk volume create "$VOLUME" >/dev/null
  dk run -d --privileged --name "$NAME" --restart unless-stopped \
    --cpuset-cpus 0-3 --cpus 4 --memory 8g --memory-swap 10g \
    -p 127.0.0.1:443:9443 -v "$VOLUME:/var/lib/docker" "$DIND_IMAGE" >/dev/null
  for _ in $(seq 60); do
    if dk exec "$NAME" docker info >/dev/null 2>&1; then break; fi
    sleep 1
  done
  dk exec "$NAME" docker info >/dev/null 2>&1 || die "the inner docker daemon did not start"
  # mailcow's generate_config.sh refuses BusyBox tools.
  inner 'apk add --no-cache --quiet bash git curl openssl jq coreutils iproute2 findutils grep sed gawk >/dev/null'
}

start_mailcow() {
  log "configuring mailcow $MAILCOW_REF as $MAIL_HOST"
  inner "git clone -q --depth 1 -c advice.detachedHead=false -b $MAILCOW_REF https://github.com/mailcow/mailcow-dockerized /opt/mailcow"
  inner "cd /opt/mailcow && ln -sf mailcow.conf .env && MAILCOW_HOSTNAME=$MAIL_HOST MAILCOW_TZ=UTC SKIP_CLAMD=y ./generate_config.sh --dev </dev/null >/dev/null 2>&1"
  # The recursive resolver cannot reach the root servers from inside Docker Desktop; delivery
  # between the stand's own mailboxes needs no outside DNS. ENABLE_IPV6=false as the runbook
  # (docs/operations/mail-node.md, section 3) sets it: generate_config.sh turns IPv6 on whenever the
  # host has it, and the node's firewall rules are IPv4 only.
  inner "cd /opt/mailcow && sed -i \
    -e 's/^SKIP_LETS_ENCRYPT=n/SKIP_LETS_ENCRYPT=y/' -e 's/^SKIP_FTS=n/SKIP_FTS=y/' -e 's/^SKIP_OLEFY=n/SKIP_OLEFY=y/' \
    -e 's/^SKIP_CLAMD=n/SKIP_CLAMD=y/' -e 's/^SKIP_UNBOUND_HEALTHCHECK=n/SKIP_UNBOUND_HEALTHCHECK=y/' \
    -e 's/^ENABLE_IPV6=.*/ENABLE_IPV6=false/' \
    -e 's|^#API_KEY=\$|API_KEY=$MAILCOW_API_KEY|' -e 's|^#API_ALLOW_FROM=.*|API_ALLOW_FROM=172.16.0.0/12,127.0.0.1|' mailcow.conf"
  inner "grep -q '^API_KEY=$MAILCOW_API_KEY\$' /opt/mailcow/mailcow.conf" || die "mailcow.conf has no API_KEY line to set"
  inner "grep -q '^ENABLE_IPV6=false\$' /opt/mailcow/mailcow.conf" || die "mailcow.conf has no ENABLE_IPV6 line to set"
  log "issuing the stand CA and a certificate for $MAIL_HOST"
  inner "mkdir -p /opt/testca && cd /opt/testca \
    && openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj '/CN=MailExpert stand CA' 2>/dev/null \
    && openssl req -newkey rsa:2048 -nodes -keyout key.pem -out req.csr -subj '/CN=$MAIL_HOST' 2>/dev/null \
    && printf 'subjectAltName=DNS:$MAIL_HOST\nextendedKeyUsage=serverAuth\n' > ext.cnf \
    && openssl x509 -req -in req.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out cert.pem -days 825 -extfile ext.cnf 2>/dev/null \
    && cp cert.pem key.pem /opt/mailcow/data/assets/ssl/"
  dk exec -i "$NAME" sh -c 'cat >> /opt/mailcow/data/conf/dovecot/extra.conf' <"$REPO_DIR/scripts/deploy/mail-node/dovecot-extra.conf"
  log "starting mailcow (pulls its images)"
  inner 'cd /opt/mailcow && docker compose pull -q >/dev/null 2>&1 && docker compose up -d >/dev/null 2>&1'
  for _ in $(seq 90); do
    if inner "curl -fsS --cacert /opt/testca/ca.pem --resolve $MAIL_HOST:443:127.0.0.1 -H 'X-API-Key: $MAILCOW_API_KEY' \
      https://$MAIL_HOST/api/v1/get/status/version >/dev/null 2>&1"; then
      log "mailcow API answers"
      return 0
    fi
    sleep 5
  done
  die "the mailcow API did not answer"
}

start_panel() {
  local version=$1
  running || die "$NAME is not running; start it with: $0 up" 2
  log "copying the repository at $(git -C "$REPO_DIR" rev-parse --short HEAD) into $NAME:/opt/app"
  inner 'rm -rf /opt/app.new && mkdir -p /opt/app.new'
  git -C "$REPO_DIR" archive HEAD | dk exec -i "$NAME" tar -x -C /opt/app.new
  inner 'if [ -d /opt/app/certs ]; then cp -r /opt/app/certs /opt/app.new/; fi; rm -rf /opt/app && mv /opt/app.new /opt/app'
  # The frontend's nginx still loads a certificate for its own 443, which nothing reaches here.
  inner '[ -f /opt/app/certs/cert.pem ] || { mkdir -p /opt/app/certs && openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /opt/app/certs/key.pem -out /opt/app/certs/cert.pem -days 3650 -subj /CN=frontend 2>/dev/null; }'
  { printf '%s\n' "SESSION_SECRET=$SESSION_SECRET" "ENCRYPTION_KEY=$ENCRYPTION_KEY" "DB_PASSWORD=$DB_PASSWORD" \
      "MAILEXPERT_VERSION=$version" MAILEXPERT_IMAGE_PREFIX=ghcr.io/wyrtensi COMPOSE_PROJECT_NAME=stage \
      APP_HTTP_PORT=8080 "APP_URL=$URL" AUTH_MODE=local "GOOGLE_REDIRECT_URI=$URL/oauth/google/callback"
  } | dk exec -i "$NAME" sh -c 'umask 077 && cat > /opt/app/.env'
  dk exec -i "$NAME" sh -c 'cat > /opt/app/Caddyfile.stage' <<'CADDY'
localhost {
	tls internal
	reverse_proxy frontend:80
}
CADDY
  # stage-edge, not caddy: docker-compose.yml has its own caddy service (profile https).
  dk exec -i "$NAME" sh -c 'cat > /opt/app/stage.override.yml' <<YAML
services:
  backend:
    extra_hosts:
      - "$MAIL_HOST:host-gateway"
    volumes:
      - /opt/testca/ca.pem:/ca/ca.pem:ro
    environment:
      NODE_EXTRA_CA_CERTS: /ca/ca.pem
  stage-edge:
    image: $CADDY_IMAGE
    restart: unless-stopped
    ports:
      - "9443:443"
    volumes:
      - ./Caddyfile.stage:/etc/caddy/Caddyfile:ro
      - stage_edge_data:/data
    depends_on:
      - frontend
    networks:
      - mailexpert
volumes:
  stage_edge_data:
YAML
  log "starting the panel $version"
  inner 'cd /opt/app && docker compose --env-file .env -f docker-compose.yml -f deploy/compose.prod.yml -f stage.override.yml \
    up -d --quiet-pull --remove-orphans >/dev/null 2>&1' || die "docker compose up failed; see: docker exec $NAME sh -c 'cd /opt/app && docker compose logs'"
  for _ in $(seq 60); do
    if [ -n "$(panel_sha)" ]; then
      log "panel answers on $URL"
      return 0
    fi
    sleep 3
  done
  die "the panel did not answer on $URL"
}

# The first administrator (the first user to register becomes one), the mail node and its domain.
# Runs inside the server (curl and jq); the secrets reach it on stdin, never as arguments.
setup_panel() {
  local out
  printf '%s\n' "U=$PANEL_ADMIN_USER" "P=$PANEL_ADMIN_PASSWORD" "K=$MAILCOW_API_KEY" "H=$MAIL_HOST" "D=$DOMAIN" "O=$URL" |
    dk exec -i "$NAME" sh -c 'umask 077 && cat > /tmp/stage-setup.env'
  out=$(dk exec -i "$NAME" sh -s <<'SETUP'
. /tmp/stage-setup.env
rm -f /tmp/stage-setup.env
jar=$(mktemp)
api() {
  curl -sk --resolve localhost:9443:127.0.0.1 -b "$jar" -c "$jar" -o /dev/null -w '%{http_code}' -X "$1" \
    -H 'Content-Type: application/json' -H "Origin: $O" -H 'X-Requested-With: XMLHttpRequest' \
    --data-binary @- "https://localhost:9443$2"
}
login=$(jq -n --arg u "$U" --arg p "$P" '{username: $u, password: $p}')
echo "register $(echo "$login" | api POST /api/auth/register)"
echo "login $(echo "$login" | api POST /api/auth/login)"
echo "node $(jq -n --arg h "$H" --arg k "$K" '{mailHost: $h, apiKey: $k, quotaMb: 5120}' | api PUT /api/mail-node/config)"
echo "domain $(jq -n --arg d "$D" '{domain: $d, mailboxes: 500}' | api POST /api/mail-node/domains)"
rm -f "$jar"
SETUP
)
  grep -qx 'login 200' <<<"$out" || die "cannot sign in as $PANEL_ADMIN_USER (see $STAGE_ENV)"
  grep -qx 'node 200' <<<"$out" || die "the panel refused the mail node settings"
  grep -qx 'domain 200' <<<"$out" || warn "could not add the domain $DOMAIN (it may exist already)"
  log "signed in as $PANEL_ADMIN_USER; mail node $MAIL_HOST with the domain $DOMAIN"
}

# --- fake EOP as mailcow's relayhost -------------------------------------------------------------
# A container in mailcow's compose network that accepts mail the way Exchange Online Protection
# does for an on-premises connector (see fake-eop/eop.mjs), and the relayhost line that sends
# mailcow's outgoing mail to it. Nothing here touches mailcow's data beyond extra.cf.

EXTRA_CF=$MAILCOW_DIR/data/conf/postfix/extra.cf
# extra-cf.sh runs inside the server, fed on stdin: the script keeps every other line of the file.
extra_cf() { dk exec -i "$NAME" sh -s -- "$@" <"$TEST_DIR/fake-eop/extra-cf.sh"; }
eop_ctl() { dk exec "$NAME" docker exec "$EOP_NAME" node /app/eop.mjs "$@"; }
postfix_relayhost() { inner "docker exec $POSTFIX postconf -h relayhost 2>/dev/null" | tr -d '\r'; }

# relayhost_apply <host>: sets relayhost in extra.cf ("" removes it) and restarts postfix-mailcow
# unless it already runs with that value. Other lines of extra.cf stay as they are.
relayhost_apply() {
  local want=$1 live=''
  if [ -n "$want" ]; then extra_cf set "$EXTRA_CF" relayhost "$want"; else extra_cf unset "$EXTRA_CF" relayhost; fi
  if [ "$(postfix_relayhost)" = "$want" ]; then
    log "postfix-mailcow already runs with relayhost '$want'"
    return 0
  fi
  log "restarting postfix-mailcow with relayhost '$want'"
  inner "cd $MAILCOW_DIR && docker compose restart postfix-mailcow >/dev/null 2>&1" || die "postfix-mailcow did not restart"
  for _ in $(seq 30); do
    live=$(postfix_relayhost 2>/dev/null || true)
    if [ "$live" = "$want" ] && inner "docker exec $POSTFIX postfix status >/dev/null 2>&1"; then return 0; fi
    sleep 2
  done
  die "postfix-mailcow did not come back with relayhost '$want' (it has '$live')"
}

eop_up() {
  inner "docker network inspect $MAILCOW_NET >/dev/null 2>&1" || die "mailcow's network $MAILCOW_NET does not exist; is the stand up? ($0 status)"
  log "copying fake-EOP into $NAME:/opt/fake-eop"
  inner 'rm -rf /opt/fake-eop && mkdir -p /opt/fake-eop /opt/fake-eop-data/tls'
  tar -C "$TEST_DIR/fake-eop" -c eop.mjs lib.mjs server.mjs | dk exec -i "$NAME" tar -x -C /opt/fake-eop
  # A certificate for eop.test.local from the stand CA; the CA key never leaves /opt/testca.
  inner "cd /opt/testca && { [ -f eop.crt ] || { openssl req -newkey rsa:2048 -nodes -keyout eop.key -out eop.csr -subj '/CN=$EOP_HOST' 2>/dev/null \
    && printf 'subjectAltName=DNS:$EOP_HOST\nextendedKeyUsage=serverAuth\n' > eop.cnf \
    && openssl x509 -req -in eop.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out eop.crt -days 825 -extfile eop.cnf 2>/dev/null; }; } \
    && cp eop.crt eop.key ca.pem /opt/fake-eop-data/tls/" || die "could not issue the certificate of $EOP_HOST"
  log "starting $EOP_NAME ($EOP_IMAGE) as $EOP_HOST in $MAILCOW_NET"
  inner "docker pull -q $EOP_IMAGE >/dev/null && { docker rm -f $EOP_NAME >/dev/null 2>&1 || true; } \
    && docker run -d --name $EOP_NAME --restart unless-stopped --network $MAILCOW_NET --network-alias $EOP_HOST --memory 128m \
      -e EOP_CONNECTOR=$MAIL_HOST -v /opt/fake-eop:/app:ro -v /opt/fake-eop-data:/data $EOP_IMAGE node /app/eop.mjs serve >/dev/null" \
    || die "could not start $EOP_NAME"
  for _ in $(seq 20); do
    if inner "docker logs $EOP_NAME 2>&1 | grep -q event=listen"; then break; fi
    sleep 1
  done
  inner "docker logs $EOP_NAME 2>&1 | grep -q event=listen" || die "$EOP_NAME did not start listening; see: $0 eop logs"
  relayhost_apply "$EOP_HOST"
  log "outgoing mail of the stand now goes to $EOP_NAME; try: $0 eop send, then $0 eop logs and $0 eop relaylog"
}

eop_down() {
  relayhost_apply ''
  inner "docker rm -f $EOP_NAME >/dev/null 2>&1 || true"
  log "removed $EOP_NAME and the relayhost; its spool stays in $NAME:/opt/fake-eop-data"
}

eop_status() {
  local state
  state=$(inner "docker inspect -f '{{.State.Status}}' $EOP_NAME 2>/dev/null" | tr -d '\r\n' || true)
  printf 'fake-EOP: %s\n' "${state:-not created}"
  if [ "$state" = running ]; then eop_ctl status; fi
  printf 'extra.cf relayhost: %s\n' "$(extra_cf get "$EXTRA_CF" relayhost 2>/dev/null || echo '(none)')"
  printf 'postfix-mailcow relayhost: %s\n' "$(postfix_relayhost)"
}

eop_main() {
  running || die "$NAME is not running; start it with: $0 up" 2
  local sub=${1:-}
  [ $# -gt 0 ] && shift
  case $sub in
    up) eop_up ;;
    down) eop_down ;;
    status) eop_status ;;
    # mode <accept|tempfail|blocked-connector|tenant-limit|recipient-denied|drop> [--stage mail|rcpt|data]
    mode) [ $# -ge 1 ] || die "usage: $0 eop mode <mode> [--stage mail|rcpt|data]" 2; eop_ctl mode "$@" ;;
    connector) [ $# -eq 1 ] || die "usage: $0 eop connector <name the client certificate must carry>" 2; eop_ctl connector "$1" ;;
    list) eop_ctl list ;;
    show) eop_ctl show "${1:-latest}" ;;
    clear) eop_ctl clear ;;
    # inject <id|latest> [verdict] [--to a@b] [--auth pass|fail] [--folded]
    inject)
      local id=${1:-latest} verdict=spam
      [ $# -gt 0 ] && shift
      if [ $# -gt 0 ] && [[ $1 != --* ]]; then verdict=$1 && shift; fi
      eop_ctl inject "$id" --verdict "$verdict" "$@"
      ;;
    # send [from] [to]: one message from inside postfix-mailcow, the way a mailbox's mail arrives there.
    send)
      local from=${1:-someone@$DOMAIN} to=${2:-test@example.com}
      printf 'From: %s\nTo: %s\nSubject: stage eop test %s\n\nSent by stage.sh eop send.\n' "$from" "$to" "$(date +%H:%M:%S)" |
        dk exec -i "$NAME" docker exec -i "$POSTFIX" sendmail -f "$from" "$to"
      log "submitted $from -> $to"
      ;;
    logs) inner "docker logs --tail ${1:-50} $EOP_NAME 2>&1" ;;
    relaylog) inner "docker logs --tail ${1:-300} $POSTFIX 2>&1 | grep -E 'relay=|status=|TLS connection|TLS connection established' | tail -n 30" ;;
    queue) inner "docker exec $POSTFIX postqueue -p" ;;
    *) die "usage: $0 eop up|down|status|mode <mode> [--stage s]|connector <name>|list|show [id]|clear|inject <id> [verdict] [--to a@b]|send [from] [to]|logs [n]|relaylog [n]|queue" 2 ;;
  esac
}

# --- DNS fixtures for the zone stage.test ---------------------------------------------------------
# dnsmasq in the container stage-dns answers for stage.test (MX, SPF, DKIM, DMARC, MS=, and the node's
# A and PTR) from stand-dns/zone.sh, in a good variant and several broken ones. It is opt-in: nothing
# uses it until a client is pointed at its address (`dns status`), so the panel and mailcow keep
# resolving real hosts as before. The panel's DNS check (R-14) takes the address as its resolver.

dns_running() { [ "$(inner "docker inspect -f '{{.State.Running}}' $DNS_NAME 2>/dev/null" | tr -d '\r')" = true ]; }
dns_ip() { inner "docker inspect -f '{{.NetworkSettings.Networks.stage_mailexpert.IPAddress}}' $DNS_NAME" | tr -d '\r'; }

dns_variant() {
  local variant=$1 key
  inner 'mkdir -p /opt/stage-dns && { [ -s /opt/stage-dns/dkim.pub ] || openssl genrsa 2048 2>/dev/null | openssl rsa -pubout -outform DER 2>/dev/null | base64 -w0 > /opt/stage-dns/dkim.pub; }'
  key=$(inner 'cat /opt/stage-dns/dkim.pub' | tr -d '\r')
  sh "$TEST_DIR/stand-dns/zone.sh" "$variant" "$key" | dk exec -i "$NAME" sh -c 'cat > /opt/stage-dns/stage.conf'
  if dns_running; then
    inner "docker restart $DNS_NAME >/dev/null"
    dns_wait
  fi
  log "stage.test zone: variant $variant"
}

# dns_wait: until dnsmasq answers (the container installs it on each start, which takes a moment).
dns_wait() {
  for _ in $(seq 30); do
    if inner "docker exec $DNS_NAME nslookup -type=MX $DOMAIN 127.0.0.1 2>/dev/null | grep -q -e 'mail exchanger' -e 'NXDOMAIN' -e 'No answer'"; then return 0; fi
    sleep 1
  done
  die "$DNS_NAME did not answer; see: docker exec $NAME docker logs $DNS_NAME"
}

dns_up() {
  local variant=${1:-ok}
  dns_variant "$variant"
  log "starting $DNS_NAME ($DNS_IMAGE with dnsmasq)"
  inner "{ docker rm -f $DNS_NAME >/dev/null 2>&1 || true; } && docker run -d --name $DNS_NAME --restart unless-stopped --network stage_mailexpert --memory 64m \
    -v /opt/stage-dns:/etc/stage-dns:ro $DNS_IMAGE sh -c 'apk add -q --no-cache dnsmasq >/dev/null && exec dnsmasq -k -C /etc/stage-dns/stage.conf' >/dev/null \
    && docker network connect $MAILCOW_NET $DNS_NAME" || die "could not start $DNS_NAME"
  dns_wait
  log "$DNS_NAME answers for $DOMAIN on $(dns_ip):53 (stage_mailexpert network, name $DNS_NAME)"
}

dns_main() {
  running || die "$NAME is not running; start it with: $0 up" 2
  local sub=${1:-}
  [ $# -gt 0 ] && shift
  case $sub in
    up) dns_up "${1:-ok}" ;;
    down) inner "docker rm -f $DNS_NAME >/dev/null 2>&1 || true"; log "removed $DNS_NAME" ;;
    variant)
      [ $# -eq 1 ] || die "usage: $0 dns variant <name>; one of: $(sh "$TEST_DIR/stand-dns/zone.sh" variants)" 2
      dns_running || die "$DNS_NAME is not running; start it with: $0 dns up" 2
      dns_variant "$1"
      ;;
    status)
      if dns_running; then
        printf 'stage-dns: running, %s:53\n' "$(dns_ip)"
        inner 'head -n 1 /opt/stage-dns/stage.conf'
      else
        echo 'stage-dns: not running'
      fi
      ;;
    query)
      [ $# -eq 2 ] || die "usage: $0 dns query <type> <name>" 2
      [[ $1 =~ ^[A-Za-z]+$ && $2 =~ ^[A-Za-z0-9._-]+$ ]] || die "bad type or name" 2
      inner "docker exec $DNS_NAME nslookup -type=$1 $2 127.0.0.1"
      ;;
    *) die "usage: $0 dns up [variant]|down|status|variant <name>|query <type> <name>" 2 ;;
  esac
}

status() {
  running || { log "$NAME is not running"; return 0; }
  dk stats --no-stream --format 'server: {{.MemUsage}} memory, {{.CPUPerc}} CPU' "$NAME"
  printf 'panel: %s, build %s\n' "$URL" "$(panel_sha)"
  inner 'docker ps --format "{{.Names}}\t{{.Status}}"' | sort
}

main() {
  local command=${1:-} version='' purge=0
  [ $# -gt 0 ] && shift
  # eop and dns have subcommands of their own and need neither the secrets nor a build to name.
  case $command in
    eop) eop_main "$@"; return ;;
    dns) dns_main "$@"; return ;;
  esac
  while [ $# -gt 0 ]; do
    case $1 in
      --version) version=${2:-} && shift 2 ;;
      --purge) purge=1 && shift ;;
      *) die "unknown option: $1" 2 ;;
    esac
  done
  version=${version:-sha-$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)}
  [[ $version =~ ^sha-[0-9a-f]{12}$ ]] || die "--version must be sha-<12 hex characters>" 2
  case $command in
    up)
      stage_env
      start_server
      start_mailcow
      start_panel "$version"
      setup_panel
      log "open $URL (the browser warns about the stand's own certificate); the password is in $STAGE_ENV"
      ;;
    panel)
      stage_env
      start_panel "$version"
      ;;
    status) status ;;
    down)
      dk rm -f "$NAME" >/dev/null 2>&1 || true
      if [ "$purge" = 1 ]; then dk volume rm "$VOLUME" >/dev/null 2>&1 || true; fi
      log "removed $NAME$([ "$purge" = 1 ] && echo " and $VOLUME")"
      ;;
    *) die "usage: $0 up|panel|status|down [--version sha-<12>] [--purge] | eop ... | dns ..." 2 ;;
  esac
}

main "$@"
