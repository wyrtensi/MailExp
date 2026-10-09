# shellcheck shell=bash
# install.sh input: flags, <prefix>/install.conf, validation and everything derived from the
# sign-in mode. Pure functions: no Docker, no network, no writes except the file passed in.

# install.conf keys, in the order they are written. --prefix and --no-start are per run.
# INSTALL_ID is no flag: install.sh generates it once (ensure_install_id); every container this
# install starts carries it as the label io.mailexpert.install.
INSTALL_CONF_KEYS=(VERSION SIGNIN CF_HOST DIRECT_HOST ADMIN_EMAILS LOCAL_AUTH EDGE EDGE_TLS
  ACME_EMAIL PROJECT EDGE_PROJECT HTTP_PORT IMAGE_PREFIX REPO_URL SYSTEM INSTALL_ID)
declare -gA INSTALL_ARGS=()
# The edge's compose project name before new installs got mailexpert-edge: an install keeps the
# name its install.conf records.
LEGACY_EDGE_PROJECT=edge

# shellcheck disable=SC2034 # the CFG_* and OPT_* globals are read by install.sh and edge.sh
install_defaults() {
  CFG_VERSION='' CFG_INSTALL_ID='' CFG_SIGNIN='' CFG_CF_HOST='' CFG_DIRECT_HOST='' CFG_ADMIN_EMAILS='' CFG_ACME_EMAIL=''
  CFG_LOCAL_AUTH=0 CFG_EDGE=1 CFG_EDGE_TLS=acme CFG_SYSTEM=1
  CFG_PROJECT=mailexpert CFG_EDGE_PROJECT=mailexpert-edge CFG_HTTP_PORT=8080
  CFG_IMAGE_PREFIX=ghcr.io/wyrtensi CFG_REPO_URL=https://github.com/wyrtensi/MailExpert.git
  OPT_PREFIX=/opt/mailexpert OPT_START=1
}

# flag_key --cf-host -> CF_HOST; --admin-email -> ADMIN_EMAILS
flag_key() {
  local key=${1#--}
  key=${key//-/_}
  key=${key^^}
  if [ "$key" = ADMIN_EMAIL ]; then key=ADMIN_EMAILS; fi
  printf '%s\n' "$key"
}

parse_install_args() {
  INSTALL_ARGS=()
  while [ $# -gt 0 ]; do
    case $1 in
      --version | --signin | --cf-host | --direct-host | --admin-email | --acme-email | --edge-tls | \
        --project | --edge-project | --http-port | --image-prefix | --repo-url | --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ] || [[ $2 == --* ]]; then die "$1 needs a value" 2; fi
        INSTALL_ARGS[$(flag_key "$1")]=$2
        shift 2
        ;;
      --local-auth) INSTALL_ARGS[LOCAL_AUTH]=1 && shift ;;
      --no-edge) INSTALL_ARGS[EDGE]=0 && shift ;;
      --no-system) INSTALL_ARGS[SYSTEM]=0 && shift ;;
      --no-start) INSTALL_ARGS[START]=0 && shift ;;
      -h | --help) INSTALL_ARGS[HELP]=1 && shift ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
}

