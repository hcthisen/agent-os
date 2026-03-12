import { getDb } from "./db.js";
import { sendOperatorMessage } from "./operator-delivery.js";

const RELAY_HISTORY_LIMIT = 15;

interface InboundMessage {
  channel: string;
  content: string;
  created_at?: string;
  direction: string;
  id: string;
  metadata?: Record<string, unknown> | null;
  sender: string;
}

interface ConversationMessage {
  content: string;
  created_at?: string;
  direction: string;
  metadata?: Record<string, unknown> | null;
  sender: string;
}

/**
 * Check for unprocessed inbound messages and create relay tasks for them.
 */
export async function routeMessages(): Promise<void> {
  const db = getDb();

  const { data: messages, error } = await db
    .from("messages")
    .select("*")
    .eq("processed", false)
    .eq("direction", "inbound")
    .order("created_at")
    .limit(10);

  if (error || !messages?.length) return;

  for (const msg of (messages || []) as InboundMessage[]) {
    const history = await loadRecentConversationMessages(msg);
    const objective = buildRelayObjective(msg, history);

    // Create a high-priority relay task
    const { data: relayTask, error: taskErr } = await db
      .from("tasks")
      .insert({
        title: `Process message: ${msg.content.slice(0, 50)}...`,
        objective,
        acceptance_criteria: [
          "Message classified",
          "Appropriate action taken or task created",
          "Response sent",
        ],
        state: "ready",
        priority: "high",
        assigned_role: "relay",
      })
      .select("id")
      .single();

    if (taskErr) {
      console.error(`Failed to create relay task for message ${msg.id}:`, taskErr);
      await sendOperatorMessage({
        content: `System alert: failed to route inbound operator message "${msg.content.slice(0, 80)}". Reason: ${taskErr.message}`,
        metadata: {
          delivery: "local",
          source_message_id: msg.id,
        },
        sender: "system",
        taskId: null,
      });
      continue;
    }

    // Mark message as processed
    await db
      .from("messages")
      .update({ processed: true, task_id: relayTask.id })
      .eq("id", msg.id);
  }
}

function buildRelayObjective(
  message: InboundMessage,
  history: ConversationMessage[]
): string {
  const transcript = [...history, {
    content: message.content,
    created_at: message.created_at,
    direction: "inbound",
    sender: message.sender,
  }]
    .map(formatConversationMessage)
    .join("\n");

  return `Process this inbound message from ${message.sender} via ${message.channel}. Classify intent and route appropriately.

Current message:
${message.content}

Recent conversation transcript:
${transcript}`;
}

function formatConversationMessage(message: ConversationMessage): string {
  const timestamp = message.created_at
    ? new Date(message.created_at).toISOString()
    : "current";
  return `[${timestamp}] ${message.direction}/${message.sender}: ${message.content}`;
}

async function loadRecentConversationMessages(
  message: InboundMessage
): Promise<ConversationMessage[]> {
  const db = getDb();
  const chatId =
    message.channel === "telegram" &&
    (typeof message.metadata?.chat_id === "string" ||
      typeof message.metadata?.chat_id === "number")
      ? message.metadata.chat_id
      : null;
  let query = db
    .from("messages")
    .select("id,direction,sender,content,created_at,metadata")
    .eq("channel", message.channel)
    .neq("id", message.id)
    .order("created_at", { ascending: false })
    .limit(RELAY_HISTORY_LIMIT);

  if (chatId !== null) {
    query = query.contains("metadata", { chat_id: chatId });
  }

  const { data, error } = await query;

  if (error) {
    console.error(
      `Failed to load recent conversation history for message ${message.id}:`,
      error
    );
    return [];
  }

  return ((data || []) as ConversationMessage[])
    .filter((row) => isRelayVisibleConversationMessage(row))
    .reverse();
}

function isRelayVisibleConversationMessage(message: ConversationMessage): boolean {
  if (message.sender === "system") {
    return false;
  }

  return (
    message.metadata?.hidden_from_operator !== true &&
    message.metadata?.operator_visible !== false
  );
}
