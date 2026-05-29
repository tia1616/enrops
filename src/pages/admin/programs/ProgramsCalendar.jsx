// /admin/programs
// Calendar/list view of scheduled programs for a selected term.
// Row-level "Change class" affordance lets an admin swap a program's curriculum.
// Live enrollment count = registrations.payment_status='paid' (excluding cancelled).
// Multi-tenant: scoped by the caller's organization_id.
//
// Two view modes:
//   - calendar: programs grouped by day-of-week, sorted by start_time (default)
//   - by_school: programs grouped by program_location, sorted by day/time within school

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import EditProgramCurriculumModal from "./EditProgramCurriculumModal.jsx";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const TERM_OPTIONS = [
  { value: "FA26", label: "Fall 2026 (FA26)" },
  { value: "WI27", label: "Winter 2027 (WI27)" },
  { value: "SP27", label: "Spring 2027 (SP27)" },
];

const DAYS_OF_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABELS = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

export default function ProgramsCalendar() {
  const { org } = useOutletContext();
  const [term, setTerm] = useState("FA26");
  const [viewMode, setViewMode] = useState("calendar");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [programs, setPrograms] = useState([]);
  const [enrollmentByProgram, setEnrollmentByProgram] = useState({});
  const [curricula, setCurricula] = useState([]);
  const [editingProgram, setEditingProgram] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      const { data: cRows } = await supabase
        .from("curricula")
        .select("id, name")
        .eq("organization_id", org.id)
        .eq("status", "published")
        .order("name");
      if (mounted) setCurricula(cRows ?? []);
    })();
    return () => { mounted = false; };
  }, [org?.id]);

  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        // Programs for this term, joined to location for school name
        const { data: progRows, error: progErr } = await supabase
          .from("programs")
          .select(`
            id, curriculum, curriculum_id, day_of_week, start_time, end_time, room,
            max_capacity, status, instructor_name, price_cents,
            program_location_id,
            program_locations (id, name, district)
          `)
          .eq("organization_id", org.id)
          .eq("term", term);
        if (progErr) throw progErr;

        const progIds = (progRows ?? []).map((p) => p.id);

        // Enrollment counts segmented by payment_status (paid headline, others smaller)
        // Only un-cancelled rows count.
        let enrollment = {};
        if (progIds.length > 0) {
          const { data: regRows, error: regErr } = await supabase
            .from("registrations")
            .select("program_id, status, payment_status")
            .in("program_id", progIds)
            .is("cancelled_at", null);
          if (regErr) throw regErr;
          for (const r of regRows ?? []) {
            const e = enrollment[r.program_id] ??= { paid: 0, unpaid: 0, pending: 0 };
            if (r.payment_status === "paid") e.paid++;
            else if (r.status === "confirmed") e.unpaid++;
            else e.pending++;
          }
        }

        if (mounted) {
          setPrograms(progRows ?? []);
          setEnrollmentByProgram(enrollment);
        }
      } catch (e) {
        if (mounted) setError(e.message ?? String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [org?.id, term]);

  const totals = useMemo(() => {
    let paid = 0, unpaid = 0, pending = 0, capacity = 0;
    for (const p of programs) {
      const e = enrollmentByProgram[p.id] ?? { paid: 0, unpaid: 0, pending: 0 };
      paid += e.paid;
      unpaid += e.unpaid;
      pending += e.pending;
      capacity += (p.max_capacity ?? 0);
    }
    // "Enrolled" = seats committed (paid OR confirmed-unpaid, e.g. VIP on installments).
    // Pending = incomplete checkouts; not counted as seats held.
    return { paid, unpaid, pending, capacity, programCount: programs.length, enrolled: paid + unpaid };
  }, [programs, enrollmentByProgram]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Scheduled programs</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            What's running this term, by day or by school. Live enrollment numbers.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select value={term} onChange={(e) => setTerm(e.target.value)} style={selectStyle}>
            {TERM_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          <div style={toggleGroup}>
            <button onClick={() => setViewMode("calendar")} style={viewMode === "calendar" ? toggleBtnActive : toggleBtn}>Calendar</button>
            <button onClick={() => setViewMode("by_school")} style={viewMode === "by_school" ? toggleBtnActive : toggleBtn}>By school</button>
          </div>
        </div>
      </div>

      {!loading && !error && programs.length > 0 && (
        <div style={summaryBar}>
          <div><strong>{totals.programCount}</strong> programs</div>
          <div>
            <strong>{totals.enrolled}</strong> enrolled <span style={{ color: MUTED }}>/ {totals.capacity} seats</span>
            {totals.enrolled > 0 && (
              <span style={{ color: MUTED, fontSize: 12, marginLeft: 8 }}>
                ({totals.paid} paid{totals.unpaid > 0 ? ` · ${totals.unpaid} on installments` : ""})
              </span>
            )}
          </div>
          {totals.pending > 0 && <div style={{ color: MUTED }}>+{totals.pending} pending</div>}
        </div>
      )}

      {loading && <div style={{ color: MUTED, padding: 12 }}>Loading {term} programs…</div>}
      {error && <div style={errorBox}>Could not load programs: {error}</div>}
      {!loading && !error && programs.length === 0 && (
        <div style={emptyState}>No programs scheduled for {term} yet.</div>
      )}

      {!loading && !error && programs.length > 0 && (
        viewMode === "calendar"
          ? <CalendarView programs={programs} enrollment={enrollmentByProgram} onEdit={setEditingProgram} />
          : <BySchoolView programs={programs} enrollment={enrollmentByProgram} onEdit={setEditingProgram} />
      )}

      {editingProgram && (
        <EditProgramCurriculumModal
          program={editingProgram}
          org={org}
          curricula={curricula}
          enrollment={enrollmentByProgram[editingProgram.id]}
          onCancel={() => setEditingProgram(null)}
          onSaved={({ programId, curriculum_id, curriculum }) => {
            setPrograms((prev) =>
              prev.map((p) =>
                p.id === programId ? { ...p, curriculum_id, curriculum } : p
              )
            );
            setEditingProgram(null);
          }}
        />
      )}
    </div>
  );
}

// ---- Views ----

function CalendarView({ programs, enrollment, onEdit }) {
  const byDay = useMemo(() => {
    const map = Object.fromEntries(DAYS_OF_WEEK.map((d) => [d, []]));
    for (const p of programs) {
      const day = (p.day_of_week ?? "").toLowerCase();
      if (map[day]) map[day].push(p);
    }
    for (const day of Object.keys(map)) {
      map[day].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
    }
    return map;
  }, [programs]);

  return (
    <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8 }}>
      {DAYS_OF_WEEK.filter((d) => byDay[d].length > 0).map((day, dayIdx, visibleDays) => (
        <div key={day}>
          <div style={{
            padding: "10px 16px 8px",
            background: "#fafaf5",
            borderTop: dayIdx === 0 ? "none" : `1px solid ${RULE}`,
            borderBottom: `1px solid ${RULE}`,
            fontSize: 13, fontWeight: 700, color: PURPLE,
            textTransform: "uppercase", letterSpacing: 0.5,
            display: "flex", alignItems: "center", gap: 8,
            position: "sticky", top: 0, zIndex: 1,
          }}>
            {DAY_LABELS[day]}
            <span style={{ color: MUTED, fontWeight: 400, fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
              · {byDay[day].length} program{byDay[day].length === 1 ? "" : "s"}
            </span>
          </div>
          {byDay[day].map((p) => <ProgramRow key={p.id} program={p} e={enrollment[p.id]} onEdit={onEdit} />)}
        </div>
      ))}
    </div>
  );
}

function BySchoolView({ programs, enrollment, onEdit }) {
  const bySchool = useMemo(() => {
    const map = {};
    for (const p of programs) {
      const key = p.program_locations?.name ?? "(no location)";
      (map[key] ??= []).push(p);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const dayCmp = DAYS_OF_WEEK.indexOf((a.day_of_week ?? "").toLowerCase()) - DAYS_OF_WEEK.indexOf((b.day_of_week ?? "").toLowerCase());
        if (dayCmp !== 0) return dayCmp;
        return (a.start_time ?? "").localeCompare(b.start_time ?? "");
      });
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [programs]);

  return (
    <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8 }}>
      {bySchool.map(([school, list], idx) => (
        <div key={school}>
          <div style={{
            padding: "10px 16px 8px",
            background: "#fafaf5",
            borderTop: idx === 0 ? "none" : `1px solid ${RULE}`,
            borderBottom: `1px solid ${RULE}`,
            fontSize: 13, fontWeight: 700, color: PURPLE,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            {school}
            <span style={{ color: MUTED, fontWeight: 400, fontSize: 12 }}>
              · {list.length} program{list.length === 1 ? "" : "s"}
            </span>
          </div>
          {list.map((p) => <ProgramRow key={p.id} program={p} e={enrollment[p.id]} onEdit={onEdit} showDay />)}
        </div>
      ))}
    </div>
  );
}

// ---- Card ----

function ProgramRow({ program: p, e, onEdit, showDay = false }) {
  const enr = e ?? { paid: 0, unpaid: 0, pending: 0 };
  const enrolled = enr.paid + enr.unpaid;
  const capacity = p.max_capacity ?? 0;
  const pct = capacity > 0 ? Math.min(1, enrolled / capacity) : 0;
  const isFull = capacity > 0 && enrolled >= capacity;
  const fillColor = isFull ? PURPLE : pct >= 0.7 ? VIOLET : "#a8c47f";

  const breakdownParts = [];
  if (enr.paid > 0) breakdownParts.push(`${enr.paid} paid`);
  if (enr.unpaid > 0) breakdownParts.push(`${enr.unpaid} on installments`);
  if (enr.pending > 0) breakdownParts.push(`+${enr.pending} pending`);
  const breakdown = breakdownParts.join(" · ");

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "70px 1fr 110px 90px 70px",
      gap: 14,
      alignItems: "center",
      padding: "10px 16px",
      borderBottom: `1px solid ${RULE}`,
      fontSize: 13,
    }}>
      {/* Time (or day + time when showDay) */}
      <div style={{ color: INK, fontWeight: 600, fontSize: 13 }}>
        {showDay && p.day_of_week && <div style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}>{DAY_LABELS[p.day_of_week.toLowerCase()]?.slice(0, 3) ?? p.day_of_week}</div>}
        {formatTime(p.start_time) || <span style={{ color: MUTED, fontWeight: 400 }}>—</span>}
      </div>

      {/* Curriculum + school + instructor */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: INK, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.curriculum ?? "Untitled"}
        </div>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
          {!showDay && p.program_locations?.name ? p.program_locations.name : ""}
          {!showDay && p.program_locations?.name && p.instructor_name ? " · " : ""}
          {p.instructor_name ? p.instructor_name : ""}
          {showDay && p.instructor_name ? p.instructor_name : ""}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 8, background: "#f0eee5", borderRadius: 4, overflow: "hidden", position: "relative" }}>
        <div style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: fillColor,
          transition: "width 0.3s",
        }} />
      </div>

      {/* Count + breakdown */}
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
          {enrolled}<span style={{ color: MUTED, fontWeight: 400 }}>{capacity > 0 ? ` / ${capacity}` : ""}</span>
        </div>
        {breakdown && (
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{breakdown}</div>
        )}
      </div>

      {/* Edit affordance */}
      <div style={{ textAlign: "right" }}>
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(p)}
            style={editLinkStyle}
            title="Change the class for this program"
          >
            Change class
          </button>
        )}
      </div>
    </div>
  );
}

