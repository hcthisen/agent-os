#!/bin/sh
# Run all SQL migration files in order.
# Placed in /docker-entrypoint-initdb.d/ so Postgres runs it on first boot.
set -eu

MIGRATIONS_DIR="/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[migrations] No migrations directory found at $MIGRATIONS_DIR - skipping."
  exit 0
fi

# Restore CREATE on public schema for postgres role
# (Supabase init scripts revoke it, but GoTrue and our migrations need it)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "GRANT CREATE ON SCHEMA public TO postgres;"

# Set password for supabase_auth_admin and supabase_storage_admin roles
# (GoTrue and Storage connect as these roles, not as postgres)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
ALTER ROLE supabase_storage_admin WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
EOSQL

echo "[migrations] Running SQL migrations from $MIGRATIONS_DIR..."

for f in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  echo "[migrations] Applying: $(basename "$f")"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$f"
done

echo "[migrations] All migrations applied successfully."
