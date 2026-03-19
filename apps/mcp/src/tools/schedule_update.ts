import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";
import cronParser from "cron-parser";

export const scheduleUpdateDef = {
  name: "schedule_update",
  description:
    "Update a schedule's cron expression or enabled state. Use for approved live schedule changes such as sentinel cadence.",
  inputSchema: {
    type: "object" as const,
    properties: {
      schedule_id: {
        type: "string",
        description: "Schedule UUID. Provide this or name.",
      },
      name: {
        type: "string",
        description: "Schedule name. Provide this or schedule_id.",
      },
      cron_expr: {
        type: "string",
        description: "New cron expression, e.g. */30 * * * *",
      },
      enabled: {
        type: "boolean",
        description: "Whether the schedule should be enabled.",
      },
      timezone: {
        type: "string",
        description:
          "IANA timezone for evaluating the cron expression, for example Europe/Copenhagen.",
      },
    },
  },
};

export async function scheduleUpdate(args: {
  schedule_id?: string;
  name?: string;
  cron_expr?: string;
  enabled?: boolean;
  timezone?: string;
}): Promise<unknown> {
  await assertTaskMutationAllowed("schedule_update");
  await requireCurrentTaskContext();

  if (!args.schedule_id && !args.name) {
    throw new Error("schedule_update requires schedule_id or name");
  }

  if (
    args.cron_expr === undefined &&
    args.enabled === undefined &&
    args.timezone === undefined
  ) {
    throw new Error("schedule_update requires cron_expr, timezone, or enabled");
  }

  const db = getDb();
  const updatePayload: Record<string, unknown> = {};

  if (typeof args.enabled === "boolean") {
    updatePayload.enabled = args.enabled;
  }

  const timezone =
    typeof args.timezone === "string" && args.timezone.trim()
      ? args.timezone.trim()
      : undefined;

  if (timezone) {
    updatePayload.timezone = timezone;
  }

  if (typeof args.cron_expr === "string" && args.cron_expr.trim()) {
    updatePayload.cron_expr = args.cron_expr.trim();
    updatePayload.next_run_at = calculateNextRun(
      args.cron_expr,
      timezone || String(process.env.AGENT_OS_TIMEZONE || process.env.TZ || "UTC")
    );
  } else if (timezone) {
    const scheduleLookup = await loadExistingSchedule(db, args);
    if (!scheduleLookup) {
      return { success: false, error: "Schedule not found" };
    }

    updatePayload.next_run_at = calculateNextRun(scheduleLookup.cron_expr, timezone);
  }

  let query = db.from("schedules").update(updatePayload);
  if (args.schedule_id) {
    query = query.eq("id", args.schedule_id);
  } else {
    query = query.eq("name", args.name!.trim());
  }

  const { data, error } = await query.select().single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, schedule: data };
}

async function loadExistingSchedule(
  db: ReturnType<typeof getDb>,
  args: { name?: string; schedule_id?: string }
): Promise<{ cron_expr: string } | null> {
  let query = db.from("schedules").select("cron_expr").limit(1);
  query = args.schedule_id ? query.eq("id", args.schedule_id) : query.eq("name", args.name!.trim());
  const { data, error } = await query.maybeSingle<{ cron_expr: string }>();
  if (error || !data) {
    return null;
  }

  return data;
}

function calculateNextRun(cronExpr: string, timezone: string): string {
  try {
    return cronParser
      .parseExpression(cronExpr.trim(), {
        currentDate: new Date(),
        tz: timezone || undefined,
      })
      .next()
      .toDate()
      .toISOString();
  } catch {
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }
}
