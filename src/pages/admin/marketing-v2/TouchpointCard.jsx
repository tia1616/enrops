// TouchpointCard — one card per scheduled email in the campaign.
// Expandable. Shows summary collapsed; editor + preview when open.
// Edits are local until "Save as draft" or "Approve & Schedule" (chunk 07 wires).

import { useState } from "react";
import EditableField from "./EditableField.jsx";
import { INK, MUTED, PURPLE, RULE, OK } from "../marketing/tokens.jsx";

function fmtScheduled(iso, timezone) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
      timeZoneName: "short", timeZone: timezone,
    });
  } catch {
    return iso;
  }
}

function fmtDatetimeInput(iso) {
  if (!iso) return "";
  // Strip timezone for <input type="datetime-local">
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LABEL_COLORS = {
  kickoff: "#185FA5",
  "mid-window": "#854F0B",
  "48h-promo": "#BA7517",
  "24h-promo": "#BA7517",
  "48h-reg-close": "#BA7517",
  "24h-reg-close": "#BA7517",
  "final-call": "#b3261e",
  thanks: "#3B6D11",
};

export default function TouchpointCard({
  touchpoint,
  defaultOpen = false,
  timezone,
  topicColors,
  onUpdate,
  onSendTest,
  onRegenerate,
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Local pending state for the per-card Send-test button so the operator
  // gets immediate visual feedback (grayed bg + "Sending test…" label) the
  // moment they click — instead of waiting ~2s for the browser alert to pop.
  // Awaits the parent's async handler so the spinner clears on real completion.
  const [sendingTest, setSendingTest] = useState(false);
  const tp = touchpoint;
  const labelColor = LABEL_COLORS[tp.label] ?? MUTED;

  const handleSendTest = async () => {
    if (sendingTest) return;
    setSendingTest(true);
    try { await onSendTest?.(tp.id); }
    finally { setSendingTest(false); }
  };

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, marginBottom: 10, background: "#fff", overflow: "hidden" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          background: open ? "#faf8f1" : "#fff", border: "none", borderBottom: open ? `1px solid ${RULE}` : "none",
          padding: 12, cursor: "pointer", textAlign: "left", fontFamily: "inherit",
        }}
      >
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 34, height: 34, borderRadius: 6, background: "#f0e3e8", color: PURPLE,
          fontWeight: 700, fontSize: 16, flexShrink: 0,
        }}>
          {tp.type === "email" ? "✉" : tp.type === "social" ? "📣" : "📄"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
              color: labelColor, padding: "2px 6px", borderRadius: 999, background: "rgba(0,0,0,0.04)",
            }}>{tp.label}</span>
            {/* Topic chips intentionally dropped 2026-06-01: with grounded
                program picks they enumerate the same N curricula on every
                touchpoint -- noisy and not informative. Subject + body
                carry what the touchpoint is about. */}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginTop: 4, lineHeight: 1.3 }}>
            {tp.subject || "(no subject yet)"}
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            {fmtScheduled(tp.scheduled_at, timezone)}
          </div>
        </div>
        <span style={{ color: MUTED, fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}>▶</span>
      </button>

      {open && (
        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <EditableField
            label="Subject"
            value={tp.subject}
            onChange={(v) => onUpdate(tp.id, { subject: v })}
            placeholder="Click to write a subject"
          />

          <div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
              Send time
            </div>
            <input
              type="datetime-local"
              value={fmtDatetimeInput(tp.scheduled_at)}
              onChange={(e) => {
                const local = new Date(e.target.value);
                if (!isNaN(local.getTime())) onUpdate(tp.id, { scheduled_at: local.toISOString() });
              }}
              style={{
                padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6,
                fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK,
              }}
            />
          </div>

          <BodyEditor
            value={tp.body_html ?? ""}
            onChange={(v) => onUpdate(tp.id, { body_html: v, body_text: stripHtml(v) })}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* Regenerate button hidden until task #7's regenerate flag ships
                in marketing-draft-campaign. Currently fires a dev stub alert
                that we don't want operators to see. */}
            <button
              onClick={handleSendTest}
              disabled={sendingTest}
              style={{
                background: sendingTest ? "#efeae0" : "#fff",
                border: `1px solid ${RULE}`,
                color: sendingTest ? MUTED : INK,
                padding: "6px 12px", borderRadius: 999,
                cursor: sendingTest ? "wait" : "pointer",
                fontSize: 12, fontFamily: "inherit",
                transition: "background 0.15s ease, color 0.15s ease",
              }}
            >
              {sendingTest ? "Sending test…" : "Send test to me"}
            </button>
            {/* "Also lands in the parent portal feed" was sitting next to
                Send-test and read as if the test sent to parents too.
                Dropped — when the parent-portal feed ships we'll re-surface
                this info in the right place (probably on the Approve button). */}
          </div>
        </div>
      )}
    </div>
  );
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Wraps merge tokens like {{first_name}} in a styled span so operators can
// see at a glance which bits get personalized at send time. Returns HTML safe
// to drop into dangerouslySetInnerHTML (input is Ennie's already-sanitized HTML).
function highlightTokens(html) {
  if (!html) return "";
  return html.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    `<span style="display:inline-block;padding:0 6px;border-radius:4px;background:#f0e3e8;color:#1C004F;font-size:0.9em;font-weight:600;font-family:ui-monospace,monospace;">{{${name}}}</span>`,
  );
}

function BodyEditor({ value, onChange }) {
  const [editing, setEditing] = useState(false);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          Email body
        </span>
        <button
          onClick={() => setEditing((v) => !v)}
          style={{
            background: "transparent", border: "none", color: PURPLE,
            cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
          }}
        >
          {editing ? "Done editing" : "Edit"}
        </button>
      </div>

      {editing ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={10}
          style={{
            width: "100%", padding: "10px 12px",
            border: `1px solid ${RULE}`, borderRadius: 6,
            fontFamily: "ui-monospace, monospace", fontSize: 12,
            lineHeight: 1.5, color: INK, background: "#fff",
            resize: "vertical", boxSizing: "border-box",
          }}
        />
      ) : (
        <div
          style={{
            padding: "14px 16px",
            border: `1px solid ${RULE}`, borderRadius: 6,
            background: "#fff", fontSize: 14, color: INK, lineHeight: 1.55,
          }}
          dangerouslySetInnerHTML={{ __html: highlightTokens(value) }}
        />
      )}

      {!editing && (
        <div style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            Highlighted tags like <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{first_name}}"}</span> get filled in for each parent when the email sends.
          </p>
          <p style={{ margin: "4px 0 0", color: OK, fontStyle: "italic" }}>
            ✨ Every edit teaches Ennie a phrase you prefer or drop. Future drafts will reflect your voice automatically — less editing each campaign.
          </p>
        </div>
      )}
    </div>
  );
}
