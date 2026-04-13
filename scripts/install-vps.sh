#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Agent-OS  ·  VPS setup and configuration
#
# Called directly or via bootstrap.sh. Supports two modes:
#
# Interactive (prompts for everything):
#   bash scripts/install-vps.sh
#
# Non-interactive (via env vars — no prompts):
#   AGENT_OS_ADD_DOMAIN=yes \
#   AGENT_OS_DOMAIN=example.com \
#   AGENT_OS_ADMIN_USER=admin \
#   AGENT_OS_ADMIN_PASS=supersecretpassword \
#   TELEGRAM_BOT_TOKEN=123456:ABC-DEF... \
#     bash scripts/install-vps.sh
#
# Optional env vars:
#   AGENT_OS_ADD_DOMAIN   Enable domain + Caddy (default: prompt)
#   TELEGRAM_BOT_TOKEN   Telegram bot token (default: none)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.vps"
SYSTEMD_UNIT_PATH="/etc/systemd/system/agent-os.service"
CADDY_ROOT="/srv/agent-os/caddy"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer targets a Linux VPS." >&2
  exit 1
fi

if command -v sudo >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

# ── Reopen stdin from terminal when piped (e.g. curl | bash) ────────
if [[ ! -t 0 ]] && [[ -e /dev/tty ]]; then
  exec 0</dev/tty
fi

# ── Input helpers ────────────────────────────────────────────────────

prompt_nonempty() {
  local prompt="$1"
  local value=""

  while [[ -z "${value}" ]]; do
    read -r -p "${prompt}: " value
  done

  printf '%s' "${value}"
}

normalize_yes_no() {
  local raw
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

  case "${raw}" in
    y|yes|true|1|on)
      printf '%s' "true"
      return 0
      ;;
    n|no|false|0|off)
      printf '%s' "false"
      return 0
      ;;
  esac

  return 1
}

prompt_yes_no() {
  local prompt="$1"
  local default_value="$2"
  local suffix="[y/n]"
  local value=""
  local normalized_default=""

  if [[ -n "${default_value}" ]]; then
    normalized_default="$(normalize_yes_no "${default_value}")" || {
      echo "Invalid default yes/no value: ${default_value}" >&2
      exit 1
    }
    if [[ "${normalized_default}" == "true" ]]; then
      suffix="[Y/n]"
    else
      suffix="[y/N]"
    fi
  fi

  while true; do
    read -r -p "${prompt} ${suffix}: " value

    if [[ -z "${value}" && -n "${normalized_default}" ]]; then
      printf '%s' "${normalized_default}"
      return 0
    fi

    if normalized_value="$(normalize_yes_no "${value}")"; then
      printf '%s' "${normalized_value}"
      return 0
    fi

    echo "Please answer yes or no." >&2
  done
}

