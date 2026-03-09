import React from "react";
import { useAuth } from "./lib/auth";
import { LoginPage } from "./pages/LoginPage";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  const auth = useAuth();

  if (auth.loading) {
    return (
      <div
        style={{
          alignItems: "center",
          background: "#0a0a0f",
          color: "#e0e0e8",
          display: "flex",
          fontSize: 14,
          height: "100vh",
          justifyContent: "center",
        }}
      >
        Loading admin session...
      </div>
    );
  }

  if (!auth.authenticated) {
    return <LoginPage onLogin={auth.login} />;
  }

  return <Dashboard onLogout={auth.logout} />;
}
