# shellcheck shell=bash
# The installed panel as every deploy script sees it: install.conf, the paths under the prefix,
# compose, images, the database and the standby marker. Needs common.sh, env.sh and config.sh.

# set_install_paths: the paths and commands derived from OPT_PREFIX and the CFG_* values. The
# compose commands are arrays as well as functions: `timeout` runs a program, not a function.
# <prefix>/compose.local.yml, when the operator put one there, is added after the production
# overlay to every compose command of the panel: local additions that a checkout of another
# version does not overwrite. Relative paths in it resolve against <prefix>/app, the project
# directory.
# shellcheck disable=SC2034 # read by the scripts that source this file
set_install_paths() {
  APP_DIR=$OPT_PREFIX/app EDGE_DIR=$OPT_PREFIX/edge STATE_DIR=$OPT_PREFIX/state
  BACKUP_DIR=$OPT_PREFIX/backups ENV_FILE=$OPT_PREFIX/.env EDGE_ENV=$OPT_PREFIX/edge/.env
  BACKEND_IMAGE=$CFG_IMAGE_PREFIX/mailexpert-backend:$CFG_VERSION
  LOCAL_COMPOSE=$OPT_PREFIX/compose.local.yml
  APP_COMPOSE=(docker compose -p "$CFG_PROJECT" --project-directory "$APP_DIR" --env-file "$ENV_FILE"
    -f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/deploy/compose.prod.yml")
  if [ -f "$LOCAL_COMPOSE" ]; then APP_COMPOSE+=(-f "$LOCAL_COMPOSE"); fi
  EDGE_COMPOSE=(docker compose -p "$CFG_EDGE_PROJECT" --project-directory "$EDGE_DIR" --env-file "$EDGE_ENV"
    -f "$EDGE_DIR/compose.yml")
}

# load_install <prefix>: the configuration install.sh stored in <prefix>/install.conf, validated,
# and the paths. Exits 2 when there is no install there or its configuration is invalid.
load_install() {
  local prefix=$1
  is_prefix "$prefix" || die "--prefix must be an absolute path without spaces or .. segments" 2
  [ -f "$prefix/install.conf" ] || die "$prefix/install.conf is missing: run install.sh first" 2
  # shellcheck disable=SC2153 # PREFIX is an associative-array key, not a misspelling of $prefix
  INSTALL_ARGS=([PREFIX]=$prefix)
  resolve_install_config "$prefix/install.conf"
  validate_install_config || exit 2
  set_install_paths
}

app_compose() { "${APP_COMPOSE[@]}" "$@"; }

# local_compose_ignored: reads another version's scripts/deploy/lib/app.sh on stdin; status 0 when
# this server has <prefix>/compose.local.yml and that version's scripts do not know it (they predate
# the override): after a switch to it the panel would run without the operator's additions. Empty
# input (the file could not be read) claims nothing.
local_compose_ignored() {
  local text
  text=$(cat)
  [ -f "$LOCAL_COMPOSE" ] && [ -n "$text" ] && ! grep -q compose.local.yml <<<"$text"
}

local_compose_warning() {
  warn "$1 does not know $LOCAL_COMPOSE: after the switch the panel runs without it, until a version that knows it is installed again (docs/operations/deployment.md, section 4)"
}
edge_compose() { "${EDGE_COMPOSE[@]}" "$@"; }

# panel_ready: status 0 when /api/health/ready answers 200 on the loopback port.
panel_ready() {
  curl -fs -m 5 -o /dev/null "http://127.0.0.1:$CFG_HTTP_PORT/api/health/ready"
}

# app_psql: psql in the postgres container on the panel's database as its user, SQL on stdin,
# tuples only and unaligned.
app_psql() {
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  app_compose exec -T postgres sh -c 'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

# migration_count: rows in schema_migrations of the panel's database.
migration_count() {
  printf 'SELECT count(*) FROM schema_migrations;\n' | app_psql
}

db_volume_exists() {
  docker volume inspect "${CFG_PROJECT}_postgres_data" >/dev/null 2>&1
}

# project_containers: ids of every container of the panel's compose project, running or not.
project_containers() {
  docker ps -aq --filter "label=com.docker.compose.project=$CFG_PROJECT"
}

# --- Ownership of the compose projects ---
#
# The panel and the edge are compose projects addressed by name (-p). On a shared host another
# project may use the same name, and `up --remove-orphans`, `rm --stop --force` or `stop` would act
# on its containers. A container is this install's when it carries the label
# io.mailexpert.install=<install.conf INSTALL_ID> (compose.prod.yml, edge/compose.yml, every
# docker run of the scripts), or, for containers made before the label existed or before an ID
# change, when compose made it from this install's directory (com.docker.compose.project.working_dir:
# <prefix>/app for the panel, <prefix>/edge for the edge, the --project-directory of
# set_install_paths). io.mailexpert.managed=true alone proves nothing: every install has it.
# Volumes and networks carry only the project label: a changed label on a volume makes compose
# offer to recreate it, with its data, so they get none of ours.

# foreign_containers <project directory> [install ID]: reads "<name>\x1f<working_dir label>\x1f
# <io.mailexpert.install label>" lines on stdin and prints "<name> (<working dir>)" for each
# container that is not this install's: neither its install label is the ID nor its directory the
# project directory. A container without either label was not made by this install's compose.
foreign_containers() {
  local want id=${2:-} name dir owner
  want=$(clean_path "$1")
  while IFS=$'\x1f' read -r name dir owner; do
    [ -n "$name" ] || continue
    if [ -n "$id" ] && [ "$owner" = "$id" ]; then continue; fi
    if [ -n "$dir" ] && [ "$(clean_path "$dir")" = "$want" ]; then continue; fi
    printf '%s (%s)\n' "$name" "${dir:-no compose working directory}${owner:+, install $owner}"
  done
}

COMPOSE_DIR_FORMAT=$'{{.Names}}\x1f{{.Label "com.docker.compose.project.working_dir"}}\x1f{{.Label "io.mailexpert.install"}}'
COMPOSE_PROJECT_FORMAT=$'{{.Name}}\t{{.Label "com.docker.compose.project"}}'

# compose_foreign_containers <project> <project directory>: "<name> (<working dir>)" for each
# container of the project, running or not, that is not this install's (foreign_containers). One
# docker ps; status 1 when Docker does not answer.
compose_foreign_containers() {
  local containers
  containers=$(docker ps -a --filter "label=com.docker.compose.project=$1" --format "$COMPOSE_DIR_FORMAT" </dev/null) ||
    return 1
  foreign_containers "$2" "${CFG_INSTALL_ID:-}" <<<"$containers"
}

# compose_foreign_objects <project> <project directory> [<volume|network>:<name>...]: one line per
# Docker object that compose -p <project> would act on or reuse and that is not this install's:
# containers of the project that are not this install's (foreign_containers); the named volumes and networks (the
# ones the compose files declare) and every volume of the project when they exist with another
# project's label or none, or when a foreign container uses the volume.
compose_foreign_objects() {
  local project=$1 dir=$2 containers volumes networks kind name list line label users
  shift 2
  # Every docker call returns 1 on failure: callers often run this where -e is off.
  containers=$(compose_foreign_containers "$project" "$dir") || return 1
  if [ -n "$containers" ]; then awk '{print "container " $0}' <<<"$containers"; fi
  volumes=$(docker volume ls --format "$COMPOSE_PROJECT_FORMAT" </dev/null) || return 1
  networks=$(docker network ls --format "$COMPOSE_PROJECT_FORMAT" </dev/null) || return 1
  {
    printf '%s\n' "$@"
    awk -F'\t' -v p="$project" '$2 == p {print "volume:" $1}' <<<"$volumes"
  } | sort -u | while IFS=: read -r kind name; do
    [ -n "$name" ] || continue
    if [ "$kind" = volume ]; then list=$volumes; else list=$networks; fi
    line=$(awk -F'\t' -v n="$name" '$1 == n {print; exit}' <<<"$list")
    [ -n "$line" ] || continue
    label=''
    if [[ $line == *$'\t'* ]]; then label=${line#*$'\t'}; fi
    if [ "$label" != "$project" ]; then
      printf '%s %s (compose project: %s)\n' "$kind" "$name" "${label:-none}"
      continue
    fi
    [ "$kind" = volume ] || continue
    users=$(docker ps -a --filter "volume=$name" --format "$COMPOSE_DIR_FORMAT" </dev/null) || return 1
    users=$(foreign_containers "$dir" "${CFG_INSTALL_ID:-}" <<<"$users" | paste -sd, -)
    if [ -n "$users" ]; then printf 'volume %s (used by %s)\n' "$name" "$users"; fi
  done
}

# panel_foreign_objects, edge_foreign_objects: compose_foreign_objects for this install's projects.
panel_foreign_objects() {
  compose_foreign_objects "$CFG_PROJECT" "$APP_DIR" "volume:${CFG_PROJECT}_postgres_data" \
    "volume:${CFG_PROJECT}_redis_data" "network:${CFG_PROJECT}_mailexpert"
}
edge_foreign_objects() {
  [ "$CFG_EDGE" = 1 ] || return 0
  compose_foreign_objects "$CFG_EDGE_PROJECT" "$EDGE_DIR" "volume:${CFG_EDGE_PROJECT}_caddy_data" \
    "volume:${CFG_EDGE_PROJECT}_caddy_config"
}

# guard_compose_projects <what to do for the panel> <what to do for the edge> <exit code when Docker
# does not answer>: stops the script (exit 2) before any compose command when the panel's or the
# edge's project holds Docker objects that are not this install's; nothing is run against them.
# A Docker that cannot be asked stops it with the caller's "nothing changed" code. An edge under a
# name without the mailexpert prefix (an install made before mailexpert-edge) also gets the move.
guard_compose_projects() {
  local foreign edge_next=$2 code=$3
  foreign=$(panel_foreign_objects) ||
    die "cannot list Docker's containers, volumes and networks to check compose project $CFG_PROJECT (the error is above); nothing was changed" "$code"
  [ -z "$foreign" ] ||
    die "compose project $CFG_PROJECT is not only this install's (its directory is $APP_DIR): $(paste -sd';' - <<<"$foreign"); nothing was run against them; $1" 2
  foreign=$(edge_foreign_objects) ||
    die "cannot list Docker's containers, volumes and networks to check compose project $CFG_EDGE_PROJECT (the error is above); nothing was changed" "$code"
  if ! is_prefixed_name "$CFG_EDGE_PROJECT"; then
    edge_next+="; or move this install's edge off the shared name: $(edge_move_steps)"
  fi
  [ -z "$foreign" ] ||
    die "compose project $CFG_EDGE_PROJECT is not only this install's (its directory is $EDGE_DIR): $(paste -sd';' - <<<"$foreign"); nothing was run against them; $edge_next" 2
}

# panel_exec_problem: why nothing may be exec'd or run in the panel's compose project, on stdout;
# nothing and status 0 when every container of the project is this install's. `compose exec` and
# `compose run` find the service's container by project and service name: in a neighbour's project
# of the same name they would reach its containers (with the secrets piped into them). One docker
# ps, containers only, to keep the CLI fast: install.sh and update.sh check the volumes and
# networks. Status 2 when a container is not this install's, 1 when Docker does not answer.
panel_exec_problem() {
  local foreign
  if ! foreign=$(compose_foreign_containers "$CFG_PROJECT" "$APP_DIR"); then
    printf '%s\n' "cannot list Docker's containers to check compose project $CFG_PROJECT (the error is above); nothing was run in it"
    return 1
  fi
  [ -n "$foreign" ] || return 0
  printf '%s\n' "compose project $CFG_PROJECT is not only this install's (its directory is $APP_DIR): $(awk '{print "container " $0}' <<<"$foreign" | paste -sd';' -); nothing was run in it: find out whose they are (docker inspect <name>); this install does not exec or run anything in that project while they are there"
  return 2
}

# guard_panel_exec <exit code when a container is not this install's> <exit code when Docker does
# not answer>: panel_exec_problem before a compose exec in the panel's project (the CLI wrappers);
# stops the script with the code for the case.
guard_panel_exec() {
  local problem code=0
  problem=$(panel_exec_problem) || code=$?
  case $code in
    0) return 0 ;;
    2) die "$problem" "$1" ;;
    *) die "$problem" "$2" ;;
  esac
}

# guard_existing_projects <exit code when Docker does not answer>: guard_compose_projects for the
# scripts that serve an existing install (update, rollback, restore), where another name is not
# the way out.
guard_existing_projects() {
  local next='find out whose they are (docker inspect <name>); this install does not run compose for that project while they are there'
  guard_compose_projects "$next" "$next" "$1"
}

# Standby: install.sh --no-start prepared this server, or restore.sh is filling it; the panel it
# holds is not the live one. The timers skip it: a backup from here would become `latest` in
# the shared repository, and a health check would page the owner about a panel that is off on
# purpose. install.sh clears the marker when it starts the panel.
is_standby() { [ -f "$STATE_DIR/standby" ]; }
set_standby() { : >"$STATE_DIR/standby"; }
clear_standby() { rm -f "$STATE_DIR/standby"; }

# lock_held <file>: status 0 when another process holds the flock on <file> exclusively. A shared
# hold does not count: backup.sh holds update.lock shared while it dumps the database, which is
# not an update, a rollback or a restore.
lock_held() {
  local fd
  [ -e "$1" ] || return 1
  exec {fd}<"$1"
  if flock -n -s "$fd"; then
    exec {fd}<&-
    return 1
  fi
  exec {fd}<&-
  return 0
}
