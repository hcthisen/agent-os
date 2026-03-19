import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  hasConfiguredRemoteMcpServer,
  type RemoteMcpServiceRow,
} from "./remote-mcp.js";
import { config } from "./config.js";
import { getServiceRegistryRuntime } from "./service-registry.js";

type ManagedServiceName =
  | "admin"
  | "auth"
  | "autoheal"
  | "browser"
  | "caddy"
  | "db"
  | "mcp"
  | "public"
  | "realtime"
  | "rest"
  | "storage"
  | "supervisor";
type ManagedServiceLifecycle = "always_on" | "manual";
type ServiceRequestAuthMode = "basic" | "bearer" | "header" | "none" | "x-api-key";
type ServiceRequestResponseMode = "auto" | "base64" | "json" | "text";

type RouteAction = "delete" | "upsert" | "verify";

interface ComposeRuntime {
  currentContainerId: string | null;
  currentService: string;
  project: string;
}

interface DockerInspectResult {
  Config?: {
    Labels?: Record<string, string>;
  };
  Id: string;
  Name?: string;
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
  };
  State?: {
    Health?: {
      Status?: string;
    };
    Running?: boolean;
    Status?: string;
  };
}

interface ManagedServiceStatus {
  attention_required: boolean;
  container_id: string | null;
  container_name: string | null;
  health: string | null;
  ip_addresses: string[];
  lifecycle: ManagedServiceLifecycle;
  lifecycle_note: string;
  self_target: boolean;
  service: ManagedServiceName;
  state: string;
  status_reason: string;
}

interface ServiceRequestAuthDefaults {
  authHeaderName?: string;
  authMode?: ServiceRequestAuthMode;
  authPrefix?: string;
}

const MANAGED_SERVICES: ManagedServiceName[] = [
  "admin",
  "auth",
  "autoheal",
  "browser",
  "caddy",
  "db",
  "mcp",
  "public",
  "realtime",
  "rest",
  "storage",
  "supervisor",
];

const RELOAD_COMMANDS: Partial<Record<ManagedServiceName, string[]>> = {
  caddy: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
  public: ["nginx", "-s", "reload"],
};

const SERVICE_LIFECYCLE: Record<
  ManagedServiceName,
  { idle_states?: string[]; lifecycle: ManagedServiceLifecycle; note: string }
> = {
  admin: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  auth: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  autoheal: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  browser: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  caddy: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  db: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  mcp: {
    idle_states: ["created", "exited", "missing"],
    lifecycle: "manual",
    note: "The MCP container is on the manual Compose profile and may be stopped when no agent session needs it.",
  },
  public: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  realtime: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  rest: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  storage: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  supervisor: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
};

const DEFAULT_SERVICE_BASE_URLS: Record<string, string> = {
  elevenlabs: "https://api.elevenlabs.io",
  gemini: "https://generativelanguage.googleapis.com",
  github: "https://api.github.com",
  gohighlevel: "https://services.leadconnectorhq.com",
  openai: "https://api.openai.com/v1",
  vercel: "https://api.vercel.com",
};

const DEFAULT_SERVICE_AUTH_DEFAULTS: Record<string, ServiceRequestAuthDefaults> = {
  elevenlabs: {
    authHeaderName: "xi-api-key",
    authMode: "x-api-key",
  },
  gemini: {
    authHeaderName: "x-goog-api-key",
    authMode: "x-api-key",
  },
};

const COMMON_CREDENTIAL_FIELDS = [
  "token",
  "api key",
  "api_key",
  "pit key",
  "pit_key",
  "key",
  "credential",
  "secret",
] as const;

export async function handlePublicSiteRouteControl(args: {
  action?: string;
  hostname?: string;
  reload?: boolean;
  target_path?: string | null;
}): Promise<Record<string, unknown>> {
  const action = normalizeRouteAction(args.action);
  const hostname = normalizeHostname(
    args.hostname,
    normalizeRootDomain(process.env.ROOT_DOMAIN)
  );
  const targetPath =
    action === "upsert" ? normalizeTargetPath(args.target_path) : null;
  const containerId = findLatestServiceContainerId(resolveComposeRuntime(), "caddy");

  if (!containerId) {
    throw new Error("No running caddy container found for route control");
  }

  const snippetPath = `/etc/caddy/sites/${hostname}.caddy`;
  const previousContents = readSnippetContents(containerId, snippetPath);
  let nextContents: string | null = previousContents;

  if (action === "delete") {
    removeSnippet(containerId, snippetPath);
    nextContents = null;
  } else if (action === "upsert") {
    nextContents = buildSnippet(hostname, targetPath!);
    await writeSnippet(containerId, snippetPath, nextContents);
  }

  const shouldReload =
    typeof args.reload === "boolean" ? args.reload : action !== "verify";
  const reloadResult = shouldReload ? reloadService(containerId, "caddy") : null;

  return {
    action,
    changed: previousContents !== nextContents,
    container_id: containerId,
    current_contents: nextContents,
    previous_contents: previousContents,
    reload_result: reloadResult,
    reloaded: shouldReload,
    snippet_path: snippetPath,
    target_path: targetPath,
    success: true,
  };
}

