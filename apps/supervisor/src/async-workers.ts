import { getDb } from "./db.js";
import { queueOperatorRelayMessage } from "./operator-delivery.js";

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

  const { data: service, error: serviceError } = await db
    .from("service_registry")
    .select(
      "id,credential,base_url,error_message,service_name,status,updated_at"
    )
    .eq("service_name", OPENAI_SERVICE_NAME)
    .maybeSingle<EmbeddingService>();

  if (serviceError) {
    console.error("Failed to load embedding service configuration:", serviceError);
    return;
  }

  if (!service) {
    const keyNeededService = await ensureOpenAiServiceKeyNeeded(null);
    if (keyNeededService) {
      await notifyOpenAiKeyNeeded(keyNeededService);
    }
    return;
  }

  if (service.status === "disabled") {
    return;
  }

  if (service.status === "key_needed") {
    await notifyOpenAiKeyNeeded(service);
    return;
  }

  if (service.status === "error") {
    await notifyOpenAiServiceError(service);
    return;
  }

  if (!service.credential) {
    const keyNeededService = await ensureOpenAiServiceKeyNeeded(service);
    if (keyNeededService) {
      await notifyOpenAiKeyNeeded(keyNeededService);
    }
    return;
  }

  try {
    const baseUrl = (service.base_url || OPENAI_SERVICE_BASE_URL).replace(
      /\/+$/,
      ""
    );

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${service.credential}`,
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
          service,
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

    const result = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };

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

  // Find episodic memories that do not have corresponding semantic memories yet.
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
      `(SELECT source_id FROM memory_chunks WHERE source_type = 'memory')`
    )
    .limit(20)
    .returns<MemoryRow[]>();

  // Note: The above subquery syntax does not work with Supabase PostgREST.
  // Instead, use a second query to find memories without chunks.
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
