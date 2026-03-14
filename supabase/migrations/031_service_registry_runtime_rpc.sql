CREATE OR REPLACE FUNCTION get_service_registry_runtime(p_service_name text)
RETURNS TABLE (
  id uuid,
  service_name text,
  display_name text,
  description text,
  base_url text,
  auth_type text,
  credential text,
  status service_status,
  last_verified timestamptz,
  error_message text,
  registered_by uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sr.id,
    sr.service_name,
    sr.display_name,
    sr.description,
    sr.base_url,
    sr.auth_type,
    CASE
      WHEN sr.credential IS NULL OR sr.credential = '' THEN sr.credential
      WHEN service_registry_encryption_key() = '' THEN sr.credential
      WHEN looks_encrypted_credential(sr.credential)
        THEN decrypt_credential(sr.credential, service_registry_encryption_key())
      ELSE sr.credential
    END AS credential,
    sr.status,
    sr.last_verified,
    sr.error_message,
    sr.registered_by,
    sr.created_at,
    sr.updated_at
  FROM service_registry sr
  WHERE sr.service_name = p_service_name
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION get_service_registry_runtime(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_service_registry_runtime(text) FROM anon;
REVOKE EXECUTE ON FUNCTION get_service_registry_runtime(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_service_registry_runtime(text) TO service_role;
