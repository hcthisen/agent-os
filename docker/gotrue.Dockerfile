FROM supabase/gotrue:v2.158.1

COPY scripts/entrypoint.sh /scripts/entrypoint.sh

RUN chmod 755 /scripts/entrypoint.sh
