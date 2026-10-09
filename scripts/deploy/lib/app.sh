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
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
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
# on its containers. Compose labels each container with the directory it ran from
# (com.docker.compose.project.working_dir): this install's are <prefix>/app (the panel) and
# <prefix>/edge (the edge), the --project-directory of set_install_paths. Volumes and networks
# carry only the project label.

# clean_path <path>: the path without repeated slashes, "/./" and a trailing slash, as compose
# records it.
clean_path() {
  local path=$1
  while [[ $path == *//* ]]; do path=${path//\/\//\/}; done
  while [[ $path == */./* ]]; do path=${path//\/.\//\/}; done
  if [ "$path" != / ]; then path=${path%/}; fi
  printf '%s\n' "$path"
}

# foreign_containers <project directory>: reads "<name>\t<working_dir label>" lines on stdin and
# prints "<name> (<working dir>)" for each container that did not run from <project directory>. A
# container without the label was not made by compose: it is foreign too.
foreign_containers() {
  local want name dir
  want=$(clean_path "$1")
  while IFS=$'\t' read -r name dir; do
    [ -n "$name" ] || continue
    if [ -n "$dir" ] && [ "$(clean_path "$dir")" = "$want" ]; then continue; fi
    printf '%s (%s)\n' "$name" "${dir:-no compose working directory}"
  done
}

COMPOSE_DIR_FORMAT=$'{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}'
COMPOSE_PROJECT_FORMAT=$'{{.Name}}\t{{.Label "com.docker.compose.project"}}'

# compose_foreign_objects <project> <project directory> [<volume|network>:<name>...]: one line per
# Docker object that compose -p <project> would act on or reuse and that is not this install's:
# containers of the project that ran from another directory; the named volumes and networks (the
# ones the compose files declare) and every volume of the project when they exist with another
# project's label or none, or when a foreign container uses the volume.
compose_foreign_objects() {
  local project=$1 dir=$2 volumes networks kind name list line label users
  shift 2
  docker ps -a --filter "label=com.docker.compose.project=$project" --format "$COMPOSE_DIR_FORMAT" </dev/null |
    foreign_containers "$dir" | sed 's/^/container /'
  volumes=$(docker volume ls --format "$COMPOSE_PROJECT_FORMAT" </dev/null)
  networks=$(docker network ls --format "$COMPOSE_PROJECT_FORMAT" </dev/null)
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
    users=$(docker ps -a --filter "volume=$name" --format "$COMPOSE_DIR_FORMAT" </dev/null | foreign_containers "$dir" | paste -sd, -)
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

# guard_compose_projects <what to do for the panel> <what to do for the edge>: stops the script
# (exit 2) before any compose command when the panel's or the edge's project holds Docker objects
# that are not this install's; nothing is run against them.
guard_compose_projects() {
  local foreign
  foreign=$(panel_foreign_objects)
  [ -z "$foreign" ] ||
    die "compose project $CFG_PROJECT is not only this install's (its directory is $APP_DIR): $(paste -sd';' - <<<"$foreign"); nothing was run against them; $1" 2
  foreign=$(edge_foreign_objects)
  [ -z "$foreign" ] ||
    die "compose project $CFG_EDGE_PROJECT is not only this install's (its directory is $EDGE_DIR): $(paste -sd';' - <<<"$foreign"); nothing was run against them; $2" 2
}

# guard_existing_projects: guard_compose_projects for the scripts that serve an existing install
# (update, rollback, restore), where another name is not the way out.
guard_existing_projects() {
  local next='find out whose they are (docker inspect <name>); this install does not run compose for that project while they are there'
  guard_compose_projects "$next" "$next"
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
