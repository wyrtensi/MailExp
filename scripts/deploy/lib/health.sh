# shellcheck shell=bash
# Health decisions of healthcheck.sh over what docker compose ps, df and curl report. Pure.

# service_problems <service...>: reads "<service> <state> <health>" lines (docker compose ps
# --format '{{.Service}} {{.State}} {{.Health}}') on stdin and prints a problem for each listed
# service that is missing, not running or unhealthy. "starting" is fine: a container that just
# restarted gets its grace time, and a crash loop shows as "restarting".
service_problems() {
  local lines service line state health
  lines=$(cat)
  for service in "$@"; do
    line=$(grep -m 1 "^$service " <<<"$lines" || true)
    if [ -z "$line" ]; then
      echo "containers: $service does not exist"
      continue
    fi
    read -r _ state health <<<"$line"
    if [ "$state" != running ]; then
      echo "containers: $service is $state"
    elif [ "${health:-}" = unhealthy ]; then
      echo "containers: $service is unhealthy"
    fi
  done
}

# disk_problem <path> <used, as df prints it: 42%> [minimum free percent, default 15]
disk_problem() {
  local path=$1 used=${2%\%} min=${3:-15}
  if ! [[ $used =~ ^[0-9]+$ ]]; then
    echo "disk: cannot read the usage of $path"
  elif [ $((100 - used)) -lt "$min" ]; then
    echo "disk: $path is ${used}% full, less than ${min}% free"
  fi
  return 0
}

# cert_problem <host> <now> <expiry epoch or ''> [minimum days, default 14]
cert_problem() {
  local host=$1 now=$2 expiry=$3 min=${4:-14} days
  if ! [[ $expiry =~ ^[0-9]+$ ]]; then
    echo "certificate: cannot read the expiry date of $host"
    return 0
  fi
  days=$(((expiry - now) / 86400))
  if [ "$days" -lt "$min" ]; then echo "certificate: $host expires in $days days"; fi
  return 0
}

# updater_state <install.conf SYSTEM: 0|1>: the state of the host updater (install.sh install_updater),
# one word: no_system (installed without systemd, --no-system), no_systemd (no systemctl here),
# not_installed (no mailexpert-updater.path unit), active, inactive (installed, not watching).
updater_state() {
  if [ "${1:-1}" != 1 ]; then
    echo no_system
  elif ! command -v systemctl >/dev/null 2>&1; then
    echo no_systemd
  elif ! systemctl cat mailexpert-updater.path >/dev/null 2>&1; then
    echo not_installed
  elif systemctl is-active --quiet mailexpert-updater.path 2>/dev/null; then
    echo active
  else
    echo inactive
  fi
}

# updater_problem <updater_state>: a problem when the path unit is installed but not active: the
# panel's "update from the panel" requests would sit in the spool unanswered.
updater_problem() {
  if [ "$1" = inactive ]; then
    echo "updater: mailexpert-updater.path is installed but not active, so update requests from the panel are not served (systemctl enable --now mailexpert-updater.path)"
  fi
  return 0
}
