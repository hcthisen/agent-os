// Supabase Edge Function: Telegram webhook handler
// Receives Telegram updates, inserts into messages table for the relay to process.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const update = await req.json();

    // Handle text messages
    const message = update.message;
    if (!message?.text) {
      return new Response("OK", { status: 200 });
    }

    const chatId = message.chat.id;
    const fromUser = message.from?.first_name || message.from?.username || "unknown";
    const text = message.text;

    // Insert into messages table
    const { error } = await supabase.from("messages").insert({
      channel: "telegram",
      direction: "inbound",
      sender: `telegram:${fromUser}`,
      content: text,
      metadata: {
        chat_id: chatId,
        message_id: message.message_id,
        from: message.from,
      },
    });

    if (error) {
      console.error("Failed to insert message:", error);
      return new Response("DB error", { status: 500 });
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("Error", { status: 500 });
  }
});

// To send outbound messages, the supervisor/relay calls this helper
export async function sendTelegramMessage(
  chatId: number,
  text: string
): Promise<void> {
  await fetch(
    `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    }
  );
}
