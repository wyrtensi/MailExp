# shellcheck shell=bash
# Decisions of updater.sh, the host side of "update from the panel". The spool's request
# directory is writable by the backend container, which may be compromised: everything read from
# it is untrusted input, and these functions are where it is judged. Pure: input on arguments and
# stdin, no Docker, no writes except the files passed in.

# shellcheck disable=SC2034 # the limits below are read by updater.sh
# The uid the backend container writes as, when install.sh could not ask the image: `USER node` in
# backend/Dockerfile is uid 1000 in the official node images. install.sh records the image's real
# uid in <state dir>/spool-uid (spool_uid). A request file owned by anyone else did not come from
# the backend.
DEFAULT_SPOOL_UID=1000
SPOOL_UID=$DEFAULT_SPOOL_UID
# A request is five short fields; anything bigger is not one.
MAX_REQUEST_BYTES=4096
# Requests taken per run; the rest are deleted without a result (a flood must not hold the
# updater for hours or fill result/ with files).
MAX_REQUESTS_PER_RUN=10
# Result files kept in the spool; older ones are deleted.
KEEP_RESULTS=20
# Lines of the run's log copied into a result, and their width.
LOG_TAIL_LINES=40
LOG_LINE_WIDTH=300

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# spool_uid <state dir>: the backend's uid recorded by install.sh, DEFAULT_SPOOL_UID without a
# valid record (a number, not root).
spool_uid() {
  local uid=''
  if [ -f "$1/spool-uid" ]; then uid=$(head -c 16 "$1/spool-uid" | tr -d '[:space:]'); fi
  if [[ $uid =~ ^[1-9][0-9]{0,9}$ ]]; then echo "$uid"; else echo "$DEFAULT_SPOOL_UID"; fi
}

# prepare_update_spool <state dir>: the spool the backend container mounts (deploy/compose.prod.yml):
# request/ is the backend's (uid from spool_uid, 0700), result/ is root's and readable (0755). Run
# on every install.sh, with or without systemd: without the directories the bind mounts would be
# created by dockerd as root and the backend could not write. An entry that is not a directory
# (a link) is replaced; the parent is root's, so only root could have put it there.
prepare_update_spool() {
  local spool=$1/update-spool dir uid
  uid=$(spool_uid "$1")
  for dir in "$spool" "$spool/result" "$spool/request"; do
    if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then rm -f -- "$dir"; fi
  done
  install -d -m 755 -o 0 -g 0 "$spool" "$spool/result"
  install -d -m 700 -o "$uid" -g "$uid" "$spool/request"
}

# rolled_back_version <state dir>: the version a person (rollback.sh) or the updater's automatic
# rollback went back from, empty when none. The panel does not offer it again: only a newer build.
rolled_back_version() {
  local v=''
  if [ -f "$1/rolled-back-version" ]; then v=$(head -c 32 "$1/rolled-back-version" | tr -d '[:space:]'); fi
  if [[ $v =~ ^sha-[0-9a-f]{12}$ ]]; then echo "$v"; fi
  return 0
}

# record_rolled_back <state dir> <version>
record_rolled_back() {
  printf '%s\n' "$2" >"$1/rolled-back-version"
}

# forget_rolled_back_if_running <state dir> <version>: install.sh, once <version> runs and is
# ready. A person who went back to the version that was rolled back from (update.sh or
# install.sh --version over SSH) runs it now: the record is stale and would make the panel say
# that the running version cannot be installed. Prints the version it forgot.
forget_rolled_back_if_running() {
  [ -n "$2" ] && [ "$(rolled_back_version "$1")" = "$2" ] || return 0
  rm -f "$1/rolled-back-version"
  if [ -f "$1/update-spool/result/updater.json" ]; then write_updater_installed "$1" "$2"; fi
  printf '%s\n' "$2"
}

# write_updater_installed <state dir> <version>: result/updater.json, how the panel learns that
# the host units are there (no file: the card says the mechanism is not installed) and which
# version it must not offer again (rolledBack).
write_updater_installed() {
  local dir=$1/update-spool/result tmp rolled
  rolled=$(rolled_back_version "$1")
  tmp=$(mktemp "$dir/.updater.XXXXXX")
  jq -cn --arg v "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg r "$rolled" \
    '{installed: true, version: $v, updatedAt: $at, rolledBack: (if $r == "" then null else $r end)}' >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dir/updater.json"
}

# request_name_ok <file name>: status 0 for <uuid>.json, the only name the backend writes.
request_name_ok() {
  local name=$1
  [[ $name == *.json ]] || return 1
  [[ ${name%.json} =~ $UUID_RE ]]
}

# request_file_problem <type> <uid> <size> <links>: the reason a staged request file is refused
# (`stat -c '%F|%u|%s|%h'`, which does not follow a symbolic link), empty when it is acceptable: a
# regular file of the backend's uid, not empty, not too big, with a single link.
request_file_problem() {
  local type=$1 uid=$2 size=$3 links=$4
  if [ "$type" != "regular file" ] && [ "$type" != "regular empty file" ]; then
    echo "not a regular file ($type)"
  elif [ "$uid" != "$SPOOL_UID" ]; then
    echo "owned by uid $uid, not the backend's $SPOOL_UID"
  elif ! [[ $size =~ ^[0-9]+$ ]] || [ "$size" -eq 0 ] || [ "$size" -gt "$MAX_REQUEST_BYTES" ]; then
    echo "size $size is not 1..$MAX_REQUEST_BYTES bytes"
  elif [ "$links" != 1 ]; then
    echo "has $links links"
  fi
  return 0
}

