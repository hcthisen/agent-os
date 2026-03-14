import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { ProjectRecord, TaskRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

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
  description: "",
  display_name: "",
  repo_url: "",
  slug: "",
};

export function ProjectsPage({
  focusProjectId,
  onOpenTask,
}: {
  focusProjectId?: string | null;
  onOpenTask?: (taskId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectTasks, setProjectTasks] = useState<TaskRecord[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadProjects(selectId?: string | null) {
    const data = await api.getProjects();
    const nextProjects = data || [];
    setProjects(nextProjects);

    const nextSelectedId =
      selectId ||
      focusProjectId ||
      selectedProjectId ||
      nextProjects[0]?.id ||
      null;
    setSelectedProjectId(nextSelectedId);

    if (nextSelectedId) {
      const tasks = await api.getTasks({ limit: 100, project_id: nextSelectedId });
      setProjectTasks(tasks || []);
    } else {
      setProjectTasks([]);
    }
  }

  useEffect(() => {
    void loadProjects(focusProjectId || null);
  }, [focusProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectTasks([]);
      return;
    }

    void api
      .getTasks({ limit: 100, project_id: selectedProjectId })
      .then((data) => setProjectTasks(data || []))
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : "Failed to load project tasks.")
      );
  }, [selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function startEdit(project: ProjectRecord) {
    setEditingId(project.id);
    setForm({
      description: project.description || "",
      display_name: project.display_name || "",
      repo_url: project.repo_url || "",
      slug: project.slug || "",
    });
  }

  async function saveProject() {
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api.updateProject(editingId, form);
      } else {
        await api.createProject(form);
      }

      await loadProjects(editingId || selectedProjectId);
      startCreate();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Projects</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Project registry plus task counts and direct task drill-down.
          </p>
        </div>
        <button
          onClick={startCreate}
          style={shellStyles.button}
          type="button"
        >
          Create Project
        </button>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(280px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={shellStyles.card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Project List</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                style={{
                  background:
                    selectedProjectId === project.id ? "#162032" : "transparent",
                  border: "1px solid #253247",
                  borderRadius: 10,
                  color: "inherit",
                  cursor: "pointer",
                  padding: 12,
                  textAlign: "left",
                }}
                type="button"
              >
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#f8fafc", fontWeight: 600 }}>
                    {project.display_name}
                  </span>
                  <span style={shellStyles.muted}>{project.slug}</span>
                </div>
                <div style={{ ...shellStyles.muted, marginTop: 6 }}>
                  {project.task_count || 0} tasks  |  {project.artifact_count || 0} artifacts
                </div>
                <div style={{ ...shellStyles.muted, marginTop: 4 }}>
                  Updated {formatDateTime(project.updated_at || project.created_at)}
                </div>
              </button>
            ))}
            {projects.length === 0 && <div style={shellStyles.muted}>No projects available.</div>}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {editingId ? "Edit Project" : "Project Form"}
              </h3>
              {selectedProject && !editingId && (
                <button
                  onClick={() => startEdit(selectedProject)}
                  style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }}
                  type="button"
                >
                  Edit Selected
                </button>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={shellStyles.label}>Slug</label>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, slug: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.slug}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Display Name</label>
                <input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      display_name: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.display_name}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Repository URL</label>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, repo_url: event.target.value }))
                  }
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.repo_url}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Description</label>
                <textarea
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, width: "100%" }}
                  value={form.description}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={saving}
                  onClick={() => void saveProject()}
                  style={{ ...shellStyles.button, opacity: saving ? 0.7 : 1 }}
                  type="button"
                >
                  {saving ? "Saving..." : editingId ? "Save Changes" : "Create Project"}
                </button>
                {editingId && (
                  <button
                    onClick={startCreate}
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
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
              {selectedProject ? `${selectedProject.display_name} Tasks` : "Project Tasks"}
            </h3>
            {!selectedProject ? (
              <div style={shellStyles.muted}>Select a project to inspect its tasks.</div>
            ) : projectTasks.length === 0 ? (
              <div style={shellStyles.muted}>No tasks found for this project.</div>
            ) : (
              projectTasks.map((task) => (
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
                  type="button"
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: "#f8fafc", fontWeight: 600 }}>{task.title}</div>
                    <div style={shellStyles.muted}>
                      {task.assigned_role}  |  {formatDateTime(task.updated_at)}
                    </div>
                  </div>
                  <span style={statusChipStyle(STATE_COLORS[task.state] || "#6b7280")}>
                    {task.state}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


