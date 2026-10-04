# shellcheck shell=bash
# Decisions of status.sh and update.sh about a version change: migrations, image tags, the parts
# of the system a version touches outside the panel. Pure: input on arguments and stdin.

# has_profile <COMPOSE_PROFILES value> <profile>: status 0 when the comma-separated list names it.
has_profile() {
  local list=",${1// /},"
  [[ $list == *",$2,"* ]]
}

# migration_versions: reads paths or file names of migrations (backend/migrations/0001_x.sql) and
# prints their versions (0001_x), sorted, one per line. Only the names the backend's runner takes
# (backend/src/services/migrations.js: /^\d{4}_.+\.sql$/); other files are skipped.
migration_versions() {
  sed -n 's|^\(.*/\)\{0,1\}\([0-9]\{4\}_[^/]\{1,\}\)\.sql$|\2|p' | LC_ALL=C sort -u
}

# pending_migrations <applied versions file> <target versions file>: the versions the target has
# and the database does not (they run when the target starts). Both files sorted.
pending_migrations() {
  LC_ALL=C comm -13 "$1" "$2"
}

# unknown_migrations <applied versions file> <target versions file>: versions the database has
# and the target does not: the target is older than the schema. Starting it on this database is
# the unsupported "old code on a new schema"; the way back is the pre-update dump.
unknown_migrations() {
  LC_ALL=C comm -23 "$1" "$2"
}

# image_tag <image reference>: the tag of <repo>[:tag][@digest], empty without one.
image_tag() {
  local ref=${1%%@*} last
  last=${ref##*/}
  if [[ $last == *:* ]]; then printf '%s\n' "${last##*:}"; fi
  return 0
}

# image_problems <expected tag> <service...>: reads "<service> <image>" lines (docker compose ps
# --format '{{.Service}} {{.Image}}') on stdin and prints a problem for each listed service that
# runs another tag. A service that is not there is service_problems' business, not this one's.
image_problems() {
  local expected=$1 lines service image tag
  shift
  lines=$(cat)
  for service in "$@"; do
    image=$(awk -v s="$service" '$1 == s {print $2; exit}' <<<"$lines")
    [ -n "$image" ] || continue
    tag=$(image_tag "$image")
    if [ "$tag" != "$expected" ]; then
      echo "version: $service runs ${tag:-an untagged image}, the panel is at $expected"
    fi
  done
  return 0
}

# manifest_state <docker manifest inspect exit code> <its stderr>: ok, missing (the registry
# answered that there is no such tag) or unknown (anything else: the registry unreachable, access
# denied, a rate limit). Only "missing" means the commit has no image.
manifest_state() {
  if [ "$1" = 0 ]; then
    echo ok
  elif grep -qiE 'no such manifest|manifest unknown|not found' <<<"$2"; then
    echo missing
  else
    echo unknown
  fi
}

# compose_image <service> : reads a compose file on stdin and prints the image of <service>
# (the first `image:` line inside its block), empty when it has none.
compose_image() {
  awk -v s="$1" '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { inside = ($1 == s ":") }
    inside && /^    image:/ { sub(/^    image:[[:space:]]*/, ""); print; exit }'
}

# major_of <image reference>: the leading number of its tag (postgres:16-alpine -> 16).
major_of() {
  local tag
  tag=$(image_tag "$1")
  printf '%s\n' "${tag%%[!0-9]*}"
}

# data_image_changes <old docker-compose.yml> <new docker-compose.yml>: one line per data service
# whose image changes between the two files: "<problem|info> <service> <old> -> <new>". A new
# PostgreSQL major version cannot start on the old data directory (it needs a dump and a restore,
# which update.sh does not do): problem. Any other change (a Redis tag, a PostgreSQL minor tag):
# info.
data_image_changes() {
  local service old new kind
  for service in postgres redis; do
    old=$(compose_image "$service" <"$1")
    new=$(compose_image "$service" <"$2")
    [ "$old" != "$new" ] || continue
    kind=info
    if [ "$service" = postgres ] && [ "$(major_of "$old")" != "$(major_of "$new")" ]; then kind=problem; fi
    printf '%s %s %s -> %s\n' "$kind" "$service" "${old:-none}" "${new:-none}"
  done
  return 0
}

# update_notes <tenant profile on: 0|1> <edge services, comma-separated>: reads the paths changed
# between two versions (git diff --name-only) on stdin and prints one line per part of the system
# the change touches outside the panel's images: "next <text>" for a step a person has to take,
# "info <text>" for what update.sh does by itself or what only matters for a rollback. Nothing for a
# change inside the panel's images.
update_notes() {
  local tenant=$1 edge=",${2:-},"
  local paths
  paths=$(cat)
  if grep -q '^backend/migrations/' <<<"$paths"; then
    echo "info migrations: the new version adds database migrations; they run when the backend starts, and going back means restoring the pre-update dump (runbook: \"Откат обновления\")"
  fi
  if grep -q '^scripts/deploy/mail-node/' <<<"$paths"; then
    echo "next mail node: its host scripts changed; on the node, check out the same commit and run scripts/deploy/mail-node/setup.sh --dry-run, then without --dry-run (docs/operations/mail-node.md, section 4)"
  fi
  if grep -q '^deploy/tenant-worker/' <<<"$paths" && [ "$tenant" = 1 ]; then
    echo "info tenant worker: its image changed; update.sh pulls and restarts it together with the panel (same tag)"
  fi
  if [[ $edge == *,caddy,* ]]; then
    if grep -q '^deploy/edge/Dockerfile$' <<<"$paths"; then
      echo "next edge: the Caddy image changed; update.sh keeps the pinned EDGE_IMAGE: to take the new one, empty EDGE_IMAGE in <prefix>/edge/.env and run install.sh (docs/operations/README.md, section 9)"
    fi
    if grep -q '^deploy/edge/Caddyfile.tmpl$' <<<"$paths"; then
      echo "info edge: the Caddyfile template changed; install.sh (run by update.sh) writes it and restarts Caddy"
    fi
  fi
  if [ "$edge" != ",," ] && grep -q '^deploy/edge/compose.yml$' <<<"$paths"; then
    echo "info edge: its compose file changed; install.sh (run by update.sh) copies it and recreates what changed"
  fi
  if grep -q '^deploy/systemd/' <<<"$paths"; then
    echo "info timers: the systemd units changed; install.sh (run by update.sh) installs them"
  fi
  return 0
}

# lines_json: the lines on stdin as a JSON array of strings ([] for none).
lines_json() {
  jq -R . | jq -cs .
}
