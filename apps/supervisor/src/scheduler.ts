import { getDb } from "./db.js";
import cronParser from "cron-parser";

interface ScheduleTaskTemplate {
  acceptance_criteria?: unknown;
  objective?: unknown;
  priority?: unknown;
  project_id?: unknown;
  title?: unknown;
}

interface ScheduleRow {
  assigned_role: string;
  created_at: string;
  cron_expr: string;
  id: string;
  last_run_at: string | null;
  name: string;
  next_run_at: string | null;
  task_template: Record<string, unknown> | null;
  timezone?: string | null;
}

/**
 * Check schedules and create tasks for any that have fired.
 */
export async function checkSchedules(): Promise<void> {
  const db = getDb();
  const now = new Date();

  await reconcileLegacySchedules();

  const { data: schedules, error } = await db
    .from("schedules")
    .select("*")
    .eq("enabled", true)
    .returns<ScheduleRow[]>();

  if (error || !schedules?.length) return;

  for (const schedule of schedules) {
    // Check if it's time to fire
    const nextRun = schedule.next_run_at
      ? new Date(schedule.next_run_at)
      : null;

    if (nextRun && nextRun > now) continue;

    // Calculate next run from cron expression
    const nextRunAt = calculateNextRun(schedule.cron_expr, schedule.timezone || undefined);
    const nowIso = now.toISOString();
    const template = (schedule.task_template || {}) as ScheduleTaskTemplate;
    const title =
      typeof template.title === "string" && template.title.trim()
        ? template.title.trim()
        : schedule.name;
    const projectId =
      typeof template.project_id === "string" && template.project_id.trim()
        ? template.project_id.trim()
        : null;
    const lastRunAt = schedule.last_run_at || null;
    const windowStart = lastRunAt || schedule.created_at;

    let duplicateQuery = db
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("title", title)
      .eq("assigned_role", schedule.assigned_role)
      .gt("created_at", windowStart);

    duplicateQuery = projectId
      ? duplicateQuery.eq("project_id", projectId)
      : duplicateQuery.is("project_id", null);

    const { count: duplicateCount, error: duplicateError } = await duplicateQuery;
    if (duplicateError) {
      console.error(`Failed to check duplicate scheduled tasks for ${schedule.name}:`, duplicateError);
      continue;
    }

    if (duplicateCount && duplicateCount > 0) {
      const advanced = await updateScheduleRunWindow(
        schedule.id,
        lastRunAt,
        nowIso,
        nextRunAt
      );
      if (!advanced) {
        console.warn(`Skipped duplicate scheduled task for ${schedule.name} after lock contention`);
      }
      continue;
    }

    const locked = await updateScheduleRunWindow(
      schedule.id,
      lastRunAt,
      nowIso,
      nextRunAt
    );
    if (!locked) {
      continue;
    }

    // Create the task from template
    const { error: taskErr } = await db.from("tasks").insert({
      title,
      objective:
        typeof template.objective === "string" ? template.objective : "",
      acceptance_criteria: Array.isArray(template.acceptance_criteria)
        ? template.acceptance_criteria
        : [],
      priority:
        typeof template.priority === "string" ? template.priority : "normal",
      project_id: projectId,
      state: "ready",
      assigned_role: schedule.assigned_role,
    });

    if (taskErr) {
      console.error(`Failed to create scheduled task for ${schedule.name}:`, taskErr);
      const rolledBack = await updateScheduleRunWindow(
        schedule.id,
        nowIso,
        lastRunAt,
        schedule.next_run_at
      );
      if (!rolledBack) {
        console.warn(
          `Failed to roll back schedule lock for ${schedule.name} after task creation error`
        );
      }
      continue;
    }

    console.log(`Fired schedule: ${schedule.name}`);
  }
}

export async function reconcileLegacySchedules(): Promise<void> {
  const db = getDb();
  const legacyCron = "*/5 * * * *";
  const targetCron = "*/30 * * * *";

  const { data: schedule, error } = await db
    .from("schedules")
    .select("id,name,cron_expr,timezone")
    .eq("name", "sentinel-health-check")
    .maybeSingle<{ cron_expr: string; id: string; name: string; timezone: string | null }>();

  if (error || !schedule || schedule.cron_expr !== legacyCron) {
    return;
  }

  const { error: updateError } = await db
    .from("schedules")
    .update({
      cron_expr: targetCron,
      next_run_at: calculateNextRun(targetCron, schedule.timezone || undefined),
    })
    .eq("id", schedule.id);

  if (updateError) {
    console.error("Failed to reconcile legacy sentinel schedule:", updateError);
    return;
  }

  console.log(
    `Reconciled legacy schedule ${schedule.name} from ${legacyCron} to ${targetCron}`
  );
}

/**
 * Simple cron next-run calculator.
 * Supports: minute, hour, day-of-month, month, day-of-week
 * For production, use a proper cron library.
 */
export function calculateNextRun(cronExpr: string, timezone?: string): string {
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

async function updateScheduleRunWindow(
  scheduleId: string,
  expectedLastRunAt: string | null,
  nextLastRunAt: string | null,
  nextRunAt: string | null
): Promise<boolean> {
  const db = getDb();
  let query = db
    .from("schedules")
    .update({
      last_run_at: nextLastRunAt,
      next_run_at: nextRunAt,
    })
    .eq("id", scheduleId);

  query = expectedLastRunAt
    ? query.eq("last_run_at", expectedLastRunAt)
    : query.is("last_run_at", null);

  const { data, error } = await query
    .select("id")
    .order("id", { ascending: true })
    .limit(1);
  if (error) {
    console.error(`Failed to update schedule run window for ${scheduleId}:`, error);
    return false;
  }

  return Boolean(data?.length);
}