const editLinkStyle = {
  background: "transparent",
  border: "none",
  color: PURPLE,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  padding: "4px 6px",
  fontFamily: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

function formatTime(t) {
  if (!t) return "";
  // start_time is stored as text — may already be display-formatted ("2:35 PM"
  // / "3:00 PM") or raw 24-hour ("14:35" / "15:00"). Handle both.
  if (/[ap]\s?m/i.test(t)) {
    return t.toLowerCase().replace(/\s+/g, "");
  }
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

// ---- Styles ----

const selectStyle = {
  padding: "7px 10px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
  background: "#fff",
  color: INK,
  cursor: "pointer",
};

const toggleGroup = {
  display: "inline-flex",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  overflow: "hidden",
};

const toggleBtn = {
  padding: "7px 12px",
  background: "#fff",
  color: INK,
  border: "none",
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
  fontWeight: 500,
};

const toggleBtnActive = {
  ...toggleBtn,
  background: PURPLE,
  color: "#fff",
};

const summaryBar = {
  display: "flex",
  gap: 18,
  alignItems: "center",
  padding: "10px 14px",
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  marginBottom: 14,
  fontSize: 13,
  color: INK,
};

const dayColumn = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: 12,
};

const dayHeader = {
  fontSize: 13,
  fontWeight: 600,
  color: PURPLE,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 10,
  paddingBottom: 8,
  borderBottom: `1px solid ${RULE}`,
};

const schoolHeader = {
  fontSize: 14,
  fontWeight: 700,
  color: PURPLE,
  marginBottom: 8,
};

const cardStyle = {
  background: "#fafaf5",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  padding: 10,
};

const errorBox = {
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  padding: 12,
  fontSize: 13,
};

const emptyState = {
  background: PANEL,
  border: `1px dashed ${RULE}`,
  borderRadius: 8,
  padding: 28,
  textAlign: "center",
  color: MUTED,
  fontSize: 14,
};
