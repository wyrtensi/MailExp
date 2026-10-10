#!/usr/bin/env bats
# scripts/ci/release-version.sh: the next version by the release rule, one version across every
# shipped package, and writing it. `set` and `bump` run on a copy of the version files.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  SCRIPT=$REPO_DIR/scripts/ci/release-version.sh
}

# copy_tree: the version files of this repository under $BATS_TEST_TMPDIR/tree, as RELEASE_ROOT.
copy_tree() {
  local f
  T=$BATS_TEST_TMPDIR/tree
  for f in backend/package.json backend/package-lock.json frontend/package.json \
    frontend/package-lock.json frontend/packages/package.json frontend/packages/android/app/build.gradle; do
    mkdir -p "$T/$(dirname "$f")"
    cp "$REPO_DIR/$f" "$T/$f"
  done
  export RELEASE_ROOT=$T
}

@test "next: the patch grows to .99, then the minor grows and the patch starts at 0" {
  [ "$(bash "$SCRIPT" next 1.0.0)" = 1.0.1 ]
  [ "$(bash "$SCRIPT" next 1.0.98)" = 1.0.99 ]
  [ "$(bash "$SCRIPT" next 1.0.99)" = 1.1.0 ]
  [ "$(bash "$SCRIPT" next 1.1.0)" = 1.1.1 ]
  [ "$(bash "$SCRIPT" next 1.9.99)" = 1.10.0 ]
  [ "$(bash "$SCRIPT" next 2.0.9)" = 2.0.10 ]
}

@test "next: anything but x.y.z is refused" {
  local bad
  for bad in '' v1.0.0 1.0 1.0.0.0 1.0.0-rc.1 01.0.0 1.a.0 ' 1.0.0'; do
    run bash "$SCRIPT" next "$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"not an x.y.z version"* ]]
  done
}

@test "the repository's packages carry one x.y.z version" {
  run bash "$SCRIPT" current
  [ "$status" -eq 0 ]
  [[ $output =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

@test "set writes every file, lockfiles twice, and nothing else in them" {
  copy_tree
  cp -r "$T" "$BATS_TEST_TMPDIR/before"
  run bash "$SCRIPT" set 4.5.6
  [ "$status" -eq 0 ]
  [ "$output" = 4.5.6 ]
  [ "$(bash "$SCRIPT" current)" = 4.5.6 ]
  [ "$(jq -r .version "$T/frontend/packages/package.json")" = 4.5.6 ]
  [ "$(jq -r '.packages[""].version' "$T/backend/package-lock.json")" = 4.5.6 ]
  grep -q '^ *versionName "4.5.6"' "$T/frontend/packages/android/app/build.gradle"
  # Only the version lines change: two per lockfile, one per manifest and in build.gradle.
  run diff -ru "$BATS_TEST_TMPDIR/before" "$T"
  added=$(grep -E '^\+([^+]|$)' <<<"$output")
  [ "$(wc -l <<<"$added")" -eq 8 ]
  ! grep -v '4\.5\.6' <<<"$added"
}

@test "set refuses a bad version and leaves the files alone" {
  copy_tree
  before=$(bash "$SCRIPT" current)
  run bash "$SCRIPT" set 1.2
  [ "$status" -eq 2 ]
  [ "$(bash "$SCRIPT" current)" = "$before" ]
}

@test "bump moves to the next version, across the .99 rollover" {
  copy_tree
  bash "$SCRIPT" set 1.0.98
  [ "$(bash "$SCRIPT" bump)" = 1.0.99 ]
  [ "$(bash "$SCRIPT" bump)" = 1.1.0 ]
  [ "$(bash "$SCRIPT" current)" = 1.1.0 ]
  grep -q '^ *versionName "1.1.0"' "$T/frontend/packages/android/app/build.gradle"
}

@test "current lists the files when they disagree, and bump refuses to guess" {
  copy_tree
  bash "$SCRIPT" set 1.0.3
  jq '.packages[""].version = "1.0.2"' "$T/frontend/package-lock.json" >"$T/x" && mv "$T/x" "$T/frontend/package-lock.json"
  sed -i 's/versionName "1.0.3"/versionName "0.9.0"/' "$T/frontend/packages/android/app/build.gradle"
  run bash "$SCRIPT" current
  [ "$status" -eq 1 ]
  [[ $output == *"1.0.2"*"frontend/package-lock.json (packages[\"\"])"* ]]
  [[ $output == *"0.9.0"*"build.gradle (versionName)"* ]]
  run bash "$SCRIPT" bump
  [ "$status" -ne 0 ]
  [[ $output == *"fix the versions first"* ]]
}

@test "current counts a file without a version as a mismatch" {
  copy_tree
  bash "$SCRIPT" set 1.0.3
  jq 'del(.version)' "$T/frontend/packages/package.json" >"$T/x" && mv "$T/x" "$T/frontend/packages/package.json"
  run bash "$SCRIPT" current
  [ "$status" -eq 1 ]
  [[ $output == *"(none)"*"frontend/packages/package.json"* ]]
}
