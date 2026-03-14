import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope, getCurrentTaskContext, type ScopeType } from "../scope.js";
import { withDecryptedCredential } from "../service-registry.js";

const OPENAI_EMBEDDING_MODEL = "text-embedding-ada-002";
const OPENAI_SERVICE_NAME = "openai";
const OPENAI_SERVICE_BASE_URL = "https://api.openai.com/v1";

interface SearchChunk {
  chunk_content: string;
  chunk_id: string;
  chunk_scope_id: string;
  chunk_scope_type: ScopeType;
  chunk_source_id: string;
  chunk_source_type: string;
  rrf_score: number;
}

interface MemoryRow {
  content: string;
  id: string;
  is_active: boolean;
  layer: string;
  scope_id: string;
  scope_type: ScopeType;
  subject: string;
  tags: string[];
}

interface ArtifactRow {
  artifact_type: string;
  external_url: string | null;
  id: string;
  metadata: Record<string, unknown>;
  mime_type: string | null;
  name: string;
  storage_path: string | null;
  task_id: string | null;
}

interface EmbeddingServiceRow {
  base_url: string | null;
  credential: string | null;
  service_name: string;
  status: string;
}

export const memorySearchDef = {
  name: "memory_search",
  description:
    "Search memories using scoped retrieval with structured scope precedence and optional hybrid FTS + vector search.",
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
  const limit = Math.max(1, Math.min(50, args.limit || 20));
  const scopes = await resolveScopes(args.scope_type, args.scope_id, ctx.role_id);
  const queryEmbedding = await generateQueryEmbedding(args.query);

  const orderedChunks: SearchChunk[] = [];
  const seenChunkIds = new Set<string>();
  const orderedSubjectMatches: MemoryRow[] = [];
  const seenSubjectIds = new Set<string>();

  for (const scope of scopes) {
    const { data, error } = await db.rpc("hybrid_memory_search", {
      filter_scope_id: scope.scope_id,
      filter_scope_type: scope.scope_type,
      match_limit: limit,
      query_embedding: queryEmbedding ? JSON.stringify(queryEmbedding) : null,
      query_text: args.query,
      rrf_k: 60,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    for (const chunk of (data || []) as SearchChunk[]) {
      if (seenChunkIds.has(chunk.chunk_id)) {
        continue;
      }

      orderedChunks.push(chunk);
      seenChunkIds.add(chunk.chunk_id);

      if (orderedChunks.length >= limit) {
        break;
      }
    }

    let subjectQuery = db
      .from("memories")
      .select("id,layer,scope_type,scope_id,subject,content,tags,is_active")
      .eq("is_active", true)
      .eq("scope_type", scope.scope_type)
      .ilike("subject", `%${args.query}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (scope.scope_id !== null) {
      subjectQuery = subjectQuery.eq("scope_id", scope.scope_id);
    }

    const { data: subjectMatches, error: subjectError } =
      await subjectQuery.returns<MemoryRow[]>();

    if (subjectError) {
      return { success: false, error: subjectError.message };
    }

    for (const memory of subjectMatches || []) {
      if (seenSubjectIds.has(memory.id)) {
        continue;
      }

      orderedSubjectMatches.push(memory);
      seenSubjectIds.add(memory.id);

      if (orderedSubjectMatches.length >= limit) {
        break;
      }
    }

    if (orderedChunks.length >= limit && orderedSubjectMatches.length >= limit) {
      break;
    }
  }

  const chunks = await hydrateChunkSources(orderedChunks.slice(0, limit));

  return {
    success: true,
    chunks,
    query_embedding_used: queryEmbedding !== null,
    scopes_searched: scopes,
    subject_matches: orderedSubjectMatches.slice(0, limit),
  };
}

async function resolveScopes(
  scopeType: string | undefined,
  scopeId: string | undefined,
  roleId: string
): Promise<Array<{ scope_type: ScopeType; scope_id: string | null }>> {
  const scopes: Array<{ scope_type: ScopeType; scope_id: string | null }> = [];

  if (scopeType) {
    if (!scopeId && scopeType !== "company") {
      throw new Error(`scope_id is required for scope_type '${scopeType}'`);
    }

    if (scopeType === "company") {
      scopes.push({ scope_type: "company", scope_id: scopeId || null });
      return scopes;
    }

    await enforceScope(scopeType, scopeId as string);
    scopes.push({
      scope_id: scopeId as string,
      scope_type: scopeType as ScopeType,
    });
    return scopes;
  }

  const currentTask = await getCurrentTaskContext();
  if (currentTask) {
    scopes.push({ scope_type: "task", scope_id: currentTask.id });
    if (currentTask.project_id) {
      scopes.push({ scope_type: "project", scope_id: currentTask.project_id });
    }
  }
  scopes.push({ scope_type: "role", scope_id: roleId });
  scopes.push({ scope_type: "company", scope_id: null });
  return scopes;
}

async function hydrateChunkSources(chunks: SearchChunk[]): Promise<Array<Record<string, unknown>>> {
  if (!chunks.length) {
    return [];
  }

  const db = getDb();
  const memoryIds = chunks
    .filter((chunk) => chunk.chunk_source_type === "memory")
    .map((chunk) => chunk.chunk_source_id);
  const artifactIds = chunks
    .filter((chunk) => chunk.chunk_source_type === "artifact")
    .map((chunk) => chunk.chunk_source_id);

  const [memoryRows, artifactRows] = await Promise.all([
    memoryIds.length
      ? db
          .from("memories")
          .select("id,layer,scope_type,scope_id,subject,content,tags,is_active")
          .in("id", memoryIds)
          .returns<MemoryRow[]>()
          .then((result) => result.data || [])
      : Promise.resolve([] as MemoryRow[]),
    artifactIds.length
      ? db
          .from("artifacts")
          .select("id,name,artifact_type,mime_type,storage_path,external_url,metadata,task_id")
          .in("id", artifactIds)
          .returns<ArtifactRow[]>()
          .then((result) => result.data || [])
      : Promise.resolve([] as ArtifactRow[]),
  ]);

  const memoryMap = new Map(memoryRows.map((row) => [row.id, row]));
  const artifactMap = new Map(artifactRows.map((row) => [row.id, row]));

  return chunks.map((chunk) => ({
    ...chunk,
    source_artifact:
      chunk.chunk_source_type === "artifact"
        ? artifactMap.get(chunk.chunk_source_id) || null
        : null,
    source_memory:
      chunk.chunk_source_type === "memory"
        ? memoryMap.get(chunk.chunk_source_id) || null
        : null,
  }));
}

async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  try {
    const db = getDb();
    const { data: rawData, error } = await db
      .from("service_registry")
      .select("service_name,base_url,credential,status")
      .eq("service_name", OPENAI_SERVICE_NAME)
      .maybeSingle<EmbeddingServiceRow>();
    const data = await withDecryptedCredential(rawData);

    if (error || !data || data.status !== "active" || !data.credential) {
      return null;
    }

    const baseUrl = (data.base_url || OPENAI_SERVICE_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: query,
        model: OPENAI_EMBEDDING_MODEL,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = payload.data?.[0]?.embedding;
    return Array.isArray(embedding) ? embedding : null;
  } catch {
    return null;
  }
}
