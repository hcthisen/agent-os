#!/bin/sh
# Entrypoint wrapper: sources generated secrets, then runs the actual command.
set -eu

ENV_FILE="/config/.env.generated"

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

# Source the generated environment (all vars including derived ones)
set -a
. "$ENV_FILE"
set +a

# Run the actual command
exec "$@"
