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
#
# Secrets live in data/stage.env (ignored by git), written on the first run: the panel's
# SESSION_SECRET, ENCRYPTION_KEY and DB_PASSWORD, the mailcow API key, and the panel's first
# administrator (PANEL_ADMIN_USER, PANEL_ADMIN_PASSWORD; local sign-in). up connects the panel
# to mailcow and adds the domain stage.test. Mail from outside never reaches the stand.
# --version defaults to the checked-out commit, whose images CI publishes after a merge to main.
# Needs about 8 GB of memory for Docker. From Git Bash on Windows it runs as is.
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
  # between the stand's own mailboxes needs no outside DNS.
  inner "cd /opt/mailcow && sed -i \
    -e 's/^SKIP_LETS_ENCRYPT=n/SKIP_LETS_ENCRYPT=y/' -e 's/^SKIP_FTS=n/SKIP_FTS=y/' -e 's/^SKIP_OLEFY=n/SKIP_OLEFY=y/' \
    -e 's/^SKIP_CLAMD=n/SKIP_CLAMD=y/' -e 's/^SKIP_UNBOUND_HEALTHCHECK=n/SKIP_UNBOUND_HEALTHCHECK=y/' \
    -e 's|^#API_KEY=\$|API_KEY=$MAILCOW_API_KEY|' -e 's|^#API_ALLOW_FROM=.*|API_ALLOW_FROM=172.16.0.0/12,127.0.0.1|' mailcow.conf"
  inner "grep -q '^API_KEY=$MAILCOW_API_KEY\$' /opt/mailcow/mailcow.conf" || die "mailcow.conf has no API_KEY line to set"
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

status() {
  running || { log "$NAME is not running"; return 0; }
  dk stats --no-stream --format 'server: {{.MemUsage}} memory, {{.CPUPerc}} CPU' "$NAME"
  printf 'panel: %s, build %s\n' "$URL" "$(panel_sha)"
  inner 'docker ps --format "{{.Names}}\t{{.Status}}"' | sort
}

main() {
  local command=${1:-} version='' purge=0
  [ $# -gt 0 ] && shift
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
    *) die "usage: $0 up|panel|status|down [--version sha-<12>] [--purge]" 2 ;;
  esac
}

main "$@"
