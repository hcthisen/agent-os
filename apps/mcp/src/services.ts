/**
 * Service registry lookup (3.17).
 * When a tool needs an external service, checks service_registry for active credentials.
 * If missing, creates a key_needed row and returns an informative error.
 */
import { getDb } from "./db.js";
import { getAgentContext } from "./context.js";
import { withDecryptedCredential } from "./service-registry.js";

export interface ServiceCredential {
  service_name: string;
  base_url: string | null;
  auth_type: string;
  credential: string;
}

/**
 * Look up an external service credential. Returns the credential if active.
 * If the service doesn't exist or needs a key, creates/updates the registry
 * entry and throws an informative error so the agent can report it.
 */
export async function getServiceCredential(
  serviceName: string,
  options?: { displayName?: string; description?: string; baseUrl?: string }
): Promise<ServiceCredential> {
  const db = getDb();

  // Look up the service
  const { data } = await db
    .from("service_registry")
    .select("service_name, base_url, auth_type, credential, status")
    .eq("service_name", serviceName)
    .maybeSingle();
  const service = await withDecryptedCredential(data);

  if (service && service.status === "active" && service.credential) {
    return {
      service_name: service.service_name,
      base_url: service.base_url,
      auth_type: service.auth_type,
      credential: service.credential,
    };
  }

  // Service exists but isn't active
  if (service) {
    if (service.status === "key_needed") {
      throw new Error(
        `Service '${serviceName}' requires an API key. ` +
        `Please add the credential via the admin panel (Settings > Service Connections).`
      );
    }
    if (service.status === "error") {
      throw new Error(
        `Service '${serviceName}' is in error state. ` +
        `Check the admin panel for details and re-enter the credential if needed.`
      );
    }
    throw new Error(`Service '${serviceName}' has status '${service.status}' and cannot be used.`);
  }

  // Service doesn't exist — register it as key_needed
  const ctx = getAgentContext();
  await db.from("service_registry").insert({
    service_name: serviceName,
    display_name: options?.displayName || serviceName,
    description: options?.description || `Required by agent ${ctx.role_id}`,
    base_url: options?.baseUrl || null,
    auth_type: "api_key",
    status: "key_needed",
    registered_by: ctx.agent_id,
  });

  // Log an event so the operator is notified
  await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "service.key_needed",
    severity: "warning",
    scope_type: "company",
    scope_id: "system",
    summary: `API key needed for service '${serviceName}'`,
    detail: {
      service_name: serviceName,
      display_name: options?.displayName || serviceName,
      description: options?.description,
    },
  });

  throw new Error(
    `Service '${serviceName}' is not configured. ` +
    `A key_needed entry has been created. ` +
    `Please add the API key via the admin panel (Settings > Service Connections).`
  );
}
