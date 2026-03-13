import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { upsertTaskRequirement } from "../task_requirements.js";

interface ServiceRow {
  auth_type: string;
  base_url: string | null;
  credential: string | null;
  description: string;
  display_name: string;
  error_message: string | null;
  id: string;
  service_name: string;
  status: string;
  updated_at: string;
}

export const serviceRequireDef = {
  name: "service_require",
  description:
    "Register or check a required external service for the current task. Creates a Settings > Service Connections slot when missing and records a task-level completion requirement.",
  inputSchema: {
    type: "object" as const,
    properties: {
      service_name: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      base_url: { type: "string" },
      required_for_completion: {
        type: "boolean",
        default: true,
      },
      note: {
        type: "string",
        description: "Why this task needs the service.",
      },
    },
    required: ["service_name"],
  },
};

export async function serviceRequire(args: {
  service_name?: string;
  display_name?: string;
  description?: string;
  base_url?: string;
  required_for_completion?: boolean;
  note?: string;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  const task = await requireCurrentTaskContext();
  const serviceName = normalizeServiceName(args.service_name);
  const displayName = String(args.display_name || serviceName).trim() || serviceName;
  const description =
    String(args.description || "").trim() ||
    `Required by task '${task.id}' for the current implementation.`;

  let service = await loadService(serviceName);
  if (!service) {
    const { data, error } = await db
      .from("service_registry")
      .insert({
        auth_type: "api_key",
        base_url: normalizeOptionalUrl(args.base_url),
        credential: null,
        description,
        display_name: displayName,
        registered_by: ctx.agent_id,
        service_name: serviceName,
        status: "key_needed",
      })
      .select(
        "id,service_name,display_name,description,base_url,auth_type,credential,status,error_message,updated_at"
      )
      .single<ServiceRow>();

    if (error) {
      throw new Error(`Failed to register required service '${serviceName}': ${error.message}`);
    }

    service = data;
  } else {
    const patch = buildServicePatch(service, {
      baseUrl: args.base_url,
      description,
      displayName,
    });

    if (patch) {
      const { data, error } = await db
        .from("service_registry")
        .update({
          ...patch,
          updated_at: new Date().toISOString(),
        })
        .eq("id", service.id)
        .select(
          "id,service_name,display_name,description,base_url,auth_type,credential,status,error_message,updated_at"
        )
        .single<ServiceRow>();

      if (error) {
        throw new Error(`Failed to update service '${serviceName}': ${error.message}`);
      }

      service = data;
    }
  }

  const ready = service.status === "active" && Boolean(service.credential);
  const requirement = await upsertTaskRequirement({
    expected: {
      allow_statuses: ["active"],
      display_name: service.display_name,
      note: String(args.note || "").trim() || null,
    },
    lastResult: {
      checked_at: new Date().toISOString(),
      display_name: service.display_name,
      error_message: service.error_message,
      service_status: service.status,
    },
    requirementType: "service_active",
    requiredForCompletion: args.required_for_completion !== false,
    status: ready ? "passed" : service.status === "error" ? "failed" : "blocked",
    target: service.service_name,
    taskId: task.id,
  });

  await logServiceRequirementEvent({
    note: args.note,
    ready,
    service,
    taskId: task.id,
  });

  return {
    success: true,
    ready,
    guidance: ready
      ? null
      : `Service '${service.service_name}' is not ready. Add or repair the credential in Settings > Service Connections before completing this task.`,
    service,
    task_requirement: requirement,
  };
}

function normalizeServiceName(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    throw new Error("service_require requires service_name");
  }

  return normalized;
}

function normalizeOptionalUrl(value: string | undefined): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function buildServicePatch(
  service: ServiceRow,
  args: {
    baseUrl?: string;
    description: string;
    displayName: string;
  }
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const nextBaseUrl = normalizeOptionalUrl(args.baseUrl);

  if (!service.display_name && args.displayName) {
    patch.display_name = args.displayName;
  } else if (service.display_name !== args.displayName && service.display_name === service.service_name) {
    patch.display_name = args.displayName;
  }

  if ((!service.description || !service.description.trim()) && args.description) {
    patch.description = args.description;
  }

  if (!service.base_url && nextBaseUrl) {
    patch.base_url = nextBaseUrl;
  }

  return Object.keys(patch).length ? patch : null;
}

async function loadService(serviceName: string): Promise<ServiceRow | null> {
  const db = getDb();
  const { data, error } = await db
    .from("service_registry")
    .select(
      "id,service_name,display_name,description,base_url,auth_type,credential,status,error_message,updated_at"
    )
    .eq("service_name", serviceName)
    .maybeSingle<ServiceRow>();

  if (error) {
    throw new Error(`Failed to load service '${serviceName}': ${error.message}`);
  }

  return data || null;
}

async function logServiceRequirementEvent(args: {
  note?: string;
  ready: boolean;
  service: ServiceRow;
  taskId: string;
}): Promise<void> {
  const db = getDb();
  const ctx = getAgentContext();
  const { error } = await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "service.require",
    severity: args.ready ? "info" : "warning",
    scope_type: "task",
    scope_id: args.taskId,
    summary: args.ready
      ? `Verified required service '${args.service.service_name}' is active.`
      : `Required service '${args.service.service_name}' needs operator attention.`,
    detail: {
      note: String(args.note || "").trim() || null,
      service_name: args.service.service_name,
      service_status: args.service.status,
    },
  });

  if (error) {
    console.error("Failed to record service requirement event:", error);
  }
}
