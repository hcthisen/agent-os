import { getAgentContext } from "../context.js";
import { enforceScope, getCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";
import { callSupervisorControl } from "../supervisor-control.js";

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

export async function messageSend(args: {
  channel: "admin_chat" | "telegram";
  content: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const ctx = getAgentContext();
  let taskId = args.task_id || null;

  if (taskId) {
    await enforceScope("task", taskId);
  } else {
    taskId = (await getCurrentTaskContext())?.id || null;
  }
  await assertTaskMutationAllowed("message_send");

  const result = await callSupervisorControl<{
    adminMirrorMessage: Record<string, unknown> | null;
    delivery: string;
    message: Record<string, unknown> | null;
    success: boolean;
    telegramChatId: number | string | null;
    telegramError: string | null;
  }>("/control/message-send", {
    channel: args.channel,
    content: args.content,
    metadata: args.metadata || {},
    sender: ctx.role_id || "system",
    task_id: taskId,
  });

  return {
    success: result.success,
    delivery: result.delivery,
    message: result.message,
    ...(result.telegramChatId !== null
      ? { telegram_chat_id: result.telegramChatId }
      : {}),
    ...(result.telegramError ? { telegram_error: result.telegramError } : {}),
    ...(result.adminMirrorMessage
      ? { admin_mirror_message: result.adminMirrorMessage }
      : {}),
  };
}
