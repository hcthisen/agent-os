import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import cronParser from "cron-parser";

export const scheduleCreateDef = {
  name: "schedule_create",
  description:
    "Create a recurring schedule that spawns tasks on a cron expression.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Unique schedule name",
      },
      cron_expr: {
        type: "string",
        description: "Cron expression, e.g. */5 * * * *",
      },
      assigned_role: {
        type: "string",
        description: "Role that will receive the generated task",
      },
      title: {
        type: "string",
        description: "Generated task title",
      },
      objective: {
        type: "string",
        description: "Generated task objective",
      },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" },
        description: "Generated task acceptance criteria",
      },
      priority: {
        type: "string",
        enum: ["critical", "high", "normal", "low"],
        default: "normal",
      },
      enabled: {
        type: "boolean",
        default: true,
      },
      project_id: {
        type: "string",
        description: "Optional project for generated tasks",
      },
    },
    required: ["name", "cron_expr", "assigned_role", "title", "objective"],
  },
};

export async function scheduleCreate(args: {
  name: string;
  cron_expr: string;
  assigned_role: string;
  title: string;
  objective: string;
  acceptance_criteria?: string[];
  priority?: string;
  enabled?: boolean;
  project_id?: string;
}): Promise<unknown> {
  await requireCurrentTaskContext();

  const db = getDb();
  const cronExpr = args.cron_expr.trim();
  const scheduleName = args.name.trim();

  const { data, error } = await db
    .from("schedules")
    .insert({
      name: scheduleName,
      cron_expr: cronExpr,
      assigned_role: args.assigned_role,
      enabled: args.enabled ?? true,
      next_run_at: calculateNextRun(cronExpr),
      task_template: {
        title: args.title,
        objective: args.objective,
        acceptance_criteria: args.acceptance_criteria || [],
        priority: args.priority || "normal",
        project_id: args.project_id || null,
      },
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, schedule: data };
}

function calculateNextRun(cronExpr: string): string {
  try {
    return cronParser
      .parseExpression(cronExpr.trim(), { currentDate: new Date() })
      .next()
      .toDate()
      .toISOString();
  } catch {
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }
}
