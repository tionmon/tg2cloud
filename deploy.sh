#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

APP_NAME="tg2cloud"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DOMAIN="${DOMAIN:-}"
SKIP_SYSTEM_UPDATE=0
SKIP_FIREWALL=0
PUBLIC_PORT=""
GENERATED_ADMIN_USERNAME=""
GENERATED_ADMIN_PASSWORD=""

log() {
  printf '\033[1;32m[%s]\033[0m %s\n' "$APP_NAME" "$*"
}

warn() {
  printf '\033[1;33m[%s]\033[0m %s\n' "$APP_NAME" "$*" >&2
}

die() {
  printf '\033[1;31m[%s]\033[0m %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
tg2cloud one-click deployment

Usage:
  sudo bash ./deploy.sh --domain files.example.com
  sudo bash ./deploy.sh --domain http://SERVER_IP

Options:
  --domain <domain-or-URL>   Caddy site address; bare domains use automatic HTTPS
  --skip-system-update       Skip the operating-system package upgrade
  --skip-firewall            Do not open HTTP/HTTPS firewall ports
  -h, --help                 Show this help

The DOMAIN environment variable is also supported.
EOF
}

while (($# > 0)); do
  case "$1" in
    --domain)
      (($# >= 2)) || die "--domain requires a value"
      DOMAIN="$2"
      shift 2
      ;;
    --skip-system-update)
      SKIP_SYSTEM_UPDATE=1
      shift
      ;;
    --skip-firewall)
      SKIP_FIREWALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (use --help)"
      ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || die "This script supports Linux servers only"
[[ "${EUID}" -eq 0 ]] || die "Run as root, for example: sudo bash ./deploy.sh --domain files.example.com"
[[ -f /etc/os-release ]] || die "Cannot detect the operating system: /etc/os-release is missing"
[[ -f "$SCRIPT_DIR/docker-compose.yml" ]] || die "Run this script from the tg2cloud project directory"
[[ -f "$SCRIPT_DIR/.env.example" ]] || die "Missing required file: $SCRIPT_DIR/.env.example"

if [[ -z "$DOMAIN" ]]; then
  [[ -t 0 ]] || die "Provide a domain with --domain or the DOMAIN environment variable"
  read -r -p "Domain (files.example.com), or http://IP for HTTP-only deployment: " DOMAIN
fi

DOMAIN="${DOMAIN%/}"
if [[ ! "$DOMAIN" =~ ^(https?://)?[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || [[ "$DOMAIN" == *..* ]]; then
  die "Invalid domain; use files.example.com or http://192.0.2.10"
fi
if [[ "$DOMAIN" =~ :([0-9]{1,5})$ ]]; then
  PUBLIC_PORT="${BASH_REMATCH[1]}"
  ((PUBLIC_PORT >= 1 && PUBLIC_PORT <= 65535)) || die "Invalid port: $PUBLIC_PORT"
fi

if [[ "$DOMAIN" == http://* || "$DOMAIN" == https://* ]]; then
  CADDY_SITE="$DOMAIN"
  PUBLIC_URL="$DOMAIN"
else
  CADDY_SITE="$DOMAIN"
  PUBLIC_URL="https://$DOMAIN"
fi

# shellcheck disable=SC1091
source /etc/os-release
OS_ID="${ID:-unknown}"
case "$OS_ID" in
  debian|ubuntu)
    PACKAGE_FAMILY="apt"
    ;;
  fedora|rhel|centos|rocky|almalinux)
    PACKAGE_FAMILY="dnf"
    ;;
  *)
    die "Unsupported distribution: ${PRETTY_NAME:-$OS_ID}. Supported: Debian/Ubuntu and Fedora/RHEL/CentOS/Rocky/AlmaLinux."
    ;;
esac

log "Detected system: ${PRETTY_NAME:-$OS_ID}"
log "Deployment URL: $PUBLIC_URL"

install_base_packages() {
  if [[ "$PACKAGE_FAMILY" == "apt" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    if ((SKIP_SYSTEM_UPDATE == 0)); then
      log "Upgrading system packages (autoremove will not be run)"
      apt-get upgrade -y
    fi
    apt-get install -y ca-certificates curl gnupg git
  else
    if ((SKIP_SYSTEM_UPDATE == 0)); then
      log "Upgrading system packages"
      dnf -y upgrade --refresh
    fi
    dnf -y install ca-certificates curl git
    if [[ "$OS_ID" == "fedora" ]]; then
      dnf -y install dnf5-plugins || dnf -y install dnf-plugins-core
    else
      dnf -y install dnf-plugins-core
    fi
  fi
}

configure_docker_apt_repo() {
  local docker_os="$OS_ID"
  local codename="${VERSION_CODENAME:-}"
  local keyring="/etc/apt/keyrings/docker.asc"
  local source_file="/etc/apt/sources.list.d/docker.sources"

  [[ -n "$codename" ]] || die "Cannot safely configure Docker: distribution codename is missing"
  install -m 0755 -d /etc/apt/keyrings

  if [[ ! -s "$keyring" ]]; then
    log "Adding the official Docker signing key"
    curl -fsSL "https://download.docker.com/linux/$docker_os/gpg" -o "$keyring"
    chmod a+r "$keyring"
  else
    log "Preserving existing Docker signing key: $keyring"
  fi

  if [[ ! -e "$source_file" ]]; then
    log "Adding the official Docker repository"
    local tmp_source
    tmp_source="$(mktemp)"
    cat >"$tmp_source" <<EOF
Types: deb
URIs: https://download.docker.com/linux/$docker_os
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: $keyring
EOF
    install -m 0644 "$tmp_source" "$source_file"
    rm -f "$tmp_source"
  else
    log "Preserving existing Docker repository: $source_file"
  fi
  apt-get update
}

configure_docker_dnf_repo() {
  local docker_os="$OS_ID"
  local repo_file="/etc/yum.repos.d/docker-ce.repo"

  case "$OS_ID" in
    rocky|almalinux) docker_os="centos" ;;
  esac

  if [[ ! -e "$repo_file" ]]; then
    log "Adding the official Docker repository"
    local tmp_repo
    tmp_repo="$(mktemp)"
    curl -fsSL "https://download.docker.com/linux/$docker_os/docker-ce.repo" -o "$tmp_repo"
    install -m 0644 "$tmp_repo" "$repo_file"
    rm -f "$tmp_repo"
  else
    log "Preserving existing Docker repository: $repo_file"
  fi
}

install_docker() {
  local need_engine=0
  local need_compose=0
  command -v docker >/dev/null 2>&1 || need_engine=1
  docker compose version >/dev/null 2>&1 || need_compose=1

  if ((need_engine == 0 && need_compose == 0)); then
    log "Docker Engine and Compose are already installed"
  elif [[ "$PACKAGE_FAMILY" == "apt" ]]; then
    configure_docker_apt_repo
    if ((need_engine == 1)); then
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
      apt-get install -y docker-compose-plugin
    fi
  else
    configure_docker_dnf_repo
    if ((need_engine == 1)); then
      dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
      dnf -y install docker-compose-plugin
    fi
  fi

  systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose is unavailable after installation"
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    log "Caddy is already installed; preserving it"
    return
  fi

  if [[ "$PACKAGE_FAMILY" == "apt" ]]; then
    local keyring="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    local source_file="/etc/apt/sources.list.d/caddy-stable.list"
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl

    if [[ ! -s "$keyring" ]]; then
      local armored_key binary_key
      armored_key="$(mktemp)"
      binary_key="$(mktemp)"
      curl -1fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" -o "$armored_key"
      gpg --dearmor --batch --yes --output "$binary_key" "$armored_key"
      install -m 0644 "$binary_key" "$keyring"
      rm -f "$armored_key" "$binary_key"
    else
      log "Preserving existing Caddy signing key: $keyring"
    fi

    if [[ ! -e "$source_file" ]]; then
      local tmp_source
      tmp_source="$(mktemp)"
      curl -1fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" -o "$tmp_source"
      install -m 0644 "$tmp_source" "$source_file"
      rm -f "$tmp_source"
    else
      log "Preserving existing Caddy repository: $source_file"
    fi
    apt-get update
    apt-get install -y caddy
  else
    log "Enabling the official Caddy COPR repository"
    dnf -y copr enable @caddy/caddy
    dnf -y install caddy
  fi
}

update_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp "$SCRIPT_DIR/.env.tmp.XXXXXX")"

  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      if (!replaced) print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$env_file" >"$tmp_file"

  chmod --reference="$env_file" "$tmp_file"
  chown --reference="$env_file" "$tmp_file"
  mv -f "$tmp_file" "$env_file"
}

read_env_value() {
  local env_file="$1"
  local key="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "$env_file"
}

generate_hex() {
  local bytes="$1"
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d '[:space:]'
}

backup_and_update_env() {
  local env_file="$SCRIPT_DIR/.env"
  local timestamp backup_file
  local created=0
  local admin_username admin_password auth_secret
  local cookie_secure="false"
  timestamp="$(date +%Y%m%d-%H%M%S-%N)"
  [[ "$PUBLIC_URL" == https://* ]] && cookie_secure="true"

  [[ ! -L "$env_file" ]] || die "Refusing to replace a symlinked .env file"

  if [[ ! -e "$env_file" ]]; then
    install -m 0600 "$SCRIPT_DIR/.env.example" "$env_file"
    created=1
    log "Created .env from .env.example"
  fi

  admin_username="$(read_env_value "$env_file" "ADMIN_USERNAME")"
  admin_password="$(read_env_value "$env_file" "ADMIN_PASSWORD")"
  auth_secret="$(read_env_value "$env_file" "AUTH_SECRET")"

  if [[ -n "$admin_password" && "$admin_password" != "change-this-password" && ${#admin_password} -lt 12 ]]; then
    die "Existing ADMIN_PASSWORD must contain at least 12 characters"
  fi
  if [[ -n "$auth_secret" && "$auth_secret" != "replace-with-a-random-secret-at-least-32-characters" && ${#auth_secret} -lt 32 ]]; then
    die "Existing AUTH_SECRET must contain at least 32 characters"
  fi

  if grep -Fqx "PORT=51947" "$env_file" \
    && grep -Fqx "PUBLIC_API_URL=$PUBLIC_URL" "$env_file" \
    && grep -Fqx "CORS_ORIGIN=$PUBLIC_URL" "$env_file" \
    && grep -Fqx "DATA_DIR=./data" "$env_file" \
    && grep -Fqx "VITE_API_URL=$PUBLIC_URL" "$env_file" \
    && grep -Fqx "AUTH_COOKIE_SECURE=$cookie_secure" "$env_file" \
    && grep -Fqx "TRUST_PROXY_HOPS=1" "$env_file" \
    && [[ -n "$admin_username" ]] \
    && [[ "$admin_password" != "change-this-password" && ${#admin_password} -ge 12 ]] \
    && [[ "$auth_secret" != "replace-with-a-random-secret-at-least-32-characters" && ${#auth_secret} -ge 32 ]]; then
    chmod 0600 "$env_file"
    log ".env deployment settings are already current"
    return
  fi

  if ((created == 0)); then
    backup_file="$SCRIPT_DIR/.env.deploy-backup.$timestamp"
    cp -a "$env_file" "$backup_file"
    log "Backed up the existing .env: $backup_file"
  fi

  update_env_value "$env_file" "PORT" "51947"
  update_env_value "$env_file" "PUBLIC_API_URL" "$PUBLIC_URL"
  update_env_value "$env_file" "CORS_ORIGIN" "$PUBLIC_URL"
  update_env_value "$env_file" "DATA_DIR" "./data"
  update_env_value "$env_file" "VITE_API_URL" "$PUBLIC_URL"
  update_env_value "$env_file" "AUTH_COOKIE_SECURE" "$cookie_secure"
  update_env_value "$env_file" "TRUST_PROXY_HOPS" "1"

  if [[ -z "$admin_username" ]]; then
    admin_username="admin"
    update_env_value "$env_file" "ADMIN_USERNAME" "$admin_username"
  fi
  if [[ -z "$admin_password" || "$admin_password" == "change-this-password" ]]; then
    admin_password="$(generate_hex 24)"
    update_env_value "$env_file" "ADMIN_PASSWORD" "$admin_password"
    GENERATED_ADMIN_USERNAME="$admin_username"
    GENERATED_ADMIN_PASSWORD="$admin_password"
  fi
  if [[ -z "$auth_secret" || "$auth_secret" == "replace-with-a-random-secret-at-least-32-characters" ]]; then
    update_env_value "$env_file" "AUTH_SECRET" "$(generate_hex 32)"
  fi
  chmod 0600 "$env_file"
}

start_application() {
  log "Building and starting tg2cloud containers"
  cd "$SCRIPT_DIR"
  docker compose config --quiet
  docker compose up -d --build

  log "Waiting for the backend health check"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 3 http://127.0.0.1:51947/health >/dev/null; then
      log "Backend is ready"
      return
    fi
    sleep 2
  done

  docker compose ps
  die "Backend health check timed out; run: docker compose logs backend"
}

rollback_caddy() {
  local caddyfile="$1"
  local main_backup="$2"
  local main_changed="$3"
  local site_file="$4"
  local site_backup="$5"
  local site_existed="$6"
  local site_changed="$7"

  set +e
  if ((main_changed == 1)); then
    cp -a "$main_backup" "$caddyfile"
  fi
  if ((site_changed == 1)); then
    if ((site_existed == 1)); then
      cp -a "$site_backup" "$site_file"
    else
      rm -f "$site_file"
    fi
  fi
  set -e
}

configure_caddy() {
  local caddyfile="/etc/caddy/Caddyfile"
  local sites_dir="/etc/caddy/sites"
  local site_file="$sites_dir/tg2cloud.caddy"
  local backup_dir="/etc/caddy/backups/tg2cloud"
  local timestamp main_backup site_backup tmp_site
  local main_changed=0
  local site_existed=0
  local site_changed=0
  local caddy_was_active=0
  local caddy_was_enabled=0
  timestamp="$(date +%Y%m%d-%H%M%S-%N)"
  main_backup="$backup_dir/Caddyfile.$timestamp"
  site_backup="$backup_dir/tg2cloud.caddy.$timestamp"

  install -d -m 0755 "$sites_dir" "$backup_dir"
  if [[ ! -e "$caddyfile" ]]; then
    install -m 0644 /dev/null "$caddyfile"
  fi

  if [[ -s "$caddyfile" ]]; then
    caddy validate --config "$caddyfile" --adapter caddyfile \
      || die "The existing Caddyfile is invalid; it was not modified: $caddyfile"
  fi

  tmp_site="$(mktemp "$sites_dir/.tg2cloud.caddy.XXXXXX")"
  cat >"$tmp_site" <<EOF
# Managed by tg2cloud deploy.sh. Manual changes are backed up before replacement.
$CADDY_SITE {
    encode zstd gzip

    @tg2cloud_backend path /api/* /health
    reverse_proxy @tg2cloud_backend 127.0.0.1:51947
    reverse_proxy 127.0.0.1:47832
}
EOF
  chmod 0644 "$tmp_site"

  if [[ -e "$site_file" ]]; then
    site_existed=1
    if cmp -s "$tmp_site" "$site_file"; then
      rm -f "$tmp_site"
      log "Caddy site configuration is unchanged"
    else
      cp -a "$site_file" "$site_backup"
      mv -f "$tmp_site" "$site_file"
      site_changed=1
      log "Backed up the existing tg2cloud site config: $site_backup"
    fi
  else
    mv -f "$tmp_site" "$site_file"
    site_changed=1
  fi

  if ! grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/sites/tg2cloud\.caddy([[:space:]]|$)' "$caddyfile"; then
    cp -a "$caddyfile" "$main_backup"
    main_changed=1
    {
      printf '\n# Added by tg2cloud deploy.sh; site configs remain in separate files.\n'
      printf 'import /etc/caddy/sites/tg2cloud.caddy\n'
    } >>"$caddyfile"
    log "Appended only an import to Caddyfile; backup: $main_backup"
  else
    log "Caddyfile already imports the sites directory; main file unchanged"
  fi

  if ! caddy validate --config "$caddyfile" --adapter caddyfile; then
    rollback_caddy "$caddyfile" "$main_backup" "$main_changed" "$site_file" "$site_backup" "$site_existed" "$site_changed"
    die "New Caddy configuration is invalid; restored the previous configuration"
  fi

  if systemctl is-enabled --quiet caddy; then
    caddy_was_enabled=1
  fi
  if systemctl is-active --quiet caddy; then
    caddy_was_active=1
    if ! systemctl reload caddy; then
      rollback_caddy "$caddyfile" "$main_backup" "$main_changed" "$site_file" "$site_backup" "$site_existed" "$site_changed"
      systemctl reload caddy || true
      die "Caddy reload failed; restored the previous configuration"
    fi
  elif ! systemctl enable --now caddy; then
    rollback_caddy "$caddyfile" "$main_backup" "$main_changed" "$site_file" "$site_backup" "$site_existed" "$site_changed"
    if ((caddy_was_enabled == 0)); then
      systemctl disable caddy >/dev/null 2>&1 || true
    fi
    die "Caddy failed to start; restored the previous configuration"
  fi

  if ((caddy_was_active == 1)); then
    systemctl enable caddy >/dev/null
  fi
  log "Caddy configuration validated and loaded"
}

configure_firewall() {
  if ((SKIP_FIREWALL == 1)); then
    warn "Firewall changes skipped; ensure TCP 80/443 are reachable"
    return
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    log "Allowing HTTP/HTTPS through UFW"
    ufw allow 80/tcp
    ufw allow 443/tcp
    [[ -z "$PUBLIC_PORT" || "$PUBLIC_PORT" == "80" || "$PUBLIC_PORT" == "443" ]] \
      || ufw allow "$PUBLIC_PORT/tcp"
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    log "Allowing HTTP/HTTPS through firewalld"
    firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --add-service=https
    if [[ -n "$PUBLIC_PORT" && "$PUBLIC_PORT" != "80" && "$PUBLIC_PORT" != "443" ]]; then
      firewall-cmd --permanent --add-port="$PUBLIC_PORT/tcp"
    fi
    firewall-cmd --reload
  fi
}

install_base_packages
install_docker
install_caddy
backup_and_update_env
start_application
configure_caddy
configure_firewall

log "Deployment complete: $PUBLIC_URL"
log "Dropbox Redirect URI: $PUBLIC_URL/api/storage/dropbox/callback"
log "Google Redirect URI: $PUBLIC_URL/api/storage/google/callback"
log "Caddy backup directory: /etc/caddy/backups/tg2cloud"
if [[ -n "$GENERATED_ADMIN_PASSWORD" ]]; then
  warn "Generated admin credentials (save them now): $GENERATED_ADMIN_USERNAME / $GENERATED_ADMIN_PASSWORD"
  warn "The credentials are also stored in $SCRIPT_DIR/.env with mode 0600"
fi
