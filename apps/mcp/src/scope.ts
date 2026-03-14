import { getDb } from "./db.js";
import { getAgentContext } from "./context.js";

export type ScopeType =
  | "task"
  | "project"
  | "customer"
  | "role"
  | "department"
  | "company";

export interface TaskContext {
  id: string;
  project_id: string | null;
  assigned_role: string;
  claimed_by: string | null;
  state: string;
}

const ACTIVE_TASK_STATES = [
  "claimed",
  "running",
  "blocked_on_agent",
  "in_review",
] as const;

async function loadTask(taskId: string): Promise<TaskContext | null> {
  const db = getDb();
  const { data, error } = await db
    .from("tasks")
    .select("id, project_id, assigned_role, claimed_by, state")
    .eq("id", taskId)
    .maybeSingle<TaskContext>();

  if (error) {
    throw new Error(`Failed to load task '${taskId}': ${error.message}`);
  }

  return data || null;
}

export async function getCurrentTaskContext(): Promise<TaskContext | null> {
  const db = getDb();
  const ctx = getAgentContext();

  const { data, error } = await db
    .from("tasks")
    .select("id, project_id, assigned_role, claimed_by, state")
    .eq("claimed_by", ctx.agent_id)
    .in("state", [...ACTIVE_TASK_STATES])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<TaskContext>();

  if (error) {
    throw new Error(`Failed to resolve current task context: ${error.message}`);
  }

  return data || null;
}

export async function requireCurrentTaskContext(): Promise<TaskContext> {
  const task = await getCurrentTaskContext();
  if (!task) {
    throw new Error("This action requires an active claimed task context");
  }
  return task;
}

export async function requireTaskClaimedByCurrentAgent(
  taskId: string
): Promise<TaskContext> {
  const ctx = getAgentContext();
  const task = await loadTask(taskId);

  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.claimed_by !== ctx.agent_id) {
    throw new Error(`Task '${taskId}' is not claimed by the current agent`);
  }

  return task;
}

export async function checkScope(
  scopeType: ScopeType | string,
  scopeId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const ctx = getAgentContext();
  const db = getDb();
  const currentTask = await getCurrentTaskContext();

  if (scopeType === "company") {
    return { allowed: true };
  }

  if (scopeType === "role") {
    if (scopeId === ctx.role_id) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Role scope '${scopeId}' does not match your role '${ctx.role_id}'`,
    };
  }

  if (scopeType === "department") {
    return {
      allowed: false,
      reason: "Department scope enforcement is not implemented yet",
    };
  }

  if (scopeType === "customer") {
    return {
      allowed: false,
      reason: "Customer scope enforcement is not implemented yet",
    };
  }

  if (scopeType === "task") {
    const task = await loadTask(scopeId);
    if (!task) {
      return { allowed: false, reason: `Task '${scopeId}' not found` };
    }

    if (task.claimed_by === ctx.agent_id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Task '${scopeId}' is outside the current agent's claimed scope`,
    };
  }

  if (scopeType === "project") {
    if (currentTask?.project_id === scopeId) {
      return { allowed: true };
    }

    const { count, error } = await db
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", scopeId)
      .eq("claimed_by", ctx.agent_id)
      .in("state", [...ACTIVE_TASK_STATES]);

    if (error) {
      return {
        allowed: false,
        reason: `Failed to verify project scope '${scopeId}': ${error.message}`,
      };
    }

    if (count && count > 0) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Project '${scopeId}' is outside the current agent's claimed scope`,
    };
  }

  return { allowed: false, reason: `Unknown scope type '${scopeType}'` };
}

export async function enforceScope(
  scopeType: ScopeType | string,
  scopeId: string
): Promise<void> {
  const result = await checkScope(scopeType, scopeId);
  if (!result.allowed) {
    throw new Error(`Scope denied: ${result.reason}`);
  }
}
