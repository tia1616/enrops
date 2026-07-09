// src/pages/admin/instructors/SurveyResponses.jsx
// Read-only "Responses" tab under Instructors. Lets the operator SEE what each
// instructor submitted on the availability survey — there is no other surface
// for this today (answers only feed the matcher/board).
//
// Term-scoped (after-school) / cycle-scoped (camps), driven by the SAME term
// selector the Schedule boards use. Uses the SAME display vocab as the survey
// forms (Love to / Happy to / Rather not / Can't; subjects title-cased from
// curricula.category; camps show REGIONS, not venues).
//
// Strictly read-only — no writes. Multi-tenant: every query is org-scoped; no
// hardcoded tenant slug/UUID.

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase";
import { fetchOrgTerms } from "../../../lib/terms.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const VIOLET = "#8C88FF";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const CREAM = "#FBFBFB";

const DAYS = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
];

// Camp session types + role, mirrored from InstructorAvailabilityForm.
const SESSION_TYPE_LABEL = { morning: "Morning", afternoon: "Afternoon", full_day: "Full day" };
const ROLE_LABEL = {
  lead_only: "Lead only",
  lead_or_developing: "Either lead or developing",
  developing_only: "Developing only",
};

// Preference value -> { label, color }. Two vocabularies: after-school has three
// levels, camps four. Kept verbatim from the two survey forms so the Responses
// view reads exactly like what the instructor filled in.
const AFTERSCHOOL_PREF = {
  preferred: { label: "Love to", color: OK_GREEN },
  available: { label: "Happy to", color: "#6B7280" },
  unavailable: { label: "Can't", color: CORAL },
};
const CAMP_PREF = {
  highly_preferred: { label: "Love to", color: OK_GREEN },
  preferred: { label: "Happy to", color: OK_GREEN },
  not_preferred: { label: "Rather not", color: VIOLET },
  unavailable: { label: "Can't", color: CORAL },
};

// Days-per-week ranges, mirrored from AfterschoolAvailabilityForm's DAYS_RANGES.
function daysPerWeekLabel(min, max) {
  if (min == null && max == null) return "No limit";
  if (min === 1 && max === 2) return "1–2 days a week";
  if (min === 3 && max === 4) return "3–4 days a week";
  if (min === 4 && max === 5) return "4–5 days a week";
  if (min != null && max != null) return `${min}–${max} days a week`;
  if (max != null) return `Up to ${max} days a week`;
  if (min != null) return `At least ${min} days a week`;
  return "No limit";
}

// Title-case a stored curriculum category for display. Same rule as the forms.
function titleCaseCategory(value) {
  return String(value)
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function termDisplayName(code) {
  if (!code) return "";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

// availability from/until are 24-hour "HH:MM" (from the form's time input). -> "12:00 PM".
function fmt24h(t) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t || "");
  if (!m) return t || "";
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = ((h + 11) % 12) + 1;
  return `${h}:${min} ${ampm}`;
}

// "2026-11-12" -> "Nov 12" (parsed at local noon so it never slips a day).
function shortDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return isNaN(d) ? String(iso) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtSubmitted(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function instructorName(inst) {
  if (!inst) return "Unknown";
  const n = [inst.preferred_name || inst.first_name, inst.last_name].filter(Boolean).join(" ").trim();
  return n || inst.email || "Unknown";
}

// Chronological term sort (Fall 2026 -> Winter 2027 -> ...), matching the board.
const SEASON_MONTH = { SU: 6, FA: 9, WI: 1, SP: 4 };
function termSortKey(code) {
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code || "");
  if (!m) return 0;
  return (2000 + parseInt(m[2], 10)) * 100 + (SEASON_MONTH[m[1]] || 0);
}

