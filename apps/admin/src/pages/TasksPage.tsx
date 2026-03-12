import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

interface Task {
  id: string;
  title: string;
  state: string;
  priority: string;
  assigned_role: string;
  claimed_by: string | null;
  attempt_count: number;
  blocked_reason: string | null;
  last_handoff_note: string | null;
  last_activity_at?: string | null;
  last_activity_summary?: string | null;
  created_at: string;
  updated_at: string;
  parent_task_id: string | null;
}

interface Approval {
  id: string;
  task_id: string;
  action_type: string;
  description: string;
  status: string;
  created_at: string;
}

const STATE_COLORS: Record<string, string> = {
  backlog: "#666",
  ready: "#3b82f6",
  claimed: "#a855f7",
  running: "#22c55e",
  blocked_on_human: "#f59e0b",
  blocked_on_agent: "#f59e0b",
  in_review: "#06b6d4",
  completed: "#10b981",
  failed: "#ef4444",
  dead_letter: "#dc2626",
};

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Task | null>(null);

  async function loadTasks() {
    const data = await api.getTasks();
    setTasks(data || []);
  }

  async function loadApprovals() {
    const data = await api.getApprovals();
    setApprovals(data || []);
  }

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      await Promise.all([loadTasks(), loadApprovals()]);
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleApproval(id: string, decision: "approved" | "rejected") {
    if (decision === "approved") {
      await api.approveApproval(id);
    } else {
      await api.rejectApproval(id);
    }

    await Promise.all([loadApprovals(), loadTasks()]);
  }

  async function retryDeadLetter(taskId: string) {
    await api.retryTask(taskId);
    await loadTasks();
  }

  const filtered = filter === "all" ? tasks : tasks.filter((t) => t.state === filter);

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Tasks</h2>

      {approvals.length > 0 && (
        <div style={{ marginBottom: 20, padding: 16, background: "#1a1a2e", borderRadius: 8, border: "1px solid #f59e0b33" }}>
          <h3 style={{ fontSize: 14, color: "#f59e0b", marginBottom: 12 }}>Pending Approvals ({approvals.length})</h3>
          {approvals.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 12, color: "#888" }}>{a.action_type}</span>
                <p style={{ fontSize: 13 }}>{a.description}</p>
              </div>
              <button onClick={() => handleApproval(a.id, "approved")} style={{ ...btnStyle, background: "#22c55e" }}>Approve</button>
              <button onClick={() => handleApproval(a.id, "rejected")} style={{ ...btnStyle, background: "#ef4444" }}>Reject</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          "all",
          "ready",
          "claimed",
          "running",
          "blocked_on_human",
          "blocked_on_agent",
          "in_review",
          "completed",
          "failed",
          "dead_letter",
        ].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid #333",
              background: filter === s ? "#2a2a3a" : "transparent",
              color: STATE_COLORS[s] || "#e0e0e8",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {s} {s !== "all" ? `(${tasks.filter((t) => t.state === s).length})` : `(${tasks.length})`}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {filtered.map((t) => (
          <div
            key={t.id}
            onClick={() => setSelected(selected?.id === t.id ? null : t)}
            style={{
              padding: "10px 14px",
              background: selected?.id === t.id ? "#1a1a2e" : "#111118",
              border: "1px solid #2a2a3a",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{t.title}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#888" }}>{t.assigned_role}</span>
                <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 3, background: (STATE_COLORS[t.state] || "#666") + "22", color: STATE_COLORS[t.state] }}>
                  {t.state}
                </span>
              </div>
            </div>
            {selected?.id === t.id && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#aaa" }}>
                <p><strong>ID:</strong> {t.id}</p>
                {t.parent_task_id && <p><strong>Parent:</strong> {t.parent_task_id}</p>}
                <p><strong>Priority:</strong> {t.priority}</p>
                <p><strong>Attempts:</strong> {t.attempt_count}</p>
                <p><strong>Updated:</strong> {new Date(t.updated_at).toLocaleString()}</p>
                {t.last_activity_at && (
                  <p><strong>Last Activity:</strong> {new Date(t.last_activity_at).toLocaleString()}</p>
                )}
                {t.last_activity_summary && (
                  <p style={{ marginTop: 6 }}><strong>Activity:</strong> {t.last_activity_summary}</p>
                )}
                {t.blocked_reason && <p style={{ marginTop: 6 }}><strong>Blocked:</strong> {t.blocked_reason}</p>}
                {t.last_handoff_note && <p style={{ marginTop: 6 }}><strong>Handoff:</strong> {t.last_handoff_note}</p>}
                {t.state === "dead_letter" && (
                  <button onClick={(e) => { e.stopPropagation(); retryDeadLetter(t.id); }} style={{ ...btnStyle, background: "#3b82f6", marginTop: 8 }}>
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "4px 12px",
  border: "none",
  borderRadius: 4,
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
