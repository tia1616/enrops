// ClassScheduleView — the shared read/assign view of a tenant's weekly
// class_schedule, used by BOTH surfaces:
//   - the Class schedule (upload) page   → assignable={false}, read-only list
//   - the Instructor scheduling surface   → assignable={true}, assign a coach per
//                                            class (this is where assignment lives
//                                            for every tenant, per platform usage)
//
// Self-contained: loads its own class_schedule rows (+ the instructor roster when
// assignable). Org comes in as a prop; never hardcoded. RLS scopes reads/writes.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { PURPLE, BRIGHT, INK, MUTED, RULE } from "./marketing/tokens.jsx";

const CREAM = "#FBFBFB";
const RED = "#b53737";
const DAY_ORDER = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const listCell = { padding: "8px 10px", borderBottom: `1px solid ${RULE}`, color: INK, verticalAlign: "top" };

function ageRange(r) {
  if (r.age_min == null && r.age_max == null) return "";
  if (r.age_min != null && r.age_max != null) return `${r.age_min}–${r.age_max}`;
  return `${r.age_min ?? r.age_max}`;
}
function instructorLabel(ins) {
  return [ins.first_name, ins.last_name].filter(Boolean).join(" ").trim() || "(unnamed)";
}

export default function ClassScheduleView({ orgId, assignable = false, refreshKey = 0, emptyHint = true }) {
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState(null);
  const [instructors, setInstructors] = useState([]);
  const [assignErr, setAssignErr] = useState("");

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      setRows(null); setErr(null);
      const { data, error } = await supabase
        .from("class_schedule")
        .select("id, title, day_of_week, start_time, end_time, location_text, instructor_name, instructor_id, age_min, age_max, capacity")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) { setErr(error.message); setRows([]); return; }
      setRows(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [orgId, refreshKey]);

  useEffect(() => {
    if (!orgId || !assignable) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("instructors")
        .select("id, first_name, last_name, is_active")
        .eq("organization_id", orgId)
        .order("first_name", { ascending: true });
      if (!cancelled) setInstructors(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [orgId, assignable, refreshKey]);

  async function assignInstructor(rowId, instructorId) {
    const prior = rows?.find((r) => r.id === rowId)?.instructor_id ?? null;
    const next = instructorId || null;
    setAssignErr("");
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, instructor_id: next } : r)));
    const { error } = await supabase.from("class_schedule").update({ instructor_id: next }).eq("id", rowId);
    if (error) {
      setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, instructor_id: prior } : r)));
      setAssignErr("Couldn't save that instructor. Please try again.");
    }
  }

  const activeInstructors = useMemo(() => instructors.filter((i) => i.is_active !== false), [instructors]);

  const byDay = useMemo(() => {
    if (!rows) return [];
    const sorted = [...rows].sort((a, b) =>
      ((DAY_ORDER[a.day_of_week] ?? 9) - (DAY_ORDER[b.day_of_week] ?? 9)) ||
      (a.start_time || "").localeCompare(b.start_time || "") ||
      (a.title || "").localeCompare(b.title || ""));
    const groups = [];
    for (const r of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.day === r.day_of_week) last.items.push(r);
      else groups.push({ day: r.day_of_week, items: [r] });
    }
    return groups;
  }, [rows]);

  if (rows === null) return <div style={{ color: MUTED, fontSize: 14, padding: 12 }}>Loading schedule…</div>;
  if (err) return <div style={{ color: RED, fontSize: 13, padding: 12 }}>Couldn&apos;t load your schedule. Refresh and try again.</div>;
  if (rows.length === 0) {
    if (!emptyHint) return null;
    return (
      <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 24, textAlign: "center", color: MUTED }}>
        No classes yet. Upload your weekly schedule to build it.
      </div>
    );
  }

  const cols = assignable ? ["Class", "Time", "Location", "Instructor", "Ages", "Cap"] : ["Class", "Time", "Location", "Instructor", "Ages", "Cap"];

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
      {assignable && activeInstructors.length === 0 && (
        <div style={{ background: `${PURPLE}08`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: "10px 12px", marginBottom: 12, fontSize: 12.5, color: INK }}>
          Add people to your <Link to="/admin/instructors" style={{ color: BRIGHT, fontWeight: 600 }}>instructor roster</Link> to assign them to these classes.
        </div>
      )}
      {assignErr && <div style={{ fontSize: 12, color: RED, marginBottom: 8 }}>{assignErr}</div>}
      <div style={{ overflowX: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
          <thead>
            <tr>
              {cols.map((h) => (
                <th key={h} style={{ position: "sticky", top: 0, background: CREAM, textAlign: "left", padding: "8px 10px", color: MUTED, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap", borderBottom: `1px solid ${RULE}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byDay.map((g) => (
              <Fragment key={`day-${g.day}`}>
                <tr>
                  <td colSpan={6} style={{ padding: "8px 10px", background: `${PURPLE}0A`, color: PURPLE, fontWeight: 700, fontSize: 12, borderBottom: `1px solid ${RULE}` }}>{g.day}</td>
                </tr>
                {g.items.map((r) => {
                  const time = [r.start_time, r.end_time].filter(Boolean).join(" – ");
                  const showUploadHint = !r.instructor_id && r.instructor_name;
                  const options = [...activeInstructors];
                  if (r.instructor_id && !options.some((i) => i.id === r.instructor_id)) {
                    const assigned = instructors.find((i) => i.id === r.instructor_id);
                    if (assigned) options.unshift(assigned);
                  }
                  const assignedName = r.instructor_id
                    ? instructorLabel(instructors.find((i) => i.id === r.instructor_id) || {})
                    : "";
                  return (
                    <tr key={r.id}>
                      <td style={listCell}><strong>{r.title}</strong></td>
                      <td style={listCell}>{time || <span style={{ color: MUTED }}>—</span>}</td>
                      <td style={listCell}>{r.location_text || <span style={{ color: MUTED }}>—</span>}</td>
                      <td style={listCell}>
                        {assignable ? (
                          <>
                            <select value={r.instructor_id || ""} onChange={(e) => assignInstructor(r.id, e.target.value)}
                              style={{ maxWidth: 160, padding: "3px 6px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit", background: "#fff", color: INK }}>
                              <option value="">Unassigned</option>
                              {options.map((i) => <option key={i.id} value={i.id}>{instructorLabel(i)}</option>)}
                            </select>
                            {showUploadHint && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>from upload: {r.instructor_name}</div>}
                          </>
                        ) : (
                          assignedName || r.instructor_name || <span style={{ color: MUTED }}>—</span>
                        )}
                      </td>
                      <td style={listCell}>{ageRange(r) || <span style={{ color: MUTED }}>—</span>}</td>
                      <td style={listCell}>{r.capacity ?? <span style={{ color: MUTED }}>—</span>}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
