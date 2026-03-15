import { getDb } from "./db.js";

const SERVICE_REGISTRY_ENCRYPTION_KEY =
  process.env.SERVICE_REGISTRY_ENCRYPTION_KEY || process.env.JWT_SECRET || "";

interface CredentialRow {
  credential: string | null;
}

export interface ServiceRegistryRuntimeRow extends CredentialRow {
  auth_type?: string;
  base_url: string | null;
  created_at?: string | null;
  description?: string;
  display_name?: string;
  error_message: string | null;
  id: string;
  last_verified?: string | null;
  registered_by?: string | null;
  service_name: string;
  status: string;
  updated_at: string;
}

function normalizeEncryptedCredential(value: string): string {
  return value.replace(/\s+/g, "");
}

function looksEncryptedCredential(value: string): boolean {
  const normalized = normalizeEncryptedCredential(value);
  return (
    normalized.length >= 40 &&
    normalized.length % 4 === 0 &&
    /^[A-Za-z0-9+/=]+$/.test(normalized)
  );
}

export async function withDecryptedCredential<T extends CredentialRow>(
  row: T | null
): Promise<T | null> {
  if (!row?.credential) {
    return row;
  }

  if (
    !SERVICE_REGISTRY_ENCRYPTION_KEY ||
    !looksEncryptedCredential(row.credential)
  ) {
    return row;
  }

  try {
    const db = getDb();
    const { data, error } = await db.rpc("decrypt_credential", {
      encrypted_text: normalizeEncryptedCredential(row.credential),
      encryption_key: SERVICE_REGISTRY_ENCRYPTION_KEY,
    });

    if (error || typeof data !== "string" || !data.trim()) {
      return row;
    }

    return {
      ...row,
      credential: data,
    };
  } catch {
    return row;
  }
}

export async function getServiceRegistryRuntime(
  serviceName: string
): Promise<ServiceRegistryRuntimeRow | null> {
  const db = getDb();

  try {
    const { data, error } = await db.rpc("get_service_registry_runtime", {
      p_service_name: serviceName,
    });

    if (!error) {
      const row = Array.isArray(data)
        ? (data[0] as ServiceRegistryRuntimeRow | undefined) || null
        : ((data as ServiceRegistryRuntimeRow | null) || null);
      return row;
    }

    console.warn(
      `Runtime service registry RPC unavailable, falling back to direct table access for ${serviceName}:`,
      error
    );
  } catch (error) {
    console.warn(
      `Runtime service registry RPC call failed, falling back to direct table access for ${serviceName}:`,
      error
    );
  }

  const { data: rawService, error: serviceError } = await db
    .from("service_registry")
    .select(
      "id,credential,base_url,error_message,service_name,status,updated_at,auth_type,created_at,description,display_name,last_verified,registered_by"
    )
    .eq("service_name", serviceName)
    .maybeSingle<ServiceRegistryRuntimeRow>();

  if (serviceError) {
    console.error(
      `Failed to load service registry entry for ${serviceName}:`,
      serviceError
    );
    return null;
  }

  return withDecryptedCredential(rawService);
}

export async function createRuntimeEmbedding(args: {
  input: string;
  model?: string;
  serviceName?: string;
}): Promise<number[] | null> {
  const serviceName = String(args.serviceName || "openai").trim().toLowerCase();
  const service = await getServiceRegistryRuntime(serviceName);

  if (!service || service.status !== "active" || !service.credential) {
    return null;
  }

  const baseUrl = String(service.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${service.credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: args.input,
      model: String(args.model || "text-embedding-ada-002").trim() || "text-embedding-ada-002",
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = payload.data?.[0]?.embedding;
  return Array.isArray(embedding) ? embedding : null;
}
