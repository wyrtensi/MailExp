#!/usr/bin/env bats
# The stand's DNS fixture: zone.sh prints a dnsmasq configuration for stage.test.

zone() { sh "$BATS_TEST_DIRNAME/stand-dns/zone.sh" "$@"; }

@test "the ok variant has one SPF with the Microsoft include, MX, DKIM, DMARC and the MS= record" {
  run zone ok QUJD
  [ "$status" -eq 0 ]
  [ "$(grep -c 'v=spf1' <<<"$output")" -eq 1 ]
  grep -q 'include:spf.protection.outlook.com' <<<"$output"
  ! grep -q 'ip4:' <<<"$output"
  grep -q '^mx-host=stage.test,stage-test.mail.protection.outlook.com,0$' <<<"$output"
  grep -q '^txt-record=dkim._domainkey.stage.test,"v=DKIM1;k=rsa;t=s;s=email;p=QUJD"$' <<<"$output"
  grep -q '^txt-record=_dmarc.stage.test,"v=DMARC1; p=quarantine' <<<"$output"
  grep -q '"MS=ms12345678"' <<<"$output"
  grep -q '^ptr-record=' <<<"$output"
}

@test "SPF variants: none, one with ip4, two records" {
  run zone no-spf QUJD
  ! grep -q 'v=spf1' <<<"$output"
  run zone spf-ip4 QUJD
  grep -q 'v=spf1 ip4:' <<<"$output"
  run zone spf-double QUJD
  [ "$(grep -c 'v=spf1' <<<"$output")" -eq 2 ]
}

@test "DKIM variants: none, selector CNAMEs, a key that differs from the node's" {
  run zone no-dkim QUJD
  ! grep -q '_domainkey' <<<"$output"
  run zone dkim-cname QUJD
  [ "$(grep -c '^cname=selector[12]\._domainkey' <<<"$output")" -eq 2 ]
  run zone dkim-mismatch QUJD
  grep -q 'p=DHW' <<<"$output"
}

@test "MX variants: a wrong host, an extra host, the new mx.microsoft form" {
  run zone wrong-mx QUJD
  ! grep -q 'protection.outlook.com,0' <<<"$output"
  run zone extra-mx QUJD
  [ "$(grep -c '^mx-host=' <<<"$output")" -eq 2 ]
  run zone mx-new-form QUJD
  grep -q '^mx-host=stage.test,stage-test.mx.microsoft,0$' <<<"$output"
}

@test "the other variants drop or add exactly their record" {
  run zone no-dmarc QUJD
  ! grep -q '_dmarc' <<<"$output"
  run zone no-ms-txt QUJD
  ! grep -q 'MS=' <<<"$output"
  run zone no-ptr QUJD
  ! grep -q '^ptr-record=' <<<"$output"
  run zone aaaa QUJD
  grep -q '^host-record=mail.test.local,2001:db8::10$' <<<"$output"
  run zone mta-sts QUJD
  grep -q '_mta-sts.stage.test' <<<"$output"
}

@test "a long DKIM key is split into strings of at most 250 characters" {
  key=$(head -c 600 /dev/zero | tr '\0' 'A')
  run zone ok "$key"
  [ "$status" -eq 0 ]
  line=$(grep '^txt-record=dkim' <<<"$output")
  [ "$(grep -o '","' <<<"$line" | wc -l)" -ge 2 ]
  ! grep -qE '"[^"]{256,}"' <<<"$line"
}

@test "unknown variants and keys that are not base64 are refused with status 2" {
  run zone nope QUJD
  [ "$status" -eq 2 ]
  run zone ok 'a b'
  [ "$status" -eq 2 ]
  run zone ok
  [ "$status" -eq 2 ]
}
