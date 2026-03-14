import type React from "react";

export const shellStyles = {
  button: {
    background: "#2563eb",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 14px",
  } satisfies React.CSSProperties,
  buttonDanger: {
    background: "#7f1d1d",
  } satisfies React.CSSProperties,
  buttonGhost: {
    background: "transparent",
    border: "1px solid #334155",
    color: "#cbd5e1",
  } satisfies React.CSSProperties,
  buttonSecondary: {
    background: "#1e293b",
    color: "#dbeafe",
  } satisfies React.CSSProperties,
  card: {
    background: "#111118",
    border: "1px solid #2a2a3a",
    borderRadius: 12,
    padding: 16,
  } satisfies React.CSSProperties,
  inlineCode: {
    background: "#171b27",
    borderRadius: 4,
    color: "#c9d9ff",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    padding: "1px 5px",
  } satisfies React.CSSProperties,
  input: {
    background: "#0e0e18",
    border: "1px solid #2a2a3a",
    borderRadius: 8,
    color: "#e0e0e8",
    fontSize: 13,
    outline: "none",
    padding: "8px 12px",
  } satisfies React.CSSProperties,
  label: {
    color: "#9ca3af",
    display: "block",
    fontSize: 12,
    marginBottom: 6,
  } satisfies React.CSSProperties,
  muted: {
    color: "#8b8b96",
    fontSize: 12,
  } satisfies React.CSSProperties,
  textarea: {
    background: "#0e0e18",
    border: "1px solid #2a2a3a",
    borderRadius: 8,
    color: "#e0e0e8",
    fontFamily: "inherit",
    fontSize: 13,
    minHeight: 110,
    outline: "none",
    padding: "10px 12px",
    resize: "vertical",
  } satisfies React.CSSProperties,
};

export function statusChipStyle(color: string): React.CSSProperties {
  return {
    background: `${color}22`,
    borderRadius: 999,
    color,
    display: "inline-flex",
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 8px",
  };
}

