import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { enforceScope, getCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";

export const taskCreateDef = {
  name: "task_create",
  description:
    "Create a new task or sub-task, delegated to a specific role. Use depends_on to create staged follow-up tasks that stay queued until prerequisite tasks complete.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string" },
      objective: { type: "string" },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" },
      },
      assigned_role: { type: "string" },
      priority: {
        type: "string",
        enum: ["critical", "high", "normal", "low"],
        default: "normal",
      },
      parent_task_id: {
        type: "string",
        description: "Parent task UUID for sub-tasks",
      },
      depends_on: {
        type: "array",
        description:
          "Optional prerequisite task UUIDs. The new task stays queued until every dependency is completed.",
        items: { type: "string" },
      },
      project_id: { type: "string" },
      customer_id: { type: "string" },
      department_id: { type: "string" },
      is_system_modification: { type: "boolean", default: false },
      state: {
        type: "string",
        enum: ["backlog", "ready"],
        default: "ready",
      },
    },
    required: ["title", "objective", "assigned_role"],
  },
};

export async function taskCreate(args: {
  title: string;
  objective: string;
  acceptance_criteria?: string[];
  assigned_role: string;
  priority?: string;
  parent_task_id?: string;
  depends_on?: string[];
  project_id?: string;
  customer_id?: string;
  department_id?: string;
  is_system_modification?: boolean;
  state?: string;
}): Promise<unknown> {
  const db = getDb();
  await assertTaskMutationAllowed("task_create");
  const currentTask = await getCurrentTaskContext();
  const parentTaskId = args.parent_task_id || currentTask?.id || null;
  let dependencyIds = normalizeDependencyIdsForParent(args.depends_on || [], parentTaskId);
  let projectId = args.project_id || null;
  let parentProjectId: string | null = null;
  let customerId = String(args.customer_id || "").trim() || currentTask?.customer_id || null;
  let departmentId =
    String(args.department_id || "").trim() || currentTask?.department_id || null;

  if (parentTaskId) {
    await enforceScope("task", parentTaskId);

    const { data: parentTask, error: parentError } = await db
      .from("tasks")
      .select("id, project_id, customer_id, department_id")
      .eq("id", parentTaskId)
      .maybeSingle<{
        id: string;
        project_id: string | null;
        customer_id: string | null;
        department_id: string | null;
      }>();

    if (parentError) {
      return { success: false, error: parentError.message };
    }

    if (!parentTask) {
      return {
        success: false,
        error: `Parent task '${parentTaskId}' not found`,
      };
    }

    parentProjectId = parentTask.project_id;
    customerId = customerId || parentTask.customer_id;
    departmentId = departmentId || parentTask.department_id;
  }

  if (projectId) {
    await enforceScope("project", projectId);
  } else if (parentProjectId) {
    projectId = parentProjectId;
  } else if (!currentTask) {
    return {
      success: false,
      error: "task_create requires an active task context, parent_task_id, or project_id",
    };
  }

  if (projectId && parentProjectId && projectId !== parentProjectId) {
    return {
      success: false,
      error: "Child tasks cannot be created in a different project than their parent task",
    };
  }

  if (customerId) {
    await enforceScope("customer", customerId);
  }

  if (departmentId) {
    await enforceScope("department", departmentId);
  }

  if (currentTask?.id && parentTaskId === currentTask.id) {
    const requiredDownstreamRole = await loadRequiredDownstreamRole(currentTask.id);
    if (requiredDownstreamRole && args.assigned_role !== requiredDownstreamRole) {
      return {
        success: false,
        error: `This task must first delegate to '${requiredDownstreamRole}' before creating '${args.assigned_role}' child tasks.`,
      };
    }
  }

  if (parentTaskId) {
    const rootTask = await loadRootTaskContext(parentTaskId);
    const hasRequirementsWalkthroughBlockers =
      rootTask?.id
        ? await hasUnresolvedRequirementsWalkthroughBlockers(rootTask.id)
        : false;
    if (
      shouldBlockRequirementsWalkthroughDelegation(
        rootTask,
        args.assigned_role,
        hasRequirementsWalkthroughBlockers
      )
    ) {
      return {
        success: false,
        error:
          "This request explicitly asked what the system still needs. Finish the requirements walkthrough and send the operator a concrete checklist before creating implementation tasks.",
      };
    }
  }

  if (dependencyIds.length) {
    for (const dependencyId of dependencyIds) {
      await enforceScope("task", dependencyId);
    }

    const { data: dependencyTasks, error: dependencyError } = await db
      .from("tasks")
      .select("id, project_id")
      .in("id", dependencyIds)
      .returns<Array<{ id: string; project_id: string | null }>>();

    if (dependencyError) {
      return { success: false, error: dependencyError.message };
    }

    const dependencyMap = new Map(
      (dependencyTasks || []).map((task) => [task.id, task])
    );

    for (const dependencyId of dependencyIds) {
      const dependencyTask = dependencyMap.get(dependencyId);
      if (!dependencyTask) {
        return {
          success: false,
          error: `Dependency task '${dependencyId}' not found`,
        };
      }

      if (
        projectId &&
        dependencyTask.project_id &&
        dependencyTask.project_id !== projectId
      ) {
        return {
          success: false,
          error: `Dependency task '${dependencyId}' belongs to a different project`,
        };
      }
    }
  }

  let duplicateQuery = db
    .from("tasks")
    .select("id,state,acceptance_criteria,depends_on")
    .eq("title", args.title)
    .eq("objective", args.objective)
    .eq("assigned_role", args.assigned_role)
    .in("state", [
      "backlog",
      "ready",
      "claimed",
      "running",
      "blocked_on_agent",
      "in_review",
    ]);

  duplicateQuery = parentTaskId
    ? duplicateQuery.eq("parent_task_id", parentTaskId)
    : duplicateQuery.is("parent_task_id", null);
  duplicateQuery = projectId
    ? duplicateQuery.eq("project_id", projectId)
    : duplicateQuery.is("project_id", null);

  const { data: existingTask, error: existingTaskError } = await duplicateQuery.returns<
    Array<{
      acceptance_criteria: string[] | null;
      depends_on: string[] | null;
      id: string;
      state: string;
    }>
  >();

  if (existingTaskError) {
    return { success: false, error: existingTaskError.message };
  }

  const normalizedAcceptanceCriteria = JSON.stringify(args.acceptance_criteria || []);
  const normalizedDependencies = JSON.stringify([...dependencyIds].sort());
  const duplicateTask = (existingTask || []).find((task) => {
    const existingAcceptanceCriteria = JSON.stringify(task.acceptance_criteria || []);
    const existingDependencies = JSON.stringify([...(task.depends_on || [])].sort());
    return (
      existingAcceptanceCriteria === normalizedAcceptanceCriteria &&
      existingDependencies === normalizedDependencies
    );
  });

  if (duplicateTask) {
    return {
      success: true,
      task: duplicateTask,
      deduplicated: true,
    };
  }

  const taskId = randomUUID();
  const insertPayload = {
    id: taskId,
    title: args.title,
    objective: args.objective,
    acceptance_criteria: args.acceptance_criteria || [],
    assigned_role: args.assigned_role,
    priority: args.priority || "normal",
    parent_task_id: parentTaskId,
    depends_on: dependencyIds,
    project_id: projectId,
    customer_id: customerId,
    department_id: departmentId,
    is_system_modification: args.is_system_modification || false,
    state: args.state || "ready",
  };

  const { error } = await db
    .from("tasks")
    .insert(insertPayload);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, task: insertPayload };
}

