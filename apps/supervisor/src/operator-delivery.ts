import { getDb } from "./db.js";

type TelegramDelivery = "failed" | "no_chat" | "not_configured" | "telegram_sent";

interface OperatorMessageResult {
  messageId: string | null;
  sent: boolean;
  telegramChatId: number | string | null;
  telegramDelivery: TelegramDelivery;
  telegramError: string | null;
}

interface OperatorRelayQueueResult {
  messageId: string | null;
  queued: boolean;
}

export async function sendOperatorMessage(args: {
  content: string;
  metadata?: Record<string, unknown>;
  sender?: string;
  taskId?: string | null;
}): Promise<OperatorMessageResult> {
  const db = getDb();
  const metadata = { ...(args.metadata || {}) };
  const telegramMirror = await mirrorToTelegram(args.content);

  metadata.telegram_delivery = telegramMirror.telegramDelivery;
  if (telegramMirror.telegramChatId !== null) {
    metadata.telegram_chat_id = telegramMirror.telegramChatId;
  }
  if (telegramMirror.telegramError) {
    metadata.telegram_error = telegramMirror.telegramError;
  }

  const { data, error } = await db
    .from("messages")
    .insert({
      channel: "admin_chat",
      content: args.content,
      direction: "outbound",
      metadata,
      processed: true,
      sender: args.sender || "system",
      task_id: args.taskId || null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to insert operator message:", error);
    return {
      messageId: null,
      sent: false,
      telegramChatId: telegramMirror.telegramChatId,
      telegramDelivery: telegramMirror.telegramDelivery,
      telegramError: telegramMirror.telegramError,
    };
  }

  return {
    messageId: data?.id || null,
    sent: true,
    telegramChatId: telegramMirror.telegramChatId,
    telegramDelivery: telegramMirror.telegramDelivery,
    telegramError: telegramMirror.telegramError,
  };
}

export async function queueOperatorRelayMessage(args: {
  content: string;
  metadata?: Record<string, unknown>;
  sender?: string;
  taskId?: string | null;
}): Promise<OperatorRelayQueueResult> {
  const db = getDb();
  const metadata = {
    ...(args.metadata || {}),
    hidden_from_operator: true,
    operator_visible: false,
    routed_via: "relay",
  };

  const { data, error } = await db
    .from("messages")
    .insert({
      channel: "admin_chat",
      content: args.content,
      direction: "inbound",
      metadata,
      processed: false,
      sender: args.sender || "system",
      task_id: args.taskId || null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to enqueue operator relay message:", error);
    return {
      messageId: null,
      queued: false,
    };
  }

  return {
    messageId: data?.id || null,
    queued: true,
  };
}

async function mirrorToTelegram(content: string): Promise<{
  telegramChatId: number | string | null;
  telegramDelivery: TelegramDelivery;
  telegramError: string | null;
}> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    return {
      telegramChatId: null,
      telegramDelivery: "not_configured",
      telegramError: null,
    };
  }

  const chatId = await resolveLatestTelegramChatId();
  if (chatId === null) {
    return {
      telegramChatId: null,
      telegramDelivery: "no_chat",
      telegramError: null,
    };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        chat_id: chatId,
        parse_mode: "Markdown",
        text: content,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        telegramChatId: chatId,
        telegramDelivery: "failed",
        telegramError: `Telegram send failed: ${response.status} ${body}`,
      };
    }

    return {
      telegramChatId: chatId,
      telegramDelivery: "telegram_sent",
      telegramError: null,
    };
  } catch (error) {
    return {
      telegramChatId: chatId,
      telegramDelivery: "failed",
      telegramError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveLatestTelegramChatId(): Promise<number | string | null> {
  const db = getDb();
  const { data, error } = await db
    .from("messages")
    .select("metadata")
    .eq("channel", "telegram")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("Failed to resolve latest Telegram chat ID:", error);
    return null;
  }

  for (const row of data || []) {
    const chatId = (row as { metadata?: Record<string, unknown> | null }).metadata?.chat_id;
    if (typeof chatId === "number" || typeof chatId === "string") {
      return chatId;
    }
  }

  return null;
}
