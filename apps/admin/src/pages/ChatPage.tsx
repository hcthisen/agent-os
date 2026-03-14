import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { subscribeAdminStream } from "../lib/stream";
import type { MessageRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const PAGE_SIZE = 50;

function resolveLinkedTaskId(message: MessageRecord): string | null {
  if (typeof message.task_id === "string" && message.task_id) {
    return message.task_id;
  }

  const relayTaskId = message.metadata?.relay_task_id;
  return typeof relayTaskId === "string" && relayTaskId ? relayTaskId : null;
}

export function ChatPage({
  onOpenTask,
}: {
  onOpenTask?: (taskId: string) => void;
}) {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [input, setInput] = useState("");
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    if (!container) {
      return;
    }

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

  function mergeMessages(
    existing: MessageRecord[],
    incoming: MessageRecord[]
  ): MessageRecord[] {
    const byId = new Map<string, MessageRecord>();

    for (const message of existing) {
      byId.set(message.id, message);
    }

    for (const message of incoming) {
      byId.set(message.id, message);
    }

    return [...byId.values()].sort(
      (left, right) =>
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
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
    void loadLatestMessages().catch((nextError) => {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to load chat history."
      );
    });

    return subscribeAdminStream((snapshot) => {
      setMessages((current) => mergeMessages(current, snapshot.messages || []));
      setError(null);
    });
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

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!input.trim() || sending) {
      return;
    }

    shouldStickToBottomRef.current = true;
    setSending(true);
    setError(null);

    try {
      await api.sendMessage(input.trim());
      setInput("");
      await loadLatestMessages();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to send message."
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px)" }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Chat</h2>
        <p style={{ ...shellStyles.muted, margin: 0 }}>
          Markdown now renders inline. Messages with task context expose a task shortcut.
        </p>
      </div>

      <div
        ref={messagesRef}
        onScroll={updateStickiness}
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 10,
          overflow: "auto",
          paddingBottom: 16,
        }}
      >
        <div style={{ ...shellStyles.muted, padding: "4px 0 8px", textAlign: "center" }}>
          {loadingOlderMessages
            ? "Loading older messages..."
            : hasOlderMessages
              ? "Scroll up to load earlier history"
              : "Start of chat history"}
        </div>
        {messages.map((message) => {
          const linkedTaskId = resolveLinkedTaskId(message);
          const isTeachMode = message.metadata?.teach_mode === true;
          return (
            <div
              key={message.id}
              style={{
                alignSelf: message.direction === "inbound" ? "flex-end" : "flex-start",
                background: message.direction === "inbound" ? "#17304e" : "#1a1a2a",
                border:
                  message.direction === "inbound"
                    ? "1px solid #214f7a"
                    : "1px solid #2a2a3a",
                borderRadius: 14,
                borderBottomLeftRadius: message.direction === "outbound" ? 4 : 14,
                borderBottomRightRadius: message.direction === "inbound" ? 4 : 14,
                maxWidth: "72%",
                padding: 12,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <span style={{ color: "#cbd5e1", fontSize: 11 }}>{message.sender}</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {isTeachMode && (
                    <span style={statusChipStyle("#f59e0b")}>Teach mode</span>
                  )}
                  {linkedTaskId && onOpenTask && (
                    <button
                      onClick={() => onOpenTask(linkedTaskId)}
                      style={{
                        ...shellStyles.button,
                        ...shellStyles.buttonGhost,
                        fontSize: 11,
                        padding: "4px 8px",
                      }}
                      type="button"
                    >
                      Task {linkedTaskId.slice(0, 8)}
                    </button>
                  )}
                </div>
              </div>
              <div style={{ color: "#e5e7eb", fontSize: 14 }}>
                {renderMarkdown(message.content)}
              </div>
              <div style={{ ...shellStyles.muted, marginTop: 10, textAlign: "right" }}>
                {formatDateTime(message.created_at)}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 10 }}>{error}</div>
      )}

      <form onSubmit={sendMessage} style={{ display: "flex", gap: 8 }}>
        <input
          autoFocus
          onChange={(event) => setInput(event.target.value)}
          placeholder="Send a message..."
          style={{ ...shellStyles.input, flex: 1, fontSize: 14, padding: "10px 14px" }}
          value={input}
        />
        <button
          disabled={sending}
          style={{ ...shellStyles.button, opacity: sending ? 0.7 : 1, padding: "10px 20px" }}
          type="submit"
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}