# resolve_install_config <install.conf>: defaults, then the file, then the flags.
resolve_install_config() {
  local conf=$1 key value
  install_defaults
  for key in "${INSTALL_CONF_KEYS[@]}"; do
    if [ -n "${INSTALL_ARGS[$key]+set}" ]; then
      value=${INSTALL_ARGS[$key]}
    elif ! value=$(env_get "$conf" "$key"); then
      continue
    fi
    printf -v "CFG_$key" '%s' "$value"
  done
  # An install.conf without EDGE_PROJECT predates the mailexpert-edge default: its edge runs as
  # "edge", and the new default would start a second edge next to it.
  if [ -f "$conf" ] && [ -z "${INSTALL_ARGS[EDGE_PROJECT]+set}" ] && ! env_get "$conf" EDGE_PROJECT >/dev/null; then
    CFG_EDGE_PROJECT=$LEGACY_EDGE_PROJECT
  fi
  for key in PREFIX START; do
    if [ -n "${INSTALL_ARGS[$key]+set}" ]; then printf -v "OPT_$key" '%s' "${INSTALL_ARGS[$key]}"; fi
  done
  CFG_CF_HOST=${CFG_CF_HOST,,}
  CFG_DIRECT_HOST=${CFG_DIRECT_HOST,,}
  CFG_ADMIN_EMAILS=${CFG_ADMIN_EMAILS,,}
  CFG_ADMIN_EMAILS=${CFG_ADMIN_EMAILS// /}
  CFG_ACME_EMAIL=${CFG_ACME_EMAIL,,}
}

write_install_conf() {
  local file=$1 key var
  for key in "${INSTALL_CONF_KEYS[@]}"; do
    var=CFG_$key
    env_set "$file" "$key" "${!var}"
  done
}

# validate_install_config: prints every problem, returns 2 if there is any.
validate_install_config() {
  local -a errors=() emails=()
  local email
  [[ $CFG_VERSION =~ ^sha-[0-9a-f]{12}$ ]] ||
    errors+=("--version must be sha-<first 12 hex characters of the commit>")
  case $CFG_SIGNIN in
    cf | direct | both) ;;
    *) errors+=("--signin must be cf, direct or both") ;;
  esac
  if [[ $CFG_SIGNIN == cf || $CFG_SIGNIN == both ]] && ! is_hostname "$CFG_CF_HOST"; then
    errors+=("--cf-host must be a host name such as app.example.com")
  fi
  if [[ $CFG_SIGNIN == direct || $CFG_SIGNIN == both ]] && ! is_hostname "$CFG_DIRECT_HOST"; then
    errors+=("--direct-host must be a host name such as app.example.com")
  fi
  if [ "$CFG_SIGNIN" = both ] && [ -n "$CFG_CF_HOST" ] && [ "$CFG_CF_HOST" = "$CFG_DIRECT_HOST" ]; then
    errors+=("--cf-host and --direct-host must differ")
  fi
  if [ -n "$CFG_ADMIN_EMAILS" ]; then
    IFS=, read -r -a emails <<<"$CFG_ADMIN_EMAILS"
    for email in "${emails[@]}"; do
      is_email "$email" || errors+=("--admin-email: '$email' is not an email address")
    done
  elif [ "$CFG_LOCAL_AUTH" != 1 ]; then
    errors+=("--admin-email is required with Google sign-in: these accounts become the first admins")
  fi
  if [ -n "$CFG_ACME_EMAIL" ] && ! is_email "$CFG_ACME_EMAIL"; then
    errors+=("--acme-email: not an email address")
  fi
  case $CFG_EDGE_TLS in
    acme | internal) ;;
    *) errors+=("--edge-tls must be acme or internal") ;;
  esac
  [[ $CFG_LOCAL_AUTH =~ ^[01]$ && $CFG_EDGE =~ ^[01]$ && $CFG_SYSTEM =~ ^[01]$ ]] ||
    errors+=("install.conf: LOCAL_AUTH, EDGE and SYSTEM must be 0 or 1")
  is_install_id "$CFG_INSTALL_ID" || [ -z "$CFG_INSTALL_ID" ] ||
    errors+=("install.conf: INSTALL_ID must be 16 lowercase hex characters (remove the line and run install.sh for a new one)")
  is_name "$CFG_PROJECT" || errors+=("--project must be lowercase letters, digits, '-' or '_'")
  is_name "$CFG_EDGE_PROJECT" || errors+=("--edge-project must be lowercase letters, digits, '-' or '_'")
  [ "$CFG_PROJECT" != "$CFG_EDGE_PROJECT" ] || errors+=("--project and --edge-project must differ")
  is_port "$CFG_HTTP_PORT" || errors+=("--http-port must be a port from 1024 to 65535")
  [[ $CFG_IMAGE_PREFIX =~ ^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$ ]] || errors+=("--image-prefix is not an image repository prefix")
  if [ -z "$CFG_REPO_URL" ] || ! env_value_ok "$CFG_REPO_URL"; then errors+=("--repo-url is empty or has spaces"); fi
  is_prefix "$OPT_PREFIX" || errors+=("--prefix must be an absolute path without spaces or .. segments")
  if [ "${#errors[@]}" -gt 0 ]; then
    printf '[mailexpert] error: %s\n' "${errors[@]}" >&2
    return 2
  fi
}

