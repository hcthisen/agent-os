import { getDb } from "./db.js";
import { hasCapacity, launchAgent } from "./process-manager.js";
import {
  buildDependencyWaitNote,
  isTaskLaunchable,
  loadDependencyTaskStateMap,
} from "./task-dependencies.js";

interface RelevantSkill {
  description: string;
  display_name: string;
  id: string;
  input_schema: Record<string, unknown>;
  is_active: boolean;
  last_used_at: string | null;
  name: string;
  output_schema: Record<string, unknown>;
  required_services: string[];
  scope_id: string;
  scope_type: string;
  steps: Array<{
    instruction: string;
    order: number;
    required: boolean;
    tool_hint: string | null;
  }>;
  tags: string[];
  trigger_when: string;
  updated_at: string;
  use_count: number;
  version: number;
}

interface SkillMemoryRow {
  content: string;
  id: string;
  is_active: boolean;
  scope_id: string;
  scope_type: string;
  subject: string;
  tags: string[] | null;
  updated_at: string;
}

interface LaunchAgentCandidate {
  config?: Record<string, unknown> | null;
  id: string;
  name: string;
  role_id: string;
}

/**
 * Poll for ready tasks and launch agents when capacity is available.
 */
export async function pollForTasks(): Promise<void> {
  const db = getDb();

  if (!hasCapacity()) return;

  // Find ready tasks ordered by priority
  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id, assigned_role, depends_on, last_handoff_note, priority, project_id, state, title"
    )
    .in("state", ["ready", "in_review"])
    .order("priority")
    .order("created_at")
    .limit(20);

  if (error || !tasks?.length) return;

  const dependencyStateMap = await loadDependencyTaskStateMap(tasks);

  for (const task of tasks) {
    if (!hasCapacity()) break;

    if (task.state === "ready" && !isTaskLaunchable(task, dependencyStateMap)) {
      const note = buildDependencyWaitNote(task, dependencyStateMap);
      if (note && task.last_handoff_note !== note) {
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

    const launchRole = task.state === "in_review" ? "reviewer" : task.assigned_role;

    // Find active agents for this role. The poller chooses the first agent with spare capacity.
    const { data: roleAgents, error: agentError } = await db
      .from("agents")
      .select("id, name, role_id, config")
      .eq("role_id", launchRole)
      .eq("status", "active")
      .order("created_at")
      .returns<LaunchAgentCandidate[]>();

    // Get role config
    const { data: role } = await db
      .from("roles")
      .select("*")
      .eq("id", launchRole)
      .single();

    if (!role) {
      console.error(`No role config found for role: ${launchRole}`);
      const note = `Supervisor could not start this task because the role configuration for '${launchRole}' is missing. Task remains queued in ${task.state}.`;
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

    if (agentError || !roleAgents?.length) {
      console.warn(`No active agent for role: ${launchRole}`);
      const note = `Supervisor could not start this task because no active agent is configured for role '${launchRole}'. Task remains queued in ${task.state}.`;
      if (task.last_handoff_note !== note) {
        await db
          .from("tasks")
          .update({
            last_handoff_note: note,
          })
          .eq("id", task.id)
          .eq("state", task.state);
      }
      continue;
    }

    const maxConcurrentTasks = resolveMaxConcurrentTasks(role);
    let agent: LaunchAgentCandidate | null = null;

    for (const candidate of roleAgents) {
      const activeTaskCount = await countActiveTasksForAgent(candidate.id);
      if (activeTaskCount < maxConcurrentTasks) {
        agent = candidate;
        break;
      }
    }

    if (!agent) {
      const note = `Supervisor deferred this task because all active agents for '${launchRole}' are already at the max concurrent task limit (${maxConcurrentTasks}). Task remains queued in ${task.state}.`;
      if (task.last_handoff_note !== note) {
        await db
          .from("tasks")
          .update({
            last_handoff_note: note,
          })
          .eq("id", task.id)
          .eq("state", task.state);
      }
      continue;
    }

    // Apply agent config overrides
    const model = (agent.config as any)?.model || role.model;
    const effort = (agent.config as any)?.effort || role.effort;
    const maxRunDurationMs = resolveMaxRunDurationMs(role);

    if (task.state === "ready") {
      // Claim the task
      const { data: claimedTask, error: claimErr } = await db
        .from("tasks")
        .update({ state: "claimed", claimed_by: agent.id })
        .eq("id", task.id)
        .eq("state", "ready")
        .select("id, claimed_by, state")
        .maybeSingle<{
          claimed_by: string | null;
          id: string;
          state: string;
        }>();

      if (
        claimErr ||
        !claimedTask ||
        claimedTask.claimed_by !== agent.id ||
        claimedTask.state !== "claimed"
      ) {
        continue;
      }

      // Move to running only if this poller still owns the claim.
      const { data: runningTask, error: runErr } = await db
        .from("tasks")
        .update({ state: "running" })
        .eq("id", task.id)
        .eq("state", "claimed")
        .eq("claimed_by", agent.id)
        .select("id, claimed_by, state")
        .maybeSingle<{
          claimed_by: string | null;
          id: string;
          state: string;
        }>();

      if (
        runErr ||
        !runningTask ||
        runningTask.claimed_by !== agent.id ||
        runningTask.state !== "running"
      ) {
        console.error(`Failed to move task ${task.id} to running:`, runErr);
        const runErrorMessage = runErr?.message || "task claim was lost before launch";
        await db
          .from("tasks")
          .update({
            state: "ready",
            claimed_by: null,
            last_handoff_note: `Supervisor claimed this task but could not transition it to running: ${runErrorMessage}`,
          })
          .eq("id", task.id)
          .eq("state", "claimed");
        continue;
      }
    } else {
      const { data: reviewerRun, error: reviewRunErr } = await db
        .from("tasks")
        .update({ state: "running", claimed_by: agent.id })
        .eq("id", task.id)
        .eq("state", "in_review")
        .select("id, claimed_by, state")
        .maybeSingle<{
          claimed_by: string | null;
          id: string;
          state: string;
        }>();

      if (
        reviewRunErr ||
        !reviewerRun ||
        reviewerRun.claimed_by !== agent.id ||
        reviewerRun.state !== "running"
      ) {
        console.error(`Failed to start reviewer run for task ${task.id}:`, reviewRunErr);
        const reviewRunErrorMessage =
          reviewRunErr?.message || "reviewer launch claim was lost";
        await db
          .from("tasks")
          .update({
            last_handoff_note: `Supervisor could not start reviewer pass: ${reviewRunErrorMessage}`,
          })
          .eq("id", task.id)
          .eq("state", "in_review");
        continue;
      }
    }

    // Build context pack
    const { data: rawContextPack, error: cpErr } = await db.rpc(
      "build_context_pack",
      { p_task_id: task.id }
    );

    if (cpErr || !rawContextPack) {
      console.error(`Failed to build context pack for ${task.id}:`, cpErr);
      await db.from("tasks").update({
        state: "failed",
        last_handoff_note: `Supervisor failed to build context pack: ${cpErr?.message}`,
      }).eq("id", task.id);
      continue;
    }

    const contextPack =
      task.state === "in_review"
        ? {
            ...(rawContextPack as Record<string, unknown>),
            effort,
            model,
            role,
            role_policy: role.policy_doc,
          }
        : rawContextPack;

    if (
      !Array.isArray(
        (contextPack as Record<string, unknown>).relevant_skills
      )
    ) {
      (contextPack as Record<string, unknown>).relevant_skills =
        await loadRelevantSkills(task.project_id || null, launchRole);
    }

    // Launch the agent
    try {
      const runId = await launchAgent(
        task.id,
        agent.id,
        agent.name,
        launchRole,
        model,
        effort,
        contextPack,
        maxRunDurationMs
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

function resolveMaxRunDurationMs(role: Record<string, unknown>): number | undefined {
  const rawValue = role.max_run_duration_ms;
  const parsed =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
        ? parseInt(rawValue, 10)
        : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveMaxConcurrentTasks(role: Record<string, unknown>): number {
  const rawValue = role.max_concurrent_tasks;
  const parsed =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
        ? parseInt(rawValue, 10)
        : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

async function countActiveTasksForAgent(agentId: string): Promise<number> {
  const db = getDb();
  const { count, error } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("claimed_by", agentId)
    .in("state", ["claimed", "running", "blocked_on_agent", "in_review"]);

  if (error) {
    throw new Error(
      `Failed to count active tasks for agent '${agentId}': ${error.message}`
    );
  }

  return count || 0;
}

async function loadRelevantSkills(
  projectId: string | null,
  roleId: string
): Promise<RelevantSkill[]> {
  const db = getDb();
  const { data, error } = await db
    .from("memories")
    .select("id,subject,content,tags,scope_type,scope_id,updated_at,is_active")
    .eq("layer", "procedural")
    .eq("is_active", true)
    .contains("tags", ["skill"])
    .in("scope_type", projectId ? ["project", "role", "company"] : ["role", "company"])
    .returns<SkillMemoryRow[]>();

  if (error) {
    console.error("Failed to load relevant skills for task launch:", error);
    return [];
  }

  return (data || [])
    .filter((memory) =>
      memory.scope_type === "company" ||
      (memory.scope_type === "role" && memory.scope_id === roleId) ||
      (memory.scope_type === "project" && projectId !== null && memory.scope_id === projectId)
    )
    .map((memory) => toRelevantSkill(memory))
    .sort((left, right) => {
      const scopeRankDelta =
        resolveSkillScopeRank(left.scope_type) - resolveSkillScopeRank(right.scope_type);
      if (scopeRankDelta !== 0) {
        return scopeRankDelta;
      }

      if (left.use_count !== right.use_count) {
        return right.use_count - left.use_count;
      }

      return (
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      );
    })
    .slice(0, 10);
}

function toRelevantSkill(memory: SkillMemoryRow): RelevantSkill {
  const payload = parseSkillContent(memory.content);
  const name = memory.subject.replace(/^skill:/i, "").trim() || memory.subject.trim();

  return {
    description: readString(payload.description),
    display_name: readString(payload.display_name) || name,
    id: memory.id,
    input_schema: readObject(payload.input_schema),
    is_active: memory.is_active,
    last_used_at: readNullableString(payload.last_used_at),
    name,
    output_schema: readObject(payload.output_schema),
    required_services: readStringArray(payload.required_services),
    scope_id: memory.scope_id,
    scope_type: memory.scope_type,
    steps: readSkillSteps(payload.steps),
    tags: readStringArray(payload.tags).length
      ? readStringArray(payload.tags)
      : memory.tags || [],
    trigger_when: readString(payload.trigger_when),
    updated_at: memory.updated_at,
    use_count: readPositiveInt(payload.use_count, 0),
    version: Math.max(1, readPositiveInt(payload.version, 1)),
  };
}

function parseSkillContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value, 10)
        : NaN;

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
}

function readSkillSteps(value: unknown): RelevantSkill["steps"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      const step =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};

      const instruction = readString(step.instruction);
      if (!instruction) {
        return null;
      }

      return {
        instruction,
        order: readPositiveInt(step.order, index + 1),
        required: step.required !== false,
        tool_hint: readNullableString(step.tool_hint),
      };
    })
    .filter(
      (
        step
      ): step is {
        instruction: string;
        order: number;
        required: boolean;
        tool_hint: string | null;
      } => Boolean(step)
    );
}

function resolveSkillScopeRank(scopeType: string): number {
  if (scopeType === "project") {
    return 0;
  }

  if (scopeType === "role") {
    return 1;
  }

  return 2;
}
