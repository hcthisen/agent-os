import { getDb } from "./db.js";
import { sendOperatorMessage } from "./operator-delivery.js";

const RELAY_HISTORY_LIMIT = 15;

interface InboundMessage {
  channel: string;
  content: string;
  created_at?: string;
  direction: string;
  id: string;
  metadata?: Record<string, unknown> | null;
  sender: string;
}

interface ConversationMessage {
  content: string;
  created_at?: string;
  direction: string;
  metadata?: Record<string, unknown> | null;
  sender: string;
}

/**
 * Check for unprocessed inbound messages and create relay tasks for them.
 */
export async function routeMessages(): Promise<void> {
  const db = getDb();

  const { data: messages, error } = await db
    .from("messages")
    .select("*")
    .eq("processed", false)
    .eq("direction", "inbound")
    .order("created_at")
    .limit(10);

  if (error || !messages?.length) return;

  for (const msg of (messages || []) as InboundMessage[]) {
    const history = await loadRecentConversationMessages(msg);
    const objective = await buildRelayObjective(msg, history);

    // Create a high-priority relay task
    const { data: relayTask, error: taskErr } = await db
      .from("tasks")
      .insert({
        title: `Process message: ${msg.content.slice(0, 50)}...`,
        objective,
        acceptance_criteria: [
          "Message classified",
          "Appropriate action taken or task created",
          "Response sent",
        ],
        state: "ready",
        priority: "high",
        assigned_role: "relay",
      })
      .select("id")
      .single();

    if (taskErr) {
      console.error(`Failed to create relay task for message ${msg.id}:`, taskErr);
      await sendOperatorMessage({
        content: `System alert: failed to route inbound operator message "${msg.content.slice(0, 80)}". Reason: ${taskErr.message}`,
        metadata: {
          delivery: "local",
          source_message_id: msg.id,
        },
        sender: "system",
        taskId: null,
      });
      continue;
    }

    // Mark message as processed
    await db
      .from("messages")
      .update({ processed: true, task_id: relayTask.id })
      .eq("id", msg.id);
  }
}

async function buildRelayObjective(
  message: InboundMessage,
  history: ConversationMessage[]
): Promise<string> {
  const content = String(message.content || "").trim();
  const teachMode = /^(remember:|always:|rule:|when\b.+\bdo\b)/i.test(content);
  const matchedSkills = await loadRelayMatchedSkills(content);
  const transcript = [...history, {
    content,
    created_at: message.created_at,
    direction: "inbound",
    sender: message.sender,
  }]
    .map(formatConversationMessage)
    .join("\n");

  return `Process this inbound message from ${message.sender} via ${message.channel}. Classify intent and route appropriately.

Current message:
${content}

Recent conversation transcript:
${transcript}

Routing reminders:
- If the request depends on a third-party service, account, API key, CDN, email provider, or similar credentialed integration, route to sage for a plan before builder implementation unless an approved plan already exists.
- If the message states a stable operator preference or constraint, record it as durable memory. Do not store secrets in memory.
- If the request creates or removes a public hostname, treat route activation or teardown plus external verification as required work, not optional follow-up.
- If the request is multi-phase, prefer a staged task graph with explicit depends_on prerequisites so follow-up work waits automatically instead of starting in parallel by accident.
- If the message begins with "Remember:", "Always:", "Rule:", or a "When...do..." procedure, treat it as explicit training. Create a semantic memory for durable facts or a shared skill for repeatable procedures at company scope, then confirm back to the operator what was stored.
- If matched shared skills are listed below and one clearly applies, reference it explicitly when you create downstream work so execution roles can reuse the existing procedure instead of recreating it.

Matched shared skills for this message:
${formatRelayMatchedSkills(matchedSkills)}

Teach mode detected: ${teachMode ? "yes" : "no"}.`;
}

async function loadRelayMatchedSkills(content: string): Promise<Array<{
  description: string;
  display_name: string;
  name: string;
  steps: Array<{ instruction: string; order: number }>;
  tags: string[];
  trigger_when: string;
  updated_at: string;
  use_count: number;
  scope_id: string;
  scope_type: string;
}>> {
  if (!content.trim()) {
    return [];
  }

  const db = getDb();
  const { data, error } = await db
    .from("memories")
    .select("id,subject,content,tags,scope_type,scope_id,updated_at,is_active")
    .eq("layer", "procedural")
    .eq("is_active", true)
    .contains("tags", ["skill"])
    .in("scope_type", ["company", "role"])
    .returns<SkillMemoryRow[]>();

  if (error) {
    console.error("Failed to load relay skill matches:", error);
    return [];
  }

  return (data || [])
    .filter((memory) =>
      memory.scope_type === "company" ||
      (memory.scope_type === "role" && memory.scope_id === "relay")
    )
    .map((memory) => toRelevantSkill(memory))
    .map((skill) => ({
      ...skill,
      match_score: scoreRelaySkillMatch(skill, content),
    }))
    .filter((skill) => skill.match_score > 0)
    .sort((left, right) => {
      if (right.match_score !== left.match_score) {
        return right.match_score - left.match_score;
      }
      if (right.use_count !== left.use_count) {
        return right.use_count - left.use_count;
      }
      return right.updated_at.localeCompare(left.updated_at);
    })
    .slice(0, 3);
}

