#!/usr/bin/env bats
# The install ID (install.conf INSTALL_ID) and the labels every container of an install carries:
# io.mailexpert.managed=true, io.mailexpert.component and io.mailexpert.install=<ID>.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  C=$BATS_TEST_TMPDIR/install.conf
  # shellcheck source=/dev/null
  source <(sed -n '/^ensure_install_id() {/,/^}/p' "$DEPLOY_DIR/install.sh")
}

configure() {
  install_defaults
  parse_install_args "$@"
  resolve_install_config "$C"
}

@test "a new install gets an ID once; install.conf keeps it across reruns" {
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  [ -z "$CFG_INSTALL_ID" ]
  ensure_install_id 2>/dev/null
  is_install_id "$CFG_INSTALL_ID"
  id=$CFG_INSTALL_ID
  write_install_conf "$C"
  [ "$(env_get "$C" INSTALL_ID)" = "$id" ]
  # A rerun (or update.sh's install.sh) reads it back and does not make another.
  configure
  [ "$CFG_INSTALL_ID" = "$id" ]
  run ensure_install_id
  [ -z "$output" ]
  validate_install_config
  # It is no flag.
  run parse_install_args --install-id fedcba9876543210
  [ "$status" -eq 2 ]
}

@test "an install made before the IDs gets one on its next run, nothing else changes" {
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 EDGE_PROJECT=edge >"$C"
  configure
  [ -z "$CFG_INSTALL_ID" ]
  validate_install_config
  ensure_install_id 2>/dev/null
  write_install_conf "$C"
  is_install_id "$(env_get "$C" INSTALL_ID)"
  [ "$(env_get "$C" EDGE_PROJECT)" = edge ]
}

@test "a changed INSTALL_ID in install.conf is used as it is; a malformed one is refused" {
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 INSTALL_ID=fedcba9876543210 >"$C"
  configure
  [ "$CFG_INSTALL_ID" = fedcba9876543210 ]
  validate_install_config
  printf 'INSTALL_ID=XYZ\n' >>"$C"
  configure
  run validate_install_config
  [ "$status" -eq 2 ]
  [[ $output == *"INSTALL_ID must be 16 lowercase hex characters"* ]]
}

@test "the ID reaches the panel's .env and the edge's .env" {
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  CFG_INSTALL_ID=0123456789abcdef
  run app_settings
  [[ $output == *"MAILEXPERT_INSTALL_ID=0123456789abcdef"* ]]
  write_edge_files "$REPO_DIR" "$BATS_TEST_TMPDIR/edge" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$(env_get "$BATS_TEST_TMPDIR/edge/.env" MAILEXPERT_INSTALL_ID)" = 0123456789abcdef ]
}

# services_without_labels <compose file>: the services that do not take the x-labels anchor.
services_without_labels() {
  awk '
    { sub(/\r$/, "") }
    /^services:/ { in_services = 1; next }
    /^[^ #]/ { in_services = 0 }
    in_services && /^  [a-z][a-z0-9-]*:$/ { if (name != "" && !labelled) print name; name = substr($1, 1, length($1) - 1); labelled = 0; next }
    in_services && /^    labels: \*labels$/ { labelled = 1 }
    END { if (name != "" && !labelled) print name }
  ' "$1"
}

@test "every service of the panel and the edge carries the labels; volumes and networks carry none" {
  local file
  for file in "$REPO_DIR/deploy/compose.prod.yml" "$REPO_DIR/deploy/edge/compose.yml"; do
    grep -q '^x-labels: &labels$' "$file"
    grep -q '^  io.mailexpert.managed: "true"$' "$file"
    grep -q '^  io.mailexpert.install: ${MAILEXPERT_INSTALL_ID:-}$' "$file"
    [ -z "$(services_without_labels "$file")" ]
  done
  [ "$(tr -d '\r' <"$REPO_DIR/deploy/compose.prod.yml" | grep -c '^    labels: \*labels$')" = 5 ]
  [ "$(tr -d '\r' <"$REPO_DIR/deploy/edge/compose.yml" | grep -c '^    labels: \*labels$')" = 2 ]
  grep -q '^  io.mailexpert.component: panel$' "$REPO_DIR/deploy/compose.prod.yml"
  grep -q '^  io.mailexpert.component: edge$' "$REPO_DIR/deploy/edge/compose.yml"
  # Every service of the base file is in the overlay, so it gets the labels. The base file has none
  # of its own: the parser must find all of them (an empty list would prove nothing).
  [ "$(services_without_labels "$REPO_DIR/docker-compose.yml" | sort | paste -sd' ' -)" = "backend caddy frontend postgres redis tenant-worker" ]
  for service in $(services_without_labels "$REPO_DIR/docker-compose.yml"); do
    [ "$service" = caddy ] && continue # profile "https": dev only, not started by install.sh
    grep -q "^  $service:$" "$REPO_DIR/deploy/compose.prod.yml"
  done
  # A label on a volume or network: compose would offer to recreate it when the ID changes.
  run grep -n -A3 '^  [a-z_]*:$' <(sed -n '/^volumes:/,$p' "$REPO_DIR/deploy/edge/compose.yml")
  [[ $output != *labels* ]]
  run grep -E '^(volumes|networks):' "$REPO_DIR/deploy/compose.prod.yml"
  [ "$status" -eq 1 ]
}

@test "managed_label_args, and the containers the scripts start by hand carry them" {
  managed_label_args labels verify 0123456789abcdef
  [ "${labels[*]}" = "--label io.mailexpert.managed=true --label io.mailexpert.component=verify --label io.mailexpert.install=0123456789abcdef" ]
  managed_label_args labels node-restic
  [ "${labels[*]}" = "--label io.mailexpert.managed=true --label io.mailexpert.component=node-restic" ]
  # restic_run, as the panel's backup and restore run it.
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s/calls"\n' "$BATS_TEST_TMPDIR" >"$BATS_TEST_TMPDIR/bin/docker"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  STATE_DIR=$BATS_TEST_TMPDIR/state CFG_INSTALL_ID=0123456789abcdef PATH=$BATS_TEST_TMPDIR/bin:$PATH restic_run -- snapshots
  grep -q -- '^run --rm --network host --label io.mailexpert.managed=true --label io.mailexpert.component=restic --label io.mailexpert.install=0123456789abcdef ' "$BATS_TEST_TMPDIR/calls"
  # Every other docker run of the panel's scripts takes managed_label_args.
  run grep -n 'docker run ' "$DEPLOY_DIR/install.sh" "$DEPLOY_DIR/backup.sh" "$DEPLOY_DIR/lib/env.sh" "$DEPLOY_DIR/lib/backup.sh"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'labels\[@\]' <<<"$output")" = "${#lines[@]}" ]
}
