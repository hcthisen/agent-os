import { spawn, spawnSync } from "node:child_process";
import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { getCurrentTaskContext } from "../scope.js";

const ALLOWED_SERVICES = [
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
] as const;

const RELOAD_COMMANDS: Record<string, string[]> = {
  caddy: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
  public: ["nginx", "-s", "reload"],
};

type AllowedService = (typeof ALLOWED_SERVICES)[number];
type ServiceControlAction = "reload" | "restart" | "status";

interface DockerInspectState {
  ExitCode?: number;
  Health?: {
    Status?: string;
  };
  Running?: boolean;
  StartedAt?: string;
  Status?: string;
}

interface DockerInspectConfig {
  Labels?: Record<string, string>;
}

interface DockerInspectNetworkSettings {
  Networks?: Record<string, { IPAddress?: string }>;
}

interface DockerInspectResult {
  Config?: DockerInspectConfig;
  Id: string;
  Name?: string;
  NetworkSettings?: DockerInspectNetworkSettings;
  State?: DockerInspectState;
}

interface ComposeRuntime {
  currentContainerId: string;
  currentService: string;
  project: string;
}

interface ManagedServiceStatus {
  container_id: string | null;
  container_name: string | null;
  health: string | null;
  ip_addresses: string[];
  self_target: boolean;
  service: string;
  state: string;
}

export const serviceControlDef = {
  name: "service_control",
  description:
    "Inspect, restart, or reload allowlisted VPS services through the managed Docker runtime. Use reload for Caddy or Nginx; use restart for other services.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        description: "One of: status, restart, reload.",
        enum: ["status", "restart", "reload"],
      },
      service: {
        type: "string",
        description:
          "Single service name. Allowed: admin, auth, autoheal, browser, caddy, db, mcp, public, realtime, rest, storage, supervisor.",
      },
      services: {
        type: "array",
        description:
          "Optional batch form of service. Only allowed service names may be used.",
        items: {
          type: "string",
        },
      },
    },
    required: ["action"],
  },
};

export async function serviceControl(args: {
  action?: string;
  service?: string;
  services?: string[];
}): Promise<unknown> {
  const action = normalizeAction(args.action);
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

  const task = await getCurrentTaskContext();
  if (!task) {
    throw new Error("service_control restart/reload requires an active claimed task");
  }

  const results: Array<Record<string, unknown>> = [];

  for (const serviceState of serviceStates) {
    if (!serviceState.container_id) {
      throw new Error(`Service '${serviceState.service}' is not running in project '${runtime.project}'`);
    }

    if (action === "reload") {
      results.push(await reloadService(serviceState));
      continue;
    }

    results.push(await restartService(serviceState, runtime.currentContainerId));
  }

  await logServiceControlEvent(action, results, task.id);

  return {
    action,
    current_service: runtime.currentService,
    project: runtime.project,
    results,
    success: true,
    warning:
      results.some((entry) => entry.self_target === true) &&
      action === "restart"
        ? "A self-targeted restart was queued. The current agent run may terminate when the supervisor container restarts."
        : undefined,
  };
}

function normalizeAction(value: string | undefined): ServiceControlAction {
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
  action: ServiceControlAction
): AllowedService[] {
  const combined = [
    ...(typeof args.service === "string" ? [args.service] : []),
    ...(Array.isArray(args.services) ? args.services : []),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!combined.length) {
    if (action === "status") {
      return [...ALLOWED_SERVICES];
    }

    throw new Error("service_control restart/reload requires service or services");
  }

  const deduped = [...new Set(combined)];
  for (const service of deduped) {
    if (!ALLOWED_SERVICES.includes(service as AllowedService)) {
      throw new Error(`service_control does not allow service '${service}'`);
    }
  }

  return deduped as AllowedService[];
}

function resolveComposeRuntime(): ComposeRuntime {
  const currentContainerId = String(process.env.HOSTNAME || "").trim();
  if (!currentContainerId) {
    throw new Error("service_control requires HOSTNAME to resolve the current container");
  }

  const [inspect] = inspectContainers([currentContainerId]);
  const labels = inspect?.Config?.Labels || {};
  const project = labels["com.docker.compose.project"];
  const currentService = labels["com.docker.compose.service"];

  if (!project || !currentService) {
    throw new Error("service_control could not resolve the current Compose project");
  }

  return {
    currentContainerId,
    currentService,
    project,
  };
}

function inspectServices(
  runtime: ComposeRuntime,
  services: AllowedService[]
): ManagedServiceStatus[] {
  return services.map((service) => inspectService(runtime, service));
}

function inspectService(
  runtime: ComposeRuntime,
  service: AllowedService
): ManagedServiceStatus {
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
    self_target: inspect.Id.startsWith(runtime.currentContainerId),
    service,
    state: state.Status || (state.Running ? "running" : "stopped") || "unknown",
  };
}

async function restartService(
  serviceState: ManagedServiceStatus,
  currentContainerId: string
): Promise<Record<string, unknown>> {
  const containerId = serviceState.container_id!;

  if (containerId.startsWith(currentContainerId)) {
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

async function reloadService(
  serviceState: ManagedServiceStatus
): Promise<Record<string, unknown>> {
  const command = RELOAD_COMMANDS[serviceState.service];
  if (!command) {
    throw new Error(`service_control does not support reload for '${serviceState.service}'`);
  }

  if (serviceState.state !== "running") {
    throw new Error(`Cannot reload '${serviceState.service}' because it is not running`);
  }

  runDocker(["exec", serviceState.container_id!, ...command]);
  const [updatedState] = inspectContainers([serviceState.container_id!]);

  return {
    action: "reload",
    container_id: serviceState.container_id,
    service: serviceState.service,
    self_target: serviceState.self_target,
    state: updatedState?.State?.Status || "unknown",
  };
}

async function logServiceControlEvent(
  action: ServiceControlAction,
  results: Array<Record<string, unknown>>,
  taskId: string
): Promise<void> {
  const db = getDb();
  const ctx = getAgentContext();

  const { error } = await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "service.control",
    severity: "info",
    scope_type: "task",
    scope_id: taskId,
    summary: `${action} service operation executed`,
    detail: {
      action,
      results,
    },
  });

  if (error) {
    console.error("Failed to record service control event:", error);
  }
}

function queueSelfRestart(containerId: string): void {
  const child = spawn("sh", ["-lc", `sleep 1; docker restart ${containerId}`], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

function inspectContainers(containerIds: string[]): DockerInspectResult[] {
  if (!containerIds.length) {
    return [];
  }

  const output = runDocker(["inspect", ...containerIds]);
  return JSON.parse(output) as DockerInspectResult[];
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
