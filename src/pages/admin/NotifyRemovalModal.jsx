import React, { useMemo, useState } from "react";
import { supabase } from "../../lib/supabase.js";

// Shown when the admin removes (or reassigns away from) an instructor whose
// camp_assignments row has email_sent_at set. The DB-level removal is silent
// — UNIQUE(session,role) forces DELETE over UPDATE 'withdrawn' — so without
// this nudge the instructor learns by their portal row vanishing. Admin
// previews + edits the copy, then chooses "Send + remove" or "Skip + remove".
//
// No "cancel" language anywhere (per enrops principle), even though this is
// instructor-facing not parent-facing — same tone rule.

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";

function fmtDate(d) {
  if (!d) return "";
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
}

function displayName(instructor) {
  if (!instructor) return "this instructor";
  return instructor.preferred_name || instructor.first_name || "there";
}

export default function NotifyRemovalModal({
  mode, // 'remove' | 'reassign'
  instructor,
  assignment,
  session,
  org,
  remainingActiveCount, // number of other active (non-withdrawn) confirmed/published assignments this instructor still has in this cycle
  onProceed,
  onCancel,
}) {
  const orgName = org?.name ?? "the team";
  const greeting = displayName(instructor);
  const campName = session?.location_name || "your camp";
  const weekDate = fmtDate(session?.starts_on);

  const defaultSubject = useMemo(() => {
    return `Update: ${campName}${weekDate ? ` (week of ${weekDate})` : ""} is no longer on your schedule`;
  }, [campName, weekDate]);

  const defaultBody = useMemo(() => {
    const lines = [`Hi ${greeting},`, ""];
    lines.push(
      `A quick update — the ${campName}${weekDate ? ` camp for the week of ${weekDate}` : ""} is no longer on your schedule.`,
    );
    lines.push("");
    if (remainingActiveCount > 0) {
      lines.push(
        `You're still on for ${remainingActiveCount} other camp${remainingActiveCount === 1 ? "" : "s"} this cycle — log in to your portal any time to see your current schedule.`,
      );
    } else {
      lines.push(
        `That leaves your schedule with ${orgName} open for this cycle. If a spot opens up that matches your availability, we'll reach back out.`,
      );
    }
    lines.push("");
    lines.push("Questions? Just reply to this email.");
    lines.push("");
    lines.push(`— ${orgName}`);
    return lines.join("\n");
  }, [greeting, campName, weekDate, orgName, remainingActiveCount]);

  const [subject, setSubject] = useState(defaultSubject);
  const [bodyText, setBodyText] = useState(defaultBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const noEmail = !instructor?.email;

  async function sendAndProceed() {
    if (busy || noEmail) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "notify-instructor-removed",
        {
          body: {
            instructor_id: instructor.id,
            organization_id: org.id,
            subject: subject.trim(),
            body_text: bodyText.trim(),
          },
        },
      );
      if (fnErr || data?.error) {
        setError(data?.error || fnErr?.message || "Couldn't send the email.");
        setBusy(false);
        return;
      }
      await onProceed({ emailSent: true });
    } catch (err) {
      console.error("[NotifyRemovalModal] send failed", err);
      setError("Something went wrong sending the email.");
      setBusy(false);
    }
  }

  async function skipAndProceed() {
    if (busy) return;
    setBusy(true);
    try {
      await onProceed({ emailSent: false });
    } catch (err) {
      console.error("[NotifyRemovalModal] proceed failed", err);
      setBusy(false);
    }
  }

  const modeLabel = mode === "reassign" ? "Reassign" : "Remove";

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        zIndex: 110,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width: "100%",
          maxWidth: 640,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
              {modeLabel} {instructor?.first_name ?? "instructor"}?
            </h2>
            <p style={{ color: MUTED, fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              They were already informed about this camp. Preview the note they'll get below — you can edit it, send it, or skip the email entirely.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              background: "transparent",
              border: "none",
              color: MUTED,
              fontSize: 18,
              cursor: busy ? "wait" : "pointer",
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {noEmail && (
          <div
            style={{
              background: "#fff7ed",
              border: `1px solid #fed7aa`,
              color: "#9a3412",
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {instructor?.first_name ?? "This instructor"} has no email on file — only "Skip email" is available.
          </div>
        )}

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
          Subject
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={busy}
          style={{
            width: "100%",
            padding: "9px 11px",
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 14,
            color: INK,
            fontFamily: "inherit",
          }}
        />

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, marginTop: 12 }}>
          Message
        </label>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          disabled={busy}
          rows={10}
          style={{
            width: "100%",
            padding: "10px 12px",
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 14,
            color: INK,
            fontFamily: "inherit",
            lineHeight: 1.5,
            resize: "vertical",
          }}
        />

        <p style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>
          Sent to {instructor?.email || "(no email on file)"}. Replies go to your org alert email.
        </p>

        {error && (
          <p style={{ color: RED, fontSize: 13, marginTop: 8 }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "9px 14px",
              border: `1px solid ${RULE}`,
              background: "transparent",
              color: INK,
              borderRadius: 6,
              cursor: busy ? "wait" : "pointer",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          >
            Don't {mode === "reassign" ? "reassign" : "remove"}
          </button>
          <button
            type="button"
            onClick={skipAndProceed}
            disabled={busy}
            style={{
              padding: "9px 14px",
              border: `1px solid ${RULE}`,
              background: "#fff",
              color: INK,
              borderRadius: 6,
              cursor: busy ? "wait" : "pointer",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          >
            Skip email + {mode === "reassign" ? "reassign" : "remove"}
          </button>
          <button
            type="button"
            onClick={sendAndProceed}
            disabled={busy || noEmail || !subject.trim() || !bodyText.trim()}
            style={{
              padding: "9px 14px",
              border: "none",
              background: PURPLE,
              color: "#fff",
              borderRadius: 6,
              cursor: busy ? "wait" : noEmail ? "not-allowed" : "pointer",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              opacity: noEmail ? 0.5 : 1,
            }}
          >
            {busy ? "Sending…" : `Send note + ${mode === "reassign" ? "reassign" : "remove"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
