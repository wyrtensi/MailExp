#!/usr/bin/env bash
# Read-only preflight of an installed panel, for a person or an agent before an update, a
# rollback or a move: versions (install.conf, checkout, running build, image tags), readiness,
# containers, the tenant worker, the edge image, free space, backups, applied migrations and the
# last known state of the mail node's spam rule. With --target sha-<12> it also checks that
# version: the commit, its images in the registry, the migrations it would run, a target older
# than the schema, a PostgreSQL major change, and the steps outside update.sh that the change needs
# (mail node, edge).
#
# It changes nothing on the server, with one exception: with --target, a commit that is not in the
# checkout yet is fetched (git fetch, as update.sh does; never while an update holds its lock). Of
# the env files it prints only non-secret values (EDGE_IMAGE, the image pinned by digest, and the
# Cloudflare Access team domain it compares with CF_ACCESS_ISSUER); secrets never. With the tunnel
# (cf, both) it asks https://<CF_HOST>/api/health once, without cookies, whether Cloudflare Access
# answers for it (lib/edge.sh cf_access_check); what it finds is a warning, never a problem.
#
#   status.sh [--prefix /opt/mailexpert] [--target sha-<12>] [--json]
#
# With --json stdout always carries one JSON object: the report, or {"error": ..., "exit_code": N}
# when the script itself failed or the input was invalid.
#
# Exit codes: 0 no problem (warnings may remain), 1 problems found (an update would be refused or
# fail), 2 invalid input or no installation.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/edge.sh
. "$LIB_DIR/edge.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib/health.sh
. "$LIB_DIR/health.sh"
# shellcheck source=lib/ops.sh
. "$LIB_DIR/ops.sh"
# shellcheck source=lib/status.sh
. "$LIB_DIR/status.sh"
# shellcheck source=lib/channel.sh
. "$LIB_DIR/channel.sh"

MIN_FREE_PCT=${MAILEXPERT_MIN_FREE_PCT:-15}

usage() {
  cat <<'EOF'
Usage: status.sh [--prefix /opt/mailexpert] [--target sha-<12>] [--json]

Read-only preflight: versions, readiness, containers, tenant worker, edge image, free space,
backups, the host updater (mailexpert-updater.path), migrations, the mail node's spam rule, Cloudflare Access in front of <CF_HOST> (cf,
both). --target checks a version to update to (the
commit, its images, pending migrations, steps outside update.sh); a commit missing from the
checkout is fetched. --json prints one JSON object on stdout (with "error" when the script
failed). Secrets are never printed.
Exit codes: 0 no problem, 1 problems found, 2 invalid input or no installation.
EOF
}

# PROBLEMS block an update; WARNINGS do not; NEXT are steps a person takes besides update.sh; INFO
# is context (what update.sh does by itself, what matters for a rollback).
PROBLEMS=() WARNINGS=() NEXT=() INFO=()
problem() { PROBLEMS+=("$1"); }
warning() { WARNINGS+=("$1"); }
info() { INFO+=("$1"); }

# Facts, filled by collect and read by the reports.
declare -A FACT=()
PRE_UPDATE_DUMPS='' APPLIED=''
TARGET_PENDING='' TARGET_UNKNOWN='' TARGET_IMAGES=''
# 1 once schema_migrations was read: until then pending and unknown migrations are unknown (null),
# never "none".
SCHEMA_READ=0
# 1 when the panel's compose project has a container of another owner (collect_names): the database
# is not read then, exec would reach that container (lib/app.sh panel_exec_problem).
PANEL_FOREIGN_CONTAINER=0
JSON=0 REPORTED=0

# lines_into <array name>: appends the non-empty lines on stdin to the array.
lines_into() {
  local -n into=$1
  local line
  while IFS= read -r line; do
    if [ -n "$line" ]; then into+=("$line"); fi
  done
}

