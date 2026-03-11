import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

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

interface Role {
  id: string;
  display_name: string;
  model: string;
  effort: string;
}

const PROVIDER_DESCRIPTIONS: Record<"anthropic" | "openai", string> = {
  anthropic:
    "Use the Claude CLI with a persisted Anthropic subscription login in the supervisor home volume.",
  openai:
    "Use the Codex CLI with a persisted ChatGPT subscription login in the supervisor home volume.",
};

const MODEL_OPTIONS = [
  "gpt-5.4",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
];

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
  relay: "Speed-critical router. Low reasoning keeps it fast.",
  sage: "Deep planning role. xHigh is reserved here.",
  sentinel: "Suggested default: gpt-5.3-codex / medium to keep recurring watchdog cost down.",
};
const OPENAI_AUTH_STATUS_LABELS: Record<OpenAiDeviceAuthResponse["status"], string> = {
  canceled: "Canceled",
  complete: "Connected",
  failed: "Failed",
  idle: "Idle",
  starting: "Starting",
  waiting: "Waiting for approval",
};
const OPENAI_AUTH_STATUS_COLORS: Record<OpenAiDeviceAuthResponse["status"], string> = {
  canceled: "#8b8b96",
  complete: "#22c55e",
  failed: "#ef4444",
  idle: "#8b8b96",
  starting: "#93c5fd",
  waiting: "#f59e0b",
};

