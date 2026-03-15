import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, formatDurationMs } from "../lib/format";
import { subscribeAdminStream } from "../lib/stream";
import type {
  AgentRecord,
  ProjectRecord,
  TaskDetailRecord,
  TaskRecord,
} from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const TASK_PAGE_SIZE = 50;

const STATE_COLORS: Record<string, string> = {
  backlog: "#64748b",
  blocked_on_agent: "#f59e0b",
  claimed: "#a855f7",
  completed: "#10b981",
  dead_letter: "#dc2626",
  failed: "#ef4444",
  in_review: "#06b6d4",
  ready: "#3b82f6",
  running: "#22c55e",
};

const EMPTY_TASK_FORM = {
  acceptance_criteria: "",
  assigned_role: "",
  customer_id: "",
  department_id: "",
  objective: "",
  parent_task_id: "",
  priority: "normal",
  project_id: "",
  simulation_only: false,
  title: "",
};

function splitAcceptanceCriteria(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function shortTaskId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "unknown";
}

function getAgentLabel(agent: AgentRecord | null | undefined): string {
  if (!agent) {
    return "";
  }

  return agent.role_profile?.display_name || agent.name || agent.role_id;
}

export function TasksControlPage({
  focusTaskId,
  onOpenProject,
}: {
  focusTaskId?: string | null;
  onOpenProject?: (projectId: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetailRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [taskForm, setTaskForm] = useState(EMPTY_TASK_FORM);
  const [error, setError] = useState<string | null>(null);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || taskDetail?.task || null,
    [selectedTaskId, taskDetail, tasks]
  );
  const agentMap = useMemo(
    () => new Map(agents.map((agent) => [agent.role_id, agent])),
    [agents]
  );

  function formatAssignedAgent(roleId: string | null | undefined): string {
    if (!roleId) {
      return "Unassigned";
    }

    return getAgentLabel(agentMap.get(roleId)) || roleId;
  }

  function mergeTasks(nextTasks: TaskRecord[], existingTasks: TaskRecord[]): TaskRecord[] {
    const merged = new Map<string, TaskRecord>();
    for (const task of nextTasks) {
      merged.set(task.id, task);
    }
    for (const task of existingTasks) {
      if (!merged.has(task.id)) {
        merged.set(task.id, task);
      }
    }
    return [...merged.values()];
  }

  async function loadTasks(options?: { append?: boolean }) {
    const before =
      options?.append && tasks.length > 0 ? tasks[tasks.length - 1].created_at : undefined;
    const data = await api.getTasks({
      before,
      limit: TASK_PAGE_SIZE,
      project_id: projectFilter === "all" ? undefined : projectFilter,
      q: query.trim() || undefined,
      state: filter === "all" ? undefined : filter,
    });
    const nextTasks = data || [];

    if (options?.append) {
      setTasks((current) => [...current, ...nextTasks]);
    } else {
      setTasks((current) => mergeTasks(nextTasks, current));
    }

    setHasMore(nextTasks.length === TASK_PAGE_SIZE);
  }

  async function loadMetadata() {
    const [agentsData, projectsData] = await Promise.all([
      api.getAgents(),
      api.getProjects(),
    ]);
    setAgents(agentsData || []);
    setProjects(projectsData || []);
    setTaskForm((current) => ({
      ...current,
      assigned_role: current.assigned_role || agentsData?.[0]?.role_id || "",
    }));
  }

  async function selectTask(taskId: string | null) {
    setSelectedTaskId(taskId);
    if (!taskId) {
      setTaskDetail(null);
      return;
    }

    setDetailLoading(true);
    try {
      const detail = await api.getTaskDetail(taskId);
      setTaskDetail(detail || null);
      if (detail?.task) {
        setTaskForm({
          acceptance_criteria: (detail.task.acceptance_criteria || []).join("\n"),
          assigned_role: detail.task.assigned_role || "",
          customer_id: detail.task.customer_id || "",
          department_id: detail.task.department_id || "",
          objective: detail.task.objective || "",
          parent_task_id: detail.task.parent_task_id || "",
          priority: detail.task.priority || "normal",
          project_id: detail.task.project_id || "",
          simulation_only: detail.task.simulation_only === true,
          title: detail.task.title || "",
        });
      }
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load task detail.");
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) {
        return;
      }

      try {
        await Promise.all([loadTasks(), loadMetadata()]);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load tasks.");
        }
      }
    };

    void refresh();

    return () => {
      cancelled = true;
    };
  }, [filter, projectFilter, query]);

  useEffect(() => {
    return subscribeAdminStream((snapshot) => {
      if (filter === "all" && projectFilter === "all" && !query.trim()) {
        setTasks((current) => mergeTasks(snapshot.tasks || [], current));
      } else {
        void loadTasks().catch((nextError) => {
          setError(nextError instanceof Error ? nextError.message : "Failed to refresh tasks.");
        });
      }

      if (!selectedTaskId) {
        return;
      }

      const streamedTask = (snapshot.tasks || []).find(
        (task) => task.id === selectedTaskId
      );
      const hasLiveActivity = (snapshot.live_activity || []).some(
        (entry) => entry.task_id === selectedTaskId
      );

      if (
        (streamedTask &&
          streamedTask.updated_at !== taskDetail?.task?.updated_at) ||
        hasLiveActivity
      ) {
        void selectTask(selectedTaskId);
      }
    });
  }, [filter, projectFilter, query, selectedTaskId, taskDetail?.task?.updated_at]);

  useEffect(() => {
    if (focusTaskId) {
      void selectTask(focusTaskId);
    }
  }, [focusTaskId]);

  async function retryDeadLetter(taskId: string) {
    await api.retryTask(taskId);
    await loadTasks();
    await selectTask(taskId);
  }

  async function loadMoreTasks() {
    setLoadingMore(true);
    try {
      await loadTasks({ append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  async function saveTask() {
    setSavingTask(true);
    try {
      const payload = {
        acceptance_criteria: splitAcceptanceCriteria(taskForm.acceptance_criteria),
        assigned_role: taskForm.assigned_role,
        customer_id: taskForm.customer_id || null,
        department_id: taskForm.department_id || null,
        objective: taskForm.objective,
        parent_task_id: taskForm.parent_task_id || null,
        priority: taskForm.priority,
        project_id: taskForm.project_id || null,
        simulation_only: taskForm.simulation_only,
        title: taskForm.title,
      };

      if (showCreateForm || !selectedTaskId) {
        const created = await api.createTask(payload);
        setShowCreateForm(false);
        setTaskForm(EMPTY_TASK_FORM);
        await Promise.all([loadTasks()]);
        if (created?.id) {
          await selectTask(created.id);
        }
      } else if (selectedTaskId) {
        await api.updateTask(selectedTaskId, payload);
        await Promise.all([loadTasks(), selectTask(selectedTaskId)]);
      }
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save task.");
    } finally {
      setSavingTask(false);
    }
  }

  function beginCreate() {
    setShowCreateForm(true);
    setSelectedTaskId(null);
    setTaskDetail(null);
    setTaskForm({
      ...EMPTY_TASK_FORM,
      assigned_role: agents[0]?.role_id || "",
    });
  }

  const filtered = filter === "all" ? tasks : tasks.filter((task) => task.state === filter);

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Tasks</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Tasks are the primary execution unit. Chat is the normal path; use manual task creation here for override, debugging, or direct control-plane intervention.
          </p>
        </div>
        <button onClick={beginCreate} style={shellStyles.button} type="button">
          Manual Task Override
        </button>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 220px 180px auto", marginBottom: 16 }}>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search task title or objective..."
          style={{ ...shellStyles.input, width: "100%" }}
          value={query}
        />
        <select
          onChange={(event) => setProjectFilter(event.target.value)}
          style={{ ...shellStyles.input, width: "100%" }}
          value={projectFilter}
        >
          <option value="all">All initiatives</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.display_name}
            </option>
          ))}
        </select>
        <select
          onChange={(event) => setFilter(event.target.value)}
          style={{ ...shellStyles.input, width: "100%" }}
          value={filter}
        >
          <option value="all">All states</option>
          <option value="ready">ready</option>
          <option value="claimed">claimed</option>
          <option value="running">running</option>
          <option value="blocked_on_agent">blocked_on_agent</option>
          <option value="in_review">in_review</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="dead_letter">dead_letter</option>
        </select>
        <button
          onClick={() => {
            setQuery("");
            setProjectFilter("all");
            setFilter("all");
          }}
          style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
          type="button"
        >
          Reset
        </button>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={shellStyles.card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Queue</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((task) => (
              <button
                key={task.id}
                onClick={() => void selectTask(task.id)}
                style={{
                  background: selectedTaskId === task.id ? "#162032" : "transparent",
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
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: "#f8fafc", fontSize: 14, fontWeight: 600 }}>
                      {task.title}
                    </div>
                    <div style={shellStyles.muted}>
                      {formatAssignedAgent(task.assigned_role)}
                      {task.simulation_only ? " • simulation" : ""}
                      {task.project?.display_name ? ` • ${task.project.display_name}` : ""}
                      {task.customer_id ? ` • customer:${task.customer_id}` : ""}
                      {task.department_id ? ` • department:${task.department_id}` : ""}
                    </div>
                  </div>
                  <span style={statusChipStyle(STATE_COLORS[task.state] || "#6b7280")}>
                    {task.state}
                  </span>
                </div>
                <div style={shellStyles.muted}>
                  Updated {formatDateTime(task.updated_at)}
                  {task.last_activity_summary ? ` • ${task.last_activity_summary}` : ""}
                </div>
              </button>
            ))}
            {filtered.length === 0 && <div style={shellStyles.muted}>No tasks found.</div>}
          </div>
          {hasMore && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
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

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {showCreateForm || !selectedTask ? "Create Task" : "Task Editor"}
              </h3>
              {selectedTask && !showCreateForm && (
                <div style={{ display: "flex", gap: 8 }}>
                  {selectedTask.state === "dead_letter" && (
                    <button
                      onClick={() => void retryDeadLetter(selectedTask.id)}
                      style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }}
                      type="button"
                    >
                      Retry Dead Letter
                    </button>
                  )}
                  {selectedTask.project_id && (
                    <button
                      onClick={() => onOpenProject?.(selectedTask.project_id!)}
                      style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
                      type="button"
                    >
                      Open Initiative
                    </button>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={shellStyles.label}>Title</label>
                <input
                  onChange={(event) =>
                    setTaskForm((current) => ({ ...current, title: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={taskForm.title}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Objective</label>
                <textarea
                  onChange={(event) =>
                    setTaskForm((current) => ({
                      ...current,
                      objective: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, width: "100%" }}
                  value={taskForm.objective}
                />
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 160px 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Assigned Agent</label>
                  <select
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        assigned_role: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={taskForm.assigned_role}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.role_id}>
                        {getAgentLabel(agent)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Priority</label>
                  <select
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        priority: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={taskForm.priority}
                  >
                    <option value="low">low</option>
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Initiative</label>
                  <select
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        project_id: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={taskForm.project_id}
                  >
                    <option value="">No initiative</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Customer Scope</label>
                  <input
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        customer_id: event.target.value,
                      }))
                    }
                    placeholder="Optional customer id"
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={taskForm.customer_id}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Department Scope</label>
                  <input
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        department_id: event.target.value,
                      }))
                    }
                    placeholder="Optional department id"
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={taskForm.department_id}
                  />
                </div>
              </div>
              <label style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <input
                  checked={taskForm.simulation_only}
                  onChange={(event) =>
                    setTaskForm((current) => ({
                      ...current,
                      simulation_only: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                <span style={shellStyles.muted}>
                  Simulation-only task. Execution may read context but must not create durable runtime or external mutations.
                </span>
              </label>
              <div>
                <label style={shellStyles.label}>Acceptance Criteria (one per line)</label>
                <textarea
                  onChange={(event) =>
                    setTaskForm((current) => ({
                      ...current,
                      acceptance_criteria: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, minHeight: 120, width: "100%" }}
                  value={taskForm.acceptance_criteria}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={savingTask}
                  onClick={() => void saveTask()}
                  style={{ ...shellStyles.button, opacity: savingTask ? 0.7 : 1 }}
                  type="button"
                >
                  {savingTask
                    ? "Saving..."
                    : showCreateForm || !selectedTask
                      ? "Create Task"
                      : "Save Task"}
                </button>
                {showCreateForm && (
                  <button
                    onClick={() => {
                      setShowCreateForm(false);
                      setTaskForm(EMPTY_TASK_FORM);
                    }}
                    style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
                    type="button"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>

          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Task Detail</h3>
            {detailLoading ? (
              <div style={shellStyles.muted}>Loading task detail...</div>
            ) : !taskDetail ? (
              <div style={shellStyles.muted}>Select a task to inspect it.</div>
            ) : (
              <div style={{ display: "grid", gap: 16 }}>
                <div>
                  <div style={{ alignItems: "center", display: "flex", gap: 10, marginBottom: 8 }}>
                    <span style={statusChipStyle(STATE_COLORS[taskDetail.task.state] || "#6b7280")}>
                      {taskDetail.task.state}
                    </span>
                    {taskDetail.task.simulation_only && (
                      <span style={statusChipStyle("#f59e0b")}>simulation</span>
                    )}
                    <span style={shellStyles.muted}>
                      {taskDetail.task.priority} • {formatAssignedAgent(taskDetail.task.assigned_role)}
                    </span>
                  </div>
                  <div style={{ color: "#f8fafc", fontSize: 18, fontWeight: 700 }}>
                    {taskDetail.task.title}
                  </div>
                  <div style={{ ...shellStyles.muted, marginTop: 6 }}>
                    ID {taskDetail.task.id}
                    {taskDetail.task.simulation_only ? " â€¢ simulation-only" : ""}
                    {taskDetail.project ? ` • ${taskDetail.project.display_name}` : ""}
                    {taskDetail.task.customer_id
                      ? ` • customer:${taskDetail.task.customer_id}`
                      : ""}
                    {taskDetail.task.department_id
                      ? ` • department:${taskDetail.task.department_id}`
                      : ""}
                  </div>
                </div>

                <div>
                  <strong>Objective</strong>
                  <div style={{ color: "#d1d5db", lineHeight: 1.6, marginTop: 6 }}>
                    {taskDetail.task.objective || "No objective recorded."}
                  </div>
                </div>

                <div>
                  <strong>Acceptance Criteria</strong>
                  {taskDetail.task.acceptance_criteria?.length ? (
                    <ul style={{ marginBottom: 0, marginTop: 8, paddingLeft: 18 }}>
                      {taskDetail.task.acceptance_criteria.map((criterion) => (
                        <li key={`${taskDetail.task.id}-${criterion}`}>{criterion}</li>
                      ))}
                    </ul>
                  ) : (
                    <div style={{ ...shellStyles.muted, marginTop: 6 }}>No acceptance criteria.</div>
                  )}
                </div>

                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                  <div style={shellStyles.card}>
                    <strong>Run History</strong>
                    {taskDetail.task_runs.length === 0 ? (
                      <div style={{ ...shellStyles.muted, marginTop: 8 }}>No runs yet.</div>
                    ) : (
                      taskDetail.task_runs.map((run) => (
                        <div key={run.id} style={{ borderBottom: "1px solid #1f2937", marginTop: 8, paddingBottom: 8 }}>
                          <div style={{ color: "#f8fafc", fontWeight: 600 }}>
                            {run.agent_name || run.agent_id}
                          </div>
                          <div style={shellStyles.muted}>
                            {run.status} • {run.model_used} / {run.effort_used}
                          </div>
                          <div style={shellStyles.muted}>
                            {formatDateTime(run.started_at)} • {formatDurationMs(run.duration_ms)}
                          </div>
                          {run.error_message && (
                            <div style={{ color: "#fca5a5", marginTop: 4 }}>{run.error_message}</div>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  <div style={shellStyles.card}>
                    <strong>Related Events</strong>
                    {taskDetail.related_events.length === 0 ? (
                      <div style={{ ...shellStyles.muted, marginTop: 8 }}>No task-scoped events.</div>
                    ) : (
                      taskDetail.related_events.slice(0, 10).map((event) => (
                        <div key={event.id} style={{ borderBottom: "1px solid #1f2937", marginTop: 8, paddingBottom: 8 }}>
                          <div style={{ color: "#f8fafc", fontWeight: 600 }}>{event.event_type}</div>
                          <div style={shellStyles.muted}>{event.summary}</div>
                          <div style={shellStyles.muted}>{formatDateTime(event.created_at)}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                  <div style={shellStyles.card}>
                    <strong>Related Memories</strong>
                    {taskDetail.related_memories.length === 0 ? (
                      <div style={{ ...shellStyles.muted, marginTop: 8 }}>No related memories.</div>
                    ) : (
                      taskDetail.related_memories.slice(0, 10).map((memory) => (
                        <div key={memory.id} style={{ borderBottom: "1px solid #1f2937", marginTop: 8, paddingBottom: 8 }}>
                          <div style={{ color: "#f8fafc", fontWeight: 600 }}>{memory.subject}</div>
                          <div style={shellStyles.muted}>{memory.layer}</div>
                          <div style={{ color: "#d1d5db", marginTop: 4 }}>{memory.content}</div>
                        </div>
                      ))
                    )}
                  </div>

                  <div style={shellStyles.card}>
                    <strong>Artifacts</strong>
                    {taskDetail.artifacts.length === 0 ? (
                      <div style={{ ...shellStyles.muted, marginTop: 8 }}>No artifacts recorded.</div>
                    ) : (
                      taskDetail.artifacts.map((artifact) => (
                        <div key={artifact.id} style={{ borderBottom: "1px solid #1f2937", marginTop: 8, paddingBottom: 8 }}>
                          <div style={{ color: "#f8fafc", fontWeight: 600 }}>{artifact.name}</div>
                          <div style={shellStyles.muted}>
                            {artifact.artifact_type}
                            {artifact.mime_type ? ` • ${artifact.mime_type}` : ""}
                          </div>
                          {artifact.external_url && (
                            <a href={artifact.external_url} rel="noreferrer" style={{ color: "#93c5fd" }} target="_blank">
                              Open artifact
                            </a>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div style={shellStyles.card}>
                  <strong>Hierarchy</strong>
                  <div style={{ ...shellStyles.muted, marginTop: 8 }}>
                    Parent: {taskDetail.parent_task ? taskDetail.parent_task.title : "—"}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    {taskDetail.child_tasks.length === 0 ? (
                      <div style={shellStyles.muted}>No child tasks.</div>
                    ) : (
                      taskDetail.child_tasks.map((child) => (
                        <button
                          key={child.id}
                          onClick={() => void selectTask(child.id)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "inherit",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            padding: "8px 0",
                            textAlign: "left",
                            width: "100%",
                          }}
                          type="button"
                        >
                          <span>{child.title}</span>
                          <span style={statusChipStyle(STATE_COLORS[child.state] || "#6b7280")}>
                            {child.state}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <div style={shellStyles.card}>
                  <strong>Task Graph</strong>
                  <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                    {taskDetail.parent_task && (
                      <button
                        onClick={() => void selectTask(taskDetail.parent_task!.id)}
                        style={graphNodeStyle}
                        type="button"
                      >
                        <div style={graphLabelStyle}>Parent</div>
                        <div style={graphTitleStyle}>{taskDetail.parent_task.title}</div>
                        <div style={shellStyles.muted}>
                          {shortTaskId(taskDetail.parent_task.id)} | {formatAssignedAgent(taskDetail.parent_task.assigned_role)}
                        </div>
                      </button>
                    )}

                    <div
                      style={{
                        ...graphNodeStyle,
                        borderColor: "#3b82f6",
                        cursor: "default",
                      }}
                    >
                      <div style={graphLabelStyle}>Current</div>
                      <div style={graphTitleStyle}>{taskDetail.task.title}</div>
                      <div style={shellStyles.muted}>
                        {shortTaskId(taskDetail.task.id)} | {formatAssignedAgent(taskDetail.task.assigned_role)}
                      </div>
                    </div>

                    {taskDetail.task.depends_on && taskDetail.task.depends_on.length > 0 && (
                      <div style={graphNodeStyle}>
                        <div style={graphLabelStyle}>Depends On</div>
                        <div style={{ ...shellStyles.muted, lineHeight: 1.7 }}>
                          {taskDetail.task.depends_on.map((dependencyId) => (
                            <div key={dependencyId}>{shortTaskId(dependencyId)}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {taskDetail.child_tasks.length > 0 && (
                      <div style={graphNodeStyle}>
                        <div style={graphLabelStyle}>Children</div>
                        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                          {taskDetail.child_tasks.map((child) => (
                            <button
                              key={child.id}
                              onClick={() => void selectTask(child.id)}
                              style={{
                                ...graphNodeStyle,
                                background: "#090b11",
                              }}
                              type="button"
                            >
                              <div style={graphTitleStyle}>{child.title}</div>
                              <div style={shellStyles.muted}>
                                {shortTaskId(child.id)} | {formatAssignedAgent(child.assigned_role)} | {child.state}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const graphNodeStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #253247",
  borderRadius: 10,
  color: "inherit",
  cursor: "pointer",
  padding: 12,
  textAlign: "left",
};

const graphLabelStyle: React.CSSProperties = {
  color: "#60a5fa",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  marginBottom: 6,
  textTransform: "uppercase",
};

const graphTitleStyle: React.CSSProperties = {
  color: "#f8fafc",
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 4,
};