collect_versions() {
  local head='' sha='' dirty=0
  FACT[version]=$CFG_VERSION
  FACT[install_id]=$CFG_INSTALL_ID
  if head=$(git -C "$APP_DIR" rev-parse --verify --quiet HEAD 2>/dev/null); then
    FACT[checkout]=sha-${head:0:12}
    if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then dirty=1; fi
  else
    FACT[checkout]=''
    problem "checkout: $APP_DIR is not a git checkout"
  fi
  FACT[checkout_dirty]=$dirty
  if [ -n "${FACT[checkout]}" ] && [ "${FACT[checkout]}" != "$CFG_VERSION" ]; then
    problem "checkout: $APP_DIR is at ${FACT[checkout]}, install.conf says $CFG_VERSION (an interrupted update or install: run install.sh --prefix $OPT_PREFIX to finish it)"
  fi
  if [ "$dirty" = 1 ]; then problem "checkout: $APP_DIR has local changes; install.sh refuses to switch commits"; fi
  FACT[ready]=0
  if panel_ready; then FACT[ready]=1; fi
  if sha=$(curl -fsS -m 5 "http://127.0.0.1:$CFG_HTTP_PORT/api/version" 2>/dev/null | jq -r '.sha // empty' 2>/dev/null) && [ -n "$sha" ]; then
    FACT[running]=sha-${sha:0:12}
    version_matches "$CFG_VERSION" "$sha" || problem "version: the running build is ${FACT[running]}, install.conf says $CFG_VERSION"
  else
    FACT[running]=''
  fi
  if [ "${FACT[ready]}" = 0 ]; then
    if is_standby; then
      info "standby: the panel does not run here on purpose (install.sh --no-start, or a move); update.sh refuses a standby server"
    else
      problem "ready: http://127.0.0.1:$CFG_HTTP_PORT/api/health/ready does not answer 200"
    fi
  fi
}

collect_containers() {
  local profiles ps images services
  local -a app_services=(frontend backend postgres redis)
  profiles=$(env_get "$ENV_FILE" COMPOSE_PROFILES) || profiles=''
  FACT[tenant_worker]=0
  if has_profile "$profiles" tenant; then
    FACT[tenant_worker]=1
    app_services+=(tenant-worker)
  fi
  services=$(edge_services)
  FACT[edge_services]=$(paste -sd, - <<<"$services")
  FACT[edge_image]=$(env_get "$EDGE_ENV" EDGE_IMAGE 2>/dev/null) || FACT[edge_image]=''
  is_standby && return 0
  if ps=$(app_compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null); then
    lines_into PROBLEMS < <(service_problems "${app_services[@]}" <<<"$ps")
  else
    problem "containers: docker compose ps failed for $CFG_PROJECT"
  fi
  if images=$(app_compose ps --all --format '{{.Service}} {{.Image}}' 2>/dev/null); then
    lines_into PROBLEMS < <(image_problems "$CFG_VERSION" frontend backend tenant-worker <<<"$images")
  fi
  if [ -n "$services" ]; then
    if ps=$(edge_compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null); then
      # shellcheck disable=SC2086 # one service name per word
      lines_into PROBLEMS < <(service_problems $services <<<"$ps")
    else
      problem "containers: docker compose ps failed for $CFG_EDGE_PROJECT"
    fi
  fi
}

# collect_names: Docker objects of another owner in this install's compose projects (install.sh,
# update.sh, rollback.sh and restore.sh refuse to run then: lib/app.sh guard_compose_projects; a
# container in the panel's project also stops backup.sh and the CLI wrappers: panel_exec_problem),
# and a note for each project name without the mailexpert prefix.
collect_names() {
  local line project foreign also
  for project in panel edge; do
    # Inside ||: a Docker that does not answer is a warning here, not the end of the report.
    if ! foreign=$("${project}_foreign_objects" 2>/dev/null); then
      warning "ownership: docker did not answer; the $project's compose project was not checked"
      continue
    fi
    while IFS= read -r line; do
      if [ -z "$line" ]; then continue; fi
      also=''
      if [ "$project" = panel ] && [[ $line == container\ * ]]; then
        PANEL_FOREIGN_CONTAINER=1
        also='; backup.sh, mailexpert-cli.sh and google-app.sh run nothing in the project either'
      fi
      if [ "$project" = panel ]; then line="$CFG_PROJECT: $line"; else line="$CFG_EDGE_PROJECT: $line"; fi
      problem "ownership: compose project $line is not this install's; install.sh, update.sh, rollback.sh and restore.sh refuse to run until it is gone$also"
    done <<<"$foreign"
  done
  lines_into INFO < <(generic_name_notes)
  if [ -z "$CFG_INSTALL_ID" ]; then
    info "names: install.conf has no INSTALL_ID yet (an install made before the IDs); the next install.sh or update.sh writes one and labels the containers with it"
  fi
}

