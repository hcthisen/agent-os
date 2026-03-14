import { getDb } from "./db.js";
import { config } from "./config.js";
import { queueOperatorRelayMessage } from "./operator-delivery.js";
import {
  buildDependencyWaitNote,
  getUnsatisfiedDependencies,
  loadDependencyTaskStateMap,
} from "./task-dependencies.js";

type AttentionState =
  | "blocked_on_agent"
  | "blocked_on_human"
  | "claimed"
  | "dead_letter"
  | "failed"
  | "in_review"
  | "ready"
  | "running";

interface AttentionTask {
  assigned_role: string;
  attempt_count: number;
  blocked_reason: string | null;
  claimed_by: string | null;
  created_at: string;
  depends_on: string[] | null;
  id: string;
  last_handoff_note: string | null;
  parent_task_id: string | null;
  priority: string;
  state: AttentionState;
  title: string;
  updated_at: string;
}

interface OperatorRootTask {
  assigned_role: string;
  id: string;
  parent_task_id: string | null;
  title: string;
}

interface TaskActivity {
  created_at: string | null;
  summary: string | null;
}

interface PendingApproval {
  action_type: string;
  created_at: string;
  description: string;
  id: string;
  task_id: string;
}

const ATTENTION_STATES: AttentionState[] = [
  "ready",
  "claimed",
  "running",
  "blocked_on_agent",
  "blocked_on_human",
  "failed",
  "dead_letter",
  "in_review",
];

export async function monitorTaskAttention(): Promise<void> {
  const db = getDb();
  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id,title,state,priority,assigned_role,parent_task_id,blocked_reason,last_handoff_note,attempt_count,claimed_by,created_at,updated_at,depends_on"
    )
    .in("state", ATTENTION_STATES);

  if (error) {
    console.error("Failed to query task attention state:", error);
    return;
  }

  const taskList = (tasks || []) as AttentionTask[];
  const dependencyStateMap = await loadDependencyTaskStateMap(taskList);
  const activityMap = await loadLatestTaskActivity(taskList.map((task) => task.id));
  const taskMap = new Map(taskList.map((task) => [task.id, task]));
  const pendingApprovalsByTask = await loadPendingApprovals(
    taskList.map((task) => task.id)
  );
  const approvalBlockedAncestorIds = buildApprovalBlockedAncestorSet(
    taskMap,
    pendingApprovalsByTask
  );

  for (const task of taskList) {
    if (task.state === "ready") {
      const waitNote = buildDependencyWaitNote(task, dependencyStateMap);
      if (waitNote && task.last_handoff_note !== waitNote) {
        await db
          .from("tasks")
          .update({ last_handoff_note: waitNote })
          .eq("id", task.id)
          .eq("state", "ready");
        task.last_handoff_note = waitNote;
      }
    }

    const activity = activityMap.get(task.id) || null;
    const pendingApproval = selectPendingApproval(task.id, pendingApprovalsByTask);
    const notificationKind = getNotificationKind(
      task,
      activity,
      dependencyStateMap,
      pendingApproval,
      approvalBlockedAncestorIds
    );
    if (!notificationKind) {
      continue;
    }

    const rootTask = await findRootTask(task);
    if (!(await shouldNotifyOperator(task, rootTask))) {
      continue;
    }

    if (await notificationSentWithinCooldown(task.id)) {
      continue;
    }

    const notificationKey = buildNotificationKey(notificationKind);
    const content =
      task.state === "blocked_on_human" && pendingApproval
        ? formatApprovalMessage(task, rootTask, pendingApproval)
        : formatAttentionMessage(task, rootTask, activity);
    await sendOperatorNotification(task, notificationKey, content);
  }
}

function getNotificationKind(
  task: AttentionTask,
  activity: TaskActivity | null,
  dependencyStateMap: Map<string, { id: string; state: string; title: string }>,
  pendingApproval: PendingApproval | null,
  approvalBlockedAncestorIds: Set<string>
): string | null {
  if (
    task.state === "ready" &&
    task.last_handoff_note?.startsWith("Supervisor could not start this task")
  ) {
    return "queue:blocker";
  }

  if (
    task.state === "ready" &&
    getUnsatisfiedDependencies(task, dependencyStateMap).length > 0
  ) {
    return null;
  }

  if (task.state === "blocked_on_human" && pendingApproval) {
    return `approval:${pendingApproval.id}`;
  }

  if (
    task.state === "blocked_on_agent" &&
    approvalBlockedAncestorIds.has(task.id)
  ) {
    return null;
  }

  if (
    task.state === "failed" ||
    task.state === "dead_letter" ||
    task.state === "blocked_on_human" ||
    task.state === "blocked_on_agent"
  ) {
    return `state:${task.state}`;
  }

  const referenceTimestamp = resolveTaskActivityTimestamp(task, activity);
  const ageMs = Date.now() - new Date(referenceTimestamp).getTime();

  if (task.state === "ready" && ageMs >= config.readyTaskAlertMs) {
    return "stale:ready";
  }

  if (task.state === "claimed" && ageMs >= config.claimedTaskAlertMs) {
    return "stale:claimed";
  }

  if (task.state === "running" && ageMs >= config.runningTaskAlertMs) {
    return "stale:running";
  }

  if (task.state === "in_review" && ageMs >= config.runningTaskAlertMs) {
    return "stale:in_review";
  }

  return null;
}

