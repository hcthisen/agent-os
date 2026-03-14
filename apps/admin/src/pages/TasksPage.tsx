import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, formatDurationMs } from "../lib/format";
import type { ApprovalRecord, ProjectRecord, RoleRecord, TaskDetailRecord, TaskRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const TASK_PAGE_SIZE = 50;
const STATE_COLORS: Record<string, string> = {
  blocked_on_agent: "#f59e0b",
  blocked_on_human: "#f59e0b",
  claimed: "#a855f7",
  completed: "#10b981",
  dead_letter: "#dc2626",
  failed: "#ef4444",
  in_review: "#06b6d4",
  ready: "#3b82f6",
  running: "#22c55e",
};

const EMPTY_FORM = {
  acceptance_criteria: "",
  assigned_role: "",
  objective: "",
  priority: "normal",
  project_id: "",
  title: "",
};

export function TasksPage({
  focusTaskId,
  onOpenProject,
}: {
  focusTaskId?: string | null;
  onOpenProject?: (projectId: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [detail, setDetail] = useState<TaskDetailRecord | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(focusTaskId || null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadTasks(options?: { append?: boolean }) {
    const before =
      options?.append && tasks.length > 0 ? tasks[tasks.length - 1].created_at : undefined;
    const data = await api.getTasks({
      before,
      limit: TASK_PAGE_SIZE,
      project_id: projectFilter || undefined,
      q: search.trim() || undefined,
      state: filter === "all" ? undefined : filter,
    });
    const nextTasks = data || [];
    setTasks((current) => (options?.append ? [...current, ...nextTasks] : nextTasks));
    setHasMore(nextTasks.length === TASK_PAGE_SIZE);
  }

  async function refresh() {
    const [tasksData, approvalsData, rolesData, projectsData] = await Promise.all([
      api.getTasks({
        limit: TASK_PAGE_SIZE,
        project_id: projectFilter || undefined,
        q: search.trim() || undefined,
        state: filter === "all" ? undefined : filter,
      }),
      api.getApprovals(),
      api.getRoles(),
      api.getProjects(),
    ]);
    setTasks(tasksData || []);
    setApprovals(approvalsData || []);
    setRoles(rolesData || []);
    setProjects(projectsData || []);
    setHasMore((tasksData || []).length === TASK_PAGE_SIZE);
  }

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        await refresh();
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load tasks.");
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [filter, projectFilter, search]);

  useEffect(() => {
    if (focusTaskId) {
      setSelectedTaskId(focusTaskId);
    }
  }, [focusTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDetail(null);
      return;
    }
    void api
      .getTaskDetail(selectedTaskId)
      .then((nextDetail) => setDetail(nextDetail || null))
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : "Failed to load task detail.")
      );
  }, [selectedTaskId]);

  async function handleApproval(id: string, decision: "approved" | "rejected") {
    if (decision === "approved") {
      await api.approveApproval(id);
    } else {
      await api.rejectApproval(id);
    }
    await refresh();
  }

  async function retryTask(taskId: string) {
    await api.retryTask(taskId);
    await refresh();
    setSelectedTaskId(taskId);
  }

  async function createTask() {
    setCreating(true);
    setError(null);
    try {
      const created = await api.createTask({
        acceptance_criteria: form.acceptance_criteria
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        assigned_role: form.assigned_role,
        objective: form.objective,
        priority: form.priority,
        project_id: form.project_id || null,
        title: form.title,
      });
      setForm(EMPTY_FORM);
      await refresh();
      setSelectedTaskId(created?.id || null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create task.");
    } finally {
      setCreating(false);
    }
  }

  async function loadMoreTasks() {
    setLoadingMore(true);
    try {
      await loadTasks({ append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Tasks</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Task queue, approvals, run history, artifacts, and task creation.
          </p>
        </div>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}

      {approvals.length > 0 && (
        <div style={{ ...shellStyles.card, border: "1px solid #f59e0b55", marginBottom: 16 }}>
          <h3 style={{ color: "#fbbf24", fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
            Pending Approvals ({approvals.length})
          </h3>
          {approvals.map((approval) => (
            <div
              key={approval.id}
              style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 8 }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ color: "#cbd5e1", fontSize: 12 }}>{approval.action_type}</div>
                <div style={{ color: "#e5e7eb", fontSize: 13 }}>{approval.description}</div>
              </div>
              <button
                onClick={() => void handleApproval(approval.id, "approved")}
                style={{ ...shellStyles.button, background: "#15803d" }}
                type="button"
              >
                Approve
              </button>
              <button
                onClick={() => void handleApproval(approval.id, "rejected")}
                style={{ ...shellStyles.button, background: "#b91c1c" }}
                type="button"
              >
                Reject
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(340px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Create Task</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <input
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Title"
                style={{ ...shellStyles.input, width: "100%" }}
                value={form.title}
              />
              <textarea
                onChange={(event) =>
                  setForm((current) => ({ ...current, objective: event.target.value }))
                }
                placeholder="Objective"
                style={{ ...shellStyles.textarea, width: "100%" }}
                value={form.objective}
              />
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr" }}>
                <select
                  onChange={(event) =>
                    setForm((current) => ({ ...current, assigned_role: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.assigned_role}
                >
                  <option value="">Assigned role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.display_name}
                    </option>
                  ))}
                </select>
                <select
                  onChange={(event) =>
                    setForm((current) => ({ ...current, priority: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.priority}
                >
                  {["low", "normal", "high", "critical"].map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
                <select
                  onChange={(event) =>
                    setForm((current) => ({ ...current, project_id: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.project_id}
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.display_name}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    acceptance_criteria: event.target.value,
                  }))
                }
                placeholder="Acceptance criteria, one line per item"
                style={{ ...shellStyles.textarea, minHeight: 90, width: "100%" }}
                value={form.acceptance_criteria}
              />
              <button
                disabled={creating}
                onClick={() => void createTask()}
                style={{ ...shellStyles.button, opacity: creating ? 0.7 : 1 }}
                type="button"
              >
                {creating ? "Creating..." : "Create Task"}
              </button>
            </div>
          </div>

          <div style={shellStyles.card}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search tasks..."
                style={{ ...shellStyles.input, flex: 1 }}
                value={search}
              />
              <select
                onChange={(event) => setProjectFilter(event.target.value)}
                style={{ ...shellStyles.input, minWidth: 180 }}
                value={projectFilter}
              >
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.display_name}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
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
              ].map((state) => (
                <button
                  key={state}
                  onClick={() => setFilter(state)}
                  style={{
                    ...shellStyles.button,
                    ...shellStyles.buttonGhost,
                    background: filter === state ? "#162032" : "transparent",
                    color: STATE_COLORS[state] || "#e2e8f0",
                    padding: "4px 10px",
                  }}
                  type="button"
                >
                  {state}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  style={{
                    background: selectedTaskId === task.id ? "#162032" : "#111118",
                    border: "1px solid #2a2a3a",
                    borderRadius: 10,
                    color: "inherit",
                    cursor: "pointer",
                    padding: 12,
                    textAlign: "left",
                  }}
                  type="button"
                >
                  <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ color: "#f8fafc", fontWeight: 600 }}>{task.title}</div>
                      <div style={shellStyles.muted}>
                        {task.assigned_role} | {formatDateTime(task.updated_at)}
                      </div>
                    </div>
                    <span style={statusChipStyle(STATE_COLORS[task.state] || "#6b7280")}>
                      {task.state}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {hasMore && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                <button
                  disabled={loadingMore}
                  onClick={() => void loadMoreTasks()}
                  style={{ ...shellStyles.button, opacity: loadingMore ? 0.7 : 1 }}
                  type="button"
                >
                  {loadingMore ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div style={shellStyles.card}>
          {!detail?.task ? (
            <div style={shellStyles.muted}>Select a task to inspect its detail view.</div>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              <div>
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{detail.task.title}</h3>
                  <span style={statusChipStyle(STATE_COLORS[detail.task.state] || "#6b7280")}>
                    {detail.task.state}
                  </span>
                </div>
                <div style={{ color: "#cbd5e1", whiteSpace: "pre-wrap" }}>
                  {detail.task.objective || "No objective recorded."}
                </div>
                <div style={{ ...shellStyles.muted, marginTop: 8 }}>
                  Role {detail.task.assigned_role} | Priority {detail.task.priority} | Updated {formatDateTime(detail.task.updated_at)}
                </div>
                {detail.project?.id && (
                  <button
                    onClick={() => onOpenProject?.(detail.project!.id)}
                    style={{ ...shellStyles.button, ...shellStyles.buttonGhost, marginTop: 8 }}
                    type="button"
                  >
                    Open Project {detail.project.display_name}
                  </button>
                )}
              </div>

              {detail.task.acceptance_criteria && detail.task.acceptance_criteria.length > 0 && (
                <div>
                  <div style={{ ...shellStyles.muted, marginBottom: 6 }}>Acceptance Criteria</div>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    {detail.task.acceptance_criteria.map((criterion, index) => (
                      <li key={`${detail.task.id}-${index}`} style={{ marginBottom: 4 }}>
                        {criterion}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {detail.task_runs.length > 0 && (
                <div>
                  <div style={{ ...shellStyles.muted, marginBottom: 8 }}>Run History</div>
                  {detail.task_runs.map((run) => (
                    <div key={run.id} style={{ borderTop: "1px solid #1f2937", padding: "8px 0" }}>
                      <div style={{ color: "#e5e7eb", fontSize: 13, fontWeight: 600 }}>
                        {run.agent_name || run.agent_id} | {run.model_used} / {run.effort_used}
                      </div>
                      <div style={shellStyles.muted}>
                        {run.status} | {formatDurationMs(run.duration_ms)} | {formatDateTime(run.started_at)}
                      </div>
                      {run.error_message && (
                        <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 4 }}>
                          {run.error_message}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {(detail.related_events?.length || 0) > 0 && (
                <div>
                  <div style={{ ...shellStyles.muted, marginBottom: 8 }}>Related Events</div>
                  {detail.related_events.map((event) => (
                    <div key={event.id} style={{ borderTop: "1px solid #1f2937", padding: "8px 0" }}>
                      <div style={{ color: "#e5e7eb", fontSize: 13 }}>{event.summary}</div>
                      <div style={shellStyles.muted}>
                        {event.event_type} | {formatDateTime(event.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(detail.artifacts?.length || 0) > 0 && (
                <div>
                  <div style={{ ...shellStyles.muted, marginBottom: 8 }}>Artifacts</div>
                  {detail.artifacts.map((artifact) => (
                    <div key={artifact.id} style={{ borderTop: "1px solid #1f2937", padding: "8px 0" }}>
                      <div style={{ color: "#e5e7eb", fontSize: 13 }}>{artifact.name}</div>
                      <div style={shellStyles.muted}>
                        {artifact.artifact_type} | {artifact.external_url || artifact.storage_path || "stored locally"}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(detail.child_tasks?.length || 0) > 0 && (
                <div>
                  <div style={{ ...shellStyles.muted, marginBottom: 8 }}>Child Tasks</div>
                  {detail.child_tasks.map((child) => (
                    <button
                      key={child.id}
                      onClick={() => setSelectedTaskId(child.id)}
                      style={{ ...shellStyles.button, ...shellStyles.buttonGhost, display: "block", marginBottom: 8, textAlign: "left", width: "100%" }}
                      type="button"
                    >
                      {child.title} | {child.state}
                    </button>
                  ))}
                </div>
              )}

              {detail.task.state === "dead_letter" && (
                <button
                  onClick={() => void retryTask(detail.task.id)}
                  style={shellStyles.button}
                  type="button"
                >
                  Retry Dead-Letter Task
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