# app_settings: the non-secret .env keys install.sh owns, as KEY=VALUE lines. They follow the
# configuration on every run.
app_settings() {
  local url='' alt='' auth=google
  case $CFG_SIGNIN in
    cf) url=https://$CFG_CF_HOST ;;
    direct) url=https://$CFG_DIRECT_HOST ;;
    both) url=https://$CFG_CF_HOST alt=https://$CFG_DIRECT_HOST ;;
  esac
  if [ "$CFG_LOCAL_AUTH" = 1 ]; then auth=local; fi
  printf '%s\n' \
    "MAILEXPERT_VERSION=$CFG_VERSION" \
    "MAILEXPERT_IMAGE_PREFIX=$CFG_IMAGE_PREFIX" \
    "COMPOSE_PROJECT_NAME=$CFG_PROJECT" \
    "APP_HTTP_PORT=$CFG_HTTP_PORT" \
    "APP_URL=$url" \
    "APP_ALT_URLS=$alt" \
    "AUTH_MODE=$auth" \
    "BOOTSTRAP_ADMIN_EMAILS=$CFG_ADMIN_EMAILS" \
    "GOOGLE_REDIRECT_URI=$url/oauth/google/callback" \
    "UPDATE_SPOOL_HOST_DIR=$OPT_PREFIX/state/update-spool" \
    "MAILEXPERT_INSTALL_ID=$CFG_INSTALL_ID"
}

# edge_services: the edge services this install runs, one per line.
edge_services() {
  [ "$CFG_EDGE" = 1 ] || return 0
  case $CFG_SIGNIN in
    direct) echo caddy ;;
    cf) echo cloudflared ;;
    both) printf '%s\n' caddy cloudflared ;;
  esac
}

# edge_profiles: COMPOSE_PROFILES for deploy/edge/compose.yml.
edge_profiles() {
  edge_services | sed 's/^cloudflared$/tunnel/' | paste -sd, -
}

# required_owner_secrets: "<app|edge> <KEY>" lines that configure.sh must provide.
required_owner_secrets() {
  local caddy=0 tunnel=0
  if [ "$CFG_EDGE" = 1 ]; then
    case $CFG_SIGNIN in
      direct) caddy=1 ;;
      cf) tunnel=1 ;;
      both) caddy=1 tunnel=1 ;;
    esac
  fi
  if [ "$tunnel" = 1 ]; then echo "edge TUNNEL_TOKEN"; fi
  if [ "$caddy" = 1 ] && [ "$CFG_EDGE_TLS" = acme ]; then echo "edge DNS_API_TOKEN"; fi
  if [ "$CFG_LOCAL_AUTH" != 1 ]; then
    if [[ $CFG_SIGNIN == cf || $CFG_SIGNIN == both ]]; then
      printf '%s\n' "app CF_ACCESS_ISSUER" "app CF_ACCESS_AUDIENCE"
    fi
    if [[ $CFG_SIGNIN == direct || $CFG_SIGNIN == both ]]; then
      printf '%s\n' "app AUTH_GOOGLE_CLIENT_ID" "app AUTH_GOOGLE_CLIENT_SECRET"
    fi
  fi
  return 0
}

# ssh_ports <listening SSH ports> <ports from `sshd -T`> <$SSH_CONNECTION>: 22, the ports an SSH
# daemon listens on, the configured sshd ports and the server port of the current SSH session.
# Enabling ufw without them locks the owner out.
ssh_ports() {
  {
    echo 22
    tr -s ' \t' '\n' <<<"$1"
    tr -s ' \t' '\n' <<<"$2"
    if [ -n "$3" ]; then echo "${3##* }"; fi
  } | grep -E '^[0-9]{1,5}$' | sort -nu
}

# ss_ssh_ports: reads `ss -ltnpH` on stdin and prints each port a process named sshd listens on
# (also when it shares the socket with systemd).
ss_ssh_ports() {
  local laddr rest
  while read -r _ _ _ laddr _ rest; do
    [[ $rest == *'("sshd",'* ]] || continue
    printf '%s\n' "${laddr##*:}"
  done | grep -E '^[0-9]{1,5}$' | sort -nu || true
}

# socket_listen_ports: reads the Listen property of ssh.socket (`systemctl show -p Listen`, with
# or without --value) on stdin and prints its TCP ports. Unix sockets are skipped.
socket_listen_ports() {
  grep -oE '[^[:space:]=]+ \(Stream\)' | sed -E 's/ \(Stream\)$//; s/.*://' |
    grep -E '^[0-9]{1,5}$' | sort -nu || true
}