function buildNotificationKey(notificationKind: string): string {
  const bucket = Math.floor(
    Date.now() / Math.max(60_000, config.taskNotificationCooldownMs)
  );
  return `${notificationKind}:${bucket}`;
}

async function shouldNotifyOperator(
  task: AttentionTask,
  rootTask: OperatorRootTask | null
): Promise<boolean> {
  if (task.assigned_role === "sentinel" && !task.parent_task_id) {
    return false;
  }

  if (task.state === "blocked_on_human") {
    return true;
  }

  if (rootTask) {
    if (
      rootTask.assigned_role === "relay" ||
      rootTask.title.startsWith("Process message:")
    ) {
      return true;
    }
  }

  if (task.parent_task_id) {
    return true;
  }

  return (
    (task.priority === "high" || task.priority === "critical") &&
    task.assigned_role !== "relay" &&
    task.assigned_role !== "sentinel"
  );
}

async function findRootTask(
  task: AttentionTask
): Promise<OperatorRootTask | null> {
  const db = getDb();
  let current: OperatorRootTask = {
    assigned_role: task.assigned_role,
    id: task.id,
    parent_task_id: task.parent_task_id,
    title: task.title,
  };

  const visited = new Set<string>([task.id]);

  while (current.parent_task_id) {
    if (visited.has(current.parent_task_id)) {
      break;
    }
    visited.add(current.parent_task_id);

    const { data, error } = await db
      .from("tasks")
      .select("id,title,parent_task_id,assigned_role")
      .eq("id", current.parent_task_id)
      .maybeSingle<OperatorRootTask>();

    if (error || !data) {
      break;
    }

    current = data;
  }

  return current;
}

async function notificationSentWithinCooldown(taskId: string): Promise<boolean> {
  const db = getDb();
  const cutoff = new Date(
    Date.now() - config.taskNotificationCooldownMs
  ).toISOString();
  const { count, error } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "operator.notification.sent")
    .eq("scope_type", "task")
    .eq("scope_id", taskId)
    .gte("created_at", cutoff);

  if (error) {
    console.error(
      `Failed to check prior operator notification for task ${taskId}:`,
      error
    );
    return false;
  }

  return Boolean(count && count > 0);
}

async function loadLatestTaskActivity(
  taskIds: string[]
): Promise<Map<string, TaskActivity>> {
  const db = getDb();
  const activityMap = new Map<string, TaskActivity>();

  if (!taskIds.length) {
    return activityMap;
  }

  const { data, error } = await db.rpc("latest_task_activity", {
    p_task_ids: taskIds,
  });

  if (error) {
    console.error("Failed to load latest task activity:", error);
    return activityMap;
  }

  for (const row of data || []) {
    const scopeId =
      row && typeof row.scope_id === "string" ? row.scope_id : null;
    if (!scopeId || activityMap.has(scopeId)) {
      continue;
    }

    activityMap.set(scopeId, {
      created_at:
        typeof row.created_at === "string" ? row.created_at : null,
      summary: typeof row.summary === "string" ? row.summary : null,
    });
  }

  return activityMap;
}

async function loadPendingApprovals(
  taskIds: string[]
): Promise<Map<string, PendingApproval[]>> {
  const db = getDb();
  const approvalMap = new Map<string, PendingApproval[]>();

  if (!taskIds.length) {
    return approvalMap;
  }

  const { data, error } = await db
    .from("approvals")
    .select("id,task_id,action_type,description,created_at")
    .eq("status", "pending")
    .in("task_id", taskIds)
    .order("created_at", { ascending: false })
    .returns<PendingApproval[]>();

  if (error) {
    console.error("Failed to load pending approvals for task attention:", error);
    return approvalMap;
  }

  for (const approval of data || []) {
    const current = approvalMap.get(approval.task_id) || [];
    current.push(approval);
    approvalMap.set(approval.task_id, current);
  }

  return approvalMap;
}

function selectPendingApproval(
  taskId: string,
  pendingApprovalsByTask: Map<string, PendingApproval[]>
): PendingApproval | null {
  const approvals = pendingApprovalsByTask.get(taskId) || [];
  return approvals[0] || null;
}

