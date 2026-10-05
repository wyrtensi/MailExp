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

# profile_on <env file> <profile>: status 0 when the file's COMPOSE_PROFILES names the profile.
profile_on() {
  local list
  list=$(env_get "$1" COMPOSE_PROFILES) || list=
  [[ ",${list// /}," == *",$2,"* ]]
}

# add_restored_profile <dest env> <restored env> <profile>: when the snapshot's COMPOSE_PROFILES
# names the profile and this server's does not, appends it to this server's list (its other
# profiles stay). Prints COMPOSE_PROFILES when it changed the file.
add_restored_profile() {
  local current
  profile_on "$2" "$3" || return 0
  profile_on "$1" "$3" && return 0
  current=$(env_get "$1" COMPOSE_PROFILES) || current=
  current=${current// /}
  env_set "$1" COMPOSE_PROFILES "${current:+$current,}$3"
  printf '%s\n' COMPOSE_PROFILES
}

# The tenant worker's files (docs/operations/mail-node.md, section 6e): the PFX in TENANT_CERT_DIR
# and its password in TENANT_PFX_PASSWORD_FILE. The worker runs as this uid
# (deploy/tenant-worker/Dockerfile): it owns both files (0400) and their directories (0500).
# A panel snapshot holds them as tenant/app.pfx and tenant/app.pfx.password, in this order.
# shellcheck disable=SC2034 # read by backup.sh, restore.sh and tests
TENANT_WORKER_UID=10001
# shellcheck disable=SC2034
TENANT_SNAPSHOT_FILES=(app.pfx app.pfx.password)

# tenant_file_targets <app dir> <env file...>: when the tenant profile is on in any of the files,
# prints the PFX path, then the password file path. Each key comes from the first file that sets
# it, else compose's default; relative paths resolve against the checkout, compose's project
# directory. Nothing when the profile is off everywhere. Paths only, never contents.
tenant_file_targets() {
  local app=$1 file key value on=0
  local -A eff=()
  shift
  for file in "$@"; do
    if profile_on "$file" tenant; then on=1; fi
  done
  [ "$on" = 1 ] || return 0
  for key in TENANT_CERT_DIR TENANT_PFX_PASSWORD_FILE; do
    value=
    for file in "$@"; do
      value=$(env_get "$file" "$key") || value=
      [ -z "$value" ] || break
    done
    eff[$key]=$value
  done
  for value in "${eff[TENANT_CERT_DIR]:-./tenant-cert}/app.pfx" \
    "${eff[TENANT_PFX_PASSWORD_FILE]:-./tenant-secrets/app.pfx.password}"; do
    case $value in /*) ;; *) value=$app/${value#./} ;; esac
    printf '%s\n' "$value"
  done
}

# tenant_files_missing <local env> <restored env> <app dir>: when the tenant profile is on here or
# in the snapshot (restore.sh adds the snapshot's to this server's profiles), prints each file the
# tenant worker needs and this server lacks (tenant_file_targets, this server's settings first).
tenant_files_missing() {
  local path
  while IFS= read -r path; do
    [ -f "$path" ] || printf '%s\n' "$path"
  done < <(tenant_file_targets "$3" "$1" "$2")
  return 0
}

# place_tenant_files <snapshot dir> <local env> <restored env> <app dir>: puts the snapshot's
# tenant/app.pfx and tenant/app.pfx.password where tenant_file_targets points, only where this
# server has no file yet (the ones set here stay), owned by the worker's uid, 0400, in a directory
# created 0500 for it when absent. All or nothing: when a missing file is not in the snapshot
# either (an older snapshot, or one made while the file was missing), nothing is placed and
# tenant_files_missing names the paths. Prints each path written, never contents.
place_tenant_files() {
  local src=$1/tenant i=0 path dir
  local -a targets=() todo=()
  mapfile -t targets < <(tenant_file_targets "$4" "$2" "$3")
  for path in "${targets[@]}"; do
    if [ ! -f "$path" ]; then
      [ -f "$src/${TENANT_SNAPSHOT_FILES[$i]}" ] || return 0
      todo+=("$i")
    fi
    i=$((i + 1))
  done
  for i in "${todo[@]}"; do
    path=${targets[$i]}
    dir=$(dirname "$path")
    if [ ! -d "$dir" ]; then
      mkdir -p "$(dirname "$dir")"
      install -d -o "$TENANT_WORKER_UID" -g 0 -m 0500 "$dir"
    fi
    install -o "$TENANT_WORKER_UID" -g 0 -m 0400 "$src/${TENANT_SNAPSHOT_FILES[$i]}" "$path"
    printf '%s\n' "$path"
  done
}

# stage_tenant_files <staging dir> <env file> <app dir>: with the tenant profile on, copies the PFX
# and its password file into <staging dir>/tenant (root, 0600) for the snapshot. A file that is
# absent is skipped with a warning naming its key and path, and listed in TENANT_STAGE_MISSING
# ("<path> (<key>)", space-separated) for the caller: a move backup fails on it, others report it
# in their ping. Never prints contents.
TENANT_STAGE_MISSING=''
stage_tenant_files() {
  local i=0 path
  local -a targets=() keys=(TENANT_CERT_DIR TENANT_PFX_PASSWORD_FILE)
  TENANT_STAGE_MISSING=''
  mapfile -t targets < <(tenant_file_targets "$3" "$2")
  [ "${#targets[@]}" -gt 0 ] || return 0
  install -d -o 0 -g 0 -m 0700 "$1/tenant"
  for path in "${targets[@]}"; do
    if [ -f "$path" ]; then
      install -o 0 -g 0 -m 0600 "$path" "$1/tenant/${TENANT_SNAPSHOT_FILES[$i]}"
      log "tenant: ${TENANT_SNAPSHOT_FILES[$i]} added"
    else
      warn "tenant: the profile is on but $path (${keys[$i]}) is missing: the snapshot is made without it"
      TENANT_STAGE_MISSING+="${TENANT_STAGE_MISSING:+ }$path (${keys[$i]})"
    fi
    i=$((i + 1))
  done
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
