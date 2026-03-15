import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, safeJsonParse, safeJsonStringify } from "../lib/format";
import type { AgentActivityRecord, AgentRecord } from "../lib/types";
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

const EMPTY_AGENT_FORM = {
  config: "{}",
  description: "",
  effort: "medium",
  handoff_when: "",
  max_concurrent_tasks: 3,
  model: "sonnet",
  name: "",
  policy_doc: "",
  status: "active",
  usage_summary: "",
};

function getAgentLabel(agent: AgentRecord | null | undefined): string {
  if (!agent) {
    return "";
  }

  return (
    agent.role_profile?.display_name?.trim() ||
    agent.name?.trim() ||
    agent.role_id?.trim() ||
    "Untitled agent"
  );
}

function buildAgentForm(agent: AgentRecord | null | undefined) {
  return {
    config: safeJsonStringify(agent?.config),
    description: agent?.role_profile?.description || "",
    effort: agent?.role_profile?.effort || "medium",
    handoff_when: agent?.role_profile?.handoff_when || "",
    max_concurrent_tasks: agent?.role_profile?.max_concurrent_tasks || 3,
    model: agent?.role_profile?.model || "sonnet",
    name: getAgentLabel(agent),
    policy_doc: agent?.role_profile?.policy_doc || "",
    status: agent?.status || "active",
    usage_summary: agent?.role_profile?.usage_summary || "",
  };
}

