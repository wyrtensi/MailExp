#!/usr/bin/env bats
# scripts/ci/promote-latest.sh (promote.yml): which commit is promoted, that its images must
# exist, the retag keeping the digest, the git tags moved after the images, and the release of the
# commit's version. crane and gh are stubs.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  SCRIPT=$REPO_DIR/scripts/ci/promote-latest.sh
  # shellcheck source=/dev/null
  source "$SCRIPT"
}

@test "input_ref: empty is the head of main, sha-<12> and hex are commits, the rest refused" {
  [ "$(input_ref '')" = refs/remotes/origin/main ]
  [ "$(input_ref ' sha-0123456789AB ')" = 0123456789ab ]
  [ "$(input_ref 0123456)" = 0123456 ]
  ! input_ref 'main'
  ! input_ref 'sha-0123'
  ! input_ref '0123456789ab; echo'
}

commit() {
  git -C "$1" add -A >/dev/null
  git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m "$2"
  git -C "$1" rev-parse HEAD
}

# versions <dir> <version>: the version files release-version.sh reads, all carrying <version>.
versions() {
  local f
  mkdir -p "$1/backend" "$1/frontend/packages/android/app"
  for f in backend/package.json frontend/package.json frontend/packages/package.json; do
    printf '{\n  "name": "x",\n  "version": "%s"\n}\n' "$2" >"$1/$f"
  done
  for f in backend/package-lock.json frontend/package-lock.json; do
    printf '{\n  "version": "%s",\n  "packages": {\n    "": {\n      "version": "%s"\n    }\n  }\n}\n' "$2" "$2" >"$1/$f"
  done
  gradle "$1" "$2"
}

gradle() {
  printf 'android {\n    defaultConfig {\n        versionName "%s"\n    }\n}\n' "$2" >"$1/frontend/packages/android/app/build.gradle"
}

# release_tag <commit> <tag>: an annotated release tag on the remote, as an earlier promotion left it.
release_tag() {
  git -C "$W" tag -a "$2" -m "MailExpert ${2#v}" "$1"
  git -C "$W" push -q origin "refs/tags/$2"
}

setup_repo() {
  R=$BATS_TEST_TMPDIR/remote.git
  W=$BATS_TEST_TMPDIR/work
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  git init -q --bare -b main "$R"
  git init -q -b main "$W"
  printf '1\n' >"$W/a"
  versions "$W" 1.0.0
  ONE=$(commit "$W" one)
  printf '2\n' >"$W/a"
  versions "$W" 1.0.1
  TWO=$(commit "$W" two)
  git -C "$W" remote add origin "$R"
  git -C "$W" push -q origin main
  git -C "$W" checkout -q -b side "$ONE"
  printf 's\n' >"$W/s"
  SIDE=$(commit "$W" side)
  git -C "$W" checkout -q main
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  # A tag other than sha-<12> names the manifest only once `crane tag` has set it.
  cat >"$STUB/crane" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CRANE_LOG"
case $1 in
  digest)
    case $2 in
      *"${STUB_MISSING:-none}"*) echo "MANIFEST_UNKNOWN" >&2; exit 1 ;;
      *:sha-*) echo sha256:abc ;;
      *) grep -qxF "${2##*:}" "$CRANE_TAGGED" 2>/dev/null && echo sha256:abc || echo sha256:other ;;
    esac ;;
  tag) printf '%s\n' "$3" >>"$CRANE_TAGGED" ;;
esac
STUB_EOF
  cat >"$STUB/gh" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "$1 $2" in
  # GH_RELEASES: the tags that have a GitHub release; GH_VIEW_FAIL: GitHub does not answer.
  "release view")
    if [ -n "${GH_VIEW_FAIL:-}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    case " ${GH_RELEASES:-} " in
      *" $3 "*) echo '{"tagName":"'"$3"'"}' ;;
      *) echo "release not found" >&2; exit 1 ;;
    esac ;;
  "release create")
    if [ -n "${GH_FAIL:-}" ]; then echo "HTTP 403" >&2; exit 1; fi ;;
esac
STUB_EOF
  chmod +x "$STUB/crane" "$STUB/gh"
  export CRANE=$STUB/crane GH=$STUB/gh CRANE_LOG=$BATS_TEST_TMPDIR/crane.log CRANE_TAGGED=$BATS_TEST_TMPDIR/tagged \
    GH_LOG=$BATS_TEST_TMPDIR/gh.log IMAGE_PREFIX=ghcr.io/o
}

