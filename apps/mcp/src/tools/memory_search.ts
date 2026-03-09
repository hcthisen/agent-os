import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope, getCurrentTaskContext, type ScopeType } from "../scope.js";

export const memorySearchDef = {
  name: "memory_search",
  description:
    "Search memories using hybrid FTS + vector search (RRF). Scoped to your accessible data.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query text" },
      scope_type: {
        type: "string",
        enum: ["task", "project", "customer", "role", "department", "company"],
      },
      scope_id: { type: "string" },
      limit: { type: "number", default: 20 },
    },
    required: ["query"],
  },
};

export async function memorySearch(args: {
  query: string;
  scope_type?: string;
  scope_id?: string;
  limit?: number;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  const limit = args.limit || 20;
  const scopes: Array<{ scope_type: ScopeType; scope_id: string | null }> = [];

  if (args.scope_type) {
    if (!args.scope_id && args.scope_type !== "company") {
      return {
        success: false,
        error: `scope_id is required for scope_type '${args.scope_type}'`,
      };
    }

    if (args.scope_type === "company") {
      scopes.push({ scope_type: "company", scope_id: args.scope_id || null });
    } else {
      await enforceScope(args.scope_type, args.scope_id as string);
      scopes.push({
        scope_type: args.scope_type as ScopeType,
        scope_id: args.scope_id as string,
      });
    }
  } else {
    const currentTask = await getCurrentTaskContext();
    if (currentTask) {
      scopes.push({ scope_type: "task", scope_id: currentTask.id });
      if (currentTask.project_id) {
        scopes.push({ scope_type: "project", scope_id: currentTask.project_id });
      }
    }
    scopes.push({ scope_type: "role", scope_id: ctx.role_id });
    scopes.push({ scope_type: "company", scope_id: null });
  }

  const chunkMap = new Map<string, any>();
  const subjectMap = new Map<string, any>();

  for (const scope of scopes) {
    const { data, error } = await db.rpc("hybrid_memory_search", {
      query_text: args.query,
      query_embedding: null,
      filter_scope_type: scope.scope_type,
      filter_scope_id: scope.scope_id,
      match_limit: limit,
      rrf_k: 60,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    for (const chunk of data || []) {
      const existing = chunkMap.get(chunk.chunk_id);
      if (!existing || existing.rrf_score < chunk.rrf_score) {
        chunkMap.set(chunk.chunk_id, chunk);
      }
    }

    let subjectQuery = db
      .from("memories")
      .select("*")
      .eq("is_active", true)
      .eq("scope_type", scope.scope_type)
      .ilike("subject", `%${args.query}%`)
      .limit(Math.min(limit, 10));

    if (scope.scope_id !== null) {
      subjectQuery = subjectQuery.eq("scope_id", scope.scope_id);
    }

    const { data: subjectMatches, error: subjectError } = await subjectQuery;
    if (subjectError) {
      return { success: false, error: subjectError.message };
    }

    for (const memory of subjectMatches || []) {
      subjectMap.set(memory.id, memory);
    }
  }

  const chunks = [...chunkMap.values()]
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, limit);

  return {
    success: true,
    chunks,
    subject_matches: [...subjectMap.values()].slice(0, limit),
  };
}
