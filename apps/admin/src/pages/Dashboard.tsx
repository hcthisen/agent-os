import React, { useState } from "react";
import { subscribeAdminStream } from "../lib/stream";
import type { LiveActivityRecord } from "../lib/types";
import { AgentsControlPage } from "./AgentsControlPage";
import { ChatPage } from "./ChatPage";
import { EventsPage } from "./EventsPage";
import { MemoryStudioPage } from "./MemoryStudioPage";
import { OverviewPage } from "./OverviewPage";
import { ProjectsPage } from "./ProjectsPage";
import { SettingsControlPage } from "./SettingsControlPage";
import { SkillsPage } from "./SkillsPage";
import { TasksControlPage } from "./TasksControlPage";

type Page =
  | "overview"
  | "chat"
  | "tasks"
  | "projects"
  | "agents"
  | "memory"
  | "skills"
  | "events"
  | "settings";

const NAV_ITEMS: Array<{ id: Page; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tasks" },
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "events", label: "Events" },
  { id: "settings", label: "Settings" },
];

export function Dashboard({ onLogout }: { onLogout: () => Promise<void> }) {
  const [page, setPage] = useState<Page>("overview");
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = React.useState<LiveActivityRecord[]>([]);

  React.useEffect(() => {
    return subscribeAdminStream((snapshot) => {
      setLiveActivity(snapshot.live_activity || []);
    });
  }, []);

  function openTask(taskId: string) {
    setFocusedTaskId(taskId);
    setPage("tasks");
  }

  function openProject(projectId: string) {
    setFocusedProjectId(projectId);
    setPage("projects");
  }

  return (
    <div style={styles.layout}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Agent-OS</div>
          <div style={{ color: "#7c89a6", fontSize: 11, marginTop: 6 }}>
            Admin control plane
          </div>
        </div>
        <div style={styles.livePanel}>
          <div style={styles.liveTitle}>Live Activity</div>
          <div style={styles.liveSummary}>
            {liveActivity.length} active {liveActivity.length === 1 ? "task" : "tasks"}
          </div>
          {liveActivity.length === 0 ? (
            <div style={styles.liveEmpty}>No agents are running right now.</div>
          ) : (
            liveActivity.slice(0, 4).map((entry) => (
              <button
                key={entry.task_id}
                onClick={() => openTask(entry.task_id)}
                style={styles.liveItem}
                type="button"
              >
                <div style={styles.liveTaskTitle}>{entry.task_title}</div>
                <div style={styles.liveTaskMeta}>
                  {(entry.agent_name || entry.role_id) + " • " + entry.task_state}
                </div>
              </button>
            ))
          )}
        </div>
        <nav style={styles.nav}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              style={{
                ...styles.navBtn,
                ...(page === item.id ? styles.navActive : {}),
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button
          onClick={() => {
            void onLogout();
          }}
          style={styles.logout}
        >
          Sign Out
        </button>
      </aside>
      <main style={styles.main}>
        {page === "overview" && (
          <OverviewPage onOpenProject={openProject} onOpenTask={openTask} />
        )}
        {page === "chat" && <ChatPage onOpenTask={openTask} />}
        {page === "tasks" && (
          <TasksControlPage
            focusTaskId={focusedTaskId}
            onOpenProject={openProject}
          />
        )}
        {page === "projects" && (
          <ProjectsPage focusProjectId={focusedProjectId} onOpenTask={openTask} />
        )}
        {page === "agents" && <AgentsControlPage />}
        {page === "memory" && <MemoryStudioPage />}
        {page === "skills" && <SkillsPage onOpenTask={openTask} />}
        {page === "events" && <EventsPage />}
        {page === "settings" && <SettingsControlPage />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: { display: "flex", height: "100vh" },
  sidebar: {
    width: 220,
    background: "#111118",
    borderRight: "1px solid #2a2a3a",
    display: "flex",
    flexDirection: "column",
    padding: "20px 0",
  },
  logo: {
    borderBottom: "1px solid #2a2a3a",
    color: "#fff",
    padding: "0 20px 20px",
  },
  livePanel: {
    borderBottom: "1px solid #2a2a3a",
    display: "grid",
    gap: 8,
    padding: "16px 12px",
  },
  liveTitle: {
    color: "#e2e8f0",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  liveSummary: {
    color: "#93c5fd",
    fontSize: 12,
  },
  liveEmpty: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 1.4,
  },
  liveItem: {
    background: "#0f1726",
    border: "1px solid #22314a",
    borderRadius: 8,
    color: "inherit",
    cursor: "pointer",
    padding: "8px 10px",
    textAlign: "left" as const,
  },
  liveTaskTitle: {
    color: "#f8fafc",
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 4,
  },
  liveTaskMeta: {
    color: "#7c89a6",
    fontSize: 11,
  },
  nav: { flex: 1, display: "flex", flexDirection: "column", padding: "12px 8px", gap: 2 },
  navBtn: {
    background: "transparent",
    border: "none",
    borderRadius: 8,
    color: "#97a3bd",
    cursor: "pointer",
    fontSize: 14,
    padding: "9px 12px",
    textAlign: "left" as const,
  },
  navActive: { background: "#162032", color: "#fff" },
  logout: {
    margin: "0 12px",
    padding: "8px 12px",
    background: "transparent",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#888",
    fontSize: 13,
    cursor: "pointer",
  },
  main: { background: "#090b11", flex: 1, overflow: "auto", padding: 24 },
};