function formatRelayMatchedSkills(
  skills: Array<{
    display_name: string;
    name: string;
    steps: Array<{ instruction: string; order: number }>;
    trigger_when: string;
  }>
): string {
  if (!skills.length) {
    return "- No obvious shared skill match detected.";
  }

  return skills
    .map((skill) => {
      const steps = skill.steps
        .slice(0, 3)
        .map((step) => `${step.order}. ${step.instruction}`)
        .join(" ");
      return [
        `- ${skill.display_name} (${skill.name})`,
        skill.trigger_when ? `  Trigger: ${skill.trigger_when}` : null,
        steps ? `  Steps: ${steps}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function scoreRelaySkillMatch(
  skill: {
    description: string;
    display_name: string;
    name: string;
    steps: Array<{ instruction: string }>;
    tags: string[];
    trigger_when: string;
  },
  content: string
): number {
  const haystack = normalizeRelayMatchText(content);
  if (!haystack) {
    return 0;
  }

  const fields = [
    skill.name,
    skill.display_name,
    skill.description,
    skill.trigger_when,
    ...skill.tags,
    ...skill.steps.map((step) => step.instruction),
  ]
    .map((value) => normalizeRelayMatchText(value))
    .filter(Boolean);

  let score = 0;
  for (const field of fields) {
    if (haystack.includes(field) || field.includes(haystack)) {
      score += 6;
      continue;
    }

    const fieldTokens = new Set(tokenizeRelayMatchText(field));
    const sharedTokens = tokenizeRelayMatchText(haystack).filter((token) =>
      fieldTokens.has(token)
    );
    score += sharedTokens.length;
  }

  return score;
}

function normalizeRelayMatchText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s:-]+/g, " ");
}

function tokenizeRelayMatchText(value: string): string[] {
  return normalizeRelayMatchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
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

function toRelevantSkill(memory: SkillMemoryRow): {
  description: string;
  display_name: string;
  name: string;
  scope_id: string;
  scope_type: string;
  steps: Array<{ instruction: string; order: number }>;
  tags: string[];
  trigger_when: string;
  updated_at: string;
  use_count: number;
} {
  const payload = parseSkillContent(memory.content);
  const name = memory.subject.replace(/^skill:/i, "").trim() || memory.subject.trim();

  return {
    description: readString(payload.description),
    display_name: readString(payload.display_name) || name,
    name,
    scope_id: memory.scope_id,
    scope_type: memory.scope_type,
    steps: readSkillSteps(payload.steps),
    tags: readStringArray(payload.tags).length
      ? readStringArray(payload.tags)
      : memory.tags || [],
    trigger_when: readString(payload.trigger_when),
    updated_at: memory.updated_at,
    use_count: readPositiveInt(payload.use_count, 0),
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

function readSkillSteps(value: unknown): Array<{ instruction: string; order: number }> {
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
      };
    })
    .filter((step): step is { instruction: string; order: number } => Boolean(step));
}

function formatConversationMessage(message: ConversationMessage): string {
  const timestamp = message.created_at
    ? new Date(message.created_at).toISOString()
    : "current";
  return `[${timestamp}] ${message.direction}/${message.sender}: ${message.content}`;
}

async function loadRecentConversationMessages(
  message: InboundMessage
): Promise<ConversationMessage[]> {
  const db = getDb();
  const chatId =
    message.channel === "telegram" &&
    (typeof message.metadata?.chat_id === "string" ||
      typeof message.metadata?.chat_id === "number")
      ? message.metadata.chat_id
      : null;
  let query = db
    .from("messages")
    .select("id,direction,sender,content,created_at,metadata")
    .eq("channel", message.channel)
    .neq("id", message.id)
    .order("created_at", { ascending: false })
    .limit(RELAY_HISTORY_LIMIT);

  if (chatId !== null) {
    query = query.contains("metadata", { chat_id: chatId });
  }

  const { data, error } = await query;

  if (error) {
    console.error(
      `Failed to load recent conversation history for message ${message.id}:`,
      error
    );
    return [];
  }

  return ((data || []) as ConversationMessage[])
    .filter((row) => isRelayVisibleConversationMessage(row))
    .reverse();
}

function isRelayVisibleConversationMessage(message: ConversationMessage): boolean {
  if (message.sender === "system") {
    return false;
  }

  return (
    message.metadata?.hidden_from_operator !== true &&
    message.metadata?.operator_visible !== false
  );
}
