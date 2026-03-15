export interface ServiceCredential {
  service_name: string;
  base_url: string | null;
  auth_type: string;
  credential: string;
}

/**
 * Plaintext service credentials are intentionally unavailable inside the
 * agent-facing MCP runtime. Service access must be routed through a
 * supervisor-managed capability instead of being returned to the agent.
 */
export async function getServiceCredential(
  serviceName: string,
  options?: { displayName?: string; description?: string; baseUrl?: string }
): Promise<ServiceCredential> {
  void serviceName;
  void options;
  throw new Error(
    "Plaintext service credentials are not exposed to agent-run MCP sessions. Use service_require or a supervisor-managed control-plane action instead."
  );
}
