import { getDb } from "../db.js";
import { enforceScope } from "../scope.js";

export const contextRefreshDef = {
  name: "context_refresh",
  description:
    "Re-fetch the context pack for a task mid-run. Useful when state may have changed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string" },
    },
    required: ["task_id"],
  },
};

export async function contextRefresh(args: {
  task_id: string;
}): Promise<unknown> {
  const db = getDb();
  await enforceScope("task", args.task_id);

  const { data, error } = await db.rpc("build_context_pack", {
    p_task_id: args.task_id,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, context_pack: data };
}
