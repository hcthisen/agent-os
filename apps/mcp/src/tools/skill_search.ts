import { getAgentContext } from "../context.js";
import {
  normalizeSkillTags,
  parseSkillMemory,
  searchSkillMemories,
} from "../skill-memory.js";

export const skillSearchDef = {
  name: "skill_search",
  description:
    "Search scoped procedural skills and return structured skill definitions ranked by relevance and prior use.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      scope_type: {
        type: "string",
        enum: ["task", "project", "customer", "role", "department", "company"],
      },
      scope_id: { type: "string" },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      limit: { type: "number", default: 10 },
    },
    required: ["query"],
  },
};

export async function skillSearch(args: {
  query: string;
  scope_type?: string;
  scope_id?: string;
  tags?: string[];
  limit?: number;
}): Promise<unknown> {
  const ctx = getAgentContext();
  const rows = await searchSkillMemories(
    {
      limit: Math.max(1, Math.min(25, args.limit || 10)),
      query: String(args.query || "").trim(),
      scope_id: args.scope_id,
      scope_type: args.scope_type,
    },
    ctx.role_id
  );
  const requestedTags = normalizeSkillTags(args.tags).filter((tag) => tag !== "skill");
  const skills = rows
    .map((row) => parseSkillMemory(row))
    .filter((skill) =>
      requestedTags.length
        ? requestedTags.every((tag) => skill.tags.includes(tag))
        : true
    )
    .sort((left, right) => {
      if (right.use_count !== left.use_count) {
        return right.use_count - left.use_count;
      }

      return right.updated_at.localeCompare(left.updated_at);
    })
    .slice(0, Math.max(1, Math.min(25, args.limit || 10)));

  return {
    success: true,
    skills,
  };
}
