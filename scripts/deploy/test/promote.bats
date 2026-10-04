#!/usr/bin/env bats
# scripts/ci/promote-latest.sh (promote.yml): which commit is promoted, that its images must
# exist, the retag keeping the digest, and the git tag moved last. crane is a stub.

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

setup_repo() {
  R=$BATS_TEST_TMPDIR/remote.git
  W=$BATS_TEST_TMPDIR/work
  git init -q --bare -b main "$R"
  git init -q -b main "$W"
  printf '1\n' >"$W/a"
  ONE=$(commit "$W" one)
  printf '2\n' >"$W/a"
  TWO=$(commit "$W" two)
  git -C "$W" remote add origin "$R"
  git -C "$W" push -q origin main
  git -C "$W" checkout -q -b side "$ONE"
  printf 's\n' >"$W/s"
  SIDE=$(commit "$W" side)
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  cat >"$STUB/crane" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CRANE_LOG"
case $1 in
  digest)
    case $2 in
      *:latest) [ -f "$CRANE_TAGGED" ] && echo sha256:abc || echo sha256:other ;;
      *"${STUB_MISSING:-none}"*) echo "MANIFEST_UNKNOWN" >&2; exit 1 ;;
      *) echo sha256:abc ;;
    esac ;;
  tag) : >"$CRANE_TAGGED" ;;
esac
STUB_EOF
  chmod +x "$STUB/crane"
  export CRANE=$STUB/crane CRANE_LOG=$BATS_TEST_TMPDIR/crane.log CRANE_TAGGED=$BATS_TEST_TMPDIR/tagged IMAGE_PREFIX=ghcr.io/o
}

@test "promotes the head of main: images tagged latest, then the git tag" {
  setup_repo
  cd "$W"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(git -C "$R" rev-parse refs/tags/latest)" = "$TWO" ]
  [ "$(grep -c '^tag ' "$CRANE_LOG")" -eq 4 ]
  grep -q "^tag ghcr.io/o/mailexpert-tenant-worker:sha-${TWO:0:12} latest$" "$CRANE_LOG"
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

@test "DRY_RUN only checks" {
  setup_repo
  cd "$W"
  DRY_RUN=1 run bash "$SCRIPT" "$ONE"
  [ "$status" -eq 0 ]
  ! grep -q '^tag ' "$CRANE_LOG"
  ! git -C "$R" rev-parse --verify --quiet refs/tags/latest
}
