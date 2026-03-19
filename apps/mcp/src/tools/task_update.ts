import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";

const ACTIVE_CHILD_TASK_STATES = [
  "backlog",
  "ready",
  "claimed",
  "running",
  "blocked_on_agent",
  "blocked_on_human",
  "in_review",
] as const;

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
  const requestedState = String(args.state || "").trim();
  const holdForChildren = await shouldHoldCompletionForActiveChildren(
    db,
    args.task_id,
    requestedState
  );

  const updatePayload: Record<string, unknown> = {
    state: holdForChildren ? "blocked_on_agent" : requestedState,
  };
  if (args.last_handoff_note)
    updatePayload.last_handoff_note = args.last_handoff_note;
  if (holdForChildren) {
    updatePayload.blocked_reason =
      args.blocked_reason ||
      "Waiting for downstream child tasks to finish before this task can conclude.";
  } else if (args.blocked_reason) {
    updatePayload.blocked_reason = args.blocked_reason;
  }

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

async function shouldHoldCompletionForActiveChildren(
  db: ReturnType<typeof getDb>,
  taskId: string,
  requestedState: string
): Promise<boolean> {
  if (!shouldBlockCompletionForActiveChildren(requestedState)) {
    return false;
  }

  const { count, error } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("parent_task_id", taskId)
    .in("state", [...ACTIVE_CHILD_TASK_STATES]);

  if (error) {
    return false;
  }

  return (count || 0) > 0;
}

function shouldBlockCompletionForActiveChildren(requestedState: string): boolean {
  return String(requestedState || "").trim().toLowerCase() === "completed";
}

export const taskUpdateTestHooks = {
  shouldBlockCompletionForActiveChildren,
};
