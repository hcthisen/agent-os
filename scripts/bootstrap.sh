#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Agent-OS  ·  Single-command VPS installer
#
# Interactive (prompts for domain, credentials):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/hcthisen/agent-os/main/scripts/bootstrap.sh)"
#
# Fully automated (no prompts):
#   AGENT_OS_DOMAIN=example.com \
#   AGENT_OS_ADMIN_USER=admin \
#   AGENT_OS_ADMIN_PASS=supersecretpassword \
#   TELEGRAM_BOT_TOKEN=123456:ABC-DEF... \
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/hcthisen/agent-os/main/scripts/bootstrap.sh)"
#
# Optional env vars:
#   AGENT_OS_DIR            Install directory        (default: /opt/agent-os)
#   AGENT_OS_BRANCH         Git branch to deploy     (default: main)
#   TELEGRAM_BOT_TOKEN      Telegram bot token       (default: none)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="https://github.com/hcthisen/agent-os.git"
INSTALL_DIR="${AGENT_OS_DIR:-/opt/agent-os}"
BRANCH="${AGENT_OS_BRANCH:-main}"

echo ""
echo "  ┌─────────────────────────────────┐"
echo "  │        Agent-OS Installer        │"
echo "  └─────────────────────────────────┘"
echo ""

# ── Detect OS ────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: This installer targets Linux only." >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "Error: Cannot detect distribution (/etc/os-release missing)." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
OS_ID="${ID:-}"
OS_VERSION_CODENAME="${VERSION_CODENAME:-}"

if [[ "${OS_ID}" != "ubuntu" && "${OS_ID}" != "debian" ]]; then
  echo "Error: Only Ubuntu and Debian are supported. Detected: ${OS_ID}" >&2
  exit 1
fi

if [[ -z "${OS_VERSION_CODENAME}" ]]; then
  echo "Error: Missing VERSION_CODENAME in /etc/os-release." >&2
  exit 1
fi

# ── Privilege helper ─────────────────────────────────────────────────
if command -v sudo >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

# ── Install system packages ─────────────────────────────────────────
echo "Checking prerequisites..."
NEED_APT_UPDATE=0

for cmd in git curl; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    NEED_APT_UPDATE=1
    break
  fi
done

if [[ "${NEED_APT_UPDATE}" -eq 1 ]]; then
  echo "Installing base packages (git, curl, ca-certificates)..."
  ${SUDO} apt-get update -qq
  ${SUDO} apt-get install -y -qq git ca-certificates curl gnupg >/dev/null
fi

# ── Install Docker if missing ────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Installing Docker..."
  ${SUDO} install -m 0755 -d /etc/apt/keyrings

  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" | \
      ${SUDO} gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    ${SUDO} chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  arch="$(dpkg --print-architecture)"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} ${OS_VERSION_CODENAME} stable" | \
    ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null

  ${SUDO} apt-get update -qq
  ${SUDO} apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin >/dev/null
  ${SUDO} systemctl enable --now docker
  echo "Docker installed."
else
  echo "Docker already installed."
fi

# ── Clone or update the repo ────────────────────────────────────────
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "Updating existing installation at ${INSTALL_DIR}..."
  git -C "${INSTALL_DIR}" fetch origin "${BRANCH}" --quiet
  git -C "${INSTALL_DIR}" checkout "${BRANCH}" --quiet
  git -C "${INSTALL_DIR}" pull origin "${BRANCH}" --quiet
else
  echo "Cloning agent-os to ${INSTALL_DIR}..."
  ${SUDO} mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
fi

# ── Hand off to the full installer ──────────────────────────────────
echo ""
cd "${INSTALL_DIR}"
exec bash "${INSTALL_DIR}/scripts/install-vps.sh"
