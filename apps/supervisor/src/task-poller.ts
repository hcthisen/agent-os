import { getDb } from "./db.js";
import { hasCapacity, launchAgent } from "./process-manager.js";
import {
  toSanitizedServiceConnectionHint,
  withDecryptedCredential,
  type SanitizedServiceConnectionHint,
  type ServiceRegistryRuntimeRow,
} from "./service-registry.js";
import {
  buildDependencyWaitNote,
  isTaskLaunchable,
  loadDependencyTaskStateMap,
} from "./task-dependencies.js";
import { findRootTaskById, sendRelayLifecycleUpdate } from "./task-outcomes.js";

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

interface QueueTaskRow {
  assigned_role: string;
  attempt_count: number;
  customer_id: string | null;
  department_id: string | null;
  depends_on: string[] | null;
  id: string;
  last_handoff_note: string | null;
  objective: string;
  parent_task_id?: string | null;
  priority: string;
  project_id: string | null;
  state: string;
  title: string;
}

interface BlockedTaskRow extends QueueTaskRow {
  blocked_reason: string | null;
  claimed_by: string | null;
  updated_at: string;
}

interface ChildTaskStateRow {
  completed_at: string | null;
  id: string;
  last_handoff_note: string | null;
  parent_task_id: string | null;
  state: string;
  title: string;
  updated_at: string;
}

interface RootLifecycleMessageRow {
  created_at: string;
  metadata: Record<string, unknown> | null;
  sender: string;
}

interface SimilarTaskRow {
  attempt_count: number;
  completed_at: string | null;
  customer_id: string | null;
  department_id: string | null;
  id: string;
  last_handoff_note: string | null;
  objective: string;
  project_id: string | null;
  state: string;
  title: string;
  updated_at: string;
}

async function loadFreshLaunchCandidate(taskId: string): Promise<QueueTaskRow | null> {
  const db = getDb();
  const { data, error } = await db
    .from("tasks")
    .select(
      "id,assigned_role,attempt_count,customer_id,department_id,depends_on,last_handoff_note,objective,parent_task_id,priority,project_id,state,title"
    )
    .eq("id", taskId)
    .in("state", ["ready", "in_review"])
    .maybeSingle<QueueTaskRow>();

  if (error) {
    console.error(`Failed to reload launch candidate ${taskId}:`, error);
    return null;
  }

  return data || null;
}

async function enforceFreshDependencyGate(task: QueueTaskRow): Promise<QueueTaskRow | null> {
  const freshTask = await loadFreshLaunchCandidate(task.id);
  if (!freshTask) {
    return null;
  }

  const dependencyStateMap = await loadDependencyTaskStateMap([freshTask]);
  if (isTaskLaunchable(freshTask, dependencyStateMap)) {
    return freshTask;
  }

  const note = buildDependencyWaitNote(freshTask, dependencyStateMap);
  if (note && freshTask.last_handoff_note !== note) {
    await getDb()
      .from("tasks")
      .update({
        last_handoff_note: note,
      })
      .eq("id", freshTask.id)
      .eq("state", freshTask.state);
  }

  return null;
}

/**
 * Poll for ready tasks and launch agents when capacity is available.
 */
