import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { getCurrentTaskContext } from "../scope.js";
import { callSupervisorControl } from "../supervisor-control.js";

const MANAGED_SERVICES = [
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

type AllowedService = (typeof MANAGED_SERVICES)[number];
type ServiceControlAction = "reload" | "restart" | "status";

export const serviceControlDef = {
  name: "service_control",
  description:
    "Inspect, restart, or reload allowlisted VPS services through the managed supervisor control plane. Use reload for Caddy or Nginx; use restart for other services.",
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
  const requestedServices = normalizeRequestedServices(args, action);
  const task = await getCurrentTaskContext();

  if (action !== "status" && !task) {
    throw new Error("service_control restart/reload requires an active claimed task");
  }

  const result = await callSupervisorControl<Record<string, unknown>>(
    "/control/service-control",
    {
      action,
      service: args.service,
      services: requestedServices,
    }
  );

  if (task) {
    const results = Array.isArray(result.results)
      ? (result.results as Array<Record<string, unknown>>)
      : [];
    await logServiceControlEvent(action, results, task.id);
  }

  return result;
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
