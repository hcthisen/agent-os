import { getDb } from "./db.js";
import { sendOperatorMessage } from "./operator-delivery.js";

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

  for (const msg of messages) {
    // Create a high-priority relay task
    const { data: relayTask, error: taskErr } = await db
      .from("tasks")
      .insert({
        title: `Process message: ${msg.content.slice(0, 50)}...`,
        objective: `Process this inbound message from ${msg.sender} via ${msg.channel}. Classify intent and route appropriately.\n\nMessage: ${msg.content}`,
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
