import { getDb } from "./db.js";
import { withDecryptedCredential, type ServiceRegistryRuntimeRow } from "./service-registry.js";

export interface RemoteMcpServerConfig {
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
  name: string;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  url: string;
}

export interface RemoteMcpConfigBundle {
  env: Record<string, string>;
  servers: RemoteMcpServerConfig[];
}

export interface RemoteMcpServiceRow extends ServiceRegistryRuntimeRow {
  credential: string | null;
}

const KNOWN_REMOTE_MCP_SERVICES = ["gohighlevel"] as const;
const COMMON_TOKEN_FIELD_NAMES = [
  "pit key",
  "pit_key",
  "token",
  "api key",
  "api_key",
  "key",
  "credential",
  "secret",
] as const;
const GHL_LOCATION_FIELD_NAMES = [
  "location id",
  "location_id",
  "locationid",
  "sub-account location id",
  "subaccount location id",
  "sub-account id",
  "subaccount id",
] as const;

export async function loadRemoteMcpConfigBundle(): Promise<RemoteMcpConfigBundle> {
  const db = getDb();
  const { data, error } = await db
    .from("service_registry")
    .select(
      "id,credential,base_url,error_message,service_name,status,updated_at,auth_type,created_at,description,display_name,last_verified,registered_by"
    )
    .in("service_name", [...KNOWN_REMOTE_MCP_SERVICES])
    .eq("status", "active")
    .returns<RemoteMcpServiceRow[]>();

  if (error || !data?.length) {
    return {
      env: {},
      servers: [],
    };
  }

  const bundle: RemoteMcpConfigBundle = {
    env: {},
    servers: [],
  };

  for (const rawRow of data) {
    const row = await withDecryptedCredential(rawRow);
    if (!row?.credential?.trim()) {
      continue;
    }

    const resolved =
      resolveRemoteMcpConfigForService(row);

    if (!resolved) {
      continue;
    }

    bundle.servers.push(resolved.server);
    Object.assign(bundle.env, resolved.env);
  }

  return bundle;
}

export function resolveRemoteMcpConfigForService(
  row: RemoteMcpServiceRow
): { env: Record<string, string>; server: RemoteMcpServerConfig } | null {
  return row.service_name === "gohighlevel"
    ? buildGoHighLevelRemoteMcpConfig(row)
    : null;
}

export function hasConfiguredRemoteMcpServer(row: RemoteMcpServiceRow): boolean {
  return resolveRemoteMcpConfigForService(row) !== null;
}

function buildGoHighLevelRemoteMcpConfig(
  row: RemoteMcpServiceRow
): { env: Record<string, string>; server: RemoteMcpServerConfig } | null {
  const fields = extractStructuredCredentialFields(row.credential || "");
  const token = findCredentialFieldValue(fields, COMMON_TOKEN_FIELD_NAMES);
  const locationId = findCredentialFieldValue(fields, GHL_LOCATION_FIELD_NAMES);

  if (!token || !locationId) {
    return null;
  }

  const tokenEnvVar = "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_TOKEN";
  const locationEnvVar = "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_LOCATION_ID";

  return {
    env: {
      [locationEnvVar]: locationId,
      [tokenEnvVar]: token,
    },
    server: {
      bearerTokenEnvVar: tokenEnvVar,
      envHttpHeaders: {
        locationId: locationEnvVar,
      },
      name: "gohighlevel",
      startupTimeoutSec: 30,
      toolTimeoutSec: 120,
      url: "https://services.leadconnectorhq.com/mcp/",
    },
  };
}

function extractStructuredCredentialFields(rawCredential: string): Record<string, string> {
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

function findCredentialFieldValue(
  fields: Record<string, string>,
  candidates: readonly string[]
): string | null {
  for (const candidate of candidates) {
    const value = fields[candidate];
    if (value?.trim()) {
      return value.trim();
    }
  }

  return null;
}

export const remoteMcpTestHooks = {
  buildGoHighLevelRemoteMcpConfig,
  extractStructuredCredentialFields,
  findCredentialFieldValue,
  hasConfiguredRemoteMcpServer,
  resolveRemoteMcpConfigForService,
};