# collect_cf_access: with the tunnel, whether https://<CF_HOST> is behind Cloudflare Access of the
# team in CF_ACCESS_ISSUER. Skipped on a standby server (its tunnel is not running).
collect_cf_access() {
  local issuer state team message
  grep -qx cloudflared <<<"$(edge_services)" || return 0
  is_standby && return 0
  issuer=$(env_get "$ENV_FILE" CF_ACCESS_ISSUER 2>/dev/null) || issuer=''
  IFS=$'\t' read -r state team message < <(cf_access_check "$CFG_CF_HOST" "$CFG_HTTP_PORT" "$issuer")
  FACT[cf_access]=$state
  FACT[cf_access_team]=${team#-}
  if [ "$state" != ok ]; then warning "cloudflare access: $message"; fi
}

collect_disk_and_backups() {
  local root path used free_kb finished='' since='' f
  local -a paths=(/)
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=''
  if [ -n "$root" ]; then paths+=("$root"); fi
  for path in "${paths[@]}"; do
    used=$(df -P "$path" 2>/dev/null | awk 'NR == 2 {print $5}') || used=''
    lines_into PROBLEMS < <(disk_problem "$path" "$used" "$MIN_FREE_PCT")
  done
  free_kb=$(df -Pk "$OPT_PREFIX" 2>/dev/null | awk 'NR == 2 {print $4}') || free_kb=''
  FACT[free_kb]=$free_kb
  FACT[backup_configured]=0
  FACT[last_backup_at]='' FACT[last_dump_bytes]=''
  if [ -f "$STATE_DIR/backup-last.json" ]; then
    FACT[last_backup_at]=$(jq -r '.finished_at // empty' "$STATE_DIR/backup-last.json" 2>/dev/null) || FACT[last_backup_at]=''
    finished=$(json_number finished_epoch <"$STATE_DIR/backup-last.json") || finished=''
    FACT[last_dump_bytes]=$(json_number dump_bytes <"$STATE_DIR/backup-last.json") || FACT[last_dump_bytes]=''
  fi
  if backup_configured "$ENV_FILE"; then
    FACT[backup_configured]=1
    if [ -f "$STATE_DIR/backup-since" ]; then since=$(<"$STATE_DIR/backup-since"); fi
    lines_into WARNINGS < <(backup_age_problem "$(date +%s)" "$finished" "$since")
  else
    warning "backup: restic is not configured; update.sh still keeps a local pre-update dump, but there is no off-site copy"
  fi
  # shellcheck disable=SC2012 # our own names: pre-update-sha-<hex>.dump
  PRE_UPDATE_DUMPS=$(ls -1t "$BACKUP_DIR"/pre-update-*.dump 2>/dev/null | while IFS= read -r f; do basename "$f"; done || true)
}

# collect_updater: the host updater units install.sh installs when the checkout has updater.sh and
# systemd runs the host (also with --no-system). A missing or inactive one is a warning (update from
# the panel does not work, update.sh itself does); without systemd it is only said so.
collect_updater() {
  local state expected=0 path
  path=$(unit_name updater path)
  state=$(updater_state)
  if [ "$state" != no_systemd ] && [ -x "$APP_DIR/scripts/deploy/updater.sh" ]; then expected=1; fi
  FACT[updater]=$state
  FACT[updater_expected]=$expected
  case $state in
    no_systemd) info "updater: not installed, this host runs without systemd; update from the panel is unavailable (update with update.sh)" ;;
    not_installed)
      if [ "$expected" = 1 ]; then
        warning "updater: $path is not installed, so update from the panel does not work (install.sh --prefix $OPT_PREFIX installs it)"
      fi
      ;;
    inactive)
      if [ "$expected" = 1 ]; then
        warning "updater: $path is installed but not active (systemctl enable --now $path)"
      else
        info "updater: $path is installed but not active, and this checkout has no scripts/deploy/updater.sh"
      fi
      ;;
  esac
}

