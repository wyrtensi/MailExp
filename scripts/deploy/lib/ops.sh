# shellcheck shell=bash
# Decisions of restore.sh and update.sh. Needs common.sh and env.sh.

# merge_restored_keys <dest env> <restored env> <overwrite|fill> <key...>: copies keys from the
# .env of a snapshot. overwrite: the restored value replaces the local one; fill: only keys that
# are empty here are written. Keys empty or absent in the snapshot are skipped. Prints the name
# of each key written, never a value.
merge_restored_keys() {
  local dest=$1 src=$2 mode=$3 key value current
  shift 3
  case $mode in overwrite | fill) ;; *) die "merge_restored_keys: unknown mode $mode" 2 ;; esac
  for key in "$@"; do
    value=$(env_get "$src" "$key") || value=
    [ -n "$value" ] || continue
    current=$(env_get "$dest" "$key") || current=
    [ "$current" != "$value" ] || continue
    if [ "$mode" = fill ] && [ -n "$current" ]; then continue; fi
    env_set "$dest" "$key" "$value"
    printf '%s\n' "$key"
  done
}

# tenant_files_missing <local env> <restored env> <app dir>: when the tenant profile is on once
# the restored keys fill this server's .env, prints each file the tenant worker needs and this
# server lacks (the PFX in TENANT_CERT_DIR, TENANT_PFX_PASSWORD_FILE; relative paths and compose's
# defaults resolve against the checkout, compose's project directory). Paths only, never contents.
tenant_files_missing() {
  local key value
  local -A eff=()
  for key in COMPOSE_PROFILES TENANT_CERT_DIR TENANT_PFX_PASSWORD_FILE; do
    value=$(env_get "$1" "$key") || value=
    if [ -z "$value" ]; then value=$(env_get "$2" "$key") || value=; fi
    eff[$key]=$value
  done
  [[ ",${eff[COMPOSE_PROFILES]// /}," == *,tenant,* ]] || return 0
  for value in "${eff[TENANT_CERT_DIR]:-./tenant-cert}/app.pfx" \
    "${eff[TENANT_PFX_PASSWORD_FILE]:-./tenant-secrets/app.pfx.password}"; do
    case $value in /*) ;; *) value=$3/${value#./} ;; esac
    [ -f "$value" ] || printf '%s\n' "$value"
  done
  return 0
}

# space_problem <free kB> <last dump bytes>: an update needs twice the dump free: the local
# pre-update dump, and room to restore it next to the current database if the update is undone.
space_problem() {
  local free=$(($1 * 1024)) need=$(($2 * 2))
  if [ "$free" -lt "$need" ]; then
    echo "free space: $(($1 / 1024)) MB, the update needs $((need / 1048576)) MB (twice the last dump)"
  fi
  return 0
}

# rollback_space_problem <free kB> <dump bytes> <database bytes>: rollback.sh restores the dump
# into a new database next to the live one, which it replaces only afterwards, and keeps both: it
# needs the size of the live database (what the restored copy can grow to) plus the dump.
rollback_space_problem() {
  local free=$(($1 * 1024)) need=$(($2 + $3))
  if [ "$free" -lt "$need" ]; then
    echo "free space: $(($1 / 1024)) MB, the rollback needs $((need / 1048576)) MB (the database next to its restored copy, plus the dump)"
  fi
  return 0
}

# stale_local_dumps <keep>: reads dump paths, newest first, and prints the ones beyond <keep>.
stale_local_dumps() {
  tail -n +"$(($1 + 1))"
}

# The EDGE_IMAGE an update replaced, kept so that going back to that version restores it:
# <state dir>/edge-image.previous holds "<version left> <image>".

# save_previous_edge_image <version left> <image>
save_previous_edge_image() {
  printf '%s %s\n' "$1" "$2" >"$STATE_DIR/edge-image.previous"
}

# previous_edge_image <version>: the edge image that ran with <version> before an update replaced
# it; status 1 when no update replaced it.
previous_edge_image() {
  local version='' image=''
  [ -f "$STATE_DIR/edge-image.previous" ] || return 1
  read -r version image <"$STATE_DIR/edge-image.previous" || true
  [ "$version" = "$1" ] && [ -n "$image" ] || return 1
  printf '%s\n' "$image"
}

# edge_image_changes <edge services, comma-separated>: reads the paths changed between two
# versions on stdin; status 0 when the Caddy image changes (it is built from deploy/edge/Dockerfile;
# the Caddyfile and the compose file are written by install.sh) and this install runs Caddy.
edge_image_changes() {
  [[ ",$1," == *,caddy,* ]] || return 1
  grep -q '^deploy/edge/Dockerfile$'
}
