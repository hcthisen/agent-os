import { getAgentContext } from "../context.js";
import {
  loadLatestSkillMemoryByName,
  loadSkillMemoryById,
  loadSkillVersions,
  normalizeSkillName,
  parseSkillMemory,
  resolveSkillScopes,
} from "../skill-memory.js";

export const skillGetDef = {
  name: "skill_get",
  description:
    "Load a single skill by slug or memory id, including the known version history in the same scope.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
  },
};

export async function skillGet(args: {
  id?: string;
  name?: string;
}): Promise<unknown> {
  let memory = null;

  if (args.id) {
    memory = await loadSkillMemoryById(String(args.id).trim());
  } else if (args.name) {
    const ctx = getAgentContext();
    const scopes = await resolveSkillScopes(undefined, undefined, ctx.role_id);
    const normalizedName = normalizeSkillName(args.name);

    for (const scope of scopes) {
      if (scope.scope_id === null) {
        continue;
      }

      memory = await loadLatestSkillMemoryByName(normalizedName, {
        scope_id: scope.scope_id,
        scope_type: scope.scope_type,
      });
      if (memory) {
        break;
      }
    }

    if (!memory) {
      memory = await loadLatestSkillMemoryByName(normalizedName);
    }
  } else {
    throw new Error("skill_get requires either id or name");
  }

  if (!memory) {
    return {
      success: false,
      error: "Skill not found",
    };
  }

  const versions = (await loadSkillVersions(memory)).map((version) => ({
    id: version.id,
    updated_at: version.updated_at,
  }));

  return {
    success: true,
    skill: parseSkillMemory(memory),
    versions,
  };
}
