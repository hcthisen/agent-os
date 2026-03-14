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
    const relayRouting = await prepareRelayTaskRouting(msg, history);

    // Create a high-priority relay task
    const { data: relayTask, error: taskErr } = await db
      .from("tasks")
      .insert({
        title: `Process message: ${msg.content.slice(0, 50)}...`,
        objective: relayRouting.objective,
        acceptance_criteria: buildRelayAcceptanceCriteria(relayRouting),
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

    if (relayTask?.id && relayRouting.requires_execution) {
      await createRelayExecutionRequirement(relayTask.id, relayRouting);
    }

    // Mark message as processed
    await db
      .from("messages")
      .update({ processed: true, task_id: relayTask.id })
      .eq("id", msg.id);
  }
}

interface RelevantSkill {
  description: string;
  display_name: string;
  match_score?: number;
  name: string;
  required_services: string[];
  scope_id: string;
  scope_type: string;
  steps: Array<{ instruction: string; order: number }>;
  tags: string[];
  trigger_when: string;
  updated_at: string;
  use_count: number;
}

interface RelayRoutingDecision {
  execution_reason: string;
  matched_skills: RelevantSkill[];
  objective: string;
  recommended_role: string | null;
  requires_execution: boolean;
  teach_mode: boolean;
}

async function prepareRelayTaskRouting(
  message: InboundMessage,
  history: ConversationMessage[]
): Promise<RelayRoutingDecision> {
  const content = String(message.content || "").trim();
  const teachMode = detectRelayTeachMode(content);
  const matchedSkills = await loadRelayMatchedSkills(content);
  const executionDecision = classifyRelayExecutionRequest(
    content,
    matchedSkills,
    teachMode
  );
  const transcript = [...history, {
    content,
    created_at: message.created_at,
    direction: "inbound",
    sender: message.sender,
  }]
    .map(formatConversationMessage)
    .join("\n");

  const objective = `Process this inbound message from ${message.sender} via ${message.channel}. Classify intent and route appropriately.

Current message:
${content}

Recent conversation transcript:
${transcript}

Routing reminders:
- If the request depends on a third-party service, account, API key, CDN, email provider, or similar credentialed integration, route to sage for a plan before builder implementation unless the task already has a clear staged execution plan in context.
- If the message states a stable operator preference or constraint, record it as durable memory. Do not store secrets in memory.
- If the request creates or removes a public hostname, treat route activation or teardown plus external verification as required work, not optional follow-up.
- If the request is multi-phase, prefer a staged task graph with explicit depends_on prerequisites so follow-up work waits automatically instead of starting in parallel by accident.
- If the message begins with "Remember:", "Always:", "Rule:", or a "When...do..." procedure, treat it as explicit training. Create a semantic memory for durable facts or a shared skill for repeatable procedures at company scope, then confirm back to the operator what was stored.
- If matched shared skills are listed below and one clearly applies, reference it explicitly when you create downstream work so execution roles can reuse the existing procedure instead of recreating it.
- When execution is required, direct response alone is insufficient. Create at least one downstream child task for the appropriate role, reference the matched skill by name, and keep any operator reply to a brief acknowledgement instead of a false completion claim.

Matched shared skills for this message:
${formatRelayMatchedSkills(matchedSkills)}

Teach mode detected: ${teachMode ? "yes" : "no"}.
Execution request detected: ${executionDecision.requiresExecution ? "yes" : "no"}.
Recommended downstream role: ${executionDecision.recommendedRole || "none"}.
Routing requirement: ${
  executionDecision.requiresExecution
    ? "Create at least one downstream child task before completing this relay task."
    : "Direct answer is allowed when confidence is high."
}`;

  return {
    execution_reason: executionDecision.reason,
    matched_skills: matchedSkills,
    objective,
    recommended_role: executionDecision.recommendedRole,
    requires_execution: executionDecision.requiresExecution,
    teach_mode: teachMode,
  };
}

function buildRelayAcceptanceCriteria(relayRouting: RelayRoutingDecision): string[] {
  if (relayRouting.requires_execution) {
    return [
      "Message classified",
      "Appropriate downstream child task created",
      "Operator kept informed without falsely claiming the work is already complete",
    ];
  }

  return [
    "Message classified",
    "Appropriate action taken or task created",
    "Response sent",
  ];
}

async function createRelayExecutionRequirement(
  taskId: string,
  relayRouting: RelayRoutingDecision
): Promise<void> {
  const db = getDb();
  const { error } = await db.from("task_requirements").insert({
    task_id: taskId,
    requirement_type: "downstream_task",
    target: "execution",
    expected: {
      execution_reason: relayRouting.execution_reason,
      matched_skill_names: relayRouting.matched_skills.map((skill) => skill.name),
      recommended_role: relayRouting.recommended_role || "builder",
    },
    status: "pending",
    required_for_completion: true,
    last_result: {},
  });

  if (error) {
    console.error(
      `Failed to create downstream-task requirement for relay task ${taskId}:`,
      error
    );
  }
}

function detectRelayTeachMode(content: string): boolean {
  return /^(remember:|always:|rule:|when\b.+\bdo\b)/i.test(content);
}

function classifyRelayExecutionRequest(
  content: string,
  matchedSkills: RelevantSkill[],
  teachMode: boolean
): {
  reason: string;
  recommendedRole: string | null;
  requiresExecution: boolean;
} {
  if (teachMode) {
    return {
      reason: "explicit_training",
      recommendedRole: null,
      requiresExecution: false,
    };
  }

  if (!matchedSkills.length) {
    return {
      reason: "no_matched_skill",
      recommendedRole: null,
      requiresExecution: false,
    };
  }

  const imperativeLead =
    /^(please\s+)?(do|run|handle|follow|use|apply|execute|perform|send|deploy|fix|update|create|remove|delete|verify|check|review|build|make|treat)\b/i.test(
      content
    );
  const actionPhrase =
    /\b(please|go ahead|follow the|use the|apply the|run the|execute the|handle this|do this|verify this|treat this as|ship this|deploy this|fix this|update this|create this|remove this)\b/i.test(
      content
    );
  const informationalQuestion = looksLikeInformationalRelayQuestion(content);
  const requiresExecution = imperativeLead || actionPhrase || !informationalQuestion;

  return {
    reason: requiresExecution
      ? imperativeLead || actionPhrase
        ? "matched_skill_action_request"
        : "matched_skill_non_question"
      : "matched_skill_information_request",
    recommendedRole: requiresExecution
      ? determineRelayRecommendedRole(matchedSkills, content)
      : null,
    requiresExecution,
  };
}

function looksLikeInformationalRelayQuestion(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized.endsWith("?")) {
    return false;
  }

  return (
    /^(what|why|how|when|where|who|which|is|are|does|do|did|can|could|would|should|will)\b/i.test(
      normalized
    ) &&
    !/\b(use|follow|apply|run|execute|handle|do|send|fix|update|create|remove|deploy|verify|build|make|treat)\b/i.test(
      normalized
    )
  );
}

function determineRelayRecommendedRole(
  matchedSkills: RelevantSkill[],
  content: string
): string {
  const requiresService =
    matchedSkills.some((skill) => skill.required_services.length > 0) ||
    /\b(api key|credential|login|service connection|service slot|cloudflare|stripe|sendgrid|resend|smtp|cdn|dns|domain)\b/i.test(
      content
    );

  return requiresService ? "sage" : "builder";
}

async function loadRelayMatchedSkills(content: string): Promise<RelevantSkill[]> {
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

function formatRelayMatchedSkills(skills: RelevantSkill[]): string {
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
  skill: RelevantSkill,
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
  required_services: string[];
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
