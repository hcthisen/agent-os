import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

interface Event {
  id: string;
  event_type: string;
  severity: string;
  scope_type: string;
  scope_id: string;
  summary: string;
  detail: Record<string, unknown>;
  agent_id: string | null;
  created_at: string;
}

export function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void loadEvents();
  }, []);

  async function loadEvents() {
    const data = await api.getEvents();
    setEvents(data || []);
  }

  const sevColor: Record<string, string> = {
    info: "#3b82f6",
    warning: "#f59e0b",
    error: "#ef4444",
    critical: "#dc2626",
  };

  const filtered = filter
    ? events.filter((e) => e.event_type.includes(filter) || e.summary.toLowerCase().includes(filter.toLowerCase()))
    : events;

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Events</h2>

      <input
        style={inputStyle}
        placeholder="Filter by type or summary..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 2 }}>
        {filtered.map((ev) => (
          <div key={ev.id} style={{ padding: "8px 12px", background: "#111118", borderRadius: 4, fontSize: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: 10, color: "#666", minWidth: 70, flexShrink: 0 }}>
              {new Date(ev.created_at).toLocaleTimeString()}
            </span>
            <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: (sevColor[ev.severity] || "#666") + "22", color: sevColor[ev.severity], flexShrink: 0 }}>
              {ev.severity}
            </span>
            <span style={{ color: "#888", minWidth: 120, flexShrink: 0 }}>{ev.event_type}</span>
            <span style={{ flex: 1 }}>{ev.summary}</span>
          </div>
        ))}
        {filtered.length === 0 && <p style={{ color: "#666", fontSize: 13 }}>No events.</p>}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "#0e0e18",
  border: "1px solid #2a2a3a",
  borderRadius: 6,
  color: "#e0e0e8",
  fontSize: 13,
  outline: "none",
};
