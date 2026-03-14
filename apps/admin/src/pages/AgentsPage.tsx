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

interface ProviderStatusEntry {
  authDetected: boolean;
  authPath: string;
  cli: string;
  cliInstalled: boolean;
  label: string;
}

interface OpenAiRoleAlignment {
  effort: string;
  model: string;
}

interface RuntimeProviderResponse {
  activeProvider: "anthropic" | "openai";
  anthropicRoleConfig: Record<string, OpenAiRoleAlignment>;
  openaiModelMap: Record<string, string>;
  openaiRoleConfig: Record<string, OpenAiRoleAlignment>;
  providerStatus: Record<string, ProviderStatusEntry> | null;
  supervisorActiveProvider: "anthropic" | "openai";
  updatedAt: string | null;
}

interface OpenAiDeviceAuthResponse {
  authDetected: boolean;
  completedAt: string | null;
  createdAt: string | null;
  error: string | null;
  expiresAt: string | null;
  sessionId: string | null;
  status: "idle" | "starting" | "waiting" | "complete" | "failed" | "canceled";
  updatedAt: string | null;
  userCode: string | null;
  verificationUrl: string | null;
}

const PROVIDER_LABELS: Record<
  "anthropic" | "openai",
  { cli: string; runtime: string; subtitle: string; title: string }
> = {
  anthropic:
    {
      cli: "claude",
      runtime: "Claude",
      subtitle:
        "Anthropic access through the Claude CLI and the persisted supervisor login.",
      title: "Claude (Anthropic)",
    },
  openai:
    {
      cli: "codex",
      runtime: "OpenAI Codex",
      subtitle:
        "OpenAI access through the Codex CLI and the persisted ChatGPT subscription login.",
      title: "OpenAI Codex (ChatGPT)",
    },
};

const MODEL_OPTIONS = [
  "gpt-5.4",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
];
const ANTHROPIC_MODEL_OPTIONS = ["haiku", "sonnet", "opus"];

const REASONING_OPTIONS = ["low", "medium", "high", "xhigh"];
const ROLE_ORDER = [
  "relay",
  "sage",
  "builder",
  "reviewer",
  "architect",
  "sentinel",
];

const ROLE_NOTES: Record<string, string> = {
  relay: "Operator-facing interpreter. Keep it concise and conversational.",
  sage: "Deep planning role. xHigh is reserved here.",
  sentinel: "Recurring watchdog. Keep it cheap and provider-aware.",
};

const BASE_TIER_LABEL = "Base role preset";
const BASE_PROFILE_LABELS: Record<string, string> = {
  haiku: "Fast profile",
  opus: "Frontier profile",
  sonnet: "Balanced profile",
};

const OPENAI_AUTH_STATUS_LABELS: Record<OpenAiDeviceAuthResponse["status"], string> = {
  canceled: "Canceled",
  complete: "Connected",
  failed: "Failed",
  idle: "Idle",
  starting: "Starting",
  waiting: "Waiting for sign-in",
};