export function AgentsControlPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [runtimeProvider, setRuntimeProvider] = useState<RuntimeProviderResponse | null>(null);
  const [openAiDeviceAuth, setOpenAiDeviceAuth] = useState<OpenAiDeviceAuthResponse | null>(
    null
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivityRecord | null>(null);
  const [agentForm, setAgentForm] = useState(EMPTY_AGENT_FORM);
  const [savingAgent, setSavingAgent] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [deviceAuthBusy, setDeviceAuthBusy] = useState<"cancel" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || agentActivity?.agent || null,
    [agentActivity?.agent, agents, selectedAgentId]
  );

  const agentProfiles = useMemo(() => {
    const seen = new Set<string>();
    return agents
      .filter((agent) => {
        if (seen.has(agent.role_id)) {
          return false;
        }
        seen.add(agent.role_id);
        return true;
      })
      .sort((left, right) => getAgentLabel(left).localeCompare(getAgentLabel(right)));
  }, [agents]);

  async function loadPage() {
    const [agentsData, runtimeProviderData, openAiDeviceAuthData] = await Promise.all([
      api.getAgents(),
      api.getRuntimeProvider(),
      api.getOpenAiDeviceAuth(),
    ]);

    setAgents(agentsData || []);
    setRuntimeProvider(runtimeProviderData || null);
    setOpenAiDeviceAuth(openAiDeviceAuthData || null);

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
    if (!selectedAgentId) {
      setAgentActivity(null);
      setAgentForm(EMPTY_AGENT_FORM);
      return;
    }

    void api
      .getAgentActivity(selectedAgentId)
      .then((detail) => {
        setAgentActivity(detail || null);
        if (detail?.agent) {
          setAgentForm(buildAgentForm(detail.agent));
        }
      })
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : "Failed to load agent activity.")
      );
  }, [selectedAgentId]);

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

  const openAiAuthStatus =
    openAiDeviceAuth?.status ||
    (runtimeProvider?.providerStatus?.openai?.authDetected ? "complete" : "idle");
  const openAiAuthDetected =
    openAiDeviceAuth?.authDetected ||
    runtimeProvider?.providerStatus?.openai?.authDetected ||
    false;

  function resolveAnthropicProfile(agent: AgentRecord) {
    const roleId = agent.role_id;
    const roleProfile = agent.role_profile;
    const override = runtimeProvider?.anthropicRoleConfig?.[roleId];

    return {
      effort: override?.effort || roleProfile?.effort || "medium",
      model: override?.model || roleProfile?.model || "sonnet",
    };
  }

  function resolveOpenAiProfile(agent: AgentRecord) {
    const roleId = agent.role_id;
    const roleProfile = agent.role_profile;
    const normalizedBaseModel = String(roleProfile?.model || "").toLowerCase();
    const override = runtimeProvider?.openaiRoleConfig?.[roleId];

    return {
      effort: override?.effort || roleProfile?.effort || "medium",
      model:
        override?.model ||
        runtimeProvider?.openaiModelMap?.[normalizedBaseModel] ||
        roleProfile?.model ||
        "gpt-5.4",
    };
  }

  async function saveAgent() {
    setSavingAgent(true);
    setError(null);
    try {
      const payload = {
        config: safeJsonParse(agentForm.config),
        description: agentForm.description,
        effort: agentForm.effort,
        handoff_when: agentForm.handoff_when,
        max_concurrent_tasks: Number(agentForm.max_concurrent_tasks) || 3,
        model: agentForm.model,
        name: agentForm.name,
        policy_doc: agentForm.policy_doc,
        status: agentForm.status,
        usage_summary: agentForm.usage_summary,
      };

      if (selectedAgentId) {
        await api.updateAgent(selectedAgentId, payload);
        setSelectedAgentId(selectedAgentId);
      } else {
        const created = await api.createAgent(payload);
        setSelectedAgentId(created.id);
      }

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

  function beginCreateAgent() {
    setSelectedAgentId(null);
    setAgentActivity(null);
    setAgentForm(EMPTY_AGENT_FORM);
  }

  return (
    <div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Agents</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Runtime provider controls plus persistent agent identities. Prefer better task routing, initiatives, and shared skills before adding a new agent.
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
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
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
                    {openAiDeviceAuth?.userCode && !openAiAuthDetected && (
                      <div style={{ ...shellStyles.muted, marginBottom: 6 }}>
                        Code: <span style={shellStyles.inlineCode}>{openAiDeviceAuth.userCode}</span>
                      </div>
                    )}
                    {openAiAuthDetected && (
                      <div style={{ color: "#22c55e", fontSize: 12, marginBottom: 8 }}>
                        ChatGPT subscription login is connected on the supervisor.
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      {!openAiAuthDetected && (
                        <button
                          disabled={deviceAuthBusy !== null}
                          onClick={() => void startOpenAiDeviceAuth()}
                          style={{ ...shellStyles.button, opacity: deviceAuthBusy ? 0.7 : 1 }}
                          type="button"
                        >
                          {deviceAuthBusy === "start" ? "Starting..." : "Connect ChatGPT"}
                        </button>
                      )}
                      {(openAiAuthStatus === "starting" || openAiAuthStatus === "waiting") && (
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
                  style={{
                    ...shellStyles.button,
                    marginTop: 12,
                    opacity: savingProvider ? 0.7 : 1,
                    width: "100%",
                  }}
                  type="button"
                >
                  {active ? "Active Provider" : "Activate Provider"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ ...shellStyles.card, marginBottom: 16 }}>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
              {runtimeProvider?.activeProvider === "openai"
                ? "OpenAI Runtime Profiles"
                : "Claude Runtime Profiles"}
            </h3>
            <div style={{ ...shellStyles.muted, marginTop: 4 }}>
              Runtime provider overrides are configured per agent profile.
            </div>
          </div>
          {runtimeProvider?.updatedAt && (
            <div style={shellStyles.muted}>Updated {formatDateTime(runtimeProvider.updatedAt)}</div>
          )}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {agentProfiles.map((agent) => {
            const activeProfile =
              runtimeProvider?.activeProvider === "openai"
                ? resolveOpenAiProfile(agent)
                : resolveAnthropicProfile(agent);
            const baseModel = agent.role_profile?.model || "sonnet";
            const baseEffort = agent.role_profile?.effort || "medium";

            return (
              <div
                key={agent.role_id}
                style={{
                  background: "#111118",
                  border: "1px solid #232334",
                  borderRadius: 8,
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "minmax(180px, 0.9fr) 1fr",
                  padding: 12,
                }}
              >
                <div>
                  <div style={{ color: "#f8fafc", fontWeight: 600 }}>{getAgentLabel(agent)}</div>
                  <div style={shellStyles.muted}>
                    Base profile {baseModel} / {baseEffort}
                  </div>
                </div>
                <div style={shellStyles.muted}>
                  Active runtime {activeProfile.model} / {activeProfile.effort}
                </div>
              </div>
            );
          })}
          {agentProfiles.length === 0 && (
            <div style={shellStyles.muted}>No agents are configured yet.</div>
          )}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1.1fr)",
        }}
      >
        <div style={shellStyles.card}>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Agents</h3>
            <button onClick={beginCreateAgent} style={shellStyles.button} type="button">
              Manual Agent Override
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                }}
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
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <div style={{ color: "#f8fafc", fontWeight: 600 }}>{getAgentLabel(agent)}</div>
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
                  {agent.role_profile?.model || "sonnet"} / {agent.role_profile?.effort || "medium"}
                  {" • "}
                  {agent.role_profile?.is_system_role ? "system" : "custom"}
                </div>
                <div style={{ ...shellStyles.muted, marginTop: 4 }}>
                  Last seen {formatDateTime(agent.last_seen_at)}
                </div>
              </button>
            ))}
            {agents.length === 0 && <div style={shellStyles.muted}>No agents created yet.</div>}
          </div>
        </div>

        <div style={shellStyles.card}>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
              {selectedAgent ? "Agent Detail" : "Create Agent"}
            </h3>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 180px" }}>
              <div>
                <label style={shellStyles.label}>Agent Name</label>
                <input
                  onChange={(event) =>
                    setAgentForm((current) => ({ ...current, name: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={agentForm.name}
                />
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
              <label style={shellStyles.label}>Description</label>
              <textarea
                onChange={(event) =>
                  setAgentForm((current) => ({ ...current, description: event.target.value }))
                }
                style={{ ...shellStyles.textarea, width: "100%" }}
                value={agentForm.description}
              />
            </div>
            <div>
              <label style={shellStyles.label}>System Instructions</label>
              <textarea
                onChange={(event) =>
                  setAgentForm((current) => ({ ...current, policy_doc: event.target.value }))
                }
                style={{ ...shellStyles.textarea, minHeight: 220, width: "100%" }}
                value={agentForm.policy_doc}
              />
            </div>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr 140px" }}>
              <div>
                <label style={shellStyles.label}>Usage Summary</label>
                <input
                  onChange={(event) =>
                    setAgentForm((current) => ({
                      ...current,
                      usage_summary: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={agentForm.usage_summary}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Handoff Guidance</label>
                <input
                  onChange={(event) =>
                    setAgentForm((current) => ({
                      ...current,
                      handoff_when: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={agentForm.handoff_when}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Max Tasks</label>
                <input
                  min={1}
                  onChange={(event) =>
                    setAgentForm((current) => ({
                      ...current,
                      max_concurrent_tasks: Number(event.target.value),
                    }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  type="number"
                  value={agentForm.max_concurrent_tasks}
                />
              </div>
            </div>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <label style={shellStyles.label}>Base Model</label>
                <select
                  onChange={(event) =>
                    setAgentForm((current) => ({ ...current, model: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={agentForm.model}
                >
                  <option value="haiku">haiku</option>
                  <option value="sonnet">sonnet</option>
                  <option value="opus">opus</option>
                </select>
              </div>
              <div>
                <label style={shellStyles.label}>Base Effort</label>
                <select
                  onChange={(event) =>
                    setAgentForm((current) => ({ ...current, effort: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={agentForm.effort}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
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
                {savingAgent ? "Saving..." : selectedAgentId ? "Save Agent" : "Create Agent"}
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
                      <div
                        key={run.id}
                        style={{
                          borderBottom: "1px solid #1f2937",
                          marginTop: 8,
                          paddingBottom: 8,
                        }}
                      >
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
                      <div
                        key={event.id}
                        style={{
                          borderBottom: "1px solid #1f2937",
                          marginTop: 8,
                          paddingBottom: 8,
                        }}
                      >
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
  );
}
