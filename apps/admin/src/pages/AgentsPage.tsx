import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

interface Agent {
  id: string;
  name: string;
  role_id: string;
  status: string;
  config: Record<string, unknown>;
  last_seen_at: string | null;
}

interface Role {
  id: string;
  display_name: string;
  model: string;
  effort: string;
  max_concurrent_tasks: number;
}

interface RuntimeProviderResponse {
  activeProvider: "anthropic" | "openai";
  openaiModelMap: Record<string, string>;
  openaiRoleConfig: Record<string, { effort: string; model: string }>;
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [runtimeProvider, setRuntimeProvider] =
    useState<RuntimeProviderResponse | null>(null);

  useEffect(() => {
    void Promise.all([
      api.getAgents(),
      api.getRoles(),
      api.getRuntimeProvider(),
    ]).then(([agentsData, rolesData, runtimeProviderData]) => {
      setAgents(agentsData || []);
      setRoles(rolesData || []);
      setRuntimeProvider(runtimeProviderData || null);
    });
  }, []);

  const roleMap = Object.fromEntries(roles.map((r) => [r.id, r]));
  const statusColor: Record<string, string> = {
    active: "#22c55e",
    paused: "#f59e0b",
    disabled: "#ef4444",
  };

  function resolveOpenAiRole(roleId: string, roleModel: string, roleEffort: string) {
    const normalizedRoleModel = String(roleModel || "").toLowerCase();
    const roleOverride = runtimeProvider?.openaiRoleConfig?.[roleId];
    return {
      effort: roleOverride?.effort || roleEffort || "?",
      model:
        roleOverride?.model ||
        runtimeProvider?.openaiModelMap?.[normalizedRoleModel] ||
        roleModel ||
        "?",
    };
  }

  function activeProviderLabel(roleId: string, model: string, effort: string) {
    if (runtimeProvider?.activeProvider === "openai") {
      const resolved = resolveOpenAiRole(roleId, model, effort);
      return `ChatGPT: ${resolved.model} / ${resolved.effort}`;
    }

    return `Anthropic: ${model} / ${effort}`;
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Agents</h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}
      >
        {agents.map((a) => {
          const role = roleMap[a.role_id];
          const model = String((a.config as { model?: unknown })?.model || role?.model || "?");
          const effort = String(
            (a.config as { effort?: unknown })?.effort || role?.effort || "?"
          );
          const openai = resolveOpenAiRole(a.role_id, model, effort);

          return (
            <div
              key={a.id}
              style={{
                padding: 16,
                background: "#111118",
                border: "1px solid #2a2a3a",
                borderRadius: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</span>
                <span style={{ fontSize: 11, color: statusColor[a.status] || "#888" }}>
                  {a.status}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "#888",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <span>Role: {a.role_id}</span>
                <span>Anthropic: {model} / {effort}</span>
                <span>ChatGPT: {openai.model} / {openai.effort}</span>
                <span>{activeProviderLabel(a.role_id, model, effort)}</span>
                <span>Max concurrent: {role?.max_concurrent_tasks ?? "?"}</span>
                <span>
                  Last seen:{" "}
                  {a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "never"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <h3 style={{ fontSize: 16, fontWeight: 600, marginTop: 32, marginBottom: 12 }}>
        Roles
      </h3>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #2a2a3a", textAlign: "left" }}>
            <th style={thStyle}>Role</th>
            <th style={thStyle}>Anthropic</th>
            <th style={thStyle}>ChatGPT / Codex</th>
            <th style={thStyle}>Active Provider</th>
            <th style={thStyle}>Max Tasks</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const openai = resolveOpenAiRole(r.id, r.model, r.effort);

            return (
              <tr key={r.id} style={{ borderBottom: "1px solid #1a1a2a" }}>
                <td style={tdStyle}>{r.display_name}</td>
                <td style={tdStyle}>
                  {r.model} / {r.effort}
                </td>
                <td style={tdStyle}>
                  {openai.model} / {openai.effort}
                </td>
                <td style={tdStyle}>{activeProviderLabel(r.id, r.model, r.effort)}</td>
                <td style={tdStyle}>{r.max_concurrent_tasks}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  color: "#888",
  fontWeight: 500,
};
const tdStyle: React.CSSProperties = { padding: "8px 12px" };
