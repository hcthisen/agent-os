import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";

export const handoffCreateDef = {
  name: "handoff_create",
  description:
    "Hand off work to another agent or role. Records what was done, what changed, blockers, and next steps.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string" },
      to_agent_id: {
        type: "string",
        description: "Specific agent UUID, if known",
      },
      to_role_id: {
        type: "string",
        description: "Or hand off to a role (system picks agent)",
      },
      summary: { type: "string", description: "What was done" },
      changes_made: {
        type: "array",
        items: { type: "string" },
      },
      blockers: {
        type: "array",
        items: { type: "string" },
      },
      next_steps: {
        type: "array",
        items: { type: "string" },
      },
      context_snapshot: {
        type: "object",
        description: "Key facts for the next agent",
      },
    },
    required: ["task_id", "summary"],
  },
};

export async function handoffCreate(args: {
  task_id: string;
  to_agent_id?: string;
  to_role_id?: string;
  summary: string;
  changes_made?: string[];
  blockers?: string[];
  next_steps?: string[];
  context_snapshot?: Record<string, unknown>;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  await assertTaskMutationAllowed("handoff_create");

  await enforceScope("task", args.task_id);

  const { data, error } = await db
    .from("handoffs")
    .insert({
      task_id: args.task_id,
      from_agent_id: ctx.agent_id,
      to_agent_id: args.to_agent_id || null,
      to_role_id: args.to_role_id || null,
      summary: args.summary,
      changes_made: args.changes_made || [],
      blockers: args.blockers || [],
      next_steps: args.next_steps || [],
      context_snapshot: args.context_snapshot || {},
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, handoff: data };
}