collect_database() {
  local state
  FACT[migrations_applied]='' FACT[spam_rule]=''
  is_standby && return 0
  if [ "$PANEL_FOREIGN_CONTAINER" = 1 ]; then
    warning "database: not read: compose project $CFG_PROJECT has a container of another owner (the ownership problem above), and psql would run in it"
    return 0
  fi
  if APPLIED=$(printf 'SELECT version FROM schema_migrations ORDER BY version;\n' | app_psql 2>/dev/null); then
    SCHEMA_READ=1
    APPLIED=$(LC_ALL=C sort -u <<<"$APPLIED" | sed '/^$/d')
    FACT[migrations_applied]=$(grep -c . <<<"$APPLIED" || true)
  else
    APPLIED=''
    warning "database: cannot read schema_migrations (is postgres running?)"
  fi
  # Only the state of the rule ({at, state, code}), never another provider's configuration.
  if state=$(printf "SELECT config->>'state' FROM integration_config WHERE provider = 'mail_node_spam_rule';\n" | app_psql 2>/dev/null); then
    FACT[spam_rule]=$state
    case $state in
      outdated | missing) warning "mail node: the spam-sort rule on the node is $state; apply it from the panel (Почтовый узел, \"Применить правило раскладки спама\"); it restarts Dovecot" ;;
    esac
  fi
}

# image_state <image reference>: ok, missing or unknown (manifest_state); a local image is ok.
image_state() {
  local err status=0
  if docker image inspect "$1" >/dev/null 2>&1; then
    echo ok
    return 0
  fi
  err=$(docker manifest inspect "$1" 2>&1 >/dev/null) || status=$?
  manifest_state "$status" "$err"
}

