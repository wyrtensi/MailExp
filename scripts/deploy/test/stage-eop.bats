#!/usr/bin/env bats
# The stand's fake-EOP hook into Postfix: one line of mailcow's extra.cf, everything else kept.

setup() {
  EXTRA_CF=$BATS_TEST_DIRNAME/../mail-node/extra-cf.sh
  F=$BATS_TEST_TMPDIR/extra.cf
}

@test "set appends the key to a file that does not have it and keeps the other lines" {
  printf 'myhostname = mail.test.local\n' >"$F"
  run sh "$EXTRA_CF" set "$F" relayhost eop.test.local
  [ "$status" -eq 0 ]
  [ "$(cat "$F")" = $'myhostname = mail.test.local\nrelayhost = eop.test.local' ]
}

@test "set creates a missing file" {
  run sh "$EXTRA_CF" set "$F" relayhost eop.test.local
  [ "$status" -eq 0 ]
  [ "$(cat "$F")" = 'relayhost = eop.test.local' ]
}

@test "set is idempotent and replaces an existing value in place of adding a second line" {
  printf 'relayhost =\nsmtpd_banner = x\nrelayhost = old.example.com\n' >"$F"
  sh "$EXTRA_CF" set "$F" relayhost eop.test.local
  sh "$EXTRA_CF" set "$F" relayhost eop.test.local
  [ "$(grep -c '^relayhost' "$F")" -eq 1 ]
  [ "$(cat "$F")" = $'smtpd_banner = x\nrelayhost = eop.test.local' ]
}

@test "get prints the value; an absent key or file exits 1" {
  printf 'a = 1\nrelayhost = eop.test.local  \n' >"$F"
  run sh "$EXTRA_CF" get "$F" relayhost
  [ "$status" -eq 0 ]
  [ "$output" = eop.test.local ]
  run sh "$EXTRA_CF" get "$F" missing
  [ "$status" -eq 1 ]
  run sh "$EXTRA_CF" get "$BATS_TEST_TMPDIR/none" relayhost
  [ "$status" -eq 1 ]
}

@test "unset removes only the key; unset of an absent key or file changes nothing" {
  printf 'a = 1\nrelayhost = eop.test.local\nb = 2\n' >"$F"
  sh "$EXTRA_CF" unset "$F" relayhost
  [ "$(cat "$F")" = $'a = 1\nb = 2' ]
  sh "$EXTRA_CF" unset "$F" relayhost
  [ "$(cat "$F")" = $'a = 1\nb = 2' ]
  run sh "$EXTRA_CF" unset "$BATS_TEST_TMPDIR/none" relayhost
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/none" ]
}

@test "a key that is a prefix of another is left alone" {
  printf 'relayhost_x = keep\nrelayhost = eop.test.local\n' >"$F"
  sh "$EXTRA_CF" unset "$F" relayhost
  [ "$(cat "$F")" = 'relayhost_x = keep' ]
}

@test "set keeps the file's mode" {
  printf 'a = 1\n' >"$F"
  chmod 640 "$F"
  sh "$EXTRA_CF" set "$F" relayhost eop.test.local
  [ "$(stat -c %a "$F")" = 640 ]
}

@test "bad arguments are refused with status 2" {
  run sh "$EXTRA_CF" frob "$F" relayhost
  [ "$status" -eq 2 ]
  run sh "$EXTRA_CF" set "$F" 'Bad Key' v
  [ "$status" -eq 2 ]
  run sh "$EXTRA_CF" set "$F" relayhost 'two words'
  [ "$status" -eq 2 ]
  run sh "$EXTRA_CF" set "$F" relayhost
  [ "$status" -eq 2 ]
  [ ! -e "$F" ]
}
