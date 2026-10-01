#!/bin/sh
# The dnsmasq configuration of the stand's DNS fixture (stage.sh dns ...): the zone stage.test as a
# tenant behind EOP should publish it, in one of several deliberately broken variants for the
# panel's DNS check (R-14, R-15). POSIX sh: it runs on the host and in bats.
#
#   zone.sh <variant> <dkim public key, base64, one line>
#   zone.sh variants
#
# All names are fixtures: the MX and the SPF include are the forms Microsoft publishes, but nothing
# here reaches Microsoft.
set -eu

VARIANTS="ok no-spf spf-ip4 spf-double no-dkim dkim-mismatch dkim-cname no-dmarc dmarc-bad wrong-mx extra-mx mx-new-form no-ms-txt ms-txt-wrong mta-sts no-ptr aaaa"

if [ "${1:-}" = variants ]; then
  echo "$VARIANTS"
  exit 0
fi
variant=${1:-}
key=${2:-}
case " $VARIANTS " in *" $variant "*) ;; *)
  echo "zone.sh: unknown variant '$variant'; one of: $VARIANTS" >&2
  exit 2
  ;;
esac
case $key in '' | *[!A-Za-z0-9+/=]*) echo "zone.sh: the DKIM key must be base64 on one line" >&2; exit 2 ;; esac

Z=stage.test
NODE_IP=203.0.113.10
NODE_PTR=10.113.0.203.in-addr.arpa
MX_LEGACY=stage-test.mail.protection.outlook.com
MX_NEW=stage-test.mx.microsoft
SPF_OK="v=spf1 include:spf.protection.outlook.com -all"
DMARC_OK="v=DMARC1; p=quarantine; rua=mailto:dmarc@$Z"
MS_TXT=MS=ms12345678

# A TXT value longer than 255 characters goes out as several strings, as DNS hosts store it.
chunks() {
  printf '%s' "$1" | fold -w 250 | sed -e 's/.*/"&"/' | paste -sd, -
}

dkim_value() { printf 'v=DKIM1;k=rsa;t=s;s=email;p=%s' "$1"; }
# A different but well-formed key: the base64 letters rotated by 13 (digits, + and / stay).
other_key() { printf '%s' "$1" | tr 'A-Za-z' 'N-ZA-Mn-za-m'; }

echo "# stage.test fixture, variant $variant"
echo "no-resolv"
echo "no-hosts"
echo "no-poll"
echo "log-queries"
echo "log-facility=-"
echo "local=/$Z/"
echo "local=/mail.test.local/"
echo "local=/113.0.203.in-addr.arpa/"

# Mail routing.
case $variant in
  wrong-mx) echo "mx-host=$Z,mail.other.test,0" ;;
  extra-mx)
    echo "mx-host=$Z,$MX_LEGACY,0"
    echo "mx-host=$Z,mail.other.test,10"
    ;;
  mx-new-form) echo "mx-host=$Z,$MX_NEW,0" ;;
  *) echo "mx-host=$Z,$MX_LEGACY,0" ;;
esac

# SPF: exactly one v=spf1 with the Microsoft include and no node address.
case $variant in
  no-spf) ;;
  spf-ip4) echo "txt-record=$Z,\"v=spf1 ip4:$NODE_IP include:spf.protection.outlook.com -all\"" ;;
  spf-double)
    echo "txt-record=$Z,\"$SPF_OK\""
    echo "txt-record=$Z,\"v=spf1 mx -all\""
    ;;
  *) echo "txt-record=$Z,\"$SPF_OK\"" ;;
esac

# Tenant verification.
case $variant in
  no-ms-txt) ;;
  ms-txt-wrong) echo "txt-record=$Z,\"MS=ms00000000\"" ;;
  *) echo "txt-record=$Z,\"$MS_TXT\"" ;;
esac

# DKIM: the node's key in dkim._domainkey (split in strings), or the selector CNAMEs.
case $variant in
  no-dkim) ;;
  dkim-mismatch) echo "txt-record=dkim._domainkey.$Z,$(chunks "$(dkim_value "$(other_key "$key")")")" ;;
  dkim-cname)
    echo "cname=selector1._domainkey.$Z,selector1-stage-test._domainkey.tenant.onmicrosoft.test"
    echo "cname=selector2._domainkey.$Z,selector2-stage-test._domainkey.tenant.onmicrosoft.test"
    ;;
  *) echo "txt-record=dkim._domainkey.$Z,$(chunks "$(dkim_value "$key")")" ;;
esac

# DMARC, and an MTA-STS policy that would break inbound mail for a node behind EOP.
case $variant in
  no-dmarc) ;;
  dmarc-bad) echo "txt-record=_dmarc.$Z,\"p=none\"" ;;
  *) echo "txt-record=_dmarc.$Z,\"$DMARC_OK\"" ;;
esac
if [ "$variant" = mta-sts ]; then echo "txt-record=_mta-sts.$Z,\"v=STSv1; id=20261001000000\""; fi

# The node's own name: A, PTR and (in one variant) an AAAA that IPv6-less mailcow must not have.
echo "host-record=mail.test.local,$NODE_IP"
if [ "$variant" != no-ptr ]; then echo "ptr-record=$NODE_PTR,mail.test.local"; fi
if [ "$variant" = aaaa ]; then echo "host-record=mail.test.local,2001:db8::10"; fi