function buildApprovalBlockedAncestorSet(
  taskMap: Map<string, AttentionTask>,
  pendingApprovalsByTask: Map<string, PendingApproval[]>
): Set<string> {
  const ancestors = new Set<string>();

  for (const task of taskMap.values()) {
    if (
      task.state !== "blocked_on_human" &&
      !(pendingApprovalsByTask.get(task.id)?.length)
    ) {
      continue;
    }

    let parentTaskId = task.parent_task_id;
    while (parentTaskId) {
      if (ancestors.has(parentTaskId)) {
        break;
      }

      ancestors.add(parentTaskId);
      parentTaskId = taskMap.get(parentTaskId)?.parent_task_id || null;
    }
  }

  return ancestors;
}

function resolveTaskActivityTimestamp(
  task: AttentionTask,
  activity: TaskActivity | null
): string {
  if (
    (task.state === "running" || task.state === "in_review") &&
    activity?.created_at
  ) {
    return activity.created_at;
  }

  return task.updated_at || task.created_at;
}

function formatApprovalMessage(
  task: AttentionTask,
  rootTask: OperatorRootTask | null,
  approval: PendingApproval
): string {
  const role = task.assigned_role;
  const shortId = task.id.slice(0, 8);
  const rootSuffix =
    rootTask && rootTask.id !== task.id
      ? ` Root request: ${rootTask.title} (${rootTask.id.slice(0, 8)}).`
      : "";
  const description = normalizeApprovalDescription(approval.description);

  return `Approval needed: ${role} task "${task.title}" (${shortId}) requested approval for ${approval.action_type}.${rootSuffix} Requested action: ${description}`;
}

function formatAttentionMessage(
  task: AttentionTask,
  rootTask: OperatorRootTask | null,
  activity: TaskActivity | null
): string {
  const role = task.assigned_role;
  const shortId = task.id.slice(0, 8);
  const rootSuffix =
    rootTask && rootTask.id !== task.id
      ? ` Root request: ${rootTask.title} (${rootTask.id.slice(0, 8)}).`
      : "";

  if (task.state === "blocked_on_human") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) is blocked on human input.${rootSuffix} Reason: ${task.blocked_reason || task.last_handoff_note || "No reason recorded."}`;
  }

  if (task.state === "blocked_on_agent") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) is blocked on another agent.${rootSuffix} Reason: ${task.blocked_reason || task.last_handoff_note || "No reason recorded."}`;
  }

  if (task.state === "failed" || task.state === "dead_letter") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) ${task.state === "dead_letter" ? "hit dead-letter" : "failed"}.${rootSuffix} Latest note: ${task.last_handoff_note || "No handoff note recorded."}`;
  }

  const waitedMinutes = Math.max(
    1,
    Math.round(
      (Date.now() - new Date(resolveTaskActivityTimestamp(task, activity)).getTime()) /
        60000
    )
  );
  const activitySuffix = activity?.summary
    ? ` Last activity: ${activity.summary}`
    : "";

  if (task.state === "ready") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) has been queued in ready for about ${waitedMinutes} minutes without starting.${rootSuffix} Latest note: ${task.last_handoff_note || "No launch note recorded."}`;
  }

  if (task.state === "claimed") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) has been stuck in claimed for about ${waitedMinutes} minutes.${rootSuffix} Latest note: ${task.last_handoff_note || "No claim note recorded."}`;
  }

  if (task.state === "in_review") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) has been waiting in review for about ${waitedMinutes} minutes without agent activity.${rootSuffix}${activitySuffix} Latest note: ${task.last_handoff_note || "No review note recorded."}`;
  }

  return `Task attention: ${role} task "${task.title}" (${shortId}) has been running for about ${waitedMinutes} minutes without agent activity.${rootSuffix}${activitySuffix} Latest note: ${task.last_handoff_note || "No handoff note recorded."}`;
}

function normalizeApprovalDescription(description: string): string {
  const normalized = description.replace(/^\[Auto-policy\]\s*/i, "").trim();
  return normalized || "No approval description recorded.";
}

async function sendOperatorNotification(
  task: AttentionTask,
  notificationKey: string,
  content: string
): Promise<void> {
  const db = getDb();
  const notificationType = notificationKey.startsWith("approval:")
    ? "approval_required"
    : "task_attention";
  const delivery = await queueOperatorRelayMessage({
    content,
    metadata: {
      notification_key: notificationKey,
      notification_type: notificationType,
      task_state: task.state,
      task_title: task.title,
    },
    sender: "system",
    taskId: task.id,
  });

  if (!delivery.queued) {
    return;
  }

  const severity =
    task.state === "dead_letter" || task.state === "failed" ? "error" : "warning";

  const { error: eventError } = await db.from("events").insert({
    trace_id: null,
    agent_id: null,
    event_type: "operator.notification.sent",
    severity,
    scope_type: "task",
    scope_id: task.id,
    summary: content.slice(0, 500),
    detail: {
      delivery: "relay_queue",
      notification_key: notificationKey,
      notification_type: notificationType,
      task_state: task.state,
    },
  });

  if (eventError) {
    console.error(
      `Failed to record operator notification event for task ${task.id}:`,
      eventError
    );
  }
}
