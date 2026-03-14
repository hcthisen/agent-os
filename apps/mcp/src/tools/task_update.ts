import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";

export const taskUpdateDef = {
  name: "task_update",
  description:
    "Update a task's state. The database trigger enforces valid transitions. Handoff note required when leaving running/blocked/failed states.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string", description: "Task UUID" },
      state: {
        type: "string",
        enum: [
          "running",
          "blocked_on_agent",
          "in_review",
          "completed",
          "failed",
          "ready",
        ],
      },
      last_handoff_note: {
        type: "string",
        description:
          "Required when leaving running/blocked/failed. What you did, what changed, what's blocked, what to do next.",
      },
      blocked_reason: {
        type: "string",
        description: "Required when entering blocked states.",
      },
    },
    required: ["task_id", "state"],
  },
};

export async function taskUpdate(args: {
  task_id: string;
  state: string;
  last_handoff_note?: string;
  blocked_reason?: string;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();

  const updatePayload: Record<string, unknown> = { state: args.state };
  if (args.last_handoff_note)
    updatePayload.last_handoff_note = args.last_handoff_note;
  if (args.blocked_reason) updatePayload.blocked_reason = args.blocked_reason;

  const { data, error } = await db
    .from("tasks")
    .update(updatePayload)
    .eq("id", args.task_id)
    .eq("claimed_by", ctx.agent_id)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, task: data };
}