const OPENAI_AUTH_STATUS_COLORS: Record<OpenAiDeviceAuthResponse["status"], string> = {
  canceled: "#8b8b96",
  complete: "#22c55e",
  failed: "#ef4444",
  idle: "#8b8b96",
  starting: "#93c5fd",
  waiting: "#f59e0b",
};

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [runtimeProvider, setRuntimeProvider] =
    useState<RuntimeProviderResponse | null>(null);
  const [openAiDeviceAuth, setOpenAiDeviceAuth] =
    useState<OpenAiDeviceAuthResponse | null>(null);
  const [anthropicRoleConfig, setAnthropicRoleConfig] = useState<
    Record<string, OpenAiRoleAlignment>
  >({});
  const [openaiModelMap, setOpenaiModelMap] = useState<Record<string, string>>({});
  const [openaiRoleConfig, setOpenaiRoleConfig] = useState<
    Record<string, OpenAiRoleAlignment>
  >({});
  const [savingProvider, setSavingProvider] = useState<"anthropic" | "openai" | null>(
    null
  );
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);
  const [deviceAuthBusy, setDeviceAuthBusy] = useState<"cancel" | "start" | null>(
    null
  );
  const [deviceAuthError, setDeviceAuthError] = useState<string | null>(null);

  async function loadAgentsPage() {
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
    setAnthropicRoleConfig(runtimeProviderData?.anthropicRoleConfig || {});
    setOpenaiModelMap(runtimeProviderData?.openaiModelMap || {});
    setOpenaiRoleConfig(runtimeProviderData?.openaiRoleConfig || {});
  }

  useEffect(() => {
    void loadAgentsPage();
  }, []);

  useEffect(() => {
    if (
      !openAiDeviceAuth ||
      (openAiDeviceAuth.status !== "starting" &&
        openAiDeviceAuth.status !== "waiting")
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const nextState = await api.getOpenAiDeviceAuth();
          setOpenAiDeviceAuth(nextState || null);

          if (nextState?.authDetected || nextState?.status === "complete") {
            await loadAgentsPage();
          }
        } catch (error) {
          setDeviceAuthError(
            error instanceof Error ? error.message : "Failed to refresh ChatGPT login status."
          );
        }
      })();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [openAiDeviceAuth?.status]);

  const roleMap = Object.fromEntries(roles.map((r) => [r.id, r]));
  const statusColor: Record<string, string> = {
    active: "#22c55e",
    paused: "#f59e0b",
    disabled: "#ef4444",
  };

  const sortedRoles = [
    ...ROLE_ORDER.map((roleId) => roleMap[roleId]).filter((role): role is Role =>
      Boolean(role)
    ),
    ...roles.filter((role) => !ROLE_ORDER.includes(role.id)),
  ];

  const openAiAuthStatus =
    openAiDeviceAuth?.status ||
    (runtimeProvider?.providerStatus?.openai?.authDetected ? "complete" : "idle");
  const openAiAuthDetected =
    openAiDeviceAuth?.authDetected ||
    runtimeProvider?.providerStatus?.openai?.authDetected ||
    false;

  function formatBaseProfile(model: string) {
    const normalized = String(model || "").trim().toLowerCase();
    return BASE_PROFILE_LABELS[normalized] || model || "?";
  }

  function resolveOpenAiRole(roleId: string, roleModel: string, roleEffort: string) {
    const normalizedRoleModel = String(roleModel || "").toLowerCase();
    const roleOverride = openaiRoleConfig[roleId];
    return {
      effort: roleOverride?.effort || roleEffort || "?",
      model:
        roleOverride?.model ||
        openaiModelMap?.[normalizedRoleModel] ||
        roleModel ||
        "?",
    };
  }

  function resolveAnthropicRole(roleId: string, roleModel: string, roleEffort: string) {
    const roleOverride = anthropicRoleConfig[roleId];
    return {
      effort: roleOverride?.effort || roleEffort || "?",
      model: roleOverride?.model || roleModel || "?",
    };
  }

  function activeProviderLabel(roleId: string, model: string, effort: string) {
    if (runtimeProvider?.activeProvider === "openai") {
      const resolved = resolveOpenAiRole(roleId, model, effort);
      return `Active runtime: ${PROVIDER_LABELS.openai.runtime} ${resolved.model} / ${resolved.effort}`;
    }

    const resolved = resolveAnthropicRole(roleId, model, effort);
    return `Active runtime: ${PROVIDER_LABELS.anthropic.runtime} ${resolved.model} / ${resolved.effort}`;
  }

  function updateOpenAiRoleConfig(
    roleId: string,
    patch: Partial<OpenAiRoleAlignment>
  ) {
    setOpenaiRoleConfig((prev) => ({
      ...prev,
      [roleId]: {
        effort: prev[roleId]?.effort || "medium",
        model: prev[roleId]?.model || "",
        ...patch,
      },
    }));
  }

  function updateAnthropicRoleConfig(
    roleId: string,
    patch: Partial<OpenAiRoleAlignment>
  ) {
    setAnthropicRoleConfig((prev) => ({
      ...prev,
      [roleId]: {
        effort: prev[roleId]?.effort || "medium",
        model: prev[roleId]?.model || "",
        ...patch,
      },
    }));
  }

  async function saveRuntimeConfig() {
    if (!runtimeProvider) return;

    setSavingRuntimeConfig(true);
    try {
      await api.saveRuntimeProvider(
        runtimeProvider.activeProvider,
        anthropicRoleConfig,
        openaiModelMap,
        openaiRoleConfig
      );
      await loadAgentsPage();
    } finally {
      setSavingRuntimeConfig(false);
    }
  }

  async function saveProvider(provider: "anthropic" | "openai") {
    setSavingProvider(provider);
    try {
      await api.saveRuntimeProvider(
        provider,
        anthropicRoleConfig,
        openaiModelMap,
        openaiRoleConfig
      );
      await loadAgentsPage();
    } finally {
      setSavingProvider(null);
    }
  }

  async function startOpenAiDeviceAuth() {
    const authWindow = window.open("", "_blank");
    setDeviceAuthBusy("start");
    setDeviceAuthError(null);

    try {
      const nextState = await api.startOpenAiDeviceAuth();
      setOpenAiDeviceAuth(nextState || null);

      if (nextState?.verificationUrl) {
        authWindow?.location.replace(nextState.verificationUrl);
      } else {
        authWindow?.close();
      }

      if (nextState?.authDetected) {
        await loadAgentsPage();
      }
    } catch (error) {
      authWindow?.close();
      setDeviceAuthError(
        error instanceof Error ? error.message : "Failed to start ChatGPT sign-in."
      );
    } finally {
      setDeviceAuthBusy(null);
    }
  }

  async function cancelOpenAiDeviceAuth() {
    setDeviceAuthBusy("cancel");
    setDeviceAuthError(null);

    try {
      const nextState = await api.cancelOpenAiDeviceAuth();
      setOpenAiDeviceAuth(nextState || null);
      await loadAgentsPage();
    } catch (error) {
      setDeviceAuthError(
        error instanceof Error ? error.message : "Failed to cancel ChatGPT sign-in."
      );
    } finally {
      setDeviceAuthBusy(null);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Agents</h2>

      <div
        style={{
          background: "#111118",
          border: "1px solid #2a2a3a",
          borderRadius: 10,
          marginBottom: 24,
          padding: 16,
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
          Runtime Provider
        </h3>
        <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 12 }}>
          This is the single place to control which runtime the agents use and how
          OpenAI Codex overrides are aligned per role.
        </p>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            marginBottom: 12,
          }}
        >
          {(["anthropic", "openai"] as const).map((providerKey) => {
            const providerStatus = runtimeProvider?.providerStatus?.[providerKey];
            const isActive = runtimeProvider?.activeProvider === providerKey;

            return (
              <div
                key={providerKey}
                style={{
                  padding: 16,
                  background: isActive ? "#162032" : "#0d0d15",
                  border: `1px solid ${isActive ? "#3b82f6" : "#232334"}`,
                  borderRadius: 10,
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
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    {PROVIDER_LABELS[providerKey].title}
                  </span>
                  <span
                    style={{
                      color: isActive ? "#93c5fd" : "#777",
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: "uppercase",
                    }}
                  >
                    {isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 12 }}>
                  {PROVIDER_LABELS[providerKey].subtitle}
                </p>
                <div
                  style={{
                    color: "#b5b5c3",
                    display: "flex",
                    flexDirection: "column",
                    fontSize: 12,
                    gap: 4,
                    marginBottom: 12,
                  }}
                >
                  <span>
                    CLI: {providerStatus?.cli || PROVIDER_LABELS[providerKey].cli}
                    {" / "}
                    <span
                      style={{
                        color: providerStatus?.cliInstalled ? "#22c55e" : "#ef4444",
                      }}
                    >
                      {providerStatus?.cliInstalled ? "installed" : "missing"}
                    </span>
                  </span>
                  <span>
                    Login:{" "}
                    <span
                      style={{
                        color: providerStatus?.authDetected ? "#22c55e" : "#f59e0b",
                      }}
                    >
                      {providerStatus?.authDetected ? "detected" : "not detected"}
                    </span>
                  </span>
                  {providerStatus?.authPath && (
                    <span style={{ color: "#777", fontSize: 11 }}>
                      Expected auth path: {providerStatus.authPath}
                    </span>
                  )}
                </div>
                {providerKey === "openai" && (
                  <div
                    style={{
                      background: "#121826",
                      border: "1px solid #23314d",
                      borderRadius: 8,
                      marginBottom: 12,
                      padding: 12,
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
                      <span style={{ color: "#d9d9e5", fontSize: 12, fontWeight: 600 }}>
                        ChatGPT Sign-In
                      </span>
                      <span
                        style={{
                          color: OPENAI_AUTH_STATUS_COLORS[openAiAuthStatus],
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        {OPENAI_AUTH_STATUS_LABELS[openAiAuthStatus]}
                      </span>
                    </div>
                    <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 10 }}>
                      Starts OpenAI Codex device authorization on the supervisor and
                      waits for the shared ChatGPT subscription login to land.
                    </p>
                    {openAiDeviceAuth?.userCode && !openAiDeviceAuth.authDetected && (
                      <div
                        style={{
                          background: "#0d0d15",
                          border: "1px solid #23314d",
                          borderRadius: 8,
                          marginBottom: 10,
                          padding: 10,
                        }}
                      >
                        <div style={{ color: "#8b8b96", fontSize: 11, marginBottom: 4 }}>
                          One-time code
                        </div>
                        <div
                          style={{
                            color: "#f8fafc",
                            fontFamily: "ui-monospace, SFMono-Regular, monospace",
                            fontSize: 18,
                            fontWeight: 700,
                            letterSpacing: "0.08em",
                          }}
                        >
                          {openAiDeviceAuth.userCode}
                        </div>
                      </div>
                    )}
                    {openAiDeviceAuth?.verificationUrl && !openAiDeviceAuth.authDetected && (
                      <a
                        href={openAiDeviceAuth.verificationUrl}
                        rel="noreferrer"
                        style={{
                          color: "#93c5fd",
                          display: "inline-block",
                          fontSize: 12,
                          marginBottom: 10,
                          textDecoration: "none",
                        }}
                        target="_blank"
                      >
                        Open ChatGPT sign-in page
                      </a>
                    )}
                    {deviceAuthError && (
                      <p style={{ color: "#ef4444", fontSize: 11, marginBottom: 8 }}>
                        {deviceAuthError}
                      </p>
                    )}
                    {openAiDeviceAuth?.error && openAiAuthStatus === "failed" && (
                      <p style={{ color: "#ef4444", fontSize: 11, marginBottom: 8 }}>
                        {openAiDeviceAuth.error}
                      </p>
                    )}
                    {openAiAuthDetected && (
                      <p style={{ color: "#22c55e", fontSize: 11, marginBottom: 8 }}>
                        ChatGPT subscription login is present in the supervisor volume.
                      </p>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      {!openAiAuthDetected && (
                        <button
                          disabled={!providerStatus?.cliInstalled || deviceAuthBusy !== null}
                          onClick={() => void startOpenAiDeviceAuth()}
                          style={{
                            ...btnStyle,
                            background: "#2563eb",
                            flex: 1,
                            opacity:
                              !providerStatus?.cliInstalled || deviceAuthBusy !== null
                                ? 0.6
                                : 1,
                          }}
                        >
                          {deviceAuthBusy === "start" ? "Starting..." : "Connect ChatGPT"}
                        </button>
                      )}
                      {(openAiAuthStatus === "starting" ||
                        openAiAuthStatus === "waiting") && (
                        <button
                          disabled={deviceAuthBusy !== null}
                          onClick={() => void cancelOpenAiDeviceAuth()}
                          style={{
                            ...btnStyle,
                            background: "#1f2937",
                            color: "#d1d5db",
                            opacity: deviceAuthBusy !== null ? 0.6 : 1,
                          }}
                        >
                          {deviceAuthBusy === "cancel" ? "Canceling..." : "Cancel"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <button
                  disabled={savingProvider !== null && savingProvider !== providerKey}
                  onClick={() => void saveProvider(providerKey)}
                  style={{
                    ...btnStyle,
                    background: isActive ? "#1d4ed8" : "#3b82f6",
                    opacity:
                      savingProvider !== null && savingProvider !== providerKey
                        ? 0.5
                        : 1,
                    width: "100%",
                  }}
                >
                  {savingProvider === providerKey
                    ? "Saving..."
                    : isActive
                      ? "Active Provider"
                      : "Activate Provider"}
                </button>
              </div>
            );
          })}
        </div>

        <div
          style={{
            background: "#0d0d15",
            border: "1px solid #232334",
            borderRadius: 8,
            marginBottom: 16,
            padding: 14,
          }}
        >
          <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
            {runtimeProvider?.activeProvider === "openai"
              ? "OpenAI Runtime Configuration"
              : "Anthropic Runtime Configuration"}
          </h4>
          <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 12 }}>
            {runtimeProvider?.activeProvider === "openai"
              ? "These per-role settings apply when the active runtime provider is OpenAI Codex."
              : "These per-role settings apply when the active runtime provider is Claude."}
            {" "}Changes are not applied until you save them.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            {sortedRoles.map((role) => {
              const roleConfig =
                runtimeProvider?.activeProvider === "openai"
                  ? resolveOpenAiRole(role.id, role.model, role.effort)
                  : resolveAnthropicRole(role.id, role.model, role.effort);
              const modelOptions =
                runtimeProvider?.activeProvider === "openai"
                  ? MODEL_OPTIONS
                  : ANTHROPIC_MODEL_OPTIONS;

              return (
                <div
                  key={role.id}
                  style={{
                    background: "#111118",
                    border: "1px solid #232334",
                    borderRadius: 8,
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "140px 1fr 120px",
                    padding: 12,
                  }}
                >
                  <div>
                    <div style={{ color: "#f4f4fa", fontSize: 13, fontWeight: 600 }}>
                      {role.display_name}
                    </div>
                    <div style={{ color: "#777", fontSize: 11, marginTop: 4 }}>
                      {BASE_TIER_LABEL}: {formatBaseProfile(role.model)} / {role.effort}
                    </div>
                    {ROLE_NOTES[role.id] && (
                      <div style={{ color: "#8b8b96", fontSize: 11, marginTop: 6 }}>
                        {ROLE_NOTES[role.id]}
                      </div>
                    )}
                  </div>
                  <select
                    style={selectStyle}
                    value={roleConfig.model}
                    onChange={(e) =>
                      runtimeProvider?.activeProvider === "openai"
                        ? updateOpenAiRoleConfig(role.id, { model: e.target.value })
                        : updateAnthropicRoleConfig(role.id, { model: e.target.value })
                    }
                  >
                    {modelOptions.map((modelOption) => (
                      <option key={modelOption} value={modelOption}>
                        {modelOption}
                      </option>
                    ))}
                  </select>
                  <select
                    style={selectStyle}
                    value={roleConfig.effort}
                    onChange={(e) =>
                      runtimeProvider?.activeProvider === "openai"
                        ? updateOpenAiRoleConfig(role.id, { effort: e.target.value })
                        : updateAnthropicRoleConfig(role.id, { effort: e.target.value })
                    }
                  >
                    {REASONING_OPTIONS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button
              onClick={() => void saveRuntimeConfig()}
              style={{
                ...btnStyle,
                background: "#2563eb",
                opacity: savingRuntimeConfig ? 0.6 : 1,
              }}
              disabled={savingRuntimeConfig}
            >
              {savingRuntimeConfig ? "Saving..." : "Save Runtime Configuration"}
            </button>
          </div>
        </div>

        {runtimeProvider?.activeProvider === "openai" && (
          <div
            style={{
              background: "#0d0d15",
              border: "1px solid #232334",
              borderRadius: 8,
              padding: 14,
            }}
          >
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
              Base Tier Fallback Mapping
            </h4>
            <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 12 }}>
              Maps the stored base role profiles onto OpenAI models when a role does not
              have an explicit override above.
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {(["opus", "sonnet", "haiku"] as const).map((tier) => (
                <label
                  key={tier}
                  style={{
                    alignItems: "center",
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "120px 1fr",
                  }}
                >
                  <span
                    style={{
                      color: "#cfcfe0",
                      fontSize: 12,
                    }}
                  >
                    {formatBaseProfile(tier)}
                  </span>
                  <select
                    style={selectStyle}
                    value={openaiModelMap[tier] || ""}
                    onChange={(e) =>
                      setOpenaiModelMap((prev) => ({
                        ...prev,
                        [tier]: e.target.value,
                      }))
                    }
                  >
                    {MODEL_OPTIONS.map((modelOption) => (
                      <option key={modelOption} value={modelOption}>
                        {modelOption}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {runtimeProvider?.updatedAt && (
              <p style={{ color: "#777", fontSize: 11, marginTop: 10 }}>
                Last updated: {new Date(runtimeProvider.updatedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
          marginBottom: 24,
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
              <div
                style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}
              >
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
                <span>{BASE_TIER_LABEL}: {formatBaseProfile(model)} / {effort}</span>
                <span>Resolved OpenAI override: {openai.model} / {openai.effort}</span>
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

      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Roles</h3>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #2a2a3a", textAlign: "left" }}>
            <th style={thStyle}>Role</th>
            <th style={thStyle}>Base Preset</th>
            <th style={thStyle}>Resolved OpenAI</th>
            <th style={thStyle}>Active Runtime</th>
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
                  {formatBaseProfile(r.model)} / {r.effort}
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

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
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

const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  color: "#888",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = { padding: "8px 12px" };