prompt_env_safe_value() {
  local prompt="$1"
  local value=""

  while true; do
    value="$(prompt_nonempty "${prompt}")"

    if [[ "${value}" =~ [[:space:]#] ]]; then
      echo "${prompt} cannot contain whitespace or '#' because it is written to .env.vps." >&2
      continue
    fi

    printf '%s' "${value}"
    return 0
  done
}

prompt_optional_env_safe_value() {
  local prompt="$1"
  local value=""

  while true; do
    read -r -p "${prompt}: " value

    if [[ -z "${value}" ]]; then
      printf '%s' ""
      return 0
    fi

    if [[ "${value}" =~ [[:space:]#] ]]; then
      echo "${prompt} cannot contain whitespace or '#' because it is written to .env.vps." >&2
      continue
    fi

    printf '%s' "${value}"
    return 0
  done
}

prompt_password() {
  local first=""
  local second=""

  while true; do
    read -r -s -p "Admin password: " first
    echo >&2
    read -r -s -p "Confirm admin password: " second
    echo >&2

    if [[ -z "${first}" ]]; then
      echo "Password cannot be empty." >&2
      continue
    fi

    if [[ "${first}" != "${second}" ]]; then
      echo "Passwords do not match." >&2
      continue
    fi

    if [[ "${first}" =~ [[:space:]#] ]]; then
      echo "Password cannot contain whitespace or '#' because it is written to .env.vps." >&2
      continue
    fi

    printf '%s' "${first}"
    return 0
  done
}

normalize_domain() {
  local raw="$1"
  raw="${raw#http://}"
  raw="${raw#https://}"
  raw="${raw%%/*}"
  raw="${raw%.}"
  printf '%s' "${raw,,}"
}

detect_primary_ipv4() {
  local candidate=""

  if command -v ip >/dev/null 2>&1; then
    candidate="$(
      ip route get 1.1.1.1 2>/dev/null | awk '
        /src/ {
          for (i = 1; i <= NF; i++) {
            if ($i == "src") {
              print $(i + 1)
              exit
            }
          }
        }
      '
    )"
  fi

  if [[ -z "${candidate}" ]]; then
    candidate="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  candidate="${candidate%% *}"
  if [[ "${candidate}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "${candidate}" != 127.* ]]; then
    printf '%s' "${candidate}"
  fi

  return 0
}

# ── OS detection (for Docker install) ────────────────────────────────

require_supported_os() {
  if [[ ! -f /etc/os-release ]]; then
    echo "Cannot detect the VPS distribution." >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
    echo "This installer currently supports Debian and Ubuntu only." >&2
    exit 1
  fi

  OS_ID="${ID}"
  OS_VERSION_CODENAME="${VERSION_CODENAME:-}"
  if [[ -z "${OS_VERSION_CODENAME}" ]]; then
    echo "Missing VERSION_CODENAME in /etc/os-release." >&2
    exit 1
  fi
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi

  require_supported_os

  ${SUDO} apt-get update
  ${SUDO} apt-get install -y ca-certificates curl gnupg git
  ${SUDO} install -m 0755 -d /etc/apt/keyrings

  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" | \
      ${SUDO} gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    ${SUDO} chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  arch="$(${SUDO} dpkg --print-architecture)"
  cat <<EOF | ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} ${OS_VERSION_CODENAME} stable
EOF

  ${SUDO} apt-get update
  ${SUDO} apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ${SUDO} systemctl enable --now docker
}

# ── Config writers ───────────────────────────────────────────────────

write_env_file() {
  local admin_user="$1"
  local admin_pass="$2"
  local domain_enabled="$3"
  local root_domain="$4"
  local telegram_bot_token="$5"
  local admin_bind_host="127.0.0.1"
  local admin_public_url=""
  local public_site_url=""
  local caddy_enabled="false"
  local caddy_site_snippets_dir=""
  local caddy_data_dir=""
  local caddy_config_dir=""

  if [[ "${domain_enabled}" == "true" ]]; then
    admin_public_url="https://admin.${root_domain}"
    public_site_url="https://${root_domain}"
    caddy_enabled="true"
    caddy_site_snippets_dir="${CADDY_ROOT}/sites"
    caddy_data_dir="${CADDY_ROOT}/data"
    caddy_config_dir="${CADDY_ROOT}/config"
  else
    admin_bind_host="0.0.0.0"
  fi

  cat > "${ENV_FILE}" <<EOF
ROOT_DOMAIN=${root_domain}
ADMIN_PUBLIC_URL=${admin_public_url}
PUBLIC_SITE_URL=${public_site_url}
ADMIN_LOCAL_PORT=3000
ADMIN_BIND_HOST=${admin_bind_host}
CADDY_ENABLED=${caddy_enabled}
CADDY_SITE_SNIPPETS_DIR=${caddy_site_snippets_dir}
CADDY_DATA_DIR=${caddy_data_dir}
CADDY_CONFIG_DIR=${caddy_config_dir}
TELEGRAM_BOT_TOKEN=${telegram_bot_token}
ADMIN_USER=${admin_user}
ADMIN_PASS=${admin_pass}
EOF

  chmod 600 "${ENV_FILE}"
}

install_systemd_unit() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is not available; skipping service installation." >&2
    return 0
  fi

  cat <<EOF | ${SUDO} tee "${SYSTEMD_UNIT_PATH}" >/dev/null
[Unit]
Description=Agent-OS VPS stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${ROOT_DIR}
ExecStart=/usr/bin/env bash ${ROOT_DIR}/scripts/manage-vps-stack.sh up
ExecReload=/usr/bin/env bash ${ROOT_DIR}/scripts/manage-vps-stack.sh reload
ExecStop=/usr/bin/env bash ${ROOT_DIR}/scripts/manage-vps-stack.sh down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

  ${SUDO} systemctl daemon-reload
  ${SUDO} systemctl enable agent-os.service
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  install_docker_if_needed

  # Resolve config: env vars take priority, then interactive prompts
  admin_user="${AGENT_OS_ADMIN_USER:-}"
  admin_pass="${AGENT_OS_ADMIN_PASS:-}"
  add_domain="${AGENT_OS_ADD_DOMAIN:-}"
  root_domain="${AGENT_OS_DOMAIN:-}"
  telegram_bot_token="${TELEGRAM_BOT_TOKEN:-}"
  admin_local_port="3000"

  echo "" >&2
  if [[ -z "${admin_user}" ]]; then
    admin_user="$(prompt_env_safe_value "Admin username")"
  fi

  if [[ -z "${admin_pass}" ]]; then
    admin_pass="$(prompt_password)"
  fi

  if [[ -n "${add_domain}" ]]; then
    add_domain="$(normalize_yes_no "${add_domain}")" || {
      echo "AGENT_OS_ADD_DOMAIN must be yes or no." >&2
      exit 1
    }
  elif [[ -n "${root_domain}" ]]; then
    add_domain="true"
  else
    add_domain="$(prompt_yes_no "Add domain and HTTPS routing with Caddy" "yes")"
  fi

  if [[ "${add_domain}" == "true" ]]; then
    if [[ -z "${root_domain}" ]]; then
      root_domain="$(normalize_domain "$(prompt_nonempty "Root domain pointed at this VPS")")"
    else
      root_domain="$(normalize_domain "${root_domain}")"
    fi
  else
    root_domain=""
  fi

  if [[ -z "${telegram_bot_token}" ]]; then
    telegram_bot_token="$(prompt_optional_env_safe_value "Telegram bot token (optional, press Enter to skip)")"
  fi

  if [[ "${add_domain}" == "true" ]]; then
    if [[ ! "${root_domain}" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
      echo "Invalid root domain: ${root_domain}" >&2
      exit 1
    fi
  fi

  if [[ "${add_domain}" == "true" ]]; then
    ${SUDO} mkdir -p "${CADDY_ROOT}/sites" "${CADDY_ROOT}/data" "${CADDY_ROOT}/config"
    if [[ ! -f "${CADDY_ROOT}/sites/00-placeholder.caddy" ]]; then
      cat <<'EOF' | ${SUDO} tee "${CADDY_ROOT}/sites/00-placeholder.caddy" >/dev/null
# Additional per-subdomain routes live in this directory.
# Leave this file in place so the Caddy import glob always resolves.
EOF
    fi
  fi

  write_env_file "${admin_user}" "${admin_pass}" "${add_domain}" "${root_domain}" "${telegram_bot_token}"
  install_systemd_unit

  echo ""
  echo "Starting Agent-OS stack..."
  AGENT_OS_ENV_FILE="${ENV_FILE}" bash "${ROOT_DIR}/scripts/manage-vps-stack.sh" up

  local_admin_url="http://localhost:${admin_local_port}"
  network_ip="$(detect_primary_ipv4)"
  network_admin_url=""
  if [[ -n "${network_ip}" ]]; then
    network_admin_url="http://${network_ip}:${admin_local_port}"
  fi

  if [[ "${add_domain}" == "true" ]]; then
    cat <<EOF

  ┌─────────────────────────────────────────────────┐
  │            Agent-OS is deploying                 │
  └─────────────────────────────────────────────────┘

  Admin:   https://admin.${root_domain}
  Public:  https://${root_domain}
  Config:  ${ENV_FILE}

  Caddy snippets: ${CADDY_ROOT}/sites

  Day-2 commands:
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh status
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh logs
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh reload
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh restart [service]

EOF
  else
    cat <<EOF

  ┌─────────────────────────────────────────────────┐
  │            Agent-OS is deploying                 │
  └─────────────────────────────────────────────────┘

  Admin (local):   ${local_admin_url}
EOF
    if [[ -n "${network_admin_url}" ]]; then
      cat <<EOF
  Admin (network): ${network_admin_url}
EOF
    fi
    cat <<EOF
  Config:          ${ENV_FILE}

  Domain setup: skipped
  Caddy:        disabled

  On the same machine, open localhost.
  On a VPS, open the server IP on port ${admin_local_port}.

  Day-2 commands:
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh status
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh logs
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh reload
    bash ${ROOT_DIR}/scripts/manage-vps-stack.sh restart [service]

EOF
  fi
}

main "$@"
