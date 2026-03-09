#!/bin/sh
# Storage-specific entrypoint: sources secrets, then overrides DATABASE_URL
# to use supabase_storage_admin role instead of postgres.
set -eu

ENV_FILE="/config/.env.generated"

# Wait for secrets
TIMEOUT=30
ELAPSED=0
while [ ! -f "$ENV_FILE" ]; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "[storage-entrypoint] ERROR: $ENV_FILE not found after ${TIMEOUT}s."
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

# Source the generated environment
set -a
. "$ENV_FILE"
set +a

# Override DATABASE_URL to use supabase_storage_admin
export DATABASE_URL="$STORAGE_DATABASE_URL"

exec "$@"
