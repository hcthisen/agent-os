import { spawn } from "node:child_process";
import {
  MANAGED_SERVICES,
  inspectContainers,
  inspectServices,
  resolveComposeRuntime,
  runDocker,
  type ManagedServiceName,
  type ManagedServiceStatus,
} from "../compose_runtime.js";
import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { getCurrentTaskContext } from "../scope.js";

const RELOAD_COMMANDS: Record<string, string[]> = {
  caddy: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
  public: ["nginx", "-s", "reload"],
};

type AllowedService = ManagedServiceName;
type ServiceControlAction = "reload" | "restart" | "status";

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
      return [...MANAGED_SERVICES];
    }

    throw new Error("service_control restart/reload requires service or services");
  }

  const deduped = [...new Set(combined)];
  for (const service of deduped) {
    if (!MANAGED_SERVICES.includes(service as AllowedService)) {
      throw new Error(`service_control does not allow service '${service}'`);
    }
  }

  return deduped as AllowedService[];
}

async function restartService(
  serviceState: ManagedServiceStatus,
  currentContainerId: string | null
): Promise<Record<string, unknown>> {
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
