import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { requireTaskClaimedByCurrentAgent } from "../scope.js";

export const approvalRequestDef = {
  name: "approval_request",
  description:
    "Request human sign-off for a high-stakes action. Blocks the task until approved or rejected.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string" },
      action_type: {
        type: "string",
        description:
          'e.g. "payment", "deploy_prod", "system_modify", "data_delete"',
      },
      description: {
        type: "string",
        description: "What you want to do and why",
      },
      context: {
        type: "object",
        description: "Relevant data: amounts, affected items, risk",
      },
    },
    required: ["task_id", "action_type", "description"],
  },
};

export async function approvalRequest(args: {
  task_id: string;
  action_type: string;
  description: string;
  context?: Record<string, unknown>;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  const task = await requireTaskClaimedByCurrentAgent(args.task_id);

  const { data: approval, error } = await db
    .from("approvals")
    .insert({
      task_id: task.id,
      agent_id: ctx.agent_id,
      action_type: args.action_type,
      description: args.description,
      context: args.context || {},
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  const { error: blockErr } = await db
    .from("tasks")
    .update({
      state: "blocked_on_human",
      blocked_reason: `Awaiting approval: ${args.action_type} - ${args.description}`,
      last_handoff_note: `Requested approval for ${args.action_type}: ${args.description}`,
    })
    .eq("id", task.id)
    .eq("claimed_by", ctx.agent_id);

  if (blockErr) {
    return {
      success: true,
      approval,
      warning: `Approval created but task state update failed: ${blockErr.message}`,
    };
  }

  return { success: true, approval };
}
