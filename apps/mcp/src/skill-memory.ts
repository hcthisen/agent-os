import { getDb } from "./db.js";
import { enforceScope, getCurrentTaskContext, type ScopeType } from "./scope.js";

export const SKILL_TAG = "skill";

export interface SkillStep {
  order: number;
  instruction: string;
  tool_hint: string | null;
  required: boolean;
}

export interface Skill {
  id: string;
  name: string;
  display_name: string;
  description: string;
  trigger_when: string;
  steps: SkillStep[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  required_services: string[];
  scope_type: ScopeType;
  scope_id: string;
  tags: string[];
  version: number;
  last_used_at: string | null;
  use_count: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

type SkillStepInput = Partial<SkillStep> & { instruction: string };

interface SkillMemoryRow {
  id: string;
  subject: string;
  content: string;
  tags: string[];
  scope_type: ScopeType;
  scope_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
}

interface StoredSkillPayload {
  display_name: string;
  description: string;
  trigger_when: string;
  steps: SkillStep[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  required_services: string[];
  version: number;
  last_used_at: string | null;
  use_count: number;
}

interface SearchChunk {
  chunk_content: string;
  chunk_id: string;
  chunk_scope_id: string;
  chunk_scope_type: ScopeType;
  chunk_source_id: string;
  chunk_source_type: string;
  rrf_score: number;
}

export interface SkillDraftInput {
  description?: string;
  display_name?: string;
  input_schema?: Record<string, unknown>;
  last_used_at?: string | null;
  name?: string;
  output_schema?: Record<string, unknown>;
  required_services?: string[];
  steps?: SkillStepInput[];
  tags?: string[];
  trigger_when?: string;
  use_count?: number;
  version?: number;
}

export function normalizeSkillName(name: string): string {
  const normalized = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/^skill:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error("Skill name is required");
  }

  return normalized;
}

export function buildSkillSubject(name: string): string {
  return `skill:${normalizeSkillName(name)}`;
}

export function buildSkillContent(input: SkillDraftInput): string {
  const normalizedName = normalizeSkillName(String(input.name || input.display_name || "skill"));
  const payload: StoredSkillPayload = {
    display_name: String(input.display_name || "").trim() || buildDefaultSkillDisplayName(normalizedName),
    description: String(input.description || "").trim(),
    trigger_when: String(input.trigger_when || "").trim(),
    steps: normalizeSkillSteps(input.steps || []),
    input_schema: input.input_schema || {},
    output_schema: input.output_schema || {},
    required_services: normalizeStringArray(input.required_services),
    version: Math.max(1, Number(input.version || 1)),
    last_used_at: input.last_used_at || null,
    use_count: Math.max(0, Number(input.use_count || 0)),
  };

  return JSON.stringify(payload, null, 2);
}

export function buildSkillChunkContent(args: {
  description?: string;
  display_name?: string;
  name: string;
  required_services?: string[];
  steps?: SkillStepInput[];
  tags?: string[];
  trigger_when?: string;
}): string {
  const steps = normalizeSkillSteps(args.steps || []);
  const requiredServices = normalizeStringArray(args.required_services);
  const tags = normalizeStringArray(args.tags).filter((tag) => tag !== SKILL_TAG);

  return [
    `Skill: ${String(args.display_name || args.name).trim() || args.name}`,
    `Slug: ${normalizeSkillName(args.name)}`,
    args.description ? `Description: ${String(args.description).trim()}` : null,
    args.trigger_when ? `Trigger: ${String(args.trigger_when).trim()}` : null,
    steps.length
      ? `Steps: ${steps
          .map((step) =>
            `${step.order}. ${step.instruction}${step.tool_hint ? ` (tool hint: ${step.tool_hint})` : ""}`
          )
          .join(" ")}`
      : null,
    requiredServices.length
      ? `Required services: ${requiredServices.join(", ")}`
      : null,
    tags.length ? `Tags: ${tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseSkillMemory(memory: SkillMemoryRow): Skill {
  const payload = parseStoredSkillPayload(memory.content);
  const name = normalizeSkillName(memory.subject);

  return {
    id: memory.id,
    name,
    display_name: payload.display_name || name,
    description: payload.description,
    trigger_when: payload.trigger_when,
    steps: payload.steps,
    input_schema: payload.input_schema,
    output_schema: payload.output_schema,
    required_services: payload.required_services,
    scope_type: memory.scope_type,
    scope_id: memory.scope_id,
    tags: normalizeSkillTags(memory.tags),
    version: payload.version,
    last_used_at: payload.last_used_at,
    use_count: payload.use_count,
    is_active: memory.is_active,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  };
}

export async function loadSkillMemoryById(id: string): Promise<SkillMemoryRow | null> {
  const db = getDb();
  const { data, error } = await db
    .from("memories")
    .select(
      "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by"
    )
    .eq("id", id)
    .eq("layer", "procedural")
    .contains("tags", [SKILL_TAG])
    .maybeSingle<SkillMemoryRow>();

  if (error) {
    throw new Error(`Failed to load skill '${id}': ${error.message}`);
  }

  return data || null;
}

export async function loadLatestSkillMemoryByName(
  name: string,
  options?: { scope_id?: string; scope_type?: ScopeType }
): Promise<SkillMemoryRow | null> {
  const db = getDb();
  let query = db
    .from("memories")
    .select(
      "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by"
    )
    .eq("layer", "procedural")
    .eq("subject", buildSkillSubject(name))
    .contains("tags", [SKILL_TAG])
    .order("created_at", { ascending: false })
    .limit(1);

  if (options?.scope_type) {
    query = query.eq("scope_type", options.scope_type);
  }

  if (options?.scope_id) {
    query = query.eq("scope_id", options.scope_id);
  }

  const { data, error } = await query.maybeSingle<SkillMemoryRow>();

  if (error) {
    throw new Error(
      `Failed to load skill '${normalizeSkillName(name)}': ${error.message}`
    );
  }

  return data || null;
}

export async function loadSkillVersions(memory: SkillMemoryRow): Promise<SkillMemoryRow[]> {
  const db = getDb();
  const { data, error } = await db
    .from("memories")
    .select(
      "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by"
    )
    .eq("layer", "procedural")
    .eq("subject", memory.subject)
    .eq("scope_type", memory.scope_type)
    .eq("scope_id", memory.scope_id)
    .contains("tags", [SKILL_TAG])
    .order("created_at", { ascending: false })
    .returns<SkillMemoryRow[]>();

  if (error) {
    throw new Error(`Failed to load skill version history: ${error.message}`);
  }

  return data || [];
}

export async function resolveSkillScopes(
  scopeType: string | undefined,
  scopeId: string | undefined,
  roleId: string
): Promise<Array<{ scope_type: ScopeType; scope_id: string | null }>> {
  if (scopeType) {
    if (scopeType !== "company") {
      await enforceScope(scopeType, requireScopeId(scopeType, scopeId));
    }

    return [
      {
        scope_type: scopeType as ScopeType,
        scope_id: scopeType === "company" ? scopeId || null : requireScopeId(scopeType, scopeId),
      },
    ];
  }

  const currentTask = await getCurrentTaskContext();
  const scopes: Array<{ scope_type: ScopeType; scope_id: string | null }> = [];

  if (currentTask) {
    scopes.push({ scope_type: "task", scope_id: currentTask.id });
    if (currentTask.project_id) {
      scopes.push({ scope_type: "project", scope_id: currentTask.project_id });
    }
    if (currentTask.customer_id) {
      scopes.push({ scope_type: "customer", scope_id: currentTask.customer_id });
    }
    if (currentTask.department_id) {
      scopes.push({ scope_type: "department", scope_id: currentTask.department_id });
    }
    scopes.push({ scope_type: "role", scope_id: currentTask.assigned_role });
  } else {
    scopes.push({ scope_type: "role", scope_id: roleId });
  }

  scopes.push({ scope_type: "company", scope_id: null });
  return scopes;
}

export async function searchSkillMemories(
  args: {
    limit: number;
    query: string;
    scope_id?: string;
    scope_type?: string;
  },
  roleId: string
): Promise<SkillMemoryRow[]> {
  const db = getDb();
  const scopes = await resolveSkillScopes(args.scope_type, args.scope_id, roleId);
  const limit = Math.max(1, Math.min(25, args.limit));
  const memories: SkillMemoryRow[] = [];
  const seenIds = new Set<string>();

  for (const scope of scopes) {
    const { data: hybridData, error: hybridError } = await db.rpc("hybrid_memory_search", {
      filter_scope_id: scope.scope_id,
      filter_scope_type: scope.scope_type,
      match_limit: limit,
      query_embedding: null,
      query_text: args.query,
      rrf_k: 60,
    });

    if (hybridError) {
      throw new Error(`Failed to search skills: ${hybridError.message}`);
    }

    const candidateIds = ((hybridData || []) as SearchChunk[])
      .filter(
        (row): row is SearchChunk =>
          Boolean(row) &&
          typeof row.chunk_source_id === "string" &&
          row.chunk_source_type === "memory"
      )
      .map((row) => row.chunk_source_id);

    const subjectQuery = db
      .from("memories")
      .select(
        "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by"
      )
      .eq("layer", "procedural")
      .contains("tags", [SKILL_TAG])
      .eq("scope_type", scope.scope_type)
      .ilike("subject", `%${args.query}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    const scopedSubjectQuery =
      scope.scope_id === null ? subjectQuery : subjectQuery.eq("scope_id", scope.scope_id);

    const [{ data: hybridMemories, error: hybridMemoryError }, { data: subjectMemories, error: subjectError }] =
      await Promise.all([
        candidateIds.length
          ? db
              .from("memories")
              .select(
                "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by"
              )
              .in("id", candidateIds)
              .eq("layer", "procedural")
              .contains("tags", [SKILL_TAG])
              .returns<SkillMemoryRow[]>()
          : Promise.resolve({ data: [], error: null }),
        scopedSubjectQuery.returns<SkillMemoryRow[]>(),
      ]);

    if (hybridMemoryError) {
      throw new Error(`Failed to hydrate skill search results: ${hybridMemoryError.message}`);
    }

    if (subjectError) {
      throw new Error(`Failed to search skills by subject: ${subjectError.message}`);
    }

    for (const memory of [...(hybridMemories || []), ...(subjectMemories || [])]) {
      if (seenIds.has(memory.id)) {
        continue;
      }

      memories.push(memory);
      seenIds.add(memory.id);

      if (memories.length >= limit) {
        return memories;
      }
    }
  }

  return memories;
}

export function deriveNextSkillVersion(previous: Skill | null): number {
  return previous ? previous.version + 1 : 1;
}

export function buildDefaultSkillDisplayName(name: string): string {
  return normalizeSkillName(name)
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeSkillTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>([SKILL_TAG]);
  const ordered = [SKILL_TAG];

  for (const rawTag of tags || []) {
    const tag = String(rawTag || "").trim().toLowerCase();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    ordered.push(tag);
  }

  return ordered;
}

function normalizeStringArray(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const rawValue of values || []) {
    const value = String(rawValue || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    ordered.push(value);
  }

  return ordered;
}

function normalizeSkillSteps(steps: SkillStepInput[]): SkillStep[] {
  return (steps || [])
    .map((step, index) => ({
      order: Number(step?.order || index + 1),
      instruction: String(step?.instruction || "").trim(),
      tool_hint: String(step?.tool_hint || "").trim() || null,
      required: step?.required !== false,
    }))
    .filter((step) => step.instruction);
}

function parseStoredSkillPayload(content: string): StoredSkillPayload {
  const fallback = {
    description: content,
    display_name: "",
    input_schema: {},
    last_used_at: null,
    output_schema: {},
    required_services: [],
    steps: [] as SkillStep[],
    trigger_when: "",
    use_count: 0,
    version: 1,
  };

  try {
    const parsed = JSON.parse(content) as Partial<StoredSkillPayload>;
    return {
      display_name: String(parsed.display_name || "").trim(),
      description: String(parsed.description || "").trim(),
      trigger_when: String(parsed.trigger_when || "").trim(),
      steps: normalizeSkillSteps(parsed.steps || []),
      input_schema:
        parsed.input_schema && typeof parsed.input_schema === "object"
          ? parsed.input_schema
          : {},
      output_schema:
        parsed.output_schema && typeof parsed.output_schema === "object"
          ? parsed.output_schema
          : {},
      required_services: normalizeStringArray(parsed.required_services),
      version: Math.max(1, Number(parsed.version || 1)),
      last_used_at:
        typeof parsed.last_used_at === "string" && parsed.last_used_at.trim()
          ? parsed.last_used_at
          : null,
      use_count: Math.max(0, Number(parsed.use_count || 0)),
    };
  } catch {
    return fallback;
  }
}

function requireScopeId(scopeType: string, scopeId: string | undefined): string {
  const normalized = String(scopeId || "").trim();
  if (!normalized) {
    throw new Error(`scope_id is required for scope_type '${scopeType}'`);
  }

  return normalized;
}
