#!/usr/bin/env bash
# Deploy e2e test in a throwaway Docker-in-Docker container. The installer's docker commands
# reach only the daemon inside that container, so containers, volumes and ports of the host are
# out of its reach. On the host it creates one container, me-e2e-<id>, removed at exit
# (E2E_KEEP=1 keeps it for inspection).
#
#   scripts/deploy/test/e2e.sh --version sha-<12> --image-prefix local.invalid
#
# --only install|backup runs one scenario (default: both).
# The images <prefix>/mailexpert-{backend,frontend,edge}:<version> must be built from HEAD, and
# the tracked files must match HEAD: the test installs HEAD from a git bundle.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

DIND_IMAGE=docker:29.8.1-dind
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$TEST_DIR/../lib/common.sh"
# shellcheck source=../lib/backup.sh
. "$TEST_DIR/../lib/backup.sh"

# Stands in for the S3 provider inside the test (`rclone serve s3`); pinned like every other image.
# MinIO, used before, is no longer published without a login.
S3_IMAGE=rclone/rclone:1.71.1

VERSION='' IMAGE_PREFIX='' ONLY=''
while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=$2 && shift 2 ;;
    --image-prefix) IMAGE_PREFIX=$2 && shift 2 ;;
    --only) ONLY=$2 && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
[[ $VERSION =~ ^sha-[0-9a-f]{12}$ ]] || die "--version sha-<12 hex characters> is required" 2
[ -n "$IMAGE_PREFIX" ] || die "--image-prefix is required" 2
case $ONLY in '' | install | backup) ;; *) die "--only must be install or backup" 2 ;; esac
head=$(git -C "$TEST_DIR" rev-parse HEAD)
[ "${head:0:12}" = "${VERSION#sha-}" ] || die "--version $VERSION is not HEAD ($head)" 2
[ -z "$(git -C "$TEST_DIR" status --porcelain --untracked-files=no)" ] ||
  die "tracked files differ from HEAD: the test installs HEAD, commit first" 2

NAME=me-e2e-${E2E_ID:-$(gen_hex 4)}
if docker container inspect "$NAME" >/dev/null 2>&1; then die "container $NAME already exists"; fi

cleanup() {
  local status=$?
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    log "kept $NAME; remove it with: docker rm -fv $NAME"
  elif docker container inspect "$NAME" >/dev/null 2>&1; then
    docker rm -fv "$NAME" >/dev/null || warn "could not remove $NAME"
  fi
  exit "$status"
}
trap cleanup EXIT

# A Docker Hub image through Google's pull-through cache first, tagged under its own name (Docker
# Hub's unauthenticated pull limit and token timeouts fail CI runs), then Docker Hub itself.
pull_hub() {
  local image=$1 path=$1
  [[ $path == */* ]] || path="library/$path"
  if docker pull --quiet "mirror.gcr.io/$path" >/dev/null 2>&1; then
    docker tag "mirror.gcr.io/$path" "$image"
  else
    docker pull --quiet "$image" >/dev/null
  fi
}

IMAGES=("$IMAGE_PREFIX/mailexpert-backend:$VERSION" "$IMAGE_PREFIX/mailexpert-frontend:$VERSION"
  "$IMAGE_PREFIX/mailexpert-edge:$VERSION" postgres:16-alpine redis:7-alpine "$RESTIC_IMAGE" "$S3_IMAGE")
for image in "${IMAGES[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then continue; fi
  case $image in
    "$IMAGE_PREFIX"/*) die "image $image is missing: build it from HEAD first" ;;
    *) pull_hub "$image" ;;
  esac
done
docker image inspect "$DIND_IMAGE" >/dev/null 2>&1 || pull_hub "$DIND_IMAGE"

log "starting $NAME from $DIND_IMAGE"
docker run -d --privileged --name "$NAME" "$DIND_IMAGE" >/dev/null
for _ in $(seq 60); do
  if docker exec "$NAME" docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" docker info >/dev/null 2>&1 || die "the inner docker daemon did not start"
docker exec "$NAME" apk add --no-cache --quiet bash curl jq iproute2 >/dev/null
log "loading images into $NAME"
docker save "${IMAGES[@]}" | docker exec -i "$NAME" docker load --quiet >/dev/null
# MSYS_NO_PATHCONV=1 on these docker exec calls only: Git Bash on Windows rewrites a bare
# absolute-looking argument such as /e2e into a host path before it reaches docker.exe, which
# would corrupt a path meant for the container. Scoped to each call so it never reaches git,
# whose own /-style arguments (above and below) need MSYS's translation to resolve on Windows.
MSYS_NO_PATHCONV=1 docker exec "$NAME" mkdir -p /e2e
git -C "$TEST_DIR" bundle create - HEAD 2>/dev/null | docker exec -i "$NAME" sh -c 'cat >/e2e/repo.bundle'
MSYS_NO_PATHCONV=1 docker exec "$NAME" git clone --quiet /e2e/repo.bundle /e2e/src
if [ "$ONLY" != backup ]; then
  MSYS_NO_PATHCONV=1 docker exec "$NAME" bash /e2e/src/scripts/deploy/test/e2e-install.sh \
    --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url /e2e/repo.bundle
fi
if [ "$ONLY" != install ]; then
  MSYS_NO_PATHCONV=1 docker exec "$NAME" bash /e2e/src/scripts/deploy/test/e2e-backup.sh \
    --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url /e2e/repo.bundle --s3-image "$S3_IMAGE"
fi
log "deploy e2e passed"