export async function pollForTasks(): Promise<void> {
  const db = getDb();

  await reconcileBlockedOnAgentTasks();

  if (!hasCapacity()) return;

  // Find ready tasks ordered by priority
  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id,assigned_role,attempt_count,customer_id,department_id,depends_on,last_handoff_note,objective,parent_task_id,priority,project_id,state,title"
    )
    .in("state", ["ready", "in_review"])
    .order("priority")
    .order("created_at")
    .limit(20)
    .returns<QueueTaskRow[]>();

  if (error || !tasks?.length) return;

  const dependencyStateMap = await loadDependencyTaskStateMap(tasks);

  for (const task of tasks) {
    if (!hasCapacity()) break;

    if (!isTaskLaunchable(task, dependencyStateMap)) {
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

    const freshLaunchTask = await enforceFreshDependencyGate(task);
    if (!freshLaunchTask) {
      continue;
    }

    const launchRole =
      freshLaunchTask.state === "in_review"
        ? "reviewer"
        : freshLaunchTask.assigned_role;

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

    if (freshLaunchTask.state === "ready") {
      // Claim the task
      const { data: claimedTask, error: claimErr } = await db
        .from("tasks")
        .update({ state: "claimed", claimed_by: agent.id })
        .eq("id", freshLaunchTask.id)
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
        .eq("id", freshLaunchTask.id)
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
        console.error(
          `Failed to move task ${freshLaunchTask.id} to running:`,
          runErr
        );
        const runErrorMessage = runErr?.message || "task claim was lost before launch";
        await db
          .from("tasks")
          .update({
            state: "ready",
            claimed_by: null,
            last_handoff_note: `Supervisor claimed this task but could not transition it to running: ${runErrorMessage}`,
          })
          .eq("id", freshLaunchTask.id)
          .eq("state", "claimed");
        continue;
      }
    } else {
      const { data: reviewerRun, error: reviewRunErr } = await db
        .from("tasks")
        .update({ state: "running", claimed_by: agent.id })
        .eq("id", freshLaunchTask.id)
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
        console.error(
          `Failed to start reviewer run for task ${freshLaunchTask.id}:`,
          reviewRunErr
        );
        const reviewRunErrorMessage =
          reviewRunErr?.message || "reviewer launch claim was lost";
        await db
          .from("tasks")
          .update({
            last_handoff_note: `Supervisor could not start reviewer pass: ${reviewRunErrorMessage}`,
          })
          .eq("id", freshLaunchTask.id)
          .eq("state", "in_review");
        continue;
      }
    }

    // Build context pack
    const { data: rawContextPack, error: cpErr } = await db.rpc(
      "build_context_pack",
      { p_task_id: freshLaunchTask.id }
    );

    if (cpErr || !rawContextPack) {
      console.error(
        `Failed to build context pack for ${freshLaunchTask.id}:`,
        cpErr
      );
      await db.from("tasks").update({
        state: "failed",
        last_handoff_note: `Supervisor failed to build context pack: ${cpErr?.message}`,
      }).eq("id", freshLaunchTask.id);
      continue;
    }

    const contextPack =
      freshLaunchTask.state === "in_review"
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
        await loadRelevantSkills(freshLaunchTask.project_id || null, launchRole);
    }

    const serviceConnections = await loadTaskServiceConnections(
      freshLaunchTask,
      contextPack as Record<string, unknown>
    );
    if (serviceConnections.length) {
      (contextPack as Record<string, unknown>).service_connections = serviceConnections;
    }

    Object.assign(
      contextPack as Record<string, unknown>,
      await loadTaskContinuationSignals(freshLaunchTask)
    );

    // Launch the agent
      try {
        const runId = await launchAgent(
          freshLaunchTask.id,
          agent.id,
        agent.name,
        launchRole,
        model,
        effort,
        contextPack,
        maxRunDurationMs
      );
      console.log(
        `Launched ${agent.name} for task ${freshLaunchTask.id} (run: ${runId})`
      );
      await maybeNotifyOperatorTaskStarted(freshLaunchTask, launchRole);
    } catch (err) {
      console.error(
        `Failed to launch agent for task ${freshLaunchTask.id}:`,
        err
      );
      await db.from("tasks").update({
        state: "failed",
        last_handoff_note: `Supervisor failed to launch agent: ${err}`,
      }).eq("id", freshLaunchTask.id);
    }
  }
}

const BLOCKED_CHILD_TERMINAL_STATES = new Set([
  "cancelled",
  "completed",
  "dead_letter",
  "failed",
]);

