import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope } from "../scope.js";

export const eventLogDef = {
  name: "event_log",
  description:
    "Log a side effect or occurrence. Every action that changes something outside your working directory must be logged.",
  inputSchema: {
    type: "object" as const,
    properties: {
      event_type: {
        type: "string",
        description:
          'Namespaced type, e.g. "task.claimed", "email.sent", "deploy.triggered"',
      },
      severity: {
        type: "string",
        enum: ["info", "warning", "error", "critical"],
        default: "info",
      },
      scope_type: {
        type: "string",
        enum: ["task", "project", "customer", "role", "department", "company"],
      },
      scope_id: { type: "string" },
      summary: { type: "string", description: "Human-readable one-liner" },
      detail: {
        type: "object",
        description: "Structured metadata",
      },
    },
    required: ["event_type", "scope_type", "scope_id", "summary"],
  },
};

export async function eventLog(args: {
  event_type: string;
  severity?: string;
  scope_type: string;
  scope_id: string;
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();

  await enforceScope(args.scope_type, args.scope_id);

  const { data, error } = await db
    .from("events")
    .insert({
      trace_id: ctx.trace_id,
      agent_id: ctx.agent_id,
      event_type: args.event_type,
      severity: args.severity || "info",
      scope_type: args.scope_type,
      scope_id: args.scope_id,
      summary: args.summary,
      detail: args.detail || {},
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, event: data };
}
