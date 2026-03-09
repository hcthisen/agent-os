import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

interface ServiceEntry {
  id: string;
  service_name: string;
  display_name: string;
  description: string;
  status: string;
  error_message: string | null;
  last_verified: string | null;
}

interface Schedule {
  id: string;
  name: string;
  cron_expr: string;
  assigned_role: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
}

export function SettingsPage() {
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});

  async function loadSettings() {
    const [servicesData, schedulesData] = await Promise.all([
      api.getServices(),
      api.getSchedules(),
    ]);

    setServices(servicesData || []);
    setSchedules(schedulesData || []);
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  async function saveKey(serviceId: string) {
    const key = keyInput[serviceId];
    if (!key) return;

    await api.saveServiceCredential(serviceId, key);
    setKeyInput((prev) => ({ ...prev, [serviceId]: "" }));
    await loadSettings();
  }

  async function toggleSchedule(id: string, enabled: boolean) {
    await api.setScheduleEnabled(id, enabled);
    await loadSettings();
  }

  const statusColor: Record<string, string> = {
    active: "#22c55e",
    key_needed: "#f59e0b",
    error: "#ef4444",
    disabled: "#666",
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Settings</h2>

      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Service Connections</h3>
      {services.length === 0 && <p style={{ fontSize: 13, color: "#666" }}>No services registered yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 32 }}>
        {services.map((s) => (
          <div key={s.id} style={{ padding: 14, background: "#111118", border: "1px solid #2a2a3a", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontWeight: 500, fontSize: 14 }}>{s.display_name}</span>
              <span style={{ fontSize: 11, color: statusColor[s.status] }}>{s.status}</span>
            </div>
            <p style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{s.description}</p>
            {s.status === "key_needed" && (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={inputStyle}
                  type="password"
                  placeholder="Paste API key..."
                  value={keyInput[s.id] || ""}
                  onChange={(e) => setKeyInput((prev) => ({ ...prev, [s.id]: e.target.value }))}
                />
                <button onClick={() => void saveKey(s.id)} style={btnStyle}>Save</button>
              </div>
            )}
            {s.error_message && <p style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>{s.error_message}</p>}
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Schedules</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {schedules.map((s) => (
          <div key={s.id} style={{ padding: "8px 14px", background: "#111118", border: "1px solid #2a2a3a", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
            <div>
              <span style={{ fontWeight: 500 }}>{s.name}</span>
              <span style={{ marginLeft: 12, color: "#888", fontSize: 11 }}>{s.cron_expr}</span>
              <span style={{ marginLeft: 12, color: "#888", fontSize: 11 }}>{s.assigned_role}</span>
            </div>
            <button
              onClick={() => void toggleSchedule(s.id, !s.enabled)}
              style={{ padding: "3px 10px", border: "1px solid #333", borderRadius: 4, background: s.enabled ? "#22c55e22" : "transparent", color: s.enabled ? "#22c55e" : "#666", fontSize: 11, cursor: "pointer" }}
            >
              {s.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  background: "#0e0e18",
  border: "1px solid #2a2a3a",
  borderRadius: 6,
  color: "#e0e0e8",
  fontSize: 12,
  outline: "none",
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "#3b82f6",
  border: "none",
  borderRadius: 6,
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
