import { getDb } from "./db.js";
import { getAgentContext } from "./context.js";
import { requireTaskClaimedByCurrentAgent } from "./scope.js";

export async function checkPolicy(
  actionType: string,
  taskId: string,
  description: string
): Promise<{ proceed: boolean; approval_id?: string; reason?: string }> {
  const db = getDb();
  const ctx = getAgentContext();
  const task = await requireTaskClaimedByCurrentAgent(taskId);

  const { data: role, error: roleError } = await db
    .from("roles")
    .select("requires_approval_for")
    .eq("id", ctx.role_id)
    .single<{ requires_approval_for: string[] }>();

  if (roleError) {
    return {
      proceed: false,
      reason: `Failed to load approval policy for role '${ctx.role_id}': ${roleError.message}`,
    };
  }

  const requiresApproval = role?.requires_approval_for || [];
  const needsApproval = requiresApproval.some((pattern) => {
    if (pattern === "*" || pattern === actionType) {
      return true;
    }

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return actionType.startsWith(`${prefix}.`);
    }

    return false;
  });

  if (!needsApproval) {
    return { proceed: true };
  }

  const { data: existing, error: existingError } = await db
    .from("approvals")
    .select("id")
    .eq("task_id", task.id)
    .eq("action_type", actionType)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (existingError) {
    return {
      proceed: false,
      reason: `Approval check failed for task '${task.id}': ${existingError.message}`,
    };
  }

  if (existing) {
    return {
      proceed: false,
      approval_id: existing.id,
      reason: `Approval already pending (${existing.id}). Waiting for human review.`,
    };
  }

  const { data: approval, error: approvalError } = await db
    .from("approvals")
    .insert({
      task_id: task.id,
      agent_id: ctx.agent_id,
      action_type: actionType,
      description: `[Auto-policy] ${description}`,
      context: { triggered_by: "policy_enforcement", role_id: ctx.role_id },
    })
    .select("id")
    .single<{ id: string }>();

  if (approvalError) {
    return {
      proceed: false,
      reason: `Policy requires approval but creation failed: ${approvalError.message}`,
    };
  }

  const { error: blockError } = await db
    .from("tasks")
    .update({
      state: "blocked_on_human",
      blocked_reason: `Policy requires approval for '${actionType}'`,
      last_handoff_note: `Auto-blocked by policy: ${actionType} - ${description}`,
    })
    .eq("id", task.id)
    .eq("claimed_by", ctx.agent_id);

  if (blockError) {
    return {
      proceed: false,
      approval_id: approval.id,
      reason: `Approval ${approval.id} created, but blocking task '${task.id}' failed: ${blockError.message}`,
    };
  }

  return {
    proceed: false,
    approval_id: approval.id,
    reason: `Your role requires approval for '${actionType}'. Approval ${approval.id} created. Task blocked until approved.`,
  };
}
