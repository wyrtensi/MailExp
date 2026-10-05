# shellcheck shell=bash
# KEY=VALUE files: <prefix>/.env, <prefix>/edge/.env and <prefix>/install.conf. They are parsed,
# never sourced. A value is one token (no whitespace, quotes, '$', '#' or backslash), so docker
# compose reads it verbatim.

# Generated on the host, written once, never replaced: ENCRYPTION_KEY decrypts stored mailbox
# credentials, DB_PASSWORD is baked into the PostgreSQL volume, the VAPID pair backs every push
# subscription, SESSION_SECRET signs sessions.
# shellcheck disable=SC2034 # read by install.sh and tests
GENERATED_SECRET_KEYS=(SESSION_SECRET ENCRYPTION_KEY DB_PASSWORD VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY)

# Owner secrets that configure.sh stores, replaced when given again (rotation). Backups go to any
# S3-compatible storage the owner picks: the repository URL and the access keys are all it takes.
# shellcheck disable=SC2034 # read by configure.sh, restore.sh and tests
APP_OWNER_KEYS=(CF_ACCESS_ISSUER CF_ACCESS_AUDIENCE AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET
  HEALTHCHECK_PING_URL BACKUP_PING_URL RESTIC_REPOSITORY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  AWS_DEFAULT_REGION)
# shellcheck disable=SC2034
EDGE_OWNER_KEYS=(TUNNEL_TOKEN DNS_API_TOKEN)
# The tenant worker (profile "tenant"), written into .env by hand (docs/operations/mail-node.md,
# section 6e); restore.sh brings them back from a snapshot. The PFX and its password file
# they point to are not in the snapshot.
# shellcheck disable=SC2034 # read by restore.sh and tests
TENANT_KEYS=(COMPOSE_PROFILES TENANT_WORKER_URL TENANT_WORKER_TOKEN TENANT_CERT_DIR TENANT_PFX_PASSWORD_FILE
  TENANT_ID TENANT_APP_ID TENANT_ORGANIZATION)
# Written once and never replaced by configure.sh: the generated keys, and RESTIC_PASSWORD, which
# a replacement would not change in the repository, only lock this server out of it.
# shellcheck disable=SC2034
WRITE_ONCE_KEYS=("${GENERATED_SECRET_KEYS[@]}" RESTIC_PASSWORD)

env_value_ok() {
  case $1 in
    *[[:space:]]* | *[\'\"\$\#\\]*) return 1 ;;
  esac
  return 0
}

# env_get <file> <key>: prints the value; status 1 when the file or the key is absent. A key that
# appears more than once resolves like a shell or `docker compose --env-file` would read it: the
# last line wins.
env_get() {
  local file=$1 key=$2 line value found=0
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "$key="*)
        value=${line#"$key="}
        found=1
        ;;
    esac
  done <"$file"
  [ "$found" = 1 ] || return 1
  printf '%s\n' "$value"
}

# env_set <file> <key> <value>: adds or replaces one key, other lines stay as they are. The file
# is replaced atomically and keeps mode 0600.
env_set() {
  local file=$1 key=$2 value=$3 tmp line found=0 current
  env_value_ok "$value" || die "$key: the value must be one token without spaces, quotes, \$, # or backslash"
  if current=$(env_get "$file" "$key") && [ "$current" = "$value" ]; then
    return 0
  fi
  tmp=$(mktemp "$file.XXXXXX") || die "cannot write next to $file"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        "$key="*)
          if [ "$found" = 0 ]; then
            printf '%s=%s\n' "$key" "$value"
            found=1
          fi
          ;;
        *) printf '%s\n' "$line" ;;
      esac
    done <"$file" >"$tmp"
  fi
  if [ "$found" = 0 ]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  mv -f "$tmp" "$file"
}

# env_ensure_secret <file> <key> <value>: writes only an absent or empty key. The same value is
# a no-op; a different value returns 2 and leaves the file untouched.
env_ensure_secret() {
  local file=$1 key=$2 value=$3 current
  current=$(env_get "$file" "$key") || current=
  if [ -z "$current" ]; then
    env_set "$file" "$key" "$value"
    return 0
  fi
  [ "$current" = "$value" ] && return 0
  log "$key already has a different value in $file; generated secrets are never replaced"
  return 2
}

# env_fill_missing <file> <key> <generator...>: runs the generator only for an absent or empty
# key and stores its output.
env_fill_missing() {
  local file=$1 key=$2 current value
  shift 2
  current=$(env_get "$file" "$key") || current=
  [ -z "$current" ] || return 0
  value=$("$@") || die "could not generate $key"
  [ -n "$value" ] || die "could not generate $key"
  env_set "$file" "$key" "$value"
  log "generated $key"
}

# env_missing <file> <key...>: prints each key that is absent or empty.
env_missing() {
  local file=$1 key value
  shift
  for key in "$@"; do
    value=$(env_get "$file" "$key") || value=
    [ -n "$value" ] || printf '%s\n' "$key"
  done
}

# gen_vapid_pair: "<public> <private>" from web-push inside the backend image ($BACKEND_IMAGE),
# without network access. Tests replace this function.
gen_vapid_pair() {
  docker run --rm --network none --entrypoint node "$BACKEND_IMAGE" -e \
    "const k = require('web-push').generateVAPIDKeys(); console.log(k.publicKey + ' ' + k.privateKey)"
}

# ensure_vapid <file>: generates the pair when both keys are missing. One key without the other
# is an error: half a pair is restored from a backup, never regenerated.
ensure_vapid() {
  local file=$1 pub priv pair
  pub=$(env_get "$file" VAPID_PUBLIC_KEY) || pub=
  priv=$(env_get "$file" VAPID_PRIVATE_KEY) || priv=
  if [ -n "$pub" ] && [ -n "$priv" ]; then return 0; fi
  if [ -n "$pub" ] || [ -n "$priv" ]; then
    die "$file has only one of VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; restore the pair from a backup"
  fi
  pair=$(gen_vapid_pair) || die "could not generate VAPID keys"
  read -r pub priv <<<"$pair"
  if [ -z "$pub" ] || [ -z "$priv" ]; then die "could not generate VAPID keys"; fi
  env_set "$file" VAPID_PUBLIC_KEY "$pub"
  env_set "$file" VAPID_PRIVATE_KEY "$priv"
  log "generated VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY"
}

# generate_app_secrets <file>: every generated secret that is still missing.
generate_app_secrets() {
  local file=$1
  env_fill_missing "$file" SESSION_SECRET gen_hex 32
  env_fill_missing "$file" ENCRYPTION_KEY gen_hex 32
  env_fill_missing "$file" DB_PASSWORD gen_hex 24
  ensure_vapid "$file"
}
