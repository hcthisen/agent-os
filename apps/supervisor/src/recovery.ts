import { getDb } from "./db.js";

function buildRecoveryNote(state: string): string {
  return state === "running"
    ? "Supervisor recovery: agent process was interrupted by a supervisor restart. Task returned to ready for retry."
    : "Supervisor recovery: claimed task was interrupted before execution started. Task returned to ready.";
}

async function recoverRunningTask(taskId: string, note: string): Promise<void> {
  const db = getDb();

  const { error: blockError } = await db
    .from("tasks")
    .update({
      state: "blocked_on_agent",
      blocked_reason: "Supervisor recovery: prior agent process was interrupted.",
      last_handoff_note: note,
    })
    .eq("id", taskId);

  if (blockError) {
    throw new Error(blockError.message);
  }

  const { error: readyError } = await db
    .from("tasks")
    .update({
      state: "ready",
      claimed_by: null,
      blocked_reason: null,
      last_handoff_note: note,
    })
    .eq("id", taskId);

  if (readyError) {
    throw new Error(readyError.message);
  }
}

async function recoverClaimedTask(taskId: string, note: string): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from("tasks")
    .update({
      state: "ready",
      claimed_by: null,
      blocked_reason: null,
      last_handoff_note: note,
    })
    .eq("id", taskId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function recoverOrphanedTasks(): Promise<void> {
  const db = getDb();

  const { data: orphans, error } = await db
    .from("tasks")
    .select("id, state, title, claimed_by")
    .in("state", ["claimed", "running"]);

  if (error) {
    console.error("Failed to query orphaned tasks:", error);
    return;
  }

  if (!orphans?.length) {
    console.log("No orphaned tasks found.");
    return;
  }

  console.log(`Found ${orphans.length} orphaned task(s), returning them to ready.`);

  for (const task of orphans) {
    const note = buildRecoveryNote(task.state);

    const { error: runError } = await db
      .from("task_runs")
      .update({
        status: "interrupted",
        error_message: "Supervisor restarted before the agent process exit was recorded.",
        handoff_note: note,
        finished_at: new Date().toISOString(),
      })
      .eq("task_id", task.id)
      .eq("status", "started");

    if (runError) {
      console.error(`Failed to close orphaned task runs for ${task.id}:`, runError);
    }

    try {
      if (task.state === "running") {
        await recoverRunningTask(task.id, note);
      } else {
        await recoverClaimedTask(task.id, note);
      }

      console.log(`Recovered task: ${task.title} (${task.id})`);
    } catch (updateErr) {
      console.error(`Failed to recover task ${task.id}:`, updateErr);
    }
  }
}
