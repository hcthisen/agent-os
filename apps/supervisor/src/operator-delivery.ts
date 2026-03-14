import { getDb } from "./db.js";

type TelegramDelivery = "failed" | "no_chat" | "not_configured" | "telegram_sent";
type ManagedMessageChannel = "admin_chat" | "telegram";

interface OperatorMessageResult {
  messageId: string | null;
  sent: boolean;
  telegramChatId: number | string | null;
  telegramDelivery: TelegramDelivery;
  telegramError: string | null;
}

interface ManagedMessageResult {
  adminMirrorMessage: Record<string, unknown> | null;
  delivery: string;
  message: Record<string, unknown> | null;
  success: boolean;
  telegramChatId: number | string | null;
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
  const result = await sendManagedMessage({
    channel: "admin_chat",
    content: args.content,
    metadata: args.metadata,
    sender: args.sender,
    taskId: args.taskId,
  });
  return {
    messageId:
      typeof result.message?.id === "string" ? (result.message.id as string) : null,
    sent: result.success,
    telegramChatId: result.telegramChatId,
    telegramDelivery:
      result.delivery === "stored_and_telegram_sent"
        ? "telegram_sent"
        : result.delivery === "stored_admin_only"
          ? result.telegramChatId === null
            ? "no_chat"
            : "failed"
          : result.delivery === "stored"
            ? "not_configured"
            : "failed",
    telegramError: result.telegramError,
  };
}

export async function sendManagedMessage(args: {
  channel: ManagedMessageChannel;
  content: string;
  metadata?: Record<string, unknown>;
  sender?: string;
  taskId?: string | null;
}): Promise<ManagedMessageResult> {
  const db = getDb();
  const sender = args.sender || "system";
  const metadata = { ...(args.metadata || {}) };

  if (args.channel === "admin_chat") {
    const telegramMirror = await mirrorToTelegram(
      args.content,
      metadata.chat_id as number | string | null | undefined
    );
    const messageMetadata = {
      ...metadata,
      ...(telegramMirror.telegramChatId !== null
        ? { telegram_chat_id: telegramMirror.telegramChatId }
        : {}),
      telegram_delivery: telegramMirror.telegramDelivery,
      ...(telegramMirror.telegramError
        ? { telegram_error: telegramMirror.telegramError }
        : {}),
    };

    const { data, error } = await db
      .from("messages")
      .insert({
        channel: "admin_chat",
        content: args.content,
        direction: "outbound",
        metadata: messageMetadata,
        processed: true,
        sender,
        task_id: args.taskId || null,
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to insert operator message:", error);
      return {
        adminMirrorMessage: null,
        delivery: "stored_admin_only",
        message: null,
        success: false,
        telegramChatId: telegramMirror.telegramChatId,
        telegramError: telegramMirror.telegramError,
      };
    }

    return {
      adminMirrorMessage: null,
      delivery:
        telegramMirror.telegramDelivery === "telegram_sent"
          ? "stored_and_telegram_sent"
          : telegramMirror.telegramDelivery === "not_configured"
            ? "stored"
            : "stored_admin_only",
      message: data as Record<string, unknown>,
      success: true,
      telegramChatId: telegramMirror.telegramChatId,
      telegramError: telegramMirror.telegramError,
    };
  }

  const telegramChatId = await resolveTelegramChatId(
    metadata.chat_id as number | string | null | undefined
  );
  if (telegramChatId === null) {
    throw new Error("Telegram outbound messages require metadata.chat_id");
  }

  const telegramResult = await deliverTelegramMessage(telegramChatId, args.content);
  if (telegramResult.telegramError) {
    throw new Error(telegramResult.telegramError);
  }

  const { data: telegramMessage, error: telegramMessageError } = await db
    .from("messages")
    .insert({
      channel: "telegram",
      content: args.content,
      direction: "outbound",
      metadata: {
        ...metadata,
        chat_id: telegramChatId,
        telegram_delivery: "telegram_sent",
      },
      processed: true,
      sender,
      task_id: args.taskId || null,
    })
    .select()
    .single();

  if (telegramMessageError) {
    console.error("Failed to insert telegram outbound message:", telegramMessageError);
    return {
      adminMirrorMessage: null,
      delivery: "telegram_sent",
      message: null,
      success: false,
      telegramChatId,
      telegramError: telegramMessageError.message,
    };
  }

  const { data: adminMirrorMessage, error: adminMirrorError } = await db
    .from("messages")
    .insert({
      channel: "admin_chat",
      content: args.content,
      direction: "outbound",
      metadata: {
        mirrored_from: "telegram",
        telegram_chat_id: telegramChatId,
        telegram_delivery: "telegram_sent",
      },
      processed: true,
      sender,
      task_id: args.taskId || null,
    })
    .select()
    .single();

  if (adminMirrorError) {
    console.error("Failed to insert admin mirror for telegram outbound message:", adminMirrorError);
  }

  return {
    adminMirrorMessage: (adminMirrorMessage as Record<string, unknown> | null) || null,
    delivery: "telegram_sent",
    message: telegramMessage as Record<string, unknown>,
    success: true,
    telegramChatId,
    telegramError: null,
  };
}

export async function queueOperatorRelayMessage(args: {
  content: string;
  metadata?: Record<string, unknown>;
  sender?: string;
  taskId?: string | null;
}): Promise<OperatorRelayQueueResult> {
  const db = getDb();
  const notificationKey =
    typeof args.metadata?.notification_key === "string" &&
    args.metadata.notification_key.trim()
      ? args.metadata.notification_key.trim()
      : null;
  const metadata = {
    ...(args.metadata || {}),
    hidden_from_operator: true,
    operator_visible: false,
    routed_via: "relay",
  };

  if (notificationKey) {
    let duplicateQuery = db
      .from("messages")
      .select("id")
      .eq("channel", "admin_chat")
      .eq("direction", "inbound")
      .contains("metadata", {
        notification_key: notificationKey,
        routed_via: "relay",
      })
      .order("created_at", { ascending: false })
      .limit(1);

    duplicateQuery =
      args.taskId === null || typeof args.taskId === "undefined"
        ? duplicateQuery.is("task_id", null)
        : duplicateQuery.eq("task_id", args.taskId);

    const { data: existing, error: existingError } =
      await duplicateQuery.maybeSingle<{ id: string }>();

    if (existingError) {
      console.error(
        `Failed to check duplicate relay notification for ${notificationKey}:`,
        existingError
      );
    } else if (existing?.id) {
      return {
        messageId: existing.id,
        queued: false,
      };
    }
  }

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

async function mirrorToTelegram(
  content: string,
  explicitChatId?: number | string | null
): Promise<{
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

  const chatId = await resolveTelegramChatId(explicitChatId);
  if (chatId === null) {
    return {
      telegramChatId: null,
      telegramDelivery: "no_chat",
      telegramError: null,
    };
  }

  return deliverTelegramMessage(chatId, content);
}

async function deliverTelegramMessage(
  chatId: number | string,
  content: string
): Promise<{
  telegramChatId: number | string;
  telegramDelivery: TelegramDelivery;
  telegramError: string | null;
}> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    return {
      telegramChatId: chatId,
      telegramDelivery: "not_configured",
      telegramError: "TELEGRAM_BOT_TOKEN is not configured",
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

async function resolveTelegramChatId(
  explicitChatId?: number | string | null
): Promise<number | string | null> {
  if (typeof explicitChatId === "number" || typeof explicitChatId === "string") {
    return explicitChatId;
  }

  return resolveLatestTelegramChatId();
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
