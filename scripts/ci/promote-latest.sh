#!/usr/bin/env bash
# Promotes a build to the production channel `latest` and releases its version
# (.github/workflows/promote.yml, run by the owner by hand). It never builds anything:
#   1. the commit: the input (a full or short sha, or sha-<12>), or the head of origin/main when
#      empty; it must be on origin/main;
#   2. its images must exist: CI's images job publishes ghcr.io/<owner>/mailexpert-<name>:sha-<12>
#      only after every other job passed;
#   3. its version: the x.y.z every package carries at that commit (release-version.sh). A version
#      already tagged v<x.y.z> on this commit is released (a re-promotion or a rollback: only
#      `latest` moves); a tag v<x.y.z> on another commit, or a version not above the newest v*
#      tag, is refused: the version is bumped in a chore(release) PR first;
#   4. each image gets the tag <x.y.z> (a new release) and `latest` on the same manifest (crane tag:
#      the same bytes, the same digest), checked afterwards;
#   5. the git tag `latest` moves to the commit and the annotated tag v<x.y.z> is created, both
#      pushed at once. Panels and the deploy scripts read `latest`, and a host refuses it while the
#      registry's latest images are not that commit's, so the images are tagged first;
#   6. the GitHub release v<x.y.z>, notes generated since the previous release tag, marked latest.
#
#   promote-latest.sh [<sha>|sha-<12>]
#
# Environment: IMAGE_PREFIX (ghcr.io/<owner>), CRANE (crane), GH (gh, with GH_TOKEN and GH_REPO),
# PUSH_REMOTE (origin), DRY_RUN=1 to stop before changing anything.
set -euo pipefail

IMAGES=(mailexpert-backend mailexpert-frontend mailexpert-edge mailexpert-tenant-worker)
BUMP_HINT="bump the version in a chore(release) PR first (scripts/ci/release-version.sh bump)"

# shellcheck source=release-version.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-version.sh"

log() { printf '[promote] %s\n' "$*" >&2; }
die() {
  printf '[promote] error: %s\n' "$1" >&2
  exit "${2:-1}"
}

# input_ref <input>: the git revision the input names: origin/main for an empty input, the hex of
# sha-<12>, a 7..40 hex sha as it is. Status 1 for anything else.
input_ref() {
  local input=${1,,}
  input=${input//[[:space:]]/}
  if [ -z "$input" ]; then
    echo refs/remotes/origin/main
  elif [[ $input =~ ^sha-([0-9a-f]{12})$ ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ $input =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "$input"
  else
    return 1
  fi
}

# commit_version <commit>: the version every package carries at <commit>; status 1 (the files
# listed on stderr) when they disagree or a file is missing.
commit_version() {
  local tree status=0
  tree=$(mktemp -d)
  local -a files
  mapfile -t files < <(version_files)
  if git archive "$1" -- "${files[@]}" | tar -x -C "$tree"; then
    RELEASE_ROOT=$tree current_version || status=1
  else
    status=1
  fi
  rm -rf "$tree"
  return "$status"
}

# newest_release_tag: the highest v<x.y.z> tag, empty when there is none.
newest_release_tag() {
  local tag newest=""
  while read -r tag; do
    is_version "${tag#v}" || continue
    if [ -z "$newest" ] || version_gt "${tag#v}" "${newest#v}"; then newest=$tag; fi
  done < <(git tag -l 'v*')
  printf '%s\n' "$newest"
}

# retag <image ref> <tag> <digest>: crane tag, then the new tag must name the same digest.
retag() {
  local after
  "$crane" tag "$1" "$2"
  after=$("$crane" digest "${1%:*}:$2")
  [ "$after" = "$3" ] || die "${1%:*}:$2 is $after after tagging, not $3"
}

main() {
  local input=${1:-} ref full tag image digest version vtag previous release existing
  local crane=${CRANE:-crane} gh=${GH:-gh} prefix=${IMAGE_PREFIX:-} remote=${PUSH_REMOTE:-origin}
  local -A digests=()
  [ -n "$prefix" ] || die "IMAGE_PREFIX is not set (ghcr.io/<owner>)" 2
  ref=$(input_ref "$input") || die "the input must be a commit sha, sha-<12> or empty (the head of main), got '$input'" 2
  git fetch --quiet --tags --force "$remote" '+refs/heads/main:refs/remotes/origin/main'
  full=$(git rev-parse --verify --quiet "$ref^{commit}") || die "no commit $ref in this repository" 2
  git merge-base --is-ancestor "$full" refs/remotes/origin/main || die "$full is not on main: only builds of main are promoted" 2
  tag=sha-${full:0:12}
  log "promoting $tag ($full)"
  for image in "${IMAGES[@]}"; do
    digest=$("$crane" digest "$prefix/$image:$tag" 2>/dev/null) ||
      die "$prefix/$image:$tag does not exist: CI's images job has not published this commit (did CI pass on main?)"
    digests[$image]=$digest
    log "$image:$tag is $digest"
  done
  version=$(commit_version "$full") ||
    die "the packages at ${full:0:12} do not carry one x.y.z version: $BUMP_HINT" 2
  vtag=v$version
  previous=$(newest_release_tag)
  release=new
  if existing=$(git rev-parse --verify --quiet "refs/tags/$vtag^{commit}"); then
    [ "$existing" = "$full" ] || die "$vtag is already the release of ${existing:0:12}, not of this commit: $BUMP_HINT" 2
    release=released
  elif [ -n "$previous" ] && ! version_gt "$version" "${previous#v}"; then
    die "$version is not above the newest release $previous: $BUMP_HINT" 2
  fi
  if [ "$release" = released ]; then
    log "$vtag is already the release of this commit: only latest moves"
  else
    log "release $vtag: images tagged $version, annotated tag $vtag, GitHub release $vtag (notes since ${previous:-the first commit})"
  fi
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "dry run: nothing changed"
    return 0
  fi
  if [ "$release" = new ]; then
    for image in "${IMAGES[@]}"; do retag "$prefix/$image:$tag" "$version" "${digests[$image]}"; done
  fi
  for image in "${IMAGES[@]}"; do retag "$prefix/$image:$tag" latest "${digests[$image]}"; done
  git tag -f latest "$full" >/dev/null
  if [ "$release" = new ]; then
    git tag -a "$vtag" -m "MailExpert $version" "$full"
    git push --quiet --atomic "$remote" +refs/tags/latest "refs/tags/$vtag"
  else
    git push --quiet --force "$remote" refs/tags/latest
  fi
  log "latest is $tag"
  if [ "$release" = new ]; then
    local -a notes=(--generate-notes)
    [ -z "$previous" ] || notes+=(--notes-start-tag "$previous")
    "$gh" release create "$vtag" --verify-tag --title "$vtag" --latest "${notes[@]}" >&2 ||
      die "$vtag and latest are pushed and the images tagged, but the GitHub release was not created; create it by hand: gh release create $vtag --verify-tag --title $vtag --latest ${notes[*]}"
    log "released $vtag"
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    # shellcheck disable=SC2016 # Markdown backticks, not command substitution
    {
      printf '### latest is `%s`, version `%s`\n\n' "$tag" "$version"
      if [ "$release" = new ]; then
        printf 'Released `%s`: the git tag, the image tags `%s` and the GitHub release.\n\n' "$vtag" "$version"
      else
        printf '`%s` was already the release of this commit.\n\n' "$vtag"
      fi
      printf 'Commit %s. Images:\n\n' "$full"
      for image in "${IMAGES[@]}"; do printf -- '- `%s/%s:latest` = `%s`\n' "$prefix" "$image" "${digests[$image]}"; done
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
