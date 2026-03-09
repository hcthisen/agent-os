import React, { useState } from "react";

export function LoginPage({
  onLogin,
}: {
  onLogin: (user: string, pass: string) => Promise<boolean>;
}) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const ok = await onLogin(user, pass);
    setSubmitting(false);
    if (!ok) {
      setError(true);
    }
  }

  return (
    <div style={styles.wrapper}>
      <form onSubmit={handleSubmit} style={styles.form}>
        <h1 style={styles.title}>Agent-OS</h1>
        <p style={styles.subtitle}>Admin Panel</p>
        {error && <p style={styles.error}>Invalid credentials</p>}
        <input
          style={styles.input}
          type="text"
          placeholder="Username"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoFocus
        />
        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <button style={styles.button} type="submit">
          {submitting ? "Signing In..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: "linear-gradient(135deg, #0a0a0f 0%, #12121f 100%)",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: 40,
    background: "#16161f",
    borderRadius: 12,
    border: "1px solid #2a2a3a",
    width: 360,
  },
  title: { fontSize: 24, fontWeight: 700, color: "#fff", textAlign: "center" },
  subtitle: { fontSize: 14, color: "#888", textAlign: "center", marginTop: -8 },
  error: { color: "#f44", fontSize: 13, textAlign: "center" },
  input: {
    padding: "10px 14px",
    background: "#0e0e18",
    border: "1px solid #2a2a3a",
    borderRadius: 8,
    color: "#e0e0e8",
    fontSize: 14,
    outline: "none",
  },
  button: {
    padding: "10px 14px",
    background: "#3b82f6",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
};
