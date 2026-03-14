CREATE OR REPLACE FUNCTION encrypt_credential(plain_text text, encryption_key text)
RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN regexp_replace(
    encode(extensions.pgp_sym_encrypt(plain_text, encryption_key), 'base64'),
    '\s+',
    '',
    'g'
  );
END;
$$;

CREATE OR REPLACE FUNCTION decrypt_credential(encrypted_text text, encryption_key text)
RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(
    decode(regexp_replace(encrypted_text, '\s+', '', 'g'), 'base64'),
    encryption_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION looks_encrypted_credential(value text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT normalized <> ''
    AND length(normalized) >= 40
    AND mod(length(normalized), 4) = 0
    AND normalized ~ '^[A-Za-z0-9+/=]+$'
  FROM (
    SELECT regexp_replace(COALESCE(value, ''), '\s+', '', 'g') AS normalized
  ) AS candidate;
$$;

DO $$
DECLARE
  v_key text;
BEGIN
  v_key := service_registry_encryption_key();

  IF v_key = '' THEN
    RETURN;
  END IF;

  UPDATE service_registry
  SET
    credential = encrypt_credential(
      CASE
        WHEN looks_encrypted_credential(credential)
          THEN decrypt_credential(credential, v_key)
        ELSE credential
      END,
      v_key
    ),
    updated_at = now()
  WHERE credential IS NOT NULL
    AND credential <> '';
END;
$$;
