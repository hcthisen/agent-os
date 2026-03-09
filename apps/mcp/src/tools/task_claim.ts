import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";

export const taskClaimDef = {
  name: "task_claim",
  description:
    "Claim the next ready task for your role. Returns the task or null if none available.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function taskClaim(): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();

  // Check how many tasks this agent already has running/claimed
  const { count: activeCount } = await db
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("claimed_by", ctx.agent_id)
    .in("state", ["claimed", "running"]);

  // Check role's max_concurrent_tasks
  const { data: role } = await db
    .from("roles")
    .select("max_concurrent_tasks")
    .eq("id", ctx.role_id)
    .single();

  if (role && activeCount !== null && activeCount >= role.max_concurrent_tasks) {
    return { success: false, reason: "Max concurrent tasks reached" };
  }

  // Find next ready task for this role, ordered by priority
  const priorityOrder = ["critical", "high", "normal", "low"];
  const { data: task, error } = await db
    .from("tasks")
    .select("*")
    .eq("state", "ready")
    .eq("assigned_role", ctx.role_id)
    .order("priority")
    .order("created_at")
    .limit(1)
    .single();

  if (error || !task) {
    return { success: false, reason: "No ready tasks for your role" };
  }

  // Claim it
  const { data: claimed, error: claimErr } = await db
    .from("tasks")
    .update({ state: "claimed", claimed_by: ctx.agent_id })
    .eq("id", task.id)
    .eq("state", "ready") // optimistic lock
    .select()
    .single();

  if (claimErr || !claimed) {
    return { success: false, reason: "Task was claimed by another agent" };
  }

  return { success: true, task: claimed };
}
