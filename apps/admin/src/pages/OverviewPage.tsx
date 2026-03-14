import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, formatDurationMs } from "../lib/format";
import type { AgentRecord, ProjectRecord, TaskRecord, UsageSummaryRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const STATE_COLORS: Record<string, string> = {
  blocked_on_agent: "#f59e0b",
  claimed: "#a855f7",
  completed: "#10b981",
  dead_letter: "#dc2626",
  failed: "#ef4444",
  in_review: "#06b6d4",
  ready: "#3b82f6",
  running: "#22c55e",
};

function WindowCard({
  getAgentName,
  title,
  window,
}: {
  getAgentName: (roleId: string) => string;
  title: string;
  window: UsageSummaryRecord["task_runs"]["today"];
}) {
  return (
    <div style={shellStyles.card}>
      <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{title}</h3>
        <span style={{ color: "#bfdbfe", fontSize: 20, fontWeight: 700 }}>
          {window.run_count}
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ ...shellStyles.muted, marginBottom: 8 }}>Runs per agent</div>
        {window.runs_per_role.length === 0 ? (
          <div style={shellStyles.muted}>No task runs in this window.</div>
        ) : (
          window.runs_per_role.map((entry) => (
            <div
              key={`${title}-${entry.role_id}`}
              style={{
                alignItems: "center",
                display: "grid",
                gap: 12,
                gridTemplateColumns: "110px 1fr auto",
                marginBottom: 6,
              }}
            >
              <span style={{ color: "#e5e7eb", fontSize: 12 }}>{getAgentName(entry.role_id)}</span>
              <div
                style={{
                  background: "#172033",
                  borderRadius: 999,
                  height: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    background: "#3b82f6",
                    height: "100%",
                    width: `${Math.max(12, Math.min(100, entry.run_count * 18))}%`,
                  }}
                />
              </div>
              <span style={{ ...shellStyles.muted, whiteSpace: "nowrap" }}>
                {entry.run_count} / {formatDurationMs(entry.average_duration_ms)}
              </span>
            </div>
          ))
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ ...shellStyles.muted, marginBottom: 8 }}>Model distribution</div>
        {window.model_distribution.length === 0 ? (
          <div style={shellStyles.muted}>No model usage recorded.</div>
        ) : (
          window.model_distribution.map((entry) => (
            <div
              key={`${title}-${entry.model}`}
              style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
            >
              <span style={{ color: "#dbeafe", fontSize: 12 }}>{entry.model}</span>
              <span style={shellStyles.muted}>{entry.count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatUsd(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: value < 10 ? 3 : 2,
    minimumFractionDigits: value < 10 ? 3 : 2,
    style: "currency",
  }).format(value);
}

export function OverviewPage({
  onOpenProject,
  onOpenTask,
}: {
  onOpenProject?: (projectId: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const [usage, setUsage] = useState<UsageSummaryRecord | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  function getAgentName(roleId: string): string {
    const agent = agents.find((entry) => entry.role_id === roleId);
    return agent?.role_profile?.display_name || agent?.name || roleId;
  }

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [usageSummary, recentTasks, projectList, agentsData] = await Promise.all([
          api.getUsageSummary(),
          api.getTasks({ limit: 8 }),
          api.getProjects(),
          api.getAgents(),
        ]);

        if (cancelled) {
          return;
        }

        setUsage(usageSummary || null);
        setTasks(recentTasks || []);
        setProjects((projectList || []).slice(0, 6));
        setAgents(agentsData || []);
        setError(null);
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error ? nextError.message : "Failed to load overview."
          );
        }
      }
    };

    void load();
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Overview</h2>
        <p style={{ ...shellStyles.muted, margin: 0 }}>
          Usage, recent work, projects, and artifacts from the admin control plane.
        </p>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}

      {usage && (
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            marginBottom: 18,
          }}
        >
          <WindowCard getAgentName={getAgentName} title="Today" window={usage.task_runs.today} />
          <WindowCard getAgentName={getAgentName} title="This Week" window={usage.task_runs.week} />
          <WindowCard getAgentName={getAgentName} title="This Month" window={usage.task_runs.month} />
        </div>
      )}

      {usage && (
        <div style={{ ...shellStyles.card, marginBottom: 18 }}>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Provider Usage</h3>
            <span style={shellStyles.muted}>
              {usage.provider_usage.event_count} usage events
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              marginBottom: 12,
            }}
          >
            <div>
              <div style={shellStyles.muted}>Total Tokens</div>
              <div style={{ color: "#f8fafc", fontSize: 22, fontWeight: 700 }}>
                {usage.provider_usage.total_tokens.toLocaleString()}
              </div>
            </div>
            <div>
              <div style={shellStyles.muted}>Estimated Cost</div>
              <div style={{ color: "#f8fafc", fontSize: 22, fontWeight: 700 }}>
                {formatUsd(usage.provider_usage.estimated_cost_usd)}
              </div>
            </div>
          </div>
          {usage.provider_usage.providers.length === 0 ? (
            <div style={shellStyles.muted}>No provider usage events recorded yet.</div>
          ) : (
            usage.provider_usage.providers.map((provider) => (
              <div
                key={provider.provider}
                style={{
                  borderTop: "1px solid #1f2937",
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "minmax(120px, 0.8fr) 1fr auto auto",
                  padding: "10px 0",
                }}
              >
                <div style={{ color: "#dbeafe", fontWeight: 600 }}>{provider.provider}</div>
                <div style={shellStyles.muted}>{provider.event_count} events</div>
                <div style={shellStyles.muted}>
                  {provider.total_tokens.toLocaleString()} tokens
                </div>
                <div style={{ color: "#bfdbfe" }}>{formatUsd(provider.estimated_cost_usd)}</div>
              </div>
            ))
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 0.8fr)",
        }}
      >
        <div style={shellStyles.card}>
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Recent Tasks</h3>
          </div>
          {tasks.length === 0 ? (
            <div style={shellStyles.muted}>No recent tasks.</div>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => onOpenTask?.(task.id)}
                style={{
                  alignItems: "center",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid #1f2937",
                  color: "inherit",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "10px 0",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#f8fafc", fontSize: 14, fontWeight: 600 }}>
                    {task.title}
                  </div>
                  <div style={shellStyles.muted}>
                    {getAgentName(task.assigned_role)}  |  {formatDateTime(task.updated_at)}
                  </div>
                </div>
                <span style={statusChipStyle(STATE_COLORS[task.state] || "#6b7280")}>
                  {task.state}
                </span>
              </button>
            ))
          )}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Projects</h3>
            {projects.length === 0 ? (
              <div style={shellStyles.muted}>No projects yet.</div>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => onOpenProject?.(project.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid #1f2937",
                    color: "inherit",
                    cursor: "pointer",
                    display: "block",
                    padding: "10px 0",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  <div style={{ color: "#f8fafc", fontSize: 14, fontWeight: 600 }}>
                    {project.display_name}
                  </div>
                  <div style={shellStyles.muted}>
                    {project.task_count || 0} tasks  |  {project.artifact_count || 0} artifacts
                  </div>
                </button>
              ))
            )}
          </div>

          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Artifacts</h3>
            {!usage || usage.recent_artifacts.length === 0 ? (
              <div style={shellStyles.muted}>No recent artifacts.</div>
            ) : (
              usage.recent_artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  style={{ borderBottom: "1px solid #1f2937", padding: "10px 0" }}
                >
                  <div style={{ color: "#f8fafc", fontSize: 14, fontWeight: 600 }}>
                    {artifact.name}
                  </div>
                  <div style={shellStyles.muted}>
                    {artifact.artifact_type}
                    {artifact.task_title ? `  |  ${artifact.task_title}` : ""}
                  </div>
                  <div style={shellStyles.muted}>{formatDateTime(artifact.created_at)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


