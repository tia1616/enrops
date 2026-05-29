// Lets an admin swap the curriculum on a single scheduled program.
// Writes both programs.curriculum_id (FK) AND programs.curriculum (text)
// because no DB trigger keeps them in sync.
//
// Scoped by organization_id at every query; RLS blocks cross-tenant writes
// even if a stale org slipped through.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const SOFT_AMBER_BG = "#fff7ed";
const SOFT_AMBER_BORDER = "#fed7aa";
const SOFT_AMBER_INK = "#9a3412";

const DAY_LABELS = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

function describeProgram(p) {
  const parts = [];
  if (p.program_locations?.name) parts.push(p.program_locations.name);
  if (p.day_of_week) parts.push(DAY_LABELS[p.day_of_week.toLowerCase()] ?? p.day_of_week);
  if (p.start_time) parts.push(formatTime(p.start_time));
  return parts.join(" · ");
}

function formatTime(t) {
  if (!t) return "";
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, "");
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

export default function EditProgramCurriculumModal({
  program,
  org,
  curricula,
  enrollment,
  onSaved,
  onCancel,
}) {
  const currentId = program.curriculum_id ?? "";
  const [pickedId, setPickedId] = useState(currentId);
  const [impact, setImpact] = useState({ loading: true, assignments: 0, deliveries: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [assignRes, deliverRes] = await Promise.all([
          supabase
            .from("program_assignments")
            .select("id", { count: "exact", head: true })
            .eq("program_id", program.id)
            .eq("organization_id", org.id),
          supabase
            .from("session_delivery_confirmations")
            .select("id", { count: "exact", head: true })
            .eq("program_id", program.id)
            .eq("organization_id", org.id),
        ]);
        if (!mounted) return;
        setImpact({
          loading: false,
          assignments: assignRes.count ?? 0,
          // session_delivery_confirmations may not exist in every org's schema yet;
          // a missing-table error reads as 0 rather than blocking the modal.
          deliveries: deliverRes.error ? 0 : (deliverRes.count ?? 0),
        });
      } catch {
        if (mounted) setImpact({ loading: false, assignments: 0, deliveries: 0 });
      }
    })();
    return () => { mounted = false; };
  }, [program.id, org.id]);

  const currentName = program.curriculum ?? "(none)";
  const pickedCurriculum = curricula.find((c) => c.id === pickedId) ?? null;
  const changed = pickedId && pickedId !== currentId;
  const enr = enrollment ?? { paid: 0, unpaid: 0, pending: 0 };
  const enrolled = enr.paid + enr.unpaid;

  async function save() {
    if (!changed || !pickedCurriculum) return;
    setBusy(true);
    setError("");
    const { error: upErr } = await supabase
      .from("programs")
      .update({
        curriculum_id: pickedCurriculum.id,
        curriculum: pickedCurriculum.name,
      })
      .eq("id", program.id)
      .eq("organization_id", org.id);
    if (upErr) {
      setBusy(false);
      setError(upErr.message ?? "Could not save the change.");
      return;
    }
    onSaved({
      programId: program.id,
      curriculum_id: pickedCurriculum.id,
      curriculum: pickedCurriculum.name,
    });
  }

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
          maxWidth: 580,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
              Change the class
            </h2>
            <p style={{ color: MUTED, fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              {describeProgram(program) || "this program"}
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

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Currently</label>
          <div style={{ ...readOnlyValue, color: INK }}>{currentName}</div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Change to</label>
          <select
            value={pickedId}
            onChange={(e) => setPickedId(e.target.value)}
            disabled={busy}
            style={{
              width: "100%",
              padding: "9px 11px",
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              fontFamily: "inherit",
              background: "#fff",
              color: INK,
            }}
          >
            <option value="">Pick a class…</option>
            {curricula.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.id === currentId ? " (current)" : ""}
              </option>
            ))}
          </select>
          {curricula.length === 0 && (
            <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>
              No published classes in your library yet. Add one in Curricula first.
            </div>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>What this touches</label>
          {impact.loading ? (
            <div style={{ color: MUTED, fontSize: 13, padding: "8px 0" }}>Checking…</div>
          ) : (
            <ul style={{ margin: 0, padding: "4px 0 0 18px", color: INK, fontSize: 13, lineHeight: 1.7 }}>
              <li>
                <strong>{enrolled}</strong> enrolled famil{enrolled === 1 ? "y" : "ies"}
                {enrolled > 0 && " — they'll see the new class name in their account and confirmations."}
              </li>
              <li>
                <strong>{impact.assignments}</strong> instructor confirmation{impact.assignments === 1 ? "" : "s"}
                {impact.assignments > 0 && " — the instructor's schedule will show the new class name."}
              </li>
              {impact.deliveries > 0 && (
                <li>
                  <strong>{impact.deliveries}</strong> past session{impact.deliveries === 1 ? "" : "s"} already logged — those will be re-labeled in your records.
                </li>
              )}
              <li style={{ color: MUTED }}>
                Marketing emails don't auto-update — review any scheduled sends manually.
              </li>
            </ul>
          )}
        </div>

        {changed && pickedCurriculum && enrolled > 0 && (
          <div
            style={{
              background: SOFT_AMBER_BG,
              border: `1px solid ${SOFT_AMBER_BORDER}`,
              color: SOFT_AMBER_INK,
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: 1.5,
              marginBottom: 12,
            }}
          >
            Heads up — <strong>{enrolled}</strong> famil{enrolled === 1 ? "y has" : "ies have"} already signed up for{" "}
            <strong>{currentName}</strong>. They'll see <strong>{pickedCurriculum.name}</strong> instead after you save.
            Consider sending them a note.
          </div>
        )}

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
            Not now
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !changed}
            style={{
              padding: "9px 14px",
              border: "none",
              background: PURPLE,
              color: "#fff",
              borderRadius: 6,
              cursor: busy ? "wait" : !changed ? "not-allowed" : "pointer",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              opacity: !changed ? 0.5 : 1,
            }}
          >
            {busy ? "Saving…" : "Save change"}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: 11,
  fontWeight: 700,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const readOnlyValue = {
  padding: "9px 11px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 14,
  background: "#fafaf5",
};