async function reconcileBlockedOnAgentTasks(): Promise<void> {
  const db = getDb();
  const { data: blockedTasks, error } = await db
    .from("tasks")
    .select(
      "id,assigned_role,attempt_count,blocked_reason,claimed_by,customer_id,department_id,depends_on,last_handoff_note,objective,priority,project_id,state,title,updated_at"
    )
    .eq("state", "blocked_on_agent")
    .order("updated_at")
    .limit(50)
    .returns<BlockedTaskRow[]>();

  if (error) {
    console.error("Failed to load blocked_on_agent tasks for reconciliation:", error);
    return;
  }

  if (!blockedTasks?.length) {
    return;
  }

  const dependencyStateMap = await loadDependencyTaskStateMap(blockedTasks);
  const blockedTaskIds = blockedTasks.map((task) => task.id);
  const { data: childTasks, error: childError } = await db
    .from("tasks")
    .select("id,parent_task_id,state,title,updated_at,completed_at,last_handoff_note")
    .in("parent_task_id", blockedTaskIds)
    .returns<ChildTaskStateRow[]>();

  if (childError) {
    console.error("Failed to load blocked_on_agent child tasks:", childError);
    return;
  }

  const childTasksByParentId = new Map<string, ChildTaskStateRow[]>();
  for (const childTask of childTasks || []) {
    if (!childTask.parent_task_id) {
      continue;
    }

    const entries = childTasksByParentId.get(childTask.parent_task_id) || [];
    entries.push(childTask);
    childTasksByParentId.set(childTask.parent_task_id, entries);
  }

  for (const task of blockedTasks) {
    if (!isTaskLaunchable(task, dependencyStateMap)) {
      continue;
    }

    const childEntries = childTasksByParentId.get(task.id) || [];
    if (!shouldResumeBlockedTask(task, childEntries)) {
      continue;
    }

    const resumeNote = buildBlockedTaskResumeNote(task, childEntries);
    const { error: updateError } = await db
      .from("tasks")
      .update({
        blocked_reason: null,
        claimed_by: null,
        last_handoff_note: resumeNote,
        state: "ready",
      })
      .eq("id", task.id)
      .eq("state", "blocked_on_agent");

    if (updateError) {
      console.error(
        `Failed to resume blocked_on_agent task ${task.id} after child completion:`,
        updateError
      );
    }
  }
}

function shouldResumeBlockedTask(
  task: Pick<BlockedTaskRow, "state">,
  childTasks: ChildTaskStateRow[]
): boolean {
  return (
    task.state === "blocked_on_agent" &&
    childTasks.length > 0 &&
    childTasks.every((childTask) => BLOCKED_CHILD_TERMINAL_STATES.has(childTask.state))
  );
}