# collect_target <sha-XXXXXXXXXXXX>
collect_target() {
  local target=$1 commit=${1#sha-} full head image state prefix=$CFG_IMAGE_PREFIX locked=0
  local applied_file target_file changed line kind service from to errors
  local -a images=(mailexpert-backend mailexpert-frontend)
  FACT[target]=$target
  FACT[target_commit]=0
  if lock_held "$STATE_DIR/update.lock"; then
    locked=1
    problem "target: an update, rollback or restore is running now"
  fi
  # Never fetched next to a running update: it is switching this checkout.
  if [ "$locked" = 0 ] && ! git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}" >/dev/null 2>&1; then
    if ! errors=$(git -C "$APP_DIR" fetch --quiet origin 2>&1); then
      warning "target: git fetch failed in $APP_DIR: $(error_tail <<<"$errors"); only the commits already fetched are known"
    fi
  fi
  if ! full=$(git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}" 2>/dev/null); then
    if [ "$locked" = 0 ]; then problem "target: commit $commit is not in $(redact_url "$CFG_REPO_URL")"; fi
    return 0
  fi
  FACT[target_commit]=1
  if [ "$target" = "$CFG_VERSION" ]; then info "target: the panel is already at $target"; fi
  if is_standby; then problem "target: standby server: update.sh refuses it; install.sh --version sets its version"; fi

  if [ "${FACT[tenant_worker]}" = 1 ]; then images+=(mailexpert-tenant-worker); fi
  head=$(git -C "$APP_DIR" rev-parse --verify --quiet HEAD 2>/dev/null) || head=''
  changed=''
  if [ -n "$head" ]; then changed=$(git -C "$APP_DIR" diff --name-only "$head" "$full" 2>/dev/null) || changed=''; fi
  # update.sh takes the new Caddy image when it changes (lib/ops.sh edge_image_changes).
  if edge_image_changes "${FACT[edge_services]}" <<<"$changed"; then images+=(mailexpert-edge); fi
  for image in "${images[@]}"; do
    state=$(image_state "$prefix/$image:$target")
    TARGET_IMAGES+="$image $state"$'\n'
    case $state in
      missing) problem "target: image $prefix/$image:$target does not exist in the registry (did CI's images job pass for this commit?)" ;;
      unknown) problem "target: cannot check image $prefix/$image:$target: the registry is unreachable or refused access (network, credentials, rate limit); update.sh would stop at the same point" ;;
    esac
  done

  if [ "$SCHEMA_READ" = 1 ]; then
    applied_file=$(mktemp) target_file=$(mktemp)
    printf '%s\n' "$APPLIED" | sed '/^$/d' >"$applied_file"
    git -C "$APP_DIR" ls-tree --name-only "$full" backend/migrations/ | migration_versions >"$target_file"
    TARGET_PENDING=$(pending_migrations "$applied_file" "$target_file")
    TARGET_UNKNOWN=$(unknown_migrations "$applied_file" "$target_file")
    rm -f "$applied_file" "$target_file"
    if [ -n "$TARGET_UNKNOWN" ]; then
      problem "target: $target is older than the database schema ($(grep -c . <<<"$TARGET_UNKNOWN") migration(s) it does not know); old code on a new schema is not supported: go back with the pre-update dump (runbook: \"Откат обновления\")"
    fi
    line=$(pending_note <<<"$TARGET_PENDING")
    if [ -n "$line" ]; then info "${line#info }"; fi
  else
    warning "target: the database schema could not be read, so pending migrations are unknown: treat them as present (going back then needs the pre-update dump)"
  fi

  if [ -n "${FACT[last_dump_bytes]}" ] && [ -n "${FACT[free_kb]}" ]; then
    lines_into PROBLEMS < <(space_problem "${FACT[free_kb]}" "${FACT[last_dump_bytes]}")
  fi
  [ -n "$head" ] && [ "$head" != "$full" ] || return 0
  while read -r kind service from _ to; do
    if [ "$kind" = problem ]; then
      problem "target: $service changes from $from to $to: a new PostgreSQL major version does not start on the old data directory, and update.sh does not migrate it (dump, new volume, restore)"
    elif [ -n "$kind" ]; then
      info "target: the $service image changes from $from to $to"
    fi
  done < <(data_image_changes <(git -C "$APP_DIR" show "$head:docker-compose.yml" 2>/dev/null) \
    <(git -C "$APP_DIR" show "$full:docker-compose.yml" 2>/dev/null))
  while IFS= read -r line; do
    case $line in
      "next "*) NEXT+=("${line#next }") ;;
      "info "*) INFO+=("${line#info }") ;;
    esac
  done < <(update_notes "${FACT[tenant_worker]}" "${FACT[edge_services]}" "$(systemd_flag)" <<<"$changed")
  if ! git -C "$APP_DIR" merge-base --is-ancestor "$head" "$full" 2>/dev/null; then
    info "target: $target is not a descendant of the running commit (a downgrade or another branch)"
  fi
}

# resolve_target_channel: RESOLVED_TARGET = the sha-<12> the channel latest names now, empty (with
# a problem) when it cannot be resolved. Next to a running update only the local tag is read,
# never fetched. Not in a subshell: it records facts and problems.
RESOLVED_TARGET=''
resolve_target_channel() {
  local full errors line
  FACT[channel]=latest
  RESOLVED_TARGET=''
  if lock_held "$STATE_DIR/update.lock"; then
    if full=$(latest_commit 2>/dev/null); then
      RESOLVED_TARGET=sha-${full:0:12}
    else
      problem "target: the channel latest cannot be resolved while an update runs"
    fi
    return 0
  fi
  errors=$(mktemp)
  if RESOLVED_TARGET=$(resolve_latest 2>"$errors"); then
    while IFS= read -r line; do
      if [ -n "$line" ]; then warning "target: ${line#\[mailexpert\] warning: }"; fi
    done <"$errors"
  else
    RESOLVED_TARGET=''
    problem "target: the channel latest cannot be resolved: $(sed 's/^\[mailexpert\] warning: //' "$errors" | paste -sd';' -)"
  fi
  rm -f "$errors"
}

