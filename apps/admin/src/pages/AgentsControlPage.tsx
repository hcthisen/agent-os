import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, parseTagInput, safeJsonParse, safeJsonStringify, toTagInput } from "../lib/format";
import type { AgentActivityRecord, AgentRecord, RoleRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

type RuntimeProviderResponse = {
  activeProvider: "anthropic" | "openai";
  anthropicRoleConfig: Record<string, { effort: string; model: string }>;
  openaiModelMap: Record<string, string>;
  openaiRoleConfig: Record<string, { effort: string; model: string }>;
  providerStatus: Record<
    string,
    { authDetected?: boolean; authPath?: string; cli?: string; cliInstalled?: boolean }
  > | null;
  supervisorActiveProvider: "anthropic" | "openai";
  updatedAt: string | null;
};

type OpenAiDeviceAuthResponse = {
  authDetected: boolean;
  error: string | null;
  sessionId: string | null;
  status: "idle" | "starting" | "waiting" | "complete" | "failed" | "canceled";
  updatedAt: string | null;
  userCode: string | null;
  verificationUrl: string | null;
};

const EMPTY_ROLE_FORM = {
  description: "",
  display_name: "",
  effort: "medium",
  handoff_when: "",
  id: "",
  max_concurrent_tasks: 3,
  model: "sonnet",
  policy_doc: "",
  requires_approval_for: "",
  usage_summary: "",
};

const EMPTY_AGENT_FORM = {
  config: "{}",
  name: "",
  role_id: "",
  status: "active",
};

export function AgentsControlPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [runtimeProvider, setRuntimeProvider] = useState<RuntimeProviderResponse | null>(null);
  const [openAiDeviceAuth, setOpenAiDeviceAuth] = useState<OpenAiDeviceAuthResponse | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [roleDetail, setRoleDetail] = useState<RoleRecord | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivityRecord | null>(null);
  const [roleForm, setRoleForm] = useState(EMPTY_ROLE_FORM);
  const [agentForm, setAgentForm] = useState(EMPTY_AGENT_FORM);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [deviceAuthBusy, setDeviceAuthBusy] = useState<"cancel" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) || roleDetail || null,
    [roleDetail, roles, selectedRoleId]
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId]
  );

  async function loadPage() {
    const [agentsData, rolesData, runtimeProviderData, openAiDeviceAuthData] =
      await Promise.all([
        api.getAgents(),
        api.getRoles(),
        api.getRuntimeProvider(),
        api.getOpenAiDeviceAuth(),
      ]);

    setAgents(agentsData || []);
    setRoles(rolesData || []);
    setRuntimeProvider(runtimeProviderData || null);
    setOpenAiDeviceAuth(openAiDeviceAuthData || null);

    if (!selectedRoleId && rolesData?.[0]?.id) {
      setSelectedRoleId(rolesData[0].id);
    }
    if (!selectedAgentId && agentsData?.[0]?.id) {
      setSelectedAgentId(agentsData[0].id);
    }
  }

  useEffect(() => {
    void loadPage().catch((nextError) =>
      setError(nextError instanceof Error ? nextError.message : "Failed to load agents page.")
    );
  }, []);

  useEffect(() => {
    if (!selectedRoleId) {
      setRoleDetail(null);
      return;
    }

    void api
      .getRole(selectedRoleId)
      .then((detail) => {
        setRoleDetail(detail || null);
        if (!editingRoleId && detail) {
          setRoleForm({
            description: detail.description || "",
            display_name: detail.display_name || "",
            effort: detail.effort || "medium",
            handoff_when: detail.handoff_when || "",
            id: detail.id || "",
            max_concurrent_tasks: detail.max_concurrent_tasks || 3,
            model: detail.model || "sonnet",
            policy_doc: detail.policy_doc || "",
            requires_approval_for: toTagInput(detail.requires_approval_for),
            usage_summary: detail.usage_summary || "",
          });
        }
      })
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : "Failed to load role detail.")
      );
  }, [editingRoleId, selectedRoleId]);

  useEffect(() => {
    if (!selectedAgentId) {
      setAgentActivity(null);
      return;
    }

    void api
      .getAgentActivity(selectedAgentId)
      .then((detail) => {
        setAgentActivity(detail || null);
        if (!editingAgentId && detail?.agent) {
          setAgentForm({
            config: safeJsonStringify(detail.agent.config),
            name: detail.agent.name || "",
            role_id: detail.agent.role_id || roles[0]?.id || "",
            status: detail.agent.status || "active",
          });
        }
      })
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : "Failed to load agent activity.")
      );
  }, [editingAgentId, roles, selectedAgentId]);

  useEffect(() => {
    if (
      !openAiDeviceAuth ||
      (openAiDeviceAuth.status !== "starting" && openAiDeviceAuth.status !== "waiting")
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      void api.getOpenAiDeviceAuth().then((nextState) => {
        setOpenAiDeviceAuth(nextState || null);
      });
    }, 2000);

    return () => window.clearInterval(interval);
  }, [openAiDeviceAuth]);

  async function saveRole() {
    setSavingRole(true);
    setError(null);
    try {
      const payload = {
        description: roleForm.description,
        display_name: roleForm.display_name,
        effort: roleForm.effort,
        handoff_when: roleForm.handoff_when,
        id: roleForm.id,
        max_concurrent_tasks: Number(roleForm.max_concurrent_tasks) || 3,
        model: roleForm.model,
        policy_doc: roleForm.policy_doc,
        requires_approval_for: parseTagInput(roleForm.requires_approval_for),
        usage_summary: roleForm.usage_summary,
      };

      if (editingRoleId) {
        await api.updateRole(editingRoleId, payload);
      } else {
        await api.createRole(payload);
      }

      setEditingRoleId(null);
      await loadPage();
      setSelectedRoleId(roleForm.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save role.");
    } finally {
      setSavingRole(false);
    }
  }

  async function saveAgent() {
    setSavingAgent(true);
    setError(null);
    try {
      const payload = {
        config: safeJsonParse(agentForm.config),
        name: agentForm.name,
        role_id: agentForm.role_id,
        status: agentForm.status,
      };

      if (editingAgentId) {
        await api.updateAgent(editingAgentId, payload);
      } else {
        const created = await api.createAgent(payload);
        setSelectedAgentId(created.id);
      }

      setEditingAgentId(null);
      await loadPage();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save agent.");
    } finally {
      setSavingAgent(false);
    }
  }

  async function saveProvider(provider: "anthropic" | "openai") {
    if (!runtimeProvider) {
      return;
    }

    setSavingProvider(true);
    try {
      await api.saveRuntimeProvider(
        provider,
        runtimeProvider.anthropicRoleConfig,
        runtimeProvider.openaiModelMap,
        runtimeProvider.openaiRoleConfig
      );
      await loadPage();
    } finally {
      setSavingProvider(false);
    }
  }

  async function startOpenAiDeviceAuth() {
    const authWindow = window.open("", "_blank");
    setDeviceAuthBusy("start");
    try {
      const nextState = await api.startOpenAiDeviceAuth();
      setOpenAiDeviceAuth(nextState || null);
      if (nextState?.verificationUrl) {
        authWindow?.location.replace(nextState.verificationUrl);
      } else {
        authWindow?.close();
      }
    } catch (nextError) {
      authWindow?.close();
      setError(
        nextError instanceof Error ? nextError.message : "Failed to start OpenAI device auth."
      );
    } finally {
      setDeviceAuthBusy(null);
    }
  }

  async function cancelOpenAiDeviceAuth() {
    setDeviceAuthBusy("cancel");
    try {
      const nextState = await api.cancelOpenAiDeviceAuth();
      setOpenAiDeviceAuth(nextState || null);
      await loadPage();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to cancel OpenAI device auth."
      );
    } finally {
      setDeviceAuthBusy(null);
    }
  }

  function beginCreateRole() {
    setEditingRoleId(null);
    setSelectedRoleId(null);
    setRoleDetail(null);
    setRoleForm(EMPTY_ROLE_FORM);
  }

  function beginEditRole() {
    if (!selectedRole) {
      return;
    }
    setEditingRoleId(selectedRole.id);
  }

  function beginCreateAgent() {
    setEditingAgentId(null);
    setSelectedAgentId(null);
    setAgentActivity(null);
    setAgentForm({
      ...EMPTY_AGENT_FORM,
      role_id: roles[0]?.id || "",
    });
  }

  function beginEditAgent() {
    if (!selectedAgent) {
      return;
    }
    setEditingAgentId(selectedAgent.id);
  }

  const agentsForSelectedRole = selectedRole
    ? agents.filter((agent) => agent.role_id === selectedRole.id)
    : [];

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Agents</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Runtime provider controls plus role and agent management.
          </p>
        </div>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}

      <div style={{ ...shellStyles.card, marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Runtime Provider</h3>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            marginBottom: 12,
          }}
        >
          {(["anthropic", "openai"] as const).map((provider) => {
            const status = runtimeProvider?.providerStatus?.[provider];
            const active = runtimeProvider?.activeProvider === provider;
            return (
              <div
                key={provider}
                style={{
                  background: active ? "#162032" : "#0f1320",
                  border: `1px solid ${active ? "#3b82f6" : "#253247"}`,
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <strong>{provider === "openai" ? "OpenAI Codex" : "Claude"}</strong>
                  <span style={statusChipStyle(active ? "#3b82f6" : "#64748b")}>
                    {active ? "Active" : "Inactive"}
                  </span>
                </div>
                <div style={shellStyles.muted}>
                  CLI {status?.cli || provider}
                  {status?.cliInstalled ? " installed" : " missing"}
                </div>
                <div style={shellStyles.muted}>
                  Login {status?.authDetected ? "detected" : "not detected"}
                </div>
                {provider === "openai" && (
                  <div style={{ marginTop: 10 }}>
                    {openAiDeviceAuth?.userCode && !openAiDeviceAuth.authDetected && (
                      <div style={{ ...shellStyles.muted, marginBottom: 6 }}>
                        Code: <span style={shellStyles.inlineCode}>{openAiDeviceAuth.userCode}</span>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        disabled={deviceAuthBusy !== null || openAiDeviceAuth?.authDetected}
                        onClick={() => void startOpenAiDeviceAuth()}
                        style={{ ...shellStyles.button, opacity: deviceAuthBusy ? 0.7 : 1 }}
                        type="button"
                      >
                        Connect ChatGPT
                      </button>
                      {(openAiDeviceAuth?.status === "starting" ||
                        openAiDeviceAuth?.status === "waiting") && (
                        <button
                          disabled={deviceAuthBusy !== null}
                          onClick={() => void cancelOpenAiDeviceAuth()}
                          style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
                          type="button"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <button
                  disabled={savingProvider}
                  onClick={() => void saveProvider(provider)}
                  style={{ ...shellStyles.button, marginTop: 12, opacity: savingProvider ? 0.7 : 1, width: "100%" }}
                  type="button"
                >
                  {active ? "Active Provider" : "Activate Provider"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Roles</h3>
              <button onClick={beginCreateRole} style={shellStyles.button} type="button">
                Create Role
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {roles.map((role) => (
                <button
                  key={role.id}
                  onClick={() => setSelectedRoleId(role.id)}
                  style={{
                    background: selectedRoleId === role.id ? "#162032" : "transparent",
                    border: "1px solid #253247",
                    borderRadius: 10,
                    color: "inherit",
                    cursor: "pointer",
                    padding: 12,
                    textAlign: "left",
                  }}
                  type="button"
                >
                  <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ color: "#f8fafc", fontWeight: 600 }}>{role.display_name}</div>
                    <span style={statusChipStyle(role.is_system_role ? "#3b82f6" : "#64748b")}>
                      {role.is_system_role ? "system" : "custom"}
                    </span>
                  </div>
                  <div style={shellStyles.muted}>
                    {role.id} • {role.model} / {role.effort}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Agents</h3>
              <button onClick={beginCreateAgent} style={shellStyles.button} type="button">
                Create Agent
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                  style={{
                    background: selectedAgentId === agent.id ? "#162032" : "transparent",
                    border: "1px solid #253247",
                    borderRadius: 10,
                    color: "inherit",
                    cursor: "pointer",
                    padding: 12,
                    textAlign: "left",
                  }}
                  type="button"
                >
                  <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ color: "#f8fafc", fontWeight: 600 }}>{agent.name}</div>
                    <span
                      style={statusChipStyle(
                        agent.status === "active"
                          ? "#22c55e"
                          : agent.status === "paused"
                            ? "#f59e0b"
                            : "#ef4444"
                      )}
                    >
                      {agent.status}
                    </span>
                  </div>
                  <div style={shellStyles.muted}>
                    {agent.role_id} • last seen {formatDateTime(agent.last_seen_at)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {editingRoleId ? "Edit Role" : "Role Detail"}
              </h3>
              {selectedRole && !editingRoleId && (
                <button onClick={beginEditRole} style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }} type="button">
                  Edit Role
                </button>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Role ID</label>
                  <input
                    disabled={Boolean(editingRoleId)}
                    onChange={(event) =>
                      setRoleForm((current) => ({ ...current, id: event.target.value }))
                    }
                    style={{ ...shellStyles.input, opacity: editingRoleId ? 0.7 : 1, width: "100%" }}
                    value={roleForm.id}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Display Name</label>
                  <input
                    onChange={(event) =>
                      setRoleForm((current) => ({
                        ...current,
                        display_name: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={roleForm.display_name}
                  />
                </div>
              </div>
              <div>
                <label style={shellStyles.label}>Description</label>
                <textarea
                  onChange={(event) =>
                    setRoleForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, width: "100%" }}
                  value={roleForm.description}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Policy Doc</label>
                <textarea
                  onChange={(event) =>
                    setRoleForm((current) => ({
                      ...current,
                      policy_doc: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, minHeight: 180, width: "100%" }}
                  value={roleForm.policy_doc}
                />
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr 140px" }}>
                <div>
                  <label style={shellStyles.label}>Usage Summary</label>
                  <input
                    onChange={(event) =>
                      setRoleForm((current) => ({
                        ...current,
                        usage_summary: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={roleForm.usage_summary}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Handoff When</label>
                  <input
                    onChange={(event) =>
                      setRoleForm((current) => ({
                        ...current,
                        handoff_when: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={roleForm.handoff_when}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Max Tasks</label>
                  <input
                    min={1}
                    onChange={(event) =>
                      setRoleForm((current) => ({
                        ...current,
                        max_concurrent_tasks: Number(event.target.value),
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    type="number"
                    value={roleForm.max_concurrent_tasks}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Model</label>
                  <select
                    onChange={(event) =>
                      setRoleForm((current) => ({ ...current, model: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={roleForm.model}
                  >
                    <option value="haiku">haiku</option>
                    <option value="sonnet">sonnet</option>
                    <option value="opus">opus</option>
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Effort</label>
                  <select
                    onChange={(event) =>
                      setRoleForm((current) => ({ ...current, effort: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={roleForm.effort}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={shellStyles.label}>Requires Approval For</label>
                <input
                  onChange={(event) =>
                    setRoleForm((current) => ({
                      ...current,
                      requires_approval_for: event.target.value,
                    }))
                  }
                  placeholder="system.modify, service.manage"
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={roleForm.requires_approval_for}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={savingRole}
                  onClick={() => void saveRole()}
                  style={{ ...shellStyles.button, opacity: savingRole ? 0.7 : 1 }}
                  type="button"
                >
                  {savingRole ? "Saving..." : editingRoleId ? "Save Role" : "Create Role"}
                </button>
              </div>
              {selectedRole && (
                <div style={shellStyles.muted}>
                  Agents in role: {agentsForSelectedRole.map((agent) => agent.name).join(", ") || "none"}
                </div>
              )}
            </div>
          </div>

          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {editingAgentId ? "Edit Agent" : "Agent Detail"}
              </h3>
              {selectedAgent && !editingAgentId && (
                <button onClick={beginEditAgent} style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }} type="button">
                  Edit Agent
                </button>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 180px 160px" }}>
                <div>
                  <label style={shellStyles.label}>Name</label>
                  <input
                    onChange={(event) =>
                      setAgentForm((current) => ({ ...current, name: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={agentForm.name}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Role</label>
                  <select
                    onChange={(event) =>
                      setAgentForm((current) => ({ ...current, role_id: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={agentForm.role_id}
                  >
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Status</label>
                  <select
                    onChange={(event) =>
                      setAgentForm((current) => ({ ...current, status: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={agentForm.status}
                  >
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="disabled">disabled</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={shellStyles.label}>Config JSON</label>
                <textarea
                  onChange={(event) =>
                    setAgentForm((current) => ({ ...current, config: event.target.value }))
                  }
                  style={{ ...shellStyles.textarea, minHeight: 140, width: "100%" }}
                  value={agentForm.config}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={savingAgent}
                  onClick={() => void saveAgent()}
                  style={{ ...shellStyles.button, opacity: savingAgent ? 0.7 : 1 }}
                  type="button"
                >
                  {savingAgent ? "Saving..." : editingAgentId ? "Save Agent" : "Create Agent"}
                </button>
              </div>
              {agentActivity && (
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                  <div style={shellStyles.card}>
                    <strong>Recent Task Runs</strong>
                    {agentActivity.task_runs.length === 0 ? (
                      <div style={{ ...shellStyles.muted, marginTop: 8 }}>No recent task runs.</div>
                    ) : (
                      agentActivity.task_runs.map((run) => (
                        <div key={run.id} style={{ borderBottom: "1px solid #1f2937", marginTop: 8, paddingBottom: 8 }}>
                          <div style={{ color: "#f8fafc", fontWeight: 600 }}>
                            {run.task_title || run.task_id}
                          </div>
                          <div style={shellStyles.muted}>
                            {run.status} • {run.model_used} / {run.effort_used}
                          </div>
                          <div style={shellStyles.muted}>{formatDateTime(run.started_at)}</div>
                        </div>
                      ))
                    )}
                  </div>
                  <div style={shellStyles.card}>
                    <strong>Recent Events</strong>
                    {agentActivity.events.length === 0 ? (
                      <div style={{ ...shellStyles.muted, marginTop: 8 }}>No recent events.</div>
                    ) : (
                      agentActivity.events.map((event) => (
                        <div key={event.id} style={{ borderBottom: "1px solid #1f2937", marginTop: 8, paddingBottom: 8 }}>
                          <div style={{ color: "#f8fafc", fontWeight: 600 }}>{event.event_type}</div>
                          <div style={shellStyles.muted}>{event.summary}</div>
                          <div style={shellStyles.muted}>{formatDateTime(event.created_at)}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

