// DeliveryIssuesPanel — "families who didn't get an email" surface.
//
// Phase 2 (Chunk 1, read-only) of the lifecycle send-failure work. Since
// lifecycle-automations-cron now RECORDS a failed send (status='failed' +
// error_message + attempts) instead of silently dropping it, this panel makes
// those failures visible to the operator right on the Automations tab.
//
// Read-only for now: Resend / Fix-email / Mark-handled actions land in the next
// chunk (they need the resend edge fn + a resolved_at column). This chunk is
// deliberately isolated — new file, existing RLS (members_read_
// automation_run_recipients scopes rows to the operator's org), no schema
// change, no shared files.
//
// Honest-state rules (matches the platform's no-silent-failure control audit):
//   - Separates "Needs you" (bad address, or exhausted after retries) from
//     "Still sending" (a transient failure the cron is auto-retrying). A row
//     that's still retrying is NOT shown as a hard failure.
//   - Intentional skips (unsubscribed / throttled) never appear here — only
//     genuine failures (status='failed').
//   - Renders nothing when there are no failures (no clutter, no dead controls).

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, RULE, WARN, INFO } from "../marketing/tokens.jsx";

// Mirrors MAX_SEND_ATTEMPTS in lifecycle-automations-cron. A failed row at/above
// this has stopped auto-retrying and needs a human.
const MAX_SEND_ATTEMPTS = 5;

// Map a raw Resend/network error to a plain-English reason + whether it needs
// the operator. Address problems are permanent (fix the address); an exhausted
// transient failure needs a manual resend; anything still under the retry cap is
// the cron's job, shown as in-progress.
function classify(row) {
  const err = (row.error_message || "").toLowerCase();
  const badAddress = /422|invalid|not a valid|validation|no recipients|parse|domain/.test(err);
  if (badAddress) {
    return { needsYou: true, reason: "The email address on file looks invalid.", hint: "Check this family's email address." };
  }
  if ((row.attempts ?? 0) >= MAX_SEND_ATTEMPTS) {
    return { needsYou: true, reason: "We couldn't reach their inbox after several tries.", hint: "Resend, or reach them another way." };
  }
  return { needsYou: false, reason: "Still sending — retrying automatically.", hint: null };
}

// context_key shapes we can attribute a child/program to:
//   camp:<camp_session_id>:parent:<parent_id>:student:<student_id>
//   program:<program_id>:parent:<parent_id>:student:<student_id>[:suffix]
// Other lifecycle types (birthday, contact_added, no_school_day) don't carry a
// student in a fixed slot — we degrade gracefully and just omit child/program.
function parseContextKey(ck) {
  const p = (ck || "").split(":");
  if ((p[0] === "camp" || p[0] === "program") && p[2] === "parent" && p[4] === "student") {
    return { kind: p[0], refId: p[1], studentId: p[5] };
  }
  return { kind: null, refId: null, studentId: null };
}

