import { getDb } from "./db.js";
import { queueOperatorRelayMessage } from "./operator-delivery.js";
import { getServiceRegistryRuntime } from "./service-registry.js";

const EMBEDDING_BATCH_SIZE = 10;
const EMBEDDING_POLL_MS = 30000; // 30 seconds
const OPENAI_SERVICE_NAME = "openai";
const OPENAI_SERVICE_DISPLAY_NAME = "OpenAI API";
const OPENAI_SERVICE_DESCRIPTION =
  "Required for memory and artifact embedding generation.";
const OPENAI_SERVICE_BASE_URL = "https://api.openai.com/v1";
const OPENAI_EMBEDDING_MODEL = "text-embedding-ada-002";

interface EmbeddingService {
  id: string;
  credential: string | null;
  base_url: string | null;
  error_message: string | null;
  service_name: string;
  status: "active" | "disabled" | "error" | "key_needed";
  updated_at: string;
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
  layer?: string;
  tags?: string[];
}

interface ChunkSourceRow {
  source_id: string;
}

interface ArtifactRow {
  external_url: string | null;
  id: string;
  name: string;
  storage_path: string | null;
  mime_type: string | null;
  metadata: Record<string, unknown> | null;
  project_id: string | null;
  task_id: string | null;
}

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Process memory chunks that are missing embeddings.
 * Generates embeddings via the configured embedding service (e.g., OpenAI).
 */
export async function processEmbeddings(): Promise<void> {
  const db = getDb();

  // Only request the OpenAI API key once there is actual embedding work queued.
  const { data: chunks, error: chunksError } = await db
    .from("memory_chunks")
    .select("id, content")
    .is("embedding", null)
    .limit(EMBEDDING_BATCH_SIZE)
    .returns<MemoryChunkRow[]>();

  if (chunksError) {
    console.error("Failed to load chunks pending embeddings:", chunksError);
    return;
  }

  if (!chunks?.length) return;

  const resolvedService = (await getServiceRegistryRuntime(
    OPENAI_SERVICE_NAME
  )) as EmbeddingService | null;

  if (!resolvedService) {
    const keyNeededService = await ensureOpenAiServiceKeyNeeded(null);
    if (keyNeededService) {
      await notifyOpenAiKeyNeeded(keyNeededService);
    }
    return;
  }

  if (resolvedService.status === "disabled") {
    return;
  }

  if (resolvedService.status === "key_needed") {
    await notifyOpenAiKeyNeeded(resolvedService);
    return;
  }

  if (resolvedService.status === "error") {
    await notifyOpenAiServiceError(resolvedService);
    return;
  }

  if (!resolvedService.credential) {
    const keyNeededService = await ensureOpenAiServiceKeyNeeded(resolvedService);
    if (keyNeededService) {
      await notifyOpenAiKeyNeeded(keyNeededService);
    }
    return;
  }

  try {
    const baseUrl = (resolvedService.base_url || OPENAI_SERVICE_BASE_URL).replace(
      /\/+$/,
      ""
    );

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolvedService.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_EMBEDDING_MODEL,
        input: chunks.map((chunk) => chunk.content),
      }),
    });

    if (!response.ok) {
      const body = await response.text();

      if (response.status === 401 || response.status === 403) {
        const errorService = await markOpenAiServiceError(
          resolvedService,
          `OpenAI embeddings request failed with ${response.status}. Update the API key in Settings > Service Connections.`
        );
        if (errorService) {
          await notifyOpenAiServiceError(errorService);
        }
      }

      console.error(
        `Embedding API error: ${response.status}${body ? ` ${body}` : ""}`
      );
      return;
    }

    const result = (await response.json()) as EmbeddingResponse;

    await recordProviderUsage({
      batchSize: chunks.length,
      model: OPENAI_EMBEDDING_MODEL,
      promptTokens: result.usage?.prompt_tokens,
      serviceName: OPENAI_SERVICE_NAME,
      totalTokens: result.usage?.total_tokens,
    });

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
 * This is a lightweight pass - the actual distillation is done by the sentinel agent.
 */
