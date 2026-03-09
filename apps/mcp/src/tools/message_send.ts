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

  if (args.channel === "telegram") {
    const chatId = metadata.chat_id;
    if (chatId === undefined || chatId === null) {
      throw new Error("Telegram outbound messages require metadata.chat_id");
    }

    await sendTelegramMessage(chatId as number | string, args.content);
    delivery = "telegram_sent";
  }

  const { data, error } = await db
    .from("messages")
    .insert({
      channel: args.channel,
      content: args.content,
      direction: "outbound",
      metadata,
      processed: true,
      sender: agent?.name || ctx.role_id,
      task_id: taskId,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, delivery, message: data };
}
