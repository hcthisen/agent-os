import { getDb } from "./db.js";

type SupportedScopeType =
  | "company"
  | "customer"
  | "department"
  | "project"
  | "role"
  | "task";

interface SkillStep {
  instruction: string;
  order: number;
  required: boolean;
  tool_hint: string | null;
}

interface TaskSkillSource {
  assigned_role: string;
  attempt_count: number;
  claimed_by: string | null;
  customer_id: string | null;
  department_id: string | null;
  id: string;
  last_handoff_note: string | null;
  objective: string | null;
  project_id: string | null;
  simulation_only?: boolean | null;
  title: string;
}

interface ParsedReusableSkill {
  description: string;
  display_name: string;
  name: string;
  scope_id: string;
  scope_type: SupportedScopeType;
  steps: SkillStep[];
  tags: string[];
  trigger_when: string;
}

interface SkillMemoryRow {
  content: string;
  id: string;
}

const REUSABLE_SKILL_LABELS = [
  "Reusable procedure:",
  "Shared skill:",
  "Skill candidate:",
];

const REUSABLE_SKILL_FIELD_NAMES = new Set([
  "description",
  "display name",
  "display_name",
  "name",
  "scope",
  "scope id",
  "scope_id",
  "steps",
  "tags",
  "trigger",
]);

const SKILL_TAG = "skill";

export async function maybeAutocaptureReusableSkill(
  task: TaskSkillSource
): Promise<void> {
  if (
    task.simulation_only === true ||
    !task.last_handoff_note ||
    task.assigned_role === "relay"
  ) {
    return;
  }

  const parsed = parseReusableSkillFromTask(task);
  if (!parsed) {
    return;
  }

  const notificationKey = `skill-autocaptured:${task.id}`;
  if (await skillAutocaptureAlreadyRecorded(task.id, notificationKey)) {
    return;
  }

  try {
    const saved = await upsertAutocapturedSkill(task, parsed);
    await recordAutocaptureEvent(task, parsed, saved.id, notificationKey);
  } catch (error) {
    console.error(`Failed to auto-capture reusable skill for task ${task.id}:`, error);
  }
}

async function skillAutocaptureAlreadyRecorded(
  taskId: string,
  notificationKey: string
): Promise<boolean> {
  const db = getDb();
  const { count, error } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "skill.autocaptured")
    .eq("scope_type", "task")
    .eq("scope_id", taskId)
    .contains("detail", { notification_key: notificationKey });

  if (error) {
    console.error(
      `Failed to check reusable-skill autocapture status for task ${taskId}:`,
      error
    );
    return false;
  }

  return Boolean(count && count > 0);
}

