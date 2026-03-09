import React, { useState } from "react";
import { ChatPage } from "./ChatPage";
import { TasksPage } from "./TasksPage";
import { AgentsPage } from "./AgentsPage";
import { MemoryPage } from "./MemoryPage";
import { EventsPage } from "./EventsPage";
import { SettingsPage } from "./SettingsPage";

type Page = "chat" | "tasks" | "agents" | "memory" | "events" | "settings";

const NAV_ITEMS: { id: Page; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "memory", label: "Memory" },
  { id: "events", label: "Events" },
  { id: "settings", label: "Settings" },
];

export function Dashboard({ onLogout }: { onLogout: () => Promise<void> }) {
  const [page, setPage] = useState<Page>("chat");

  return (
    <div style={styles.layout}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Agent-OS</div>
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
        {page === "chat" && <ChatPage />}
        {page === "tasks" && <TasksPage />}
        {page === "agents" && <AgentsPage />}
        {page === "memory" && <MemoryPage />}
        {page === "events" && <EventsPage />}
        {page === "settings" && <SettingsPage />}
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
    fontSize: 18,
    fontWeight: 700,
    color: "#fff",
    padding: "0 20px 20px",
    borderBottom: "1px solid #2a2a3a",
  },
  nav: { flex: 1, display: "flex", flexDirection: "column", padding: "12px 8px", gap: 2 },
  navBtn: {
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    color: "#999",
    fontSize: 14,
    textAlign: "left" as const,
    cursor: "pointer",
  },
  navActive: { background: "#1e1e2e", color: "#fff" },
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
  main: { flex: 1, overflow: "auto", padding: 24 },
};
