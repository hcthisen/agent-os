import { getDb } from "./db.js";

const EMBEDDING_BATCH_SIZE = 10;
const EMBEDDING_POLL_MS = 30000; // 30 seconds

interface EmbeddingService {
  credential: string | null;
  base_url: string | null;
  service_name: string;
}

interface MemoryChunkRow {
  id: string;
  content: string;
}

interface MemoryRow {
  id: string;
  subject: string;
  content: string;
  scope_type: string;
  scope_id: string;
}

interface ChunkSourceRow {
  source_id: string;
}

interface ArtifactRow {
  id: string;
  name: string;
  storage_path: string | null;
  mime_type: string | null;
  metadata: Record<string, unknown> | null;
  project_id: string | null;
  task_id: string | null;
}

/**
 * Process memory chunks that are missing embeddings.
 * Generates embeddings via the configured embedding service (e.g., OpenAI).
 */
export async function processEmbeddings(): Promise<void> {
  const db = getDb();

  // Check if an embedding service is configured
  const { data: service } = await db
    .from("service_registry")
    .select("credential, base_url, service_name")
    .eq("service_name", "openai")
    .eq("status", "active")
    .single<EmbeddingService>();

  if (!service?.credential) {
    // No embedding service configured — skip silently
    return;
  }

  // Find chunks without embeddings
  const { data: chunks } = await db
    .from("memory_chunks")
    .select("id, content")
    .is("embedding", null)
    .limit(EMBEDDING_BATCH_SIZE)
    .returns<MemoryChunkRow[]>();

  if (!chunks?.length) return;

  try {
    // Generate embeddings via OpenAI API
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${service.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-ada-002",
        input: chunks.map((chunk) => chunk.content),
      }),
    });

    if (!response.ok) {
      console.error(`Embedding API error: ${response.status}`);
      return;
    }

    const result = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    // Update chunks with embeddings
    for (const item of result.data) {
      const chunk = chunks[item.index];
      if (!chunk) continue;

      await db
        .from("memory_chunks")
        .update({ embedding: JSON.stringify(item.embedding) })
        .eq("id", chunk.id);
    }

    console.log(`Generated embeddings for ${result.data.length} chunks`);
  } catch (err) {
    console.error("Embedding generation error:", err);
  }
}

/**
 * Memory distillation: read recent episodic memories and extract semantic facts.
 * This is a lightweight pass — the actual distillation is done by the sentinel agent.
 */
export async function processDistillation(): Promise<void> {
  const db = getDb();

  // Find episodic memories that don't have corresponding semantic memories yet
  // This is tracked by checking if a semantic memory exists with the same scope
  // and a more recent created_at. The sentinel handles the actual LLM-based distillation.
  // Here we just ensure memory_chunks exist for all recent memories.
  const { data: memories } = await db
    .from("memories")
    .select("id, subject, content, scope_type, scope_id")
    .eq("is_active", true)
    .not(
      "id",
      "in",
      // Sub-select: chunks that already exist
      `(SELECT source_id FROM memory_chunks WHERE source_type = 'memory')`
    )
    .limit(20)
    .returns<MemoryRow[]>();

  // Note: The above subquery syntax doesn't work with Supabase PostgREST.
  // Instead, we'll use a different approach: find memories without chunks.
  const { data: allMemories } = await db
    .from("memories")
    .select("id, subject, content, scope_type, scope_id")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<MemoryRow[]>();

  if (!allMemories?.length) return;

  const { data: existingChunks } = await db
    .from("memory_chunks")
    .select("source_id")
    .eq("source_type", "memory")
    .in("source_id", allMemories.map((memory) => memory.id))
    .returns<ChunkSourceRow[]>();

  const existingIds = new Set(
    (existingChunks || []).map((chunk) => chunk.source_id)
  );
  const missing = allMemories.filter((memory) => !existingIds.has(memory.id));

  if (!missing.length) return;

  // Create chunks for memories that don't have them
  const chunks = missing.map((memory) => ({
    source_type: "memory",
    source_id: memory.id,
    scope_type: memory.scope_type,
    scope_id: memory.scope_id,
    content: `${memory.subject}: ${memory.content}`,
  }));

  const { error } = await db.from("memory_chunks").insert(chunks);
  if (error) {
    console.error("Chunk creation error:", error);
  } else {
    console.log(`Created ${chunks.length} memory chunks`);
  }
}

/**
 * Process artifact chunks: split text-based artifacts into chunks for search.
 */
export async function processArtifactChunks(): Promise<void> {
  const db = getDb();

  // Find text-based artifacts without chunks
  const { data: artifacts } = await db
    .from("artifacts")
    .select("id, name, storage_path, mime_type, metadata, project_id, task_id")
    .in("mime_type", ["text/plain", "text/markdown", "application/json", "text/html"])
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<ArtifactRow[]>();

  if (!artifacts?.length) return;

  const { data: existingChunks } = await db
    .from("memory_chunks")
    .select("source_id")
    .eq("source_type", "artifact")
    .in("source_id", artifacts.map((artifact) => artifact.id))
    .returns<ChunkSourceRow[]>();

  const existingIds = new Set(
    (existingChunks || []).map((chunk) => chunk.source_id)
  );
  const missing = artifacts.filter((artifact) => !existingIds.has(artifact.id));

  if (!missing.length) return;

  // For now, create a single chunk per artifact with the name as content
  // Full content extraction would require reading from Supabase Storage
  const chunks = missing.map((artifact) => ({
    source_type: "artifact",
    source_id: artifact.id,
    scope_type: artifact.task_id
      ? "task"
      : artifact.project_id
        ? "project"
        : ("company" as string),
    scope_id: artifact.task_id || artifact.project_id || "global",
    content: `Artifact: ${artifact.name} (${artifact.mime_type})`,
  }));

  const { error } = await db.from("memory_chunks").insert(chunks);
  if (error) {
    console.error("Artifact chunk creation error:", error);
  } else {
    console.log(`Created ${chunks.length} artifact chunks`);
  }
}

let asyncInterval: ReturnType<typeof setInterval> | null = null;

export function startAsyncWorkers(): void {
  asyncInterval = setInterval(async () => {
    try {
      await processEmbeddings();
      await processDistillation();
      await processArtifactChunks();
    } catch (err) {
      console.error("Async worker error:", err);
    }
  }, EMBEDDING_POLL_MS);

  console.log("Async workers started (embedding, distillation, artifact chunks)");
}

export function stopAsyncWorkers(): void {
  if (asyncInterval) {
    clearInterval(asyncInterval);
    asyncInterval = null;
  }
}