export default function SurveyResponses() {
  const { org } = useOutletContext() ?? {};
  const navigate = useNavigate();

  // Term selector state — same shape as the board: a list of camp cycles + a
  // list of after-school term codes, and a single `selected` encoding which one.
  const [campCycles, setCampCycles] = useState([]);       // [{id, name, weeks, ...}]
  const [afterschoolTerms, setAfterschoolTerms] = useState([]); // ["FA26", ...]
  const [selected, setSelected] = useState(null); // { mode:'camp', cycleId } | { mode:'afterschool', term }
  const [pickerReady, setPickerReady] = useState(false);

  const [state, setState] = useState({ status: "idle" }); // idle|loading|ready|empty|error

  // 1) Discover camp cycles + after-school terms, then pick a sensible default.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!org?.id) return;
      setPickerReady(false);
      const [campRes, progRes, surveyRes, asCycleRes] = await Promise.all([
        supabase
          .from("scheduling_cycles")
          .select("id, name, weeks, starts_on")
          .eq("organization_id", org.id)
          .eq("cycle_type", "summer_camp")
          .neq("status", "archived")
          .order("starts_on", { ascending: false, nullsFirst: false }),
        supabase.from("programs").select("term").eq("organization_id", org.id).not("term", "is", null),
        supabase.from("afterschool_survey_state").select("term").eq("organization_id", org.id),
        supabase
          .from("scheduling_cycles")
          .select("name")
          .eq("organization_id", org.id)
          .eq("cycle_type", "afterschool")
          .neq("status", "archived"),
      ]);
      if (!alive) return;

      const camps = campRes.data ?? [];
      setCampCycles(camps);

      const terms = new Set();
      (progRes.data ?? []).forEach((r) => { if (r.term) terms.add(r.term); });
      (surveyRes.data ?? []).forEach((r) => { if (r.term) terms.add(r.term); });
      (asCycleRes.data ?? []).forEach((r) => { if (r.name) terms.add(r.name); });
      const sortedTerms = [...terms].sort((a, b) => termSortKey(a) - termSortKey(b));
      setAfterschoolTerms(sortedTerms);

      // Default landing: prefer the org's current term if it's an after-school
      // term we know about; else the most-recent camp cycle; else the first
      // after-school term. Mirrors how the board resolves "which term am I on".
      const { defaultTerm } = await fetchOrgTerms(org.id);
      if (!alive) return;
      let next = null;
      if (defaultTerm && sortedTerms.includes(defaultTerm)) {
        next = { mode: "afterschool", term: defaultTerm };
      } else if (camps.length > 0) {
        next = { mode: "camp", cycleId: camps[0].id };
      } else if (sortedTerms.length > 0) {
        next = { mode: "afterschool", term: sortedTerms[0] };
      }
      setSelected(next);
      setPickerReady(true);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  // 2) Load responses for the selected term/cycle.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!org?.id || !selected) { if (pickerReady) setState({ status: "empty" }); return; }
      setState({ status: "loading" });
      try {
        const data = selected.mode === "afterschool"
          ? await loadAfterschool(org.id, selected.term)
          : await loadCamp(org.id, selected.cycleId, campCycles.find((c) => c.id === selected.cycleId));
        if (!alive) return;
        setState({ status: "ready", ...data });
      } catch (err) {
        if (!alive) return;
        console.error("[SurveyResponses] load error:", err);
        setState({ status: "error", message: err?.message || "Couldn't load responses." });
      }
    })();
    return () => { alive = false; };
  }, [org?.id, selected, pickerReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectValue = selected
    ? (selected.mode === "afterschool" ? `as:${selected.term}` : selected.cycleId)
    : "";

  function onPick(e) {
    const v = e.target.value;
    if (v.startsWith("as:")) setSelected({ mode: "afterschool", term: v.slice(3) });
    else setSelected({ mode: "camp", cycleId: v });
  }

  // Nudge non-responders: the survey drawer (with non-responders pre-selected)
  // already lives on the Schedule board. Rather than duplicate it here, route to
  // the board so the operator opens/resends the survey from the built surface.
  function nudge() {
    navigate("/admin/schedule");
  }

  const hasAnyContext = campCycles.length > 0 || afterschoolTerms.length > 0;

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: INK, margin: "0 0 4px", letterSpacing: -0.3 }}>
          Availability survey responses
        </h1>
        <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
          See what each instructor submitted. Read-only — to edit the survey or send it, use the Schedule board.
        </p>
      </header>

      {!hasAnyContext && pickerReady ? (
        <Empty
          title="No terms yet"
          body="Once you have a camp cycle or an after-school term with programs, instructor responses will show up here."
        />
      ) : (
        <>
          {/* Term/cycle selector — same options as the board. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <select
              value={selectValue}
              onChange={onPick}
              title="Switch term"
              style={{
                fontSize: 15, fontWeight: 700, color: INK, letterSpacing: -0.2, fontFamily: "inherit",
                background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "8px 32px 8px 12px",
                cursor: "pointer", appearance: "none",
                backgroundImage: `linear-gradient(45deg, transparent 50%, ${MUTED} 50%), linear-gradient(135deg, ${MUTED} 50%, transparent 50%)`,
                backgroundPosition: "calc(100% - 16px) center, calc(100% - 11px) center",
                backgroundSize: "5px 5px, 5px 5px",
                backgroundRepeat: "no-repeat",
              }}
            >
              {afterschoolTerms.length > 0 && (
                <optgroup label="After-school">
                  {afterschoolTerms.map((t) => (
                    <option key={`as:${t}`} value={`as:${t}`}>{termDisplayName(t)}</option>
                  ))}
                </optgroup>
              )}
              {campCycles.length > 0 && (
                <optgroup label="Camps">
                  {campCycles.map((c) => (
                    <option key={c.id} value={c.id}>{termDisplayName(c.name)}</option>
                  ))}
                </optgroup>
              )}
            </select>
            {selected && (
              <span style={{
                fontSize: 11, color: PURPLE, background: `${VIOLET}22`, textTransform: "uppercase",
                letterSpacing: 0.6, fontWeight: 700, padding: "3px 8px", borderRadius: 999,
              }}>
                {selected.mode === "afterschool" ? "After-school" : "Camps"}
              </span>
            )}
          </div>

          <Body state={state} mode={selected?.mode} onNudge={nudge} />
        </>
      )}
    </div>
  );
}

// ---- Data loaders -------------------------------------------------------------

async function loadAfterschool(orgId, term) {
  const [instRes, availRes, areaRes] = await Promise.all([
    supabase
      .from("instructors")
      .select("id, first_name, last_name, preferred_name, email")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("first_name", { ascending: true }),
    supabase
      .from("instructor_term_availability")
      .select("instructor_id, weekday_availability, min_days, max_days, preferred_categories, unavailable_dates, notes, submitted_at")
      .eq("organization_id", orgId)
      .eq("term", term),
    supabase
      .from("instructor_term_area_preferences")
      .select("instructor_id, area, preference")
      .eq("organization_id", orgId)
      .eq("term", term),
  ]);
  if (instRes.error) throw instRes.error;
  if (availRes.error) throw availRes.error;
  if (areaRes.error) throw areaRes.error;

  const availByInst = new Map();
  for (const a of availRes.data ?? []) availByInst.set(a.instructor_id, a);
  const areasByInst = new Map();
  for (const r of areaRes.data ?? []) {
    if (!areasByInst.has(r.instructor_id)) areasByInst.set(r.instructor_id, []);
    areasByInst.get(r.instructor_id).push(r);
  }

  const responded = [];
  const nonResponders = [];
  for (const inst of instRes.data ?? []) {
    const av = availByInst.get(inst.id);
    if (av && av.submitted_at) {
      responded.push({ instructor: inst, av, areas: areasByInst.get(inst.id) ?? [] });
    } else {
      nonResponders.push(inst);
    }
  }
  responded.sort((a, b) => new Date(b.av.submitted_at) - new Date(a.av.submitted_at));
  return { responded, nonResponders, activeCount: (instRes.data ?? []).length };
}

async function loadCamp(orgId, cycleId, cycle) {
  const [instRes, availRes, locRes, curRes] = await Promise.all([
    supabase
      .from("instructors")
      .select("id, first_name, last_name, preferred_name, email")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("first_name", { ascending: true }),
    supabase
      .from("instructor_availability")
      .select("instructor_id, session_types, available_weeks, role_preference, saturdays_ok, unavailable_dates, unavailable_notes, notes, submitted_at")
      .eq("cycle_id", cycleId),
    supabase
      .from("instructor_location_preferences")
      .select("instructor_id, location_name, preference")
      .eq("cycle_id", cycleId),
    supabase
      .from("instructor_curriculum_preferences")
      .select("instructor_id, curriculum_category, preference")
      .eq("cycle_id", cycleId),
  ]);
  if (instRes.error) throw instRes.error;
  if (availRes.error) throw availRes.error;
  if (locRes.error) throw locRes.error;
  if (curRes.error) throw curRes.error;

  const availByInst = new Map();
  for (const a of availRes.data ?? []) availByInst.set(a.instructor_id, a);
  const regionByInst = new Map();
  for (const r of locRes.data ?? []) {
    if (!regionByInst.has(r.instructor_id)) regionByInst.set(r.instructor_id, []);
    regionByInst.get(r.instructor_id).push(r);
  }
  const curByInst = new Map();
  for (const r of curRes.data ?? []) {
    if (!curByInst.has(r.instructor_id)) curByInst.set(r.instructor_id, []);
    curByInst.get(r.instructor_id).push(r);
  }

  const weeks = Array.isArray(cycle?.weeks) ? cycle.weeks : [];
  const responded = [];
  const nonResponders = [];
  for (const inst of instRes.data ?? []) {
    const av = availByInst.get(inst.id);
    if (av && av.submitted_at) {
      responded.push({
        instructor: inst,
        av,
        regions: regionByInst.get(inst.id) ?? [],
        subjects: curByInst.get(inst.id) ?? [],
      });
    } else {
      nonResponders.push(inst);
    }
  }
  responded.sort((a, b) => new Date(b.av.submitted_at) - new Date(a.av.submitted_at));
  return { responded, nonResponders, activeCount: (instRes.data ?? []).length, weeks };
}

// ---- Body / cards -------------------------------------------------------------

function Body({ state, mode, onNudge }) {
  if (state.status === "loading" || state.status === "idle") {
    return <div style={{ color: MUTED, fontSize: 14 }}>Loading responses…</div>;
  }
  if (state.status === "error") {
    return <Empty title="Couldn't load responses" body={state.message} tone="error" />;
  }
  if (state.status === "empty") {
    return <Empty title="Pick a term" body="Choose a term or cycle above to see responses." />;
  }

  const { responded = [], nonResponders = [], activeCount = 0, weeks = [] } = state;
  const respondedCount = responded.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ fontSize: 13, color: MUTED }}>
        <strong style={{ color: INK }}>{respondedCount}</strong> of{" "}
        <strong style={{ color: INK }}>{activeCount}</strong> active instructors responded
      </div>

      {respondedCount === 0 ? (
        <Empty
          title="No responses yet"
          body="No instructor has submitted the availability survey for this term. Send or resend it from the Schedule board."
        />
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {responded.map((r) =>
            mode === "afterschool"
              ? <AfterschoolCard key={r.instructor.id} row={r} />
              : <CampCard key={r.instructor.id} row={r} weeks={weeks} />
          )}
        </div>
      )}

      {nonResponders.length > 0 && (
        <NonResponders instructors={nonResponders} onNudge={onNudge} />
      )}
    </div>
  );
}

function ResponseCard({ name, submittedAt, children }) {
  return (
    <section style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>{name}</h2>
        <span style={{ fontSize: 12, color: MUTED }}>Submitted {fmtSubmitted(submittedAt)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", gap: 12, alignItems: "start" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, paddingTop: 2 }}>{label}</div>
      <div style={{ fontSize: 14, color: INK }}>{children}</div>
    </div>
  );
}

function Chip({ children, color = INK, filled = false }) {
  return (
    <span style={{
      display: "inline-block", fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 999,
      marginRight: 6, marginBottom: 4, whiteSpace: "nowrap",
      background: filled ? color : `${CREAM}`, color: filled ? "#fff" : color,
      border: `1px solid ${filled ? color : RULE}`,
    }}>
      {children}
    </span>
  );
}

// A row of "<name> — <pref label>" prefs, colored by preference.
function PrefChips({ prefs, vocab, nameKey }) {
  const rows = (prefs ?? []).filter((p) => p[nameKey]);
  if (rows.length === 0) return <span style={{ color: MUTED }}>—</span>;
  // Order: strongest preference first for scannability.
  const rank = { highly_preferred: 0, preferred: 1, available: 1, not_preferred: 2, unavailable: 3 };
  const sorted = [...rows].sort((a, b) => (rank[a.preference] ?? 9) - (rank[b.preference] ?? 9));
  return (
    <div>
      {sorted.map((p, i) => {
        const meta = vocab[p.preference] || { label: p.preference, color: MUTED };
        return (
          <span key={i} style={{ display: "inline-block", marginRight: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: INK }}>{titleCaseCategory(p[nameKey])}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, marginLeft: 5 }}>{meta.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function AfterschoolCard({ row }) {
  const { instructor, av, areas } = row;
  const wd = av.weekday_availability || {};
  const availDays = DAYS.filter((d) => wd[d.key] && wd[d.key].from);
  const subjects = Array.isArray(av.preferred_categories) ? av.preferred_categories : [];
  const dates = Array.isArray(av.unavailable_dates) ? av.unavailable_dates : [];

  return (
    <ResponseCard name={instructorName(instructor)} submittedAt={av.submitted_at}>
      <Field label="Weekday availability">
        {availDays.length === 0 ? <span style={{ color: MUTED }}>None given</span> : (
          <div>
            {availDays.map((d) => {
              const w = wd[d.key];
              const range = w.until ? `${fmt24h(w.from)}–${fmt24h(w.until)}` : `from ${fmt24h(w.from)}`;
              return <Chip key={d.key} color={PURPLE}>{d.label} · {range}</Chip>;
            })}
          </div>
        )}
      </Field>
      <Field label="Days per week">{daysPerWeekLabel(av.min_days, av.max_days)}</Field>
      <Field label="Areas">
        <PrefChips prefs={areas} vocab={AFTERSCHOOL_PREF} nameKey="area" />
      </Field>
      <Field label="Subjects">
        {subjects.length === 0 ? <span style={{ color: MUTED }}>—</span> :
          subjects.map((c) => <Chip key={c} color={BRIGHT}>{titleCaseCategory(c)}</Chip>)}
      </Field>
      {dates.length > 0 && (
        <Field label="Unavailable dates">
          {[...dates].sort().map((d) => <Chip key={d} color={CORAL}>{shortDate(d)}</Chip>)}
        </Field>
      )}
      {av.notes && <Field label="Notes"><span style={{ whiteSpace: "pre-wrap" }}>{av.notes}</span></Field>}
    </ResponseCard>
  );
}

function CampCard({ row, weeks }) {
  const { instructor, av, regions, subjects } = row;
  const weekByNum = new Map((weeks ?? []).map((w) => [w.num, w]));
  const availWeeks = Array.isArray(av.available_weeks) ? av.available_weeks : [];
  const sessionTypes = Array.isArray(av.session_types) ? av.session_types : [];
  const dates = Array.isArray(av.unavailable_dates) ? av.unavailable_dates : [];

  return (
    <ResponseCard name={instructorName(instructor)} submittedAt={av.submitted_at}>
      <Field label="Weeks">
        {availWeeks.length === 0 ? <span style={{ color: MUTED }}>None given</span> :
          [...availWeeks].sort((a, b) => a - b).map((num) => {
            const w = weekByNum.get(num);
            return (
              <Chip key={num} color={PURPLE}>
                Week {num}{w ? ` · ${shortDate(w.starts_on)}–${shortDate(w.ends_on)}` : ""}
              </Chip>
            );
          })}
      </Field>
      <Field label="Times of day">
        {sessionTypes.length === 0 ? <span style={{ color: MUTED }}>—</span> :
          sessionTypes.map((s) => <Chip key={s} color={PURPLE}>{SESSION_TYPE_LABEL[s] || s}</Chip>)}
      </Field>
      <Field label="Regions">
        <PrefChips prefs={regions} vocab={CAMP_PREF} nameKey="location_name" />
      </Field>
      <Field label="Subjects">
        <PrefChips prefs={subjects} vocab={CAMP_PREF} nameKey="curriculum_category" />
      </Field>
      <Field label="Role">{ROLE_LABEL[av.role_preference] || (av.role_preference ? titleCaseCategory(av.role_preference) : "—")}</Field>
      <Field label="Saturdays">{av.saturdays_ok ? "Open to Saturdays" : "No Saturdays"}</Field>
      {dates.length > 0 && (
        <Field label="Unavailable dates">
          {[...dates].sort().map((d) => <Chip key={d} color={CORAL}>{shortDate(d)}</Chip>)}
        </Field>
      )}
      {av.notes && <Field label="Notes"><span style={{ whiteSpace: "pre-wrap" }}>{av.notes}</span></Field>}
    </ResponseCard>
  );
}

function NonResponders({ instructors, onNudge }) {
  return (
    <section style={{ background: CREAM, border: `1px dashed ${CORAL}`, borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK }}>
          Not yet responded <span style={{ color: CORAL }}>({instructors.length})</span>
        </h2>
        <button
          type="button"
          onClick={onNudge}
          style={{
            background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8,
            padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}
          title="Open the availability survey on the Schedule board — non-responders are pre-selected there"
        >
          Nudge non-responders
        </button>
      </div>
      <div>
        {instructors.map((inst) => (
          <Chip key={inst.id} color={MUTED}>{instructorName(inst)}</Chip>
        ))}
      </div>
    </section>
  );
}

function Empty({ title, body, tone }) {
  return (
    <div style={{
      background: tone === "error" ? "#fff5f3" : CREAM,
      border: `1px solid ${tone === "error" ? CORAL : RULE}`,
      borderRadius: 12, padding: "28px 24px", textAlign: "center",
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 6 }}>{title}</div>
      {body && <div style={{ fontSize: 13, color: MUTED, maxWidth: 520, margin: "0 auto", lineHeight: 1.5 }}>{body}</div>}
    </div>
  );
}
