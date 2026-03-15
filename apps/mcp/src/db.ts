import {
  createPostgrestClient,
  type AgentOsPostgrestClient,
} from "@agent-os/shared";

let client: AgentOsPostgrestClient | null = null;

export function getDb(): AgentOsPostgrestClient {
  if (client) return client;

  const url = process.env.POSTGREST_URL || process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_ANON_KEY || "";
  const runtimeToken =
    process.env.AGENT_RUNTIME_JWT || process.env.SUPABASE_SERVICE_KEY || "";

  if (!url || !apiKey || !runtimeToken) {
    throw new Error(
      "Missing POSTGREST_URL (or SUPABASE_URL fallback), SUPABASE_ANON_KEY, or AGENT_RUNTIME_JWT environment variables"
    );
  }

  client = createPostgrestClient(url, apiKey, runtimeToken);

  return client;
}
