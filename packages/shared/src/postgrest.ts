import { PostgrestClient } from "@supabase/postgrest-js";

export type AgentOsPostgrestClient = PostgrestClient;

export function normalizePostgrestUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createPostgrestClient(
  url: string,
  apiKey: string,
  bearerToken = apiKey
): AgentOsPostgrestClient {
  return new PostgrestClient(normalizePostgrestUrl(url), {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${bearerToken}`,
    },
  });
}
