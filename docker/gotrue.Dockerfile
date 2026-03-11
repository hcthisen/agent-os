FROM supabase/gotrue:v2.158.1

COPY --chmod=755 scripts/entrypoint.sh /scripts/entrypoint.sh