export function SettingsPage() {
  const [runtimeProvider, setRuntimeProvider] =
    useState<RuntimeProviderResponse | null>(null);
  const [openAiDeviceAuth, setOpenAiDeviceAuth] =
    useState<OpenAiDeviceAuthResponse | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleInputs, setScheduleInputs] = useState<Record<string, string>>({});
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [openaiModelMap, setOpenaiModelMap] = useState<Record<string, string>>({});
  const [openaiRoleConfig, setOpenaiRoleConfig] = useState<
    Record<string, OpenAiRoleAlignment>
  >({});
  const [savingProvider, setSavingProvider] = useState<"anthropic" | "openai" | null>(
    null
  );
  const [deviceAuthBusy, setDeviceAuthBusy] = useState<"cancel" | "start" | null>(
    null
  );
  const [deviceAuthError, setDeviceAuthError] = useState<string | null>(null);

  async function loadSettings() {
    const [
      runtimeProviderData,
      openAiDeviceAuthData,
      rolesData,
      servicesData,
      schedulesData,
    ] =
      await Promise.all([
        api.getRuntimeProvider(),
        api.getOpenAiDeviceAuth(),
        api.getRoles(),
        api.getServices(),
        api.getSchedules(),
      ]);

    setRuntimeProvider(runtimeProviderData || null);
    setOpenAiDeviceAuth(openAiDeviceAuthData || null);
    setOpenaiModelMap(runtimeProviderData?.openaiModelMap || {});
    setOpenaiRoleConfig(runtimeProviderData?.openaiRoleConfig || {});
    setRoles(rolesData || []);
    setServices(servicesData || []);
    setSchedules(schedulesData || []);
    setScheduleInputs(
      Object.fromEntries(
        (schedulesData || []).map((schedule: Schedule) => [
          schedule.id,
          schedule.cron_expr || "",
        ])
      )
    );
  }

  useEffect(() => {
    void loadSettings();
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
            await loadSettings();
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

  async function saveProvider(provider: "anthropic" | "openai") {
    setSavingProvider(provider);
    try {
      await api.saveRuntimeProvider(provider, openaiModelMap, openaiRoleConfig);
      await loadSettings();
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
        await loadSettings();
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
      await loadSettings();
    } catch (error) {
      setDeviceAuthError(
        error instanceof Error ? error.message : "Failed to cancel ChatGPT sign-in."
      );
    } finally {
      setDeviceAuthBusy(null);
    }
  }

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

  async function saveSchedule(id: string) {
    const cron_expr = (scheduleInputs[id] || "").trim();
    if (!cron_expr) return;

    await api.saveSchedule(id, { cron_expr });
    await loadSettings();
  }

  function updateRoleConfig(
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

  const statusColor: Record<string, string> = {
    active: "#22c55e",
    key_needed: "#f59e0b",
    error: "#ef4444",
    disabled: "#666",
  };
  const roleMap = Object.fromEntries(roles.map((role) => [role.id, role]));
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

  return (
    <div>
      <datalist id="codex-model-options">
        {MODEL_OPTIONS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Settings</h2>

      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
        Runtime Provider
      </h3>
      <p style={{ fontSize: 12, color: "#8b8b96", marginBottom: 12 }}>
        Only one coding provider is active at a time. The supervisor will use the
        selected CLI for all new task runs.
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
                background: isActive ? "#162032" : "#111118",
                border: `1px solid ${isActive ? "#3b82f6" : "#2a2a3a"}`,
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
                  {providerStatus?.label ||
                    (providerKey === "anthropic"
                      ? "Anthropic subscription"
                      : "ChatGPT subscription")}
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
                {PROVIDER_DESCRIPTIONS[providerKey]}
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
                  CLI: {providerStatus?.cli || (providerKey === "anthropic" ? "claude" : "codex")}
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
                    background: "#0d0d15",
                    border: "1px solid #232334",
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
                      Remote Sign-In
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
                    Starts Codex device authorization on the supervisor, opens the
                    official OpenAI sign-in page, and waits for the persisted login
                    to land in the shared provider volume.
                  </p>
                  {openAiDeviceAuth?.userCode && !openAiDeviceAuth.authDetected && (
                    <div
                      style={{
                        background: "#121826",
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
                      {openAiDeviceAuth.expiresAt && (
                        <div style={{ color: "#8b8b96", fontSize: 11, marginTop: 6 }}>
                          Expires:{" "}
                          {new Date(openAiDeviceAuth.expiresAt).toLocaleTimeString()}
                        </div>
                      )}
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
                      Open OpenAI sign-in page
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
                    <button
                      disabled={
                        !providerStatus?.cliInstalled ||
                        deviceAuthBusy !== null ||
                        openAiAuthDetected
                      }
                      onClick={() => void startOpenAiDeviceAuth()}
                      style={{
                        ...btnStyle,
                        background: "#2563eb",
                        flex: 1,
                        opacity:
                          !providerStatus?.cliInstalled ||
                          deviceAuthBusy !== null ||
                          openAiAuthDetected
                            ? 0.6
                            : 1,
                      }}
                    >
                      {deviceAuthBusy === "start"
                        ? "Starting..."
                        : openAiAuthDetected
                          ? "ChatGPT Connected"
                          : "Connect ChatGPT subscription"}
                    </button>
                    {(openAiAuthStatus === "starting" || openAiAuthStatus === "waiting") && (
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
          background: "#111118",
          border: "1px solid #2a2a3a",
          borderRadius: 8,
          marginBottom: 16,
          padding: 14,
        }}
      >
        <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          ChatGPT / Codex Role Alignment
        </h4>
        <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 12 }}>
          These per-role settings override Anthropic tiers whenever ChatGPT is the
          active provider.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {sortedRoles.map((role) => {
            const roleConfig = openaiRoleConfig[role.id] || {
              effort: "medium",
              model: "",
            };

            return (
              <div
                key={role.id}
                style={{
                  background: "#0d0d15",
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
                    Anthropic: {role.model} / {role.effort}
                  </div>
                  {ROLE_NOTES[role.id] && (
                    <div style={{ color: "#8b8b96", fontSize: 11, marginTop: 6 }}>
                      {ROLE_NOTES[role.id]}
                    </div>
                  )}
                </div>
                <input
                  list="codex-model-options"
                  style={inputStyle}
                  type="text"
                  value={roleConfig.model}
                  onChange={(e) =>
                    updateRoleConfig(role.id, { model: e.target.value })
                  }
                />
                <select
                  style={selectStyle}
                  value={roleConfig.effort}
                  onChange={(e) =>
                    updateRoleConfig(role.id, { effort: e.target.value })
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
        {runtimeProvider?.updatedAt && (
          <p style={{ color: "#777", fontSize: 11, marginTop: 10 }}>
            Last updated: {new Date(runtimeProvider.updatedAt).toLocaleString()}
          </p>
        )}
      </div>

      <div
        style={{
          background: "#111118",
          border: "1px solid #2a2a3a",
          borderRadius: 8,
          marginBottom: 32,
          padding: 14,
        }}
      >
        <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          Tier Fallback Mapping
        </h4>
        <p style={{ color: "#8b8b96", fontSize: 12, marginBottom: 12 }}>
          Used only for custom roles that do not have an explicit ChatGPT / Codex
          override above.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          {(["opus", "sonnet", "haiku"] as const).map((tier) => (
            <label
              key={tier}
              style={{
                alignItems: "center",
                display: "grid",
                gap: 10,
                gridTemplateColumns: "90px 1fr",
              }}
            >
              <span style={{ color: "#cfcfe0", fontSize: 12, textTransform: "capitalize" }}>
                {tier}
              </span>
              <input
                list="codex-model-options"
                style={inputStyle}
                type="text"
                value={openaiModelMap[tier] || ""}
                onChange={(e) =>
                  setOpenaiModelMap((prev) => ({
                    ...prev,
                    [tier]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
        Service Connections
      </h3>
      {services.length === 0 && (
        <p style={{ fontSize: 13, color: "#666" }}>No services registered yet.</p>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginBottom: 32,
        }}
      >
        {services.map((s) => (
          <div
            key={s.id}
            style={{
              padding: 14,
              background: "#111118",
              border: "1px solid #2a2a3a",
              borderRadius: 8,
            }}
          >
            <div
              style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
            >
              <span style={{ fontWeight: 500, fontSize: 14 }}>{s.display_name}</span>
              <span style={{ fontSize: 11, color: statusColor[s.status] }}>
                {s.status}
              </span>
            </div>
            <p style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
              {s.description}
            </p>
            {s.status === "key_needed" && (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={inputStyle}
                  type="password"
                  placeholder="Paste API key..."
                  value={keyInput[s.id] || ""}
                  onChange={(e) =>
                    setKeyInput((prev) => ({ ...prev, [s.id]: e.target.value }))
                  }
                />
                <button onClick={() => void saveKey(s.id)} style={btnStyle}>
                  Save
                </button>
              </div>
            )}
            {s.error_message && (
              <p style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>
                {s.error_message}
              </p>
            )}
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Schedules</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {schedules.map((s) => (
          <div
            key={s.id}
            style={{
              padding: "8px 14px",
              background: "#111118",
              border: "1px solid #2a2a3a",
              borderRadius: 6,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 13,
            }}
          >
            <div>
              <span style={{ fontWeight: 500 }}>{s.name}</span>
              <span style={{ marginLeft: 12, color: "#888", fontSize: 11 }}>
                {s.assigned_role}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                style={{ ...inputStyle, width: 140, padding: "4px 8px" }}
                value={scheduleInputs[s.id] || ""}
                onChange={(e) =>
                  setScheduleInputs((prev) => ({
                    ...prev,
                    [s.id]: e.target.value,
                  }))
                }
              />
              <button onClick={() => void saveSchedule(s.id)} style={btnStyle}>
                Save
              </button>
            <button
              onClick={() => void toggleSchedule(s.id, !s.enabled)}
              style={{
                padding: "3px 10px",
                border: "1px solid #333",
                borderRadius: 4,
                background: s.enabled ? "#22c55e22" : "transparent",
                color: s.enabled ? "#22c55e" : "#666",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {s.enabled ? "Enabled" : "Disabled"}
            </button>
            </div>
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
