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
import NotifyRemovalModal from "./NotifyRemovalModal.jsx";
import AssignSubModal from "./AssignSubModal";
import HatGuide from "../../components/HatGuide";
import NeedsCoverBanner from "../../components/NeedsCoverBanner.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
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

// Sub statuses that are "live" — shown on the board, counted by the filter. Excludes declined/missed.
const SUB_SHOWN_STATUSES = new Set(["pending", "confirmed", "taught"]);

// --- Calendar-week helpers (UTC-based so they never shift across the user's tz). ---
// These bucket CANONICAL session dates (from derive_program_session_dates) into weeks;
// they never DERIVE which dates a class meets — that always comes from the RPC.
function weekStartOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();              // 0=Sun..6=Sat
  dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -6 : 1 - dow)); // back to Monday
  return dt.toISOString().slice(0, 10);
}
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function fmtWeekLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
function fmtDateShort(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

// Map raw edge-function/Resend failure strings to plain English (no codes/JSON in UI).
function friendlyFailReason(reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("api key is invalid") || r.includes("resend 401") || r.includes("401")) return "Email service rejected the key — staging’s email key isn’t set up yet, so nothing was sent.";
  if (r.includes("missing email") || r.includes("no email")) return "No email address on file for this instructor.";
  if (r.includes("resend") || r.includes("email")) return "The email service couldn’t send right now — nothing was sent.";
  return "Couldn’t send to this instructor.";
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
    ok: "Not yet sent",
  })[status] || status;
}