# ufw_enable_safe <ufw active 0|1> <listening SSH ports> <allowed SSH port...>: status 0 when
# ufw may be enabled: it is active already, or one of the allowed ports has an SSH listener.
ufw_enable_safe() {
  local active=$1 listening=$2 port
  shift 2
  [ "$active" = 1 ] && return 0
  for port in "$@"; do
    grep -qx "$port" <<<"$listening" && return 0
  done
  return 1
}

# ufw_rules_cover_port <port>: reads `ufw status` and/or `ufw show added` on stdin; status 0 when
# any rule names the port, alone, in a list or in a range (the OpenSSH profile counts as 22).
ufw_rules_cover_port() {
  local port=$1 line token item
  local -a tokens
  while read -r line; do
    case $line in 'Status:'* | 'Added user rules'* | 'To '* | '--'*) continue ;; esac
    read -r -a tokens <<<"$line"
    for token in "${tokens[@]}"; do
      [ "$token" = OpenSSH ] && token=22
      token=${token%/tcp}
      token=${token%/udp}
      [[ $token =~ ^[0-9:,]+$ ]] || continue
      for item in ${token//,/ }; do
        if [[ $item =~ ^([0-9]{1,5}):([0-9]{1,5})$ ]]; then
          ((10#${BASH_REMATCH[1]} <= port && port <= 10#${BASH_REMATCH[2]})) && return 0
        elif [[ $item =~ ^[0-9]{1,5}$ ]]; then
          ((10#$item == port)) && return 0
        fi
      done
    done
  done
  return 1
}

# ufw_allowed_ports <ssh port...>: inbound ufw rules, one per line.
ufw_allowed_ports() {
  local port
  for port in "$@"; do printf '%s/tcp\n' "$port"; done
  if edge_services | grep -qx caddy; then printf '%s\n' 80/tcp 443/tcp 443/udp; fi
}

# port_conflicts <own caddy running: 0|1> <port...>: reads `ss -ltnpH` on stdin and prints
# "<port> <process>" for each listed port held by anything but the edge's own caddy. A process
# named caddy counts as this install's only while the edge project's caddy container runs (it uses
# the host network, so ss shows the process itself); otherwise any caddy (installed on the host,
# another project's, or this install's edge under an earlier --edge-project) is a conflict.
port_conflicts() {
  local own=$1 want laddr rest port proc
  shift
  want=" $* "
  while read -r _ _ _ laddr _ rest; do
    port=${laddr##*:}
    case $want in
      *" $port "*) ;;
      *) continue ;;
    esac
    proc=$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$rest")
    if [ "$proc" = caddy ] && [ "$own" = 1 ]; then continue; fi
    printf '%s %s\n' "$port" "${proc:-unknown}"
  done
}

# loopback_port_holders <port>: reads `ss -ltnpH` on stdin and prints "<port> <process>" for each
# listener that a bind of 127.0.0.1:<port> collides with: on 127.0.0.1 itself or on every address.
loopback_port_holders() {
  local laddr rest proc
  while read -r _ _ _ laddr _ rest; do
    [ "${laddr##*:}" = "$1" ] || continue
    case ${laddr%:*} in
      127.0.0.1 | 0.0.0.0 | '*' | '[::]' | '[::ffff:127.0.0.1]') ;;
      *) continue ;;
    esac
    proc=$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$rest")
    printf '%s %s\n' "$1" "${proc:-unknown}"
  done
}

# is_prefixed_name <compose project>: status 0 for mailexpert, mailexpert-* and mailexpert_*.
is_prefixed_name() {
  [[ $1 == mailexpert || $1 == mailexpert-* || $1 == mailexpert_* ]]
}

# generic_name_notes: one line per compose project name of this install without the mailexpert
# prefix, which a neighbouring project on a shared host could also use, with how to move. Nothing
# moves by itself: install.conf keeps the name an install started with.
generic_name_notes() {
  local doc='docs/operations/deployment.md, "Имена на общем сервере"'
  if ! is_prefixed_name "$CFG_PROJECT"; then
    echo "names: the panel's compose project '$CFG_PROJECT' has no mailexpert prefix; it holds the database (volume ${CFG_PROJECT}_postgres_data), so it stays; a move is a backup restored into an install with another --project ($doc)"
  fi
  if [ "$CFG_EDGE" = 1 ] && ! is_prefixed_name "$CFG_EDGE_PROJECT"; then
    echo "names: the edge's compose project '$CFG_EDGE_PROJECT' has no mailexpert prefix (new installs use mailexpert-edge); to move: $(edge_move_steps)"
  fi
  return 0
}

# edge_move_steps: how this install's edge moves to the project mailexpert-edge. Only this install's
# containers go, selected by project and working directory: `docker compose -p <name> down` would
# also remove a neighbour's containers of the same project name. The volumes stay until removed by
# hand once the new Caddy has its certificates.
edge_move_steps() {
  printf '%s\n' "docker ps -aq --filter label=com.docker.compose.project=$CFG_EDGE_PROJECT --filter label=com.docker.compose.project.working_dir=$(clean_path "$OPT_PREFIX/edge") | xargs -r docker rm -f, then install.sh --prefix $OPT_PREFIX --edge-project mailexpert-edge; Caddy gets its certificates again (docs/operations/deployment.md, \"Имена на общем сервере\")"
}

# resource_shortfalls <cpus> <MemTotal kB> <free disk kB>: one line per shortfall. A "4 GB"
# server reports about 3.8-3.9 GB of MemTotal, hence the 3800 MB floor.
resource_shortfalls() {
  if [ "$1" -lt 2 ]; then echo "CPU: $1, at least 2 are needed"; fi
  if [ "$2" -lt $((3800 * 1024)) ]; then echo "memory: $(($2 / 1024)) MB, at least 4 GB is needed"; fi
  if [ "$3" -lt $((20 * 1024 * 1024)) ]; then echo "free disk: $(($3 / 1024 / 1024)) GB, at least 20 GB is needed"; fi
  return 0
}

# version_matches <sha-XXXXXXXXXXXX> <full sha from /api/version>
version_matches() {
  [[ $1 =~ ^sha-[0-9a-f]{12}$ ]] && [ "${2:0:12}" = "${1#sha-}" ]
}

# render_unit <template> <prefix>: a systemd unit with @PREFIX@ replaced.
render_unit() {
  local text
  text=$(<"$1")
  printf '%s\n' "${text//@PREFIX@/"$2"}"
}

# unit_name <updater|backup|health> <path|service|timer>: the name of a panel unit on this host.
# The default project keeps the names it always had (mailexpert-updater.path); any other project
# gets its name as a suffix (mailexpert-updater-<project>.path), so two panels on one host keep
# their own units. A suffix, not a prefix: mail node hosts already have mailexpert-node-agent and
# mailexpert-node-backup, which a prefix would collide with for a project called "node".
unit_name() {
  local project=${CFG_PROJECT:-mailexpert}
  if [ "$project" = mailexpert ]; then
    printf 'mailexpert-%s.%s\n' "$1" "$2"
  else
    printf 'mailexpert-%s-%s.%s\n' "$1" "$project" "$2"
  fi
}

# render_project_unit <template> <prefix>: render_unit, and the names of the panel's units inside
# it (Unit= of mailexpert-updater.path, the hints in comments) follow unit_name.
render_project_unit() {
  local text name kind
  text=$(render_unit "$1" "$2")
  if [ "${CFG_PROJECT:-mailexpert}" != mailexpert ]; then
    for name in updater backup health; do
      for kind in path service timer; do
        text=${text//"mailexpert-$name.$kind"/"$(unit_name "$name" "$kind")"}
      done
    done
  fi
  printf '%s\n' "$text"
}

# has_systemd: status 0 when systemd runs this host (the standard check: /run/systemd/system) and
# systemctl is there. MAILEXPERT_SYSTEMD=1 or 0 overrides the check (the tests).
has_systemd() {
  case ${MAILEXPERT_SYSTEMD:-} in
    1) return 0 ;;
    0) return 1 ;;
  esac
  [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1
}

# systemd_flag: 1 when has_systemd, else 0.
systemd_flag() {
  if has_systemd; then echo 1; else echo 0; fi
}

# unit_runs_prefix <unit file> <prefix>: status 0 when the unit file serves the install at <prefix>:
# its ExecStart runs a script of <prefix>/app with --prefix <prefix>, or it watches <prefix>'s
# spool. /opt/mailexpert never matches a unit of /opt/mailexpert2.
unit_runs_prefix() {
  local line
  [ -f "$1" ] || return 1
  while IFS= read -r line; do
    case $line in
      "ExecStart=$2/app/"*" --prefix $2" | "PathExistsGlob=$2/state/"*) return 0 ;;
    esac
  done <"$1"
  return 1
}
