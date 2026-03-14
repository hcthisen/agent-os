import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { shellStyles } from "../lib/ui";

const EVENTS_PAGE_SIZE = 50;

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
  const [query, setQuery] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    void loadEvents().catch(() => undefined);
  }, [agentFilter, dateFrom, dateTo, eventTypeFilter, severityFilter]);

  async function loadEvents(options?: { append?: boolean }) {
    const before =
      options?.append && events.length > 0
        ? events[events.length - 1].created_at
        : undefined;
    const data = await api.getEvents({
      agent_id: agentFilter.trim() || undefined,
      before,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      event_type: eventTypeFilter.trim() || undefined,
      limit: EVENTS_PAGE_SIZE,
      severity: severityFilter === "all" ? undefined : severityFilter,
    });
    const nextEvents = data || [];

    setEvents((current) => (options?.append ? [...current, ...nextEvents] : nextEvents));
    setHasMore(nextEvents.length === EVENTS_PAGE_SIZE);
  }

  async function loadMoreEvents() {
    setLoadingMore(true);
    try {
      await loadEvents({ append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  const severityColors: Record<string, string> = {
    critical: "#dc2626",
    error: "#ef4444",
    info: "#3b82f6",
    warning: "#f59e0b",
  };

  const filtered = query
    ? events.filter(
        (event) =>
          event.event_type.toLowerCase().includes(query.toLowerCase()) ||
          event.summary.toLowerCase().includes(query.toLowerCase())
      )
    : events;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Events</h2>
        <p style={{ ...shellStyles.muted, margin: 0 }}>
          Filter by type, severity, agent, and time window. Expand an event to inspect
          the full JSON detail.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "1.2fr 1fr 180px 180px 160px 160px",
          marginBottom: 12,
        }}
      >
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search loaded events..."
          style={inputStyle}
          value={query}
        />
        <input
          onChange={(event) => setEventTypeFilter(event.target.value)}
          placeholder="Server filter: event type"
          style={inputStyle}
          value={eventTypeFilter}
        />
        <select
          onChange={(event) => setSeverityFilter(event.target.value)}
          style={inputStyle}
          value={severityFilter}
        >
          <option value="all">All severities</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
          <option value="critical">critical</option>
        </select>
        <input
          onChange={(event) => setAgentFilter(event.target.value)}
          placeholder="Server filter: agent id"
          style={inputStyle}
          value={agentFilter}
        />
        <input
          onChange={(event) => setDateFrom(event.target.value)}
          style={inputStyle}
          type="date"
          value={dateFrom}
        />
        <input
          onChange={(event) => setDateTo(event.target.value)}
          style={inputStyle}
          type="date"
          value={dateTo}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((event) => (
          <button
            key={event.id}
            onClick={() =>
              setExpandedEventId((current) => (current === event.id ? null : event.id))
            }
            style={{
              background: expandedEventId === event.id ? "#162032" : "#111118",
              border: "1px solid #253247",
              borderRadius: 8,
              color: "inherit",
              cursor: "pointer",
              display: "block",
              fontSize: 12,
              padding: "10px 12px",
              textAlign: "left",
              width: "100%",
            }}
            type="button"
          >
            <div style={{ alignItems: "flex-start", display: "flex", gap: 12 }}>
              <span style={{ color: "#666", flexShrink: 0, fontSize: 10, minWidth: 132 }}>
                {formatDateTime(event.created_at)}
              </span>
              <span
                style={{
                  background: (severityColors[event.severity] || "#666") + "22",
                  borderRadius: 3,
                  color: severityColors[event.severity],
                  flexShrink: 0,
                  fontSize: 10,
                  padding: "1px 5px",
                }}
              >
                {event.severity}
              </span>
              <span style={{ color: "#888", flexShrink: 0, minWidth: 160 }}>
                {event.event_type}
              </span>
              <span style={{ flex: 1 }}>{event.summary}</span>
            </div>
            {expandedEventId === event.id && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...shellStyles.muted, marginBottom: 8 }}>
                  Scope {event.scope_type}:{event.scope_id}
                  {event.agent_id ? ` | agent ${event.agent_id}` : ""}
                </div>
                <pre
                  style={{
                    background: "#090b11",
                    border: "1px solid #1f2937",
                    borderRadius: 8,
                    color: "#cbd5e1",
                    fontSize: 11,
                    margin: 0,
                    overflowX: "auto",
                    padding: 12,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {JSON.stringify(event.detail || {}, null, 2)}
                </pre>
              </div>
            )}
          </button>
        ))}
        {filtered.length === 0 && <p style={{ color: "#666", fontSize: 13 }}>No events.</p>}
      </div>

      {hasMore && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <button
            disabled={loadingMore}
            onClick={() => void loadMoreEvents()}
            style={{
              ...buttonStyle,
              background: loadingMore ? "#334155" : "#3b82f6",
              opacity: loadingMore ? 0.8 : 1,
            }}
            type="button"
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#0e0e18",
  border: "1px solid #2a2a3a",
  borderRadius: 6,
  color: "#e0e0e8",
  fontSize: 13,
  outline: "none",
  padding: "8px 12px",
  width: "100%",
};

const buttonStyle: React.CSSProperties = {
  border: "none",
  borderRadius: 6,
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  padding: "8px 16px",
};
