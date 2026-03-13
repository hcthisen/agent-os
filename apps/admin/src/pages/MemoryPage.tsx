import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

const MEMORY_PAGE_SIZE = 50;

interface Memory {
  id: string;
  layer: string;
  scope_type: string;
  scope_id: string;
  subject: string;
  content: string;
  tags: string[];
  confidence: number;
  is_active: boolean;
  created_at: string;
}

export function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMemories(query = "", options?: { append?: boolean }) {
    const before =
      options?.append && memories.length > 0
        ? memories[memories.length - 1].created_at
        : undefined;
    const data = await api.getMemoriesPage({
      before,
      limit: MEMORY_PAGE_SIZE,
      query,
    });
    const nextMemories = data || [];

    setMemories((current) =>
      options?.append ? [...current, ...nextMemories] : nextMemories
    );
    setHasMore(nextMemories.length === MEMORY_PAGE_SIZE);
  }

  useEffect(() => {
    void loadMemories();
  }, []);

  async function handleSearch() {
    setExpanded(null);
    await loadMemories(search.trim());
  }

  async function expireMemory(id: string) {
    await api.expireMemory(id);
    await loadMemories(search.trim());
  }

  async function loadMoreMemories() {
    setLoadingMore(true);
    try {
      await loadMemories(search.trim(), { append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  const layerColor: Record<string, string> = {
    episodic: "#3b82f6",
    semantic: "#22c55e",
    procedural: "#a855f7",
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Memory</h2>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          style={inputStyle}
          placeholder="Search by subject..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
        />
        <button onClick={() => void handleSearch()} style={btnStyle}>Search</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {memories.map((m) => (
          <div
            key={m.id}
            onClick={() => setExpanded(expanded === m.id ? null : m.id)}
            style={{ padding: "10px 14px", background: "#111118", border: "1px solid #2a2a3a", borderRadius: 6, cursor: "pointer" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 500, fontSize: 13 }}>{m.subject}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "#888" }}>{m.scope_type}:{m.scope_id.slice(0, 8)}</span>
                <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: (layerColor[m.layer] || "#666") + "22", color: layerColor[m.layer] }}>
                  {m.layer}
                </span>
              </div>
            </div>
            {expanded === m.id && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#aaa" }}>
                <p style={{ lineHeight: 1.6 }}>{m.content}</p>
                <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
                  <span>Confidence: {m.confidence}</span>
                  {m.tags.length > 0 && <span>Tags: {m.tags.join(", ")}</span>}
                  <button onClick={(e) => { e.stopPropagation(); void expireMemory(m.id); }} style={{ ...btnSmall, background: "#ef444422", color: "#ef4444" }}>
                    Expire
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {memories.length === 0 && <p style={{ color: "#666", fontSize: 13 }}>No memories found.</p>}
      </div>

      {hasMore && (
        <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
          <button
            onClick={() => void loadMoreMemories()}
            disabled={loadingMore}
            style={{
              ...btnStyle,
              background: loadingMore ? "#334155" : "#3b82f6",
              opacity: loadingMore ? 0.8 : 1,
            }}
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  background: "#0e0e18",
  border: "1px solid #2a2a3a",
  borderRadius: 6,
  color: "#e0e0e8",
  fontSize: 13,
  outline: "none",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#3b82f6",
  border: "none",
  borderRadius: 6,
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const btnSmall: React.CSSProperties = {
  padding: "2px 8px",
  border: "none",
  borderRadius: 3,
  fontSize: 11,
  cursor: "pointer",
};
