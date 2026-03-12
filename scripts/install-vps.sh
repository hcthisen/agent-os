#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.vps"
SYSTEMD_UNIT_PATH="/etc/systemd/system/agent-os.service"
CADDY_ROOT="/srv/agent-os/caddy"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer targets a Linux VPS." >&2
  exit 1
fi

if command -v sudo >/dev/null 2>&1 && [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

prompt_nonempty() {
  local prompt="$1"
  local value=""

  while [[ -z "${value}" ]]; do
    read -r -p "${prompt}: " value
  done

  printf '%s' "${value}"
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

prompt_password() {
  local first=""
  local second=""

  while true; do
    read -r -s -p "Admin password: " first
    echo
    read -r -s -p "Confirm admin password: " second
    echo

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

write_env_file() {
  local admin_user="$1"
  local admin_pass="$2"
  local root_domain="$3"
  local admin_public_url="https://admin.${root_domain}"
  local public_site_url="https://${root_domain}"

  cat > "${ENV_FILE}" <<EOF
ROOT_DOMAIN=${root_domain}
ADMIN_PUBLIC_URL=${admin_public_url}
PUBLIC_SITE_URL=${public_site_url}
ADMIN_LOCAL_PORT=3000
CADDY_SITE_SNIPPETS_DIR=${CADDY_ROOT}/sites
CADDY_DATA_DIR=${CADDY_ROOT}/data
CADDY_CONFIG_DIR=${CADDY_ROOT}/config
TELEGRAM_BOT_TOKEN=
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

main() {
  install_docker_if_needed

  admin_user="$(prompt_env_safe_value "Admin username")"
  admin_pass="$(prompt_password)"
  root_domain="$(normalize_domain "$(prompt_nonempty "Root domain pointed at this VPS")")"

  if [[ ! "${root_domain}" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
    echo "Invalid root domain: ${root_domain}" >&2
    exit 1
  fi

  ${SUDO} mkdir -p "${CADDY_ROOT}/sites" "${CADDY_ROOT}/data" "${CADDY_ROOT}/config"
  if [[ ! -f "${CADDY_ROOT}/sites/00-placeholder.caddy" ]]; then
    cat <<'EOF' | ${SUDO} tee "${CADDY_ROOT}/sites/00-placeholder.caddy" >/dev/null
# Additional per-subdomain routes live in this directory.
# Leave this file in place so the Caddy import glob always resolves.
EOF
  fi

  write_env_file "${admin_user}" "${admin_pass}" "${root_domain}"
  install_systemd_unit

  AGENT_OS_ENV_FILE="${ENV_FILE}" bash "${ROOT_DIR}/scripts/manage-vps-stack.sh" up

  cat <<EOF

Agent-OS is deploying on the VPS.

Admin URL: https://admin.${root_domain}
Public URL: https://${root_domain}
Env file: ${ENV_FILE}

Additional public routes can be added as Caddy snippets in:
  ${CADDY_ROOT}/sites

Use these commands for day-2 operations:
  bash scripts/manage-vps-stack.sh status
  bash scripts/manage-vps-stack.sh logs
  bash scripts/manage-vps-stack.sh restart public
EOF
}

main "$@"
