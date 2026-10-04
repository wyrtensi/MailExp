# shellcheck shell=bash
# Decisions of status.sh and update.sh about a version change: migrations, image tags, the parts
# of the system a version touches outside the panel. Pure: input on arguments and stdin.

# has_profile <COMPOSE_PROFILES value> <profile>: status 0 when the comma-separated list names it.
has_profile() {
  local list=",${1// /},"
  [[ $list == *",$2,"* ]]
}

# migration_versions: reads paths or file names of migrations (backend/migrations/0001_x.sql) and
# prints their versions (0001_x), sorted, one per line. Other files are skipped.
migration_versions() {
  sed -n 's|^\(.*/\)\{0,1\}\([^/]*\)\.sql$|\2|p' | LC_ALL=C sort -u
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

# update_notes <tenant profile on: 0|1>: reads the paths changed between two versions (git diff
# --name-only) on stdin and prints one line per part of the system that needs a step besides
# update.sh. Nothing when the change stays inside the panel's images.
update_notes() {
  local tenant=$1 paths
  paths=$(cat)
  if grep -q '^backend/migrations/' <<<"$paths"; then
    echo "migrations: the new version adds database migrations; they run when the backend starts, and going back means restoring the pre-update dump (runbook: \"Откат обновления\")"
  fi
  if grep -q '^scripts/deploy/mail-node/' <<<"$paths"; then
    echo "mail node: its host scripts changed; on the node, check out the same commit and run scripts/deploy/mail-node/setup.sh --dry-run, then without --dry-run (docs/operations/mail-node.md, section 4)"
  fi
  if grep -q '^deploy/tenant-worker/' <<<"$paths"; then
    if [ "$tenant" = 1 ]; then
      echo "tenant worker: its image changed; update.sh pulls and restarts it together with the panel (same tag)"
    else
      echo "tenant worker: its image changed; this install runs no tenant worker (COMPOSE_PROFILES has no tenant), nothing to do"
    fi
  fi
  if grep -q '^deploy/edge/Dockerfile$' <<<"$paths"; then
    echo "edge: the Caddy image changed; update.sh keeps the pinned EDGE_IMAGE: to take the new one, empty EDGE_IMAGE in <prefix>/edge/.env and run install.sh (runbook: docs/operations/README.md, \"Обновление\")"
  fi
  if grep -q '^deploy/edge/\(compose.yml\|Caddyfile.tmpl\)$' <<<"$paths"; then
    echo "edge: its compose file or Caddyfile template changed; install.sh (run by update.sh) writes them and restarts Caddy when the Caddyfile differs"
  fi
  if grep -q '^deploy/systemd/' <<<"$paths"; then
    echo "timers: the systemd units changed; install.sh (run by update.sh) installs them"
  fi
  return 0
}

# lines_json: the lines on stdin as a JSON array of strings ([] for none).
lines_json() {
  jq -R . | jq -cs .
}