report_text() {
  local line key pending
  printf 'MailExpert panel at %s\n' "$OPT_PREFIX"
  for key in version install_id checkout running ready tenant_worker edge_services edge_image cf_access cf_access_team updater backup_configured \
    last_backup_at last_dump_bytes free_kb migrations_applied spam_rule channel target target_commit; do
    [ -n "${FACT[$key]+set}" ] || continue
    printf '  %-20s %s\n' "$key" "${FACT[$key]:--}"
  done
  if [ -n "$PRE_UPDATE_DUMPS" ]; then printf '  %-20s %s\n' pre_update_dumps "$(paste -sd' ' - <<<"$PRE_UPDATE_DUMPS")"; fi
  if [ -n "$TARGET_IMAGES" ]; then printf '  %-20s %s\n' target_images "$(sed '/^$/d' <<<"$TARGET_IMAGES" | paste -sd, -)"; fi
  if [ -n "${FACT[target]+set}" ] && [ "${FACT[target_commit]}" = 1 ]; then
    pending=$(sed '/^$/d' <<<"$TARGET_PENDING" | paste -sd' ' -)
    if [ "$SCHEMA_READ" = 0 ]; then pending=unknown; fi
    printf '  %-20s %s\n' pending_migrations "${pending:-none}"
  fi
  for line in "${PROBLEMS[@]}"; do printf 'problem: %s\n' "$line"; done
  for line in "${WARNINGS[@]}"; do printf 'warning: %s\n' "$line"; done
  for line in "${NEXT[@]}"; do printf 'next: %s\n' "$line"; done
  for line in "${INFO[@]}"; do printf 'info: %s\n' "$line"; done
  if [ "${#PROBLEMS[@]}" -eq 0 ]; then printf 'result: no problems\n'; else printf 'result: %s problem(s)\n' "${#PROBLEMS[@]}"; fi
}

