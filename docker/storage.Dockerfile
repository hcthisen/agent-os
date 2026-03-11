FROM supabase/storage-api:v1.11.13

COPY scripts/storage-entrypoint.sh /scripts/storage-entrypoint.sh

RUN chmod 755 /scripts/storage-entrypoint.sh
