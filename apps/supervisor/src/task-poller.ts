import { getDb } from "./db.js";
import { hasCapacity, launchAgent } from "./process-manager.js";

/**
 * Poll for ready tasks and launch agents when capacity is available.
 */
export async function pollForTasks(): Promise<void> {
  if (!hasCapacity()) return;

  const db = getDb();

  // Find ready tasks ordered by priority
  const { data: tasks, error } = await db
    .from("tasks")
    .select("id, assigned_role, priority, last_handoff_note")
    .eq("state", "ready")
    .order("priority")
    .order("created_at")
    .limit(5);

  if (error || !tasks?.length) return;

  for (const task of tasks) {
    if (!hasCapacity()) break;

    // Find an active agent for this role
    const { data: agent } = await db
      .from("agents")
      .select("id, name, role_id, config")
      .eq("role_id", task.assigned_role)
      .eq("status", "active")
      .limit(1)
      .single();

    if (!agent) {
      console.warn(`No active agent for role: ${task.assigned_role}`);
      const note = `Supervisor could not start this task because no active agent is configured for role '${task.assigned_role}'. Task remains queued in ready.`;
      if (task.last_handoff_note !== note) {
        await db
          .from("tasks")
          .update({
            last_handoff_note: note,
          })
          .eq("id", task.id)
          .eq("state", "ready");
      }
      continue;
    }

    // Get role config
    const { data: role } = await db
      .from("roles")
      .select("model, effort")
      .eq("id", task.assigned_role)
      .single();

    if (!role) {
      console.error(`No role config found for role: ${task.assigned_role}`);
      const note = `Supervisor could not start this task because the role configuration for '${task.assigned_role}' is missing. Task remains queued in ready.`;
      if (task.last_handoff_note !== note) {
        await db
          .from("tasks")
          .update({
            last_handoff_note: note,
          })
          .eq("id", task.id)
          .eq("state", "ready");
      }
      continue;
    }

    // Apply agent config overrides
    const model = (agent.config as any)?.model || role.model;
    const effort = (agent.config as any)?.effort || role.effort;

    // Claim the task
    const { error: claimErr } = await db
      .from("tasks")
      .update({ state: "claimed", claimed_by: agent.id })
      .eq("id", task.id)
      .eq("state", "ready"); // optimistic lock

    if (claimErr) continue; // another poller got it

    // Move to running
    const { error: runErr } = await db
      .from("tasks")
      .update({ state: "running" })
      .eq("id", task.id)
      .eq("state", "claimed");

    if (runErr) {
      console.error(`Failed to move task ${task.id} to running:`, runErr);
      await db
        .from("tasks")
        .update({
          state: "ready",
          claimed_by: null,
          last_handoff_note: `Supervisor claimed this task but could not transition it to running: ${runErr.message}`,
        })
        .eq("id", task.id)
        .eq("state", "claimed");
      continue;
    }

    // Build context pack
    const { data: contextPack, error: cpErr } = await db.rpc(
      "build_context_pack",
      { p_task_id: task.id }
    );

    if (cpErr || !contextPack) {
      console.error(`Failed to build context pack for ${task.id}:`, cpErr);
      await db.from("tasks").update({
        state: "failed",
        last_handoff_note: `Supervisor failed to build context pack: ${cpErr?.message}`,
      }).eq("id", task.id);
      continue;
    }

    // Launch the agent
    try {
      const runId = await launchAgent(
        task.id,
        agent.id,
        agent.name,
        agent.role_id,
        model,
        effort,
        contextPack
      );
      console.log(
        `Launched ${agent.name} for task ${task.id} (run: ${runId})`
      );
    } catch (err) {
      console.error(`Failed to launch agent for task ${task.id}:`, err);
      await db.from("tasks").update({
        state: "failed",
        last_handoff_note: `Supervisor failed to launch agent: ${err}`,
      }).eq("id", task.id);
    }
  }
}