report_json() {
  local -a args=()
  local key
  for key in "${!FACT[@]}"; do args+=(--arg "$key" "${FACT[$key]}"); done
  jq -cn "${args[@]}" \
    --arg prefix "$OPT_PREFIX" \
    --argjson problems "$(printf '%s\n' "${PROBLEMS[@]}" | sed '/^$/d' | lines_json)" \
    --argjson warnings "$(printf '%s\n' "${WARNINGS[@]}" | sed '/^$/d' | lines_json)" \
    --argjson next "$(printf '%s\n' "${NEXT[@]}" | sed '/^$/d' | lines_json)" \
    --argjson info "$(printf '%s\n' "${INFO[@]}" | sed '/^$/d' | lines_json)" \
    --argjson schema_read "$(if [ "$SCHEMA_READ" = 1 ]; then echo true; else echo false; fi)" \
    --argjson dumps "$(sed '/^$/d' <<<"$PRE_UPDATE_DUMPS" | lines_json)" \
    --argjson pending "$(sed '/^$/d' <<<"$TARGET_PENDING" | lines_json)" \
    --argjson unknown "$(sed '/^$/d' <<<"$TARGET_UNKNOWN" | lines_json)" \
    --argjson images "$(sed '/^$/d' <<<"$TARGET_IMAGES" | jq -Rn '[inputs | split(" ") | {(.[0]): .[1]}] | add // {}')" \
    'def num: if . == null or . == "" then null else tonumber end;
     def flag: . == "1";
     $ARGS.named as $f
     | {prefix: $prefix, version: $f.version, install_id: (if ($f.install_id // "") == "" then null else $f.install_id end), checkout: ($f.checkout // null),
      checkout_dirty: ($f.checkout_dirty | flag), running: (if ($f.running // "") == "" then null else $f.running end),
      ready: ($f.ready | flag), standby: ($f.standby | flag), tenant_worker: ($f.tenant_worker | flag),
      edge_services: (($f.edge_services // "") | split(",") | map(select(. != ""))),
      edge_image: (if ($f.edge_image // "") == "" then null else $f.edge_image end),
      cf_access: (if $f.cf_access == null then null else
        {state: $f.cf_access, team: (if ($f.cf_access_team // "") == "" then null else $f.cf_access_team end)} end),
      updater: {state: ($f.updater // "unknown"), expected: ($f.updater_expected | flag)},
      backup: {configured: ($f.backup_configured | flag),
               last_finished_at: (if ($f.last_backup_at // "") == "" then null else $f.last_backup_at end),
               last_dump_bytes: ($f.last_dump_bytes | num), pre_update_dumps: $dumps},
      free_kb: ($f.free_kb | num), migrations_applied: ($f.migrations_applied | num),
      spam_rule: (if ($f.spam_rule // "") == "" then null else $f.spam_rule end),
      target: (if $f.target == null then
          (if $f.channel == null then null else {version: null, channel: $f.channel, commit_found: false} end)
        else
        {version: $f.target, channel: ($f.channel // null), commit_found: ($f.target_commit | flag), images: $images,
         pending_migrations: (if $schema_read then $pending else null end),
         unknown_migrations: (if $schema_read then $unknown else null end)} end),
      problems: $problems, warnings: $warnings, next: $next, info: $info}'
}

main() {
  local prefix=/opt/mailexpert target='' json=0
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix | --target)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        if [ "$1" = --prefix ]; then prefix=$2; else target=$2; fi
        shift 2
        ;;
      --json) json=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  if [ -n "$target" ] && ! [[ $target =~ ^sha-[0-9a-f]{12}$ || $target == latest ]]; then
    die "--target must be sha-<first 12 characters of the commit> or latest" 2
  fi
  [[ $MIN_FREE_PCT =~ ^[0-9]+$ ]] || die "MAILEXPERT_MIN_FREE_PCT must be a number" 2
  [ "$(id -u)" = 0 ] || die "run status.sh as root (it reads <prefix>/.env and talks to docker)" 2
  load_install "$prefix"

  FACT[standby]=0
  if is_standby; then FACT[standby]=1; fi
  if lock_held "$STATE_DIR/update.lock"; then info "an update, rollback or restore is running now: results may be in flux"; fi
  collect_versions
  collect_containers
  collect_names
  collect_cf_access
  collect_updater
  collect_disk_and_backups
  collect_database
  if [ "$target" = latest ]; then
    resolve_target_channel
    target=$RESOLVED_TARGET
  fi
  if [ -n "$target" ]; then collect_target "$target"; fi

  if [ "$json" = 1 ]; then report_json; else report_text; fi
  REPORTED=1
  # exit, not return: a nonzero return from main would trip the ERR trap.
  if [ "${#PROBLEMS[@]}" -gt 0 ]; then exit 1; fi
  exit 0
}

# json_failure <exit code>: with --json, the object a failed run leaves on stdout instead of a
# report, so that a caller never mistakes a failure for a status.
json_failure() {
  local kind=script_failure
  if [ "$JSON" = 1 ] && [ "$REPORTED" = 0 ] && [ "$1" != 0 ]; then
    if [ "$1" = 2 ]; then kind=invalid_input_or_no_installation; fi
    printf '{"error":"%s","exit_code":%s}\n' "$kind" "$1"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  exit_on_unexpected_failure
  # Known before main parses the arguments: a failure while parsing gets its object too.
  for arg in "$@"; do if [ "$arg" = --json ]; then JSON=1; fi; done
  trap 'json_failure $?' EXIT
  main "$@"
fi
