import { getDb } from "../db.js";
import { enforceScope, getCurrentTaskContext } from "../scope.js";

export const taskCreateDef = {
  name: "task_create",
  description: "Create a new task or sub-task, delegated to a specific role.",
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
      project_id: { type: "string" },
      requires_approval: { type: "boolean", default: false },
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
  project_id?: string;
  requires_approval?: boolean;
  is_system_modification?: boolean;
  state?: string;
}): Promise<unknown> {
  const db = getDb();
  const currentTask = await getCurrentTaskContext();
  const parentTaskId = args.parent_task_id || currentTask?.id || null;
  let projectId = args.project_id || null;
  let parentProjectId: string | null = null;

  if (parentTaskId) {
    await enforceScope("task", parentTaskId);

    const { data: parentTask, error: parentError } = await db
      .from("tasks")
      .select("id, project_id")
      .eq("id", parentTaskId)
      .maybeSingle<{ id: string; project_id: string | null }>();

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

  const { data, error } = await db
    .from("tasks")
    .insert({
      title: args.title,
      objective: args.objective,
      acceptance_criteria: args.acceptance_criteria || [],
      assigned_role: args.assigned_role,
      priority: args.priority || "normal",
      parent_task_id: parentTaskId,
      project_id: projectId,
      requires_approval: args.requires_approval || false,
      is_system_modification: args.is_system_modification || false,
      state: args.state || "ready",
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, task: data };
}
