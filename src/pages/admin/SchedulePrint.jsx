// src/pages/admin/SchedulePrint.jsx
// Printable instructor schedule for the materials coordinator.
// Toggle between "by instructor" (one section per person) and "by week"
// (one section per week). Filters to committed assignments only — accepted,
// confirmed, or published offers. Excludes proposed drafts, change-requested,
// and withdrawn. Use the browser's Print → Save as PDF to email it.
// Multi-tenant: all data RLS-scoped by org via outlet context.

import React, { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const DAY_SHORT = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };
const SESSION_TIME_LABEL = { morning: "Morning", afternoon: "Afternoon", full_day: "Full day", after_school: "After-school" };
// Statuses the materials coordinator should prep for. The offer is locked in
// or the instructor has actively accepted. Excludes proposed/change_requested/withdrawn.
const COMMITTED_STATUSES = ["confirmed", "published"];

function fmtRange(startStr, endStr) {
  if (!startStr || !endStr) return "";
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  const sameYear = start.getFullYear() === end.getFullYear();
  const left = start.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "long", day: "numeric", year: "numeric" });
  const right = end.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return `${left} – ${right}`;
}

function fmtShort(dateStr) {
  if (!dateStr) return "";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "am" : "pm";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

function fmtTimeRange(start, end) {
  if (!start || !end) return "";
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

function classDaysSummary(class_days) {
  if (!Array.isArray(class_days) || class_days.length === 0) return "";
  const order = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const sorted = [...class_days].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (sorted.length === 5 && sorted.every((d, i) => d === order[i])) return "Mon–Fri";
  return sorted.map((d) => DAY_SHORT[d] ?? d).join(", ");
}

function fmtPrintedAt() {
  const now = new Date();
  return now.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

export default function SchedulePrint() {
  const { org } = useOutletContext() ?? {};
  const [params] = useSearchParams();
  const requestedCycleId = params.get("cycle");
  const [view, setView] = useState("instructor"); // "instructor" | "week"
  const [state, setState] = useState({ status: "loading" });

  // Sets the browser tab + "Save as PDF" suggested filename to "Camp Schedule".
  useEffect(() => {
    const prev = document.title;
    document.title = "Camp Schedule";
    return () => { document.title = prev; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!org?.id) return;
      try {
        const { data: cyclesList, error: cyclesErr } = await supabase
          .from("scheduling_cycles")
          .select("id, name, cycle_type, starts_on, ends_on, weeks, status")
          .eq("organization_id", org.id)
          .neq("status", "archived")
          .order("starts_on", { ascending: false, nullsFirst: false });
        if (cyclesErr) throw cyclesErr;
        if (!alive) return;
        if (!cyclesList || cyclesList.length === 0) { setState({ status: "empty" }); return; }

        const cycle = requestedCycleId
          ? (cyclesList.find((c) => c.id === requestedCycleId) ?? cyclesList[0])
          : cyclesList[0];

        const sessionsRes = await supabase
          .from("camp_sessions")
          .select("id, location_name, week_num, session_type, curriculum_category, curriculum_name, start_time, end_time, current_enrollment, class_days, status")
          .eq("cycle_id", cycle.id)
          .eq("status", "active");
        if (sessionsRes.error) throw sessionsRes.error;
        const sessions = sessionsRes.data ?? [];
        const sessionIds = sessions.map((s) => s.id);

        const assignmentsRes = sessionIds.length
          ? await supabase
              .from("camp_assignments")
              .select("id, camp_session_id, status, role, instructor:instructors(id, first_name, last_name)")
              .in("camp_session_id", sessionIds)
              .in("status", COMMITTED_STATUSES)
          : { data: [], error: null };
        if (assignmentsRes.error) throw assignmentsRes.error;

        const assignments = (assignmentsRes.data ?? []).map((a) => ({
          id: a.id,
          camp_session_id: a.camp_session_id,
          status: a.status,
          role: a.role ?? "lead",
          instructor_id: a.instructor?.id ?? null,
          instructor_first: a.instructor?.first_name ?? "",
          instructor_last: a.instructor?.last_name ?? "",
        })).filter((a) => a.instructor_id); // only assignments with an actual instructor

        if (!alive) return;
        setState({ status: "ready", cycle, sessions, assignments });
      } catch (err) {
        console.error("SchedulePrint load error:", err);
        if (alive) setState({ status: "error", message: err.message ?? "Could not load schedule." });
      }
    })();
    return () => { alive = false; };
  }, [org?.id, requestedCycleId]);

  // Map session_id -> session for fast lookup, and merge into assignment rows.
  const rows = useMemo(() => {
    if (state.status !== "ready") return [];
    const sById = new Map(state.sessions.map((s) => [s.id, s]));
    const weeks = Array.isArray(state.cycle.weeks) ? state.cycle.weeks : [];
    const wByNum = new Map(weeks.map((w) => [w.num, w]));
    return state.assignments
      .map((a) => {
        const session = sById.get(a.camp_session_id);
        if (!session) return null;
        const wk = wByNum.get(session.week_num);
        return {
          ...a,
          session,
          week: wk ?? { num: session.week_num, starts_on: null, ends_on: null },
        };
      })
      .filter(Boolean);
  }, [state]);

  // Group helpers
  const byInstructor = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.instructor_id;
      const display = `${r.instructor_first} ${r.instructor_last}`.trim() || "Unknown";
      if (!map.has(key)) map.set(key, { name: display, rows: [] });
      map.get(key).rows.push(r);
    }
    // Sort instructors A→Z by name; sort each instructor's rows by week then time then location.
    const sorted = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const g of sorted) {
      g.rows.sort((a, b) => {
        if (a.session.week_num !== b.session.week_num) return a.session.week_num - b.session.week_num;
        if ((a.session.start_time ?? "") !== (b.session.start_time ?? "")) return (a.session.start_time ?? "").localeCompare(b.session.start_time ?? "");
        return (a.session.location_name ?? "").localeCompare(b.session.location_name ?? "");
      });
    }
    return sorted;
  }, [rows]);

  const byWeek = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.session.week_num;
      if (!map.has(key)) map.set(key, { num: key, starts_on: r.week.starts_on, ends_on: r.week.ends_on, rows: [] });
      map.get(key).rows.push(r);
    }
    const sorted = [...map.values()].sort((a, b) => a.num - b.num);
    for (const g of sorted) {
      g.rows.sort((a, b) => {
        if ((a.session.location_name ?? "") !== (b.session.location_name ?? "")) return (a.session.location_name ?? "").localeCompare(b.session.location_name ?? "");
        if ((a.session.start_time ?? "") !== (b.session.start_time ?? "")) return (a.session.start_time ?? "").localeCompare(b.session.start_time ?? "");
        const an = `${a.instructor_first} ${a.instructor_last}`.trim();
        const bn = `${b.instructor_first} ${b.instructor_last}`.trim();
        return an.localeCompare(bn);
      });
    }
    return sorted;
  }, [rows]);

  if (state.status === "loading") {
    return <div style={{ padding: 24, color: MUTED }}>Loading schedule…</div>;
  }
  if (state.status === "error") {
    return <div style={{ padding: 24, color: "#a32" }}>Couldn't load schedule: {state.message}</div>;
  }
  if (state.status === "empty") {
    return <div style={{ padding: 24, color: MUTED }}>No scheduling cycles yet. Create one from the Schedule page first.</div>;
  }

  const { cycle } = state;
  const instructorCount = byInstructor.length;
  const campCount = rows.length;
  const hasData = rows.length > 0;

  return (
    <div data-print-wrap style={{ padding: "24px 28px", maxWidth: 980, margin: "0 auto", color: INK, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Print-only CSS: hide the AdminLayout sidebar + topbar so the printed PDF
          contains only the schedule. Also tighten margins for A4/Letter. */}
      <style>{`
        @media print {
          @page { size: letter; margin: 0.5in; }
          body { background: white !important; }
          [data-admin-sidebar], [data-screen-only] { display: none !important; }
          [data-admin-grid] { grid-template-columns: 1fr !important; }
          [data-admin-main] { padding: 0 !important; max-width: none !important; }
          [data-print-wrap] { padding: 0 !important; max-width: none !important; }
          /* Let long sections flow across pages; just keep individual rows + headings tidy.
             page-break-inside: avoid on whole sections was pushing the last (August)
             section onto a fresh page and leaving big whitespace behind. */
          tr { page-break-inside: avoid; }
          h2 { page-break-after: avoid; }
          .print-instructor + .print-instructor, .print-week + .print-week { margin-top: 18px; }
          a { color: inherit; text-decoration: none; }
        }
      `}</style>

      <div data-screen-only style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Link to="/admin/schedule" style={{ color: PURPLE, fontSize: 14, textDecoration: "none" }}>← Back to schedule</Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div role="tablist" aria-label="Group by" style={{ display: "inline-flex", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
            <button
              type="button"
              role="tab"
              aria-selected={view === "instructor"}
              onClick={() => setView("instructor")}
              style={tabBtn(view === "instructor")}
            >
              By instructor
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "week"}
              onClick={() => setView("week")}
              style={tabBtn(view === "week")}
            >
              By week
            </button>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            style={{
              background: BRIGHT,
              color: "#fff",
              border: "none",
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      <header style={{ borderBottom: `2px solid ${PURPLE}`, paddingBottom: 12, marginBottom: 20 }}>
        <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: MUTED, fontWeight: 600 }}>
          {org?.name ?? ""} · Instructor schedule
        </div>
        <h1 style={{ margin: "4px 0 6px", fontSize: 24, color: PURPLE, fontWeight: 700 }}>
          {cycle.name}
        </h1>
        <div style={{ fontSize: 14, color: INK }}>
          {fmtRange(cycle.starts_on, cycle.ends_on)} · {instructorCount} instructor{instructorCount === 1 ? "" : "s"} · {campCount} assignment{campCount === 1 ? "" : "s"}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
          Printed {fmtPrintedAt()} · Committed assignments only (excludes drafts, change requests, and withdrawn)
        </div>
      </header>

      {!hasData && (
        <div style={{ color: MUTED, fontSize: 14, padding: 24, textAlign: "center", border: `1px dashed ${RULE}`, borderRadius: 8 }}>
          No committed assignments yet. Approve the draft and send offers from the Schedule page first.
        </div>
      )}

      {hasData && view === "instructor" && (
        <div>
          {byInstructor.map((grp) => (
            <section key={grp.name} className="print-section print-instructor" style={{ marginBottom: 22 }}>
              <h2 style={{ fontSize: 17, color: PURPLE, margin: "0 0 8px", borderBottom: `1px solid ${RULE}`, paddingBottom: 4 }}>
                {grp.name}
                <span style={{ color: MUTED, fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                  · {grp.rows.length} camp{grp.rows.length === 1 ? "" : "s"}
                </span>
              </h2>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <Th style={{ width: "13%" }}>Week</Th>
                    <Th style={{ width: "22%" }}>Location</Th>
                    <Th>Curriculum</Th>
                    <Th style={{ width: "14%" }}>Time</Th>
                    <Th style={{ width: "9%", textAlign: "right" }}>Students</Th>
                    <Th style={{ width: "8%" }}>Role</Th>
                  </tr>
                </thead>
                <tbody>
                  {grp.rows.map((r) => (
                    <SessionRow key={r.id} row={r} />
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}

      {hasData && view === "week" && (
        <div>
          {byWeek.map((grp) => (
            <section key={grp.num} className="print-section print-week" style={{ marginBottom: 22 }}>
              <h2 style={{ fontSize: 17, color: PURPLE, margin: "0 0 8px", borderBottom: `1px solid ${RULE}`, paddingBottom: 4 }}>
                Week {grp.num}
                {grp.starts_on && grp.ends_on && (
                  <span style={{ color: MUTED, fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                    · {fmtShort(grp.starts_on)} – {fmtShort(grp.ends_on)}
                  </span>
                )}
                <span style={{ color: MUTED, fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                  · {grp.rows.length} camp{grp.rows.length === 1 ? "" : "s"}
                </span>
              </h2>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <Th style={{ width: "22%" }}>Location</Th>
                    <Th style={{ width: "22%" }}>Instructor</Th>
                    <Th>Curriculum</Th>
                    <Th style={{ width: "14%" }}>Time</Th>
                    <Th style={{ width: "9%", textAlign: "right" }}>Students</Th>
                    <Th style={{ width: "8%" }}>Role</Th>
                  </tr>
                </thead>
                <tbody>
                  {grp.rows.map((r) => (
                    <WeekRow key={r.id} row={r} />
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({ row }) {
  const s = row.session;
  const w = row.week;
  return (
    <tr style={rowStyle}>
      <Td>
        <div style={{ fontWeight: 600 }}>Wk {s.week_num}</div>
        {w?.starts_on && w?.ends_on && (
          <div style={{ color: MUTED, fontSize: 12 }}>{fmtShort(w.starts_on)} – {fmtShort(w.ends_on)}</div>
        )}
      </Td>
      <Td>{s.location_name ?? "—"}</Td>
      <Td>
        <div>{s.curriculum_name ?? "—"}</div>
        {s.curriculum_category && (
          <div style={{ color: MUTED, fontSize: 12 }}>{s.curriculum_category}</div>
        )}
      </Td>
      <Td>
        <div>{fmtTimeRange(s.start_time, s.end_time) || (SESSION_TIME_LABEL[s.session_type] ?? "—")}</div>
        <div style={{ color: MUTED, fontSize: 12 }}>{classDaysSummary(s.class_days)}</div>
      </Td>
      <Td style={{ textAlign: "right" }}>{s.current_enrollment ?? "—"}</Td>
      <Td>{row.role === "developing" ? "Developing" : "Lead"}</Td>
    </tr>
  );
}

function WeekRow({ row }) {
  const s = row.session;
  return (
    <tr style={rowStyle}>
      <Td>{s.location_name ?? "—"}</Td>
      <Td>{`${row.instructor_first} ${row.instructor_last}`.trim() || "—"}</Td>
      <Td>
        <div>{s.curriculum_name ?? "—"}</div>
        {s.curriculum_category && (
          <div style={{ color: MUTED, fontSize: 12 }}>{s.curriculum_category}</div>
        )}
      </Td>
      <Td>
        <div>{fmtTimeRange(s.start_time, s.end_time) || (SESSION_TIME_LABEL[s.session_type] ?? "—")}</div>
        <div style={{ color: MUTED, fontSize: 12 }}>{classDaysSummary(s.class_days)}</div>
      </Td>
      <Td style={{ textAlign: "right" }}>{s.current_enrollment ?? "—"}</Td>
      <Td>{row.role === "developing" ? "Developing" : "Lead"}</Td>
    </tr>
  );
}

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const rowStyle = {
  borderTop: `1px solid ${RULE}`,
  verticalAlign: "top",
};

function Th({ children, style }) {
  return (
    <th
      style={{
        textAlign: "left",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: MUTED,
        fontWeight: 600,
        padding: "6px 6px",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }) {
  return (
    <td style={{ padding: "8px 6px", ...style }}>
      {children}
    </td>
  );
}

function tabBtn(active) {
  return {
    background: active ? PURPLE : "transparent",
    color: active ? "#fff" : PURPLE,
    border: "none",
    padding: "7px 12px",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  };
}
