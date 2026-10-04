#!/usr/bin/env bash
# Promotes a build to the production channel `latest` (.github/workflows/promote.yml, run by the
# owner by hand). It never builds anything:
#   1. the commit: the input (a full or short sha, or sha-<12>), or the head of origin/main when
#      empty; it must be on origin/main;
#   2. its images must exist: CI's images job publishes ghcr.io/<owner>/mailexpert-<name>:sha-<12>
#      only after every other job passed;
#   3. each image gets the tag `latest` on the same manifest (crane tag: the same bytes, the same
#      digest), checked afterwards;
#   4. the git tag `latest` moves to the commit. Panels and the deploy scripts read that tag, and a
#      host refuses `latest` while the registry's latest images are not that commit's, so the
#      images are tagged first.
#
#   promote-latest.sh [<sha>|sha-<12>]
#
# Environment: IMAGE_PREFIX (ghcr.io/<owner>), CRANE (crane), PUSH_REMOTE (origin), DRY_RUN=1 to
# stop before changing anything.
set -euo pipefail

IMAGES=(mailexpert-backend mailexpert-frontend mailexpert-edge mailexpert-tenant-worker)

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

main() {
  local input=${1:-} ref full tag image digest after crane=${CRANE:-crane} prefix=${IMAGE_PREFIX:-} remote=${PUSH_REMOTE:-origin}
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
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "dry run: nothing changed"
    return 0
  fi
  for image in "${IMAGES[@]}"; do
    "$crane" tag "$prefix/$image:$tag" latest
    after=$("$crane" digest "$prefix/$image:latest")
    [ "$after" = "${digests[$image]}" ] || die "$image:latest is $after after tagging, not ${digests[$image]}"
  done
  git tag -f latest "$full" >/dev/null
  git push --quiet --force "$remote" refs/tags/latest
  log "latest is $tag"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    # shellcheck disable=SC2016 # Markdown backticks, not command substitution
    {
      printf '### latest is `%s`\n\n' "$tag"
      printf 'Commit %s. Images:\n\n' "$full"
      for image in "${IMAGES[@]}"; do printf -- '- `%s/%s:latest` = `%s`\n' "$prefix" "$image" "${digests[$image]}"; done
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
