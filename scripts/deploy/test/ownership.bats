#!/usr/bin/env bats
# Ownership of the compose projects on a shared host (lib/app.sh guard_compose_projects) and
# install.sh's prechecks: the loopback port, a caddy that is not this install's edge, flock.
# docker and ss are fakes answering from files: what other projects left on the host.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P"
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 \
    PROJECT=me-test EDGE_PROJECT=me-test-edge HTTP_PORT=18090 >"$P/install.conf"
  load_install "$P"
  # The install.sh functions under test (install.sh itself runs main when sourced).
  # shellcheck source=/dev/null
  source <(sed -n '/^guard_projects() {/,/^}/p; /^own_caddy_running() {/,/^}/p; /^panel_holds_port() {/,/^}/p; /^check_ports() {/,/^}/p; /^check_tools() {/,/^}/p' "$DEPLOY_DIR/install.sh")
  export FAKE_DOCKER=$BATS_TEST_TMPDIR/docker
  mkdir -p "$FAKE_DOCKER" "$BATS_TEST_TMPDIR/bin"
  cat >"$BATS_TEST_TMPDIR/bin/docker" <<'STUB_EOF'
#!/usr/bin/env bash
# ps answers from ps-<project> ("<name>\t<working_dir>"), ps-volume-<volume> (the containers that
# use it), caddy-<project> (a running caddy of the project) and ports-<project> ({{.Ports}});
# volume ls and network ls from volumes and networks ("<name>\t<project label>").
D=$FAKE_DOCKER
printf '%s\n' "$*" >>"$D/calls"
# A file "down": the daemon does not answer.
if [ -f "$D/down" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
case $1 in
  ps)
    f=''
    for a in "$@"; do
      case $a in
        label=com.docker.compose.project=*) f=${a#label=com.docker.compose.project=} ;;
        volume=*) f=volume-${a#volume=} ;;
      esac
    done
    case " $* " in
      *" label=com.docker.compose.service=caddy "*) f=caddy-$f ;;
      *" {{.Ports}} "*) f=ports-$f ;;
      *) f=ps-$f ;;
    esac
    cat "$D/$f" 2>/dev/null
    ;;
  volume) [ "$2" != ls ] || cat "$D/volumes" 2>/dev/null ;;
  network) [ "$2" != ls ] || cat "$D/networks" 2>/dev/null ;;
esac
exit 0
STUB_EOF
  printf '#!/bin/sh\nprintf "%%s\\n" "$FAKE_SS"\n' >"$BATS_TEST_TMPDIR/bin/ss"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker" "$BATS_TEST_TMPDIR/bin/ss"
  PATH=$BATS_TEST_TMPDIR/bin:$PATH
  export FAKE_SS=''
}

fake() { printf "$2\n" "${@:3}" >>"$FAKE_DOCKER/$1"; }
compose_calls() { grep -c '^compose' "$FAKE_DOCKER/calls" || true; }

# --- the guard -----------------------------------------------------------------------------------

@test "clean_path and foreign_containers" {
  [ "$(clean_path /opt//mailexpert/./app/)" = /opt/mailexpert/app ]
  [ "$(clean_path /)" = / ]
  out=$(printf 'a\t/opt/me/app\nb\t/opt/me//app/\nc\t/srv/other\nd\t\n' | foreign_containers /opt/me/app)
  [ "$out" = $'c (/srv/other)\nd (no compose working directory)' ]
}

@test "guard: empty projects (a new install) proceed" {
  guard_projects
  guard_existing_projects
  [ "$(compose_calls)" = 0 ]
}

@test "guard: this install's own containers, volumes and network proceed" {
  fake ps-me-test '%s\t%s' me-test-backend "$P/app" me-test-postgres "$P/app/"
  fake ps-me-test-edge '%s\t%s' me-test-edge-caddy-1 "$P//edge"
  fake volumes '%s\t%s' me-test_postgres_data me-test me-test-edge_caddy_data me-test-edge unrelated_data other
  fake networks '%s\t%s' me-test_mailexpert me-test bridge ''
  fake ps-volume-me-test_postgres_data '%s\t%s' me-test-postgres "$P/app"
  guard_projects
}

@test "guard: a panel container from another directory refuses before any compose command" {
  fake ps-me-test '%s\t%s' me-test-backend "$P/app" me-test-web /srv/neighbour
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"compose project me-test is not only this install's (its directory is $P/app): container me-test-web (/srv/neighbour)"* ]]
  [[ $output == *"nothing was run against them; choose another name for the panel with --project <name>"* ]]
  [[ $output != *me-test-backend* ]]
  [ "$(compose_calls)" = 0 ]
}

@test "guard: an edge container from another directory refuses with --edge-project" {
  fake ps-me-test-edge '%s\t%s' me-test-edge-caddy-1 /srv/neighbour/edge
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"compose project me-test-edge is not only this install's (its directory is $P/edge): container me-test-edge-caddy-1 (/srv/neighbour/edge)"* ]]
  [[ $output == *"choose another name for the edge with --edge-project <name>"* ]]
  [ "$(compose_calls)" = 0 ]
}

@test "guard: a container with the project label but no compose working directory is foreign" {
  fake ps-me-test '%s\t%s' hand-made ''
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"container hand-made (no compose working directory)"* ]]
}

@test "guard: volumes and networks under our names from another project, or no project, refuse" {
  fake volumes '%s\t%s' me-test_postgres_data other-panel
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"volume me-test_postgres_data (compose project: other-panel)"* ]]
  : >"$FAKE_DOCKER/volumes"
  fake volumes '%s\t%s' me-test-edge_caddy_data ''
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"compose project me-test-edge"*"volume me-test-edge_caddy_data (compose project: none)"* ]]
  : >"$FAKE_DOCKER/volumes"
  fake networks '%s\t%s' me-test_mailexpert someone
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"network me-test_mailexpert (compose project: someone)"* ]]
}

