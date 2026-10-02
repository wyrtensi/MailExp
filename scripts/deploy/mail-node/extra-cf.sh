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
if [ -z "$file" ] || [ -z "$key" ]; then
  echo "extra-cf.sh: file and key are required" >&2
  exit 2
fi
case $key in *[!a-z_0-9]*) echo "extra-cf.sh: bad key: $key" >&2; exit 2 ;; esac

# Every line except the key's. Nothing when the file does not exist.
others() {
  if [ -f "$file" ]; then
    grep -v "^[[:space:]]*${key}[[:space:]]*=" "$file" || true
  fi
}

# write: stdin into the file through a temporary file in the same directory and a rename, so a full
# disk never leaves the file cut short; owner and mode of the file it replaces are kept (mailcow's
# postfix container relies on them), a new file gets 644.
write() {
  dir=$(dirname "$file")
  mkdir -p "$dir"
  tmp=$(mktemp "$file.XXXXXX")
  if ! cat >"$tmp"; then rm -f "$tmp"; exit 1; fi
  if [ -e "$file" ]; then
    if ! { chmod "$(stat -c %a "$file")" "$tmp" && chown "$(stat -c %u:%g "$file")" "$tmp"; }; then
      rm -f "$tmp"
      exit 1
    fi
  else
    chmod 644 "$tmp"
  fi
  mv -f "$tmp" "$file"
}

case $action in
  get)
    [ -f "$file" ] || exit 1
    line=$(grep "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n 1)
    [ -n "$line" ] || exit 1
    printf '%s\n' "$line" | sed -e 's/^[^=]*=[[:space:]]*//' -e 's/[[:space:]]*$//'
    ;;
  set)
    value=${4:-}
    if [ -z "$value" ]; then
      echo "extra-cf.sh: a value is required" >&2
      exit 2
    fi
    case $value in *[[:space:]]*) echo "extra-cf.sh: the value must be one word" >&2; exit 2 ;; esac
    { others; printf '%s = %s\n' "$key" "$value"; } | write
    ;;
  unset)
    [ -f "$file" ] || exit 0
    others | write
    ;;
esac
