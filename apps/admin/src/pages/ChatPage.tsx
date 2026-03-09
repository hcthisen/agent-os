import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface Message {
  id: string;
  direction: string;
  sender: string;
  content: string;
  created_at: string;
}

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  async function loadMessages() {
    const data = await api.getMessages();
    setMessages(data || []);
  }

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      await loadMessages();
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    await api.sendMessage(input.trim());
    setInput("");
    await loadMessages();
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Chat</h2>
      <div style={styles.messages}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...styles.message,
              ...(msg.direction === "inbound" ? styles.inbound : styles.outbound),
            }}
          >
            <span style={styles.sender}>{msg.sender}</span>
            <p style={styles.content}>{msg.content}</p>
            <span style={styles.time}>
              {new Date(msg.created_at).toLocaleTimeString()}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={sendMessage} style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message..."
          autoFocus
        />
        <button style={styles.sendBtn} type="submit">
          Send
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "calc(100vh - 48px)" },
  heading: { fontSize: 20, fontWeight: 600, marginBottom: 16 },
  messages: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "0 0 16px" },
  message: { maxWidth: "70%", padding: "8px 12px", borderRadius: 10, fontSize: 14 },
  inbound: { alignSelf: "flex-end", background: "#1e3a5f", borderBottomRightRadius: 2 },
  outbound: { alignSelf: "flex-start", background: "#1e1e2e", borderBottomLeftRadius: 2 },
  sender: { fontSize: 11, color: "#888", display: "block", marginBottom: 2 },
  content: { lineHeight: 1.5 },
  time: { fontSize: 10, color: "#666", display: "block", marginTop: 4, textAlign: "right" as const },
  inputRow: { display: "flex", gap: 8 },
  input: {
    flex: 1,
    padding: "10px 14px",
    background: "#111118",
    border: "1px solid #2a2a3a",
    borderRadius: 8,
    color: "#e0e0e8",
    fontSize: 14,
    outline: "none",
  },
  sendBtn: {
    padding: "10px 20px",
    background: "#3b82f6",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
};
