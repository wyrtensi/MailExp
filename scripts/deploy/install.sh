#!/usr/bin/env bash
# Installs MailExpert on a host or re-applies its configuration. Idempotent: every step checks
# what is already done; generated secrets are written once and never replaced. Owner secrets
# come from configure.sh, never from flags.
#
# Exit codes: 0 done, 1 failure, 2 invalid input, 3 waiting for secrets (run configure.sh).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"
# shellcheck source=lib/config.sh
. "$SCRIPT_DIR/lib/config.sh"
# shellcheck source=lib/edge.sh
. "$SCRIPT_DIR/lib/edge.sh"
# shellcheck source=lib/system.sh
. "$SCRIPT_DIR/lib/system.sh"
# shellcheck source=lib/app.sh
. "$SCRIPT_DIR/lib/app.sh"
# shellcheck source=lib/backup.sh
. "$SCRIPT_DIR/lib/backup.sh"
# shellcheck source=lib/updater.sh
. "$SCRIPT_DIR/lib/updater.sh"

exit_on_unexpected_failure

# update.sh raises it: long backfill migrations run before the backend listens.
READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-180}
EDGE_TIMEOUT=180
# How long verify_edge waits for https://<CF_HOST> to show Cloudflare Access before it warns.
CF_CHECK_TIMEOUT=${MAILEXPERT_CF_CHECK_TIMEOUT:-60}
[[ $CF_CHECK_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_CF_CHECK_TIMEOUT must be a number of seconds" 2
# How long to wait for install.lock: another install.sh or configure.sh, or a backup while it
# dumps the database (minutes on a large one). The updater's automatic rollback raises it.
LOCK_TIMEOUT=${MAILEXPERT_LOCK_TIMEOUT:-600}
[[ $LOCK_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_LOCK_TIMEOUT must be a number of seconds" 2
# 1 when the panel already answered before this run changed anything (an update, a rollback, a
# rerun): setup_backups then only warns about the repository.
PANEL_WAS_RUNNING=0
ORIG_ARGS=("$@")
LOADED_HASH=$(cat "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR"/lib/*.sh | sha256sum)

usage() {
  cat <<'EOF'
Usage: install.sh --version sha-<commit> --signin cf|direct|both
                  [--cf-host <CF_HOST>] [--direct-host <DIRECT_HOST>]
                  [--admin-email <email>[,<email>]] [--local-auth]
                  [--no-edge] [--edge-tls acme|internal] [--acme-email <email>]
                  [--prefix /opt/mailexpert] [--project mailexpert] [--edge-project edge]
                  [--http-port 8080] [--image-prefix ghcr.io/wyrtensi] [--repo-url <git url>]
                  [--no-system] [--no-start]

--version       image tag sha-<first 12 characters of the commit>; that commit is checked out
--signin        cf: <CF_HOST> through the Cloudflare tunnel and Access; direct: <DIRECT_HOST>
                through Caddy with "Sign in with Google"; both: both hosts
--local-auth    username and password sign-in instead of Google (test stands)
--no-edge       run neither Caddy nor cloudflared
--edge-tls      acme (default): certificate through Cloudflare DNS-01;
                internal: Caddy's own CA (test stands)
--no-system     skip Ubuntu checks, packages, swap, ufw and timers
--no-start      prepare everything, start neither the panel nor the tunnel (before a move)

Values are stored in <prefix>/install.conf: a rerun without flags repeats the last install.
<prefix>/compose.local.yml, if it exists, is added after the production overlay to every compose
command of the panel (install, update, backup, restore, rollback, status, the CLI): the operator's
own additions, kept across updates and in backups. A version older than this feature (an install,
update or rollback to it) runs without the file; install.sh, update.sh and rollback.sh warn then.
Secrets are never flags: add them with configure.sh (stdin).
Exit codes: 0 done, 1 failure, 2 invalid input, 3 waiting for secrets from configure.sh.
EOF
}

prepare_dirs() {
  # An existing --prefix keeps its mode: /tmp would lose its sticky bit, /root would open up.
  if [ ! -d "$OPT_PREFIX" ]; then
    mkdir -p "$OPT_PREFIX"
    chmod 755 "$OPT_PREFIX"
  fi
  mkdir -p "$APP_DIR" "$EDGE_DIR" "$OPT_PREFIX/backups" "$STATE_DIR"
  chmod 700 "$EDGE_DIR" "$OPT_PREFIX/backups" "$STATE_DIR"
  prepare_update_spool "$STATE_DIR"
}

# lock_install: one install.sh or configure.sh at a time per prefix: configure.sh takes the same
# lock, so their read-modify-write updates of .env cannot overwrite each other.
lock_install() {
  take_install_lock "$STATE_DIR" "$LOCK_TIMEOUT" install.sh
}

check_tools() {
  local tool
  for tool in git curl jq ss sha256sum timeout; do
    command -v "$tool" >/dev/null || die "$tool is required"
  done
}

check_docker() {
  local version
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
  version=$(docker compose version --short 2>/dev/null) || die "docker compose v2 is not installed"
  version_ge "$version" 2.24.4 || die "docker compose $version is too old, 2.24.4 or newer is needed"
}

check_ports() {
  local listening conflicts
  listening=$(ss -ltnpH)
  if edge_services | grep -qx caddy; then
    conflicts=$(port_conflicts 80 443 <<<"$listening" | sort -u)
    [ -z "$conflicts" ] || die "ports for the edge are taken: $(paste -sd';' - <<<"$conflicts")"
  fi
  conflicts=$(port_conflicts 25 465 587 993 <<<"$listening" | awk '$2 != "docker-proxy"' | sort -u)
  [ -z "$conflicts" ] || warn "mail ports are taken outside Docker: $(paste -sd';' - <<<"$conflicts"); the mail node needs them"
}

checkout_code() {
  local commit=${CFG_VERSION#sha-} full
  if [ ! -d "$APP_DIR/.git" ]; then
    log "cloning $(redact_url "$CFG_REPO_URL")"
    git clone --quiet "$CFG_REPO_URL" "$APP_DIR" ||
      die "git clone of $(redact_url "$CFG_REPO_URL") into $APP_DIR failed (git's error is above): check the network and access to the repository"
  elif [ "$(git -C "$APP_DIR" remote get-url origin)" != "$CFG_REPO_URL" ]; then
    git -C "$APP_DIR" remote set-url origin "$CFG_REPO_URL"
  fi
  if ! git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}" >/dev/null; then
    git -C "$APP_DIR" fetch --quiet origin ||
      die "git fetch in $APP_DIR failed (git's error is above): check the network and access to $(redact_url "$CFG_REPO_URL")"
  fi
  full=$(git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}") || die "commit $commit is not in $(redact_url "$CFG_REPO_URL")"
  if [ "$(git -C "$APP_DIR" rev-parse HEAD)" != "$full" ]; then
    [ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] ||
      die "$APP_DIR has local changes; refusing to switch commits"
    git -C "$APP_DIR" checkout --quiet --detach "$full"
    log "checked out $full"
  fi
}

# maybe_reexec: continue with the installer of the checked-out commit when it differs from the
# one running (for example cloud-init cloned main but installs an older or newer commit).
maybe_reexec() {
  local target=$APP_DIR/scripts/deploy target_hash
  [ -f "$target/install.sh" ] || die "commit $CFG_VERSION has no scripts/deploy/install.sh"
  [ -z "${MAILEXPERT_INSTALL_REEXEC:-}" ] || return 0
  if local_compose_ignored <"$target/lib/app.sh"; then local_compose_warning "$CFG_VERSION"; fi
  target_hash=$(cat "$target/install.sh" "$target"/lib/*.sh | sha256sum)
  [ "$target_hash" != "$LOADED_HASH" ] || return 0
  log "continuing with the installer of $CFG_VERSION"
  exec 9>&-
  export MAILEXPERT_INSTALL_REEXEC=1
  exec bash "$target/install.sh" "${ORIG_ARGS[@]}"
}

write_app_settings() {
  local line subject url
  while IFS= read -r line; do
    env_set "$ENV_FILE" "${line%%=*}" "${line#*=}"
  done < <(app_settings)
  subject=$(env_get "$ENV_FILE" VAPID_SUBJECT) || subject=''
  if [ -z "$subject" ]; then
    url=$(env_get "$ENV_FILE" APP_URL)
    env_set "$ENV_FILE" VAPID_SUBJECT "$url"
  fi
}

ensure_app_images() {
  ensure_image "$BACKEND_IMAGE"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-frontend:$CFG_VERSION"
}

# record_spool_uid: the uid the backend image runs as, asked from the image itself (a throwaway
# container without network), kept in <state>/spool-uid for the spool's owner and the updater's
# owner check; the spool is then made again with it. Without an answer the recorded or default uid
# (1000, `USER node`) stays.
record_spool_uid() {
  local uid
  uid=$(docker run --rm --network none --entrypoint id "$BACKEND_IMAGE" -u 2>/dev/null | tr -d '[:space:]') || uid=''
  if [[ $uid =~ ^[1-9][0-9]{0,9}$ ]]; then
    printf '%s\n' "$uid" >"$STATE_DIR/spool-uid"
  else
    warn "cannot ask $BACKEND_IMAGE for its uid; the update spool stays owned by uid $(spool_uid "$STATE_DIR")"
  fi
  prepare_update_spool "$STATE_DIR"
}

# pinned_edge_image: the EDGE_IMAGE to keep. A digest stays as it is; a tag becomes its digest
# once the image is local and has one (a locally built image has none and keeps its tag).
pinned_edge_image() {
  local image digest
  image=$(env_get "$EDGE_ENV" EDGE_IMAGE) || image=''
  [ -n "$image" ] || image=$CFG_IMAGE_PREFIX/mailexpert-edge:$CFG_VERSION
  if edge_services | grep -qx caddy; then
    ensure_image "$image"
    if [[ $image != *@sha256:* ]]; then
      digest=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image")
      [ -z "$digest" ] || image=$digest
    fi
  fi
  printf '%s\n' "$image"
}

guard_existing_database() {
  local missing
  db_volume_exists || return 0
  missing=$(env_missing "$ENV_FILE" DB_PASSWORD ENCRYPTION_KEY)
  [ -z "$missing" ] ||
    die "volume ${CFG_PROJECT}_postgres_data exists but $ENV_FILE has no $(paste -sd' ' - <<<"$missing"): new values would lock the data out; restore .env from a backup"
}

require_owner_secrets() {
  local where key file value missing=''
  while read -r where key; do
    if [ "$where" = edge ]; then file=$EDGE_ENV; else file=$ENV_FILE; fi
    value=$(env_get "$file" "$key") || value=''
    [ -n "$value" ] || missing+=" $key"
  done < <(required_owner_secrets)
  [ -n "$missing" ] || return 0
  log "waiting for secrets:$missing"
  log "add them as KEY=VALUE lines: $APP_DIR/scripts/deploy/configure.sh --prefix $OPT_PREFIX < <file>"
  log "then run install.sh again"
  exit 3
}

# require_generated_secrets: the panel never starts with an empty DB_PASSWORD or ENCRYPTION_KEY:
# the database volume would be created with it. Nothing is generated here; a rerun generates the
# missing keys (guard_existing_database stops it when a database volume exists).
require_generated_secrets() {
  local missing
  missing=$(env_missing "$ENV_FILE" "${GENERATED_SECRET_KEYS[@]}")
  [ -z "$missing" ] ||
    die "$ENV_FILE lost $(paste -sd' ' - <<<"$missing") during this run; the panel was not started, run install.sh again"
}

# app_up: `up` waits for the backend to be healthy before it starts the frontend, with no time
# limit, and a backend that crashes at start (a failing migration) restarts forever without
# ever turning unhealthy. The wait is bounded so that update.sh gets to its rollback.
app_up() {
  log "starting the panel (compose project $CFG_PROJECT)"
  if [ -f "$LOCAL_COMPOSE" ]; then log "with the local compose override $LOCAL_COMPOSE"; fi
  # --remove-orphans: a service dropped from the compose files or compose.local.yml stops. Only
  # containers of this compose project (-p) count; the edge and other projects are never touched.
  local rc=0
  timeout "$READY_TIMEOUT" "${APP_COMPOSE[@]}" up -d --quiet-pull --remove-orphans || rc=$?
  if [ "$rc" = 124 ]; then
    die "the panel did not start within ${READY_TIMEOUT}s; see: docker compose -p $CFG_PROJECT logs backend"
  elif [ "$rc" != 0 ]; then
    die "docker compose up for $CFG_PROJECT failed (exit $rc; its error is above); see: docker compose -p $CFG_PROJECT ps --all and docker compose -p $CFG_PROJECT logs backend"
  fi
  clear_standby
}

edge_up() {
  local services service existed=0 applied=$STATE_DIR/caddyfile.applied
  local -a targets=()
  [ "$CFG_EDGE" = 1 ] || return 0
  services=$(edge_services)
  for service in caddy cloudflared; do
    if ! grep -qx "$service" <<<"$services"; then
      edge_compose --profile caddy --profile tunnel rm --stop --force "$service" >/dev/null
    fi
  done
  if grep -qx caddy <<<"$services"; then
    targets+=(caddy)
    if [ -n "$(edge_compose ps --all --quiet caddy)" ]; then existed=1; fi
  else
    rm -f "$applied"
  fi
  if grep -qx cloudflared <<<"$services" && [ "$OPT_START" = 1 ]; then targets+=(cloudflared); fi
  [ "${#targets[@]}" -gt 0 ] || return 0
  edge_compose up -d --quiet-pull "${targets[@]}" ||
    die "docker compose up for the edge ($CFG_EDGE_PROJECT: ${targets[*]}) failed (its error is above); see: docker compose -p $CFG_EDGE_PROJECT logs ${targets[0]}"
  grep -qx caddy <<<"$services" || return 0
  # Caddy's admin API is off: a changed Caddyfile is loaded by a restart. The record of what Caddy
  # loaded is written only afterwards, so a run that stops earlier leaves the restart to a rerun.
  if caddy_restart_needed "$EDGE_DIR/Caddyfile" "$applied" "$existed"; then
    log "restarting caddy to load the changed Caddyfile"
    edge_compose restart caddy >/dev/null
  fi
  caddy_record_applied "$EDGE_DIR/Caddyfile" "$applied"
}

wait_ready() {
  local base=http://127.0.0.1:$CFG_HTTP_PORT deadline=$((SECONDS + READY_TIMEOUT)) sha
  until panel_ready; do
    [ "$SECONDS" -lt "$deadline" ] || die "the panel is not ready after ${READY_TIMEOUT}s; see: docker compose -p $CFG_PROJECT logs backend"
    sleep 3
  done
  sha=$(curl -fsS "$base/api/version" | jq -r .sha)
  version_matches "$CFG_VERSION" "$sha" || die "the running build is $sha, not $CFG_VERSION"
  log "panel ready on 127.0.0.1:$CFG_HTTP_PORT, build $sha"
}

# forget_rolled_back: the version that now runs is no longer one to keep the panel away from
# (lib/updater.sh forget_rolled_back_if_running).
forget_rolled_back() {
  local forgot
  forgot=$(forget_rolled_back_if_running "$STATE_DIR" "$CFG_VERSION")
  if [ -n "$forgot" ]; then log "$forgot runs again: the panel no longer treats it as rolled back"; fi
}

edge_probe() {
  local host=$CFG_DIRECT_HOST root=$STATE_DIR/edge-local-root.crt
  local -a tls=()
  if [ "$CFG_EDGE_TLS" = internal ]; then
    edge_compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$root" 2>/dev/null || return 1
    tls=(--cacert "$root")
  fi
  curl -fs -o /dev/null "${tls[@]}" --resolve "$host:443:127.0.0.1" "https://$host/api/health"
}

# verify_cf_access: whether https://<CF_HOST> is behind Cloudflare Access of the team that
# CF_ACCESS_ISSUER names (lib/edge.sh cf_access_wait). A warning, never a failure: DNS and the
# connector can take minutes, and status.sh repeats the check. Waits up to CF_CHECK_TIMEOUT only
# for what time can fix.
verify_cf_access() {
  local issuer
  issuer=$(env_get "$ENV_FILE" CF_ACCESS_ISSUER) || issuer=''
  cf_access_wait "$CFG_CF_HOST" "$CFG_HTTP_PORT" "$issuer" "$CF_CHECK_TIMEOUT"
}

verify_edge() {
  local services deadline=$((SECONDS + EDGE_TIMEOUT))
  [ "$CFG_EDGE" = 1 ] || return 0
  services=$(edge_services)
  if grep -qx cloudflared <<<"$services"; then
    edge_compose ps --status running --services | grep -qx cloudflared ||
      die "cloudflared is not running; see: docker compose -p $CFG_EDGE_PROJECT logs cloudflared"
    log "tunnel connector running; in Zero Trust the public hostname $CFG_CF_HOST must point to http://127.0.0.1:$CFG_HTTP_PORT"
    verify_cf_access
  fi
  grep -qx caddy <<<"$services" || return 0
  until edge_probe; do
    [ "$SECONDS" -lt "$deadline" ] || die "https://$CFG_DIRECT_HOST does not answer through Caddy after ${EDGE_TIMEOUT}s; see: docker compose -p $CFG_EDGE_PROJECT logs caddy"
    sleep 5
  done
  log "edge: https://$CFG_DIRECT_HOST answers through Caddy"
}

admin_notice() {
  local url
  url=$(env_get "$ENV_FILE" APP_URL)
  if [ "$CFG_LOCAL_AUTH" = 1 ]; then
    log "local sign-in: the first account registered at $url becomes the admin"
  else
    log "Google sign-in: $CFG_ADMIN_EMAILS become admins at their first sign-in at $url"
  fi
}

# setup_backups: with the restic keys in .env the repository is opened (created when it does not
# exist yet), the start of backups recorded for the health check and the recovery key shown once.
# Without the keys the panel runs without backups: a warning here, and the health check fails
# until the owner adds them. A repository that neither opens nor can be created stops only a first
# install (backup_setup_failure); on a server that ran already it is a warning, so an update or a
# rollback that brought the panel up is not undone by a storage hiccup.
setup_backups() {
  local problem set_up=0
  if ! backup_configured "$ENV_FILE"; then
    warn "backups are off: add RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with configure.sh, then run install.sh again"
    return 0
  fi
  load_restic_env
  ensure_image "$RESTIC_IMAGE"
  if ! problem=$(ensure_backup_repo); then
    if [ -f "$STATE_DIR/backup-since" ]; then set_up=1; fi
    [ "$(backup_setup_failure "$set_up" "$PANEL_WAS_RUNNING")" = warning ] || die "$problem"
    warn "backups: $problem"
    warn "backups: the panel runs; backups fail until this is fixed (the nightly backup and the health check report it); then run install.sh again"
    return 0
  fi
  if [ ! -f "$STATE_DIR/backup-since" ]; then date +%s >"$STATE_DIR/backup-since"; fi
  show_recovery_key_once "$APP_DIR/scripts/deploy/backup.sh --prefix $OPT_PREFIX --show-recovery-key"
}

main() {
  local edge_image
  parse_install_args "$@"
  if [ -n "${INSTALL_ARGS[HELP]+set}" ]; then
    usage
    return 0
  fi
  resolve_install_config "${INSTALL_ARGS[PREFIX]:-/opt/mailexpert}/install.conf"
  validate_install_config || exit 2
  [[ $READY_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_READY_TIMEOUT must be a number of seconds" 2
  set_install_paths

  [ "$(id -u)" = 0 ] || die "run install.sh as root"
  prepare_dirs
  lock_install
  load_restic_host mailexpert
  if panel_ready; then PANEL_WAS_RUNNING=1; fi
  if [ "$CFG_SYSTEM" = 1 ]; then
    check_os
    check_resources
    install_packages
    ensure_docker_running
    ensure_swap
    enable_unattended_upgrades
  fi
  check_tools
  check_docker
  check_ports

  write_install_conf "$OPT_PREFIX/install.conf"
  chmod 600 "$OPT_PREFIX/install.conf"
  checkout_code
  maybe_reexec

  write_app_settings
  ensure_app_images
  record_spool_uid
  guard_existing_database
  generate_app_secrets "$ENV_FILE"
  if [ "$CFG_EDGE" = 1 ]; then
    edge_image=$(pinned_edge_image)
    write_edge_files "$APP_DIR" "$EDGE_DIR" "$edge_image"
  fi
  require_owner_secrets
  require_generated_secrets

  if [ "$OPT_START" = 1 ]; then app_up; else set_standby; fi
  edge_up
  if [ "$CFG_SYSTEM" = 1 ]; then apply_ufw; fi
  if [ "$OPT_START" = 1 ]; then
    wait_ready
    forget_rolled_back
    verify_edge
  fi
  admin_notice
  setup_backups
  if [ "$CFG_SYSTEM" = 1 ]; then
    install_timers
    install_updater
  fi
  log "done"
}

# One line: bash has read it whole before main runs, so a checkout that rewrites this file
# cannot change what the running shell executes next.
main "$@"; exit $?