export async function handleServiceControlControl(args: {
  action?: string;
  service?: string;
  services?: string[];
}): Promise<Record<string, unknown>> {
  const action = normalizeServiceAction(args.action);
  const runtime = resolveComposeRuntime();
  const requestedServices = normalizeRequestedServices(args, action);
  const serviceStates = inspectServices(runtime, requestedServices);

  if (action === "status") {
    return {
      action,
      current_service: runtime.currentService,
      project: runtime.project,
      services: serviceStates,
      success: true,
    };
  }

  const results: Array<Record<string, unknown>> = [];

  for (const serviceState of serviceStates) {
    if (!serviceState.container_id) {
      throw new Error(
        `Service '${serviceState.service}' is not running in project '${runtime.project}'`
      );
    }

    if (action === "reload") {
      results.push(reloadService(serviceState.container_id, serviceState.service));
      continue;
    }

    results.push(restartService(serviceState, runtime.currentContainerId));
  }

  return {
    action,
    current_service: runtime.currentService,
    project: runtime.project,
    results,
    success: true,
    warning:
      results.some((entry) => entry.self_target === true) &&
      action === "restart"
        ? "A self-targeted restart was queued. The current request may terminate when the supervisor restarts."
        : undefined,
  };
}

export async function handleServiceRequestControl(args: {
  allow_non_2xx?: boolean;
  auth_header_name?: string;
  auth_mode?: string;
  auth_prefix?: string;
  body?: unknown;
  credential_field?: string;
  headers?: Record<string, unknown>;
  method?: string;
  output_path?: string;
  path?: string;
  query?: Record<string, unknown>;
  response_mode?: string;
  service_name?: string;
  task_id?: string;
  timeout_ms?: number;
  url?: string;
}): Promise<Record<string, unknown>> {
  const serviceName = normalizeServiceRequestServiceName(args.service_name);
  const service = await getServiceRegistryRuntime(serviceName);

  if (!service || service.status !== "active" || !service.credential?.trim()) {
    throw new Error(
      `Service '${serviceName}' is not active or has no usable credential in Service Connections`
    );
  }

  if (shouldBlockServiceRequestForService(service)) {
    throw new Error(
      `service_request is disabled for '${serviceName}' because this runtime already exposes dedicated ${serviceName} MCP tools. Use the ${serviceName} MCP tools directly, and if the required action is unavailable there, report the blocker instead of probing raw REST endpoints.`
    );
  }

  const method = normalizeServiceRequestMethod(args.method);
  const authDefaults = getDefaultServiceRequestAuthDefaults(service.service_name);
  const baseUrl =
    String(service.base_url || "").trim() ||
    getDefaultServiceBaseUrl(service.service_name) ||
    null;
  const targetUrl = buildServiceRequestUrl({
    baseUrl,
    path: args.path,
    query: args.query,
      url: args.url,
  });
  const authMode = normalizeServiceRequestAuthMode(
    args.auth_mode || authDefaults.authMode
  );
  const requestHeaders = buildServiceRequestHeaders({
    authHeaderName: args.auth_header_name || authDefaults.authHeaderName,
    authMode,
    authPrefix: args.auth_prefix || authDefaults.authPrefix,
    credential: service.credential,
    credentialField: args.credential_field,
    headers: {
      ...getDefaultServiceRequestHeaders(service.service_name),
      ...(args.headers || {}),
    },
  });
  const responseMode = normalizeServiceResponseMode(args.response_mode);
  const body = buildServiceRequestBody(args.body, requestHeaders);
  const timeoutMs = normalizeTimeoutMs(args.timeout_ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      body,
      headers: requestHeaders,
      method,
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parsedBody = parseServiceResponseBody(
      bytes,
      response.headers.get("content-type"),
      responseMode
    );
    const savedOutput =
      String(args.output_path || "").trim().length > 0
        ? await saveServiceRequestOutputToWorkspace({
            bytes,
            outputPath: String(args.output_path || ""),
            taskId: args.task_id,
          })
        : null;

    if (!response.ok && args.allow_non_2xx !== true) {
      throw new Error(
        `service_request ${method} ${targetUrl} returned ${response.status} ${response.statusText}: ${truncateResponseSnippet(
          parsedBody
        )}`
      );
    }

    return {
      body_base64: savedOutput && parsedBody.isBinary ? null : parsedBody.base64,
      body_json: parsedBody.json,
      body_text: parsedBody.text,
      content_type: response.headers.get("content-type"),
      headers: selectSafeResponseHeaders(response.headers),
      is_binary: parsedBody.isBinary,
      method,
      output_saved: Boolean(savedOutput),
      saved_output: savedOutput,
      service_name: service.service_name,
      status: response.status,
      status_text: response.statusText,
      success: response.ok,
      url: response.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRouteAction(value: string | undefined): RouteAction {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "upsert" || normalized === "delete" || normalized === "verify") {
    return normalized;
  }

  throw new Error("public_site_route requires action=upsert|delete|verify");
}

function normalizeServiceRequestServiceName(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    throw new Error("service_request requires service_name");
  }

  return normalized;
}

function normalizeServiceRequestMethod(value: string | undefined): string {
  const normalized = String(value || "GET")
    .trim()
    .toUpperCase();

  if (!normalized) {
    return "GET";
  }

  return normalized;
}

function normalizeServiceRequestAuthMode(
  value: string | undefined
): ServiceRequestAuthMode {
  const normalized = String(value || "bearer")
    .trim()
    .toLowerCase();

  if (
    normalized === "bearer" ||
    normalized === "basic" ||
    normalized === "header" ||
    normalized === "none" ||
    normalized === "x-api-key"
  ) {
    return normalized;
  }

  throw new Error(
    "service_request auth_mode must be bearer, basic, header, x-api-key, or none"
  );
}

function getDefaultServiceBaseUrl(serviceName: string): string | null {
  return DEFAULT_SERVICE_BASE_URLS[serviceName] || null;
}

function getDefaultServiceRequestAuthDefaults(
  serviceName: string
): ServiceRequestAuthDefaults {
  return DEFAULT_SERVICE_AUTH_DEFAULTS[String(serviceName || "").trim().toLowerCase()] || {};
}

function getDefaultServiceRequestHeaders(
  serviceName: string
): Record<string, string> {
  const normalized = String(serviceName || "")
    .trim()
    .toLowerCase();

  if (normalized === "gohighlevel") {
    return {
      Accept: "application/json",
      Version: "2021-07-28",
    };
  }

  return {};
}

function normalizeServiceResponseMode(
  value: string | undefined
): ServiceRequestResponseMode {
  const normalized = String(value || "auto")
    .trim()
    .toLowerCase();

  if (
    normalized === "auto" ||
    normalized === "base64" ||
    normalized === "json" ||
    normalized === "text"
  ) {
    return normalized;
  }

  throw new Error("service_request response_mode must be auto, json, text, or base64");
}

function buildServiceRequestUrl(args: {
  baseUrl: string | null;
  path?: string;
  query?: Record<string, unknown>;
  url?: string;
}): string {
  const baseUrl = String(args.baseUrl || "").trim();
  const explicitUrl = String(args.url || "").trim();
  const path = String(args.path || "").trim();

  if (!explicitUrl && !path) {
    throw new Error("service_request requires path or url");
  }

  if (!baseUrl && !explicitUrl) {
    throw new Error(
      "service_request needs either an explicit url or a service base_url/default base URL"
    );
  }

  const resolvedBase = baseUrl ? new URL(baseUrl) : null;
  const target = explicitUrl
    ? new URL(explicitUrl)
    : new URL(path.replace(/^\/*/, ""), ensureTrailingSlash(resolvedBase!.toString()));

  if (resolvedBase && target.origin !== resolvedBase.origin) {
    throw new Error(
      `service_request url origin '${target.origin}' must match service base origin '${resolvedBase.origin}'`
    );
  }

  for (const [key, value] of Object.entries(normalizeServiceRequestQuery(args.query))) {
    target.searchParams.set(key, value);
  }

  return target.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeServiceRequestQuery(
  value: Record<string, unknown> | undefined
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const query: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }

    query[String(key)] = String(entry);
  }

  return query;
}

function buildServiceRequestHeaders(args: {
  authHeaderName?: string;
  authMode: ServiceRequestAuthMode;
  authPrefix?: string;
  credential: string;
  credentialField?: string;
  headers?: Record<string, unknown>;
}): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(args.headers || {})) {
    if (value === undefined || value === null) {
      continue;
    }

    headers[String(key)] = String(value);
  }

  const credentialValue = selectServiceCredentialValue(
    args.credential,
    args.credentialField
  );
  if (!credentialValue || args.authMode === "none") {
    return headers;
  }

  if (args.authMode === "bearer") {
    headers.Authorization = `${String(args.authPrefix || "Bearer ").trimEnd()} ${credentialValue}`.trim();
    return headers;
  }

  if (args.authMode === "basic") {
    headers.Authorization = `${String(args.authPrefix || "Basic ").trimEnd()} ${credentialValue}`.trim();
    return headers;
  }

  if (args.authMode === "x-api-key") {
    headers[String(args.authHeaderName || "x-api-key")] = credentialValue;
    return headers;
  }

  headers[String(args.authHeaderName || "Authorization")] = `${String(
    args.authPrefix || ""
  )}${credentialValue}`;
  return headers;
}

function buildServiceRequestBody(
  body: unknown,
  headers: Record<string, string>
): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  const contentTypeKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === "content-type"
  );
  const contentType = contentTypeKey ? headers[contentTypeKey] : "";

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const params = new URLSearchParams();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined || value === null) {
          continue;
        }
        params.set(key, String(value));
      }
    } else {
      throw new Error(
        "service_request form-urlencoded bodies must be provided as an object"
      );
    }
    return params.toString();
  }

  if (!contentTypeKey) {
    headers["Content-Type"] = "application/json";
  }

  return JSON.stringify(body);
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

function selectServiceCredentialValue(
  rawCredential: string,
  requestedField?: string
): string {
  const credential = String(rawCredential || "").trim();
  if (!credential) {
    throw new Error("service_request requires a non-empty service credential");
  }

  const fields = extractStructuredCredentialFields(credential);
  if (requestedField) {
    const selected = fields[requestedField.trim().toLowerCase()];
    if (!selected) {
      throw new Error(
        `service_request could not find credential field '${requestedField}'`
      );
    }
    return selected;
  }

  for (const fieldName of COMMON_CREDENTIAL_FIELDS) {
    if (fields[fieldName]) {
      return fields[fieldName];
    }
  }

  const lines = credential
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 1) {
    const singleLineMatch = lines[0].match(/^[^:]+:\s*(.+)$/);
    return singleLineMatch ? singleLineMatch[1].trim() : lines[0];
  }

  if (Object.keys(fields).length === 1) {
    return Object.values(fields)[0]!;
  }

  return credential;
}

function parseServiceResponseBody(
  bytes: Uint8Array,
  contentType: string | null,
  responseMode: ServiceRequestResponseMode
): {
  base64: string | null;
  isBinary: boolean;
  json: unknown | null;
  text: string | null;
} {
  if (!bytes.length) {
    return {
      base64: null,
      isBinary: false,
      json: null,
      text: null,
    };
  }

  const decodedText = decodeServiceResponseText(bytes);
  const likelyJson =
    Boolean(contentType && /json|javascript/i.test(contentType)) ||
    Boolean(decodedText && /^[\[{]/.test(decodedText.trim()));
  const likelyText =
    responseMode === "text" ||
    (responseMode === "auto" && isLikelyTextResponse(contentType, decodedText));

  if (responseMode === "json" || (responseMode === "auto" && likelyJson)) {
    const trimmed = String(decodedText || "").trim();
    if (trimmed) {
      try {
        return {
          base64: null,
          isBinary: false,
          json: JSON.parse(trimmed),
          text: null,
        };
      } catch {
        if (responseMode === "json") {
          throw new Error("service_request response_mode=json could not parse JSON");
        }
      }
    }
  }

  if (responseMode === "base64") {
    return {
      base64: Buffer.from(bytes).toString("base64"),
      isBinary: true,
      json: null,
      text: null,
    };
  }

  if (likelyText) {
    return {
      base64: null,
      isBinary: false,
      json: null,
      text: decodedText,
    };
  }

  return {
    base64: Buffer.from(bytes).toString("base64"),
    isBinary: true,
    json: null,
    text: null,
  };
}

async function saveServiceRequestOutputToWorkspace(args: {
  bytes: Uint8Array;
  outputPath: string;
  taskId?: string;
}): Promise<{
  absolute_path: string;
  size_bytes: number;
  workspace_path: string;
}> {
  const taskId = String(args.taskId || "").trim();
  if (!taskId) {
    throw new Error("service_request output_path requires task_id");
  }

  const workspacePath = normalizeWorkspaceOutputPath(args.outputPath);
  const workspaceRoot = resolve(config.workspacesDir, taskId);
  const targetPath = resolve(workspaceRoot, workspacePath);
  const workspaceRootPrefix = workspaceRoot.endsWith(sep)
    ? workspaceRoot
    : `${workspaceRoot}${sep}`;

  if (targetPath !== workspaceRoot && !targetPath.startsWith(workspaceRootPrefix)) {
    throw new Error("service_request output_path must stay inside the task workspace");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(args.bytes));

  return {
    absolute_path: targetPath,
    size_bytes: args.bytes.length,
    workspace_path: workspacePath,
  };
}

function normalizeWorkspaceOutputPath(value: string): string {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!normalized) {
    throw new Error("service_request output_path must be a non-empty workspace-relative path");
  }

  return normalized;
}

function selectSafeResponseHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (/^set-cookie$/i.test(key)) {
      continue;
    }
    selected[key] = value;
  }
  return selected;
}

function decodeServiceResponseText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isLikelyTextResponse(
  contentType: string | null,
  decodedText: string | null
): boolean {
  if (
    contentType &&
    /(?:^audio\/|^image\/|^video\/|application\/(?:octet-stream|pdf|zip|gzip|x-gzip))/i.test(
      contentType
    )
  ) {
    return false;
  }

  if (
    contentType &&
    /(?:^text\/|json|javascript|xml|html|svg|csv|x-www-form-urlencoded)/i.test(
      contentType
    )
  ) {
    return true;
  }

  if (!decodedText) {
    return false;
  }

  const sample = decodedText.slice(0, 256);
  if (!sample) {
    return false;
  }

  const replacementCount = Array.from(sample).filter((char) => char === "\uFFFD").length;
  return replacementCount <= Math.max(1, Math.floor(sample.length / 20));
}

function truncateResponseSnippet(
  value:
    | string
    | {
        base64: string | null;
        isBinary: boolean;
        json: unknown | null;
        text: string | null;
      },
  maxLength = 1200
): string {
  const raw =
    typeof value === "string"
      ? value
      : value.text ??
        (value.json !== null
          ? JSON.stringify(value.json)
          : value.base64
            ? `[binary:${value.base64.length} base64 chars]`
            : "");
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3).trim()}...`;
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30_000;
  }

  return Math.max(1_000, Math.min(parsed, 120_000));
}

function normalizeRootDomain(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");

  if (!normalized) {
    throw new Error("public_site_route requires ROOT_DOMAIN to be configured");
  }

  return normalized;
}

function normalizeHostname(value: string | undefined, rootDomain: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");

  if (!normalized) {
    throw new Error("public_site_route requires hostname");
  }

  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    throw new Error(`Invalid hostname '${normalized}'`);
  }

  if (!normalized.endsWith(`.${rootDomain}`)) {
    throw new Error(`Hostname '${normalized}' must be under ${rootDomain}`);
  }

  if (normalized === rootDomain) {
    throw new Error("public_site_route only manages subdomains, not the root domain");
  }

  return normalized;
}

function normalizeTargetPath(value: string | null | undefined): string {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new Error("public_site_route upsert requires target_path");
  }

  if (!normalized.startsWith("/")) {
    throw new Error("target_path must start with '/'");
  }

  if (/[?#]/.test(normalized)) {
    throw new Error("target_path must not include a query string or fragment");
  }

  if (normalized === "/") {
    return normalized;
  }

  return normalized.replace(/\/+$/, "");
}

function buildSnippet(hostname: string, targetPath: string): string {
  const lines = [`${hostname} {`, "  encode zstd gzip"];

  if (targetPath !== "/") {
    lines.push(`  rewrite * ${targetPath}{uri}`);
  }

  lines.push("  reverse_proxy public:80", "}", "");
  return lines.join("\n");
}

function normalizeServiceAction(value: string | undefined): "reload" | "restart" | "status" {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "status" || normalized === "restart" || normalized === "reload") {
    return normalized;
  }

  throw new Error("service_control requires action=status|restart|reload");
}

function normalizeRequestedServices(
  args: { service?: string; services?: string[] },
  action: "reload" | "restart" | "status"
): ManagedServiceName[] {
  const combined = [
    ...(typeof args.service === "string" ? [args.service] : []),
    ...(Array.isArray(args.services) ? args.services : []),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!combined.length) {
    if (action === "status") {
      return [...MANAGED_SERVICES];
    }

    throw new Error("service_control restart/reload requires service or services");
  }

  const deduped = [...new Set(combined)];
  for (const service of deduped) {
    if (!MANAGED_SERVICES.includes(service as ManagedServiceName)) {
      throw new Error(`service_control does not allow service '${service}'`);
    }
  }

  return deduped as ManagedServiceName[];
}

function resolveComposeRuntime(): ComposeRuntime {
  const explicitProject = normalizeEnv("COMPOSE_PROJECT");
  const explicitService = normalizeEnv("COMPOSE_CURRENT_SERVICE");
  const explicitContainerId = normalizeEnv("COMPOSE_CURRENT_CONTAINER_ID");

  if (explicitProject && explicitService) {
    return {
      currentContainerId: explicitContainerId || null,
      currentService: explicitService,
      project: explicitProject,
    };
  }

  const currentContainerId = explicitContainerId || normalizeEnv("HOSTNAME");
  if (!currentContainerId) {
    throw new Error(
      "Compose runtime requires COMPOSE_PROJECT and COMPOSE_CURRENT_SERVICE or HOSTNAME"
    );
  }

  const [inspect] = inspectContainers([currentContainerId]);
  const labels = inspect?.Config?.Labels || {};
  const project = labels["com.docker.compose.project"];
  const currentService = labels["com.docker.compose.service"];

  if (!project || !currentService) {
    throw new Error("Compose runtime could not resolve the current Compose project");
  }

  return {
    currentContainerId,
    currentService,
    project,
  };
}

function inspectServices(
  runtime: ComposeRuntime,
  services: readonly ManagedServiceName[]
): ManagedServiceStatus[] {
  return services.map((service) => {
    const containerId = findLatestServiceContainerId(runtime, service);

    if (!containerId) {
      const classification = classifyManagedServiceState(service, "missing", null);
      return {
        attention_required: classification.attention_required,
        container_id: null,
        container_name: null,
        health: null,
        ip_addresses: [],
        lifecycle: SERVICE_LIFECYCLE[service].lifecycle,
        lifecycle_note: SERVICE_LIFECYCLE[service].note,
        self_target: false,
        service,
        state: "missing",
        status_reason: classification.status_reason,
      };
    }

    const [inspect] = inspectContainers([containerId]);
    const state = inspect?.State || {};
    const networks = inspect?.NetworkSettings?.Networks || {};
    const health = state.Health?.Status || null;
    const normalizedState =
      state.Status || (state.Running ? "running" : "stopped") || "unknown";
    const classification = classifyManagedServiceState(service, normalizedState, health);

    return {
      attention_required: classification.attention_required,
      container_id: inspect.Id,
      container_name: inspect.Name ? inspect.Name.replace(/^\/+/, "") : null,
      health,
      ip_addresses: Object.values(networks)
        .map((network) => network.IPAddress || "")
        .filter(Boolean),
      lifecycle: SERVICE_LIFECYCLE[service].lifecycle,
      lifecycle_note: SERVICE_LIFECYCLE[service].note,
      self_target: runtime.currentContainerId
        ? inspect.Id.startsWith(runtime.currentContainerId)
        : false,
      service,
      state: normalizedState,
      status_reason: classification.status_reason,
    };
  });
}

function classifyManagedServiceState(
  service: ManagedServiceName,
  state: string,
  health: string | null
): { attention_required: boolean; status_reason: string } {
  const lifecycle = SERVICE_LIFECYCLE[service];
  if (lifecycle.lifecycle === "manual") {
    if (lifecycle.idle_states?.includes(state)) {
      return {
        attention_required: false,
        status_reason: "Manual-profile service is idle, which is expected when no task is using it.",
      };
    }

    if (state === "running" && health === "unhealthy") {
      return {
        attention_required: true,
        status_reason: "Manual-profile service is active but unhealthy.",
      };
    }

    if (state === "running") {
      return {
        attention_required: false,
        status_reason: "Manual-profile service is running and available.",
      };
    }

    return {
      attention_required: true,
      status_reason: `Manual-profile service is in unexpected state '${state}'.`,
    };
  }

  if (state !== "running") {
    return {
      attention_required: true,
      status_reason: `Always-on service is not running (state '${state}').`,
    };
  }

  if (health === "unhealthy") {
    return {
      attention_required: true,
      status_reason: "Always-on service is running but unhealthy.",
    };
  }

  return {
    attention_required: false,
    status_reason: "Always-on service is running normally.",
  };
}

function inspectContainers(containerIds: string[]): DockerInspectResult[] {
  if (!containerIds.length) {
    return [];
  }

  const output = runDocker(["inspect", ...containerIds]);
  return JSON.parse(output) as DockerInspectResult[];
}

function findLatestServiceContainerId(
  runtime: ComposeRuntime,
  service: ManagedServiceName
): string | null {
  const containerId = runDocker([
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=${runtime.project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--latest",
  ]).trim();

  return containerId || null;
}

function runDocker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "docker command failed").trim());
  }

  return result.stdout.trim();
}

function readSnippetContents(containerId: string, snippetPath: string): string | null {
  const result = spawnSync(
    "docker",
    ["exec", containerId, "sh", "-lc", `cat '${snippetPath}' 2>/dev/null || true`],
    {
      encoding: "utf8",
      timeout: 30000,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "docker command failed").trim());
  }

  const contents = result.stdout;
  return contents ? contents : null;
}

async function writeSnippet(
  containerId: string,
  snippetPath: string,
  contents: string
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-os-route-"));
  const tempPath = join(tempDir, "snippet.caddy");

  try {
    await writeFile(tempPath, contents, "utf8");
    runDocker(["cp", tempPath, `${containerId}:${snippetPath}`]);
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function removeSnippet(containerId: string, snippetPath: string): void {
  runDocker(["exec", containerId, "sh", "-lc", `rm -f '${snippetPath}'`]);
}

function reloadService(
  containerId: string,
  service: ManagedServiceName
): Record<string, unknown> {
  const command = RELOAD_COMMANDS[service];
  if (!command) {
    throw new Error(`service_control does not support reload for '${service}'`);
  }

  runDocker(["exec", containerId, ...command]);

  const [updatedState] = inspectContainers([containerId]);
  return {
    action: "reload",
    container_id: containerId,
    service,
    state: updatedState?.State?.Status || "unknown",
  };
}

function restartService(
  serviceState: ManagedServiceStatus,
  currentContainerId: string | null
): Record<string, unknown> {
  const containerId = serviceState.container_id!;

  if (currentContainerId && containerId.startsWith(currentContainerId)) {
    queueSelfRestart(containerId);
    return {
      action: "restart",
      queued: true,
      self_target: true,
      service: serviceState.service,
      state: "queued",
    };
  }

  if (serviceState.state === "running") {
    runDocker(["restart", containerId]);
  } else {
    runDocker(["start", containerId]);
  }

  const [updatedState] = inspectContainers([containerId]);
  return {
    action: "restart",
    container_id: containerId,
    service: serviceState.service,
    self_target: false,
    state: updatedState?.State?.Status || "unknown",
  };
}

function queueSelfRestart(containerId: string): void {
  const child = spawn("sh", ["-lc", `sleep 1; docker restart ${containerId}`], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

function normalizeEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function shouldBlockServiceRequestForService(service: RemoteMcpServiceRow): boolean {
  return Boolean(service.credential?.trim()) && hasConfiguredRemoteMcpServer(service);
}

export const controlPlaneTestHooks = {
  buildServiceRequestHeaders,
  buildServiceRequestUrl,
  extractStructuredCredentialFields,
  getDefaultServiceBaseUrl,
  getDefaultServiceRequestAuthDefaults,
  getDefaultServiceRequestHeaders,
  normalizeServiceResponseMode,
  normalizeWorkspaceOutputPath,
  parseServiceResponseBody,
  saveServiceRequestOutputToWorkspace,
  selectServiceCredentialValue,
  shouldBlockServiceRequestForService,
};