# parse_request <id>: reads a request on stdin and prints "<action> <target>" when it is exactly
# {id, action, target, requestedAt, requestedBy} with the id of its file name, action check or
# update, target sha-<12 hex>; status 1 otherwise. Nothing else in it is ever used.
parse_request() {
  jq -er --arg id "$1" '
    if type == "object"
      and (keys == ["action", "id", "requestedAt", "requestedBy", "target"])
      and .id == $id
      and (.action == "check" or .action == "update")
      and (.target | type == "string" and test("\\Asha-[0-9a-f]{12}\\z"))
      and (.requestedAt | type == "string" and length <= 64)
      and (.requestedBy | type == "string" and length <= 254)
    then "\(.action) \(.target)" else error("invalid request") end' 2>/dev/null
}

# request_actor: reads a request on stdin and prints who asked, reduced to characters that are
# safe in a log line. Only logged, never trusted.
request_actor() {
  jq -r '.requestedBy // "" | tostring' 2>/dev/null | head -c 254 | LC_ALL=C tr -cd 'A-Za-z0-9@._+-'
}

# target_verdict <is HEAD 0|1> <descendant of HEAD 0|1> <the promoted latest 0|1> <on main 0|1>
# <rolled back from 0|1>: empty when the panel may move to the target, otherwise the reason. Only
# the build the owner promoted (the tag latest), only forward (a descendant of the running commit,
# so a compromised admin or backend cannot roll the server back), only on origin/main, and never
# the version a person just rolled back from. Any other version is update.sh over SSH; going back
# is rollback.sh, by a person.
target_verdict() {
  local head=$1 descendant=$2 latest=$3 main=$4 rolled=$5
  if [ "$head" = 1 ]; then
    echo "the panel already runs this version"
  elif [ "$latest" != 1 ]; then
    echo "not the promoted latest build: the panel only installs what the owner promoted (other versions: update.sh over SSH)"
  elif [ "$main" != 1 ]; then
    echo "the tag latest names a commit outside main; the panel refuses it"
  elif [ "$descendant" != 1 ]; then
    echo "not a descendant of the running commit: a downgrade is never done from the panel (going back: rollback.sh over SSH)"
  elif [ "$rolled" = 1 ]; then
    echo "this version was rolled back; the panel offers it again only after a newer build is promoted"
  fi
  return 0
}

# preflight_verdict <status.sh exit code>: reads status.sh --json on stdin and prints ready,
# blocked (problems found) or error (the script failed, or its output is not a report).
preflight_verdict() {
  local json
  json=$(cat)
  if ! jq -e 'type == "object" and (has("error") | not) and (.problems | type == "array")' >/dev/null 2>&1 <<<"$json"; then
    echo error
  elif [ "$1" = 0 ] && jq -e '.problems == []' >/dev/null 2>&1 <<<"$json"; then
    echo ready
  elif [ "$1" = 0 ] || [ "$1" = 1 ]; then
    echo blocked
  else
    echo error
  fi
}

# preflight_summary: reads status.sh --json on stdin and prints the part a result carries.
# pendingMigrations is null when the schema was not read: then migrations count as present.
preflight_summary() {
  jq -c '{ok: ((.problems // ["?"]) == []),
          problems: (.problems // []), warnings: (.warnings // []), next: (.next // []), info: (.info // []),
          pendingMigrations: (.target.pending_migrations // null),
          migrationsApplied: (.migrations_applied // null)}' 2>/dev/null || echo null
}

# auto_rollback_allowed <preflight summary JSON>: status 0 only when it is known that the target
# runs no migration: the schema was read and nothing is pending. Then going back after a failed
# switch is install.sh --version <old>, nothing is lost. Anything else needs the pre-update dump,
# and that is a person's decision.
auto_rollback_allowed() {
  jq -e '.pendingMigrations == [] and (.migrationsApplied | type == "number")' >/dev/null 2>&1 <<<"$1"
}

# state_terminal <state>: status 0 for a state after which the host writes the result no more.
state_terminal() {
  case $1 in
    ready | blocked | refused | error | succeeded | failed | rolled_back | rollback_failed) return 0 ;;
    *) return 1 ;;
  esac
}

# log_tail: reads a run's log on stdin and prints the lines a result may carry: only the scripts'
# own "[mailexpert] " lines (no command output), none that looks like KEY=value of a secret, the
# last LOG_TAIL_LINES, each cut to LOG_LINE_WIDTH. The scripts never print secrets outside a
# terminal; this is the second guard.
log_tail() {
  grep -a '^\[mailexpert\] ' | grep -avE '(PASSWORD|SECRET|TOKEN|KEY|PRIVATE)[A-Z_]*=' |
    tail -n "$LOG_TAIL_LINES" | cut -c "1-$LOG_LINE_WIDTH" || true
}

# log_next: reads a run's log on stdin and prints its "next:" steps (update.sh's notes).
log_next() {
  sed -n 's/^\[mailexpert\] next: //p' | cut -c "1-$LOG_LINE_WIDTH" || true
}

# result_merge <now> <name=<JSON value>...>: reads a result on stdin ({} for a new one) and prints
# it with the named fields set (names are the caller's constants, values JSON), updatedAt = <now>
# and terminal derived from the state.
result_merge() {
  local now=$1 pair i=0 filter='.'
  local -a args=()
  shift
  for pair in "$@"; do
    args+=(--argjson "v$i" "${pair#*=}")
    filter+=" | .${pair%%=*} = \$v$i"
    i=$((i + 1))
  done
  # shellcheck disable=SC2016 # jq variables, not the shell's
  filter+=' | .updatedAt = $now
    | .terminal = ((.state // "") as $s
      | ["ready", "blocked", "refused", "error", "succeeded", "failed", "rolled_back", "rollback_failed"]
      | index($s) != null)'
  jq -c --arg now "$now" "${args[@]}" "$filter"
}
