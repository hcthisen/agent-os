FROM supabase/postgres:15.6.1.143

COPY --chmod=755 scripts/entrypoint.sh /scripts/entrypoint.sh
COPY --chmod=755 scripts/zzz-run-migrations.sh /docker-entrypoint-initdb.d/zzz-run-migrations.sh
COPY supabase/migrations/ /migrations/