export async function processDistillation(): Promise<void> {
  const db = getDb();
  const { data: allMemories } = await db
    .from("memories")
    .select("id, layer, subject, content, scope_type, scope_id, tags")
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

  const episodicMemories = allMemories.filter((memory) => memory.layer === "episodic");
  if (!episodicMemories.length) return;

  const { data: semanticMemories } = await db
    .from("memories")
    .select("scope_type, scope_id, subject, content")
    .eq("layer", "semantic")
    .eq("is_active", true);

  const semanticKeys = new Set(
    (semanticMemories || []).map((memory) =>
      buildSemanticKey(memory.scope_type, memory.scope_id, memory.subject, memory.content)
    )
  );

  const distilled = episodicMemories
    .filter(shouldDistillEpisodicMemory)
    .filter(
      (memory) =>
        !semanticKeys.has(
          buildSemanticKey(memory.scope_type, memory.scope_id, memory.subject, memory.content)
        )
    )
    .slice(0, 10);

  if (!distilled.length) return;

  const { data: insertedSemantic, error: insertSemanticError } = await db
    .from("memories")
    .insert(
      distilled.map((memory) => ({
        confidence: 0.8,
        content: memory.content,
        layer: "semantic",
        scope_id: memory.scope_id,
        scope_type: memory.scope_type,
        subject: memory.subject,
        tags: [...new Set([...(memory.tags || []), "auto_distilled"])],
      }))
    )
    .select("id, subject, content, scope_type, scope_id")
    .returns<MemoryRow[]>();

  if (insertSemanticError) {
    console.error("Semantic distillation insert error:", insertSemanticError);
    return;
  }

  if (!insertedSemantic?.length) return;

  const { error: semanticChunkError } = await db.from("memory_chunks").insert(
    insertedSemantic.map((memory) => ({
      source_type: "memory",
      source_id: memory.id,
      scope_type: memory.scope_type,
      scope_id: memory.scope_id,
      content: `${memory.subject}: ${memory.content}`,
    }))
  );

  if (semanticChunkError) {
    console.error("Semantic chunk creation error:", semanticChunkError);
  } else {
    console.log(`Distilled ${insertedSemantic.length} semantic memories`);
  }
}

/**
 * Process artifact chunks: split text-based artifacts into chunks for search.
 */
export async function processArtifactChunks(): Promise<void> {
  const db = getDb();

  const { data: artifacts } = await db
    .from("artifacts")
    .select("id, name, storage_path, external_url, mime_type, metadata, project_id, task_id")
    .in("mime_type", ["text/plain", "text/markdown", "application/json", "text/html"])
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<ArtifactRow[]>();

  if (!artifacts?.length) return;

  await db
    .from("memory_chunks")
    .delete()
    .eq("source_type", "artifact")
    .in("source_id", artifacts.map((artifact) => artifact.id));

  const chunks = artifacts.flatMap((artifact) =>
    buildArtifactChunks(artifact).map((content) => ({
      source_type: "artifact",
      source_id: artifact.id,
      scope_type: artifact.task_id
        ? "task"
        : artifact.project_id
          ? "project"
          : ("company" as string),
      scope_id: artifact.task_id || artifact.project_id || "global",
      content,
    }))
  );

  if (!chunks.length) return;

  const { error } = await db.from("memory_chunks").insert(chunks);
  if (error) {
    console.error("Artifact chunk creation error:", error);
  } else {
    console.log(`Created ${chunks.length} artifact chunks`);
  }
}

function shouldDistillEpisodicMemory(memory: MemoryRow): boolean {
  const tags = new Set((memory.tags || []).map((tag) => tag.toLowerCase()));
  return (
    tags.has("operator_preference") ||
    tags.has("preference") ||
    tags.has("constraint") ||
    tags.has("decision") ||
    memory.subject.toLowerCase().includes("preference")
  );
}

function buildSemanticKey(
  scopeType: string,
  scopeId: string,
  subject: string,
  content: string
): string {
  return `${scopeType}::${scopeId}::${subject}::${content}`;
}

function buildArtifactChunks(artifact: ArtifactRow): string[] {
  const content = extractArtifactText(artifact);
  const scopeLabel = artifact.task_id || artifact.project_id || "company";

  if (!content) {
    return [`Artifact ${artifact.name} (${artifact.mime_type || "unknown"}) for ${scopeLabel}`];
  }

  return chunkText(content, 1400, 200).map(
    (chunk, index) =>
      `Artifact: ${artifact.name}\nType: ${artifact.mime_type || "unknown"}\nChunk: ${index + 1}\n\n${chunk}`
  );
}