@test "the first release: the head of main, images tagged, the git tags, then the GitHub release" {
  setup_repo
  cd "$W"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(git -C "$R" rev-parse refs/tags/latest)" = "$TWO" ]
  [ "$(git -C "$R" rev-parse 'refs/tags/v1.0.1^{commit}')" = "$TWO" ]
  [ "$(git -C "$R" cat-file -t refs/tags/v1.0.1)" = tag ]
  [ "$(grep -c '^tag .* latest$' "$CRANE_LOG")" -eq 4 ]
  [ "$(grep -c '^tag .* 1\.0\.1$' "$CRANE_LOG")" -eq 4 ]
  grep -q "^tag ghcr.io/o/mailexpert-tenant-worker:sha-${TWO:0:12} latest$" "$CRANE_LOG"
  grep -q "^tag ghcr.io/o/mailexpert-backend:sha-${TWO:0:12} 1.0.1$" "$CRANE_LOG"
  grep -q '^digest ghcr.io/o/mailexpert-edge:1.0.1$' "$CRANE_LOG"
  [ "$(cat "$GH_LOG")" = "release create v1.0.1 --verify-tag --title v1.0.1 --latest --generate-notes" ]
}

@test "a release after an earlier one: notes start at the previous release tag" {
  setup_repo
  release_tag "$ONE" v1.0.0
  cd "$W"
  run bash "$SCRIPT" "$TWO"
  [ "$status" -eq 0 ]
  [ "$(git -C "$R" rev-parse 'refs/tags/v1.0.1^{commit}')" = "$TWO" ]
  [ "$(cat "$GH_LOG")" = "release create v1.0.1 --verify-tag --title v1.0.1 --latest --generate-notes --notes-start-tag v1.0.0" ]
}

@test "a commit already released (re-promotion, rollback): only latest moves" {
  setup_repo
  release_tag "$ONE" v1.0.0
  release_tag "$TWO" v1.0.1
  cd "$W"
  GH_RELEASES="v1.0.0 v1.0.1" run bash "$SCRIPT" "$ONE"
  [ "$status" -eq 0 ]
  [[ $output == *"v1.0.0 is already the release of this commit"* ]]
  [ "$(git -C "$R" rev-parse refs/tags/latest)" = "$ONE" ]
  [ "$(grep -c '^tag .* latest$' "$CRANE_LOG")" -eq 4 ]
  [ "$(grep -c '^tag .* 1\.0\.0$' "$CRANE_LOG")" -eq 0 ]
  [ "$(cat "$GH_LOG")" = "release view v1.0.0 --json tagName" ]
}

@test "the tag on this commit without its GitHub release: latest moves and the release is created" {
  setup_repo
  release_tag "$ONE" v1.0.0
  release_tag "$TWO" v1.0.1
  cd "$W"
  # The newest release tag: marked latest, notes since the release before it.
  GH_RELEASES=v1.0.0 run bash "$SCRIPT" "$TWO"
  [ "$status" -eq 0 ]
  [[ $output == *"its GitHub release is missing"* ]]
  [ "$(git -C "$R" rev-parse refs/tags/latest)" = "$TWO" ]
  [ "$(grep -c '^tag .* 1\.0\.1$' "$CRANE_LOG")" -eq 0 ]
  [ "$(sed -n 2p "$GH_LOG")" = "release create v1.0.1 --verify-tag --title v1.0.1 --latest --generate-notes --notes-start-tag v1.0.0" ]
  # An older one (a rollback): created, but not marked latest; nothing before it.
  : >"$GH_LOG"
  GH_RELEASES=v1.0.1 run bash "$SCRIPT" "$ONE"
  [ "$status" -eq 0 ]
  [ "$(git -C "$R" rev-parse refs/tags/latest)" = "$ONE" ]
  [ "$(sed -n 2p "$GH_LOG")" = "release create v1.0.0 --verify-tag --title v1.0.0 --latest=false --generate-notes" ]
}

@test "GitHub not answering whether the release exists stops before anything moves" {
  setup_repo
  release_tag "$TWO" v1.0.1
  cd "$W"
  GH_VIEW_FAIL=1 run bash "$SCRIPT" "$TWO"
  [ "$status" -eq 1 ]
  [[ $output == *"cannot ask GitHub whether the release v1.0.1 exists: HTTP 502"* ]]
  [ ! -e "$CRANE_TAGGED" ]
  run git -C "$R" rev-parse --verify --quiet refs/tags/latest
  [ "$status" -ne 0 ]
  ! grep -q '^release create' "$GH_LOG"
}