async function upsertAutocapturedSkill(
  task: TaskSkillSource,
  parsed: ParsedReusableSkill
): Promise<{ id: string }> {
  const db = getDb();
  const subject = buildSkillSubject(parsed.name);
  const { data: previous, error: previousError } = await db
    .from("memories")
    .select("id,content")
    .eq("layer", "procedural")
    .eq("subject", subject)
    .eq("scope_type", parsed.scope_type)
    .eq("scope_id", parsed.scope_id)
    .contains("tags", [SKILL_TAG])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<SkillMemoryRow>();

  if (previousError) {
    throw new Error(previousError.message);
  }

  if (previous?.id) {
    await db.from("memories").update({ is_active: false }).eq("id", previous.id);
    await db
      .from("memory_chunks")
      .delete()
      .eq("source_type", "memory")
      .eq("source_id", previous.id);
  }

  const content = buildSkillContent({
    description: parsed.description,
    display_name: parsed.display_name,
    name: parsed.name,
    steps: parsed.steps,
    trigger_when: parsed.trigger_when,
    use_count: readPositiveInt(previous?.content, "use_count"),
    version: readPositiveInt(previous?.content, "version", 0) + 1,
  });

  const { data: memory, error: insertError } = await db
    .from("memories")
    .insert({
      content,
      confidence: 0.9,
      layer: "procedural",
      scope_id: parsed.scope_id,
      scope_type: parsed.scope_type,
      source_agent_id: task.claimed_by || null,
      subject,
      superseded_by: null,
      tags: parsed.tags,
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !memory) {
    throw new Error(insertError?.message || "Failed to insert shared skill memory");
  }

  if (previous?.id) {
    await db.from("memories").update({ superseded_by: memory.id }).eq("id", previous.id);
  }

  const { error: chunkError } = await db.from("memory_chunks").insert({
    content: buildSkillChunkContent(parsed),
    scope_id: parsed.scope_id,
    scope_type: parsed.scope_type,
    source_id: memory.id,
    source_type: "memory",
  });

  if (chunkError) {
    console.error(`Failed to create memory chunk for auto-captured skill ${memory.id}:`, chunkError);
  }

  return memory;
}

async function recordAutocaptureEvent(
  task: TaskSkillSource,
  parsed: ParsedReusableSkill,
  skillId: string,
  notificationKey: string
): Promise<void> {
  const db = getDb();
  const { error } = await db.from("events").insert({
    agent_id: task.claimed_by || null,
    detail: {
      notification_key: notificationKey,
      scope_id: parsed.scope_id,
      scope_type: parsed.scope_type,
      skill_id: skillId,
      trigger_when: parsed.trigger_when,
    },
    event_type: "skill.autocaptured",
    scope_id: task.id,
    scope_type: "task",
    severity: "info",
    summary: `Auto-captured shared skill ${parsed.display_name}.`,
    trace_id: null,
  });

  if (error) {
    console.error(`Failed to record auto-captured skill event for task ${task.id}:`, error);
  }
}

function parseReusableSkillFromTask(
  task: TaskSkillSource
): ParsedReusableSkill | null {
  const section = extractReusableSkillSection(task.last_handoff_note || "");
  if (!section) {
    return null;
  }

  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = new Map<string, string>();
  const descriptionLines: string[] = [];
  const steps: string[] = [];
  let inSteps = false;

  for (const line of lines) {
    const stepMatch = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (stepMatch) {
      inSteps = true;
      steps.push(stepMatch[1].trim());
      continue;
    }

    const fieldMatch = line.match(/^([A-Za-z_ ]+):\s*(.*)$/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1].trim().toLowerCase();
      const fieldValue = fieldMatch[2].trim();
      if (fieldName === "steps") {
        inSteps = true;
        if (fieldValue) {
          steps.push(...extractInlineSteps(fieldValue));
        }
        continue;
      }

      if (REUSABLE_SKILL_FIELD_NAMES.has(fieldName)) {
        inSteps = false;
        if (fieldValue) {
          fields.set(fieldName, fieldValue);
        }
        continue;
      }
    }

    if (inSteps) {
      steps.push(...extractInlineSteps(line));
      continue;
    }

    descriptionLines.push(line);
  }

  const normalizedSteps = [...new Set(steps.map((step) => step.trim()).filter(Boolean))]
    .map((instruction, index) => ({
      instruction,
      order: index + 1,
      required: true,
      tool_hint: null,
    }))
    .filter((step) => step.instruction.length >= 8);

  if (normalizedSteps.length < 2) {
    return null;
  }

  const scope = resolveSkillScope(task, fields);
  const displayName =
    fields.get("display name") ||
    fields.get("display_name") ||
    buildDefaultSkillDisplayName(
      fields.get("name") || buildAutoSkillName(task.title, task.project_id)
    );
  const name = normalizeSkillName(
    fields.get("name") || displayName || buildAutoSkillName(task.title, task.project_id)
  );
  const description =
    fields.get("description") ||
    descriptionLines.join(" ").trim() ||
    buildFallbackDescription(task, normalizedSteps);
  const triggerWhen =
    fields.get("trigger") ||
    `Use when work matches: ${task.title}${task.objective ? ` (${task.objective})` : ""}`;
  const tags = normalizeSkillTags([
    ...parseTags(fields.get("tags") || ""),
    "agent-first",
    "auto-captured",
    task.assigned_role,
  ]);

  return {
    description,
    display_name: displayName || buildDefaultSkillDisplayName(name),
    name,
    scope_id: scope.scope_id,
    scope_type: scope.scope_type,
    steps: normalizedSteps,
    tags,
    trigger_when: triggerWhen,
  };
}

function extractReusableSkillSection(note: string): string | null {
  const lines = String(note || "").split(/\r?\n/);
  let startIndex = -1;
  let firstLineRemainder = "";

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const label = REUSABLE_SKILL_LABELS.find((candidate) =>
      trimmed.toLowerCase().startsWith(candidate.toLowerCase())
    );
    if (!label) {
      continue;
    }

    startIndex = index;
    firstLineRemainder = trimmed.slice(label.length).trim();
    break;
  }

  if (startIndex < 0) {
    return null;
  }

  const collected: string[] = [];
  if (firstLineRemainder) {
    collected.push(firstLineRemainder);
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      collected.push("");
      continue;
    }

    if (isTopLevelHandoffHeading(trimmed)) {
      break;
    }

    collected.push(trimmed);
  }

  return collected.join("\n").trim() || null;
}

function isTopLevelHandoffHeading(line: string): boolean {
  const match = line.match(/^([A-Za-z ]+):/);
  if (!match) {
    return false;
  }

  const normalized = match[1].trim().toLowerCase();
  if (REUSABLE_SKILL_FIELD_NAMES.has(normalized)) {
    return false;
  }

  return [
    "what you did",
    "what changed",
    "what is blocked",
    "what to do next",
    "verification",
    "evidence",
    "notes",
  ].includes(normalized);
}