function extractArtifactText(artifact: ArtifactRow): string {
  const metadata = artifact.metadata || {};
  const candidateFields = [
    metadata.indexable_content,
    metadata.content,
    metadata.body,
    metadata.markdown,
    metadata.summary,
    metadata.text,
  ];
  const directText = candidateFields.find(
    (value) => typeof value === "string" && value.trim().length > 0
  );

  if (typeof directText === "string" && directText.trim()) {
    return directText.trim();
  }

  const fallbackParts = [
    artifact.name ? `Name: ${artifact.name}` : "",
    artifact.mime_type ? `Mime: ${artifact.mime_type}` : "",
    artifact.external_url ? `URL: ${artifact.external_url}` : "",
    artifact.storage_path ? `Storage: ${artifact.storage_path}` : "",
    typeof metadata.description === "string" ? `Description: ${metadata.description}` : "",
  ].filter(Boolean);

  return fallbackParts.join("\n");
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);

    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + Math.floor(maxChars / 2)) {
        end = boundary;
      }
    }

    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks.filter(Boolean);
}

async function ensureOpenAiServiceKeyNeeded(
  service: EmbeddingService | null
): Promise<EmbeddingService | null> {
  const db = getDb();

  if (service?.status === "key_needed") {
    return service;
  }

  if (service?.id) {
    const { data, error } = await db
      .from("service_registry")
      .update({
        base_url: OPENAI_SERVICE_BASE_URL,
        description: OPENAI_SERVICE_DESCRIPTION,
        display_name: OPENAI_SERVICE_DISPLAY_NAME,
        error_message: null,
        last_verified: null,
        status: "key_needed",
      })
      .eq("id", service.id)
      .select(
        "id,credential,base_url,error_message,service_name,status,updated_at"
      )
      .single<EmbeddingService>();

    if (error) {
      console.error("Failed to mark OpenAI service as key_needed:", error);
      return service;
    }

    return data || service;
  }

  const { data, error } = await db
    .from("service_registry")
    .insert({
      auth_type: "api_key",
      base_url: OPENAI_SERVICE_BASE_URL,
      credential: null,
      description: OPENAI_SERVICE_DESCRIPTION,
      display_name: OPENAI_SERVICE_DISPLAY_NAME,
      registered_by: null,
      service_name: OPENAI_SERVICE_NAME,
      status: "key_needed",
    })
    .select("id,credential,base_url,error_message,service_name,status,updated_at")
    .single<EmbeddingService>();

  if (error) {
    console.error("Failed to register OpenAI service:", error);
    return null;
  }

  return data || null;
}

async function markOpenAiServiceError(
  service: EmbeddingService,
  errorMessage: string
): Promise<EmbeddingService | null> {
  const db = getDb();
  const { data, error } = await db
    .from("service_registry")
    .update({
      error_message: errorMessage,
      last_verified: new Date().toISOString(),
      status: "error",
    })
    .eq("id", service.id)
    .select("id,credential,base_url,error_message,service_name,status,updated_at")
    .single<EmbeddingService>();

  if (error) {
    console.error("Failed to mark OpenAI service as error:", error);
    return service;
  }

  return data || service;
}

async function notifyOpenAiKeyNeeded(service: EmbeddingService): Promise<void> {
  const notificationKey = `service:key_needed:${OPENAI_SERVICE_NAME}:${service.updated_at}`;
  const content =
    "Service attention: OpenAI API key needed for embeddings. The supervisor has pending memory or artifact chunks waiting for embeddings. Add the key in Settings > Service Connections to resume embedding generation.";

  await sendOpenAiServiceNotification({
    content,
    eventType: "service.key_needed",
    notificationKey,
    severity: "warning",
    service,
  });
}

async function notifyOpenAiServiceError(
  service: EmbeddingService
): Promise<void> {
  const notificationKey = `service:error:${OPENAI_SERVICE_NAME}:${service.updated_at}`;
  const reason =
    service.error_message ||
    "The configured OpenAI credential needs attention.";
  const content = `Service attention: OpenAI API credential for embeddings is in error state. ${reason}`;

  await sendOpenAiServiceNotification({
    content,
    eventType: "service.error",
    notificationKey,
    severity: "error",
    service,
  });
}

