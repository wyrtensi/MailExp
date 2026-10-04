# shellcheck shell=bash
# The version channel `latest`: the build the owner promoted as production-ready (the promote.yml
# workflow moves the git tag `latest` and tags the images of that commit `latest`). A server never
# runs the mutable tag: `latest` is turned into the commit's sha-<12> before anything else. Needs
# common.sh and app.sh (APP_DIR, CFG_IMAGE_PREFIX).

# fetch_latest_tag: brings the tag `latest` of origin into the checkout. A plain `git fetch` never
# moves a tag that is already there, hence the forced refspec.
fetch_latest_tag() {
  git -C "$APP_DIR" fetch --quiet --no-tags origin '+refs/tags/latest:refs/tags/latest'
}

# latest_commit: the full sha of the commit the local tag `latest` names, empty status 1 without one.
latest_commit() {
  git -C "$APP_DIR" rev-parse --verify --quiet 'refs/tags/latest^{commit}'
}

# manifest_digests: reads `docker manifest inspect -v` on stdin (an object for an image, an array
# for a multi-platform index) and prints its manifest digests, sorted and comma-separated.
manifest_digests() {
  jq -r 'if type == "array" then map(.Descriptor.digest) else [.Descriptor.digest] end
         | map(select(type == "string")) | sort | join(",")'
}

# image_digests <image reference>: manifest_digests of the reference in the registry; status 1 when
# the registry cannot be asked or has no such tag.
image_digests() {
  local out digests
  out=$(docker manifest inspect -v "$1" 2>/dev/null) || return 1
  digests=$(manifest_digests <<<"$out" 2>/dev/null) || return 1
  [ -n "$digests" ] || return 1
  printf '%s\n' "$digests"
}

# channel_images_state <sha-XXXXXXXXXXXX>: same, differ or unknown: whether the registry's `latest`
# images (all four that promote.yml tags) are the images of that commit. differ means a promotion
# half done or a tag moved by hand; unknown that the registry did not answer.
channel_images_state() {
  local image a b
  for image in mailexpert-backend mailexpert-frontend mailexpert-edge mailexpert-tenant-worker; do
    a=$(image_digests "$CFG_IMAGE_PREFIX/$image:latest") || { echo unknown; return 0; }
    b=$(image_digests "$CFG_IMAGE_PREFIX/$image:$1") || { echo unknown; return 0; }
    if [ "$a" != "$b" ]; then
      echo differ
      return 0
    fi
  done
  echo same
}

# resolve_latest: prints sha-<12> of the promoted commit. Fails (status 1, the reason on stderr)
# when the tag cannot be fetched or does not exist, or when the registry's `latest` images are
# not that commit's. A registry that does not answer is only a warning: the images are pulled by
# their sha-<12> tag anyway, and a missing one stops the update before anything changes.
resolve_latest() {
  local full version
  if ! fetch_latest_tag 2>/dev/null; then
    warn "cannot fetch the tag latest from $(redact_url "$CFG_REPO_URL") (has the owner promoted a build yet?)"
    return 1
  fi
  full=$(latest_commit) || {
    warn "the tag latest does not name a commit in $(redact_url "$CFG_REPO_URL")"
    return 1
  }
  version=sha-${full:0:12}
  case $(channel_images_state "$version") in
    differ)
      warn "the registry's latest images are not the images of $version (a promotion is half done?); name the version explicitly"
      return 1
      ;;
    unknown) warn "cannot compare the registry's latest images with $version; going on with $version" ;;
  esac
  printf '%s\n' "$version"
}
