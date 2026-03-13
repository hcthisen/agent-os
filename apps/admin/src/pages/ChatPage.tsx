import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface Message {
  id: string;
  direction: string;
  sender: string;
  content: string;
  created_at: string;
}

const PAGE_SIZE = 50;

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const prependRestoreRef = useRef<{
    previousScrollHeight: number;
    previousScrollTop: number;
  } | null>(null);

  function updateStickiness() {
    const container = messagesRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 80;

    if (
      container.scrollTop < 80 &&
      hasOlderMessages &&
      !loadingOlderMessages &&
      messages.length > 0
    ) {
      void loadOlderMessages();
    }
  }

  function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
    const byId = new Map<string, Message>();

    for (const message of existing) {
      byId.set(message.id, message);
    }

    for (const message of incoming) {
      byId.set(message.id, message);
    }

    return [...byId.values()].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }

  async function loadLatestMessages() {
    const data = await api.getMessages({ limit: PAGE_SIZE });
    setMessages((current) => mergeMessages(current, data || []));
    if (isInitialLoadRef.current) {
      setHasOlderMessages((data || []).length >= PAGE_SIZE);
      isInitialLoadRef.current = false;
    }
  }

  async function loadOlderMessages() {
    if (loadingOlderMessages || !hasOlderMessages || messages.length === 0) {
      return;
    }

    const container = messagesRef.current;
    if (container) {
      prependRestoreRef.current = {
        previousScrollHeight: container.scrollHeight,
        previousScrollTop: container.scrollTop,
      };
    }

    setLoadingOlderMessages(true);
    try {
      const data = await api.getMessages({
        before: messages[0]?.created_at,
        limit: PAGE_SIZE,
      });
      const olderMessages = data || [];

      if (!olderMessages.length) {
        setHasOlderMessages(false);
        prependRestoreRef.current = null;
        return;
      }

      setMessages((current) => mergeMessages(current, olderMessages));
      setHasOlderMessages(olderMessages.length >= PAGE_SIZE);
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      await loadLatestMessages();
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
    const restore = prependRestoreRef.current;
    const container = messagesRef.current;

    if (restore && container) {
      const nextScrollTop =
        restore.previousScrollTop +
        (container.scrollHeight - restore.previousScrollHeight);
      prependRestoreRef.current = null;
      container.scrollTop = nextScrollTop;
      return;
    }

    if (!shouldStickToBottomRef.current) {
      return;
    }

    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    shouldStickToBottomRef.current = true;
    await api.sendMessage(input.trim());
    setInput("");
    await loadLatestMessages();
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Chat</h2>
      <div ref={messagesRef} onScroll={updateStickiness} style={styles.messages}>
        <div style={styles.historyStatus}>
          {loadingOlderMessages
            ? "Loading older messages..."
            : hasOlderMessages
              ? "Scroll up to load earlier history"
              : "Start of chat history"}
        </div>
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
  historyStatus: {
    color: "#77788a",
    fontSize: 11,
    padding: "4px 0 8px",
    textAlign: "center",
  },
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
