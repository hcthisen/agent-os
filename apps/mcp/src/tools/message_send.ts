import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope, getCurrentTaskContext } from "../scope.js";

export const messageSendDef = {
  name: "message_send",
  description:
    "Send an outbound message to a supported operator channel and record it in the audit trail.",
  inputSchema: {
    type: "object" as const,
    properties: {
      channel: {
        type: "string",
        enum: ["admin_chat", "telegram"],
      },
      content: { type: "string" },
      task_id: {
        type: "string",
        description: "Associated task UUID, if this message belongs to a task thread.",
      },
      metadata: {
        type: "object",
        description:
          "Optional channel metadata. For Telegram, include chat_id when replying to a specific conversation.",
      },
    },
    required: ["channel", "content"],
  },
};

async function sendTelegramMessage(
  chatId: number | string,
  text: string
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${body}`);
  }
}

async function resolveLatestTelegramChatId(
  explicitChatId?: number | string | null
): Promise<number | string | null> {
  if (typeof explicitChatId === "number" || typeof explicitChatId === "string") {
    return explicitChatId;
  }

  const db = getDb();
  const { data, error } = await db
    .from("messages")
    .select("metadata")
    .eq("channel", "telegram")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to resolve Telegram chat ID: ${error.message}`);
  }

  for (const row of data || []) {
    const chatId = (row as { metadata?: Record<string, unknown> | null }).metadata?.chat_id;
    if (typeof chatId === "number" || typeof chatId === "string") {
      return chatId;
    }
  }

  return null;
}

export async function messageSend(args: {
  channel: "admin_chat" | "telegram";
  content: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  let taskId = args.task_id || null;

  if (taskId) {
    await enforceScope("task", taskId);
  } else {
    taskId = (await getCurrentTaskContext())?.id || null;
  }

  const { data: agent } = await db
    .from("agents")
    .select("name")
    .eq("id", ctx.agent_id)
    .single();

  const metadata = args.metadata || {};
  let delivery = "stored";
  let telegramChatId: number | string | null = null;
  let telegramError: string | null = null;
  let mirrorMessage: Record<string, unknown> | null = null;

  if (args.channel === "telegram") {
    telegramChatId = await resolveLatestTelegramChatId(
      metadata.chat_id as number | string | null | undefined
    );
    if (telegramChatId === undefined || telegramChatId === null) {
      throw new Error("Telegram outbound messages require metadata.chat_id");
    }

    await sendTelegramMessage(telegramChatId, args.content);
    delivery = "telegram_sent";
  } else {
    telegramChatId = await resolveLatestTelegramChatId(
      metadata.chat_id as number | string | null | undefined
    );

    if (telegramChatId !== null) {
      try {
        await sendTelegramMessage(telegramChatId, args.content);
        delivery = "stored_and_telegram_sent";
      } catch (error) {
        telegramError = error instanceof Error ? error.message : String(error);
        delivery = "stored_admin_only";
      }
    }
  }

  const messageMetadata = {
    ...metadata,
    ...(telegramChatId !== null ? { chat_id: telegramChatId } : {}),
    ...(args.channel === "admin_chat"
      ? {
          telegram_delivery:
            delivery === "stored_and_telegram_sent"
              ? "telegram_sent"
              : telegramChatId === null
                ? "no_chat"
                : "failed",
        }
      : {}),
    ...(telegramError ? { telegram_error: telegramError } : {}),
  };

  const { data, error } = await db
    .from("messages")
    .insert({
      channel: args.channel,
      content: args.content,
      direction: "outbound",
      metadata: messageMetadata,
      processed: true,
      sender: agent?.name || ctx.role_id,
      task_id: taskId,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  if (args.channel === "telegram") {
    const { data: adminMirror, error: adminMirrorError } = await db
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
        sender: agent?.name || ctx.role_id,
        task_id: taskId,
      })
      .select()
      .single();

    if (!adminMirrorError) {
      mirrorMessage = adminMirror as Record<string, unknown>;
    }
  }

  return {
    success: true,
    delivery,
    message: data,
    ...(telegramChatId !== null ? { telegram_chat_id: telegramChatId } : {}),
    ...(telegramError ? { telegram_error: telegramError } : {}),
    ...(mirrorMessage ? { admin_mirror_message: mirrorMessage } : {}),
  };
}
