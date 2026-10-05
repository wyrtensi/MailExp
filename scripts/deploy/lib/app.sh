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
