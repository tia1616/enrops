// src/pages/admin/AfterschoolSchedule.jsx
// After-school scheduling calendar. Sibling of Schedule.jsx (camps) — kept as a
// separate component so camp logic stays untouched. After-school is term-keyed
// and structurally simpler than camps:
//   - Mon–Fri columns (each program recurs the same weekday all term)
//   - one instructor per program (the lead)
//   - NO weeks, NO am/pm/full_day, NO curriculum matching, NO enrollment gates
// Reads programs + program_assignments + instructor_term_availability for one term.
// Hosts the "open availability survey" and "match instructors" triggers.
// Multi-tenant: every query is scoped by organization_id.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const CHANGE_REQ = "#8B4FB5";
const CREAM = "#FBFBFB";

const DAYS = [
  { key: "monday", code: "mon", label: "Monday", short: "Mon" },
  { key: "tuesday", code: "tue", label: "Tuesday", short: "Tue" },
  { key: "wednesday", code: "wed", label: "Wednesday", short: "Wed" },
  { key: "thursday", code: "thu", label: "Thursday", short: "Thu" },
  { key: "friday", code: "fri", label: "Friday", short: "Fri" },
];
const DAY_TO_CODE = { monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri" };

const LOCATION_PALETTE = ["#F2E4D2", "#E5EDDC", "#DDE7F0", "#ECDFEC", "#F0E0E0", "#E1ECEA"];

const STATUS_RANK = { published: 4, confirmed: 3, change_requested: 2, proposed: 1, withdrawn: 0, declined: 0 };

const FILTER_STATUSES = [
  { key: "needs_hire", label: "Needs instructor" },
  { key: "change_requested", label: "Change requested" },
  { key: "flagged", label: "Flagged" },
  { key: "accepted", label: "Accepted" },
  { key: "confirmed", label: "Awaiting response" },
  { key: "ok", label: "Not yet sent" },
];

function dayKey(dow) {
  return (dow || "").trim().toLowerCase();
}

function termDisplayName(code) {
  if (!code) return "";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

function fmtTime(t) {
  if (!t) return "";
  // programs.start_time/end_time are 12-hour text ("2:05 PM").
  const ampm = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(t);
  if (ampm) return `${parseInt(ampm[1], 10)}:${ampm[2]} ${ampm[3].toUpperCase()}`;
  // Legacy 24-hour fallback.
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const hr12 = ((h + 11) % 12) + 1;
  return m ? `${hr12}:${String(m).padStart(2, "0")}` : `${hr12}`;
}

function fmtTimeRange(start, end) {
  if (!start && !end) return "";
  if (start && end) return `${fmtTime(start)}–${fmtTime(end)}`;
  return fmtTime(start || end);
}

const ARRIVAL_BUFFER_MIN = 15;

// programs.start_time/end_time are 12-hour text ("2:05 PM"). -> minutes, or null.
function parse12h(t) {
  if (!t) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(t);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h === 12) h = 0;
  if (m[3].toLowerCase() === "pm") h += 12;
  return h * 60 + min;
}

// availability from/until are 24-hour "HH:MM" (from the form's time input). -> minutes.
function parseHHMM(t) {
  if (!t) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function fmtDeadline(d) {
  if (!d) return "";
  const date = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" });
}

function businessDaysFromToday(days) {
  const d = new Date();
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function locationColorMap(programs, locName) {
  const seen = new Set();
  const order = [];
  for (const p of programs) {
    const loc = locName.get(p.program_location_id) || "—";
    if (!seen.has(loc)) { seen.add(loc); order.push(loc); }
  }
  const map = new Map();
  order.forEach((loc, i) => map.set(loc, LOCATION_PALETTE[i % LOCATION_PALETTE.length]));
  return map;
}

function deriveStatus(programId, assignments) {
  const own = assignments.filter((a) => a.program_id === programId && a.status !== "withdrawn" && a.status !== "declined");
  if (own.length === 0) return "needs_hire";
  let best = null;
  for (const a of own) {
    const rank = STATUS_RANK[a.status] ?? -1;
    if (!best || rank > best.rank) {
      best = { status: a.status, rank, flags: a.flags ?? [], instructor_response_at: a.instructor_response_at ?? null, flagged_reason: a.flagged_reason ?? null };
    }
  }
  if (best.status === "change_requested") return "change_requested";
  if (best.flagged_reason) return "flagged";
  if (Array.isArray(best.flags) && best.flags.length > 0) return "flagged";
  if (best.status === "confirmed" && best.instructor_response_at) return "accepted";
  if (best.status === "confirmed" || best.status === "published") return "confirmed";
  return "ok";
}

function statusColor(status) {
  if (status === "needs_hire") return CORAL;
  if (status === "flagged") return VIOLET;
  if (status === "change_requested") return CHANGE_REQ;
  if (status === "accepted") return OK_GREEN;
  return PURPLE;
}

function statusLabel(status) {
  return ({
    needs_hire: "Needs instructor",
    flagged: "Flagged",
    change_requested: "Change requested",
    accepted: "Accepted",
    confirmed: "Awaiting response",
    ok: "Draft",
  })[status] || status;
}

export default function AfterschoolSchedule({ org, term, campCycles = [], afterschoolTerms = [], onSwitchTerm, onSwitchToCamp }) {
  const [state, setState] = useState({ status: "loading" });
  const [searchText, setSearchText] = useState("");
  const [selectedLocations, setSelectedLocations] = useState(() => new Set());
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set());
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(null); // 'matching' | 'survey' | null
  const [picker, setPicker] = useState(null); // { program }
  const [surveyDialog, setSurveyDialog] = useState(null); // { mode:'choose'|'result', payload }
  const [surveyDeadline, setSurveyDeadline] = useState(() => businessDaysFromToday(10));
  const [matchResult, setMatchResult] = useState(null);
  const [view, setView] = useState("list"); // 'list' | 'grid'

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  async function loadAll() {
    if (!org?.id || !term) return;
    setState({ status: "loading" });
    try {
      const [progRes, locRes, instRes, availRes, surveyRes, areaPrefRes] = await Promise.all([
        supabase
          .from("programs")
          .select("id, curriculum, day_of_week, start_time, end_time, program_location_id, status, max_capacity, grade_min, grade_max")
          .eq("organization_id", org.id)
          .eq("term", term)
          .not("status", "in", '("cancelled","archived")'),
        supabase
          .from("program_locations")
          .select("id, name, area")
          .eq("organization_id", org.id),
        supabase
          .from("instructors")
          .select("id, first_name, last_name, preferred_name, email")
          .eq("organization_id", org.id)
          .eq("is_active", true)
          .order("first_name", { ascending: true }),
        supabase
          .from("instructor_term_availability")
          .select("instructor_id, weekday_availability, max_days, needs_confirmation, notes, submitted_at")
          .eq("organization_id", org.id)
          .eq("term", term),
        supabase
          .from("afterschool_survey_state")
          .select("opened_at, deadline")
          .eq("organization_id", org.id)
          .eq("term", term)
          .maybeSingle(),
        supabase
          .from("instructor_term_area_preferences")
          .select("instructor_id, area, preference")
          .eq("organization_id", org.id)
          .eq("term", term),
      ]);
      if (progRes.error) throw progRes.error;
      if (locRes.error) throw locRes.error;
      if (instRes.error) throw instRes.error;
      if (availRes.error) throw availRes.error;
      if (surveyRes.error) throw surveyRes.error;
      if (areaPrefRes.error) throw areaPrefRes.error;

      const programs = (progRes.data ?? []).filter((p) => DAY_TO_CODE[dayKey(p.day_of_week)]);
      const programIds = programs.map((p) => p.id);

      const assignRes = programIds.length
        ? await supabase
            .from("program_assignments")
            .select("id, program_id, instructor_id, status, role, flags, distance_bonus_cents, instructor_response_at, email_sent_at, change_request_message, flagged_reason, instructor:instructors(id, first_name, last_name, preferred_name, email)")
            .in("program_id", programIds)
        : { data: [], error: null };
      if (assignRes.error) throw assignRes.error;

      const enrollRes = programIds.length
        ? await supabase.from("program_enrollment").select("program_id, enrolled, max_capacity").in("program_id", programIds)
        : { data: [], error: null };
      const enrollment = {};
      for (const r of enrollRes.data ?? []) enrollment[r.program_id] = { enrolled: Number(r.enrolled ?? 0), max: r.max_capacity ?? null };

      const assignments = (assignRes.data ?? []).map((a) => ({
        id: a.id,
        program_id: a.program_id,
        instructor_id: a.instructor?.id ?? a.instructor_id ?? null,
        status: a.status,
        role: a.role,
        flags: Array.isArray(a.flags) ? a.flags : [],
        distance_bonus_cents: a.distance_bonus_cents ?? null,
        instructor_response_at: a.instructor_response_at ?? null,
        email_sent_at: a.email_sent_at ?? null,
        change_request_message: a.change_request_message ?? null,
        flagged_reason: a.flagged_reason ?? null,
        instructor_first: a.instructor?.first_name ?? null,
        instructor_last: a.instructor?.last_name ?? null,
        instructor_preferred: a.instructor?.preferred_name ?? null,
        instructor_email: a.instructor?.email ?? null,
      }));

      setState({
        status: "ready",
        programs,
        assignments,
        instructors: instRes.data ?? [],
        availability: availRes.data ?? [],
        locations: locRes.data ?? [],
        survey: surveyRes.data ?? null,
        areaPrefs: areaPrefRes.data ?? [],
        enrollment,
      });
    } catch (err) {
      console.error("AfterschoolSchedule load error:", err);
      setState({ status: "error", message: err.message ?? "Could not load schedule." });
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, term]);

  const locName = useMemo(() => {
    const m = new Map();
    if (state.status === "ready") for (const l of state.locations) m.set(l.id, l.name);
    return m;
  }, [state]);

  const availByInstr = useMemo(() => {
    const m = new Map();
    if (state.status === "ready") for (const a of state.availability) m.set(a.instructor_id, a);
    return m;
  }, [state]);

  const locArea = useMemo(() => {
    const m = new Map();
    if (state.status === "ready") for (const l of state.locations) m.set(l.id, l.area ?? null);
    return m;
  }, [state]);

  const areaPrefByInstr = useMemo(() => {
    const m = new Map();
    if (state.status === "ready") {
      for (const r of state.areaPrefs ?? []) {
        if (!m.has(r.instructor_id)) m.set(r.instructor_id, {});
        m.get(r.instructor_id)[r.area] = r.preference;
      }
    }
    return m;
  }, [state]);

  const colorMap = useMemo(() => {
    if (state.status !== "ready") return new Map();
    return locationColorMap(state.programs, locName);
  }, [state, locName]);

  // program_id -> { status, lead assignment }
  const enriched = useMemo(() => {
    const m = new Map();
    if (state.status !== "ready") return m;
    for (const p of state.programs) {
      const status = deriveStatus(p.id, state.assignments);
      const own = state.assignments.filter((a) => a.program_id === p.id && a.status !== "withdrawn" && a.status !== "declined");
      const lead = own.find((a) => a.role === "lead") ?? own[0] ?? null;
      m.set(p.id, { status, lead });
    }
    return m;
  }, [state]);

  // instructor_id -> Set<dayCode> currently committed (active assignments), for double-book checks.
  const committedDays = useMemo(() => {
    const m = new Map();
    if (state.status !== "ready") return m;
    const progById = new Map(state.programs.map((p) => [p.id, p]));
    for (const a of state.assignments) {
      if (a.status === "withdrawn" || a.status === "declined" || !a.instructor_id) continue;
      const p = progById.get(a.program_id);
      const code = p ? DAY_TO_CODE[dayKey(p.day_of_week)] : null;
      if (!code) continue;
      if (!m.has(a.instructor_id)) m.set(a.instructor_id, new Map());
      // store dayCode -> program_id so we can exclude the program being edited
      m.get(a.instructor_id).set(code, a.program_id);
    }
    return m;
  }, [state]);

  const loadCount = useMemo(() => {
    const m = new Map();
    if (state.status !== "ready") return m;
    for (const a of state.assignments) {
      if (a.status === "withdrawn" || a.status === "declined" || !a.instructor_id) continue;
      m.set(a.instructor_id, (m.get(a.instructor_id) ?? 0) + 1);
    }
    return m;
  }, [state]);

  const counts = useMemo(() => {
    const c = { assigned: 0, accepted: 0, flagged: 0, changeRequested: 0, needsHire: 0, instructors: 0 };
    if (state.status !== "ready") return c;
    for (const e of enriched.values()) {
      if (e.status === "needs_hire") c.needsHire++;
      else if (e.status === "change_requested") c.changeRequested++;
      else if (e.status === "flagged") c.flagged++;
      else if (e.status === "accepted") c.accepted++;
      else c.assigned++;
    }
    c.instructors = state.instructors.length;
    return c;
  }, [state, enriched]);

  // Eligibility for a target program: returns { ok, reason, pref, warnings }.
  function evaluate(instructorId, program) {
    const av = availByInstr.get(instructorId);
    const inst = state.status === "ready" ? state.instructors.find((i) => i.id === instructorId) : null;
    const first = inst?.preferred_name || inst?.first_name || "This instructor";
    const warnings = [];
    const wd = av?.weekday_availability || {};
    const code = DAY_TO_CODE[dayKey(program.day_of_week)];
    const dayLabel = DAYS.find((d) => d.code === code)?.label ?? "that day";
    if (!av || !Object.values(wd).some((w) => w && w.from)) {
      return { ok: false, reason: `${first} hasn't submitted availability for this term.`, warnings };
    }
    const avail = wd[code];
    if (!avail || !avail.from) {
      return { ok: false, reason: `${first} isn't available on ${dayLabel}.`, warnings };
    }
    const start = parse12h(program.start_time), end = parse12h(program.end_time);
    if (start == null || end == null) {
      return { ok: false, reason: `This class is missing a start/end time.`, warnings };
    }
    const from = parseHHMM(avail.from), until = avail.until ? parseHHMM(avail.until) : null;
    if (from == null || start - ARRIVAL_BUFFER_MIN < from || (until != null && end > until)) {
      return { ok: false, reason: `${first}'s ${dayLabel} hours don't cover this class time (needs to arrive ${ARRIVAL_BUFFER_MIN} min early).`, warnings };
    }
    // Double-booking: already holds a (different) program that same weekday.
    const committed = committedDays.get(instructorId);
    if (committed && committed.has(code) && committed.get(code) !== program.id) {
      return { ok: false, reason: `${first} already teaches another class on ${dayLabel} — can't be at two schools that afternoon.`, warnings };
    }
    // Max-days cap (count excludes this program if they already hold it).
    if (av.max_days != null) {
      const holdsThis = committed && committed.get(code) === program.id;
      const current = (loadCount.get(instructorId) ?? 0) - (holdsThis ? 1 : 0);
      if (current >= av.max_days) {
        return { ok: false, reason: `${first} is at their ${av.max_days}-day limit.`, warnings };
      }
    }
    const area = program.program_location_id ? (locArea.get(program.program_location_id) ?? null) : null;
    const pref = area ? (areaPrefByInstr.get(instructorId) || {})[area] : undefined;
    if (pref === "not_preferred") warnings.push(`${first} marked ${area} as not preferred.`);
    if (pref === "unavailable") warnings.push(`${first} marked ${area} as a place they can't go.`);
    if (av.needs_confirmation) warnings.push(`${first}'s availability is unconfirmed.`);
    return { ok: true, reason: null, pref, warnings };
  }

  function matchesFilters(p) {
    const e = enriched.get(p.id);
    const loc = locName.get(p.program_location_id) ?? "—";
    if (selectedLocations.size && !selectedLocations.has(loc)) return false;
    if (selectedStatuses.size && !selectedStatuses.has(e?.status)) return false;
    const q = searchText.trim().toLowerCase();
    if (q) {
      const hay = [p.curriculum, loc, e?.lead?.instructor_first, e?.lead?.instructor_last].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  // Group filtered programs by weekday -> location order.
  const grid = useMemo(() => {
    const byDay = new Map(DAYS.map((d) => [d.code, []]));
    if (state.status !== "ready") return byDay;
    const filtered = state.programs.filter(matchesFilters);
    // sort within day by location name then time
    filtered.sort((a, b) => {
      const la = locName.get(a.program_location_id) ?? "", lb = locName.get(b.program_location_id) ?? "";
      if (la !== lb) return la.localeCompare(lb);
      return (a.start_time ?? "").localeCompare(b.start_time ?? "");
    });
    for (const p of filtered) {
      const code = DAY_TO_CODE[dayKey(p.day_of_week)];
      if (byDay.has(code)) byDay.get(code).push(p);
    }
    return byDay;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, enriched, searchText, selectedLocations, selectedStatuses, locName]);

  const locationOptions = useMemo(() => {
    if (state.status !== "ready") return [];
    const set = new Set(state.programs.map((p) => locName.get(p.program_location_id)).filter(Boolean));
    return Array.from(set).sort();
  }, [state, locName]);

  async function handleAssign(program, instructorId) {
    const e = enriched.get(program.id);
    const current = e?.lead ?? null;
    try {
      if (current) {
        if (current.instructor_id === instructorId) { setPicker(null); return; }
        const { error } = await supabase
          .from("program_assignments")
          .update({
            instructor_id: instructorId,
            status: "proposed",
            email_sent_at: null,
            instructor_response_at: null,
            flagged_reason: null,
            change_request_message: null,
            flags: [],
          })
          .eq("id", current.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("program_assignments")
          .insert({
            organization_id: org.id,
            program_id: program.id,
            instructor_id: instructorId,
            role: "lead",
            status: "proposed",
          });
        if (error) throw error;
      }
      setPicker(null);
      await loadAll();
    } catch (err) {
      console.error("Assign failed:", err);
      setSaveError(`Couldn't save: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  async function handleRemove(program) {
    const e = enriched.get(program.id);
    const current = e?.lead ?? null;
    if (!current) { setPicker(null); return; }
    try {
      const { error } = await supabase.from("program_assignments").delete().eq("id", current.id);
      if (error) throw error;
      setPicker(null);
      await loadAll();
    } catch (err) {
      console.error("Remove failed:", err);
      setSaveError(`Couldn't remove: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  async function handleMatch() {
    const ok = window.confirm(
      "Match instructors for this term? This fills empty classes with proposed assignments from instructor availability. It never changes classes an instructor has already accepted."
    );
    if (!ok) return;
    setBusy("matching");
    setSaveError(null);
    setMatchResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("match-afterschool", {
        body: { organization_id: org.id, term, dry_run: false },
      });
      if (error) {
        let msg = error.message ?? "function error";
        try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setMatchResult(data?.summary ?? null);
      await loadAll();
    } catch (err) {
      console.error("Match failed:", err);
      setSaveError(`Couldn't match: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 8000);
    } finally {
      setBusy(null);
    }
  }

  async function runSurvey(mode) {
    setBusy("survey");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-afterschool-survey", {
        body: { organization_id: org.id, term, mode, deadline: surveyDeadline || null },
      });
      if (error) {
        let msg = error.message ?? "function error";
        try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setSurveyDialog({ mode: "result", payload: { mode, data } });
      if (mode === "send") await loadAll();
    } catch (err) {
      console.error("Survey failed:", err);
      setSaveError(`Couldn't send survey: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 8000);
    } finally {
      setBusy(null);
    }
  }

  if (state.status === "loading") return <div style={{ color: MUTED, fontSize: 14 }}>Loading schedule…</div>;
  if (state.status === "error") return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 28 }}>
      <h2 style={{ color: CORAL, margin: "0 0 8px" }}>Couldn't load schedule</h2>
      <p style={{ color: MUTED, margin: 0 }}>{state.message}</p>
    </div>
  );

  const survey = state.survey;
  const submittedCount = state.availability.filter((a) => a.submitted_at).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {saveError && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb", color: "#842029", borderRadius: 8, padding: "12px 16px", fontSize: 14 }}>
          {saveError}
        </div>
      )}

      <Header
        term={term}
        campCycles={campCycles}
        afterschoolTerms={afterschoolTerms}
        onSwitchTerm={onSwitchTerm}
        onSwitchToCamp={onSwitchToCamp}
        counts={counts}
        survey={survey}
        submittedCount={submittedCount}
        busy={busy}
        onOpenSurvey={() => setSurveyDialog({ mode: "choose", payload: null })}
        onMatch={handleMatch}
        hasPrograms={state.programs.length > 0}
      />

      {matchResult && (
        <div style={{ background: `${VIOLET}14`, border: `1px solid ${VIOLET}55`, borderRadius: 8, padding: "12px 16px", fontSize: 14, color: INK }}>
          Matched <strong>{matchResult.assigned}</strong> of {matchResult.programs_total} classes.{" "}
          {matchResult.needs_hire > 0 && <span>{matchResult.needs_hire} still need an instructor. </span>}
          {Array.isArray(matchResult.missing_surveys) && matchResult.missing_surveys.length > 0 && (
            <span style={{ color: MUTED }}>Waiting on availability from {matchResult.missing_surveys.length} instructor{matchResult.missing_surveys.length === 1 ? "" : "s"}.</span>
          )}
          <button onClick={() => setMatchResult(null)} style={linkBtn}>Dismiss</button>
        </div>
      )}

      <FilterBar
        searchText={searchText}
        setSearchText={setSearchText}
        locationOptions={locationOptions}
        selectedLocations={selectedLocations}
        setSelectedLocations={setSelectedLocations}
        selectedStatuses={selectedStatuses}
        setSelectedStatuses={setSelectedStatuses}
      />

      {state.programs.length > 0 && (
        <InstructorLoadStrip instructors={state.instructors} loadCount={loadCount} availByInstr={availByInstr} />
      )}

      {state.programs.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ display: "inline-flex", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
            {[["list", "List"], ["grid", "Week grid"]].map(([v, label]) => (
              <button key={v} type="button" onClick={() => setView(v)} style={{ border: "none", background: view === v ? `${PURPLE}12` : "#fff", color: view === v ? PURPLE : MUTED, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {state.programs.length === 0 ? (
        <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 8, padding: 28, textAlign: "center", color: MUTED }}>
          No {termDisplayName(term)} after-school classes yet. Classes you schedule for this term will appear here.
        </div>
      ) : view === "list" ? (
        <StaffingList
          programs={state.programs.filter(matchesFilters)}
          enriched={enriched}
          enrollment={state.enrollment}
          locName={locName}
          locArea={locArea}
          onRowClick={(p) => setPicker({ program: p })}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(5, minmax(0, 1fr))`, gap: 12, alignItems: "start" }}>
          {DAYS.map((d) => {
            const items = grid.get(d.code) ?? [];
            return (
              <div key={d.code} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textAlign: "center", padding: "6px 0", borderBottom: `2px solid ${RULE}` }}>
                  {d.label}
                  <span style={{ color: MUTED, fontWeight: 500, marginLeft: 6 }}>{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div style={{ color: MUTED, fontSize: 12, textAlign: "center", padding: "12px 0" }}>—</div>
                ) : (
                  items.map((p) => {
                    const e = enriched.get(p.id);
                    const loc = locName.get(p.program_location_id) ?? "—";
                    return (
                      <ProgramCard
                        key={p.id}
                        program={p}
                        loc={loc}
                        tint={colorMap.get(loc)}
                        status={e?.status}
                        lead={e?.lead}
                        onClick={() => setPicker({ program: p })}
                      />
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      {picker && (
        <PickerModal
          program={picker.program}
          loc={locName.get(picker.program.program_location_id) ?? "—"}
          current={enriched.get(picker.program.id)?.lead ?? null}
          instructors={state.instructors}
          evaluate={(id) => evaluate(id, picker.program)}
          onAssign={(id) => handleAssign(picker.program, id)}
          onRemove={() => handleRemove(picker.program)}
          onClose={() => setPicker(null)}
        />
      )}

      {surveyDialog && (
        <SurveyDialog
          dialog={surveyDialog}
          term={term}
          instructorCount={counts.instructors}
          deadline={surveyDeadline}
          setDeadline={setSurveyDeadline}
          busy={busy === "survey"}
          onRun={runSurvey}
          onClose={() => setSurveyDialog(null)}
        />
      )}
    </div>
  );
}

const linkBtn = { background: "transparent", border: "none", color: PURPLE, fontWeight: 600, cursor: "pointer", marginLeft: 10, fontSize: 13, textDecoration: "underline" };

function Header({ term, campCycles, afterschoolTerms, onSwitchTerm, onSwitchToCamp, counts, survey, submittedCount, busy, onOpenSurvey, onMatch, hasPrograms }) {
  // Unified term selector: afterschool terms (this view) + camp cycles (switches back to Schedule).
  const value = `as:${term}`;
  function onChange(e) {
    const v = e.target.value;
    if (v.startsWith("as:")) onSwitchTerm && onSwitchTerm(v.slice(3));
    else onSwitchToCamp && onSwitchToCamp(v);
  }
  return (
    <header style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "18px 22px", display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <select
            value={value}
            onChange={onChange}
            title="Switch term"
            style={{ fontSize: 16, fontWeight: 700, color: INK, letterSpacing: -0.2, fontFamily: "inherit", background: "transparent", border: "none", borderBottom: `2px dotted ${RULE}`, padding: "0 22px 2px 0", cursor: "pointer", appearance: "none",
              backgroundImage: `linear-gradient(45deg, transparent 50%, ${MUTED} 50%), linear-gradient(135deg, ${MUTED} 50%, transparent 50%)`,
              backgroundPosition: "calc(100% - 12px) center, calc(100% - 7px) center",
              backgroundSize: "5px 5px, 5px 5px",
              backgroundRepeat: "no-repeat" }}
          >
            <optgroup label="After-school">
              {afterschoolTerms.map((t) => (
                <option key={`as:${t}`} value={`as:${t}`}>{termDisplayName(t)}</option>
              ))}
            </optgroup>
            {campCycles.length > 0 && (
              <optgroup label="Camps">
                {campCycles.map((c) => (
                  <option key={c.id} value={c.id}>{termDisplayName(c.name)}</option>
                ))}
              </optgroup>
            )}
          </select>
          <span style={{ fontSize: 11, color: PURPLE, background: `${VIOLET}22`, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}>
            After-school
          </span>
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: MUTED, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span><strong style={{ color: INK }}>{counts.assigned + counts.accepted}</strong> assigned</span>
          <span><strong style={{ color: counts.needsHire ? CORAL : INK }}>{counts.needsHire}</strong> need an instructor</span>
          {counts.changeRequested > 0 && <span><strong style={{ color: CHANGE_REQ }}>{counts.changeRequested}</strong> change requested</span>}
          <span><strong style={{ color: INK }}>{counts.instructors}</strong> active instructors</span>
        </div>
        {survey?.opened_at ? (
          <div style={{ marginTop: 6, fontSize: 12, color: OK_GREEN }}>
            Survey open · {submittedCount} submitted{survey.deadline ? ` · due ${fmtDeadline(survey.deadline)}` : ""}
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>Availability survey not sent yet.</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onOpenSurvey}
          disabled={!!busy}
          style={{ ...btnStyle, background: "#fff", color: PURPLE, border: `1.5px solid ${PURPLE}` }}
        >
          {survey?.opened_at ? "Resend survey" : "Open availability survey"}
        </button>
        <button
          type="button"
          onClick={onMatch}
          disabled={!!busy || !hasPrograms}
          style={{ ...btnStyle, background: PURPLE, color: "#fff", border: `1.5px solid ${PURPLE}`, opacity: busy === "matching" ? 0.7 : 1 }}
        >
          {busy === "matching" ? "Matching…" : "Match instructors"}
        </button>
      </div>
    </header>
  );
}

const btnStyle = { padding: "10px 16px", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" };

function FilterBar({ searchText, setSearchText, locationOptions, selectedLocations, setSelectedLocations, selectedStatuses, setSelectedStatuses }) {
  function toggle(set, setter, key) {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    setter(next);
  }
  const hasFilters = searchText || selectedLocations.size || selectedStatuses.size;
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "12px 16px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
      <input
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder="Search class, school, instructor…"
        style={{ flex: "1 1 220px", minWidth: 180, padding: "8px 12px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTER_STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => toggle(selectedStatuses, setSelectedStatuses, s.key)}
            style={chip(selectedStatuses.has(s.key), statusColor(s.key))}
          >
            {s.label}
          </button>
        ))}
      </div>
      {locationOptions.length > 0 && (
        <select
          onChange={(e) => { if (e.target.value) { toggle(selectedLocations, setSelectedLocations, e.target.value); e.target.value = ""; } }}
          value=""
          style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 13, fontFamily: "inherit", color: MUTED }}
        >
          <option value="">+ Filter school…</option>
          {locationOptions.filter((l) => !selectedLocations.has(l)).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      {[...selectedLocations].map((l) => (
        <button key={l} onClick={() => toggle(selectedLocations, setSelectedLocations, l)} style={chip(true, PURPLE)}>{l} ✕</button>
      ))}
      {hasFilters && (
        <button onClick={() => { setSearchText(""); setSelectedLocations(new Set()); setSelectedStatuses(new Set()); }} style={linkBtn}>Clear</button>
      )}
    </div>
  );
}

function chip(active, color) {
  return {
    padding: "5px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
    border: `1.5px solid ${active ? color : RULE}`,
    background: active ? `${color}18` : "#fff",
    color: active ? color : MUTED,
  };
}

function gradeLabel(g) {
  if (g === 0) return "K";
  return g == null ? "?" : String(g);
}

function Pill({ status }) {
  const c = statusColor(status);
  return (
    <span style={{ fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 999, color: c, background: `${c}1F`, whiteSpace: "nowrap", display: "inline-block" }}>
      {statusLabel(status)}
    </span>
  );
}

function InstructorLoadStrip({ instructors, loadCount, availByInstr }) {
  const rows = instructors.map((i) => {
    const av = availByInstr.get(i.id);
    const submitted = av && Object.values(av.weekday_availability || {}).some((w) => w && w.from);
    return {
      id: i.id,
      name: (i.preferred_name || i.first_name) + (i.last_name ? ` ${i.last_name}` : ""),
      n: loadCount.get(i.id) ?? 0,
      cap: av?.max_days ?? null,
      submitted,
    };
  }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (rows.length === 0) return null;
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 14px", display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 700, marginRight: 4 }}>Instructor load</span>
      {rows.map((r) => {
        const full = r.cap != null && r.n >= r.cap;
        return (
          <span key={r.id} style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999, border: `1px solid ${full ? OK_GREEN : RULE}`, color: !r.submitted ? MUTED : (full ? OK_GREEN : INK), background: "#fff", opacity: r.submitted ? 1 : 0.7 }}>
            {r.name}
            <span style={{ color: MUTED, fontWeight: 500 }}>
              {" · "}
              {r.submitted ? `${r.n}${r.cap != null ? ` / ${r.cap}${full ? " (full)" : ""}` : ""}` : "no availability yet"}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function StaffingList({ programs, enriched, enrollment, locName, locArea, onRowClick }) {
  const byDay = new Map(DAYS.map((d) => [d.code, []]));
  for (const p of programs) {
    const code = DAY_TO_CODE[dayKey(p.day_of_week)];
    if (byDay.has(code)) byDay.get(code).push(p);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => (parse12h(a.start_time) ?? 0) - (parse12h(b.start_time) ?? 0));
  const anyRows = DAYS.some((d) => (byDay.get(d.code) ?? []).length > 0);
  if (!anyRows) {
    return <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 8, padding: 24, textAlign: "center", color: MUTED }}>No classes match your filters.</div>;
  }
  const td = { padding: "11px 14px", borderTop: "1px solid #f0eee6", fontSize: 13.5, verticalAlign: "middle" };
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
      {DAYS.map((d) => {
        const items = byDay.get(d.code) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={d.code}>
            <div style={{ background: CREAM, padding: "7px 14px", fontSize: 12, fontWeight: 700, color: PURPLE, borderTop: `1px solid ${RULE}` }}>
              {d.label} <span style={{ color: MUTED, fontWeight: 500 }}>· {items.length} class{items.length === 1 ? "" : "es"}</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {items.map((p) => {
                  const e = enriched.get(p.id);
                  const loc = locName.get(p.program_location_id) ?? "—";
                  const area = locArea.get(p.program_location_id);
                  const lead = e?.lead;
                  const who = lead ? ((lead.instructor_preferred || lead.instructor_first || "Instructor") + (lead.instructor_last ? ` ${lead.instructor_last}` : "")) : null;
                  const enr = enrollment?.[p.id];
                  return (
                    <tr key={p.id} onClick={() => onRowClick(p)} style={{ cursor: "pointer" }}>
                      <td style={{ ...td, width: "26%" }}>
                        <div style={{ fontWeight: 700, color: INK }}>{p.curriculum || "Class"}</div>
                        {(p.grade_min != null || p.grade_max != null) && (
                          <div style={{ fontSize: 11.5, color: MUTED }}>Grades {gradeLabel(p.grade_min)}–{gradeLabel(p.grade_max)}</div>
                        )}
                      </td>
                      <td style={{ ...td, width: "20%" }}>
                        {loc}{area && <span style={{ color: MUTED }}> · {area}</span>}
                      </td>
                      <td style={{ ...td, width: "20%" }}>
                        <span style={{ fontWeight: 600, color: INK }}>{fmtTimeRange(p.start_time, p.end_time)}</span>
                        <div style={{ fontSize: 11.5, color: PURPLE, fontWeight: 600 }}>all term</div>
                      </td>
                      <td style={{ ...td, width: "10%" }}>
                        {enr ? <><span style={{ fontWeight: 600, color: INK }}>{enr.enrolled}</span><span style={{ color: MUTED }}> / {enr.max ?? "—"}</span></> : <span style={{ color: MUTED }}>—</span>}
                      </td>
                      <td style={{ ...td, width: "13%" }}>
                        {who ? <span style={{ fontWeight: 600, color: INK }}>{who}</span> : <span style={{ color: PURPLE, fontWeight: 600 }}>+ Assign</span>}
                      </td>
                      <td style={{ ...td, width: "11%" }}><Pill status={e?.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function ProgramCard({ program, loc, tint, status, lead, onClick }) {
  const sc = statusColor(status);
  const who = lead ? (lead.instructor_preferred || lead.instructor_first || "Instructor") + (lead.instructor_last ? ` ${lead.instructor_last}` : "") : null;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left", width: "100%", cursor: "pointer", fontFamily: "inherit",
        background: tint || "#fff", border: `1px solid ${RULE}`, borderLeft: `4px solid ${sc}`,
        borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, lineHeight: 1.25 }}>{program.curriculum || "Class"}</div>
      <div style={{ fontSize: 12, color: PURPLE, fontWeight: 600 }}>{loc}</div>
      {(program.start_time || program.end_time) && (
        <div style={{ fontSize: 11, color: MUTED }}>{fmtTimeRange(program.start_time, program.end_time)}</div>
      )}
      <div style={{ marginTop: 2, fontSize: 12, color: who ? INK : sc, fontWeight: who ? 500 : 600 }}>
        {who || "+ Assign"}
      </div>
      <div style={{ fontSize: 10, color: sc, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{statusLabel(status)}</div>
      {status === "flagged" && lead && Array.isArray(lead.flags) && lead.flags.length > 0 && (
        <div style={{ fontSize: 10, color: VIOLET, fontWeight: 600, lineHeight: 1.3 }}>
          {lead.flags.includes("location_override")
            ? `In an area they marked unavailable · +$${Math.round((lead.distance_bonus_cents || 0) / 100)} bonus`
            : lead.flags.includes("location_low_pref")
            ? `In a not-preferred area · +$${Math.round((lead.distance_bonus_cents || 0) / 100)} bonus`
            : null}
        </div>
      )}
    </button>
  );
}

function PickerModal({ program, loc, current, instructors, evaluate, onAssign, onRemove, onClose }) {
  const rows = instructors.map((i) => {
    const ev = evaluate(i.id);
    return { inst: i, ev };
  });
  const prefRank = { highly_preferred: 0, preferred: 1, undefined: 2, not_preferred: 3, unavailable: 4 };
  const eligible = rows.filter((r) => r.ev.ok).sort((a, b) => (prefRank[a.ev.pref] ?? 2) - (prefRank[b.ev.pref] ?? 2));
  const ineligible = rows.filter((r) => !r.ev.ok);
  return (
    <Overlay onClose={onClose}>
      <div style={{ padding: "20px 22px", borderBottom: `1px solid ${RULE}` }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: INK }}>{program.curriculum || "Class"}</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{loc} · {program.day_of_week}{program.start_time ? ` · ${fmtTimeRange(program.start_time, program.end_time)}` : ""}</div>
        {current && (
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: INK }}>Currently: <strong>{(current.instructor_preferred || current.instructor_first) ?? "—"} {current.instructor_last ?? ""}</strong></span>
            <button onClick={onRemove} style={{ ...linkBtn, color: CORAL }}>Remove</button>
          </div>
        )}
      </div>
      <div style={{ maxHeight: "55vh", overflowY: "auto", padding: "12px 14px" }}>
        {eligible.length === 0 && <div style={{ color: MUTED, fontSize: 13, padding: "8px 6px" }}>No available instructors for this day.</div>}
        {eligible.map(({ inst, ev }) => (
          <button
            key={inst.id}
            onClick={() => onAssign(inst.id)}
            disabled={current?.instructor_id === inst.id}
            style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: `1px solid ${RULE}`, background: current?.instructor_id === inst.id ? "#f3f1ea" : "#fff", cursor: current?.instructor_id === inst.id ? "default" : "pointer", marginBottom: 6, fontFamily: "inherit" }}
          >
            <span style={{ fontSize: 14, color: INK, fontWeight: 600 }}>{inst.preferred_name || inst.first_name} {inst.last_name}</span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {ev.pref === "highly_preferred" && <Tag color={OK_GREEN}>Loves this area</Tag>}
              {ev.pref === "preferred" && <Tag color={PURPLE}>Prefers this area</Tag>}
              {ev.warnings.length > 0 && <Tag color={CORAL}>⚠ {ev.warnings.length}</Tag>}
            </span>
          </button>
        ))}
        {ineligible.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, padding: "4px 6px" }}>Not available</div>
            {ineligible.map(({ inst, ev }) => (
              <div key={inst.id} style={{ padding: "8px 12px", fontSize: 13, color: MUTED, display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 600 }}>{inst.preferred_name || inst.first_name} {inst.last_name}</span>
                <span style={{ fontSize: 12 }}>{ev.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: "12px 18px", borderTop: `1px solid ${RULE}`, textAlign: "right" }}>
        <button onClick={onClose} style={{ ...btnStyle, background: "#fff", color: MUTED, border: `1px solid ${RULE}` }}>Close</button>
      </div>
    </Overlay>
  );
}

function Tag({ color, children }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}18`, padding: "2px 7px", borderRadius: 999 }}>{children}</span>;
}

function SurveyDialog({ dialog, term, instructorCount, deadline, setDeadline, busy, onRun, onClose }) {
  if (dialog.mode === "result") {
    const { mode, data } = dialog.payload;
    return (
      <Overlay onClose={onClose}>
        <div style={{ padding: 24 }}>
          <h3 style={{ margin: "0 0 10px", color: INK }}>
            {mode === "send" ? "Survey sent" : mode === "test" ? "Test sent to you" : "Preview ready"}
          </h3>
          <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px" }}>
            {mode === "preview"
              ? `${data?.preview?.length ?? 0} instructor email(s) rendered — no emails sent.`
              : `Sent to ${data?.sent ?? 0} of ${data?.recipient_count ?? 0} instructor(s).`}
            {Array.isArray(data?.failed) && data.failed.length > 0 && ` ${data.failed.length} failed.`}
          </p>
          <div style={{ textAlign: "right" }}>
            <button onClick={onClose} style={{ ...btnStyle, background: PURPLE, color: "#fff" }}>Done</button>
          </div>
        </div>
      </Overlay>
    );
  }
  return (
    <Overlay onClose={onClose}>
      <div style={{ padding: 24, maxWidth: 460 }}>
        <h3 style={{ margin: "0 0 6px", color: INK }}>Open the {termDisplayName(term)} availability survey</h3>
        <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px" }}>
          Emails every active instructor ({instructorCount}) a link to tell you which weekdays they can teach this term.
        </p>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>Response deadline (optional)</label>
        <input type="date" value={deadline ?? ""} onChange={(e) => setDeadline(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit", marginBottom: 20 }} />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={() => onRun("test")} disabled={busy} style={{ ...btnStyle, background: "#fff", color: PURPLE, border: `1.5px solid ${PURPLE}` }}>Send test to me</button>
          <button onClick={() => onRun("send")} disabled={busy} style={{ ...btnStyle, background: PURPLE, color: "#fff" }}>
            {busy ? "Sending…" : `Send to ${instructorCount} instructor${instructorCount === 1 ? "" : "s"}`}
          </button>
        </div>
        <div style={{ textAlign: "right", marginTop: 12 }}>
          <button onClick={onClose} style={linkBtn}>Cancel</button>
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,12,40,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 560, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        {children}
      </div>
    </div>
  );
}