@test "a rerun after a failed GitHub release creates it" {
  setup_repo
  cd "$W"
  GH_FAIL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  : >"$GH_LOG"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$GH_LOG")" = "release view v1.0.1 --json tagName
release create v1.0.1 --verify-tag --title v1.0.1 --latest --generate-notes" ]
}

@test "a version tagged on another commit is refused and nothing moves" {
  setup_repo
  release_tag "$TWO" v1.0.0
  cd "$W"
  run bash "$SCRIPT" "$ONE"
  [ "$status" -eq 2 ]
  [[ $output == *"v1.0.0 is already the release of ${TWO:0:12}"*"chore(release) PR"* ]]
  [ ! -e "$CRANE_TAGGED" ]
  [ ! -e "$GH_LOG" ]
  run git -C "$R" rev-parse --verify --quiet refs/tags/latest
  [ "$status" -ne 0 ]
}

@test "a version not above the newest release is refused and nothing moves" {
  setup_repo
  release_tag "$ONE" v1.0.5
  cd "$W"
  run bash "$SCRIPT" "$TWO"
  [ "$status" -eq 2 ]
  [[ $output == *"1.0.1 is not above the newest release v1.0.5"* ]]
  [ ! -e "$CRANE_TAGGED" ]
  [ ! -e "$GH_LOG" ]
  run git -C "$R" rev-parse --verify --quiet refs/tags/latest
  [ "$status" -ne 0 ]
  run git -C "$R" rev-parse --verify --quiet refs/tags/v1.0.1
  [ "$status" -ne 0 ]
}

@test "packages that disagree on the version are refused" {
  setup_repo
  gradle "$W" 0.9.0
  THREE=$(commit "$W" three)
  git -C "$W" push -q origin main
  cd "$W"
  run bash "$SCRIPT" "$THREE"
  [ "$status" -eq 2 ]
  [[ $output == *"0.9.0"*"build.gradle (versionName)"* ]]
  [[ $output == *"do not carry one x.y.z version"* ]]
  [ ! -e "$CRANE_TAGGED" ]
}

@test "a failed GitHub release fails loudly after the tags, saying what to run" {
  setup_repo
  cd "$W"
  GH_FAIL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ $output == *"the GitHub release was not created; promote this commit again, or create it by hand: gh release create v1.0.1 --verify-tag"* ]]
  [ "$(git -C "$R" rev-parse 'refs/tags/v1.0.1^{commit}')" = "$TWO" ]
  [ "$(git -C "$R" rev-parse refs/tags/latest)" = "$TWO" ]
}

@test "a commit off main, or one without images, is refused and nothing moves" {
  setup_repo
  cd "$W"
  run bash "$SCRIPT" "$SIDE"
  [ "$status" -eq 2 ]
  [[ $output == *"is not on main"* ]]
  STUB_MISSING=mailexpert-edge run bash "$SCRIPT" "sha-${ONE:0:12}"
  [ "$status" -eq 1 ]
  [[ $output == *"mailexpert-edge:sha-${ONE:0:12} does not exist"* ]]
  ! grep -q '^tag ' "$CRANE_LOG"
  ! git -C "$R" rev-parse --verify --quiet refs/tags/latest
}

@test "DRY_RUN only checks, and says which release it would make" {
  setup_repo
  release_tag "$ONE" v1.0.0
  cd "$W"
  DRY_RUN=1 run bash "$SCRIPT" "$TWO"
  [ "$status" -eq 0 ]
  [[ $output == *"release v1.0.1: images tagged 1.0.1, annotated tag v1.0.1, GitHub release v1.0.1 (notes since v1.0.0)"* ]]
  [[ $output == *"dry run: nothing changed"* ]]
  [ ! -e "$CRANE_TAGGED" ]
  [ ! -e "$GH_LOG" ]
  run git -C "$R" rev-parse --verify --quiet refs/tags/latest
  [ "$status" -ne 0 ]
  run git -C "$R" rev-parse --verify --quiet refs/tags/v1.0.1
  [ "$status" -ne 0 ]
}

@test "DRY_RUN refuses what the promotion would refuse" {
  setup_repo
  release_tag "$ONE" v1.0.5
  cd "$W"
  DRY_RUN=1 run bash "$SCRIPT" "$TWO"
  [ "$status" -eq 2 ]
  [[ $output == *"not above the newest release v1.0.5"* ]]
}