async function sendOpenAiServiceNotification(args: {
  content: string;
  eventType: "service.error" | "service.key_needed";
  notificationKey: string;
  severity: "error" | "warning";
  service: EmbeddingService;
}): Promise<void> {
  const db = getDb();

  if (await serviceNotificationAlreadySent(args.notificationKey)) {
    return;
  }

  const notificationType =
    args.eventType === "service.key_needed"
      ? "service_key_needed"
      : "service_error";

  const delivery = await queueOperatorRelayMessage({
    content: args.content,
    metadata: {
      notification_key: args.notificationKey,
      notification_type: notificationType,
      service_name: OPENAI_SERVICE_NAME,
      service_status: args.service.status,
    },
    sender: "system",
  });

  if (!delivery.queued) {
    return;
  }

  const detail = {
    delivery: "relay_queue",
    notification_key: args.notificationKey,
    notification_type: notificationType,
    service_name: OPENAI_SERVICE_NAME,
    service_status: args.service.status,
  };

  const { error } = await db.from("events").insert([
    {
      trace_id: null,
      agent_id: null,
      event_type: args.eventType,
      severity: args.severity,
      scope_type: "company",
      scope_id: "system",
      summary: args.content.slice(0, 500),
      detail,
    },
    {
      trace_id: null,
      agent_id: null,
      event_type: "operator.notification.sent",
      severity: args.severity,
      scope_type: "company",
      scope_id: "system",
      summary: args.content.slice(0, 500),
      detail,
    },
  ]);

  if (error) {
    console.error("Failed to record OpenAI service notification:", error);
  }
}

async function serviceNotificationAlreadySent(
  notificationKey: string
): Promise<boolean> {
  const db = getDb();
  const { count, error } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "operator.notification.sent")
    .eq("scope_type", "company")
    .eq("scope_id", "system")
    .contains("detail", { notification_key: notificationKey });

  if (error) {
    console.error("Failed to check prior service notification state:", error);
    return false;
  }

  return Boolean(count && count > 0);
}

async function recordProviderUsage(args: {
  batchSize: number;
  model: string;
  promptTokens?: number;
  serviceName: string;
  totalTokens?: number;
}): Promise<void> {
  const promptTokens =
    typeof args.promptTokens === "number" && Number.isFinite(args.promptTokens)
      ? args.promptTokens
      : null;
  const totalTokens =
    typeof args.totalTokens === "number" && Number.isFinite(args.totalTokens)
      ? args.totalTokens
      : promptTokens;

  if (promptTokens === null && totalTokens === null) {
    return;
  }

  const db = getDb();
  const summaryParts = [];
  if (promptTokens !== null) {
    summaryParts.push(`${promptTokens} prompt tokens`);
  }
  if (totalTokens !== null && totalTokens !== promptTokens) {
    summaryParts.push(`${totalTokens} total tokens`);
  }

  const { error } = await db.from("events").insert({
    trace_id: null,
    agent_id: null,
    event_type: "provider.usage",
    severity: "info",
    scope_type: "company",
    scope_id: "system",
    summary: `Recorded ${args.serviceName} usage for ${args.model}: ${summaryParts.join(", ")}`,
    detail: {
      batch_size: args.batchSize,
      endpoint: "embeddings",
      model: args.model,
      prompt_tokens: promptTokens,
      provider: "openai",
      service_name: args.serviceName,
      total_tokens: totalTokens,
    },
  });

  if (error) {
    console.error("Failed to record provider usage event:", error);
  }
}

let asyncInterval: ReturnType<typeof setInterval> | null = null;
let asyncRunInFlight = false;

async function runAsyncWorkersCycle(): Promise<void> {
  if (asyncRunInFlight) {
    return;
  }

  asyncRunInFlight = true;

  try {
    await processEmbeddings();
    await processDistillation();
    await processArtifactChunks();
  } catch (err) {
    console.error("Async worker error:", err);
  } finally {
    asyncRunInFlight = false;
  }
}

export function startAsyncWorkers(): void {
  void runAsyncWorkersCycle();
  asyncInterval = setInterval(() => {
    void runAsyncWorkersCycle();
  }, EMBEDDING_POLL_MS);

  console.log("Async workers started (embedding, distillation, artifact chunks)");
}

export function stopAsyncWorkers(): void {
  if (asyncInterval) {
    clearInterval(asyncInterval);
    asyncInterval = null;
  }
}