function normalizeDependencyIdsForParent(
  dependencyIds: string[],
  parentTaskId: string | null
): string[] {
  const normalized = [...new Set(dependencyIds.map((value) => value.trim()).filter(Boolean))];
  if (!parentTaskId) {
    return normalized;
  }

  return normalized.filter((dependencyId) => dependencyId !== parentTaskId);
}

async function loadRequiredDownstreamRole(taskId: string): Promise<string | null> {
  const db = getDb();
  const { data, error } = await db
    .from("task_requirements")
    .select("expected,status")
    .eq("task_id", taskId)
    .eq("requirement_type", "downstream_task")
    .eq("required_for_completion", true)
    .in("status", ["pending", "blocked", "failed"])
    .order("created_at")
    .limit(1)
    .maybeSingle<{ expected?: Record<string, unknown> | null; status: string }>();

  if (error) {
    return null;
  }

  const recommendedRole =
    typeof data?.expected?.recommended_role === "string"
      ? data.expected.recommended_role.trim()
      : "";

  return recommendedRole || null;
}

interface RootTaskContext {
  assigned_role: string;
  id: string;
  objective: string | null;
  parent_task_id: string | null;
  title: string;
}

async function loadRootTaskContext(taskId: string): Promise<RootTaskContext | null> {
  const db = getDb();
  let currentTaskId: string | null = taskId;
  const visited = new Set<string>();
  let currentTask: RootTaskContext | null = null;

  while (currentTaskId) {
    if (visited.has(currentTaskId)) {
      break;
    }

    visited.add(currentTaskId);
    const response = await db
      .from("tasks")
      .select("id,title,objective,parent_task_id,assigned_role")
      .eq("id", currentTaskId)
      .maybeSingle<RootTaskContext>();
    const data = response.data as RootTaskContext | null;
    const error = response.error;

    if (error || !data) {
      return currentTask;
    }

    currentTask = data;
    currentTaskId = data.parent_task_id;
  }

  return currentTask;
}

async function hasUnresolvedRequirementsWalkthroughBlockers(
  taskId: string
): Promise<boolean> {
  const db = getDb();
  const { count, error } = await db
    .from("task_requirements")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("required_for_completion", true)
    .in("status", ["blocked", "failed"])
    .neq("requirement_type", "downstream_task");

  if (error) {
    return true;
  }

  return (count || 0) > 0;
}

function shouldBlockRequirementsWalkthroughDelegation(
  rootTask: RootTaskContext | null,
  assignedRole: string,
  hasRequirementsWalkthroughBlockers: boolean
): boolean {
  if (!rootTask) {
    return false;
  }

  const rootLooksLikeRelayRequest =
    rootTask.assigned_role === "relay" ||
    /^Process message:/i.test(rootTask.title);
  if (!rootLooksLikeRelayRequest) {
    return false;
  }

  const objective = String(rootTask.objective || "");
  if (!/Requirements walkthrough requested:\s*yes/i.test(objective)) {
    return false;
  }

  if (!hasRequirementsWalkthroughBlockers) {
    return false;
  }

  return !["relay", "sage"].includes(assignedRole);
}

export const taskCreateTestHooks = {
  hasUnresolvedRequirementsWalkthroughBlockers,
  normalizeDependencyIdsForParent,
  shouldBlockRequirementsWalkthroughDelegation,
};
