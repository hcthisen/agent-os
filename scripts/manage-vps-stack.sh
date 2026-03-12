#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${AGENT_OS_ENV_FILE:-${ROOT_DIR}/.env.vps}"
COMPOSE_ARGS=(
  "--env-file" "${ENV_FILE}"
  "-f" "${ROOT_DIR}/docker-compose.yaml"
  "-f" "${ROOT_DIR}/docker-compose.vps.yaml"
)

usage() {
  cat <<'EOF'
Usage: bash scripts/manage-vps-stack.sh <command> [service...]

Commands:
  up            Build and start the VPS stack
  down          Stop and remove the VPS stack
  reload        Rebuild and reconcile the VPS stack
  restart       Restart the whole stack or the named services
  status        Show stack status
  logs          Follow logs for the whole stack or the named services
  caddy-reload  Reload Caddy after editing site snippets
EOF
}

run_compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing environment file: ${ENV_FILE}" >&2
  echo "Run bash scripts/install-vps.sh first." >&2
  exit 1
fi

command_name="${1:-}"
shift || true

case "${command_name}" in
  up)
    run_compose up -d --build --remove-orphans
    ;;
  down)
    run_compose down --remove-orphans
    ;;
  reload)
    run_compose up -d --build --remove-orphans "$@"
    ;;
  restart)
    if [[ "$#" -eq 0 ]]; then
      run_compose restart
    else
      run_compose restart "$@"
    fi
    ;;
  status)
    run_compose ps
    ;;
  logs)
    run_compose logs -f --tail=200 "$@"
    ;;
  caddy-reload)
    run_compose exec caddy caddy reload --config /etc/caddy/Caddyfile
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