function buildBlockedTaskResumeNote(
  task: Pick<BlockedTaskRow, "last_handoff_note">,
  childTasks: ChildTaskStateRow[]
): string {
  const childSummary = childTasks
    .map((childTask) => `${childTask.title} (${childTask.state})`)
    .join("; ");
  const priorNote = String(task.last_handoff_note || "").trim();
  const resumeDirective =
    "Blocked dependency work reached a terminal state. Resume this task now, inspect the child-task outcomes, and either complete the request or fail clearly based on those results.";

  return [
    resumeDirective,
    childSummary ? `Resolved child tasks: ${childSummary}.` : null,
    priorNote ? `Prior note:\n${priorNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function maybeNotifyOperatorTaskStarted(
  task: QueueTaskRow,
  launchRole: string
): Promise<void> {
  const rootTask = await findRootTaskById(task.id);
  if (
    !rootTask ||
    (rootTask.assigned_role !== "relay" &&
      !rootTask.title.startsWith("Process message:"))
  ) {
    return;
  }

  const relatedTaskTitle = simplifyTaskTitle(task.title);
  if (task.id === rootTask.id) {
    return;
  }

  const recentMessages = await loadRecentRootLifecycleMessages(rootTask.id);
  if (
    shouldSuppressDirectChildStartLifecycleUpdate(
      task,
      rootTask.id,
      await countDirectRequestChildren(rootTask.id),
      recentMessages
    )
  ) {
    return;
  }

  if (shouldSuppressImmediateStartUpdate(recentMessages)) {
    return;
  }

  const content = `I’ve started ${launchRole} work on this request: ${relatedTaskTitle}.`;

  await sendRelayLifecycleUpdate({
    content,
    eventType: "operator.progress.sent",
    extraMetadata: {
      related_task_id: task.id,
      related_task_role: launchRole,
      relay_update_kind: "started",
    },
    notificationKey: `request-start:${task.id}`,
    notificationType: "task_progress",
    rootTaskId: rootTask.id,
  });
}

async function loadRecentRootLifecycleMessages(
  rootTaskId: string
): Promise<RootLifecycleMessageRow[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const { data, error } = await db
    .from("messages")
    .select("created_at,metadata,sender")
    .eq("direction", "outbound")
    .eq("task_id", rootTaskId)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(10)
    .returns<RootLifecycleMessageRow[]>();

  if (error) {
    console.error(
      `Failed to load recent root lifecycle messages for ${rootTaskId}:`,
      error
    );
    return [];
  }

  return data || [];
}

async function countDirectRequestChildren(rootTaskId: string): Promise<number> {
  const db = getDb();
  const { count, error } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("parent_task_id", rootTaskId);

  if (error) {
    console.error(
      `Failed to count direct request children for ${rootTaskId}:`,
      error
    );
    return 0;
  }

  return count || 0;
}

function shouldSuppressFirstDirectChildStartUpdate(
  task: Pick<QueueTaskRow, "parent_task_id">,
  rootTaskId: string
): boolean {
  return task.parent_task_id === rootTaskId;
}

function shouldSuppressDirectChildStartLifecycleUpdate(
  task: Pick<QueueTaskRow, "parent_task_id">,
  rootTaskId: string,
  directChildCount: number,
  messages: RootLifecycleMessageRow[]
): boolean {
  if (!shouldSuppressFirstDirectChildStartUpdate(task, rootTaskId)) {
    return false;
  }

  if (directChildCount > 1) {
    return false;
  }

  return shouldSuppressImmediateStartUpdate(messages);
}

function shouldSuppressImmediateStartUpdate(
  messages: RootLifecycleMessageRow[]
): boolean {
  const relayMessages = messages.filter(
    (message) =>
      message.sender === "relay" &&
      typeof message.metadata?.relay_update_kind === "string"
  );

  if (!relayMessages.length) {
    return false;
  }

  const hasRecentReceived = relayMessages.some(
    (message) => message.metadata?.relay_update_kind === "received"
  );
  const hasOtherLifecycleUpdate = relayMessages.some(
    (message) => message.metadata?.relay_update_kind !== "received"
  );

  return hasRecentReceived && !hasOtherLifecycleUpdate;
}

function simplifyTaskTitle(title: string): string {
  return String(title || "").replace(/^Process message:\s*/i, "").trim() || "the task";
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

async function loadTaskContinuationSignals(
  task: QueueTaskRow
): Promise<Record<string, unknown>> {
  const db = getDb();
  let query = db
    .from("tasks")
    .select(
      "id,title,objective,state,last_handoff_note,updated_at,completed_at,attempt_count,project_id,customer_id,department_id"
    )
    .neq("id", task.id)
    .eq("assigned_role", task.assigned_role)
    .in("state", ["completed", "failed", "dead_letter", "blocked_on_agent"])
    .order("updated_at", { ascending: false })
    .limit(80);

  if (task.project_id) {
    query = query.eq("project_id", task.project_id);
  } else if (task.customer_id) {
    query = query.eq("customer_id", task.customer_id);
  } else if (task.department_id) {
    query = query.eq("department_id", task.department_id);
  }

  const { data, error } = await query.returns<SimilarTaskRow[]>();

  if (error) {
    console.error(`Failed to load continuation signals for task ${task.id}:`, error);
    return {};
  }

  return buildTaskContinuationSummary(task, data || []);
}

async function loadTaskServiceConnections(
  task: Pick<QueueTaskRow, "id" | "objective" | "title">,
  contextPack: Record<string, unknown>
): Promise<SanitizedServiceConnectionHint[]> {
  const db = getDb();
  const { data, error } = await db
    .from("service_registry")
    .select(
      "id,credential,base_url,error_message,service_name,status,updated_at,auth_type,created_at,description,display_name,last_verified,registered_by"
    )
    .eq("status", "active")
    .returns<ServiceRegistryRuntimeRow[]>();

  if (error || !data?.length) {
    return [];
  }

  const taskRequirements = Array.isArray(contextPack.task_requirements)
    ? (contextPack.task_requirements as Array<Record<string, unknown>>)
    : [];
  const requiredServiceNames = new Set(
    taskRequirements
      .filter(
        (entry) =>
          String(entry.requirement_type || "").trim() === "service_active" &&
          typeof entry.target === "string"
      )
      .map((entry) => String(entry.target || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const lineageTaskText = await loadTaskLineageText(task.id);
  const combinedTaskText = [
    task.title,
    task.objective,
    String(
      ((contextPack.task as Record<string, unknown> | undefined)?.last_handoff_note as
        | string
        | undefined) || ""
    ),
    lineageTaskText,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const inferredRequestedServices = inferRequestedActiveServices(combinedTaskText);

  const rows = await Promise.all(data.map((row) => withDecryptedCredential(row)));
  return rows
    .filter((row): row is ServiceRegistryRuntimeRow => Boolean(row))
    .filter((row) => {
      if (requiredServiceNames.has(row.service_name)) {
        return true;
      }

      const serviceName = row.service_name.toLowerCase();
      const displayName = String(row.display_name || "").trim().toLowerCase();
      return (
        inferredRequestedServices.has(serviceName) ||
        combinedTaskText.includes(serviceName) ||
        (displayName && combinedTaskText.includes(displayName))
      );
    })
    .map((row) => toSanitizedServiceConnectionHint(row))
    .filter((row): row is SanitizedServiceConnectionHint => Boolean(row));
}

async function loadTaskLineageText(taskId: string): Promise<string> {
  const db = getDb();
  const fragments: string[] = [];
  let currentTaskId: string | null = taskId;
  const visited = new Set<string>();

  while (currentTaskId && !visited.has(currentTaskId)) {
    visited.add(currentTaskId);
    const response = await db
      .from("tasks")
      .select("id,parent_task_id,title,objective,last_handoff_note")
      .eq("id", currentTaskId)
      .maybeSingle<{
        id: string;
        last_handoff_note: string | null;
        objective: string | null;
        parent_task_id: string | null;
        title: string;
      }>();
    const data = response.data as
      | {
          id: string;
          last_handoff_note: string | null;
          objective: string | null;
          parent_task_id: string | null;
          title: string;
        }
      | null;
    const error = response.error;

    if (error || !data) {
      break;
    }

    fragments.push(
      data.title || "",
      data.objective || "",
      data.last_handoff_note || ""
    );
    currentTaskId = data.parent_task_id;
  }

  return fragments.filter(Boolean).join("\n");
}

function inferRequestedActiveServices(combinedTaskText: string): Set<string> {
  const inferred = new Set<string>();
  const text = String(combinedTaskText || "").toLowerCase();

  if (
    /\b(image|images|visual|visuals|creative|ad creative|thumbnail|render|rendered)\b/i.test(
      text
    )
  ) {
    inferred.add("gemini");
  }

  if (
    /\b(voiceover|voice-over|voice over|audio|spoken|speech|tts|narration|narrator)\b/i.test(
      text
    )
  ) {
    inferred.add("elevenlabs");
  }

  if (/\b(gohighlevel|highlevel|leadconnector)\b/i.test(text)) {
    inferred.add("gohighlevel");
  }

  if (/\b(github|repository|repo)\b/i.test(text)) {
    inferred.add("github");
  }

  if (/\b(vercel|deploy|deployment|preview url)\b/i.test(text)) {
    inferred.add("vercel");
  }

  return inferred;
}

function buildTaskContinuationSummary(
  task: QueueTaskRow,
  candidates: SimilarTaskRow[]
): Record<string, unknown> {
  const similarTasks = candidates
    .map((candidate) => ({
      candidate,
      score: scoreTaskSimilarity(task, candidate),
    }))
    .filter((entry) => entry.score >= 2)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return (
        new Date(right.candidate.updated_at).getTime() -
        new Date(left.candidate.updated_at).getTime()
      );
    })
    .slice(0, 5);

  const history = similarTasks.map(({ candidate, score }) => ({
    attempt_count: candidate.attempt_count,
    completed_at: candidate.completed_at,
    handoff_summary: summarizeTaskHistoryNote(candidate.last_handoff_note),
    id: candidate.id,
    similarity_score: score,
    state: candidate.state,
    title: candidate.title,
    updated_at: candidate.updated_at,
  }));

  const similarFailures = similarTasks.filter(({ candidate }) =>
    candidate.state === "failed" ||
    candidate.state === "dead_letter" ||
    candidate.state === "blocked_on_agent"
  );
  const similarSuccesses = similarTasks.filter(
    ({ candidate }) => candidate.state === "completed"
  );

  const guidance: string[] = [];
  if (task.project_id) {
    guidance.push(
      "This task belongs to a persistent initiative. Keep follow-up tasks, memories, artifacts, and skills attached to this project unless the scope has clearly changed."
    );
  }

  if (task.attempt_count > 0) {
    guidance.push(
      "This task is being retried after a failed run. Start by inspecting the last handoff and change the approach instead of repeating the same path."
    );
  }

  if (similarFailures.length > 0) {
    guidance.push(
      "Similar prior tasks failed or stalled. Read their handoff notes and choose a materially different approach before you act."
    );
  }

  if (similarSuccesses.length >= 2) {
    guidance.push(
      "This looks like repeat work. Reuse an existing shared skill when it fits, or update/create one before you finish so the next run starts from the proven procedure."
    );
  }

  const continuationSummary: Record<string, unknown> = {};
  if (history.length > 0) {
    continuationSummary.similar_task_history = history;
  }

  if (guidance.length > 0) {
    continuationSummary.adaptation_guidance = guidance.join(" ");
  }

  if (similarSuccesses.length >= 2 || task.attempt_count > 0 || similarFailures.length > 0) {
    continuationSummary.skill_evolution_directive =
      "If you discover a better repeatable procedure while completing this task, update an existing shared skill or create a new one instead of leaving the learning trapped in this run.";
  }

  return continuationSummary;
}

function scoreTaskSimilarity(task: QueueTaskRow, candidate: SimilarTaskRow): number {
  const taskText = `${task.title} ${task.objective}`;
  const candidateText = `${candidate.title} ${candidate.objective}`;
  const taskTokens = new Set(tokenizeTaskSimilarityText(taskText));
  const candidateTokens = new Set(tokenizeTaskSimilarityText(candidateText));
  let score = 0;

  for (const token of taskTokens) {
    if (candidateTokens.has(token)) {
      score += 1;
    }
  }

  const taskHostnames = extractTaskHostnames(taskText);
  const candidateHostnames = new Set(extractTaskHostnames(candidateText));
  for (const hostname of taskHostnames) {
    if (candidateHostnames.has(hostname)) {
      score += 4;
    }
  }

  if (
    normalizeTaskSimilarityText(task.title) ===
    normalizeTaskSimilarityText(candidate.title)
  ) {
    score += 4;
  }

  return score;
}

function summarizeTaskHistoryNote(note: string | null): string | null {
  if (!note) {
    return null;
  }

  return note.replace(/\s+/g, " ").trim().slice(0, 280);
}

function normalizeTaskSimilarityText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s:-]+/g, " ");
}

function tokenizeTaskSimilarityText(value: string): string[] {
  return normalizeTaskSimilarityText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function extractTaskHostnames(value: string): string[] {
  const matches = [
    ...String(value || "").matchAll(
      /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi
    ),
  ];

  return [...new Set(
    matches
      .map((match) => String(match[1] || "").trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean)
  )];
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

export const taskPollerTestHooks = {
  buildBlockedTaskResumeNote,
  buildTaskContinuationSummary,
  extractTaskHostnames,
  loadTaskServiceConnections,
  scoreTaskSimilarity,
  enforceFreshDependencyGate,
  shouldSuppressDirectChildStartLifecycleUpdate,
  shouldSuppressFirstDirectChildStartUpdate,
  shouldSuppressImmediateStartUpdate,
  shouldResumeBlockedTask,
  tokenizeTaskSimilarityText,
};
