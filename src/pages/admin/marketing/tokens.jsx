// src/pages/admin/marketing/tokens.js
// Shared brand tokens and utility functions for the marketing module.

export const PLUM = "#691D39";
export const GOLD = "#CFB12F";
export const CHALK = "#EAEADD";
export const INK = "#1a1a1a";
export const MUTED = "#6b6b6b";
export const RULE = "#e2dfd5";
export const OK = "#3B6D11";
export const INFO = "#185FA5";
export const WARN = "#BA7517";
export const DANGER = "#b3261e";

export function statusColor(status) {
  switch (status) {
    case "draft": return MUTED;
    case "ready":
    case "scheduled": return "#854F0B";
    case "running":
    case "sending": return "#ed6c02";
    case "sent":
    case "complete": return OK;
    case "paused":
    case "failed": return DANGER;
    default: return MUTED;
  }
}

export function pillClass(status) {
  switch (status) {
    case "running": return { background: "#EAF3DE", color: OK };
    case "scheduled":
    case "ready": return { background: "#FAEEDA", color: "#854F0B" };
    case "complete":
    case "sent": return { background: "#F1EFE8", color: "#5F5E5A" };
    case "on": return { background: "#EAF3DE", color: OK };
    case "off": return { background: "#F1EFE8", color: "#5F5E5A" };
    case "draft": return { background: "#F1EFE8", color: MUTED };
    case "failed": return { background: "#fdecea", color: DANGER };
    default: return { background: "#F1EFE8", color: MUTED };
  }
}

export function Pill({ status, label }) {
  const s = pillClass(status);
  return (
    <span style={{
      fontSize: 10, padding: "3px 9px", borderRadius: 999, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.4, ...s,
    }}>
      {label || status}
    </span>
  );
}

export function btn(bg, fg = "#fff", outlined = false) {
  return {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "8px 14px", background: outlined ? "transparent" : bg,
    color: outlined ? bg : fg, border: outlined ? `1px solid ${bg}` : "none",
    borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500,
    fontFamily: "inherit", textDecoration: "none", whiteSpace: "nowrap",
  };
}

export function input(extra = {}) {
  return {
    padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 5,
    fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK,
    width: "100%", ...extra,
  };
}

export function Card({ children, style, active, dashed, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: "#fff",
      border: active ? `2px solid ${INFO}` : dashed ? `1px dashed ${RULE}` : `1px solid ${RULE}`,
      borderRadius: 6, padding: 14, marginBottom: 8, cursor: onClick ? "pointer" : undefined,
      ...style,
    }}>
      {children}
    </div>
  );
}
