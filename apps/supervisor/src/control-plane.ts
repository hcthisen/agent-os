import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  container_id: string | null;
  container_name: string | null;
  health: string | null;
  ip_addresses: string[];
  self_target: boolean;
  service: ManagedServiceName;
  state: string;
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

function normalizeRouteAction(value: string | undefined): RouteAction {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "upsert" || normalized === "delete" || normalized === "verify") {
    return normalized;
  }

  throw new Error("public_site_route requires action=upsert|delete|verify");
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
      return {
        container_id: null,
        container_name: null,
        health: null,
        ip_addresses: [],
        self_target: false,
        service,
        state: "missing",
      };
    }

    const [inspect] = inspectContainers([containerId]);
    const state = inspect?.State || {};
    const networks = inspect?.NetworkSettings?.Networks || {};
    const health = state.Health?.Status || null;

    return {
      container_id: inspect.Id,
      container_name: inspect.Name ? inspect.Name.replace(/^\/+/, "") : null,
      health,
      ip_addresses: Object.values(networks)
        .map((network) => network.IPAddress || "")
        .filter(Boolean),
      self_target: runtime.currentContainerId
        ? inspect.Id.startsWith(runtime.currentContainerId)
        : false,
      service,
      state: state.Status || (state.Running ? "running" : "stopped") || "unknown",
    };
  });
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
