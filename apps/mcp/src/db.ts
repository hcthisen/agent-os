import {
  createPostgrestClient,
  type AgentOsPostgrestClient,
} from "@agent-os/shared";

let client: AgentOsPostgrestClient | null = null;

export function getDb(): AgentOsPostgrestClient {
  if (client) return client;

  const url = process.env.POSTGREST_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing POSTGREST_URL (or SUPABASE_URL fallback) or SUPABASE_SERVICE_KEY environment variables"
    );
  }

  client = createPostgrestClient(url, key);

  return client;
}
