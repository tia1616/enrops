// src/pages/admin/ClassReports.jsx
// /admin/class-reports — the admin safety/compliance view over attendance_records
// (Attendance + Dismissal Log, Chunk C). Per class → per term: a daily grid of who
// was present and who each child was released to, LEADING with the compliance
// highlights that make this a safety tool (undismissed kids, releases to someone
// not on the authorized list, do-not-release name hits, missing check-ins).
//
// Multi-tenant: org from outlet context; every query is scoped by org.id and
// backed by RLS on attendance_records / registrations / students / student_contacts.
// Term is programs.term; the selector is derived from the data so it scales as
// terms accumulate (archive = filter to an older term, never a delete). Camps are
// week-scoped, so they list by session rather than by term.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import Chevron from "../../components/Chevron.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CREAM = "#FBFBFB";
const OK = "#3a7c3a";
const AMBER = "#b67e00";
const RED = "#b53737";

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Term codes are <season><2-digit year>, e.g. FA26 = Fall 2026, WI27 = Winter
// 2027 (winter falls in the calendar year AFTER fall). Sort CHRONOLOGICALLY, not
// alphabetically (else WI27 sorts before FA26 and the report opens on the wrong
// term). Key = the term's start month as YYYYMM.
const TERM_START_MONTH = { WI: 1, SP: 4, SU: 7, FA: 9 };
function termKey(t) {
  const m = /^([A-Za-z]{2})(\d{2})$/.exec(t || "");
  if (!m) return 0;
  return (2000 + Number(m[2])) * 100 + (TERM_START_MONTH[m[1].toUpperCase()] ?? 0);
}
// Default to the term in progress or next up; if all terms are past, the latest.
function currentTerm(terms) {
  if (!terms || terms.length === 0) return null;
  const now = new Date();
  const todayKey = now.getFullYear() * 100 + (now.getMonth() + 1);
  const upcoming = terms.filter((t) => termKey(t) >= todayKey).sort((a, b) => termKey(a) - termKey(b));
  if (upcoming.length) return upcoming[0];
  return [...terms].sort((a, b) => termKey(b) - termKey(a))[0];
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function fmtDay(dateStr) {
  if (!dateStr) return "";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}

// Camp meeting dates: every date in [startsOn, endsOn] whose weekday is in class_days.
function campMeetingDates(startsOn, endsOn, classDays) {
  if (!startsOn || !endsOn) return [];
  const days = new Set((classDays ?? []).map((d) => String(d).toLowerCase()));
  // Unknown class_days → don't fabricate a schedule (would invent weekend meeting
  // days + false "missing check-in" flags). Fall back to recorded dates only.
  if (days.size === 0) return [];
  const out = [];
  const cur = new Date(`${startsOn}T00:00:00`);
  const end = new Date(`${endsOn}T00:00:00`);
  let guard = 0;
  while (cur <= end && guard < 400) {
    if (days.has(DOW[cur.getDay()])) {
      out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
    }
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return out;
}

const nm = (c) => `${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim();
const instructorName = (i) =>
  i ? (i.preferred_name?.trim() || `${i.first_name ?? ""} ${i.last_name ?? ""}`.trim()) : "";

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  // Neutralize spreadsheet formula injection: a cell starting with = + - @ (or a
  // control char) is evaluated by Excel/Sheets. Contact names + notes are
  // user-entered, so prefix a quote to force text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function ClassReports() {
  const { org } = useOutletContext() ?? {};
  const [view, setView] = useState("afterschool"); // 'afterschool' | 'camps'

  return (
    <div>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          Class Reports
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 14 }}>
          Attendance and dismissal for each class, day by day. Leads with safety flags — children not yet dismissed,
          releases to someone off the authorized list, do-not-release names, and missing check-ins.
        </p>
      </header>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 18 }}>
        <TabBtn active={view === "afterschool"} onClick={() => setView("afterschool")} label="Afterschool" />
        <TabBtn active={view === "camps"} onClick={() => setView("camps")} label="Camps" />
      </div>

      {view === "afterschool" ? <AfterschoolReports org={org} /> : <CampReports org={org} />}
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none", background: "none", fontFamily: "inherit", fontSize: 14, fontWeight: 600,
        padding: "8px 14px", cursor: "pointer", color: active ? PURPLE : MUTED,
        borderBottom: active ? `2px solid ${PURPLE}` : "2px solid transparent", marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

// ── Afterschool: term-scoped program list ────────────────────────────────────
function AfterschoolReports({ org }) {
  const [terms, setTerms] = useState(null);
  const [term, setTerm] = useState(null);
  const [programs, setPrograms] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState("");

  // Terms present in the data, chronological (newest first). Default = the term
  // in progress / next up. Archive = pick an older term.
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error: e } = await supabase
        .from("programs").select("term").eq("organization_id", org.id).not("term", "is", null);
      if (cancelled) return;
      if (e) { setError("Couldn't load terms."); setTerms([]); return; }
      const uniq = [...new Set((data ?? []).map((r) => r.term).filter(Boolean))]
        .sort((a, b) => termKey(b) - termKey(a));
      setTerms(uniq);
      setTerm((cur) => cur ?? currentTerm(uniq));
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  useEffect(() => {
    if (!org?.id || !term) return;
    let cancelled = false;
    (async () => {
      setPrograms(null); setError("");
      const { data, error: e } = await supabase
        .from("programs")
        .select("id, curriculum, day_of_week, start_time, term, program_locations ( name )")
        .eq("organization_id", org.id).eq("term", term);
      if (cancelled) return;
      if (e) { setError("Couldn't load programs."); setPrograms([]); return; }
      setPrograms((data ?? []).sort((a, b) => (a.curriculum ?? "").localeCompare(b.curriculum ?? "")));
      setExpandedId(null);
    })();
    return () => { cancelled = true; };
  }, [org?.id, term]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: MUTED, display: "flex", alignItems: "center", gap: 8 }}>
          Term
          <select
            value={term ?? ""}
            onChange={(e) => setTerm(e.target.value)}
            disabled={!terms || terms.length === 0}
            style={{ padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", fontSize: 13, background: "#fff", color: INK }}
          >
            {(terms ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      {error && <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {(terms === null || programs === null) && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}
      {terms !== null && terms.length === 0 && (
        <EmptyCard>No afterschool terms yet. Reports appear once programs run.</EmptyCard>
      )}
      {programs !== null && programs.length === 0 && terms && terms.length > 0 && (
        <EmptyCard>No afterschool programs for {term}.</EmptyCard>
      )}
      {programs !== null && programs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {programs.map((p) => (
            <ClassCard
              key={p.id}
              title={p.curriculum || "Class"}
              subtitle={[p.program_locations?.name, p.start_time].filter(Boolean).join(" · ")}
              expanded={expandedId === p.id}
              onToggle={() => setExpandedId((c) => (c === p.id ? null : p.id))}
            >
              {expandedId === p.id && (
                <ClassReportPanel org={org} kind="program" classId={p.id} title={p.curriculum || "Class"} />
              )}
            </ClassCard>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Camps: week-scoped session list ──────────────────────────────────────────
function CampReports({ org }) {
  const [camps, setCamps] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setCamps(null); setError("");
      const { data, error: e } = await supabase
        .from("camp_sessions")
        .select("id, curriculum_name, starts_on, ends_on, class_days, week_num, location_name")
        .eq("organization_id", org.id)
        .order("starts_on", { ascending: false });
      if (cancelled) return;
      if (e) { setError("Couldn't load camps."); setCamps([]); return; }
      setCamps(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  return (
    <div>
      {error && <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {camps === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}
      {camps !== null && camps.length === 0 && !error && <EmptyCard>No camps yet.</EmptyCard>}
      {camps !== null && camps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {camps.map((c) => (
            <ClassCard
              key={c.id}
              title={c.curriculum_name || "Camp"}
              subtitle={[c.location_name, c.week_num ? `Week ${c.week_num}` : null, `${fmtDay(c.starts_on)}–${fmtDay(c.ends_on)}`].filter(Boolean).join(" · ")}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId((x) => (x === c.id ? null : c.id))}
            >
              {expandedId === c.id && (
                <ClassReportPanel
                  org={org} kind="camp" classId={c.id} title={c.curriculum_name || "Camp"}
                  campMeta={{ startsOn: c.starts_on, endsOn: c.ends_on, classDays: c.class_days }}
                />
              )}
            </ClassCard>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyCard({ children }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 20, color: MUTED, textAlign: "center", fontSize: 13 }}>
      {children}
    </div>
  );
}

function ClassCard({ title, subtitle, expanded, onToggle, children }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, overflow: "hidden" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{subtitle}</div>}
        </div>
        <Chevron open={expanded} />
      </button>
      {expanded && <div style={{ borderTop: `1px solid ${RULE}`, padding: "14px 16px" }}>{children}</div>}
    </div>
  );
}

// ── The report for one class ─────────────────────────────────────────────────
function ClassReportPanel({ org, kind, classId, title, campMeta }) {
  const [state, setState] = useState({ loading: true, error: "" });
  const [roster, setRoster] = useState([]); // [{ registration_id, student_id, name, pickups:[], doNotRelease:[] }]
  const [dates, setDates] = useState([]); // meeting dates (ISO)
  const [recByKey, setRecByKey] = useState({}); // `${student_id}|${date}` -> attendance row
  const [instructors, setInstructors] = useState({}); // id -> row
  const [selected, setSelected] = useState(null); // clicked grid cell -> detail panel

  useEffect(() => {
    if (!org?.id || !classId) return;
    let cancelled = false;
    (async () => {
      setState({ loading: true, error: "" });
      try {
        const filterCol = kind === "camp" ? "camp_session_id" : "program_id";

        // Roster (non-cancelled registrations + student).
        const { data: regs, error: rErr } = await supabase
          .from("registrations")
          .select("id, student_id, status, student:students ( id, first_name, last_name )")
          .eq(filterCol, classId)
          .not("status", "in", "(cancelled,withdrawn)");
        if (rErr) throw rErr;
        // Dedupe by student_id — a child with two active registrations for the
        // same class (e.g. an un-cancelled transfer) must be one roster row, or
        // the grid double-counts them and collides React keys.
        const seenStudent = new Set();
        const students = (regs ?? []).filter((r) => {
          if (!r.student?.id || seenStudent.has(r.student.id)) return false;
          seenStudent.add(r.student.id);
          return true;
        });
        const studentIds = [...seenStudent];

        // Structured contacts (authorized pickup + do-not-release) for compliance checks.
        const contactsByStudent = {};
        if (studentIds.length) {
          const { data: contacts } = await supabase
            .from("student_contacts")
            .select("student_id, role, first_name, last_name")
            .in("student_id", studentIds)
            .in("role", ["authorized_pickup", "do_not_release"]);
          for (const c of contacts ?? []) (contactsByStudent[c.student_id] ||= []).push(c);
        }

        // Attendance rows for the class.
        const { data: recs, error: aErr } = await supabase
          .from("attendance_records")
          .select("student_id, session_date, present, checked_in_at, checked_in_by, dismissal_kind, released_to_contact_id, released_to_name, released_at, released_by, notes")
          .eq(filterCol, classId);
        if (aErr) throw aErr;

        // Instructors for name resolution (checked_in_by / released_by).
        const instrMap = {};
        const { data: instr } = await supabase
          .from("instructors").select("id, first_name, last_name, preferred_name").eq("organization_id", org.id);
        for (const i of instr ?? []) instrMap[i.id] = i;

        // Meeting dates.
        let meetingDates = [];
        if (kind === "camp") {
          meetingDates = campMeetingDates(campMeta?.startsOn, campMeta?.endsOn, campMeta?.classDays);
        } else {
          const { data: dd, error: ddErr } = await supabase.rpc("derive_program_session_dates", { p_program_id: classId });
          if (ddErr) console.warn("[ClassReports] session-date derive failed; falling back to recorded dates", ddErr);
          meetingDates = Array.isArray(dd) ? [...dd].sort() : [];
        }
        // Include any recorded date not already in the derived schedule (make-up days).
        const recDates = new Set((recs ?? []).map((r) => r.session_date));
        for (const d of recDates) if (!meetingDates.includes(d)) meetingDates.push(d);
        meetingDates.sort();

        if (cancelled) return;

        const byKey = {};
        for (const r of recs ?? []) byKey[`${r.student_id}|${r.session_date}`] = r;

        setRoster(
          students
            .map((r) => {
              const cs = contactsByStudent[r.student.id] ?? [];
              return {
                registration_id: r.id,
                student_id: r.student.id,
                name: nm(r.student) || "Unnamed",
                pickups: cs.filter((c) => c.role === "authorized_pickup").map(nm).filter(Boolean),
                doNotRelease: cs.filter((c) => c.role === "do_not_release").map(nm).filter(Boolean),
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name))
        );
        setDates(meetingDates);
        setRecByKey(byKey);
        setInstructors(instrMap);
        setState({ loading: false, error: "" });
      } catch (e) {
        if (!cancelled) {
          console.error("[ClassReports] load failed", e);
          setState({ loading: false, error: "Couldn't load this report." });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, classId, kind]);

  const today = todayISO();

  // Days on which attendance was actually taken (any child has a row). "Missing
  // check-in" only means "attendance was taken that day but THIS child was
  // skipped" — a day nobody recorded is "not taken", not per-child missing, so we
  // don't drown a class that hasn't adopted the feature in false flags.
  const datesWithRecord = useMemo(
    () => new Set(Object.keys(recByKey).map((k) => k.slice(k.indexOf("|") + 1))),
    [recByKey]
  );

  // Compliance scan across (child, past-or-today meeting date).
  const compliance = useMemo(() => {
    const dnr = [], nonAuth = [], undismissed = [], missing = [];
    let presentCount = 0, releasedCount = 0;
    for (const child of roster) {
      const dnrSet = new Set(child.doNotRelease.map((s) => s.toLowerCase()));
      for (const d of dates) {
        if (d > today) continue; // future meetings aren't "missing"
        const rec = recByKey[`${child.student_id}|${d}`];
        if (!rec || rec.present == null) {
          if (datesWithRecord.has(d)) missing.push({ child: child.name, date: d });
          continue;
        }
        if (rec.present === true) presentCount += 1;
        if (rec.released_at) {
          releasedCount += 1;
          const relName = (rec.released_to_name ?? "").toLowerCase().trim();
          if (relName && dnrSet.has(relName)) {
            dnr.push({ child: child.name, date: d, who: rec.released_to_name });
          } else if (rec.dismissal_kind === "released_to_adult" && !rec.released_to_contact_id) {
            nonAuth.push({ child: child.name, date: d, who: rec.released_to_name, reason: rec.notes });
          }
        } else if (rec.present === true) {
          undismissed.push({ child: child.name, date: d });
        }
      }
    }
    return { dnr, nonAuth, undismissed, missing, presentCount, releasedCount };
  }, [roster, dates, recByKey, today, datesWithRecord]);

  function exportCsv() {
    const header = ["Child", "Date", "Present", "Dismissal", "Released to", "Released at", "By", "Flag", "Notes"];
    const lines = [header.map(csvCell).join(",")];
    for (const child of roster) {
      const dnrSet = new Set(child.doNotRelease.map((s) => s.toLowerCase()));
      for (const d of dates) {
        const rec = recByKey[`${child.student_id}|${d}`];
        const present = rec?.present == null ? "" : rec.present ? "Present" : "Absent";
        const relName = (rec?.released_to_name ?? "").toLowerCase().trim();
        let flag = "";
        if (d <= today) {
          if (!rec || rec.present == null) flag = datesWithRecord.has(d) ? "MISSING CHECK-IN" : "";
          else if (rec.present === true && !rec.released_at) flag = "NOT DISMISSED";
          else if (rec.released_at && relName && dnrSet.has(relName)) flag = "DO-NOT-RELEASE VIOLATION";
          else if (rec.released_at && rec.dismissal_kind === "released_to_adult" && !rec.released_to_contact_id) flag = "RELEASED TO NON-AUTHORIZED";
        }
        lines.push([
          child.name, d, present,
          rec?.dismissal_kind ?? "", rec?.released_to_name ?? "", fmtTime(rec?.released_at),
          instructorName(instructors[rec?.released_by]) || instructorName(instructors[rec?.checked_in_by]),
          flag, rec?.notes ?? "",
        ].map(csvCell).join(","));
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `class-report-${(title || "class").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (state.loading) return <div style={{ color: MUTED, fontSize: 13 }}>Loading report…</div>;
  if (state.error) return <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13 }}>{state.error}</div>;
  if (roster.length === 0) return <div style={{ color: MUTED, fontSize: 13 }}>No one is registered for this class yet.</div>;

  const pastDates = dates.filter((d) => d <= today);
  const totalIssues = compliance.dnr.length + compliance.nonAuth.length + compliance.undismissed.length + compliance.missing.length;

  return (
    <div>
      {/* Value line — real counts, not a fabricated estimate. */}
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
        {compliance.releasedCount} dismissal{compliance.releasedCount === 1 ? "" : "s"} logged across {pastDates.length} class day{pastDates.length === 1 ? "" : "s"} — each one timestamped and searchable.
      </div>

      {/* Compliance highlights lead — the safety value. */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: totalIssues ? RED : OK, marginBottom: 8 }}>
          {totalIssues ? `${totalIssues} thing${totalIssues === 1 ? "" : "s"} to review` : "No safety flags"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FlagGroup color={RED} label="Do-not-release name used" items={compliance.dnr}
            render={(x) => `${x.child} · ${fmtDay(x.date)} → ${x.who}`} />
          <FlagGroup color={RED} label="Released to someone not on the authorized list" items={compliance.nonAuth}
            render={(x) => `${x.child} · ${fmtDay(x.date)} → ${x.who}${x.reason ? ` (${x.reason})` : ""}`} />
          <FlagGroup color={AMBER} label="Present but not yet dismissed" items={compliance.undismissed}
            render={(x) => `${x.child} · ${fmtDay(x.date)}`} />
          <FlagGroup color={AMBER} label="Missing check-in" items={compliance.missing}
            render={(x) => `${x.child} · ${fmtDay(x.date)}`} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button
          type="button"
          onClick={exportCsv}
          style={{ fontSize: 12, fontFamily: "inherit", fontWeight: 600, color: BRIGHT, background: "none", border: `1px solid ${BRIGHT}`, borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}
        >
          Export CSV
        </button>
      </div>

      {/* Daily grid — children × meeting days. */}
      {dates.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 13 }}>No meeting days scheduled yet.</div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${RULE}`, borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
            <thead>
              <tr>
                <th style={thStyle(true)}>Child</th>
                {dates.map((d) => (
                  <th key={d} style={thStyle(false)}>{fmtDay(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roster.map((child) => {
                const dnrSet = new Set(child.doNotRelease.map((s) => s.toLowerCase()));
                return (
                  <tr key={child.student_id}>
                    <td style={{ ...tdStyle, position: "sticky", left: 0, background: CREAM, fontWeight: 600, whiteSpace: "nowrap" }}>{child.name}</td>
                    {dates.map((d) => {
                      const rec = recByKey[`${child.student_id}|${d}`];
                      const clickable = Boolean(rec);
                      return (
                        <td
                          key={d}
                          onClick={clickable ? () => setSelected({ childName: child.name, date: d, rec, dnrSet }) : undefined}
                          style={{ ...tdStyle, cursor: clickable ? "pointer" : "default" }}
                        >
                          <Cell rec={rec} isPast={d <= today} dnrSet={dnrSet} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <CellDetail selected={selected} instructors={instructors} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// Click-through detail for one attendance cell — the instructor attribution and
// full release record are shown here, not buried in a hover tooltip.
function CellDetail({ selected, instructors, onClose }) {
  const { childName, date, rec, dnrSet } = selected;
  const present = rec?.present == null ? "Not marked" : rec.present ? "Present" : "Absent";
  const relName = (rec?.released_to_name ?? "").toLowerCase().trim();
  const isDnr = rec?.released_at && relName && dnrSet.has(relName);
  const isNonAuth = rec?.released_at && rec.dismissal_kind === "released_to_adult" && !rec.released_to_contact_id;
  const checkedBy = instructorName(instructors[rec?.checked_in_by]);
  const releasedBy = instructorName(instructors[rec?.released_by]);

  const row = (label, value) => value ? (
    <div style={{ display: "flex", gap: 8, fontSize: 12, marginTop: 4 }}>
      <span style={{ color: MUTED, minWidth: 96 }}>{label}</span>
      <span style={{ color: INK }}>{value}</span>
    </div>
  ) : null;

  return (
    <div style={{ marginTop: 12, padding: "12px 14px", background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{childName} · {fmtDay(date)}</div>
        <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: MUTED, fontSize: 16, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" }}>×</button>
      </div>
      {(isDnr || isNonAuth) && (
        <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: RED }}>
          ⚠ {isDnr ? "Released to a do-not-release name" : "Released to someone not on the authorized list"}
        </div>
      )}
      {row("Attendance", present)}
      {row("Checked in", rec?.checked_in_at ? `${fmtTime(rec.checked_in_at)}${checkedBy ? ` by ${checkedBy}` : ""}` : null)}
      {row("Released to", rec?.released_to_name)}
      {row("Released at", rec?.released_at ? `${fmtTime(rec.released_at)}${releasedBy ? ` by ${releasedBy}` : ""}` : null)}
      {row("Notes", rec?.notes)}
      {!rec?.released_at && rec?.present === true && (
        <div style={{ marginTop: 6, fontSize: 12, color: AMBER }}>Present, not yet dismissed.</div>
      )}
    </div>
  );
}

function FlagGroup({ color, label, items, render }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;
  return (
    <div style={{ background: `${color}12`, border: `1px solid ${color}55`, borderRadius: 6, padding: "8px 10px" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0, textAlign: "left" }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{label} · {items.length}</span>
        <span style={{ fontSize: 11, color }}>{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul style={{ margin: "6px 0 0", padding: "0 0 0 16px", color: INK, fontSize: 12, lineHeight: 1.6 }}>
          {items.map((x, i) => <li key={i}>{render(x)}</li>)}
        </ul>
      )}
    </div>
  );
}

// Compact cell visual only. Full detail (incl. which instructor) is one click
// away in CellDetail, not a hover tooltip.
function Cell({ rec, isPast, dnrSet }) {
  if (!rec || rec.present == null) {
    return <span style={{ color: isPast ? AMBER : "#c9c4b8" }}>{isPast ? "—" : ""}</span>;
  }

  // A completed release is shown first — including its violation coloring — even
  // if the row is (contradictorily) marked absent, so the grid never hides a flag
  // the highlights and CSV both surface. isDnr/isNonAuth are guarded by
  // released_at, matching the compliance + CSV logic exactly.
  if (rec.released_at) {
    const relName = (rec.released_to_name ?? "").toLowerCase().trim();
    const isDnr = relName && dnrSet.has(relName);
    const isNonAuth = rec.dismissal_kind === "released_to_adult" && !rec.released_to_contact_id;
    return (
      <span style={{ display: "inline-block", whiteSpace: "nowrap", color: isDnr || isNonAuth ? RED : OK, fontWeight: isDnr ? 700 : 500, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>
        {isDnr || isNonAuth ? "⚠ " : "✓ "}{rec.released_to_name || "released"}
      </span>
    );
  }

  if (rec.present === false) return <span style={{ color: MUTED }}>abs</span>;
  // Present, not yet dismissed.
  return <span style={{ color: AMBER }}>• here</span>;
}

const thStyleBase = {
  fontSize: 11, fontWeight: 600, color: MUTED, textAlign: "left",
  padding: "8px 10px", borderBottom: `1px solid ${RULE}`, whiteSpace: "nowrap", background: "#fff",
};
function thStyle(sticky) {
  return sticky ? { ...thStyleBase, position: "sticky", left: 0, zIndex: 1 } : thStyleBase;
}
const tdStyle = { padding: "7px 10px", borderBottom: `1px solid ${RULE}`, verticalAlign: "top" };
