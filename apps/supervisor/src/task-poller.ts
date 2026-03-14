import { getDb } from "./db.js";
import { hasCapacity, launchAgent } from "./process-manager.js";
import {
  buildDependencyWaitNote,
  isTaskLaunchable,
  loadDependencyTaskStateMap,
} from "./task-dependencies.js";

interface ApprovedApproval {
  action_type: string;
  decided_at: string | null;
  description: string;
  task_id: string;
}

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

/**
 * Poll for ready tasks and launch agents when capacity is available.
 */
export async function pollForTasks(): Promise<void> {
  const db = getDb();
  await releaseApprovedTasks(db);

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

    // Find an active agent for this role
    const { data: agent } = await db
      .from("agents")
      .select("id, name, role_id, config")
      .eq("role_id", launchRole)
      .eq("status", "active")
      .limit(1)
      .single();

    if (!agent) {
      console.warn(`No active agent for role: ${launchRole}`);
      const note = `Supervisor could not start this task because no active agent is configured for role '${launchRole}'. Task remains queued in ${task.state}.`;
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

    // Apply agent config overrides
    const model = (agent.config as any)?.model || role.model;
    const effort = (agent.config as any)?.effort || role.effort;
    const maxRunDurationMs = resolveMaxRunDurationMs(role);

    if (task.state === "ready") {
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
    } else {
      const { error: reviewRunErr } = await db
        .from("tasks")
        .update({ state: "running", claimed_by: agent.id })
        .eq("id", task.id)
        .eq("state", "in_review");

      if (reviewRunErr) {
        console.error(`Failed to start reviewer run for task ${task.id}:`, reviewRunErr);
        await db
          .from("tasks")
          .update({
            last_handoff_note: `Supervisor could not start reviewer pass: ${reviewRunErr.message}`,
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

async function releaseApprovedTasks(db: ReturnType<typeof getDb>): Promise<void> {
  const { data: approvals, error: approvalError } = await db
    .from("approvals")
    .select("task_id,action_type,description,decided_at")
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .returns<ApprovedApproval[]>();

  if (approvalError) {
    console.error("Failed to query approved approvals for task release:", approvalError);
    return;
  }

  if (!approvals?.length) {
    return;
  }

  const latestApprovedByTask = new Map<string, ApprovedApproval>();
  for (const approval of approvals) {
    if (!latestApprovedByTask.has(approval.task_id)) {
      latestApprovedByTask.set(approval.task_id, approval);
    }
  }

  const taskIds = [...latestApprovedByTask.keys()];
  const { data: pendingApprovals, error: pendingError } = await db
    .from("approvals")
    .select("task_id")
    .eq("status", "pending")
    .in("task_id", taskIds)
    .returns<Array<{ task_id: string }>>();

  if (pendingError) {
    console.error("Failed to query pending approvals for task release:", pendingError);
    return;
  }

  const pendingTaskIds = new Set(
    (pendingApprovals || []).map((approval) => approval.task_id)
  );

  for (const [taskId, approval] of latestApprovedByTask.entries()) {
    if (pendingTaskIds.has(taskId)) {
      continue;
    }

    const { error: updateError } = await db
      .from("tasks")
      .update({
        blocked_reason: null,
        claimed_by: null,
        last_handoff_note: `Approval granted for ${approval.action_type}: ${approval.description}`,
        state: "ready",
      })
      .eq("id", taskId)
      .eq("state", "blocked_on_human");

    if (updateError) {
      console.error(`Failed to release approved task ${taskId}:`, updateError);
    }
  }
}
