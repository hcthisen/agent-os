FROM supabase/storage-api:v1.11.13

COPY --chmod=755 scripts/storage-entrypoint.sh /scripts/storage-entrypoint.sh
