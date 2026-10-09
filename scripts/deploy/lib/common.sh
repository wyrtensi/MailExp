# shellcheck shell=bash
# Helpers shared by the deploy scripts. Sourced, never executed.

log() { printf '[mailexpert] %s\n' "$*" >&2; }
warn() { printf '[mailexpert] warning: %s\n' "$*" >&2; }

# redact_url <url>: the URL without user information (https://user:token@host/x -> https://host/x),
# for messages and logs: a repository URL may carry a token, and the updater's results reach the
# backend container.
redact_url() {
  printf '%s\n' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#'
}

# error_tail: reads a command's error output on stdin and prints its last non-empty line, without
# the user information of any URL in it (git names the remote, which may carry a token), cut to
# 200 characters: the cause a message names.
error_tail() {
  sed -e '/^[[:space:]]*$/d' | tail -n 1 | sed -E 's#([A-Za-z][A-Za-z0-9+.-]*://)[^/@[:space:]]*@#\1#g' | cut -c1-200
}

# die <message> [exit code, default 1]
die() {
  printf '[mailexpert] error: %s\n' "$1" >&2
  exit "${2:-1}"
}

# exit_on_unexpected_failure: a command that fails outside `die` ends the script with 1, whatever
# its own status (git 128, apt-get 100, jq 2): callers branch on 2 (invalid input) and 3 (waiting
# for secrets), which only the scripts themselves return. Only the location is printed, never the
# command, whose arguments may hold secrets.
exit_on_unexpected_failure() {
  set -E
  trap 'printf "[mailexpert] error: a command failed with status %s at %s:%s\n" "$?" "${BASH_SOURCE[0]##*/}" "$LINENO" >&2; exit 1' ERR
}

# take_install_lock <state dir> <seconds> <script name>: takes <state dir>/install.lock on fd 9,
# shared by install.sh and configure.sh, waiting up to <seconds>. flock -n in a loop instead of
# flock -w: BusyBox flock has no timeout.
take_install_lock() {
  local dir=$1 timeout=$2 name=$3 waited=0
  command -v flock >/dev/null || die "flock is required"
  exec 9>"$dir/install.lock"
  until flock -n 9; do
    if [ "$waited" -eq 0 ]; then log "$name: waiting for another install.sh or configure.sh to finish"; fi
    [ "$waited" -lt "$timeout" ] ||
      die "$name: another install.sh or configure.sh has held $dir/install.lock for ${timeout}s; try again when it finishes"
    sleep 1
    waited=$((waited + 1))
  done
}

# take_lock <file> <seconds> <what> [descriptor variable]: an exclusive flock on <file>, held until the process exits,
# waiting up to <seconds> for <what> to let go. Children inherit the descriptor, so a script must
# not run a child that takes the same lock (it would wait for its own parent).
take_lock() {
  local file=$1 timeout=$2 what=$3 fd waited=0
  command -v flock >/dev/null || die "flock is required"
  exec {fd}>"$file"
  if [ $# -ge 4 ]; then printf -v "$4" '%s' "$fd"; fi
  until flock -n "$fd"; do
    if [ "$waited" -eq 0 ]; then log "waiting for $what to finish"; fi
    [ "$waited" -lt "$timeout" ] || die "$what has held $file for ${timeout}s; try again when it finishes"
    sleep 1
    waited=$((waited + 1))
  done
}

# version_ge <a> <b>: a >= b for dotted numeric versions. A leading "v" and a "-..." or
# "+..." suffix are ignored, so 2.24.4-desktop.1 compares as 2.24.4.
version_ge() {
  local a=${1#v} b=${2#v} i x y
  local -a av bv
  a=${a%%[-+]*}
  b=${b%%[-+]*}
  [[ $a =~ ^[0-9]+(\.[0-9]+)*$ && $b =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
  IFS=. read -r -a av <<<"$a"
  IFS=. read -r -a bv <<<"$b"
  for i in 0 1 2 3; do
    x=${av[i]:-0}
    y=${bv[i]:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# ping_target <base url> <start|success|fail>: the URL of the event (Healthchecks-style: the base
# URL is success, /start and /fail are the others).
ping_target() {
  local base=${1%/}
  case $2 in
    success) printf '%s\n' "$base" ;;
    start | fail) printf '%s/%s\n' "$base" "$2" ;;
    *) return 1 ;;
  esac
}

# send_ping <base url> <start|success|fail> [text]: tells the monitoring service; never fails the
# caller. The URL carries the check's key, so it reaches curl through a config on a file
# descriptor, not through argv; curl's own messages are dropped for the same reason. Shared by the
# panel's scripts and the mail node's (mail-node/eop-ranges.sh).
send_ping() {
  local base=$1 kind=$2 body=${3:-} target
  [ -n "$base" ] || return 0
  target=$(ping_target "$base" "$kind") || return 0
  if ! printf '%s' "$body" | curl -fsS -m 10 --retry 2 -o /dev/null --data-binary @- \
    -K <(printf 'url = "%s"\n' "$target") 2>/dev/null; then
    warn "could not reach the monitoring service ($kind ping)"
  fi
}

# ensure_image <image>: pulls the image unless it is present locally (an emergency build from
# source tags a local image that a pull must not replace). Shared by the panel's scripts and the
# mail node's backup.
ensure_image() {
  if docker image inspect "$1" >/dev/null 2>&1; then return 0; fi
  log "pulling $1"
  docker pull --quiet "$1" >/dev/null || die "cannot pull $1 (the panel's own images can be built from source: see deploy/compose.prod.yml)"
}

# gen_hex <bytes>: random bytes as lowercase hex, two characters per byte.
gen_hex() {
  head -c "$1" /dev/urandom | od -A n -v -t x1 | tr -d ' \n'
}

is_hostname() {
  [ "${#1}" -le 253 ] && [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

is_email() {
  [[ $1 =~ ^[^[:space:]@,]+@([a-z0-9-]+\.)+[a-z]{2,63}$ ]]
}

is_port() {
  [[ $1 =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

# is_prefix <path>: an install prefix: absolute, letters, digits and . _ / - only, no ".." segment
# (compose records the resolved directory, which the ownership check compares with).
is_prefix() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] && ! [[ $1 =~ (^|/)\.\.(/|$) ]]
}

# clean_path <path>: the path without repeated slashes, "/./" and a trailing slash, as compose
# records it.
clean_path() {
  local path=$1
  while [[ $path == *//* ]]; do path=${path//\/\//\/}; done
  while [[ $path == */./* ]]; do path=${path//\/.\//\/}; done
  if [[ $path == ?*/. ]]; then path=${path%/.}; fi
  if [ "$path" != / ]; then path=${path%/}; fi
  printf '%s\n' "$path"
}

# is_name <compose project name>
is_name() {
  [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]
}
