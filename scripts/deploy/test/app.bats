#!/usr/bin/env bats
# The installed panel as the deploy scripts load it: install.conf, paths, compose commands.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P"
}

write_conf() {
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 \
    PROJECT=me-test HTTP_PORT=18090 "$@" >"$P/install.conf"
}

@test "load_install reads install.conf and derives the paths and commands" {
  write_conf
  load_install "$P"
  [ "$CFG_PROJECT" = me-test ] && [ "$CFG_HTTP_PORT" = 18090 ] && [ "$OPT_PREFIX" = "$P" ]
  [ "$APP_DIR" = "$P/app" ] && [ "$STATE_DIR" = "$P/state" ] && [ "$BACKUP_DIR" = "$P/backups" ]
  [ "$ENV_FILE" = "$P/.env" ] && [ "$EDGE_ENV" = "$P/edge/.env" ]
  [ "$BACKEND_IMAGE" = ghcr.io/wyrtensi/mailexpert-backend:sha-0123456789ab ]
  [ "${APP_COMPOSE[*]}" = "docker compose -p me-test --project-directory $P/app --env-file $P/.env -f $P/app/docker-compose.yml -f $P/app/deploy/compose.prod.yml" ]
  [ "${EDGE_COMPOSE[*]}" = "docker compose -p edge --project-directory $P/edge --env-file $P/edge/.env -f $P/edge/compose.yml" ]
}

@test "load_install adds <prefix>/compose.local.yml after the production overlay when it exists" {
  write_conf
  printf 'services: {}\n' >"$P/compose.local.yml"
  load_install "$P"
  [ "$LOCAL_COMPOSE" = "$P/compose.local.yml" ]
  [ "${APP_COMPOSE[*]}" = "docker compose -p me-test --project-directory $P/app --env-file $P/.env -f $P/app/docker-compose.yml -f $P/app/deploy/compose.prod.yml -f $P/compose.local.yml" ]
  # The edge is another project: the override is the panel's only.
  [ "${EDGE_COMPOSE[*]}" = "docker compose -p edge --project-directory $P/edge --env-file $P/edge/.env -f $P/edge/compose.yml" ]
}

@test "app_compose passes the local override to docker compose" {
  write_conf
  printf 'services: {}\n' >"$P/compose.local.yml"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\nprintf "%%s\\n" "$@"\n' >"$BATS_TEST_TMPDIR/bin/docker"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  load_install "$P"
  PATH=$BATS_TEST_TMPDIR/bin:$PATH run app_compose ps
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | tail -n 3 | paste -sd' ' -)" = "-f $P/compose.local.yml ps" ]
}

@test "set_install_paths, as install.sh calls it, adds the override only when the file is there" {
  INSTALL_ARGS=([PREFIX]=$P)
  resolve_install_config "$P/install.conf"
  set_install_paths
  [[ " ${APP_COMPOSE[*]} " != *compose.local.yml* ]]
  : >"$P/compose.local.yml"
  set_install_paths
  [ "${APP_COMPOSE[-1]}" = "$P/compose.local.yml" ] && [ "${APP_COMPOSE[-2]}" = -f ]
  # A directory of that name is not a compose file.
  rm "$P/compose.local.yml" && mkdir "$P/compose.local.yml"
  set_install_paths
  [[ " ${APP_COMPOSE[*]} " != *compose.local.yml* ]]
}

@test "load_install without install.conf exits 2" {
  run load_install "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"install.conf is missing: run install.sh first"* ]]
}

@test "load_install rejects an invalid install.conf and a relative prefix" {
  write_conf VERSION=latest
  run load_install "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"--version must be"* ]]
  run load_install relative/path
  [ "$status" -eq 2 ]
}

@test "the standby marker" {
  write_conf
  load_install "$P"
  mkdir -p "$STATE_DIR"
  run is_standby
  [ "$status" -eq 1 ]
  set_standby
  is_standby
  clear_standby
  run is_standby
  [ "$status" -eq 1 ]
}
