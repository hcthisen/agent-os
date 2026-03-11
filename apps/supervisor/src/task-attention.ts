import { getDb } from "./db.js";
import { config } from "./config.js";
import { sendOperatorMessage } from "./operator-delivery.js";

type AttentionState =
  | "blocked_on_agent"
  | "blocked_on_human"
  | "claimed"
  | "dead_letter"
  | "failed"
  | "ready"
  | "running";

interface AttentionTask {
  assigned_role: string;
  attempt_count: number;
  blocked_reason: string | null;
  claimed_by: string | null;
  created_at: string;
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

const ATTENTION_STATES: AttentionState[] = [
  "ready",
  "claimed",
  "running",
  "blocked_on_agent",
  "blocked_on_human",
  "failed",
  "dead_letter",
];

export async function monitorTaskAttention(): Promise<void> {
  const db = getDb();
  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id,title,state,priority,assigned_role,parent_task_id,blocked_reason,last_handoff_note,attempt_count,claimed_by,created_at,updated_at"
    )
    .in("state", ATTENTION_STATES);

  if (error) {
    console.error("Failed to query task attention state:", error);
    return;
  }

  for (const task of (tasks || []) as AttentionTask[]) {
    const notificationKey = getNotificationKey(task);
    if (!notificationKey) {
      continue;
    }

    const rootTask = await findRootTask(task);
    if (!(await shouldNotifyOperator(task, rootTask))) {
      continue;
    }

    const alreadySent = await notificationAlreadySent(task.id, notificationKey);
    if (alreadySent) {
      continue;
    }

    const content = formatAttentionMessage(task, rootTask);
    await sendOperatorNotification(task, notificationKey, content);
  }
}

function getNotificationKey(task: AttentionTask): string | null {
  if (
    task.state === "ready" &&
    task.last_handoff_note?.startsWith("Supervisor could not start this task")
  ) {
    return `queue:blocker:${task.updated_at}`;
  }

  if (
    task.state === "failed" ||
    task.state === "dead_letter" ||
    task.state === "blocked_on_human" ||
    task.state === "blocked_on_agent"
  ) {
    return `state:${task.state}:${task.updated_at}`;
  }

  const ageMs = Date.now() - new Date(task.updated_at || task.created_at).getTime();

  if (task.state === "ready" && ageMs >= config.readyTaskAlertMs) {
    return `stale:ready:${task.updated_at}`;
  }

  if (task.state === "claimed" && ageMs >= config.claimedTaskAlertMs) {
    return `stale:claimed:${task.updated_at}`;
  }

  if (task.state === "running" && ageMs >= config.runningTaskAlertMs) {
    return `stale:running:${task.updated_at}`;
  }

  return null;
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

async function notificationAlreadySent(
  taskId: string,
  notificationKey: string
): Promise<boolean> {
  const db = getDb();
  const { count, error } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "operator.notification.sent")
    .eq("scope_type", "task")
    .eq("scope_id", taskId)
    .contains("detail", { notification_key: notificationKey });

  if (error) {
    console.error(
      `Failed to check prior operator notification for task ${taskId}:`,
      error
    );
    return false;
  }

  return Boolean(count && count > 0);
}

function formatAttentionMessage(
  task: AttentionTask,
  rootTask: OperatorRootTask | null
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
    Math.round((Date.now() - new Date(task.updated_at || task.created_at).getTime()) / 60000)
  );

  if (task.state === "ready") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) has been queued in ready for about ${waitedMinutes} minutes without starting.${rootSuffix} Latest note: ${task.last_handoff_note || "No launch note recorded."}`;
  }

  if (task.state === "claimed") {
    return `Task attention: ${role} task "${task.title}" (${shortId}) has been stuck in claimed for about ${waitedMinutes} minutes.${rootSuffix} Latest note: ${task.last_handoff_note || "No claim note recorded."}`;
  }

  return `Task attention: ${role} task "${task.title}" (${shortId}) has been running for about ${waitedMinutes} minutes without a terminal update.${rootSuffix} Latest note: ${task.last_handoff_note || "No handoff note recorded."}`;
}

async function sendOperatorNotification(
  task: AttentionTask,
  notificationKey: string,
  content: string
): Promise<void> {
  const db = getDb();
  const delivery = await sendOperatorMessage({
    content,
    metadata: {
      notification_key: notificationKey,
      task_state: task.state,
      task_title: task.title,
    },
    sender: "system",
    taskId: task.id,
  });

  if (!delivery.sent) {
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
      notification_key: notificationKey,
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