export default function AfterschoolSchedule({ org, term, campCycles = [], afterschoolTerms = [], onSwitchTerm, onSwitchToCamp }) {
  const [state, setState] = useState({ status: "loading" });
  const [searchText, setSearchText] = useState("");
  const [selectedLocations, setSelectedLocations] = useState(() => new Set());
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set());
  const [selectedInstructors, setSelectedInstructors] = useState(() => new Set());
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(null); // 'matching' | 'survey' | null
  const [picker, setPicker] = useState(null); // { program }
  const [surveyDialog, setSurveyDialog] = useState(null); // { mode:'choose'|'result', payload }
  const [surveyDeadline, setSurveyDeadline] = useState(() => businessDaysFromToday(10));
  const [surveySelectedIds, setSurveySelectedIds] = useState(null); // Set<id> | null (=all)
  const [surveyIntro, setSurveyIntro] = useState(""); // editable lead paragraph
  const [matchResult, setMatchResult] = useState(null);
  const [view, setView] = useState("grid"); // 'list' | 'grid' — default to the week-at-a-glance grid
  // Week focus for the week-grid view. undefined = use the default (current/upcoming) week;
  // null = "Every week" (recurring overview); 'YYYY-MM-DD' (a Monday) = that specific week.
  const [focusedWeekStart, setFocusedWeekStart] = useState(undefined);
  // Stage B — offer loop.
  const [offerDialog, setOfferDialog] = useState(null); // { mode:'choose'|'result', payload }
  const [offerDeadline, setOfferDeadline] = useState(() => businessDaysFromToday(5));
  const [selectedInstructorIds, setSelectedInstructorIds] = useState(null); // Set<id> | null (=all)
  const [reviewFor, setReviewFor] = useState(null); // { program, assignment } — offer review / change-request modal
  const [notifyRemoval, setNotifyRemoval] = useState(null); // { mode, program, assignment, instructor, remaining, onProceed }
  const [assignSubFor, setAssignSubFor] = useState(null); // { program, lead, dates } — day-of sub assignment modal
  const [approveResult, setApproveResult] = useState(null);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  async function loadAll() {
    if (!org?.id || !term) return;
    setState({ status: "loading" });
    try {
      const [progRes, locRes, instRes, availRes, surveyRes, areaPrefRes, cycleRes] = await Promise.all([
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
        // The afterschool scheduling_cycle for this term holds the auto-reminder
        // toggle the cron gates on. Programs link by term (not cycle_id), and not
        // every term has a cycle row yet — the Reminders control creates one on
        // first enable. limit(1) keeps maybeSingle safe if a dupe ever exists.
        supabase
          .from("scheduling_cycles")
          .select("id, auto_reminders_enabled")
          .eq("organization_id", org.id)
          .eq("cycle_type", "afterschool")
          .eq("name", term)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      if (progRes.error) throw progRes.error;
      if (locRes.error) throw locRes.error;
      if (instRes.error) throw instRes.error;
      if (availRes.error) throw availRes.error;
      if (surveyRes.error) throw surveyRes.error;
      if (areaPrefRes.error) throw areaPrefRes.error;
      if (cycleRes.error) throw cycleRes.error;

      const programs = (progRes.data ?? []).filter((p) => DAY_TO_CODE[dayKey(p.day_of_week)]);
      const programIds = programs.map((p) => p.id);

      const assignRes = programIds.length
        ? await supabase
            .from("program_assignments")
            .select("id, program_id, instructor_id, status, role, flags, distance_bonus_cents, instructor_response_at, email_sent_at, change_request_message, flagged_reason, deadline, published_at, instructor:instructors(id, first_name, last_name, preferred_name, email)")
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
        deadline: a.deadline ?? null,
        published_at: a.published_at ?? null,
        instructor_first: a.instructor?.first_name ?? null,
        instructor_last: a.instructor?.last_name ?? null,
        instructor_preferred: a.instructor?.preferred_name ?? null,
        instructor_email: a.instructor?.email ?? null,
      }));

      // Day-of substitute coverage for these program assignments (parent_assignment_type='program').
      const assignmentIds = assignments.map((a) => a.id);
      let substitutions = [];
      if (assignmentIds.length) {
        const { data: subRows, error: subErr } = await supabase
          .from("assignment_substitutions")
          .select("id, parent_assignment_id, date, status, sub_tier, sub_instructor_id, sub:instructors!sub_instructor_id(first_name, last_name)")
          .eq("parent_assignment_type", "program")
          .in("parent_assignment_id", assignmentIds);
        if (subErr) console.warn("[AfterschoolSchedule] sub load failed:", subErr.message);
        else substitutions = subRows ?? [];
      }

      // Each class's real session dates (per its school/district calendar, closures included)
      // — used to build the week rail and resolve per-week coverage. Canonical source only.
      // Fail-soft per class: one rejected RPC must not blank the whole board (or the
      // list/recurring views, which don't need dates). A failed class just gets no weeks.
      const dateResults = await Promise.all(
        programs.map((p) =>
          supabase.rpc("derive_program_session_dates", { p_program_id: p.id }).then((r) => r, () => ({ data: [] })),
        ),
      );
      const programDates = {};
      programs.forEach((p, i) => {
        const d = dateResults[i]?.data;
        programDates[p.id] = Array.isArray(d) ? d : [];
      });

      setState({
        status: "ready",
        programs,
        assignments,
        substitutions,
        programDates,
        instructors: instRes.data ?? [],
        availability: availRes.data ?? [],
        locations: locRes.data ?? [],
        survey: surveyRes.data ?? null,
        areaPrefs: areaPrefRes.data ?? [],
        enrollment,
        cycle: cycleRes.data ?? null,
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

  // Reset week focus to the default when the term or org changes.
  useEffect(() => { setFocusedWeekStart(undefined); }, [term, org?.id]);

  // Realtime: when an instructor accepts / requests a change in their portal,
  // the board updates without a manual refresh. Reload on any program_assignments
  // change that touches a program in the current term.
  useEffect(() => {
    if (!org?.id || !term) return;
    const channel = supabase
      .channel(`as-assignments-${org.id}-${term}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "program_assignments", filter: `organization_id=eq.${org.id}` },
        (payload) => {
          const pid = payload.new?.program_id ?? payload.old?.program_id;
          const progs = stateRef.current?.programs ?? [];
          if (pid && progs.some((p) => p.id === pid)) loadAll();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
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

  // program_id -> { ids:Set<instructor_id>, names:string[], subs:[{name,date,status}] } for live subs.
  // Powers the card sub indicator and lets the instructor filter surface a program a person only SUBs.
  const subInfoByProgram = useMemo(() => {
    const m = new Map();
    if (state.status !== "ready") return m;
    const asgToProgram = new Map(state.assignments.map((a) => [a.id, a.program_id]));
    for (const s of state.substitutions ?? []) {
      if (!SUB_SHOWN_STATUSES.has(s.status)) continue;
      const pid = asgToProgram.get(s.parent_assignment_id);
      if (!pid) continue;
      if (!m.has(pid)) m.set(pid, { ids: new Set(), names: [], subs: [] });
      const entry = m.get(pid);
      if (s.sub_instructor_id) entry.ids.add(s.sub_instructor_id);
      const nm = [s.sub?.first_name, s.sub?.last_name].filter(Boolean).join(" ");
      if (nm) entry.names.push(nm);
      entry.subs.push({ name: nm || "Sub", date: s.date, status: s.status });
    }
    return m;
  }, [state]);

  // Calendar weeks present in this term — the union of every class's real session dates,
  // bucketed by Monday. Empty weeks (all schools off) simply don't appear.
  const weeks = useMemo(() => {
    if (state.status !== "ready") return [];
    const counts = new Map(); // weekStart(Monday) -> session count
    const pd = state.programDates ?? {};
    for (const pid in pd) for (const dt of pd[pid]) {
      const ws = weekStartOf(dt);
      counts.set(ws, (counts.get(ws) ?? 0) + 1);
    }
    if (counts.size === 0) return [];
    const sorted = [...counts.keys()].sort();
    // Split into segments wherever consecutive class-weeks are >4 weeks apart, so stray
    // off-term dates (e.g. summer classes mis-tagged to a fall term) don't drag in weeks
    // of phantom "break". Keep the densest segment = the actual term.
    const GAP_DAYS = 28;
    const segments = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const gap = (Date.parse(`${sorted[i]}T00:00:00Z`) - Date.parse(`${sorted[i - 1]}T00:00:00Z`)) / 86400000;
      if (gap > GAP_DAYS) segments.push([]);
      segments[segments.length - 1].push(sorted[i]);
    }
    let term = segments[0], best = -1;
    for (const s of segments) {
      const total = s.reduce((n, w) => n + (counts.get(w) ?? 0), 0);
      if (total > best) { best = total; term = s; }
    }
    // Fill every week across the term so in-term breaks (e.g. Thanksgiving) show as
    // labeled "Break" weeks rather than holes.
    const out = [];
    for (let cur = term[0]; cur <= term[term.length - 1]; cur = addDaysIso(cur, 7)) {
      out.push({ start: cur, end: addDaysIso(cur, 6), label: fmtWeekLabel(cur), isBreak: !counts.has(cur) });
    }
    return out;
  }, [state]);

  // Default focus = current/upcoming week (first whose end >= today), else the last week.
  const defaultWeekStart = useMemo(() => {
    if (weeks.length === 0) return null;
    const t = todayIso();
    return (weeks.find((w) => !w.isBreak && w.end >= t) ?? weeks.find((w) => !w.isBreak) ?? weeks[weeks.length - 1]).start;
  }, [weeks]);
  const effectiveWeek = focusedWeekStart === undefined ? defaultWeekStart : focusedWeekStart;

  // Per-week "needs attention" signals for the rail dot + closure notes:
  //   gap      = a class meets this week but has no lead instructor (drives the orange dot)
  //   closures = classes active AROUND this week but off it (a genuine mid-term break,
  //              not a term-boundary) — listed by school name.
  const weekSignals = useMemo(() => {
    const m = new Map();
    if (state.status !== "ready") return m;
    for (const w of weeks) m.set(w.start, { gap: false, closures: [] });
    const pd = state.programDates ?? {};
    for (const p of state.programs) {
      const dates = [...(pd[p.id] ?? [])].sort();
      if (dates.length === 0) continue;
      const metWeeks = new Set(dates.map(weekStartOf));
      const firstW = weekStartOf(dates[0]);
      const lastW = weekStartOf(dates[dates.length - 1]);
      // Only call a missing week a "closure" for classes that actually meet weekly —
      // otherwise a biweekly/irregular class's normal off-weeks would look like breaks.
      const spanWeeks = weeks.filter((w) => w.start >= firstW && w.start <= lastW).length;
      const isWeekly = spanWeeks > 0 && metWeeks.size / spanWeeks >= 0.75;
      const e = enriched.get(p.id);
      const needsHire = !e?.lead;
      const schoolName = locName.get(p.program_location_id) ?? p.curriculum ?? "A class";
      for (const w of weeks) {
        const sig = m.get(w.start);
        if (!sig) continue;
        if (metWeeks.has(w.start)) {
          if (needsHire) sig.gap = true;
        } else if (!w.isBreak && isWeekly && w.start > firstW && w.start < lastW && !sig.closures.includes(schoolName)) {
          sig.closures.push(schoolName);
        }
      }
    }
    return m;
  }, [state, weeks, enriched, locName]);

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
    const c = { assigned: 0, accepted: 0, flagged: 0, changeRequested: 0, needsHire: 0, instructors: 0, proposed: 0, sendable: 0 };
    if (state.status !== "ready") return c;
    for (const e of enriched.values()) {
      if (e.status === "needs_hire") c.needsHire++;
      else if (e.status === "change_requested") c.changeRequested++;
      else if (e.status === "flagged") c.flagged++;
      else if (e.status === "accepted") c.accepted++;
      else c.assigned++;
    }
    for (const a of state.assignments) {
      if (a.status === "proposed") c.proposed++;
      else if (a.status === "confirmed" && !a.email_sent_at) c.sendable++;
    }
    c.instructors = state.instructors.length;
    return c;
  }, [state, enriched]);

  // Instructors who actually have approved (confirmed, not-yet-emailed) classes —
  // the real recipients of a Send. The Send modal lists + pre-selects exactly these.
  const sendableInstructors = useMemo(() => {
    if (state.status !== "ready") return [];
    const ids = new Set();
    for (const a of state.assignments) {
      if (a.status === "confirmed" && !a.email_sent_at && a.instructor_id) ids.add(a.instructor_id);
    }
    return state.instructors.filter((i) => ids.has(i.id));
  }, [state]);

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
    if (pref === "unavailable") warnings.push(`${first} marked ${area} as a place they can't go.`);
    if (av.needs_confirmation) warnings.push(`${first}'s availability is unconfirmed.`);
    return { ok: true, reason: null, pref, warnings };
  }

  function matchesFilters(p) {
    const e = enriched.get(p.id);
    const loc = locName.get(p.program_location_id) ?? "—";
    if (selectedLocations.size && !selectedLocations.has(loc)) return false;
    if (selectedStatuses.size && !selectedStatuses.has(e?.status)) return false;
    const subInfo = subInfoByProgram.get(p.id);
    if (selectedInstructors.size) {
      let hit = !!(e?.lead?.instructor_id && selectedInstructors.has(e.lead.instructor_id));
      if (!hit && subInfo) {
        for (const id of subInfo.ids) { if (selectedInstructors.has(id)) { hit = true; break; } }
      }
      if (!hit) return false;
    }
    const q = searchText.trim().toLowerCase();
    if (q) {
      const hay = [p.curriculum, loc, e?.lead?.instructor_first, e?.lead?.instructor_last, ...(subInfo?.names ?? [])].filter(Boolean).join(" ").toLowerCase();
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
      if (!byDay.has(code)) continue;
      if (effectiveWeek) {
        // Week mode: only show classes that actually meet this week (per their calendar).
        const wd = (state.programDates?.[p.id] ?? []).find((dt) => weekStartOf(dt) === effectiveWeek);
        if (!wd) continue;
        byDay.get(code).push({ program: p, weekDate: wd });
      } else {
        byDay.get(code).push({ program: p, weekDate: null });
      }
    }
    return byDay;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, enriched, searchText, selectedLocations, selectedStatuses, selectedInstructors, locName, effectiveWeek]);

  const locationOptions = useMemo(() => {
    if (state.status !== "ready") return [];
    const set = new Set(state.programs.map((p) => locName.get(p.program_location_id)).filter(Boolean));
    return Array.from(set).sort();
  }, [state, locName]);

  // Clears all offer state on reassign (mirrors camps) so the new instructor
  // starts fresh at 'proposed' and surfaces as needing a (re)send.
  async function performAssign(program, instructorId, current) {
    try {
      if (current) {
        const { error } = await supabase
          .from("program_assignments")
          .update({
            instructor_id: instructorId,
            status: "proposed",
            email_sent_at: null,
            instructor_response_at: null,
            flagged_reason: null,
            change_request_message: null,
            published_at: null,
            deadline: null,
            reminder_sent_at: null,
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

  async function handleAssign(program, instructorId) {
    const e = enriched.get(program.id);
    const current = e?.lead ?? null;
    if (current && current.instructor_id === instructorId) { setPicker(null); return; }
    // Reassigning away from an already-emailed instructor → warm heads-up first.
    if (current && current.instructor_id && current.email_sent_at) {
      const displaced = current;
      setPicker(null);
      setNotifyRemoval({
        mode: "reassign",
        program,
        assignment: displaced,
        instructor: { id: displaced.instructor_id, first_name: displaced.instructor_first, preferred_name: displaced.instructor_preferred, email: displaced.instructor_email },
        remaining: remainingActiveFor(displaced.instructor_id, displaced.id),
        onProceed: async () => { await performAssign(program, instructorId, displaced); setNotifyRemoval(null); },
      });
      return;
    }
    await performAssign(program, instructorId, current);
  }

  async function handleRemove(program) {
    const e = enriched.get(program.id);
    const current = e?.lead ?? null;
    if (!current) { setPicker(null); return; }
    setPicker(null);
    await handleReviewRemove(program, current);
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

  // Default lead paragraph for the survey email — matches the edge fn's fallback,
  // so the textarea shows exactly what instructors get if left unedited.
  const defaultSurveyIntro = `We're planning the ${termDisplayName(term)} after-school schedule and want to know which days you can teach.`;

  // Open the survey drawer. Pre-select recipients: never sent → all active
  // instructors; already open → only the non-responders (the straggler / new-hire
  // nudge). Only instructors with an email on file are selectable — the send skips
  // anyone without one, so they must not be silently counted as recipients.
  // Seed the intro with the default copy so it's editable in place, and pre-fill
  // the deadline from the open survey (don't silently push it out on a re-send).
  function openSurvey() {
    if (state.status !== "ready") return;
    const submitted = new Set(state.availability.filter((a) => a.submitted_at).map((a) => a.instructor_id));
    const alreadyOpen = !!state.survey?.opened_at;
    const preselect = state.instructors
      .filter((i) => !!i.email)
      .filter((i) => (alreadyOpen ? !submitted.has(i.id) : true))
      .map((i) => i.id);
    setSurveySelectedIds(new Set(preselect));
    setSurveyIntro(defaultSurveyIntro);
    // Keep the survey's existing deadline on a re-send (blank stays blank if they
    // opened it with no deadline); default to +10 business days on a first open.
    // Normalize to YYYY-MM-DD for <input type="date"> in case the column ever
    // carries a timestamp.
    setSurveyDeadline(alreadyOpen ? (state.survey?.deadline ? String(state.survey.deadline).slice(0, 10) : "") : businessDaysFromToday(10));
    setSurveyDialog({ mode: "choose", payload: null });
  }

  // Resolve the recipients: only selected instructors that actually have an email
  // (the send skips the rest — never let a no-email id ride along and desync counts).
  function surveyRecipientIds() {
    if (state.status !== "ready" || !surveySelectedIds) return [];
    const emailable = new Set(state.instructors.filter((i) => !!i.email).map((i) => i.id));
    return Array.from(surveySelectedIds).filter((id) => emailable.has(id));
  }

  function surveyBody(mode) {
    const ids = surveyRecipientIds();
    const intro = surveyIntro.trim() && surveyIntro.trim() !== defaultSurveyIntro ? surveyIntro.trim() : null;
    return { organization_id: org.id, term, mode, deadline: surveyDeadline || null, instructor_ids: ids, intro };
  }

  // In-app preview: renders the real survey email(s) without sending anything.
  async function previewSurvey() {
    const { data, error } = await supabase.functions.invoke("send-afterschool-survey", { body: surveyBody("preview") });
    if (error) {
      let msg = error.message ?? "function error";
      try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data.preview || [];
  }

  async function runSurvey(mode) {
    // Hard guard: never send/test with an empty recipient set. The buttons are
    // disabled at zero, but the edge fn reads an empty list as "everyone", so a
    // stray call here must not blast the whole roster.
    if (surveyRecipientIds().length === 0) {
      setSaveError("Pick at least one instructor with an email on file before sending.");
      setTimeout(() => setSaveError(null), 6000);
      return;
    }
    setBusy("survey");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-afterschool-survey", { body: surveyBody(mode) });
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

  const programIds = useMemo(() => (state.status === "ready" ? state.programs.map((p) => p.id) : []), [state]);

  function remainingActiveFor(instructorId, exceptAssignmentId) {
    if (state.status !== "ready") return 0;
    return state.assignments.filter(
      (a) => a.instructor_id === instructorId && a.id !== exceptAssignmentId && a.status !== "withdrawn" && a.status !== "declined",
    ).length;
  }

  function removalSession(program) {
    const loc = program?.program_location_id ? locName.get(program.program_location_id) : "";
    const label = [program?.curriculum, loc].filter(Boolean).join(" at ");
    return { location_name: label || "your class", starts_on: null };
  }

  // Approve: flip every proposed match in this term to confirmed (ready to send).
  // Never touches rows an instructor already accepted.
  async function handleApprove() {
    if (programIds.length === 0) return;
    const ok = window.confirm(
      "Approve all proposed matches for this term? This moves them to ‘ready to send’ so you can email offers. It won’t change anything an instructor has already accepted."
    );
    if (!ok) return;
    setBusy("approving");
    setSaveError(null);
    setApproveResult(null);
    try {
      const { data, error } = await supabase
        .from("program_assignments")
        .update({ status: "confirmed" })
        .eq("organization_id", org.id)
        .eq("status", "proposed")
        .in("program_id", programIds)
        .select("id");
      if (error) throw error;
      setApproveResult({ count: (data ?? []).length });
      await loadAll();
    } catch (err) {
      console.error("Approve failed:", err);
      setSaveError(`Couldn't approve: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 8000);
    } finally {
      setBusy(null);
    }
  }

  async function runOffers(mode) {
    setBusy("offers");
    setSaveError(null);
    try {
      const instructor_ids = selectedInstructorIds && selectedInstructorIds.size > 0 ? Array.from(selectedInstructorIds) : null;
      const { data, error } = await supabase.functions.invoke("send-afterschool-offers", {
        body: { organization_id: org.id, term, mode, instructor_ids, deadline: offerDeadline || null },
      });
      if (error) {
        let msg = error.message ?? "function error";
        try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setOfferDialog({ mode: "result", payload: { mode, data } });
      if (mode === "send") await loadAll();
    } catch (err) {
      console.error("Send offers failed:", err);
      setSaveError(`Couldn't send offers: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 8000);
    } finally {
      setBusy(null);
    }
  }

  // In-app preview: renders the real offer email(s) without sending anything.
  // Returns [{ instructor_id, to, subject, html, text }].
  async function previewOffers() {
    const instructor_ids = selectedInstructorIds && selectedInstructorIds.size > 0 ? Array.from(selectedInstructorIds) : null;
    const { data, error } = await supabase.functions.invoke("send-afterschool-offers", {
      body: { organization_id: org.id, term, mode: "preview", instructor_ids, deadline: offerDeadline || null },
    });
    if (error) {
      let msg = error.message ?? "function error";
      try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data.preview || [];
  }

  async function deleteAssignment(assignmentId) {
    const { error } = await supabase.from("program_assignments").delete().eq("id", assignmentId);
    if (error) throw error;
  }

  // Remove from the schedule. If the offer email already went out, warm-notify first.
  async function handleReviewRemove(program, assignment) {
    if (assignment.email_sent_at) {
      setReviewFor(null);
      setNotifyRemoval({
        mode: "remove",
        program,
        assignment,
        instructor: {
          id: assignment.instructor_id,
          first_name: assignment.instructor_first,
          preferred_name: assignment.instructor_preferred,
          email: assignment.instructor_email,
        },
        remaining: remainingActiveFor(assignment.instructor_id, assignment.id),
        onProceed: async () => { await deleteAssignment(assignment.id); setNotifyRemoval(null); await loadAll(); },
      });
      return;
    }
    try {
      await deleteAssignment(assignment.id);
      setReviewFor(null);
      await loadAll();
    } catch (err) {
      console.error("Remove failed:", err);
      setSaveError(`Couldn't remove: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  async function submitReply(assignment, message) {
    const { data, error } = await supabase.functions.invoke("offer-message-reply", {
      body: { program_assignment_id: assignment.id, message },
    });
    if (error) {
      let msg = error.message ?? "function error";
      try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    await loadAll();
  }

  function openSendOffers() {
    // Pre-select every instructor with approved classes — "sending to all" by default;
    // the admin unchecks to narrow.
    setSelectedInstructorIds(new Set(sendableInstructors.map((i) => i.id)));
    setOfferDialog({ mode: "choose", payload: null });
  }

  // Open the day-of sub assignment modal for a program. Fetches the program's real
  // class dates via the canonical RPC (never roll our own date math) for the picker.
  async function openAssignSub(program, defaultDate = null) {
    const lead = enriched.get(program.id)?.lead ?? null;
    if (!lead) return; // nothing to sub for until a lead is assigned
    // Reuse the session dates already loaded; fall back to the RPC if they weren't.
    let dates = state.status === "ready" ? (state.programDates?.[program.id] ?? []) : [];
    if (dates.length === 0) {
      const { data, error } = await supabase.rpc("derive_program_session_dates", { p_program_id: program.id });
      if (error) console.warn("[AfterschoolSchedule] derive_program_session_dates failed:", error.message);
      else if (Array.isArray(data)) dates = data;
    }
    setAssignSubFor({ program, lead, dates, defaultDate });
  }

  function openRow(program) {
    const e = enriched.get(program.id);
    const lead = e?.lead ?? null;
    // Offer in flight (emailed, responded, or change requested) → review modal.
    // Otherwise the picker for free (re)assignment before anything is sent.
    if (lead && (lead.email_sent_at || lead.status === "change_requested" || lead.instructor_response_at)) {
      setReviewFor({ program, assignment: lead });
    } else {
      setPicker({ program });
    }
  }

  if (state.status === "loading") return <div style={{ color: MUTED, fontSize: 14 }}>Loading schedule…</div>;
  if (state.status === "error") return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 28 }}>
      <h2 style={{ color: CORAL, margin: "0 0 8px" }}>Couldn't load schedule</h2>
      <p style={{ color: MUTED, margin: 0 }}>{state.message}</p>
    </div>
  );

  const survey = state.survey;
  const submittedCount = state.availability.filter((a) => a.submitted_at).length;

  // Change-request notification (mirrors camp's Hat tip): surface a prompt to
  // review when instructors ask to change their schedule.
  const changeReqProgram = state.programs.find((p) => enriched.get(p.id)?.status === "change_requested");
  const changeReqLead = changeReqProgram ? enriched.get(changeReqProgram.id)?.lead : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {saveError && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb", color: "#842029", borderRadius: 8, padding: "12px 16px", fontSize: 14 }}>
          {saveError}
        </div>
      )}

      {counts.changeRequested > 0 && changeReqLead && (
        <HatGuide
          character="instructor"
          tip={{
            key: `as-${term}-changereq-${counts.changeRequested}`,
            message: counts.changeRequested === 1
              ? `${changeReqLead.instructor_preferred || changeReqLead.instructor_first || "An instructor"} asked to change their schedule. Want to review the request?`
              : `${counts.changeRequested} instructors asked to change their schedule. Want to review the requests?`,
            primary: {
              label: counts.changeRequested === 1 ? "Review change request" : `Review ${counts.changeRequested} change requests`,
              onClick: () => setReviewFor({ program: changeReqProgram, assignment: changeReqLead }),
            },
          }}
        />
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
        onOpenSurvey={openSurvey}
        onMatch={handleMatch}
        onApprove={handleApprove}
        onSendOffers={openSendOffers}
        hasPrograms={state.programs.length > 0}
      />

      {approveResult && (
        <div style={{ background: `${OK_GREEN}14`, border: `1px solid ${OK_GREEN}55`, borderRadius: 8, padding: "12px 16px", fontSize: 14, color: INK }}>
          {approveResult.count > 0
            ? <>Approved <strong>{approveResult.count}</strong> match{approveResult.count === 1 ? "" : "es"}. They're ready to send — click <strong>Send offers</strong>.</>
            : <>No proposed matches to approve.</>}
          <button onClick={() => setApproveResult(null)} style={linkBtn}>Dismiss</button>
        </div>
      )}

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
        onSearchChange={setSearchText}
        instructors={state.instructors}
        selectedInstructors={selectedInstructors}
        onToggleInstructor={(id) => setSelectedInstructors((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        locations={locationOptions}
        selectedLocations={selectedLocations}
        onToggleLocation={(name) => setSelectedLocations((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; })}
        selectedStatuses={selectedStatuses}
        onToggleStatus={(k) => setSelectedStatuses((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; })}
        onClear={() => { setSearchText(""); setSelectedInstructors(new Set()); setSelectedLocations(new Set()); setSelectedStatuses(new Set()); }}
        hasFilters={!!searchText || selectedInstructors.size > 0 || selectedLocations.size > 0 || selectedStatuses.size > 0}
      />

      {state.programs.length > 0 && (
        <InstructorLoadStrip
          instructors={state.instructors}
          loadCount={loadCount}
          availByInstr={availByInstr}
          selectedInstructors={selectedInstructors}
          onToggleInstructor={(id) => setSelectedInstructors((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        />
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

      <NeedsCoverBanner org={org} parentType="program" />

      {state.programs.length > 0 && (
        <AfterschoolReminders
          org={org}
          term={term}
          cycle={state.cycle}
          assignments={state.assignments}
          onChanged={loadAll}
        />
      )}

      {state.programs.length === 0 ? (
        <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center", color: MUTED }}>
          No {termDisplayName(term)} after-school classes yet. Classes you schedule for this term will appear here.
        </div>
      ) : view === "list" ? (
        <StaffingList
          programs={state.programs.filter(matchesFilters)}
          enriched={enriched}
          enrollment={state.enrollment}
          locName={locName}
          locArea={locArea}
          onRowClick={openRow}
        />
      ) : (
        <>
          {weeks.length > 0 && (
            <WeekRail weeks={weeks} signals={weekSignals} effective={effectiveWeek} onSelect={setFocusedWeekStart} />
          )}
          {effectiveWeek && weeks.find((w) => w.start === effectiveWeek)?.isBreak && (
            <div style={{ fontSize: 12, color: MUTED, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: "8px 12px", marginBottom: 4 }}>
              No classes this week — <strong style={{ color: INK }}>term break</strong>.
            </div>
          )}
          {effectiveWeek && !weeks.find((w) => w.start === effectiveWeek)?.isBreak && (weekSignals.get(effectiveWeek)?.closures.length ?? 0) > 0 && (
            <div style={{ fontSize: 12, color: MUTED, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: "8px 12px", marginBottom: 4 }}>
              Off this week (break/closure): <strong style={{ color: INK }}>{weekSignals.get(effectiveWeek).closures.join(", ")}</strong>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(5, minmax(0, 1fr))`, gap: 12, alignItems: "start" }}>
          {DAYS.map((d, i) => {
            const items = grid.get(d.code) ?? [];
            // In a specific week each column is a real calendar day — show its date.
            // In the "Every week" overview there's no single date, so fall back to a count.
            const colDate = effectiveWeek ? addDaysIso(effectiveWeek, i) : null;
            return (
              <div key={d.code} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textAlign: "center", padding: "6px 0", borderBottom: `2px solid ${RULE}` }}>
                  {d.label}
                  <span style={{ color: MUTED, fontWeight: 500, marginLeft: 6 }}>
                    {colDate ? fmtWeekLabel(colDate) : items.length}
                  </span>
                </div>
                {items.length === 0 ? (
                  <div style={{ color: MUTED, fontSize: 12, textAlign: "center", padding: "12px 0" }}>—</div>
                ) : (
                  items.map(({ program: p, weekDate }) => {
                    const e = enriched.get(p.id);
                    const loc = locName.get(p.program_location_id) ?? "—";
                    const weekSub = weekDate
                      ? (subInfoByProgram.get(p.id)?.subs.find((s) => s.date === weekDate) ?? null)
                      : null;
                    return (
                      <ProgramCard
                        key={p.id}
                        program={p}
                        loc={loc}
                        tint={colorMap.get(loc)}
                        status={e?.status}
                        lead={e?.lead}
                        sub={subInfoByProgram.get(p.id)}
                        weekDate={weekDate}
                        weekSub={weekSub}
                        onClick={() => openRow(p)}
                        onSubClick={(dd) => openAssignSub(p, dd)}
                      />
                    );
                  })
                )}
              </div>
            );
          })}
          </div>
        </>
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

      {assignSubFor && (
        <AssignSubModal
          parentAssignment={assignSubFor.lead}
          parentType="program"
          sessionInfo={{
            curriculum: assignSubFor.program.curriculum,
            school_name: locName.get(assignSubFor.program.program_location_id) ?? "",
            first_session_date: assignSubFor.dates[0] ?? null,
          }}
          availableDates={assignSubFor.dates}
          defaultDate={assignSubFor.defaultDate ?? null}
          organizationId={org?.id}
          instructors={state.instructors}
          onClose={() => setAssignSubFor(null)}
          onSubmitted={() => { setAssignSubFor(null); loadAll(); }}
        />
      )}

      {surveyDialog && (
        <SurveyDialog
          dialog={surveyDialog}
          term={term}
          instructors={state.status === "ready" ? state.instructors : []}
          availability={state.status === "ready" ? state.availability : []}
          alreadyOpen={!!survey?.opened_at}
          selectedIds={surveySelectedIds}
          setSelectedIds={setSurveySelectedIds}
          intro={surveyIntro}
          setIntro={setSurveyIntro}
          defaultIntro={defaultSurveyIntro}
          deadline={surveyDeadline}
          setDeadline={setSurveyDeadline}
          busy={busy === "survey"}
          onRun={runSurvey}
          onPreview={previewSurvey}
          onClose={() => setSurveyDialog(null)}
        />
      )}

      {offerDialog && (
        <OfferDialog
          dialog={offerDialog}
          term={term}
          counts={counts}
          instructors={sendableInstructors}
          selectedInstructorIds={selectedInstructorIds}
          setSelectedInstructorIds={setSelectedInstructorIds}
          deadline={offerDeadline}
          setDeadline={setOfferDeadline}
          busy={busy === "offers"}
          onRun={runOffers}
          onPreview={previewOffers}
          onClose={() => setOfferDialog(null)}
        />
      )}

      {reviewFor && (
        <OfferReviewModal
          program={reviewFor.program}
          assignment={reviewFor.assignment}
          loc={locName.get(reviewFor.program.program_location_id) ?? "—"}
          onReply={(msg) => submitReply(reviewFor.assignment, msg)}
          onReassign={() => { const p = reviewFor.program; setReviewFor(null); setPicker({ program: p }); }}
          onRemove={() => handleReviewRemove(reviewFor.program, reviewFor.assignment)}
          onClose={() => setReviewFor(null)}
        />
      )}

      {notifyRemoval && (
        <NotifyRemovalModal
          mode={notifyRemoval.mode}
          instructor={notifyRemoval.instructor}
          assignment={notifyRemoval.assignment}
          session={removalSession(notifyRemoval.program)}
          org={org}
          unitNoun="class"
          remainingActiveCount={notifyRemoval.remaining}
          onProceed={notifyRemoval.onProceed}
          onCancel={() => setNotifyRemoval(null)}
        />
      )}
    </div>
  );
}

const linkBtn = { background: "transparent", border: "none", color: PURPLE, fontWeight: 600, cursor: "pointer", marginLeft: 10, fontSize: 13, textDecoration: "underline" };

function Header({ term, campCycles, afterschoolTerms, onSwitchTerm, onSwitchToCamp, counts, survey, submittedCount, busy, onOpenSurvey, onMatch, onApprove, onSendOffers, hasPrograms }) {
  // Unified term selector: afterschool terms (this view) + camp cycles (switches back to Schedule).
  const value = `as:${term}`;
  function onChange(e) {
    const v = e.target.value;
    if (v.startsWith("as:")) onSwitchTerm && onSwitchTerm(v.slice(3));
    else onSwitchToCamp && onSwitchToCamp(v);
  }
  return (
    <header style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "18px 22px", display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <select
            value={value}
            onChange={onChange}
            title="Switch term"
            style={{ fontSize: 14, fontWeight: 700, color: INK, letterSpacing: -0.2, fontFamily: "inherit", background: "transparent", border: "none", borderBottom: `2px dotted ${RULE}`, padding: "0 22px 2px 0", cursor: "pointer", appearance: "none",
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
          style={{ ...btnStyle, background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}` }}
        >
          {survey?.opened_at ? "Resend survey" : "Open availability survey"}
        </button>
        {(() => {
          // The matcher only fills EMPTY classes (idempotent; never touches accepted).
          // With nothing unfilled it's a no-op, so grey it out — it re-enables the
          // moment a slot opens (unassign someone). De-emphasize once offers exist.
          const nothingToMatch = counts.needsHire === 0;
          const someStaffed = (counts.assigned + counts.accepted + counts.flagged + counts.changeRequested) > 0;
          const secondary = nothingToMatch || counts.proposed > 0 || counts.sendable > 0;
          return (
            <button
              type="button"
              onClick={onMatch}
              disabled={!!busy || !hasPrograms || nothingToMatch}
              title={nothingToMatch ? "Every class already has an instructor — nothing to match. Unassign someone to re-open a slot." : ""}
              style={{ ...btnStyle,
                background: nothingToMatch ? "#f3f1ea" : (secondary ? "#fff" : BRIGHT),
                color: nothingToMatch ? MUTED : (secondary ? BRIGHT : "#fff"),
                border: `1.5px solid ${nothingToMatch ? RULE : BRIGHT}`,
                cursor: nothingToMatch ? "default" : "pointer",
                opacity: busy === "matching" ? 0.7 : 1 }}
            >
              {busy === "matching" ? "Matching…" : nothingToMatch ? "All classes staffed" : someStaffed ? "Match remaining" : "Match instructors"}
            </button>
          );
        })()}
        {counts.proposed > 0 && (
          <button
            type="button"
            onClick={onApprove}
            disabled={!!busy}
            style={{ ...btnStyle, background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, opacity: busy === "approving" ? 0.7 : 1 }}
          >
            {busy === "approving" ? "Approving…" : `Approve ${counts.proposed} match${counts.proposed === 1 ? "" : "es"}`}
          </button>
        )}
        {counts.sendable > 0 && (
          <button
            type="button"
            onClick={onSendOffers}
            disabled={!!busy}
            style={{ ...btnStyle, background: BRIGHT, color: "#fff", border: `1.5px solid ${BRIGHT}`, opacity: busy === "offers" ? 0.7 : 1 }}
          >
            {busy === "offers" ? "Sending…" : `Send offers (${counts.sendable})`}
          </button>
        )}
      </div>
    </header>
  );
}

const btnStyle = { padding: "10px 16px", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" };

// Mirrors the camp schedule FilterBar (Schedule.jsx) so both scheduling pages
// render identically: search + Instructors/Locations/Status multi-selects +
// Clear + active pills.
function FilterBar({
  searchText, onSearchChange,
  instructors, selectedInstructors, onToggleInstructor,
  locations, selectedLocations, onToggleLocation,
  selectedStatuses, onToggleStatus,
  onClear, hasFilters,
}) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search classes, instructors, locations…"
          name="schedule-search-filter"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          style={{ flex: "1 1 240px", minWidth: 200, padding: "8px 12px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, background: "#fff" }}
        />
        <MultiSelect
          label="Instructors"
          options={instructors.map((i) => ({ key: i.id, label: `${i.preferred_name || i.first_name}${i.last_name ? " " + i.last_name : ""}` }))}
          selected={selectedInstructors}
          onToggle={onToggleInstructor}
        />
        <MultiSelect
          label="Locations"
          options={locations.map((name) => ({ key: name, label: name }))}
          selected={selectedLocations}
          onToggle={onToggleLocation}
        />
        <MultiSelect
          label="Status"
          options={FILTER_STATUSES.map((s) => ({ key: s.key, label: s.label }))}
          selected={selectedStatuses}
          onToggle={onToggleStatus}
        />
        {hasFilters && (
          <button type="button" onClick={onClear} style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600, background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
            Clear
          </button>
        )}
      </div>
      {hasFilters && (
        <ActivePills
          searchText={searchText}
          onClearSearch={() => onSearchChange("")}
          instructors={instructors}
          selectedInstructors={selectedInstructors}
          onToggleInstructor={onToggleInstructor}
          selectedLocations={selectedLocations}
          onToggleLocation={onToggleLocation}
          selectedStatuses={selectedStatuses}
          onToggleStatus={onToggleStatus}
        />
      )}
    </div>
  );
}

function MultiSelect({ label, options, selected, onToggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const count = selected.size;
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ padding: "7px 10px", fontSize: 13, fontWeight: 500, background: "#fff", color: INK, border: `1px solid ${count > 0 ? PURPLE : RULE}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span>{label}</span>
        {count > 0 && (
          <span style={{ background: BRIGHT, color: "#fff", borderRadius: 999, padding: "0 7px", fontSize: 11, fontWeight: 600 }}>{count}</span>
        )}
        <span style={{ fontSize: 10, color: MUTED }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 220, maxHeight: 280, overflowY: "auto", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 6, boxShadow: "0 4px 14px rgba(0,0,0,0.08)", zIndex: 10, padding: 6 }}>
          {options.length === 0 && (
            <div style={{ padding: "8px 10px", color: MUTED, fontSize: 12 }}>None</div>
          )}
          {options.map((opt) => {
            const isOn = selected.has(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => onToggle(opt.key)}
                style={{ width: "100%", textAlign: "left", padding: "7px 10px", background: isOn ? `${VIOLET}1A` : "transparent", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13, fontFamily: "inherit", color: INK, display: "flex", alignItems: "center", gap: 8 }}
              >
                <span style={{ width: 14, height: 14, borderRadius: 3, border: `1.5px solid ${isOn ? PURPLE : RULE}`, background: isOn ? PURPLE : "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10, lineHeight: 1, flex: "0 0 auto" }}>{isOn ? "✓" : ""}</span>
                <span style={{ flex: 1 }}>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivePills({
  searchText, onClearSearch,
  instructors, selectedInstructors, onToggleInstructor,
  selectedLocations, onToggleLocation,
  selectedStatuses, onToggleStatus,
}) {
  const pills = [];
  if (searchText) pills.push({ key: "_search", label: `"${searchText}"`, onRemove: onClearSearch });
  for (const id of selectedInstructors) {
    const i = instructors.find((x) => x.id === id);
    if (i) pills.push({ key: `i:${id}`, label: i.preferred_name || i.first_name, onRemove: () => onToggleInstructor(id) });
  }
  for (const name of selectedLocations) {
    pills.push({ key: `l:${name}`, label: name, onRemove: () => onToggleLocation(name) });
  }
  for (const k of selectedStatuses) {
    const s = FILTER_STATUSES.find((x) => x.key === k);
    pills.push({ key: `s:${k}`, label: s?.label ?? k, onRemove: () => onToggleStatus(k) });
  }
  if (pills.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {pills.map((p) => (
        <span key={p.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 4px 3px 10px", background: `${VIOLET}1A`, border: `1px solid ${RULE}`, borderRadius: 999, fontSize: 12, color: INK }}>
          <span>{p.label}</span>
          <button type="button" onClick={p.onRemove} aria-label="Remove filter" style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px", fontSize: 14, color: MUTED, lineHeight: 1 }}>×</button>
        </span>
      ))}
    </div>
  );
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

function InstructorLoadStrip({ instructors, loadCount, availByInstr, selectedInstructors, onToggleInstructor }) {
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
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "10px 14px", display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 700, marginRight: 4 }}>Instructor load <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>· tap to filter</span></span>
      {rows.map((r) => {
        const full = r.cap != null && r.n >= r.cap;
        const active = selectedInstructors?.has(r.id);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onToggleInstructor(r.id)}
            title={active ? "Showing only this instructor — tap to clear" : "Show only this instructor's classes"}
            style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
              border: `1.5px solid ${active ? PURPLE : (full ? OK_GREEN : RULE)}`,
              color: active ? PURPLE : (!r.submitted ? MUTED : (full ? OK_GREEN : INK)),
              background: active ? `${PURPLE}12` : "#fff",
              opacity: r.submitted ? 1 : 0.7 }}
          >
            {r.name}
            <span style={{ color: MUTED, fontWeight: 500 }}>
              {" · "}
              {r.submitted ? `${r.n}${r.cap != null ? ` / ${r.cap}${full ? " (full)" : ""}` : ""}` : "no availability yet"}
            </span>
          </button>
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
    return <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 12, padding: 24, textAlign: "center", color: MUTED }}>No classes match your filters.</div>;
  }
  const th = { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 700, textAlign: "left", padding: "10px 14px", borderBottom: `1px solid ${RULE}` };
  const td = { padding: "11px 14px", borderTop: "1px solid #f0eee6", fontSize: 13.5, verticalAlign: "middle" };
  const widths = ["24%", "19%", "19%", "9%", "16%", "13%"];
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
        <thead>
          <tr>
            <th style={th}>Class</th>
            <th style={th}>School · Area</th>
            <th style={th}>When</th>
            <th style={th}>Enrolled</th>
            <th style={th}>Instructor</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {DAYS.map((d) => {
            const items = byDay.get(d.code) ?? [];
            if (items.length === 0) return null;
            return (
              <React.Fragment key={d.code}>
                <tr>
                  <td colSpan={6} style={{ background: CREAM, padding: "7px 14px", fontSize: 12, fontWeight: 700, color: PURPLE, borderTop: `1px solid ${RULE}` }}>
                    {d.label} <span style={{ color: MUTED, fontWeight: 500 }}>· {items.length} class{items.length === 1 ? "" : "es"}</span>
                  </td>
                </tr>
                {items.map((p) => {
                  const e = enriched.get(p.id);
                  const loc = locName.get(p.program_location_id) ?? "—";
                  const area = locArea.get(p.program_location_id);
                  const lead = e?.lead;
                  const who = lead ? ((lead.instructor_preferred || lead.instructor_first || "Instructor") + (lead.instructor_last ? ` ${lead.instructor_last}` : "")) : null;
                  const enr = enrollment?.[p.id];
                  return (
                    <tr key={p.id} onClick={() => onRowClick(p)} style={{ cursor: "pointer" }}>
                      <td style={{ ...td, overflow: "hidden", textOverflow: "ellipsis" }}>
                        <div style={{ fontWeight: 700, color: INK }}>{p.curriculum || "Class"}</div>
                        {(p.grade_min != null || p.grade_max != null) && (
                          <div style={{ fontSize: 11.5, color: MUTED }}>Grades {gradeLabel(p.grade_min)}–{gradeLabel(p.grade_max)}</div>
                        )}
                      </td>
                      <td style={td}>{loc}{area && <span style={{ color: MUTED }}> · {area}</span>}</td>
                      <td style={td}>
                        <span style={{ fontWeight: 600, color: INK }}>{fmtTimeRange(p.start_time, p.end_time)}</span>
                        <div style={{ fontSize: 11.5, color: PURPLE, fontWeight: 600 }}>all term</div>
                      </td>
                      <td style={td}>{enr ? <><span style={{ fontWeight: 600, color: INK }}>{enr.enrolled}</span><span style={{ color: MUTED }}> / {enr.max ?? "—"}</span></> : <span style={{ color: MUTED }}>—</span>}</td>
                      <td style={td}>{who ? <span style={{ fontWeight: 600, color: INK }}>{who}</span> : <span style={{ color: PURPLE, fontWeight: 600 }}>+ Assign</span>}</td>
                      <td style={td}><Pill status={e?.status} /></td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function weekPillStyle(active) {
  return {
    flexShrink: 0, padding: "6px 12px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
    fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
    background: active ? PURPLE : "#fff",
    color: active ? "#fff" : MUTED,
    border: `1px solid ${active ? PURPLE : RULE}`,
  };
}

// Horizontal week selector for the week-grid view. "Every week" = recurring overview;
// each pill = a real calendar week of the term (derived from class session dates).
// An orange dot flags weeks that need attention: a class that week has no instructor.
function WeekRail({ weeks, signals, effective, onSelect }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "2px 2px 8px" }}>
      <button type="button" onClick={() => onSelect(null)} style={weekPillStyle(effective === null)}>Every week</button>
      {weeks.map((w) => {
        const sig = signals?.get(w.start);
        const active = effective === w.start;
        const dot = !w.isBreak && sig?.gap ? CORAL : null;
        return (
          <button
            key={w.start}
            type="button"
            onClick={() => onSelect(w.start)}
            title={w.isBreak ? "No classes this week (term break)" : sig?.gap ? "A class needs an instructor this week" : undefined}
            style={{
              ...weekPillStyle(active),
              display: "inline-flex", alignItems: "center", gap: 5,
              ...(w.isBreak && !active ? { background: "#fafafa", color: "#9a9a9a", borderStyle: "dashed" } : {}),
            }}
          >
            {w.isBreak ? `${w.label} · Break` : w.label}
            {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0 }} />}
          </button>
        );
      })}
    </div>
  );
}

function ProgramCard({ program, loc, tint, status, lead, sub, weekDate, weekSub, onClick, onSubClick }) {
  const sc = statusColor(status);
  const who = lead ? (lead.instructor_preferred || lead.instructor_first || "Instructor") + (lead.instructor_last ? ` ${lead.instructor_last}` : "") : null;
  // Week mode shows only THIS week's coverage; recurring mode summarizes all sub days.
  const subsForLine = weekDate ? (weekSub ? [weekSub] : []) : (sub?.subs ?? []);
  return (
    <div style={{
      background: tint || "#fff", border: `1px solid ${RULE}`, borderLeft: `4px solid ${sc}`,
      borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          textAlign: "left", width: "100%", cursor: "pointer", fontFamily: "inherit",
          background: "transparent", border: "none", padding: "10px 12px",
          display: "flex", flexDirection: "column", gap: 4,
        }}
      >
        {weekDate && (
          <div style={{ fontSize: 10, fontWeight: 700, color: BRIGHT, textTransform: "uppercase", letterSpacing: 0.4 }}>{fmtDateShort(weekDate)}</div>
        )}
        <div style={{ fontSize: 13, fontWeight: 700, color: INK, lineHeight: 1.25 }}>{program.curriculum || "Class"}</div>
        <div style={{ fontSize: 12, color: PURPLE, fontWeight: 600 }}>{loc}</div>
        {(program.start_time || program.end_time) && (
          <div style={{ fontSize: 11, color: MUTED }}>{fmtTimeRange(program.start_time, program.end_time)}</div>
        )}
        <div style={{ marginTop: 2 }}>
          <span style={{ display: "inline-block", fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 999, background: who ? `${PURPLE}10` : `${CORAL}14`, color: who ? PURPLE : CORAL, border: `1px solid ${who ? `${PURPLE}33` : `${CORAL}55`}` }}>
            {who || "+ Assign"}
          </span>
        </div>
        <div style={{ fontSize: 10, color: sc, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{statusLabel(status)}</div>
      </button>
      {lead && <SubLineAS subs={subsForLine} onClick={() => onSubClick && onSubClick(weekDate ?? null)} />}
    </div>
  );
}

// Sub coverage control on an after-school program card. Shows existing sub coverage
// (or "+ Sub day" when none) and opens the assign-sub modal. Sibling of the main
// card button (not nested) so it stays independently clickable and valid HTML.
function SubLineAS({ subs, onClick }) {
  const list = subs ?? [];
  let label, color;
  if (list.length === 0) {
    color = MUTED; label = "+ Sub day";
  } else if (list.length === 1) {
    const s = list[0];
    const confirmed = s.status === "confirmed" || s.status === "taught";
    color = confirmed ? OK_GREEN : VIOLET;
    label = `Sub ${s.name}${confirmed ? " ✓" : " · pending"}`;
  } else {
    color = OK_GREEN; label = `${list.length} sub days`;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (onClick) onClick(); }}
      title="Assign or change a sub for a class date"
      style={{
        display: "flex", alignItems: "center", width: "100%",
        padding: "5px 12px", background: "transparent",
        border: "none", borderTop: `1px solid ${RULE}`,
        cursor: "pointer", fontFamily: "inherit", textAlign: "left",
        fontSize: 10, fontWeight: 600, color, whiteSpace: "nowrap", overflow: "hidden",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </button>
  );
}

function PickerModal({ program, loc, current, instructors, evaluate, onAssign, onRemove, onClose }) {
  const rows = instructors.map((i) => {
    const ev = evaluate(i.id);
    return { inst: i, ev };
  });
  const prefRank = { preferred: 0, highly_preferred: 0, available: 1, undefined: 1, not_preferred: 1, unavailable: 3 };
  const eligible = rows.filter((r) => r.ev.ok).sort((a, b) => (prefRank[a.ev.pref] ?? 1) - (prefRank[b.ev.pref] ?? 1));
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
              {(ev.pref === "preferred" || ev.pref === "highly_preferred") && <Tag color={OK_GREEN}>Prefers this area</Tag>}
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

function SurveyDialog({ dialog, term, instructors, availability, alreadyOpen, selectedIds, setSelectedIds, intro, setIntro, defaultIntro, deadline, setDeadline, busy, onRun, onPreview, onClose }) {
  const [previews, setPreviews] = useState(null);
  const [pvIdx, setPvIdx] = useState(0);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState(null);

  if (dialog.mode === "result") {
    const { mode, data } = dialog.payload;
    const failed = Array.isArray(data?.failed) ? data.failed : [];
    const sent = data?.sent ?? 0;
    return (
      <Overlay onClose={onClose}>
        <div style={{ padding: 24 }}>
          <h3 style={{ margin: "0 0 10px", color: INK }}>
            {mode === "send" ? "Survey sent" : "Test sent to you"}
          </h3>
          <p style={{ color: MUTED, fontSize: 14, margin: "0 0 12px" }}>
            {mode === "test"
              ? "Sent one test to your inbox — instructors weren't contacted."
              : <><strong style={{ color: INK }}>{sent}</strong> of {data?.recipient_count ?? 0} instructor email(s) delivered.</>}
            {failed.length > 0 && ` ${failed.length} failed.`}
          </p>
          {mode === "send" && sent > 0 && (
            <div style={{ display: "inline-block", background: `${OK_GREEN}14`, border: `1px solid ${OK_GREEN}55`, color: "#1f6b40", borderRadius: 999, padding: "4px 12px", fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>
              ⏱ Saved you ~{Math.max(5, sent * 2)} min vs. emailing and tracking each instructor by hand
            </div>
          )}
          {failed.length > 0 && (
            <div style={{ background: "#fdecea", border: "1px solid #f5c6cb", color: "#842029", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 12 }}>
              {Object.entries(failed.reduce((m, f) => { const k = friendlyFailReason(f.reason); m[k] = (m[k] || 0) + 1; return m; }, {}))
                .map(([reason, n], i) => <div key={i}>{reason}{n > 1 ? ` (${n} instructors)` : ""}</div>)}
            </div>
          )}
          <div style={{ textAlign: "right" }}>
            <button onClick={onClose} style={{ ...btnStyle, background: BRIGHT, color: "#fff" }}>Done</button>
          </div>
        </div>
      </Overlay>
    );
  }

  const submitted = new Set((availability ?? []).filter((a) => a.submitted_at).map((a) => a.instructor_id));
  // Only instructors with an email can actually be sent to — the send skips the
  // rest, so all counts and bulk-select actions operate over the emailable set.
  const emailable = instructors.filter((i) => !!i.email);
  const emailableCount = emailable.length;
  const missingEmailCount = instructors.length - emailableCount;
  // Count only selected instructors that can actually be sent to, so the label
  // and the Send payload (which filters to emailable) never disagree.
  const selCount = emailable.filter((i) => selectedIds?.has(i.id)).length;
  const allSelected = emailableCount > 0 && selCount === emailableCount;
  const nonResponderCount = emailable.filter((i) => !submitted.has(i.id)).length;
  const hasPreview = previews && previews.length > 0;
  const nameById = new Map(instructors.map((i) => [i.id, (i.preferred_name || i.first_name) + (i.last_name ? ` ${i.last_name}` : "")]));

  function toggle(id) {
    const next = new Set(selectedIds ?? []);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedIds(next);
  }
  function selectNonResponders() {
    setSelectedIds(new Set(emailable.filter((i) => !submitted.has(i.id)).map((i) => i.id)));
  }
  async function doPreview() {
    setPvBusy(true); setPvErr(null);
    try {
      const p = await onPreview();
      setPreviews(p); setPvIdx(0);
      if (!p.length) setPvErr("No one selected to preview — pick at least one instructor.");
    } catch (e) {
      setPvErr(e.message || "Couldn't build the preview.");
    } finally { setPvBusy(false); }
  }

  return (
    <Overlay onClose={onClose} maxWidth={hasPreview ? 720 : 540}>
      <div style={{ padding: 24, overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 6px", color: INK }}>{alreadyOpen ? "Send" : "Open"} the {termDisplayName(term)} availability survey</h3>
        <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px" }}>
          Emails instructors a link to tell you which weekdays they can teach this term.
          {alreadyOpen && nonResponderCount > 0 && ` ${nonResponderCount} haven't responded yet — pre-selected below.`}
        </p>

        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>Message to instructors</label>
        <textarea
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          rows={3}
          placeholder={defaultIntro}
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical", marginBottom: 4 }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: MUTED }}>The rest of the email (button, link, signature) is added automatically.</span>
          {intro.trim() !== defaultIntro && <button type="button" onClick={() => setIntro(defaultIntro)} style={linkBtn}>Reset to default</button>}
        </div>

        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>Response deadline (optional)</label>
        <input type="date" value={deadline ?? ""} onChange={(e) => setDeadline(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit", marginBottom: 16 }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: INK }}>
            {selCount === 0 ? "No instructors selected" : allSelected ? `Sending to all ${emailableCount} instructors` : `Sending to ${selCount} of ${emailableCount}`}
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            {alreadyOpen && nonResponderCount > 0 && <button type="button" onClick={selectNonResponders} style={linkBtn}>Non-responders</button>}
            <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(emailable.map((i) => i.id)))} style={linkBtn}>
              {allSelected ? "Clear all" : "Select all"}
            </button>
          </div>
        </div>
        <div style={{ maxHeight: 180, overflowY: "auto", marginBottom: missingEmailCount > 0 ? 6 : 16, border: `1px solid ${RULE}`, borderRadius: 8, padding: 8 }}>
          {instructors.length === 0 && <div style={{ fontSize: 13, color: MUTED, padding: "4px 6px" }}>No active instructors for this term.</div>}
          {instructors.map((i) => {
            const noEmail = !i.email;
            const checked = !noEmail && (selectedIds?.has(i.id) ?? false);
            const hasSubmitted = submitted.has(i.id);
            return (
              <label key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", fontSize: 13, cursor: noEmail ? "default" : "pointer", opacity: noEmail ? 0.55 : 1 }}>
                <input type="checkbox" checked={checked} disabled={noEmail} onChange={() => toggle(i.id)} />
                <span style={{ flex: 1 }}>{(i.preferred_name || i.first_name)}{i.last_name ? ` ${i.last_name}` : ""}</span>
                {noEmail ? (
                  <Tag color={CORAL}>no email</Tag>
                ) : alreadyOpen ? (
                  <Tag color={hasSubmitted ? OK_GREEN : MUTED}>{hasSubmitted ? "✓ submitted" : "○ waiting"}</Tag>
                ) : null}
              </label>
            );
          })}
        </div>
        {missingEmailCount > 0 && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>
            {missingEmailCount} instructor{missingEmailCount === 1 ? " has" : "s have"} no email on file and can't be sent the survey. Add an email on their profile to include {missingEmailCount === 1 ? "them" : "them"}.
          </div>
        )}

        <button
          type="button"
          onClick={doPreview}
          disabled={pvBusy || selCount === 0}
          style={{ ...btnStyle, width: "100%", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, opacity: pvBusy || selCount === 0 ? 0.5 : 1, marginBottom: 10 }}
        >
          {pvBusy ? "Building preview…" : hasPreview ? "Refresh preview" : "Preview the email"}
        </button>
        {pvErr && <div style={{ color: "#b53737", fontSize: 13, marginBottom: 10 }}>{pvErr}</div>}
        {hasPreview && (
          <div style={{ marginBottom: 14, border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${RULE}`, background: CREAM }}>
              <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>Previewing</span>
              {previews.length > 1 ? (
                <select value={pvIdx} onChange={(e) => setPvIdx(Number(e.target.value))} style={{ fontSize: 12, fontFamily: "inherit", border: `1px solid ${RULE}`, borderRadius: 6, padding: "3px 6px", maxWidth: 320 }}>
                  {previews.map((p, i) => <option key={i} value={i}>{nameById.get(p.instructor_id) || p.to}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{nameById.get(previews[0].instructor_id) || previews[0].to}</span>
              )}
              <span style={{ marginLeft: "auto", fontSize: 11, color: MUTED }}>No email sent</span>
            </div>
            <iframe title="Survey email preview" srcDoc={previews[pvIdx]?.html} style={{ width: "100%", height: 460, border: "none", background: "#fff", display: "block" }} />
          </div>
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <button onClick={onClose} style={linkBtn}>Cancel</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => onRun("test")} disabled={busy || selCount === 0} style={{ ...btnStyle, background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, opacity: busy || selCount === 0 ? 0.6 : 1 }}>Send test to me</button>
            <button onClick={() => onRun("send")} disabled={busy || selCount === 0} style={{ ...btnStyle, background: BRIGHT, color: "#fff", opacity: busy || selCount === 0 ? 0.6 : 1 }}>
              {busy ? "Sending…" : allSelected ? `Send to all ${emailableCount}` : `Send to ${selCount}`}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function OfferDialog({ dialog, term, counts, instructors, selectedInstructorIds, setSelectedInstructorIds, deadline, setDeadline, busy, onRun, onPreview, onClose }) {
  const [previews, setPreviews] = useState(null);
  const [pvIdx, setPvIdx] = useState(0);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState(null);

  if (dialog.mode === "result") {
    const { mode, data } = dialog.payload;
    const failed = Array.isArray(data?.failed) ? data.failed : [];
    return (
      <Overlay onClose={onClose}>
        <div style={{ padding: 24 }}>
          <h3 style={{ margin: "0 0 10px", color: INK }}>
            {mode === "send" ? "Offers sent" : mode === "test" ? "Test sent to you" : "Preview ready"}
          </h3>
          <p style={{ color: MUTED, fontSize: 14, margin: "0 0 12px" }}>
            {data?.note
              ? data.note
              : mode === "preview"
              ? `${data?.preview?.length ?? 0} instructor email(s) rendered — nothing sent.`
              : <><strong style={{ color: INK }}>{data?.sent ?? 0}</strong> of {data?.recipient_count ?? 0} instructor email(s) delivered.</>}
            {failed.length > 0 && ` ${failed.length} failed.`}
          </p>
          {mode === "test" && (
            <div style={{ background: `${VIOLET}14`, border: `1px solid ${VIOLET}55`, borderRadius: 8, padding: "10px 12px", fontSize: 13, color: INK, marginBottom: 12 }}>
              All emails went to your inbox only — instructors weren't contacted.
            </div>
          )}
          {failed.length > 0 && (
            <div style={{ background: "#fdecea", border: "1px solid #f5c6cb", color: "#842029", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 12 }}>
              {Object.entries(failed.reduce((m, f) => { const k = friendlyFailReason(f.reason); m[k] = (m[k] || 0) + 1; return m; }, {}))
                .map(([reason, n], i) => <div key={i}>{reason}{n > 1 ? ` (${n} instructors)` : ""}</div>)}
            </div>
          )}
          <div style={{ textAlign: "right" }}>
            <button onClick={onClose} style={{ ...btnStyle, background: BRIGHT, color: "#fff" }}>Done</button>
          </div>
        </div>
      </Overlay>
    );
  }
  function toggle(id) {
    const next = new Set(selectedInstructorIds ?? []);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedInstructorIds(next);
  }
  const total = instructors.length;
  const selCount = selectedInstructorIds?.size ?? 0;
  const allSelected = total > 0 && selCount === total;
  const nameById = new Map(instructors.map((i) => [i.id, (i.preferred_name || i.first_name) + (i.last_name ? ` ${i.last_name}` : "")]));
  const hasPreview = previews && previews.length > 0;
  async function doPreview() {
    setPvBusy(true); setPvErr(null);
    try {
      const p = await onPreview();
      setPreviews(p); setPvIdx(0);
      if (!p.length) setPvErr("Nothing to preview — approve some matches first.");
    } catch (e) {
      setPvErr(e.message || "Couldn't build the preview.");
    } finally { setPvBusy(false); }
  }
  return (
    <Overlay onClose={onClose} maxWidth={hasPreview ? 720 : 520}>
      <div style={{ padding: 24, overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 6px", color: INK }}>Send {termDisplayName(term)} offers</h3>
        <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px" }}>
          Emails each instructor their approved classes with Accept / Request change.{" "}
          <strong style={{ color: INK }}>{counts.sendable}</strong> class{counts.sendable === 1 ? "" : "es"} ready to send.
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: INK }}>Response deadline (optional)</label>
          {deadline ? <button type="button" onClick={() => setDeadline("")} style={linkBtn}>Clear (no deadline)</button> : null}
        </div>
        <input type="date" value={deadline ?? ""} onChange={(e) => setDeadline(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit", marginBottom: 4 }} />
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>{deadline ? "Instructors are asked to respond by this date." : "No deadline — instructors are asked to respond, but no date is shown."}</div>
        <details style={{ marginBottom: 16 }} open>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: PURPLE }}>
            {allSelected ? `Sending to all ${total} instructor${total === 1 ? "" : "s"} with approved classes` : selCount === 0 ? "No instructors selected" : `Sending to ${selCount} of ${total} instructors`}
          </summary>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" onClick={() => setSelectedInstructorIds(allSelected ? new Set() : new Set(instructors.map((i) => i.id)))} style={linkBtn}>
              {allSelected ? "Clear all" : "Select all"}
            </button>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto", marginTop: 4, border: `1px solid ${RULE}`, borderRadius: 8, padding: 8 }}>
            {total === 0 && <div style={{ fontSize: 13, color: MUTED, padding: "4px 6px" }}>No instructors have approved classes yet — Approve some matches first.</div>}
            {instructors.map((i) => {
              const checked = selectedInstructorIds?.has(i.id) ?? false;
              return (
                <label key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(i.id)} />
                  {(i.preferred_name || i.first_name)}{i.last_name ? ` ${i.last_name}` : ""}
                </label>
              );
            })}
          </div>
        </details>
        <button
          type="button"
          onClick={doPreview}
          disabled={pvBusy || selCount === 0}
          style={{ ...btnStyle, width: "100%", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, opacity: pvBusy || selCount === 0 ? 0.5 : 1, marginBottom: 10 }}
        >
          {pvBusy ? "Building preview…" : hasPreview ? "Refresh preview" : "Preview the email"}
        </button>
        {pvErr && <div style={{ color: "#b53737", fontSize: 13, marginBottom: 10 }}>{pvErr}</div>}
        {hasPreview && (
          <div style={{ marginBottom: 14, border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${RULE}`, background: CREAM }}>
              <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>Previewing</span>
              {previews.length > 1 ? (
                <select value={pvIdx} onChange={(e) => setPvIdx(Number(e.target.value))} style={{ fontSize: 12, fontFamily: "inherit", border: `1px solid ${RULE}`, borderRadius: 6, padding: "3px 6px", maxWidth: 320 }}>
                  {previews.map((p, i) => <option key={i} value={i}>{nameById.get(p.instructor_id) || p.to}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{nameById.get(previews[0].instructor_id) || previews[0].to}</span>
              )}
              <span style={{ marginLeft: "auto", fontSize: 11, color: MUTED }}>No email sent</span>
            </div>
            <iframe title="Offer email preview" srcDoc={previews[pvIdx]?.html} style={{ width: "100%", height: 460, border: "none", background: "#fff", display: "block" }} />
          </div>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <button onClick={onClose} style={linkBtn}>Cancel</button>
          <button onClick={() => onRun("send")} disabled={busy || selCount === 0} style={{ ...btnStyle, background: BRIGHT, color: "#fff", opacity: busy || selCount === 0 ? 0.6 : 1 }}>
            {busy ? "Sending…" : allSelected ? "Send to all" : `Send to ${selCount}`}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// Reminder controls for after-school — the operator-facing mirror of the camp
// reminder UI in Schedule.jsx. Holds the per-term auto-reminder toggle (which
// lives on the afterschool scheduling_cycle the cron gates on), a "Send reminders
// now" manual trigger, and a next-fire forecast. The cycle row may not exist yet
// for a term (programs link by term, not cycle_id) — turning the toggle on creates
// it so both this control and the cron have a row to read/write.
function AfterschoolReminders({ org, term, cycle, assignments, onChanged }) {
  const [busy, setBusy] = useState(null); // 'toggle' | 'run' | null
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null); // { sent, flagged } from a manual run
  const enabled = !!cycle?.auto_reminders_enabled;

  // Forecast: published rows still awaiting a response, bucketed by their
  // deadline-minus-3-days fire date; show the soonest. Same rule the cron uses.
  const forecast = useMemo(() => {
    const pending = (assignments ?? []).filter(
      (a) => a.status === "published" && !a.reminder_sent_at && a.email_sent_at && a.deadline && !a.instructor_response_at,
    );
    if (pending.length === 0) return null;
    const today = todayIso();
    const buckets = new Map();
    for (const a of pending) {
      const computed = addDaysIso(a.deadline, -3);
      const fire = computed < today ? today : computed;
      if (!buckets.has(fire)) buckets.set(fire, new Set());
      buckets.get(fire).add(a.instructor_id);
    }
    const next = [...buckets.keys()].sort()[0];
    return { fireDate: next, instructorCount: buckets.get(next).size };
  }, [assignments]);

  async function setEnabled(next) {
    setBusy("toggle"); setErr(null);
    try {
      if (cycle?.id) {
        const { error } = await supabase.from("scheduling_cycles").update({ auto_reminders_enabled: next }).eq("id", cycle.id);
        if (error) throw error;
      } else if (next) {
        // No cycle row for this term yet — create one (only on enable; "off" with
        // no row is already the effective state). organization_id/name/cycle_type
        // are the only required columns; the rest default.
        const { error } = await supabase.from("scheduling_cycles").insert({
          organization_id: org.id, name: term, cycle_type: "afterschool", auto_reminders_enabled: true,
        });
        if (error) throw error;
      }
      await onChanged();
    } catch (e) {
      setErr(e.message ?? "Couldn't update reminders.");
      setTimeout(() => setErr(null), 6000);
    } finally { setBusy(null); }
  }

  async function runNow() {
    setBusy("run"); setErr(null); setResult(null);
    try {
      // Scope the run to THIS term's after-school reminders only — never touch
      // camp/summer or other terms from this button.
      const { data, error } = await supabase.functions.invoke("offer-reminders-cron", {
        body: { dry_run: false, scope: "program", organization_id: org.id, term },
      });
      if (error) {
        let msg = error.message ?? "function error";
        try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      const sent = (data?.program_reminder_results ?? []).filter((r) => r.sent).length;
      const flagged = data?.program_expired_count ?? 0;
      setResult({ sent, flagged });
      await onChanged();
    } catch (e) {
      setErr(`Couldn't send reminders: ${e.message ?? "unknown error"}`);
      setTimeout(() => setErr(null), 8000);
    } finally { setBusy(null); }
  }

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 9, cursor: busy ? "default" : "pointer", fontSize: 13.5, color: INK, fontWeight: 600 }}>
        <input type="checkbox" checked={enabled} disabled={!!busy} onChange={(e) => setEnabled(e.target.checked)} />
        Auto-remind instructors who haven’t replied
      </label>
      <span style={{ fontSize: 12.5, color: MUTED }}>
        {enabled
          ? (forecast
              ? <>Next nudge <strong style={{ color: INK }}>{fmtDateShort(forecast.fireDate)}</strong> → {forecast.instructorCount} instructor{forecast.instructorCount === 1 ? "" : "s"}</>
              : "No replies outstanding right now.")
          : "Off — instructors won’t be nudged automatically."}
      </span>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
        {result && (
          <span style={{ fontSize: 12.5, color: OK_GREEN, fontWeight: 600 }}>
            Sent {result.sent} reminder{result.sent === 1 ? "" : "s"}{result.flagged ? ` · flagged ${result.flagged} overdue` : ""}
          </span>
        )}
        {err && <span style={{ fontSize: 12.5, color: CORAL, fontWeight: 600 }}>{err}</span>}
        <button type="button" onClick={runNow} disabled={!!busy} style={{ background: enabled ? BRIGHT : "#fff", color: enabled ? "#fff" : MUTED, border: enabled ? "none" : `1px solid ${RULE}`, borderRadius: 7, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: "inherit" }}>
          {busy === "run" ? "Sending…" : "Send reminders now"}
        </button>
      </div>
    </div>
  );
}

function OfferReviewModal({ program, assignment, loc, onReply, onReassign, onRemove, onClose }) {
  const [thread, setThread] = useState(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);

  async function loadThread() {
    const { data } = await supabase
      .from("instructor_offer_messages")
      .select("id, sender_role, sender_instructor_id, message, created_at")
      .eq("program_assignment_id", assignment.id)
      .order("created_at", { ascending: true });
    return data ?? [];
  }

  useEffect(() => {
    let active = true;
    loadThread().then((d) => { if (active) setThread(d); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id]);

  const who = (assignment.instructor_preferred || assignment.instructor_first || "Instructor") + (assignment.instructor_last ? ` ${assignment.instructor_last}` : "");
  const isChange = assignment.status === "change_requested";
  const pillStatus = isChange ? "change_requested" : (assignment.instructor_response_at ? "accepted" : "confirmed");

  async function send() {
    if (!reply.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      await onReply(reply.trim());
      setSent(true); setReply("");
      setThread(await loadThread());
    } catch (e) {
      setErr(e.message ?? "Couldn't send.");
    } finally { setBusy(false); }
  }

  function senderLabel(m) {
    if (m.sender_role === "instructor") return who;
    if (m.sender_role === "admin") return "You";
    return "System";
  }
  function bubbleBg(role) {
    if (role === "instructor") return `${CHANGE_REQ}12`;
    if (role === "admin") return `${PURPLE}10`;
    return "#f5f3ed";
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ padding: "20px 22px", borderBottom: `1px solid ${RULE}` }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: INK }}>{program.curriculum || "Class"}</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{loc} · {program.day_of_week}{program.start_time ? ` · ${fmtTimeRange(program.start_time, program.end_time)}` : ""}</div>
        <div style={{ fontSize: 13, color: INK, marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontWeight: 600 }}>{who}</span> <Pill status={pillStatus} /></div>
        {assignment.deadline && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Response due {fmtDeadline(assignment.deadline)}</div>}
      </div>
      <div style={{ maxHeight: "46vh", overflowY: "auto", padding: "14px 18px" }}>
        {isChange && assignment.change_request_message && (
          <div style={{ background: `${CHANGE_REQ}12`, border: `1px solid ${CHANGE_REQ}44`, borderRadius: 8, padding: "10px 12px", fontSize: 13.5, color: INK, marginBottom: 14 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, color: CHANGE_REQ, marginBottom: 4 }}>Change requested</div>
            {assignment.change_request_message}
          </div>
        )}
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, color: MUTED, marginBottom: 8 }}>Email activity</div>
        {thread == null ? <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
          : thread.length === 0 ? <div style={{ color: MUTED, fontSize: 13 }}>No messages yet.</div>
          : thread.map((m) => (
            <div key={m.id} style={{ background: bubbleBg(m.sender_role), borderRadius: 8, padding: "8px 11px", marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>{senderLabel(m)} · {new Date(m.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
              <div style={{ fontSize: 13.5, color: INK, whiteSpace: "pre-wrap" }}>{m.message}</div>
            </div>
          ))}
      </div>
      <div style={{ padding: "12px 18px", borderTop: `1px solid ${RULE}` }}>
        {sent && <div style={{ color: OK_GREEN, fontSize: 13, marginBottom: 8 }}>✓ Sent.</div>}
        {err && <div style={{ color: "#b53737", fontSize: 13, marginBottom: 8 }}>{err}</div>}
        <textarea value={reply} onChange={(e) => { setReply(e.target.value); setSent(false); }} rows={3} placeholder={isChange ? `Reply to ${who}…` : `Message ${who}…`} style={{ width: "100%", padding: "9px 11px", border: `1px solid ${RULE}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onReassign} style={{ ...btnStyle, background: "#fff", color: PURPLE, border: `1px solid ${RULE}` }}>Reassign</button>
            <button onClick={onRemove} style={{ ...btnStyle, background: "#fff", color: CORAL, border: `1px solid ${RULE}` }}>Remove</button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ ...btnStyle, background: "#fff", color: MUTED, border: `1px solid ${RULE}` }}>Close</button>
            <button onClick={send} disabled={busy || !reply.trim()} style={{ ...btnStyle, background: BRIGHT, color: "#fff", opacity: busy || !reply.trim() ? 0.6 : 1 }}>{busy ? "Sending…" : "Send reply"}</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose, maxWidth = 560 }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,12,40,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        {children}
      </div>
    </div>
  );
}
