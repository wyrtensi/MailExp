#!/usr/bin/env bats
# The stand's DNS fixture: zone.sh prints a dnsmasq configuration for stage.test.

bats_require_minimum_version 1.5.0

zone() { sh "$BATS_TEST_DIRNAME/stand-dns/zone.sh" "$@"; }

# A bare `! grep` or `a && b` that is not the last command of a test never fails it (errexit does
# not look at them), so the checks are functions that return 1 themselves.
has() {
  grep -Eq -e "$1" <<<"$output" && return 0
  echo "expected a line matching: $1" >&2
  return 1
}
lacks() {
  if grep -Eq -e "$1" <<<"$output"; then
    echo "unexpected line matching: $1" >&2
    return 1
  fi
}
count() {
  local n
  n=$(grep -Ec -e "$1" <<<"$output" || true)
  [ "$n" -eq "$2" ] || { echo "expected $2 lines matching '$1', found $n" >&2; return 1; }
}

@test "the ok variant has one SPF with the Microsoft include, MX, DKIM, DMARC and the MS= record" {
  run zone ok QUJD
  [ "$status" -eq 0 ]
  count 'v=spf1' 1
  has 'include:spf\.protection\.outlook\.com'
  lacks 'ip4:'
  has '^mx-host=stage\.test,stage-test\.mail\.protection\.outlook\.com,0$'
  has '^txt-record=dkim\._domainkey\.stage\.test,"v=DKIM1;k=rsa;t=s;s=email;p=QUJD"$'
  has '^txt-record=_dmarc\.stage\.test,"v=DMARC1; p=quarantine'
  has '"MS=ms12345678"'
  has '^ptr-record='
}

@test "SPF variants: none, one with ip4, two records" {
  run zone no-spf QUJD
  [ "$status" -eq 0 ]
  lacks 'v=spf1'
  run zone spf-ip4 QUJD
  has 'v=spf1 ip4:'
  run zone spf-double QUJD
  count 'v=spf1' 2
}

@test "DKIM variants: none, selector CNAMEs, a key that differs from the node's" {
  run zone no-dkim QUJD
  [ "$status" -eq 0 ]
  lacks '_domainkey'
  run zone dkim-cname QUJD
  count '^cname=selector[12]\._domainkey' 2
  lacks 'txt-record=dkim'
  run zone dkim-mismatch QUJD
  has 'p=DHWQ'
  lacks 'p=QUJD'
}

@test "MX variants: a wrong host, an extra host, the new mx.microsoft form" {
  run zone wrong-mx QUJD
  [ "$status" -eq 0 ]
  lacks 'protection\.outlook\.com,0'
  has '^mx-host=stage\.test,mail\.other\.test,0$'
  run zone extra-mx QUJD
  count '^mx-host=' 2
  run zone mx-new-form QUJD
  has '^mx-host=stage\.test,stage-test\.mx\.microsoft,0$'
  lacks 'protection\.outlook\.com,0'
}

@test "the other variants drop or add exactly their record" {
  run zone no-dmarc QUJD
  [ "$status" -eq 0 ]
  lacks '_dmarc'
  run zone dmarc-bad QUJD
  has '^txt-record=_dmarc\.stage\.test,"p=none"$'
  run zone no-ms-txt QUJD
  lacks 'MS='
  run zone ms-txt-wrong QUJD
  has '"MS=ms00000000"'
  lacks 'ms12345678'
  run zone no-ptr QUJD
  lacks '^ptr-record='
  # host-record would publish the PTR by itself.
  lacks '^host-record=mail\.test\.local,203'
  has '^address=/mail\.test\.local/203\.0\.113\.10$'
  run zone aaaa QUJD
  has '^host-record=mail\.test\.local,2001:db8::10$'
  run zone mta-sts QUJD
  has '_mta-sts\.stage\.test'
}

@test "a long DKIM key is split into strings of at most 250 characters" {
  key=$(head -c 600 /dev/zero | tr '\0' 'A')
  run zone ok "$key"
  [ "$status" -eq 0 ]
  line=$(grep '^txt-record=dkim' <<<"$output")
  [ "$(grep -o '","' <<<"$line" | wc -l)" -ge 2 ]
  if grep -qE '"[^"]{256,}"' <<<"$line"; then
    echo "a string is longer than 255 characters" >&2
    return 1
  fi
}

@test "unknown variants and keys that are not base64 are refused with status 2" {
  run zone nope QUJD
  [ "$status" -eq 2 ]
  run zone ok 'a b'
  [ "$status" -eq 2 ]
  run zone ok
  [ "$status" -eq 2 ]
}

@test "a refused variant prints nothing on stdout, so a caller cannot take it for a zone" {
  run --separate-stderr zone nope QUJD
  [ "$status" -eq 2 ]
  [ -z "$output" ]
}

@test "the list of variants is what stage.sh offers" {
  run zone variants
  [ "$status" -eq 0 ]
  for v in ok no-spf spf-ip4 spf-double no-dkim dkim-mismatch dkim-cname no-dmarc dmarc-bad wrong-mx extra-mx mx-new-form no-ms-txt ms-txt-wrong mta-sts no-ptr aaaa; do
    has "(^| )$v( |\$)"
  done
}
