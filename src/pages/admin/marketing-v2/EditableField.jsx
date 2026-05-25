// EditableField — click-to-edit pattern per chunk 06 spec.
// Display mode: shows value + hover hint. Click → input/textarea. Blur or
// Enter (input) saves; Esc cancels. Multiline mode uses textarea + Cmd/Ctrl+Enter.

import { useEffect, useRef, useState } from "react";
import { INK, MUTED, PURPLE, RULE } from "../marketing/tokens.jsx";

export default function EditableField({
  value,
  onChange,
  multiline = false,
  placeholder = "Click to edit",
  label,
  style,
  rows = 6,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef(null);

  useEffect(() => { if (!editing) setDraft(value ?? ""); }, [value, editing]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== value) onChange(draft);
  }
  function cancel() {
    setEditing(false);
    setDraft(value ?? "");
  }

  const containerStyle = { ...style };

  if (editing) {
    if (multiline) {
      return (
        <div style={containerStyle}>
          {label && <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>}
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
            }}
            rows={rows}
            style={{
              width: "100%", border: `2px solid ${PURPLE}`, borderRadius: 6,
              padding: 10, fontSize: 13, lineHeight: 1.5,
              fontFamily: "inherit", color: INK, background: "#fff",
              resize: "vertical", outline: "none",
            }}
          />
          <p style={{ margin: "4px 0 0", fontSize: 11, color: MUTED }}>
            Cmd/Ctrl+Enter to save · Esc to cancel
          </p>
        </div>
      );
    }
    return (
      <div style={containerStyle}>
        {label && <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>}
        <input
          ref={ref}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
            if (e.key === "Enter") { e.preventDefault(); commit(); }
          }}
          style={{
            width: "100%", border: `2px solid ${PURPLE}`, borderRadius: 6,
            padding: "8px 10px", fontSize: 13, fontFamily: "inherit",
            color: INK, background: "#fff", outline: "none",
          }}
        />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {label && <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>}
      <div
        onClick={() => setEditing(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        style={{
          border: `1px solid ${RULE}`, borderRadius: 6, padding: multiline ? 10 : "8px 10px",
          background: "#fff", cursor: "text", fontSize: 13, lineHeight: 1.5, color: value ? INK : MUTED,
          whiteSpace: multiline ? "pre-wrap" : "normal",
          minHeight: multiline ? 60 : "auto",
        }}
      >
        {value || placeholder}
      </div>
    </div>
  );
}
