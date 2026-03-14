import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { getCurrentTaskContext } from "../scope.js";
import {
  buildSkillContent,
  loadLatestSkillMemoryByName,
  loadSkillMemoryById,
  parseSkillMemory,
} from "../skill-memory.js";

export const skillLogUseDef = {
  name: "skill_log_use",
  description:
    "Record that a skill was used, incrementing usage counters and emitting a task-scoped skill.used event.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      task_id: { type: "string" },
      outcome: {
        type: "string",
        enum: ["success", "partial", "failed"],
        default: "success",
      },
      notes: { type: "string" },
    },
  },
};

export async function skillLogUse(args: {
  id?: string;
  name?: string;
  task_id?: string;
  outcome?: "success" | "partial" | "failed";
  notes?: string;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  const currentTask = await getCurrentTaskContext();
  const memory = args.id
    ? await loadSkillMemoryById(String(args.id).trim())
    : args.name
      ? await loadLatestSkillMemoryByName(String(args.name).trim())
      : null;

  if (!memory) {
    throw new Error("Skill not found");
  }

  const skill = parseSkillMemory(memory);
  const now = new Date().toISOString();
  const nextContent = buildSkillContent({
    name: skill.name,
    description: skill.description,
    display_name: skill.display_name,
    input_schema: skill.input_schema,
    last_used_at: now,
    output_schema: skill.output_schema,
    required_services: skill.required_services,
    steps: skill.steps,
    trigger_when: skill.trigger_when,
    use_count: skill.use_count + 1,
    version: skill.version,
  });

  const { error: updateError } = await db
    .from("memories")
    .update({
      content: nextContent,
      updated_at: now,
    })
    .eq("id", memory.id);

  if (updateError) {
    throw new Error(`Failed to update skill usage: ${updateError.message}`);
  }

  const scopeTaskId = String(args.task_id || currentTask?.id || "").trim();
  const { error: eventError } = await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "skill.used",
    severity: args.outcome === "failed" ? "warning" : "info",
    scope_type: scopeTaskId ? "task" : "company",
    scope_id: scopeTaskId || "system",
    summary: `Skill '${skill.name}' used with outcome '${args.outcome || "success"}'.`,
    detail: {
      notes: String(args.notes || "").trim() || null,
      outcome: args.outcome || "success",
      skill_id: memory.id,
      skill_name: skill.name,
      task_id: scopeTaskId || null,
      use_count: skill.use_count + 1,
    },
  });

  if (eventError) {
    throw new Error(`Failed to log skill usage event: ${eventError.message}`);
  }

  return { success: true };
}