@test "guard: a volume of the project that a foreign container uses refuses" {
  fake volumes '%s\t%s' me-test_extra me-test
  fake ps-volume-me-test_extra '%s\t%s' neighbour-db /srv/neighbour
  run guard_projects
  [ "$status" -eq 2 ]
  [[ $output == *"volume me-test_extra (used by neighbour-db (/srv/neighbour))"* ]]
}

@test "guard: a Docker that does not answer stops the script, nothing is run" {
  : >"$FAKE_DOCKER/down"
  run guard_projects
  [ "$status" -eq 1 ]
  [[ $output == *"cannot list Docker's containers, volumes and networks to check compose project me-test"* ]]
  [ "$(compose_calls)" = 0 ]
  run compose_foreign_objects me-test "$P/app"
  [ "$status" -eq 1 ]
}

@test "guard: without an edge the edge project is not checked" {
  CFG_EDGE=0
  fake ps-me-test-edge '%s\t%s' me-test-edge-caddy-1 /srv/neighbour/edge
  guard_projects
}

@test "guard_existing_projects: update, rollback and restore stop with exit 2 and no new name" {
  fake ps-me-test '%s\t%s' me-test-web /srv/neighbour
  run guard_existing_projects
  [ "$status" -eq 2 ]
  [[ $output == *"find out whose they are (docker inspect <name>)"* ]]
  [[ $output != *"--project"* ]]
}

@test "update.sh, rollback.sh and restore.sh guard before their first compose command" {
  first=$(grep -n 'guard_existing_projects$' "$DEPLOY_DIR/update.sh" | cut -d: -f1)
  backup=$(grep -n 'bash "$SCRIPT_DIR/backup.sh"' "$DEPLOY_DIR/update.sh" | cut -d: -f1)
  [ -n "$first" ] && [ "$first" -lt "$backup" ]
  first=$(grep -n 'guard_existing_projects$' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  stop=$(grep -n 'app_compose stop backend frontend' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  [ -n "$first" ] && [ "$first" -lt "$stop" ]
  first=$(grep -n 'guard_existing_projects$' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  check=$(grep -n 'if db_volume_exists; then' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  [ -n "$first" ] && [ "$first" -lt "$check" ]
  first=$(grep -n '^  guard_projects$' "$DEPLOY_DIR/install.sh" | cut -d: -f1)
  ports=$(grep -n '^  check_ports$' "$DEPLOY_DIR/install.sh" | cut -d: -f1)
  conf=$(grep -n '^  write_install_conf ' "$DEPLOY_DIR/install.sh" | cut -d: -f1)
  [ -n "$first" ] && [ "$first" -lt "$ports" ] && [ "$first" -lt "$conf" ]
}

# --- install.sh prechecks ------------------------------------------------------------------------

@test "check_ports: --http-port held by something else on loopback stops a start" {
  FAKE_SS='LISTEN 0 4096 127.0.0.1:18090 0.0.0.0:* users:(("node",pid=10,fd=6))'
  run check_ports
  [ "$status" -eq 1 ]
  [[ $output == *"--http-port 18090 is taken on 127.0.0.1 by something other than this panel: 18090 node; choose another --http-port"* ]]
  # --no-start prepares a server: a warning, the start would fail later.
  OPT_START=0
  run check_ports
  [ "$status" -eq 0 ]
  [[ $output == *"warning: --http-port 18090 is taken"*"the panel is not started now"* ]]
}

@test "check_ports: --http-port held by this panel's own frontend is fine" {
  FAKE_SS='LISTEN 0 4096 127.0.0.1:18090 0.0.0.0:* users:(("docker-proxy",pid=10,fd=6))'
  fake ports-me-test '%s' '127.0.0.1:18090->80/tcp'
  run check_ports
  [ "$status" -eq 0 ]
  [[ $output != *"--http-port"* ]]
  # Another port of the panel does not make 18090 ours.
  : >"$FAKE_DOCKER/ports-me-test"
  fake ports-me-test '%s' '127.0.0.1:28090->80/tcp'
  run check_ports
  [ "$status" -eq 1 ]
}

@test "check_ports: a caddy on 80/443 that is not this install's edge is a conflict" {
  FAKE_SS='LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=11,fd=7))
LISTEN 0 4096 *:443 *:* users:(("caddy",pid=11,fd=8))'
  run check_ports
  [ "$status" -eq 1 ]
  [[ $output == *"ports for the edge are taken: 443 caddy;80 caddy (that caddy is not this install's edge"* ]]
  # The edge project's own caddy runs (host network): it holds the ports.
  fake caddy-me-test-edge '%s' 0123456789ab
  run check_ports
  [ "$status" -eq 0 ]
  # A tunnel-only edge does not need 80/443.
  : >"$FAKE_DOCKER/caddy-me-test-edge"
  CFG_SIGNIN=cf
  run check_ports
  [ "$status" -eq 0 ]
}

@test "check_tools: flock is required" {
  local tool bin=$BATS_TEST_TMPDIR/tools
  mkdir -p "$bin"
  for tool in git curl jq ss sha256sum timeout; do printf '#!/bin/sh\n' >"$bin/$tool" && chmod +x "$bin/$tool"; done
  tools_in() {
    local PATH=$1
    check_tools
  }
  run tools_in "$bin"
  [ "$status" -eq 1 ]
  [[ $output == *"error: flock is required"* ]]
  printf '#!/bin/sh\n' >"$bin/flock" && chmod +x "$bin/flock"
  run tools_in "$bin"
  [ "$status" -eq 0 ]
}
