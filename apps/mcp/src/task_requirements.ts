import { getAgentContext } from "./context.js";
import { getDb } from "./db.js";

export type TaskRequirementType = "public_route" | "service_active" | "url_status";
export type TaskRequirementStatus = "blocked" | "failed" | "passed" | "pending";

export async function upsertTaskRequirement(args: {
  taskId: string;
  requirementType: TaskRequirementType;
  target: string;
  expected?: Record<string, unknown>;
  status: TaskRequirementStatus;
  requiredForCompletion?: boolean;
  lastResult?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const db = getDb();
  const ctx = getAgentContext();
  const normalizedTarget = args.target.trim();

  const payload = {
    task_id: args.taskId,
    requirement_type: args.requirementType,
    target: normalizedTarget,
    expected: args.expected || {},
    status: args.status,
    required_for_completion: args.requiredForCompletion !== false,
    last_result: args.lastResult || {},
    created_by: ctx.agent_id,
    updated_at: new Date().toISOString(),
  };

  const { data: existing, error: loadError } = await db
    .from("task_requirements")
    .select("id")
    .eq("task_id", args.taskId)
    .eq("requirement_type", args.requirementType)
    .eq("target", normalizedTarget)
    .maybeSingle<{ id: string }>();

  if (loadError) {
    throw new Error(`Failed to load task requirement: ${loadError.message}`);
  }

  if (existing?.id) {
    const { data, error } = await db
      .from("task_requirements")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single<Record<string, unknown>>();

    if (error) {
      throw new Error(`Failed to update task requirement: ${error.message}`);
    }

    return data;
  }

  const { data, error } = await db
    .from("task_requirements")
    .insert(payload)
    .select()
    .single<Record<string, unknown>>();

  if (error) {
    throw new Error(`Failed to create task requirement: ${error.message}`);
  }

  return data;
}
