import { getDb } from "./db.js";

const SERVICE_REGISTRY_ENCRYPTION_KEY =
  process.env.SERVICE_REGISTRY_ENCRYPTION_KEY || process.env.JWT_SECRET || "";

export interface ServiceRegistryCredentialRow {
  credential: string | null;
}

function looksEncryptedCredential(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length >= 40 &&
    normalized.length % 4 === 0 &&
    /^[A-Za-z0-9+/=]+$/.test(normalized)
  );
}

export async function decryptServiceCredential(
  credential: string | null
): Promise<string | null> {
  if (!credential) {
    return null;
  }

  if (!SERVICE_REGISTRY_ENCRYPTION_KEY || !looksEncryptedCredential(credential)) {
    return credential;
  }

  try {
    const db = getDb();
    const { data, error } = await db.rpc("decrypt_credential", {
      encrypted_text: credential,
      encryption_key: SERVICE_REGISTRY_ENCRYPTION_KEY,
    });

    if (error || typeof data !== "string" || !data.trim()) {
      return credential;
    }

    return data;
  } catch {
    return credential;
  }
}

export async function withDecryptedCredential<T extends ServiceRegistryCredentialRow>(
  row: T | null
): Promise<T | null> {
  if (!row) {
    return null;
  }

  return {
    ...row,
    credential: await decryptServiceCredential(row.credential),
  };
}
