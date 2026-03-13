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

  // Find launchable ready tasks for this role, ordered by priority.
  const { data: readyTasks, error } = await db
    .from("tasks")
    .select("*")
    .eq("state", "ready")
    .eq("assigned_role", ctx.role_id)
    .order("priority")
    .order("created_at")
    .limit(25);

  if (error || !readyTasks?.length) {
    return { success: false, reason: "No ready tasks for your role" };
  }

  const dependencyIds = [
    ...new Set(
      readyTasks.flatMap((task) => (Array.isArray(task.depends_on) ? task.depends_on : []))
    ),
  ];
  let dependencyStateMap = new Map<string, { id: string; state: string; title: string }>();

  if (dependencyIds.length) {
    const { data: dependencyTasks, error: dependencyError } = await db
      .from("tasks")
      .select("id,state,title")
      .in("id", dependencyIds)
      .returns<Array<{ id: string; state: string; title: string }>>();

    if (dependencyError) {
      return { success: false, reason: dependencyError.message };
    }

    dependencyStateMap = new Map(
      (dependencyTasks || []).map((task) => [task.id, task])
    );
  }

  const task = readyTasks.find((candidate) =>
    (candidate.depends_on || []).every((dependencyId: string) => {
      const dependencyTask = dependencyStateMap.get(dependencyId);
      return dependencyTask?.state === "completed";
    })
  );

  if (!task) {
    const waitingTask = readyTasks[0];
    const waitingOn = (waitingTask.depends_on || [])
      .map((dependencyId: string) => dependencyStateMap.get(dependencyId))
      .filter(Boolean)
      .map(
        (dependency: { id: string; state: string; title: string }) =>
          `${dependency.title} (${dependency.id.slice(0, 8)}) [${dependency.state}]`
      );
    return {
      success: false,
      reason:
        waitingOn.length > 0
          ? `No launchable ready tasks; waiting on dependencies: ${waitingOn.join(", ")}`
          : "No launchable ready tasks; one or more dependencies could not be resolved",
    };
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
