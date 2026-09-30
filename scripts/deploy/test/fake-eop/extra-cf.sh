#!/bin/sh
# Edits one "key = value" line of a Postfix main.cf fragment (mailcow's data/conf/postfix/extra.cf),
# keeping every other line. Idempotent. POSIX sh: it runs inside the stand (BusyBox) and in bats.
#
#   extra-cf.sh set <file> <key> <value>    replace the key's line or append it
#   extra-cf.sh unset <file> <key>          remove the key's line
#   extra-cf.sh get <file> <key>            print the value, exit 1 when the key is absent
set -eu

action=${1:-}
file=${2:-}
key=${3:-}
case $action in
  set | unset | get) ;;
  *)
    echo "usage: extra-cf.sh set <file> <key> <value> | unset <file> <key> | get <file> <key>" >&2
    exit 2
    ;;
esac
[ -n "$file" ] && [ -n "$key" ] || { echo "extra-cf.sh: file and key are required" >&2; exit 2; }
case $key in *[!a-z_0-9]*) echo "extra-cf.sh: bad key: $key" >&2; exit 2 ;; esac

# Every line except the key's.
others() { [ -f "$file" ] && { grep -v "^[[:space:]]*${key}[[:space:]]*=" "$file" || true; } || true; }

case $action in
  get)
    [ -f "$file" ] || exit 1
    line=$(grep "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n 1)
    [ -n "$line" ] || exit 1
    printf '%s\n' "$line" | sed -e 's/^[^=]*=[[:space:]]*//' -e 's/[[:space:]]*$//'
    ;;
  set)
    value=${4:-}
    [ -n "$value" ] || { echo "extra-cf.sh: a value is required" >&2; exit 2; }
    case $value in *[[:space:]]*) echo "extra-cf.sh: the value must be one word" >&2; exit 2 ;; esac
    tmp=$(mktemp)
    { others; printf '%s = %s\n' "$key" "$value"; } >"$tmp"
    # cat, not mv: keeps the file's owner and mode, which mailcow's postfix container relies on.
    cat "$tmp" >"$file"
    rm -f "$tmp"
    ;;
  unset)
    [ -f "$file" ] || exit 0
    tmp=$(mktemp)
    others >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
    ;;
esac
