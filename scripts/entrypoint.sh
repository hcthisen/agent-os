#!/bin/sh
# Entrypoint wrapper: source generated secrets, then run the actual command.
set -eu

ENV_FILE="/config/.env.generated"
ENV_OVERRIDE_KEYS="${ENV_OVERRIDE_KEYS:-}"
OVERRIDE_FILE=""

# Wait for secrets to be generated (init service runs first)
TIMEOUT=30
ELAPSED=0
while [ ! -f "$ENV_FILE" ]; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "[entrypoint] ERROR: $ENV_FILE not found after ${TIMEOUT}s. Did the init service run?"
    exit 1
  fi
  echo "[entrypoint] Waiting for secrets..."
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

# Preserve selected environment variables so platform-provided values can
# override generated config loaded from the shared volume.
if [ -n "$ENV_OVERRIDE_KEYS" ]; then
  OVERRIDE_FILE="$(mktemp)"

  for key in $ENV_OVERRIDE_KEYS; do
    if eval "[ -n \"\${$key:-}\" ]"; then
      eval "value=\${$key}"
      escaped=$(printf "%s" "$value" | sed "s/'/'\\\\''/g")
      printf "%s='%s'\nexport %s\n" "$key" "$escaped" "$key" >>"$OVERRIDE_FILE"
    fi
  done
fi

# Source the generated environment, including derived values.
set -a
. "$ENV_FILE"
set +a

if [ -n "$OVERRIDE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$OVERRIDE_FILE"
  rm -f "$OVERRIDE_FILE"
fi

if [ -n "${PUBLIC_LIVE_DIR:-}" ]; then
  mkdir -p "$PUBLIC_LIVE_DIR"
  chmod -R 0777 "$PUBLIC_LIVE_DIR" || true
fi

# Expose the JWT secret and service-registry encryption key to Postgres as
# custom runtime settings so DB-side credential encryption can work on both
# fresh deployments and upgraded stacks.
if [ "$#" -ge 2 ] && [ "$1" = "docker-entrypoint.sh" ] && [ "$2" = "postgres" ]; then
  if [ -n "${JWT_SECRET:-}" ]; then
    set -- "$@" -c "app.settings.jwt_secret=${JWT_SECRET}"
  fi

  if [ -n "${SERVICE_REGISTRY_ENCRYPTION_KEY:-}" ]; then
    set -- "$@" -c "app.settings.service_registry_encryption_key=${SERVICE_REGISTRY_ENCRYPTION_KEY}"
  elif [ -n "${JWT_SECRET:-}" ]; then
    set -- "$@" -c "app.settings.service_registry_encryption_key=${JWT_SECRET}"
  fi
fi

# Run the actual command
exec "$@"
