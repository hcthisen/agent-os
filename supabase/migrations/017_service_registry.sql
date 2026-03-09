CREATE TABLE service_registry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name  text UNIQUE NOT NULL,
  display_name  text NOT NULL,
  description   text NOT NULL DEFAULT '',
  base_url      text,
  auth_type     text NOT NULL DEFAULT 'api_key',
  credential    text,             -- encrypted at rest via pgcrypto
  status        service_status NOT NULL DEFAULT 'key_needed',
  last_verified timestamptz,
  error_message text,
  registered_by uuid REFERENCES agents(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_name ON service_registry(service_name);
CREATE INDEX idx_service_status ON service_registry(status);

-- Helper functions for credential encryption/decryption
-- The encryption key is derived from the JWT_SECRET env var set in Postgres config.

CREATE OR REPLACE FUNCTION encrypt_credential(plain_text text, encryption_key text)
RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN encode(pgp_sym_encrypt(plain_text, encryption_key), 'base64');
END;
$$;

CREATE OR REPLACE FUNCTION decrypt_credential(encrypted_text text, encryption_key text)
RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN pgp_sym_decrypt(decode(encrypted_text, 'base64'), encryption_key);
END;
$$;