function ago(ts) {
  if (!ts) return "";
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export default function DeliveryIssuesPanel({ org }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (org?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // RLS (is_org_member) already scopes to this org; the explicit filter also
      // hits the partial index automation_run_recipients_failed_idx.
      const { data: failed, error: fErr } = await supabase
        .from("automation_run_recipients")
        .select("id, context_key, parent_id, email, automation_id, error_message, attempts, last_attempt_at")
        .eq("organization_id", org.id)
        .eq("status", "failed")
        .order("last_attempt_at", { ascending: false })
        .limit(100);
      if (fErr) throw fErr;

      const list = failed ?? [];
      if (list.length === 0) {
        setRows([]);
        return;
      }

      // Collect the ids we need to resolve for display.
      const autoIds = [...new Set(list.map((r) => r.automation_id).filter(Boolean))];
      const parentIds = [...new Set(list.map((r) => r.parent_id).filter(Boolean))];
      const parsed = list.map((r) => parseContextKey(r.context_key));
      const studentIds = [...new Set(parsed.map((p) => p.studentId).filter(Boolean))];
      const campIds = [...new Set(parsed.filter((p) => p.kind === "camp").map((p) => p.refId))];
      const programIds = [...new Set(parsed.filter((p) => p.kind === "program").map((p) => p.refId))];

      const [autoRes, parentRes, studentRes, campRes, progRes] = await Promise.all([
        autoIds.length ? supabase.from("automations").select("id, template_id").in("id", autoIds) : { data: [] },
        parentIds.length ? supabase.from("parents").select("id, first_name, last_name").in("id", parentIds) : { data: [] },
        studentIds.length ? supabase.from("students").select("id, first_name").in("id", studentIds) : { data: [] },
        campIds.length ? supabase.from("camp_sessions").select("id, curriculum_name, starts_on").in("id", campIds) : { data: [] },
        programIds.length ? supabase.from("programs").select("id, curriculum, first_session_date").in("id", programIds) : { data: [] },
      ]);

      // automation_id -> template display_name (two hops: automations -> templates)
      const templateIds = [...new Set((autoRes.data ?? []).map((a) => a.template_id).filter(Boolean))];
      const tplRes = templateIds.length
        ? await supabase.from("automation_templates").select("id, display_name").in("id", templateIds)
        : { data: [] };
      const tplName = new Map((tplRes.data ?? []).map((t) => [t.id, t.display_name]));
      const autoName = new Map((autoRes.data ?? []).map((a) => [a.id, tplName.get(a.template_id) || "An email"]));
      const parentById = new Map((parentRes.data ?? []).map((p) => [p.id, p]));
      const studentById = new Map((studentRes.data ?? []).map((s) => [s.id, s]));
      const campById = new Map((campRes.data ?? []).map((c) => [c.id, c]));
      const progById = new Map((progRes.data ?? []).map((p) => [p.id, p]));

      const resolved = list.map((r, i) => {
        const pk = parsed[i];
        const parent = parentById.get(r.parent_id);
        const student = pk.studentId ? studentById.get(pk.studentId) : null;
        const camp = pk.kind === "camp" ? campById.get(pk.refId) : null;
        const prog = pk.kind === "program" ? progById.get(pk.refId) : null;
        const parentName = parent
          ? `${parent.first_name || ""} ${parent.last_name || ""}`.trim() || r.email
          : r.email;
        const childName = student?.first_name || null;
        const programName = camp?.curriculum_name || prog?.curriculum || null;
        const startDate = camp?.starts_on || prog?.first_session_date || null;
        const { needsYou, reason, hint } = classify(r);
        return {
          id: r.id,
          familyLabel: childName ? `${childName}'s family` : parentName,
          email: r.email,
          emailName: autoName.get(r.automation_id) || "An email",
          programName,
          startDate,
          reason,
          hint,
          needsYou,
          when: ago(r.last_attempt_at),
        };
      });

      setRows(resolved);
    } catch (e) {
      setError("Couldn't load delivery issues.");
      // eslint-disable-next-line no-console
      console.error("[DeliveryIssuesPanel]", e);
    } finally {
      setLoading(false);
    }
  }

  // Quiet while loading and when there's nothing wrong — this is an alert
  // surface, not a permanent widget.
  if (loading) return null;
  if (error) {
    return (
      <div role="alert" style={errBox}>
        {error}
      </div>
    );
  }
  if (rows.length === 0) return null;

  const needsYou = rows.filter((r) => r.needsYou);
  const inProgress = rows.filter((r) => !r.needsYou);

  return (
    <section
      aria-label="Email delivery issues"
      style={{
        border: `1px solid ${WARN}`,
        background: "#fffaf0",
        borderRadius: 12,
        padding: 18,
        marginBottom: 22,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span aria-hidden="true">⚠️</span>
        <h2 style={{ color: INK, fontSize: 16, fontWeight: 800, margin: 0 }}>
          {needsYou.length > 0
            ? `${needsYou.length} ${needsYou.length === 1 ? "family" : "families"} didn't get an email`
            : "Delivery in progress"}
        </h2>
      </div>
      <p style={{ color: MUTED, fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
        {needsYou.length > 0
          ? "These sends couldn't reach the family and need a look. Resend and fix-email are coming next; for now, here's exactly who to follow up with."
          : "A few sends hit a temporary snag and are retrying automatically — nothing to do."}
      </p>

      {needsYou.map((r) => (
        <IssueRow key={r.id} r={r} tone="needs" />
      ))}
      {inProgress.map((r) => (
        <IssueRow key={r.id} r={r} tone="progress" />
      ))}
    </section>
  );
}

function IssueRow({ r, tone }) {
  const accent = tone === "needs" ? WARN : INFO;
  return (
    <div
      style={{
        borderTop: `1px solid ${RULE}`,
        padding: "10px 0",
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: INK, fontSize: 14, fontWeight: 700 }}>
          {r.familyLabel}
          <span style={{ color: MUTED, fontWeight: 500 }}>
            {" · "}
            {r.emailName}
          </span>
        </div>
        <div style={{ color: MUTED, fontSize: 13, margin: "2px 0" }}>
          {r.programName
            ? `${r.programName}${r.startDate ? ` · starts ${r.startDate}` : ""}`
            : r.email}
        </div>
        <div style={{ color: accent, fontSize: 13, fontWeight: 600 }}>
          {r.reason}
          {r.hint ? <span style={{ color: MUTED, fontWeight: 400 }}>{` ${r.hint}`}</span> : null}
        </div>
      </div>
      <div style={{ color: MUTED, fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
        {r.when}
      </div>
    </div>
  );
}

const errBox = {
  background: "#fef2f2",
  border: `1px solid ${WARN}`,
  color: "#7c2d12",
  padding: "10px 14px",
  borderRadius: 12,
  marginBottom: 16,
  fontSize: 14,
};
