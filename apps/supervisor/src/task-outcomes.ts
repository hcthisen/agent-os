import { getDb } from "./db.js";
import { config } from "./config.js";
import { queueOperatorRelayMessage } from "./operator-delivery.js";

interface CompletedTask {
  assigned_role: string;
  completed_at: string | null;
  id: string;
  last_handoff_note: string | null;
  parent_task_id: string | null;
  state: string;
  title: string;
  updated_at: string;
}

interface RootTask {
  assigned_role: string;
  id: string;
  parent_task_id: string | null;
  title: string;
}

export async function monitorTaskOutcomes(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(
    Date.now() - config.completionNotificationLookbackMs
  ).toISOString();

  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id,title,state,assigned_role,parent_task_id,last_handoff_note,completed_at,updated_at"
    )
    .eq("state", "completed")
    .not("parent_task_id", "is", null)
    .gte("updated_at", cutoff);

  if (error) {
    console.error("Failed to query completed tasks for operator updates:", error);
    return;
  }

  for (const task of (tasks || []) as CompletedTask[]) {
    if (!(await isLeafTask(task.id))) {
      continue;
    }

    const rootTask = await findRootTask(task);
    if (!rootTask) {
      continue;
    }

    if (
      rootTask.assigned_role !== "relay" &&
      !rootTask.title.startsWith("Process message:")
    ) {
      continue;
    }

    const notificationKey = `completion:${task.updated_at}`;
    if (await notificationAlreadySent(task.id, notificationKey)) {
      continue;
    }

    const content = formatCompletionMessage(task, rootTask);
    await sendOperatorCompletion(task.id, notificationKey, content);
  }
}

async function isLeafTask(taskId: string): Promise<boolean> {
  const db = getDb();
  const { count, error } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("parent_task_id", taskId);

  if (error) {
    console.error(`Failed to inspect child tasks for ${taskId}:`, error);
    return false;
  }

  return !count;
}

async function findRootTask(task: CompletedTask): Promise<RootTask | null> {
  const db = getDb();
  let current: RootTask = {
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
      .maybeSingle<RootTask>();

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
    .eq("event_type", "operator.completion.sent")
    .eq("scope_type", "task")
    .eq("scope_id", taskId)
    .contains("detail", { notification_key: notificationKey });

  if (error) {
    console.error(
      `Failed to check completion notification status for task ${taskId}:`,
      error
    );
    return false;
  }

  return Boolean(count && count > 0);
}

function formatCompletionMessage(task: CompletedTask, rootTask: RootTask): string {
  const outcome = summarizeOutcome(task.last_handoff_note);
  const prefix =
    task.assigned_role === "builder"
      ? "Done."
      : `${capitalize(task.assigned_role)} finished.`;

  if (outcome) {
    return `${prefix} ${outcome}`;
  }

  const rootSuffix =
    rootTask.id !== task.id ? ` Request: ${simplifyTitle(rootTask.title)}.` : "";
  return `${prefix} ${simplifyTitle(task.title)} is complete.${rootSuffix}`;
}

function summarizeOutcome(note: string | null): string | null {
  if (!note) {
    return null;
  }

  const compact = note.replace(/\s+/g, " ").trim();
  const changed = extractSection(compact, "What changed:");
  const blocked = extractSection(compact, "What is blocked:");
  const liveUrlMatch = compact.match(/https?:\/\/[^\s)]+/i);
  const publishedLiveMatch = compact.match(
    /public site .*?(rebuilt|published).*?live at (https?:\/\/[^\s)]+)/i
  );

  if (publishedLiveMatch) {
    return `The public site is rebuilt and live at ${publishedLiveMatch[2]}.`;
  }

  if (changed) {
    const cleaned = toSingleSentence(changed);
    if (liveUrlMatch && !cleaned.includes(liveUrlMatch[0])) {
      return trimSentence(`${cleaned} Live at ${liveUrlMatch[0]}.`);
    }

    return trimSentence(cleaned);
  }

  if (blocked && !/^nothing blocked/i.test(blocked)) {
    return trimSentence(`Completed, but still blocked by ${toSingleSentence(blocked)}`);
  }

  if (liveUrlMatch) {
    return `Live at ${liveUrlMatch[0]}.`;
  }

  return trimSentence(toSingleSentence(compact));
}

function extractSection(note: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = note.match(
    new RegExp(`${escaped}\\s*(.*?)(?=\\s+[A-Z][^:]{1,40}:|$)`, "i")
  );

  return match?.[1]?.trim() || null;
}

function toSingleSentence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const firstSentence = compact.match(/^(.+?[.!?])(\s|$)/);
  return (firstSentence?.[1] || compact)
    .replace(/^[-:]\s*/, "")
    .replace(/^(the workspace now contains|what changed:)\s*/i, "")
    .trim();
}

function trimSentence(value: string, maxLength = 260): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function simplifyTitle(title: string): string {
  return title.replace(/^Process message:\s*/i, "").trim();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function sendOperatorCompletion(
  taskId: string,
  notificationKey: string,
  content: string
): Promise<void> {
  const db = getDb();
  const delivery = await queueOperatorRelayMessage({
    content,
    metadata: {
      notification_key: notificationKey,
      notification_type: "task_completion",
    },
    sender: "system",
    taskId,
  });

  if (!delivery.queued) {
    return;
  }

  const { error: eventError } = await db.from("events").insert({
    trace_id: null,
    agent_id: null,
    event_type: "operator.completion.sent",
    severity: "info",
    scope_type: "task",
    scope_id: taskId,
    summary: content.slice(0, 500),
    detail: {
      delivery: "relay_queue",
      notification_key: notificationKey,
      notification_type: "task_completion",
    },
  });

  if (eventError) {
    console.error(
      `Failed to record completion notification event for ${taskId}:`,
      eventError
    );
  }
}