function extractInlineSteps(value: string): string[] {
  return String(value || "")
    .split(/\s*(?:\||;|\. )\s*/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 8);
}

function parseTags(value: string): string[] {
  return String(value || "")
    .split(/[,\s]+/g)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length >= 2);
}

function resolveSkillScope(
  task: TaskSkillSource,
  fields: Map<string, string>
): { scope_id: string; scope_type: SupportedScopeType } {
  const explicitScope = String(fields.get("scope") || "").trim().toLowerCase();
  const explicitScopeId = String(fields.get("scope id") || fields.get("scope_id") || "").trim();

  if (explicitScope === "project" && task.project_id) {
    return { scope_id: explicitScopeId || task.project_id, scope_type: "project" };
  }

  if (explicitScope === "customer" && task.customer_id) {
    return { scope_id: explicitScopeId || task.customer_id, scope_type: "customer" };
  }

  if (explicitScope === "department" && task.department_id) {
    return {
      scope_id: explicitScopeId || task.department_id,
      scope_type: "department",
    };
  }

  if (explicitScope === "task") {
    return { scope_id: explicitScopeId || task.id, scope_type: "task" };
  }

  if (explicitScope === "company") {
    return { scope_id: explicitScopeId || "system", scope_type: "company" };
  }

  if (explicitScope === "role") {
    return { scope_id: explicitScopeId || task.assigned_role, scope_type: "role" };
  }

  if (task.project_id) {
    return { scope_id: task.project_id, scope_type: "project" };
  }

  return { scope_id: task.assigned_role, scope_type: "role" };
}

function buildFallbackDescription(
  task: TaskSkillSource,
  steps: SkillStep[]
): string {
  return [
    `Reusable procedure captured from completed task "${task.title}".`,
    task.attempt_count > 0
      ? "This procedure was learned after retries or iteration."
      : null,
    steps.length > 0 ? `First step: ${steps[0].instruction}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildAutoSkillName(title: string, projectId: string | null): string {
  const stableSeed = projectId ? `${title} ${projectId}` : title;
  return normalizeSkillName(stableSeed);
}

function normalizeSkillName(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^skill:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "shared-skill";
}

function buildDefaultSkillDisplayName(name: string): string {
  return normalizeSkillName(name)
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildSkillSubject(name: string): string {
  return `skill:${normalizeSkillName(name)}`;
}

function normalizeSkillTags(tags: string[]): string[] {
  const ordered = [SKILL_TAG];
  const seen = new Set<string>(ordered);

  for (const rawTag of tags) {
    const tag = String(rawTag || "").trim().toLowerCase();
    if (!tag || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    ordered.push(tag);
  }

  return ordered;
}

function buildSkillContent(input: {
  description: string;
  display_name: string;
  name: string;
  steps: SkillStep[];
  trigger_when: string;
  use_count: number;
  version: number;
}): string {
  return JSON.stringify(
    {
      description: String(input.description || "").trim(),
      display_name:
        String(input.display_name || "").trim() ||
        buildDefaultSkillDisplayName(input.name),
      input_schema: {},
      last_used_at: null,
      output_schema: {},
      required_services: [],
      steps: input.steps,
      trigger_when: String(input.trigger_when || "").trim(),
      use_count: Math.max(0, Number(input.use_count || 0)),
      version: Math.max(1, Number(input.version || 1)),
    },
    null,
    2
  );
}

function buildSkillChunkContent(parsed: ParsedReusableSkill): string {
  return [
    `Skill: ${parsed.display_name}`,
    `Slug: ${parsed.name}`,
    `Description: ${parsed.description}`,
    `Trigger: ${parsed.trigger_when}`,
    `Steps: ${parsed.steps.map((step) => `${step.order}. ${step.instruction}`).join(" ")}`,
    parsed.tags.length > 1
      ? `Tags: ${parsed.tags.filter((tag) => tag !== SKILL_TAG).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function readPositiveInt(
  content: string | undefined,
  field: "use_count" | "version",
  fallback = 0
): number {
  try {
    const parsed = JSON.parse(String(content || "{}")) as Record<string, unknown>;
    const value =
      typeof parsed[field] === "number"
        ? parsed[field]
        : typeof parsed[field] === "string"
          ? parseInt(parsed[field], 10)
          : NaN;
    return Number.isFinite(value) ? Number(value) : fallback;
  } catch {
    return fallback;
  }
}

export const skillAutocaptureTestHooks = {
  extractReusableSkillSection,
  parseReusableSkillFromTask,
};
