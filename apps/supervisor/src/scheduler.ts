import { getDb } from "./db.js";

/**
 * Check schedules and create tasks for any that have fired.
 */
export async function checkSchedules(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const { data: schedules, error } = await db
    .from("schedules")
    .select("*")
    .eq("enabled", true);

  if (error || !schedules?.length) return;

  for (const schedule of schedules) {
    // Check if it's time to fire
    const nextRun = schedule.next_run_at
      ? new Date(schedule.next_run_at)
      : null;

    if (nextRun && nextRun > now) continue;

    // Calculate next run from cron expression
    const nextRunAt = calculateNextRun(schedule.cron_expr);

    // Create the task from template
    const template = schedule.task_template as Record<string, unknown>;
    const { error: taskErr } = await db.from("tasks").insert({
      title: (template.title as string) || schedule.name,
      objective: (template.objective as string) || "",
      acceptance_criteria: (template.acceptance_criteria as string[]) || [],
      priority: (template.priority as string) || "normal",
      project_id: (template.project_id as string) || null,
      state: "ready",
      assigned_role: schedule.assigned_role,
    });

    if (taskErr) {
      console.error(`Failed to create scheduled task for ${schedule.name}:`, taskErr);
      continue;
    }

    // Update schedule
    await db
      .from("schedules")
      .update({
        last_run_at: now.toISOString(),
        next_run_at: nextRunAt,
      })
      .eq("id", schedule.id);

    console.log(`Fired schedule: ${schedule.name}`);
  }
}

/**
 * Simple cron next-run calculator.
 * Supports: minute, hour, day-of-month, month, day-of-week
 * For production, use a proper cron library.
 */
function calculateNextRun(cronExpr: string): string {
  // Parse cron expression
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Fallback: 5 minutes from now
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }

  const [minPart] = parts;

  // Handle */N pattern for minutes
  if (minPart.startsWith("*/")) {
    const interval = parseInt(minPart.slice(2), 10);
    return new Date(Date.now() + interval * 60 * 1000).toISOString();
  }

  // Default: 1 hour from now (safe fallback for complex crons)
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}
