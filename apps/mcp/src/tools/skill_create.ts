import { getCurrentTaskContext, requireCurrentTaskContext } from "../scope.js";
import {
  buildDefaultSkillDisplayName,
  buildSkillChunkContent,
  buildSkillContent,
  buildSkillSubject,
  deriveNextSkillVersion,
  loadLatestSkillMemoryByName,
  normalizeSkillName,
  normalizeSkillTags,
  parseSkillMemory,
} from "../skill-memory.js";
import { writeMemoryRecord } from "./memory_write.js";

export const skillCreateDef = {
  name: "skill_create",
  description:
    "Create or update a procedural skill stored as a scoped memory-backed skill definition.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      trigger_when: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            order: { type: "number" },
            instruction: { type: "string" },
            tool_hint: { type: "string" },
            required: { type: "boolean" },
          },
          required: ["instruction"],
        },
      },
      input_schema: {
        type: "object",
        additionalProperties: true,
      },
      output_schema: {
        type: "object",
        additionalProperties: true,
      },
      required_services: {
        type: "array",
        items: { type: "string" },
      },
      scope_type: {
        type: "string",
        enum: ["task", "project", "customer", "role", "department", "company"],
        default: "company",
      },
      scope_id: { type: "string" },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["name"],
  },
};

export async function skillCreate(args: {
  name: string;
  display_name?: string;
  description?: string;
  trigger_when?: string;
  steps?: Array<{
    order?: number;
    instruction: string;
    tool_hint?: string | null;
    required?: boolean;
  }>;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  required_services?: string[];
  scope_type?: string;
  scope_id?: string;
  tags?: string[];
}): Promise<unknown> {
  const task = await requireCurrentTaskContext();
  const name = normalizeSkillName(args.name);
  const scopeType = (args.scope_type || "company").trim().toLowerCase();
  const scopeId = resolveScopeId(scopeType, args.scope_id, task);
  const previousMemory = await loadLatestSkillMemoryByName(name, {
    scope_id: scopeId,
    scope_type: scopeType as any,
  });
  const previousSkill = previousMemory ? parseSkillMemory(previousMemory) : null;
  const displayName =
    String(args.display_name || "").trim() || buildDefaultSkillDisplayName(name);
  const tags = normalizeSkillTags(args.tags);
  const content = buildSkillContent({
    name,
    description: args.description,
    display_name: displayName,
    input_schema: args.input_schema || {},
    output_schema: args.output_schema || {},
    required_services: args.required_services || [],
    steps: args.steps || [],
    trigger_when: args.trigger_when,
    use_count: previousSkill?.use_count || 0,
    version: deriveNextSkillVersion(previousSkill),
    last_used_at: previousSkill?.last_used_at || null,
  });

  const result = await writeMemoryRecord({
    chunk_content: buildSkillChunkContent({
      description: args.description,
      display_name: displayName,
      name,
      required_services: args.required_services,
      steps: args.steps,
      tags,
      trigger_when: args.trigger_when,
    }),
    content,
    layer: "procedural",
    scope_id: scopeId,
    scope_type: scopeType,
    subject: buildSkillSubject(name),
    supersedes_memory_id: previousMemory?.id,
    tags,
  });

  const memory = result.memory as {
    content: string;
    created_at: string;
    id: string;
    is_active: boolean;
    scope_id: string;
    scope_type: any;
    subject: string;
    tags: string[];
    updated_at: string;
  };

  return {
    success: true,
    skill: parseSkillMemory({
      content: memory.content,
      created_at: memory.created_at,
      id: memory.id,
      is_active: memory.is_active,
      scope_id: memory.scope_id,
      scope_type: memory.scope_type,
      subject: memory.subject,
      superseded_by: null,
      tags: memory.tags,
      updated_at: memory.updated_at,
    }),
    superseded_id: previousMemory?.id || null,
    warning: result.chunk_warning || null,
  };
}

function resolveScopeId(
  scopeType: string,
  providedScopeId: string | undefined,
  task: Awaited<ReturnType<typeof getCurrentTaskContext>>
): string {
  const normalizedScopeId = String(providedScopeId || "").trim();

  if (scopeType === "company") {
    return normalizedScopeId || "system";
  }

  if (normalizedScopeId) {
    return normalizedScopeId;
  }

  if (!task) {
    throw new Error(`scope_id is required for scope_type '${scopeType}'`);
  }

  if (scopeType === "task") {
    return task.id;
  }

  if (scopeType === "project" && task.project_id) {
    return task.project_id;
  }

  if (scopeType === "customer" && task.customer_id) {
    return task.customer_id;
  }

  if (scopeType === "department" && task.department_id) {
    return task.department_id;
  }

  if (scopeType === "role") {
    return task.assigned_role;
  }

  throw new Error(`scope_id is required for scope_type '${scopeType}'`);
}
