#!/usr/bin/env bash
# The MailExpert version: one x.y.z shared by every shipped package (AGENTS.md, "Versions and
# releases"). A release is the next patch, x.y.0 ... x.y.99, then the next minor with patch 0;
# a bigger step is the owner's explicit choice (`set`).
#
#   release-version.sh next <x.y.z>   the version after <x.y.z> by that rule
#   release-version.sh current        the version all files agree on; fails listing them otherwise
#   release-version.sh set <x.y.z>    write <x.y.z> into every file
#   release-version.sh bump           set to `next current`: the chore(release) PR's change
#   release-version.sh files          the files that carry the version, one per line
#
# Environment: RELEASE_ROOT (the repository root; default: this script's checkout). jq is needed.
set -euo pipefail

# The files that carry the version, relative to the root. Lockfiles keep it twice: at the top and
# in packages[""].
JSON_FILES=(backend/package.json frontend/package.json frontend/packages/package.json)
LOCK_FILES=(backend/package-lock.json frontend/package-lock.json)
GRADLE_FILE=frontend/packages/android/app/build.gradle
PATCH_MAX=99

# version_files: the files that carry the version, relative to the root.
version_files() {
  printf '%s\n' "${JSON_FILES[@]}" "${LOCK_FILES[@]}" "$GRADLE_FILE"
}

die() {
  printf '[release-version] error: %s\n' "$1" >&2
  exit "${2:-1}"
}

# require_jq: jq reads and writes the package files.
require_jq() {
  command -v jq >/dev/null 2>&1 || die "jq not found: install jq to read and write the package versions"
}

release_root() {
  if [ -n "${RELEASE_ROOT:-}" ]; then
    printf '%s\n' "$RELEASE_ROOT"
  else
    (cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  fi
}

# is_version <v>: status 0 for x.y.z (decimal, no leading zeros, no prefix or suffix).
is_version() {
  [[ ${1:-} =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

# version_gt <a> <b>: status 0 when x.y.z <a> is greater than <b>.
version_gt() {
  local -a a b
  local i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((a[i] != b[i])); then
      ((a[i] > b[i]))
      return
    fi
  done
  return 1
}

# next_version <x.y.z>: the patch +1 up to x.y.99, after it x.(y+1).0.
next_version() {
  local -a v
  is_version "${1:-}" || die "not an x.y.z version: '${1:-}'" 2
  IFS=. read -r -a v <<<"$1"
  if ((v[2] >= PATCH_MAX)); then
    printf '%s.%s.0\n' "${v[0]}" "$((v[1] + 1))"
  else
    printf '%s.%s.%s\n' "${v[0]}" "${v[1]}" "$((v[2] + 1))"
  fi
}

# file_versions <root>: "<version or empty>|<file>" per place the version is kept.
file_versions() {
  local root=$1 f
  require_jq
  for f in "${JSON_FILES[@]}"; do
    printf '%s|%s\n' "$(jq -r '.version // ""' "$root/$f")" "$f"
  done
  for f in "${LOCK_FILES[@]}"; do
    printf '%s|%s\n' "$(jq -r '.version // ""' "$root/$f")" "$f"
    printf '%s|%s\n' "$(jq -r '.packages[""].version // ""' "$root/$f")" "$f (packages[\"\"])"
  done
  printf '%s|%s\n' "$(sed -n 's/^[[:space:]]*versionName "\([^"]*\)".*/\1/p' "$root/$GRADLE_FILE" | head -n 1)" "$GRADLE_FILE (versionName)"
}

# current_version: the version every file carries; status 1 listing each file when they differ.
current_version() {
  local root lines first="" agree=1 version file
  root=$(release_root)
  lines=$(file_versions "$root")
  first=${lines%%|*}
  while IFS='|' read -r version file; do
    [ "$version" = "$first" ] || agree=0
  done <<<"$lines"
  if [ "$agree" = 1 ] && is_version "$first"; then
    printf '%s\n' "$first"
    return 0
  fi
  printf '[release-version] error: the files do not carry one x.y.z version:\n' >&2
  while IFS='|' read -r version file; do
    printf '  %-10s %s\n' "${version:-(none)}" "$file" >&2
  done <<<"$lines"
  return 1
}

set_version() {
  local version=${1:-} root f tmp
  is_version "$version" || die "not an x.y.z version: '$version'" 2
  require_jq
  root=$(release_root)
  for f in "${JSON_FILES[@]}" "${LOCK_FILES[@]}"; do
    [ -f "$root/$f" ] || die "missing $root/$f"
  done
  [ -f "$root/$GRADLE_FILE" ] || die "missing $root/$GRADLE_FILE"
  grep -q '^[[:space:]]*versionName "' "$root/$GRADLE_FILE" || die "no versionName in $GRADLE_FILE"
  tmp=$(mktemp)
  # shellcheck disable=SC2064 # expand now: tmp is local to this function
  trap "rm -f '$tmp'" EXIT
  for f in "${JSON_FILES[@]}"; do
    jq --arg v "$version" '.version = $v' "$root/$f" >"$tmp"
    cat "$tmp" >"$root/$f"
  done
  for f in "${LOCK_FILES[@]}"; do
    jq --arg v "$version" '.version = $v | .packages[""].version = $v' "$root/$f" >"$tmp"
    cat "$tmp" >"$root/$f"
  done
  # Through the temporary file, not sed -i (GNU and BSD sed differ); cat keeps the file's mode.
  sed "s/^\([[:space:]]*versionName \)\"[^\"]*\"/\1\"$version\"/" "$root/$GRADLE_FILE" >"$tmp"
  cat "$tmp" >"$root/$GRADLE_FILE"
  current_version >/dev/null || die "the files disagree after writing $version"
  printf '%s\n' "$version"
}

main() {
  local cmd=${1:-} current
  case $cmd in current | set | bump) require_jq ;; esac
  case $cmd in
    next) next_version "${2:-}" ;;
    current) current_version ;;
    files) version_files ;;
    set) set_version "${2:-}" ;;
    bump)
      current=$(current_version) || die "fix the versions first: release-version.sh set <x.y.z>"
      set_version "$(next_version "$current")"
      ;;
    *) die "usage: release-version.sh next <x.y.z> | current | set <x.y.z> | bump | files" 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
