import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { sendAdminOnlyMessage, sendManagedMessage } from "./operator-delivery.js";
import { maybePublishOperatorResultPage } from "./result-delivery.js";
import { maybeAutocaptureReusableSkill } from "./skill-autocapture.js";

const TASK_SELECT_FIELDS =
  "id,title,objective,state,assigned_role,parent_task_id,last_handoff_note,completed_at,updated_at,project_id,attempt_count,claimed_by,customer_id,department_id,simulation_only";

interface CompletedTask {
  assigned_role: string;
  attempt_count: number;
  claimed_by: string | null;
  completed_at: string | null;
  customer_id: string | null;
  department_id: string | null;
  id: string;
  last_handoff_note: string | null;
  objective: string | null;
  parent_task_id: string | null;
  project_id: string | null;
  simulation_only?: boolean | null;
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

interface TaskArtifactSummaryRow {
  artifact_type: string;
  created_at: string;
  external_url: string | null;
  metadata: Record<string, unknown> | null;
  mime_type: string | null;
  name: string;
  storage_path: string | null;
  task_id: string | null;
}

interface TaskMessageRow {
  channel: string;
  created_at: string;
  direction: string;
  id: string;
  metadata: Record<string, unknown> | null;
  sender: string;
}

interface CompletionCandidate {
  artifactSummary: string | null;
  score: number;
  task: CompletedTask;
}

interface DeliveryTarget {
  channel: "admin_chat" | "telegram";
  chatId: number | string | null;
  sourceMessageId: string | null;
}

interface DeliveryPageLink {
  path: string;
  url: string | null;
}

export async function monitorTaskOutcomes(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(
    Date.now() - config.completionNotificationLookbackMs
  ).toISOString();

  const { data: tasks, error } = await db
    .from("tasks")
    .select(TASK_SELECT_FIELDS)
    .eq("state", "completed")
    .gte("updated_at", cutoff);

  if (error) {
    console.error("Failed to query completed tasks for operator updates:", error);
    return;
  }

  for (const task of (tasks || []) as CompletedTask[]) {
    await maybeAutocaptureReusableSkill(task);

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

    const requestTasks = await loadRelayRequestTreeTasks(rootTask.id);
    if (!requestTasks.length) {
      continue;
    }

    const requestComplete = requestTasks.every(
      (requestTask) => requestTask.state === "completed"
    );
    const deliveryTarget = await resolveRootRequestDeliveryTarget(rootTask.id);

    if (!requestComplete) {
      const progressNotificationKey = `request-progress:${task.id}`;
      if (
        shouldSendInterimProgressUpdate(task, rootTask, requestTasks) &&
        !(await hasAgentAuthoredOutboundMessage(requestTasks.map((entry) => entry.id))) &&
        !(await notificationAlreadySent(rootTask.id, progressNotificationKey))
      ) {
        const artifactSummary = (
          await loadTaskArtifactSummaries([task.id])
        ).get(task.id);
        const content = formatCompletionMessage(
          task,
          rootTask,
          false,
          artifactSummary || null
        );
        await sendOperatorProgress(
          rootTask.id,
          progressNotificationKey,
          content,
          deliveryTarget
        );
      }
      continue;
    }

    const notificationKey = `request-completion:${rootTask.id}`;
    const requestCompletionAt = resolveRequestCompletionTimestamp(requestTasks);
    if (
      (await hasRecentAgentAuthoredOutboundMessage(
        requestTasks.map((entry) => entry.id),
        requestCompletionAt
      )) ||
      (await notificationAlreadySent(rootTask.id, notificationKey))
    ) {
      continue;
    }

    const completionCandidate = await selectCompletionCandidate(
      requestTasks,
      task.id
    );
    const content = formatCompletionMessage(
      completionCandidate.task,
      rootTask,
      true,
      completionCandidate.artifactSummary
    );
    const resultPageLink = await maybePublishOperatorResultPage({
      deliveryChannel: deliveryTarget.channel,
      requestTasks,
      rootTaskId: rootTask.id,
      rootTaskTitle: rootTask.title,
      selectedTask: completionCandidate.task,
      summary: content,
    });
    const deliveredContent = formatDeliveredCompletionMessage(
      content,
      resultPageLink,
      deliveryTarget.channel
    );
    await sendOperatorCompletion(
      rootTask.id,
      notificationKey,
      deliveredContent,
      deliveryTarget,
      resultPageLink,
      completionCandidate.task
    );
  }

  await monitorBlockedTaskRequirements(cutoff);
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

export async function findRootTaskById(taskId: string): Promise<RootTask | null> {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) {
    return null;
  }

  const db = getDb();
  const { data, error } = await db
    .from("tasks")
    .select("id,title,parent_task_id,assigned_role")
    .eq("id", normalizedTaskId)
    .maybeSingle<RootTask>();

  if (error || !data) {
    return null;
  }

  return findRootTask({
    assigned_role: data.assigned_role,
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: data.id,
    last_handoff_note: null,
    objective: null,
    parent_task_id: data.parent_task_id,
    project_id: null,
    state: "running",
    title: data.title,
    updated_at: new Date().toISOString(),
  });
}

function shouldSendInterimProgressUpdate(
  task: CompletedTask,
  rootTask: RootTask,
  requestTasks: CompletedTask[]
): boolean {
  if (task.state !== "completed") {
    return false;
  }

  if (!String(task.last_handoff_note || "").trim()) {
    return false;
  }

  if (task.id === rootTask.id) {
    return (
      countRequestTreeChildren(rootTask.id, requestTasks) === 0 ||
      looksLikeRequirementsChecklist(task.last_handoff_note || "")
    );
  }

  if (task.assigned_role === "relay") {
    return true;
  }

  if (task.assigned_role === "sage") {
    return false;
  }

  return countRequestTreeChildren(task.id, requestTasks) > 0;
}

function chooseBlockedRequestUpdateCandidate(
  rootTask: RootTask,
  requestTasks: CompletedTask[]
): CompletedTask | null {
  const blockedTasks = requestTasks
    .filter(
      (task) =>
        (task.state === "blocked_on_agent" || task.state === "blocked_on_human") &&
        looksLikeRequirementsChecklist(task.last_handoff_note || "")
    )
    .sort((left, right) => {
      const updatedAtDelta =
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
      if (updatedAtDelta !== 0) {
        return updatedAtDelta;
      }

      const blockedStatePriority = (task: CompletedTask): number => {
        if (task.state === "blocked_on_human") {
          return 2;
        }
        if (task.state === "blocked_on_agent") {
          return 1;
        }
        return 0;
      };
      const blockedStateDelta =
        blockedStatePriority(right) - blockedStatePriority(left);
      if (blockedStateDelta !== 0) {
        return blockedStateDelta;
      }

      const leftRoot = left.id === rootTask.id ? 1 : 0;
      const rightRoot = right.id === rootTask.id ? 1 : 0;
      if (rightRoot !== leftRoot) {
        return rightRoot - leftRoot;
      }

      const leftLength = String(left.last_handoff_note || "").length;
      const rightLength = String(right.last_handoff_note || "").length;
      if (rightLength !== leftLength) {
        return rightLength - leftLength;
      }

      return String(left.id).localeCompare(String(right.id));
    });

  return blockedTasks[0] || null;
}

function countRequestTreeChildren(
  taskId: string,
  requestTasks: CompletedTask[]
): number {
  return requestTasks.filter((task) => task.parent_task_id === taskId).length;
}

function looksLikeRequirementsChecklist(note: string): boolean {
  const normalized = String(note || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  return /\b(required now|need(?:ed)? now|need from you|what i (?:still )?need now|what i(?:'|’)ll need later|what i will need later|credentials?|api keys?|tokens?|accounts?|service connections?|optional but helpful|needed later|required later)\b/i.test(
    normalized
  );
}

function trimChecklistMessage(value: string, maxLength = 3500): string {
  const normalized = String(value || "").replace(/\r/g, "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function formatBlockedChecklistMessage(note: string): string {
  const normalized = String(note || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return "";
  }

  const explicitChecklist = extractExplicitChecklist(normalized);
  if (explicitChecklist) {
    return trimChecklistMessage(sanitizeChecklistMessage(explicitChecklist));
  }

  const derivedChecklist = deriveChecklistFromInternalRelayNote(normalized);
  if (derivedChecklist) {
    return trimChecklistMessage(sanitizeChecklistMessage(derivedChecklist));
  }

  return trimChecklistMessage(normalized);
}

function formatBlockedRequestUpdateMessage(
  blockedCandidate: CompletedTask,
  requestTasks: CompletedTask[]
): string {
  const checklist = formatBlockedChecklistMessage(
    blockedCandidate.last_handoff_note || ""
  );
  if (!checklist) {
    return "";
  }

  const executionStatus = buildBlockedExecutionStatusSection(
    blockedCandidate,
    requestTasks
  );
  return [executionStatus, checklist].filter(Boolean).join("\n\n");
}

function buildBlockedExecutionStatusSection(
  blockedCandidate: CompletedTask,
  requestTasks: CompletedTask[]
): string | null {
  const activeExecutionTask = requestTasks
    .filter(
      (task) =>
        task.id !== blockedCandidate.id &&
        task.assigned_role !== "relay" &&
        ["claimed", "running", "in_review"].includes(task.state)
    )
    .sort((left, right) => {
      const priority = (value: string): number => {
        if (value === "running") {
          return 3;
        }
        if (value === "claimed") {
          return 2;
        }
        if (value === "in_review") {
          return 1;
        }
        return 0;
      };

      const priorityDelta = priority(right.state) - priority(left.state);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return (
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      );
    })[0];

  if (!activeExecutionTask) {
    return null;
  }

  const roleLabel = capitalize(activeExecutionTask.assigned_role);
  const title = simplifyTitle(activeExecutionTask.title || "");
  const detail = title
    ? `${roleLabel} work has already started: ${title}.`
    : `${roleLabel} work has already started on this request.`;

  return `Execution status:\n- ${detail}`;
}

function extractExplicitChecklist(note: string): string | null {
  const headingMatch = note.match(
    /(?:^|\n)\s*(?:Required now:|What I need now:|What I still need now:|Need from you:|Needed later:|What I'll need later:|What I will need later:|Optional but helpful:)/i
  );
  if (!headingMatch || typeof headingMatch.index !== "number") {
    return null;
  }

  const prefix = note.slice(0, headingMatch.index).trim();
  const checklist = note.slice(headingMatch.index).trim();
  if (!checklist) {
    return null;
  }

  if (!prefix || looksInternalRelayPreamble(prefix)) {
    return checklist;
  }

  return `${trimSentence(toSingleSentence(prefix), 180)}\n\n${checklist}`;
}

function looksInternalRelayPreamble(value: string): boolean {
  return /\b(Classified the inbound|Attached to existing project|Created downstream|Confirmed missing required service connection|Operator-facing checklist should ask)\b/i.test(
    value
  );
}

function deriveChecklistFromInternalRelayNote(note: string): string | null {
  const requiredItems = new Map<string, string>();
  const laterItems = new Map<string, string>();

  for (const match of note.matchAll(
    /missing required service connection\s+(.+?)\s+is blocked on\s+([^.;]+)\.?/gi
  )) {
    const serviceName = trimChecklistItem(match[1] || "");
    const reason = trimChecklistItem(match[2] || "");
    if (!serviceName) {
      continue;
    }

    const item = reason
      ? `Add ${serviceName} in Service Connections (${reason}).`
      : `Add ${serviceName} in Service Connections.`;
    requiredItems.set(normalizeChecklistIdentity(serviceName), item);
  }

  const operatorChecklistMatch = note.match(
    /Operator-facing checklist should ask for\s+(.+?)\s+later,\s+while noting\s+(.+?)\s+(?:is|are)\s+required now\.?/i
  );
  if (operatorChecklistMatch) {
    for (const item of splitChecklistPhrase(operatorChecklistMatch[1] || "")) {
      const normalizedItem = normalizeChecklistIdentity(item);
      if (!laterItems.has(normalizedItem)) {
        laterItems.set(normalizedItem, item);
      }
    }

    for (const item of splitChecklistPhrase(operatorChecklistMatch[2] || "")) {
      const normalizedItem = normalizeChecklistIdentity(item);
      if (!requiredItems.has(normalizedItem)) {
        requiredItems.set(normalizedItem, item);
      }
    }
  }

  if (!requiredItems.size && !laterItems.size) {
    return null;
  }

  const sections: string[] = [];
  if (requiredItems.size) {
    sections.push(
      ["Required now:", ...[...requiredItems.values()].map((item) => `- ${item}`)].join("\n")
    );
  }

  if (laterItems.size) {
    sections.push(
      ["Needed later:", ...[...laterItems.values()].map((item) => `- ${item}`)].join("\n")
    );
  }

  return sections.join("\n\n");
}

function splitChecklistPhrase(value: string): string[] {
  return String(value || "")
    .replace(/\s+(?:and|&)\s+/gi, "|")
    .split(/[|,;]/)
    .map((item) => trimChecklistItem(item))
    .filter(Boolean);
}

function trimChecklistItem(value: string): string {
  return String(value || "")
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
}

function normalizeChecklistIdentity(value: string): string {
  return trimChecklistItem(value)
    .toLowerCase()
    .replace(/^add\s+/, "")
    .replace(/\s+in service connections.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeChecklistMessage(value: string): string {
  const sections: Array<{ heading: string; items: string[] }> = [];
  let currentSection: { heading: string; items: string[] } | null = null;

  for (const rawLine of String(value || "").replace(/\r/g, "").split("\n")) {
    const headingMatch = rawLine.match(
      /^\s*(Required now:|What I need now:|What I still need now:|Need from you:|Needed later:|What I'll need later:|What I will need later:|Optional but helpful:)\s*$/i
    );
    if (headingMatch) {
      if (currentSection && currentSection.items.length > 0) {
        sections.push(currentSection);
      }
      currentSection = {
        heading: headingMatch[1],
        items: [],
      };
      continue;
    }

    const bulletMatch = rawLine.match(/^\s*-\s+(.+)$/);
    if (!bulletMatch || !currentSection) {
      continue;
    }

    const item = trimChecklistItem(bulletMatch[1] || "");
    if (!item || !isOperatorActionableChecklistItem(item)) {
      continue;
    }

    currentSection.items.push(item);
  }

  if (currentSection && currentSection.items.length > 0) {
    sections.push(currentSection);
  }

  return sections
    .map((section) => [section.heading, ...section.items.map((item) => `- ${item}`)].join("\n"))
    .join("\n\n")
    .trim();
}

function isOperatorActionableChecklistItem(value: string): boolean {
  const normalized = trimChecklistItem(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  return !/\b(?:allow|let)\s+the\s+(?:downstream|planning|builder|reviewer|child)\s+task\b|\b(?:downstream|planning|builder|reviewer|child)\s+task\b|\bimplementation approach\b/i.test(
    normalized
  );
}

async function loadRelayRequestTreeTasks(rootTaskId: string): Promise<CompletedTask[]> {
  const db = getDb();
  const tasks = new Map<string, CompletedTask>();
  const { data: rootTask, error: rootError } = await db
    .from("tasks")
    .select(TASK_SELECT_FIELDS)
    .eq("id", rootTaskId)
    .maybeSingle<CompletedTask>();

  if (rootError || !rootTask) {
    console.error(`Failed to load root task ${rootTaskId} for completion aggregation:`, rootError);
    return [];
  }

  tasks.set(rootTask.id, rootTask);
  const queue = [rootTaskId];
  const visited = new Set<string>();

  while (queue.length) {
    const parentIds = queue.splice(0, 50).filter((parentId) => {
      if (visited.has(parentId)) {
        return false;
      }

      visited.add(parentId);
      return true;
    });

    if (!parentIds.length) {
      continue;
    }

    const { data, error } = await db
      .from("tasks")
      .select(TASK_SELECT_FIELDS)
      .in("parent_task_id", parentIds)
      .returns<CompletedTask[]>();

    if (error) {
      console.error(`Failed to load relay request tree tasks for ${rootTaskId}:`, error);
      return [...tasks.values()];
    }

    for (const childTask of data || []) {
      tasks.set(childTask.id, childTask);
      queue.push(childTask.id);
    }
  }

  return [...tasks.values()];
}

async function notificationAlreadySent(
  taskId: string,
  notificationKey: string
): Promise<boolean> {
  const db = getDb();
  const { count, error } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
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

async function hasAgentAuthoredOutboundMessage(taskIds: string[]): Promise<boolean> {
  const filteredTaskIds = [...new Set(taskIds.filter(Boolean))];
  if (!filteredTaskIds.length) {
    return false;
  }

  const db = getDb();
  const { data, error } = await db
    .from("messages")
    .select("id,sender,metadata")
    .eq("direction", "outbound")
    .in("task_id", filteredTaskIds);

  if (error) {
    console.error("Failed to inspect prior outbound operator replies:", error);
    return false;
  }

  return (data || []).some((message) => !isSynthesizedOperatorNotification(message));
}

async function hasRecentAgentAuthoredOutboundMessage(
  taskIds: string[],
  since: string
): Promise<boolean> {
  const filteredTaskIds = [...new Set(taskIds.filter(Boolean))];
  if (!filteredTaskIds.length) {
    return false;
  }

  const db = getDb();
  const { data, error } = await db
    .from("messages")
    .select("id,sender,metadata")
    .eq("direction", "outbound")
    .gte("created_at", since)
    .in("task_id", filteredTaskIds);

  if (error) {
    console.error("Failed to inspect recent outbound operator replies:", error);
    return false;
  }

  return (data || []).some((message) => !isSynthesizedOperatorNotification(message));
}

async function monitorBlockedTaskRequirements(cutoff: string): Promise<void> {
  const db = getDb();
  const { data: blockedTasks, error } = await db
    .from("tasks")
    .select(TASK_SELECT_FIELDS)
    .in("state", ["blocked_on_agent", "blocked_on_human"])
    .gte("updated_at", cutoff)
    .returns<CompletedTask[]>();

  if (error) {
    console.error("Failed to query blocked tasks for operator updates:", error);
    return;
  }

  const relayRoots = new Map<string, RootTask>();
  for (const blockedTask of blockedTasks || []) {
    const rootTask = await findRootTask(blockedTask);
    if (
      !rootTask ||
      (rootTask.assigned_role !== "relay" &&
        !rootTask.title.startsWith("Process message:"))
    ) {
      continue;
    }

    relayRoots.set(rootTask.id, rootTask);
  }

  for (const [rootTaskId, rootTask] of relayRoots.entries()) {
    const requestTasks = await loadRelayRequestTreeTasks(rootTaskId);
    if (!requestTasks.length) {
      continue;
    }

    const requestComplete = requestTasks.every(
      (requestTask) => requestTask.state === "completed"
    );
    if (requestComplete) {
      continue;
    }

    const blockedCandidate = chooseBlockedRequestUpdateCandidate(
      rootTask,
      requestTasks
    );
    if (!blockedCandidate) {
      continue;
    }

    if (
      (await hasAgentAuthoredOutboundMessage([blockedCandidate.id])) ||
      await hasRecentAgentAuthoredOutboundMessage(
        requestTasks.map((task) => task.id),
        blockedCandidate.updated_at
      )
    ) {
      continue;
    }

    const content = formatBlockedRequestUpdateMessage(
      blockedCandidate,
      requestTasks
    );
    if (!content) {
      continue;
    }

    await sendRelayLifecycleUpdate({
      content,
      eventType: "operator.progress.sent",
      extraMetadata: {
        related_task_id: blockedCandidate.id,
        related_task_role: blockedCandidate.assigned_role,
        relay_update_kind: "blocked",
        task_state: blockedCandidate.state,
      },
      notificationKey: `request-blocked:${blockedCandidate.id}:${blockedCandidate.updated_at}`,
      notificationType: "task_progress",
      rootTaskId,
    });
  }
}

function resolveRequestCompletionTimestamp(requestTasks: CompletedTask[]): string {
  const timestamps = requestTasks
    .map((task) => task.completed_at || task.updated_at)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) {
    return new Date().toISOString();
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

export async function sendRelayLifecycleUpdate(args: {
  content: string;
  deliveryTarget?: DeliveryTarget;
  eventType: "operator.completion.sent" | "operator.progress.sent";
  extraMetadata?: Record<string, unknown>;
  notificationKey: string;
  notificationType: "task_completion" | "task_progress";
  rootTaskId: string;
}): Promise<void> {
  if (await notificationAlreadySent(args.rootTaskId, args.notificationKey)) {
    return;
  }

  const deliveryTarget =
    args.deliveryTarget || (await resolveRootRequestDeliveryTarget(args.rootTaskId));
  await sendOperatorNotification(
    args.rootTaskId,
    args.notificationKey,
    args.content,
    deliveryTarget,
    args.notificationType,
    args.eventType,
    args.extraMetadata || {}
  );
}

async function selectCompletionCandidate(
  requestTasks: CompletedTask[],
  preferredTaskId: string
): Promise<CompletionCandidate> {
  const artifactSummaries = await loadTaskArtifactSummaries(
    requestTasks.map((task) => task.id)
  );
  const candidate = pickBestCompletionCandidate(
    requestTasks,
    artifactSummaries,
    preferredTaskId
  );

  if (candidate) {
    return candidate;
  }

  const fallbackTask =
    requestTasks.find((task) => task.id === preferredTaskId) || requestTasks[0];
  return {
    artifactSummary: artifactSummaries.get(fallbackTask.id) || null,
    score: 0,
    task: fallbackTask,
  };
}

function formatCompletionMessage(
  task: CompletedTask,
  rootTask: RootTask,
  rootRequestComplete = false,
  artifactSummary: string | null = null
): string {
  if (looksLikeRequirementsChecklist(task.last_handoff_note || "")) {
    return trimChecklistMessage(task.last_handoff_note || "");
  }

  const outcome = summarizeOutcome(
    task,
    task.last_handoff_note,
    task.assigned_role,
    artifactSummary
  );
  const prefix = rootRequestComplete
    ? "Done."
    : task.assigned_role === "builder"
      ? "Done."
      : `${capitalize(task.assigned_role)} finished.`;

  if (outcome) {
    return `${prefix} ${outcome}`;
  }

  const rootSuffix =
    rootTask.id !== task.id ? ` Request: ${simplifyTitle(rootTask.title)}.` : "";
  return `${prefix} ${simplifyTitle(task.title)} is complete.${rootSuffix}`;
}

function summarizeOutcome(
  task: Pick<CompletedTask, "objective" | "title">,
  note: string | null,
  role?: string,
  artifactSummary?: string | null
): string | null {
  if (!note) {
    return artifactSummary ? normalizeArtifactSummary(artifactSummary, task) : null;
  }

  const compact = note.replace(/\s+/g, " ").trim();
  const changed = extractSection(compact, "What changed:");
  const blocked = extractSection(compact, "What is blocked:");
  const liveUrlMatch = compact.match(/https?:\/\/[^\s)]+/i);
  const publishedLiveMatch = compact.match(
    /public site .*?(rebuilt|published).*?live at (https?:\/\/[^\s)]+)/i
  );
  const hasDryRunExample = /\bdry-?run example\b/i.test(compact);

  if (publishedLiveMatch) {
    return `The public site is rebuilt and live at ${publishedLiveMatch[2]}.`;
  }

  if (changed) {
    if (shouldPreferArtifactSummary(changed, task, artifactSummary)) {
      return normalizeArtifactSummary(artifactSummary || "", task);
    }

    const cleaned = normalizeRoleSpecificOutcome(
      toSingleSentence(changed),
      role || ""
    );
    if (liveUrlMatch && !cleaned.includes(liveUrlMatch[0])) {
      return trimSentence(`${cleaned} Live at ${liveUrlMatch[0]}.`);
    }

    return trimSentence(cleaned);
  }

  if (artifactSummary && looksLikeReportTask(task)) {
    return normalizeArtifactSummary(artifactSummary, task);
  }

  if (hasDryRunExample) {
    const lead = trimSentence(toSingleSentence(compact), 180);
    return trimSentence(`${lead} A dry-run example is included.`, 260);
  }

  if (blocked && !/^nothing blocked/i.test(blocked)) {
    return trimSentence(`Completed, but still blocked by ${toSingleSentence(blocked)}`);
  }

  if (liveUrlMatch) {
    return `Live at ${liveUrlMatch[0]}.`;
  }

  return trimSentence(toSingleSentence(compact));
}

async function loadTaskArtifactSummaries(
  taskIds: string[]
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  const filteredTaskIds = [...new Set(taskIds.filter(Boolean))];
  if (!filteredTaskIds.length) {
    return summaries;
  }

  const db = getDb();
  const { data, error } = await db
    .from("artifacts")
    .select(
      "task_id,artifact_type,name,metadata,created_at,storage_path,external_url,mime_type"
    )
    .in("task_id", filteredTaskIds)
    .in("artifact_type", ["report", "doc"])
    .order("created_at", { ascending: false })
    .returns<TaskArtifactSummaryRow[]>();

  if (error) {
    console.error("Failed to load artifacts for completion summaries:", error);
    return summaries;
  }

  for (const artifact of data || []) {
    if (!artifact.task_id || summaries.has(artifact.task_id)) {
      continue;
    }

    const summary = await deriveArtifactSummary(artifact);
    if (summary) {
      summaries.set(artifact.task_id, summary);
    }
  }

  return summaries;
}

async function deriveArtifactSummary(
  artifact: TaskArtifactSummaryRow
): Promise<string | null> {
  const metadataSummary =
    artifact.metadata && typeof artifact.metadata.indexable_content === "string"
      ? artifact.metadata.indexable_content.trim()
      : "";
  const fileSummary = await readArtifactDocumentSummary(artifact);

  if (fileSummary && fileSummary.length >= 80) {
    return fileSummary;
  }

  if (metadataSummary) {
    return metadataSummary;
  }

  return fileSummary || null;
}

async function readArtifactDocumentSummary(
  artifact: TaskArtifactSummaryRow
): Promise<string | null> {
  if (!artifact.task_id || !artifact.storage_path) {
    return null;
  }

  const extension = extname(artifact.storage_path).toLowerCase();
  if (![".html", ".markdown", ".md", ".txt"].includes(extension)) {
    return null;
  }

  const workspaceRoot = resolve(config.workspacesDir, artifact.task_id);
  const absolutePath = resolve(workspaceRoot, artifact.storage_path);
  if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
    return null;
  }

  try {
    const content = await readFile(absolutePath, "utf8");
    return summarizeArtifactDocument(content, artifact.name);
  } catch {
    return null;
  }
}

function summarizeArtifactDocument(content: string, artifactName: string): string | null {
  const cleaned = cleanMarkdownText(content);
  if (!cleaned) {
    return null;
  }

  const sections = parseMarkdownSections(content);
  const summaryText =
    findSectionParagraph(sections, [
      "executive summary",
      "summary",
      "overview",
      "assessment",
    ]) || extractFirstParagraph(cleaned);
  const findings = findSectionBullets(sections, [
    "key findings",
    "findings",
    "recommendations",
    "top recommendations",
    "prioritized recommendations",
    "priority actions",
    "next steps",
  ]);

  if (summaryText && findings.length > 0) {
    return trimSentence(
      `${summaryText} Top actions: ${findings.slice(0, 3).join("; ")}.`,
      420
    );
  }

  if (summaryText) {
    return trimSentence(summaryText, 360);
  }

  if (findings.length > 0) {
    return trimSentence(
      `${artifactName || "Report"} highlights: ${findings.slice(0, 3).join("; ")}.`,
      360
    );
  }

  return trimSentence(cleaned, 320);
}

function parseMarkdownSections(content: string): Array<{ heading: string; lines: string[] }> {
  const sections: Array<{ heading: string; lines: string[] }> = [
    { heading: "", lines: [] },
  ];

  for (const line of String(content || "").replace(/\r/g, "").split("\n")) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      sections.push({
        heading: cleanMarkdownText(headingMatch[1] || ""),
        lines: [],
      });
      continue;
    }

    sections[sections.length - 1].lines.push(line);
  }

  return sections;
}

function findSectionParagraph(
  sections: Array<{ heading: string; lines: string[] }>,
  headings: string[]
): string | null {
  const targetSet = new Set(headings.map((heading) => heading.toLowerCase()));

  for (const section of sections) {
    if (!targetSet.has(section.heading.toLowerCase())) {
      continue;
    }

    const paragraph = extractFirstParagraph(cleanMarkdownText(section.lines.join("\n")));
    if (paragraph) {
      return paragraph;
    }
  }

  return null;
}

function findSectionBullets(
  sections: Array<{ heading: string; lines: string[] }>,
  headings: string[]
): string[] {
  const targetSet = new Set(headings.map((heading) => heading.toLowerCase()));

  for (const section of sections) {
    if (!targetSet.has(section.heading.toLowerCase())) {
      continue;
    }

    const bullets = section.lines
      .map((line) => {
        const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
        return match ? cleanMarkdownText(match[1] || "") : "";
      })
      .filter(Boolean);

    if (bullets.length > 0) {
      return bullets;
    }
  }

  return [];
}

function extractFirstParagraph(content: string): string | null {
  const paragraphs = String(content || "")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs[0] || null;
}

function cleanMarkdownText(content: string): string {
  return String(content || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = ensureTrailingSeparator(resolve(rootPath));
  const normalizedTarget = resolve(targetPath);
  return normalizedTarget === resolve(rootPath) || normalizedTarget.startsWith(normalizedRoot);
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`;
}

function shouldPreferArtifactSummary(
  changed: string,
  task: Pick<CompletedTask, "objective" | "title">,
  artifactSummary?: string | null
): boolean {
  if (!artifactSummary) {
    return false;
  }

  const genericChanged =
    /\bworkspace now contains\b/i.test(changed) ||
    /\bartifacts?\b/i.test(changed) ||
    /\breport and screenshot evidence\b/i.test(changed) ||
    /\bregistered artifacts\b/i.test(changed) ||
    /\bmcp now has\b/i.test(changed);

  return genericChanged || looksLikeReportTask(task);
}

function looksLikeReportTask(
  task: Pick<CompletedTask, "objective" | "title">
): boolean {
  const haystack = `${task.title || ""} ${task.objective || ""}`;
  return /\b(review|audit|recommend(?:ation|ations)?|analysis|findings|report)\b/i.test(
    haystack
  );
}

function pickBestCompletionCandidate(
  requestTasks: CompletedTask[],
  artifactSummaries: Map<string, string>,
  preferredTaskId: string
): CompletionCandidate | null {
  const candidates = requestTasks
    .filter((task) => task.assigned_role !== "relay")
    .map((task) => {
      const artifactSummary = artifactSummaries.get(task.id) || null;
      const outcome = summarizeOutcome(
        task,
        task.last_handoff_note,
        task.assigned_role,
        artifactSummary
      );
      const score = scoreCompletionCandidate(
        task,
        outcome,
        artifactSummary,
        preferredTaskId
      );
      return {
        artifactSummary,
        score,
        task,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return (
        new Date(right.task.updated_at).getTime() -
        new Date(left.task.updated_at).getTime()
      );
    });

  return candidates[0] || null;
}

function scoreCompletionCandidate(
  task: CompletedTask,
  outcome: string | null,
  artifactSummary: string | null,
  preferredTaskId: string
): number {
  let score = 0;

  if (task.id === preferredTaskId) {
    score += 1;
  }

  if (artifactSummary) {
    score += 12;
  }

  if (looksLikeReportTask(task)) {
    score += 8;
  }

  if (task.assigned_role === "builder") {
    score += 4;
  } else if (task.assigned_role === "reviewer") {
    score += 2;
  }

  if (task.last_handoff_note) {
    score += Math.min(4, Math.floor(task.last_handoff_note.length / 180));
  }

  if (outcome) {
    score += 4;
    if (!/\bworkspace now contains\b|\bartifacts?\b/i.test(outcome)) {
      score += 2;
    }
  }

  return score;
}

function normalizeArtifactSummary(
  value: string,
  task: Pick<CompletedTask, "objective" | "title">
): string {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const normalized = compact
    .replace(/^Evidence-backed review of /i, "Review complete for ")
    .replace(/^Evidence-backed audit of /i, "Audit complete for ");

  if (
    /^Review complete\b/i.test(normalized) ||
    /^Audit complete\b/i.test(normalized)
  ) {
    return trimSentence(normalized);
  }

  if (looksLikeReportTask(task)) {
    return trimSentence(`Review complete. ${normalized}`);
  }

  return trimSentence(normalized);
}

function normalizeRoleSpecificOutcome(value: string, role: string): string {
  if (
    role === "reviewer" &&
    /^No site changes were made[.!?]?$/i.test(value.trim())
  ) {
    return "Review passed with no additional site changes needed.";
  }

  return value;
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

function formatDeliveredCompletionMessage(
  content: string,
  resultPageLink: DeliveryPageLink | null,
  channel: "admin_chat" | "telegram"
): string {
  const summaryLimit = channel === "telegram" ? 320 : 520;
  const brief = trimSentence(content, summaryLimit);

  if (channel === "telegram" && resultPageLink?.url) {
    return `${brief}\n\nFull result: ${resultPageLink.url}`;
  }

  return brief;
}

async function resolveRootRequestDeliveryTarget(
  rootTaskId: string
): Promise<DeliveryTarget> {
  const db = getDb();
  const { data, error } = await db
    .from("messages")
    .select("id,channel,metadata,created_at,direction,sender")
    .eq("task_id", rootTaskId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: true })
    .returns<TaskMessageRow[]>();

  if (error) {
    console.error(`Failed to resolve delivery target for root task ${rootTaskId}:`, error);
    return {
      channel: "admin_chat",
      chatId: null,
      sourceMessageId: null,
    };
  }

  return chooseOperatorDeliveryTarget(data || []);
}

function chooseOperatorDeliveryTarget(messages: TaskMessageRow[]): DeliveryTarget {
  for (const message of messages) {
    const chatId = readDeliveryChatId(message.metadata);
    if (message.channel === "telegram" && chatId !== null) {
      return {
        channel: "telegram",
        chatId,
        sourceMessageId: message.id,
      };
    }
  }

  for (const message of messages) {
    const sourceChannel = readSourceChannel(message);
    const chatId = readDeliveryChatId(message.metadata);
    if (sourceChannel === "telegram" && chatId !== null) {
      return {
        channel: "telegram",
        chatId,
        sourceMessageId:
          typeof message.metadata?.source_message_id === "string"
            ? message.metadata.source_message_id
            : message.id,
      };
    }
  }

  const adminMessage = messages.find((message) => message.channel === "admin_chat");
  return {
    channel: "admin_chat",
    chatId: null,
    sourceMessageId: adminMessage?.id || messages[0]?.id || null,
  };
}

function readSourceChannel(message: TaskMessageRow): string | null {
  if (message.channel === "telegram") {
    return "telegram";
  }

  if (typeof message.metadata?.source_channel === "string") {
    return message.metadata.source_channel;
  }

  if (message.metadata?.mirrored_from === "telegram") {
    return "telegram";
  }

  return message.channel === "admin_chat" ? "admin_chat" : null;
}

function readDeliveryChatId(
  metadata: Record<string, unknown> | null | undefined
): number | string | null {
  if (typeof metadata?.chat_id === "number" || typeof metadata?.chat_id === "string") {
    return metadata.chat_id;
  }

  if (
    typeof metadata?.telegram_chat_id === "number" ||
    typeof metadata?.telegram_chat_id === "string"
  ) {
    return metadata.telegram_chat_id;
  }

  return null;
}

async function sendOperatorCompletion(
  taskId: string,
  notificationKey: string,
  content: string,
  deliveryTarget: DeliveryTarget,
  resultPageLink: DeliveryPageLink | null,
  completedTask: CompletedTask
): Promise<void> {
  await sendOperatorNotification(
    taskId,
    notificationKey,
    content,
    deliveryTarget,
    "task_completion",
    "operator.completion.sent",
    {
      delivery_page_path: resultPageLink?.path || null,
      delivery_page_title: simplifyTitle(completedTask.title) || "Full result",
      delivery_page_url: resultPageLink?.url || null,
      relay_update_kind: "completed",
      related_task_id: completedTask.id,
    }
  );
}

async function sendOperatorProgress(
  taskId: string,
  notificationKey: string,
  content: string,
  deliveryTarget: DeliveryTarget
): Promise<void> {
  await sendOperatorNotification(
    taskId,
    notificationKey,
    content,
    deliveryTarget,
    "task_progress",
    "operator.progress.sent",
    {
      relay_update_kind: "progress",
    }
  );
}

async function sendOperatorNotification(
  taskId: string,
  notificationKey: string,
  content: string,
  deliveryTarget: DeliveryTarget,
  notificationType: "task_completion" | "task_progress",
  eventType: "operator.completion.sent" | "operator.progress.sent",
  extraMetadata: Record<string, unknown> = {}
): Promise<void> {
  const db = getDb();
  const baseMetadata = {
    notification_key: notificationKey,
    notification_type: notificationType,
    operator_visible: true,
    root_request_channel: deliveryTarget.channel,
    ...extraMetadata,
    ...(deliveryTarget.sourceMessageId
      ? { source_message_id: deliveryTarget.sourceMessageId }
      : {}),
  };
  const delivery =
    deliveryTarget.channel === "telegram" && deliveryTarget.chatId !== null
      ? await sendManagedMessage({
          channel: "telegram",
          content,
          metadata: {
            ...baseMetadata,
            chat_id: deliveryTarget.chatId,
          },
          sender: "relay",
          taskId,
        })
      : await sendAdminOnlyMessage({
          content,
          metadata: baseMetadata,
          sender: "relay",
          taskId,
        });

  const sent =
    "sent" in delivery ? delivery.sent : Boolean(delivery.success);
  if (!sent) {
    return;
  }

  const { error: eventError } = await db.from("events").insert({
    trace_id: null,
    agent_id: null,
    event_type: eventType,
    severity: "info",
    scope_type: "task",
    scope_id: taskId,
    summary: content.slice(0, 500),
    detail: {
      delivery:
        deliveryTarget.channel === "telegram"
          ? "telegram"
          : "admin_outbound",
      notification_key: notificationKey,
      notification_type: notificationType,
      relay_update_kind:
        typeof extraMetadata.relay_update_kind === "string"
          ? extraMetadata.relay_update_kind
          : null,
    },
  });

  if (eventError) {
    console.error(
      `Failed to record completion notification event for ${taskId}:`,
      eventError
    );
  }
}

function isSynthesizedOperatorNotification(message: {
  metadata?: Record<string, unknown> | null;
  sender: string;
}): boolean {
  if (message.sender === "system") {
    return true;
  }

  return typeof message.metadata?.notification_type === "string";
}

export const taskOutcomeTestHooks = {
  buildBlockedExecutionStatusSection,
  chooseBlockedRequestUpdateCandidate,
  chooseOperatorDeliveryTarget,
  formatBlockedChecklistMessage,
  formatBlockedRequestUpdateMessage,
  formatCompletionMessage,
  formatDeliveredCompletionMessage,
  looksLikeRequirementsChecklist,
  normalizeArtifactSummary,
  pickBestCompletionCandidate,
  shouldSendInterimProgressUpdate,
  summarizeArtifactDocument,
  shouldPreferArtifactSummary,
  summarizeOutcome,
};
