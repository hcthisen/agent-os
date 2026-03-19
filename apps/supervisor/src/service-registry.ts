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

export interface SanitizedServiceConnectionHint {
  base_url: string | null;
  display_name: string;
  non_secret_fields: Record<string, string>;
  service_name: string;
  status: string;
  usage_hints?: string[];
}

const DEFAULT_SERVICE_BASE_URL_HINTS: Record<string, string> = {
  elevenlabs: "https://api.elevenlabs.io",
  gemini: "https://generativelanguage.googleapis.com",
  github: "https://api.github.com",
  gohighlevel: "https://services.leadconnectorhq.com",
  openai: "https://api.openai.com/v1",
  vercel: "https://api.vercel.com",
};

const DEFAULT_SERVICE_USAGE_HINTS: Record<string, string[]> = {
  elevenlabs: [
    "Use service_request with service_name 'elevenlabs'. The control plane already injects the xi-api-key header.",
    "For generated audio, pass output_path so the MP3 is saved directly into the task workspace instead of returning a large base64 payload.",
    "A text-to-speech request should produce a real audio file or a concrete API blocker, not only a script draft.",
  ],
  gemini: [
    "Use service_request with service_name 'gemini'. The control plane already injects the x-goog-api-key header.",
    "For generated images, pass output_path so the image file is written directly into the task workspace instead of returning a large base64 payload.",
    "Use an image-capable Gemini model endpoint for live generation and return real image files or a concrete API blocker, not only prompt notes.",
  ],
  github: [
    "Use service_request with service_name 'github'. The control plane already knows the default GitHub API base URL and injects bearer auth.",
    "When the operator asked for a fresh repo and no existing repo target was specified, attempt the live repository creation and upload flow before browsing API docs or searching the web for examples.",
    "Only fall back to narrowly scoped docs research after a concrete live API attempt fails or a specific response shape is still unclear.",
  ],
  gohighlevel: [
    "Reuse the non-secret scoped identifiers in this service connection, such as location id, instead of asking the operator to repeat them.",
    "When a dedicated GHL MCP surface is available, use that instead of raw service_request calls.",
  ],
  vercel: [
    "Use service_request with service_name 'vercel'. The control plane already knows the default Vercel API base URL and injects bearer auth.",
    "When the operator asked for deployment and no existing project target was specified, attempt the live project/deployment flow before browsing API docs or searching the web for examples.",
    "Only fall back to narrowly scoped docs research after a concrete live API attempt fails or a specific response shape is still unclear.",
  ],
};

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

const SENSITIVE_CREDENTIAL_FIELD_PATTERN =
  /\b(api|token|secret|password|credential|bearer|private|refresh|access key|client secret|pit key)\b/i;
const NON_SECRET_CREDENTIAL_FIELD_PATTERN =
  /\b(id|url|uri|host|hostname|domain|subdomain|workspace|location|account|project|site|branch|region|zone|voice)\b/i;

export function extractStructuredCredentialFields(rawCredential: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of String(rawCredential || "").split(/\r?\n+/)) {
    const match = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }

    fields[match[1].trim().toLowerCase()] = match[2].trim();
  }

  return fields;
}

export function extractNonSecretCredentialFields(
  rawCredential: string
): Record<string, string> {
  const fields = extractStructuredCredentialFields(rawCredential);
  const safeFields: Record<string, string> = {};

  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    if (!fieldValue || SENSITIVE_CREDENTIAL_FIELD_PATTERN.test(fieldName)) {
      continue;
    }

    if (!NON_SECRET_CREDENTIAL_FIELD_PATTERN.test(fieldName)) {
      continue;
    }

    safeFields[fieldName] = fieldValue;
  }

  return safeFields;
}

export function toSanitizedServiceConnectionHint(
  row: ServiceRegistryRuntimeRow | null
): SanitizedServiceConnectionHint | null {
  if (!row) {
    return null;
  }

  return {
    base_url:
      row.base_url ||
      DEFAULT_SERVICE_BASE_URL_HINTS[row.service_name] ||
      null,
    display_name: String(row.display_name || row.service_name || "").trim() || row.service_name,
    non_secret_fields: extractNonSecretCredentialFields(row.credential || ""),
    service_name: row.service_name,
    status: row.status,
    ...(DEFAULT_SERVICE_USAGE_HINTS[row.service_name]
      ? { usage_hints: DEFAULT_SERVICE_USAGE_HINTS[row.service_name] }
      : {}),
  };
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

export const serviceRegistryTestHooks = {
  DEFAULT_SERVICE_BASE_URL_HINTS,
  DEFAULT_SERVICE_USAGE_HINTS,
  extractNonSecretCredentialFields,
  extractStructuredCredentialFields,
  toSanitizedServiceConnectionHint,
};
