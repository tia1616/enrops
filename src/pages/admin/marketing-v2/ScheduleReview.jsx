// ScheduleReview — the real chunk-06 review screen. Replaces the chunk-05
// ReviewPlaceholder. Shows the full multi-touchpoint schedule with editable
// subject/body/send-time per touchpoint, recipient summary with per-row
// remove, and the sticky action bar (back / save / send test / approve).
//
// All edits are LOCAL until "Save as draft" or "Approve & Schedule". Chunk 07
// wires the real PATCH + marketing-send calls.

import { useMemo, useState } from "react";
import TouchpointCard from "./TouchpointCard.jsx";
import { INK, MUTED, PURPLE, RULE, OK, INFO } from "../marketing/tokens.jsx";

// Stable color palette for topic chips. Same five we used in the mockup.
const TOPIC_PALETTE = [
  { background: "#f0e3e8", color: PURPLE },
  { background: "#FAEEDA", color: "#854F0B" },
  { background: "#EAF3DE", color: OK },
  { background: "#fce4ec", color: "#ad1457" },
  { background: "#dbeafe", color: INFO },
];

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return iso; }
}

export default function ScheduleReview({
  draft,
  org,
  onBack,
  onReset,
  onUpdateTouchpoint,
  onRemoveRecipient,
  onSaveDraft,
  onSendTest,
  onApprove,
  onRegenerate,
  busy,
}) {
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const touchpoints = draft?.schedule?.touchpoints ?? [];
  const recipients = draft?.recipients ?? { count: 0, ids: [], segment_summary: "" };
  const sender = draft?.sender ?? { name: org?.default_sender_name, email: org?.default_sender_email };
  const timezone = org?.timezone ?? "America/Los_Angeles";

  const topicColors = useMemo(() => {
    const topics = new Set();
    for (const tp of touchpoints) for (const t of tp.topics ?? []) topics.add(t);
    const map = {};
    [...topics].forEach((t, i) => { map[t] = TOPIC_PALETTE[i % TOPIC_PALETTE.length]; });
    return map;
  }, [touchpoints]);

  const firstDate = touchpoints[0]?.scheduled_at;
  const lastDate = touchpoints[touchpoints.length - 1]?.scheduled_at;
  const operatorNotes = draft?.schedule?.notes_to_operator?.trim();
  const zeroRecipients = draft?.warning === "no_recipients_matched" || recipients.count === 0;

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", paddingBottom: 96 }}>
      <button
        onClick={onBack}
        style={{
          background: "transparent", border: "none", color: MUTED,
          cursor: "pointer", fontSize: 13, fontFamily: "inherit",
          padding: "0 0 12px", display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        ← Back to questions
      </button>

      <div style={{
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
        padding: "18px 20px", marginBottom: 12,
      }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, margin: 0 }}>
          Draft plan · review &amp; approve
        </p>
        <h2 style={{ margin: "4px 0 6px", fontSize: 22, color: INK }}>
          Here's the campaign Don put together.
        </h2>
        <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
          {draft?.schedule?.summary || "Expand any touchpoint to edit and preview. Approve when it's right."}
        </p>

        {/* Plan summary grid */}
        <div style={{
          marginTop: 14, display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12, fontSize: 13,
        }}>
          <div>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Topics</div>
            <div style={{ marginTop: 2, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {Object.entries(topicColors).map(([t, color]) => (
                <span key={t} style={{
                  fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, ...color,
                }}>{t}</span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Audience</div>
            <div style={{ marginTop: 2 }}>
              {recipients.count} parents · {recipients.segment_summary}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Window</div>
            <div style={{ marginTop: 2 }}>{fmtDate(firstDate)} — {fmtDate(lastDate)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Sender</div>
            <div style={{ marginTop: 2 }}>{sender.name}</div>
          </div>
        </div>
      </div>

      {operatorNotes && (
        <div style={{
          background: "#FFF8E1", border: "1px solid #E6C77A", borderRadius: 8,
          padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#5C4A1C",
        }}>
          <strong style={{ fontWeight: 700 }}>A note from Don:</strong> {operatorNotes}
        </div>
      )}

      {zeroRecipients && (
        <div style={{
          background: "#FDECEA", border: "1px solid #E5A6A0", borderRadius: 8,
          padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#7A1F19",
        }}>
          <strong style={{ fontWeight: 700 }}>No recipients matched.</strong> Don drafted the schedule, but no parents fit this filter yet. Go back and widen the audience, or save as a draft for later.
        </div>
      )}

      {/* Recipient summary */}
      <div style={{
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
        padding: 14, marginBottom: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: INK }}>
              {recipients.count} recipients
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{recipients.segment_summary}</div>
          </div>
          <button
            onClick={() => setRecipientsOpen((v) => !v)}
            style={{
              background: "#fff", border: `1px solid ${RULE}`, color: INK,
              padding: "6px 12px", borderRadius: 6, cursor: "pointer",
              fontSize: 12, fontFamily: "inherit",
            }}
          >
            {recipientsOpen ? "Hide list" : "View list"}
          </button>
        </div>
        {recipientsOpen && (
          <RecipientList ids={recipients.ids} onRemove={onRemoveRecipient} />
        )}
      </div>

      {/* Touchpoint list */}
      <h3 style={{ margin: "16px 0 8px", fontSize: 14, color: INK, fontWeight: 700 }}>
        The schedule ({touchpoints.length} touchpoint{touchpoints.length === 1 ? "" : "s"})
      </h3>
      {touchpoints.map((tp, i) => (
        <TouchpointCard
          key={tp.id}
          touchpoint={tp}
          defaultOpen={i === 0}
          timezone={timezone}
          topicColors={topicColors}
          onUpdate={onUpdateTouchpoint}
          onSendTest={onSendTest}
          onRegenerate={onRegenerate}
        />
      ))}

      {/* Sticky action bar */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        padding: "12px 16px", background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(6px)", borderTop: `1px solid ${RULE}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 12, zIndex: 5,
      }}>
        <div style={{ fontSize: 12, color: MUTED, flex: 1, minWidth: 0 }}>
          Approving locks the schedule. You can still edit before each send fires.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onSaveDraft}
            disabled={busy}
            style={{
              background: "#fff", border: `1px solid ${RULE}`, color: INK,
              padding: "8px 14px", borderRadius: 6, cursor: busy ? "not-allowed" : "pointer",
              fontSize: 13, fontFamily: "inherit",
            }}
          >
            Save as draft
          </button>
          <button
            onClick={onSendTest}
            disabled={busy}
            style={{
              background: "#fff", border: `1px solid ${INFO}`, color: INFO,
              padding: "8px 14px", borderRadius: 6, cursor: busy ? "not-allowed" : "pointer",
              fontSize: 13, fontFamily: "inherit",
            }}
          >
            Send test to me
          </button>
          <button
            onClick={onApprove}
            disabled={busy || touchpoints.length === 0}
            style={{
              background: busy || touchpoints.length === 0 ? "#cfcfcf" : PURPLE,
              color: "#fff", border: "none",
              padding: "10px 16px", borderRadius: 6,
              cursor: busy || touchpoints.length === 0 ? "not-allowed" : "pointer",
              fontSize: 14, fontWeight: 600, fontFamily: "inherit",
            }}
          >
            Approve &amp; schedule ✨
          </button>
        </div>
      </div>
    </div>
  );
}

function RecipientList({ ids, onRemove }) {
  if (!ids || ids.length === 0) {
    return (
      <p style={{ fontSize: 12, color: MUTED, margin: "8px 0 0" }}>
        No recipients matched this filter.
      </p>
    );
  }
  return (
    <div style={{
      marginTop: 10, border: `1px solid ${RULE}`, borderRadius: 6,
      maxHeight: 200, overflowY: "auto",
    }}>
      {ids.slice(0, 50).map((id) => (
        <div key={id} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "6px 10px", borderBottom: `1px solid ${RULE}`, fontSize: 12, color: INK,
        }}>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{id}</span>
          <button
            onClick={() => onRemove?.(id)}
            style={{ background: "transparent", border: "none", color: "#b3261e", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
          >
            Remove
          </button>
        </div>
      ))}
      {ids.length > 50 && (
        <div style={{ padding: "8px 10px", fontSize: 11, color: MUTED }}>
          (showing first 50 of {ids.length})
        </div>
      )}
    </div>
  );
}
