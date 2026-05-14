// src/pages/admin/Schedule.jsx
// Scheduling Calendar UI — header strip, filter bar, term overview, weekly grid,
// instructor drag-and-drop with hard-block + loud-warning validation.
// Edit drawer + send-offers + multi-week occurrence modal land in follow-up passes.
// Multi-tenant: all data RLS-scoped by org.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const CHANGE_REQ = "#8B4FB5"; // distinct violet for status='change_requested'

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const SESSION_TIME_RANK = { morning: 0, full_day: 1, afternoon: 2, after_school: 3 };

// Stable per-location card tints — same color every time the location appears
// across days/weeks, so you can scan visually. Low saturation so status colors
// (left border / drop-hover overlays) still pop.
const LOCATION_PALETTE = [
  "#F2E4D2", // peach
  "#E5EDDC", // sage
  "#DDE7F0", // soft blue
  "#ECDFEC", // lavender
  "#F0E0E0", // soft pink
  "#E1ECEA", // mint
];

// Build a Map<location_name, color> by assigning palette positions in the order
// locations appear in the sorted items list. Adjacent rows in the grid get
// adjacent palette colors so groups always alternate visually.
function locationColorMap(sortedItems) {
  const seen = new Set();
  const order = [];
  for (const e of sortedItems) {
    const loc = e?.session?.location_name;
    if (loc && !seen.has(loc)) {
      seen.add(loc);
      order.push(loc);
    }
  }
  const map = new Map();
  order.forEach((loc, i) => map.set(loc, LOCATION_PALETTE[i % LOCATION_PALETTE.length]));
  return map;
}
const DAY_SHORT = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };
const DAY_LABEL_FULL = { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday" };

const STATUS_RANK = { published: 4, confirmed: 3, change_requested: 2, proposed: 1, withdrawn: 0 };
const MIN_ENROLLMENT = 8;
const CANCEL_THRESHOLD = 4;
const DEVELOPING_THRESHOLD = 12;

const FILTER_STATUSES = [
  { key: "needs_hire", label: "Needs hire" },
  { key: "change_requested", label: "Change requested" },
  { key: "flagged", label: "Flagged" },
  { key: "accepted", label: "Accepted" },
  { key: "confirmed", label: "Awaiting response" },
  { key: "ok", label: "Not yet sent" },
];

const DRAG_MIME = "application/x-enrops-assignment";

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
  return m === 0 ? `${hr12}` : `${hr12}:${String(m).padStart(2, "0")}`;
}

function fmtTimeRange(start, end) {
  if (!start || !end) return "";
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Cycle-aware singular/plural noun for instructional units.
// summer_camp -> camp/camps; afterschool (and anything else) -> class/classes.
function unitLabel(cycleType, count) {
  const plural = count !== 1;
  if (cycleType === "summer_camp") return plural ? "camps" : "camp";
  return plural ? "classes" : "class";
}

// Cycle codes ("SU26") -> human-readable ("Summer 2026").
// Falls back to the raw code if the pattern doesn't match.
function cycleDisplayName(code) {
  if (!code) return "";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

function classDaysLabel(days) {
  if (!Array.isArray(days) || days.length === 0) return null;
  const isStandardWeek = days.length === 5 && WEEKDAYS.every((d) => days.includes(d));
  if (isStandardWeek) return null;
  const idx = days.map((d) => WEEKDAYS.indexOf(d)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (idx.length === 0) return null;
  const consecutive = idx.every((v, i, a) => i === 0 || v === a[i - 1] + 1);
  if (consecutive && idx.length >= 3) {
    return `${DAY_SHORT[WEEKDAYS[idx[0]]]}–${DAY_SHORT[WEEKDAYS[idx[idx.length - 1]]]} only`;
  }
  return `${idx.map((i) => DAY_SHORT[WEEKDAYS[i]]).join(" · ")} only`;
}

function deriveStatus(session, assignments) {
  const own = assignments.filter((a) => a.camp_session_id === session.id && a.status !== "withdrawn");
  if (own.length === 0) return "needs_hire";
  let best = null;
  for (const a of own) {
    const rank = STATUS_RANK[a.status] ?? -1;
    if (!best || rank > best.rank) {
      best = {
        status: a.status,
        rank,
        flags: a.flags ?? [],
        instructor_response_at: a.instructor_response_at ?? null,
      };
    }
  }
  if (best.status === "change_requested") return "change_requested";
  if (Array.isArray(best.flags) && best.flags.length > 0) return "flagged";
  // Instructor has actively accepted = confirmed + a response timestamp.
  if (best.status === "confirmed" && best.instructor_response_at) return "accepted";
  if (best.status === "confirmed" || best.status === "published") return "confirmed";
  return "ok";
}

function statusColor(status) {
  if (status === "needs_hire") return CORAL;
  if (status === "flagged") return GOLD;
  if (status === "change_requested") return CHANGE_REQ;
  if (status === "accepted") return OK_GREEN;
  return PLUM;
}

function enrollmentTone(n) {
  if (n == null) return "muted";
  if (n < CANCEL_THRESHOLD) return "danger";
  if (n < MIN_ENROLLMENT) return "warn";
  return "ok";
}

// Returns business-days-from-today as YYYY-MM-DD (skips Sat/Sun).
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

function classDaysOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.some((d) => b.includes(d));
}

// Time-of-day overlap: morning vs afternoon don't conflict; full_day conflicts with everything.
function sessionTimeOverlap(a, b) {
  if (!a || !b) return true;
  if (a === "full_day" || b === "full_day") return true;
  return a === b;
}

// validateDrop returns { ok: boolean, hardBlocks: [msg], warnings: [msg] }.
// `srcAssignmentId` is excluded from double-booking checks because it's the row being moved.
function validateDrop({
  instructor, availability, locPref, curPref,
  targetSession, otherAssignments, srcAssignmentId,
}) {
  const hardBlocks = [];
  const warnings = [];
  const firstName = instructor?.first_name ?? "Instructor";

  if (!availability) {
    hardBlocks.push(`${firstName} has no availability survey for this cycle.`);
    return { ok: false, hardBlocks, warnings };
  }
  const sessionTypes = availability.session_types ?? [];
  const availableWeeks = availability.available_weeks ?? [];

  if (!availableWeeks.includes(targetSession.week_num)) {
    hardBlocks.push(`${firstName} isn't available in week ${targetSession.week_num}.`);
  }
  if (targetSession.session_type && !sessionTypes.includes(targetSession.session_type)) {
    hardBlocks.push(`${firstName} doesn't work ${titleCase(targetSession.session_type)} sessions.`);
  }
  // Double-booking — class_days-aware AND session-time-aware (morning+afternoon don't conflict).
  const conflicts = otherAssignments.filter((a) =>
    a.id !== srcAssignmentId &&
    a.status !== "withdrawn" &&
    a.instructor_id === instructor?.id &&
    a.session.week_num === targetSession.week_num &&
    a.session.id !== targetSession.id &&
    classDaysOverlap(a.session.class_days ?? WEEKDAYS, targetSession.class_days ?? WEEKDAYS) &&
    sessionTimeOverlap(a.session.session_type, targetSession.session_type)
  );
  if (conflicts.length) {
    const c = conflicts[0].session;
    hardBlocks.push(`${firstName} would be double-booked: also on ${c.location_name} (${c.session_type}) week ${c.week_num}.`);
  }

  if (locPref === "not_preferred") {
    warnings.push(`${firstName} marked ${targetSession.location_name} as not preferred.`);
  }
  if (curPref === "not_preferred") {
    warnings.push(`${firstName} marked ${titleCase(targetSession.curriculum_category)} as not preferred.`);
  }
  if (targetSession.enrollment_synced_at && targetSession.current_enrollment != null && targetSession.current_enrollment < MIN_ENROLLMENT) {
    warnings.push(`Enrollment is ${targetSession.current_enrollment} — below the ${MIN_ENROLLMENT}-student minimum.`);
  }
  if (
    sessionTypes.includes("full_day") &&
    (targetSession.session_type === "morning" || targetSession.session_type === "afternoon")
  ) {
    warnings.push(`${firstName} is reserved for full-day work.`);
  }
  if (availability.needs_confirmation) {
    warnings.push(`${firstName}'s availability is unconfirmed.`);
  }

  return { ok: hardBlocks.length === 0, hardBlocks, warnings };
}

export default function Schedule() {
  const { org } = useOutletContext() ?? {};
  const [state, setState] = useState({ status: "loading" });
  const [focusedWeek, setFocusedWeek] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [selectedInstructors, setSelectedInstructors] = useState(() => new Set());
  const [selectedLocations, setSelectedLocations] = useState(() => new Set());
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set());
  const [saveError, setSaveError] = useState(null); // serious-error banner (DB failures only)
  const [busy, setBusy] = useState(null); // "approving" | "sending" | "previewing" | "rematching" | null
  const [offerDialog, setOfferDialog] = useState(null); // { mode: 'choose' | 'result', payload: any }
  const [previewData, setPreviewData] = useState(null); // { previews: [...] } from preview mode
  const [offerDeadline, setOfferDeadline] = useState(() => businessDaysFromToday(5));
  const [lastOp, setLastOp] = useState(null); // { type, ... } — supports a single-step undo
  const [candidatesFor, setCandidatesFor] = useState(null); // { session, currentAssignment | null }
  const [changeRequestFor, setChangeRequestFor] = useState(null); // { session, assignment }

  const dragStateRef = useRef(null);

  async function loadAll() {
    if (!org?.id) return;
    try {
      const { data: cycle, error: cycleErr } = await supabase
        .from("scheduling_cycles")
        .select("id, name, cycle_type, starts_on, ends_on, status, weeks")
        .eq("organization_id", org.id)
        .neq("status", "archived")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cycleErr) throw cycleErr;
      if (!cycle) { setState({ status: "empty" }); return; }

      const sessionsRes = await supabase
        .from("camp_sessions")
        .select("id, location_name, week_num, session_type, curriculum_category, curriculum_name, start_time, end_time, current_enrollment, enrollment_synced_at, class_days, status")
        .eq("cycle_id", cycle.id)
        .eq("status", "active")
        .order("location_name", { ascending: true });
      if (sessionsRes.error) throw sessionsRes.error;
      const sessions = sessionsRes.data ?? [];
      const sessionIds = sessions.map((s) => s.id);

      const [assignmentsRes, instructorsRes, availabilityRes, locPrefRes, curPrefRes] = await Promise.all([
        sessionIds.length
          ? supabase
              .from("camp_assignments")
              .select("id, camp_session_id, status, role, change_request_message, distance_bonus_cents, instructor_response_at, instructor:instructors(id, first_name, last_name, email)")
              .in("camp_session_id", sessionIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("instructors")
          .select("id, first_name, last_name")
          .eq("organization_id", org.id)
          .eq("is_active", true)
          .order("first_name", { ascending: true }),
        supabase
          .from("instructor_availability")
          .select("instructor_id, session_types, available_weeks, needs_confirmation, notes")
          .eq("cycle_id", cycle.id),
        supabase
          .from("instructor_location_preferences")
          .select("instructor_id, location_name, preference")
          .eq("cycle_id", cycle.id),
        supabase
          .from("instructor_curriculum_preferences")
          .select("instructor_id, curriculum_category, preference")
          .eq("cycle_id", cycle.id),
      ]);
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (instructorsRes.error) throw instructorsRes.error;
      if (availabilityRes.error) throw availabilityRes.error;
      if (locPrefRes.error) throw locPrefRes.error;
      if (curPrefRes.error) throw curPrefRes.error;

      const assignments = (assignmentsRes.data ?? []).map((a) => ({
        id: a.id,
        camp_session_id: a.camp_session_id,
        status: a.status,
        role: a.role,
        change_request_message: a.change_request_message ?? null,
        distance_bonus_cents: a.distance_bonus_cents ?? null,
        instructor_response_at: a.instructor_response_at ?? null,
        instructor_id: a.instructor?.id ?? null,
        instructor_first: a.instructor?.first_name ?? null,
        instructor_last: a.instructor?.last_name ?? null,
        instructor_email: a.instructor?.email ?? null,
        flags: [],
      }));
      const instructors = instructorsRes.data ?? [];
      const availability = availabilityRes.data ?? [];
      const surveyedIds = new Set(availability.map((r) => r.instructor_id));
      const missingSurveys = instructors.filter((i) => !surveyedIds.has(i.id)).length;

      setState({
        status: "ready",
        cycle,
        sessions,
        assignments,
        instructors,
        availability,
        locPrefs: locPrefRes.data ?? [],
        curPrefs: curPrefRes.data ?? [],
        missingSurveys,
      });
    } catch (err) {
      console.error("Schedule load error:", err);
      setState({ status: "error", message: err.message ?? "Could not load schedule." });
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      await loadAll();
      if (!alive) setState((s) => s); // no-op; keeps lint quiet
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  // Realtime: when an instructor accepts or requests a change in the portal, the
  // camp_assignments row updates. Subscribe so the calendar reflects the change
  // without a manual refresh. We merge the updated row in place rather than
  // refetching the entire calendar.
  useEffect(() => {
    if (state.status !== "ready") return;
    const sessionIds = state.sessions.map((s) => s.id);
    if (sessionIds.length === 0) return;

    const channel = supabase
      .channel(`assignments-${state.cycle.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "camp_assignments" },
        (payload) => {
          // Filter client-side to rows in the active cycle (Realtime filters
          // don't support IN-clauses, so we accept all and discard the rest).
          const row = payload.new ?? payload.old;
          if (!row?.camp_session_id || !sessionIds.includes(row.camp_session_id)) return;
          setState((s) => {
            if (s.status !== "ready") return s;
            if (payload.eventType === "DELETE") {
              return { ...s, assignments: s.assignments.filter((a) => a.id !== payload.old.id) };
            }
            const updated = {
              id: payload.new.id,
              camp_session_id: payload.new.camp_session_id,
              status: payload.new.status,
              role: payload.new.role,
              change_request_message: payload.new.change_request_message ?? null,
              distance_bonus_cents: payload.new.distance_bonus_cents ?? null,
              instructor_response_at: payload.new.instructor_response_at ?? null,
              instructor_id: payload.new.instructor_id,
              // Realtime payloads don't include joined data — preserve our prior
              // instructor name/email if we already have it, else they'll show up
              // on the next full loadAll().
              instructor_first: s.assignments.find((a) => a.id === payload.new.id)?.instructor_first ?? null,
              instructor_last: s.assignments.find((a) => a.id === payload.new.id)?.instructor_last ?? null,
              instructor_email: s.assignments.find((a) => a.id === payload.new.id)?.instructor_email ?? null,
              flags: [],
            };
            const existingIdx = s.assignments.findIndex((a) => a.id === updated.id);
            const nextAssignments = existingIdx >= 0
              ? s.assignments.map((a, i) => (i === existingIdx ? { ...a, ...updated } : a))
              : [...s.assignments, updated];
            return { ...s, assignments: nextAssignments };
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === "ready" ? state.cycle?.id : null]);

  const enriched = useMemo(() => {
    if (state.status !== "ready") return null;
    const { sessions, assignments, availability } = state;
    const availMap = new Map((availability ?? []).map((r) => [r.instructor_id, r]));
    const annotate = (a) => {
      const av = availMap.get(a.instructor_id);
      return {
        ...a,
        instructor_needs_confirmation: av?.needs_confirmation === true,
        instructor_notes: av?.notes ?? null,
      };
    };
    const byId = new Map();
    for (const s of sessions) {
      const status = deriveStatus(s, assignments);
      const own = assignments.filter((a) => a.camp_session_id === s.id).map(annotate);
      const ownActive = own.filter((a) => a.status !== "withdrawn");
      const lead = ownActive.find((a) => a.role === "lead") ?? ownActive[0] ?? null;
      byId.set(s.id, { session: s, status, assignment: lead, allAssignments: own, activeAssignments: ownActive });
    }
    return byId;
  }, [state]);

  // Lookups for validation.
  const availabilityByInstructor = useMemo(() => {
    if (state.status !== "ready") return new Map();
    return new Map((state.availability ?? []).map((r) => [r.instructor_id, r]));
  }, [state]);
  const locPrefLookup = useMemo(() => {
    if (state.status !== "ready") return new Map();
    return new Map((state.locPrefs ?? []).map((r) => [`${r.instructor_id}|${r.location_name}`, r.preference]));
  }, [state]);
  const curPrefLookup = useMemo(() => {
    if (state.status !== "ready") return new Map();
    return new Map((state.curPrefs ?? []).map((r) => [`${r.instructor_id}|${r.curriculum_category}`, r.preference]));
  }, [state]);
  // For double-booking lookups: assignment rows joined with their session class_days/week.
  const assignmentsWithSession = useMemo(() => {
    if (!enriched) return [];
    const out = [];
    for (const e of enriched.values()) {
      for (const a of e.allAssignments) {
        out.push({ ...a, session: e.session });
      }
    }
    return out;
  }, [enriched]);

  function matchesFilters(e) {
    const q = searchText.trim().toLowerCase();
    if (selectedLocations.size && !selectedLocations.has(e.session.location_name)) return false;
    if (selectedStatuses.size && !selectedStatuses.has(e.status)) return false;
    if (selectedInstructors.size) {
      const ids = e.activeAssignments.map((a) => a.instructor_id).filter(Boolean);
      if (!ids.some((id) => selectedInstructors.has(id))) return false;
    }
    if (q) {
      const haystack = [
        e.session.curriculum_name, e.session.curriculum_category, e.session.session_type, e.session.location_name,
        ...e.activeAssignments.flatMap((a) => [a.instructor_first, a.instructor_last]),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  const hasFilters = !!searchText || selectedInstructors.size || selectedLocations.size || selectedStatuses.size;

  // Header counters always reflect the full cycle (truth).
  const counts = useMemo(() => {
    if (!enriched) return { assigned: 0, accepted: 0, flagged: 0, changeRequested: 0, needsHire: 0 };
    let assigned = 0, accepted = 0, flagged = 0, changeRequested = 0, needsHire = 0;
    for (const e of enriched.values()) {
      if (e.status === "needs_hire") needsHire++;
      else if (e.status === "flagged") flagged++;
      else if (e.status === "change_requested") changeRequested++;
      else if (e.status === "accepted") accepted++;
      else assigned++;
    }
    return { assigned, accepted, flagged, changeRequested, needsHire };
  }, [enriched]);

  // Overview dots respect filters so toggling them is visible without focusing a week.
  const weekBuckets = useMemo(() => {
    if (!enriched) return new Map();
    const m = new Map();
    for (const e of enriched.values()) {
      if (hasFilters && !matchesFilters(e)) continue;
      const wn = e.session.week_num;
      if (!m.has(wn)) m.set(wn, []);
      m.get(wn).push(e.status);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched, hasFilters, searchText, selectedInstructors, selectedLocations, selectedStatuses]);

  const locations = useMemo(() => {
    if (state.status !== "ready") return [];
    const set = new Set(state.sessions.map((s) => s.location_name).filter(Boolean));
    return Array.from(set).sort();
  }, [state]);

  const filteredEnrichedForWeek = useMemo(() => {
    if (!enriched || focusedWeek == null) return [];
    const out = [];
    for (const e of enriched.values()) {
      if (e.session.week_num !== focusedWeek) continue;
      if (!matchesFilters(e)) continue;
      out.push(e);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched, focusedWeek, searchText, selectedInstructors, selectedLocations, selectedStatuses]);

  if (state.status === "loading") return <div style={{ color: MUTED, fontSize: 14 }}>Loading schedule…</div>;
  if (state.status === "empty") return <Empty title="No active cycle" body="Create a scheduling cycle to begin assigning instructors to camps or classes." />;
  if (state.status === "error") return <Empty title="Couldn't load schedule" body={state.message} tone="error" />;

  const { cycle } = state;
  const weeks = Array.isArray(cycle.weeks) ? cycle.weeks : [];

  function clearFilters() {
    setSearchText("");
    setSelectedInstructors(new Set());
    setSelectedLocations(new Set());
    setSelectedStatuses(new Set());
  }

  function getValidationFor(targetSession, srcAssignment) {
    if (!srcAssignment) return { ok: false, hardBlocks: ["Nothing to move."], warnings: [] };
    const instructor = {
      id: srcAssignment.instructor_id,
      first_name: srcAssignment.instructor_first,
      last_name: srcAssignment.instructor_last,
    };
    const availability = availabilityByInstructor.get(instructor.id);
    const locPref = locPrefLookup.get(`${instructor.id}|${targetSession.location_name}`);
    const curPref = curPrefLookup.get(`${instructor.id}|${targetSession.curriculum_category}`);
    return validateDrop({
      instructor, availability, locPref, curPref,
      targetSession, otherAssignments: assignmentsWithSession,
      srcAssignmentId: srcAssignment.id,
    });
  }

  async function handleDrop(targetSession) {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    if (!drag) return;
    if (drag.sourceSessionId === targetSession.id) return; // no-op

    const srcAssignment = state.assignments.find((a) => a.id === drag.assignmentId);
    if (!srcAssignment) return;

    const result = getValidationFor(targetSession, srcAssignment);
    if (!result.ok) {
      // Block reason already shown inline during drag — silently reject.
      return;
    }

    // Snapshot for undo before any write.
    const srcSnapshot = {
      organization_id: org.id,
      camp_session_id: srcAssignment.camp_session_id,
      instructor_id: srcAssignment.instructor_id,
      role: srcAssignment.role,
      status: srcAssignment.status,
    };
    const targetLead = state.assignments.find(
      (a) => a.camp_session_id === targetSession.id && a.role === "lead" && a.status !== "withdrawn"
    );
    const tgtBefore = targetLead ? {
      id: targetLead.id,
      instructor_id: targetLead.instructor_id,
      status: targetLead.status,
    } : null;

    try {
      let tgtNewId = null;
      if (targetLead) {
        // Reassign in place — UPDATE the existing lead row to point at the new instructor.
        const { error: updErr } = await supabase
          .from("camp_assignments")
          .update({ instructor_id: srcAssignment.instructor_id, status: "proposed" })
          .eq("id", targetLead.id);
        if (updErr) throw updErr;
      } else {
        // No existing lead — INSERT a new row.
        const { data: inserted, error: insErr } = await supabase
          .from("camp_assignments")
          .insert({
            organization_id: org.id,
            camp_session_id: targetSession.id,
            instructor_id: srcAssignment.instructor_id,
            role: "lead",
            status: "proposed",
          })
          .select("id")
          .single();
        if (insErr) throw insErr;
        tgtNewId = inserted.id;
      }

      // Source: DELETE so its lead role is vacated (UNIQUE(session,role) prevents 'withdrawn' rows + new inserts).
      const { error: delErr } = await supabase
        .from("camp_assignments")
        .delete()
        .eq("id", srcAssignment.id);
      if (delErr) throw delErr;

      setLastOp({
        type: "move",
        srcSnapshot,
        tgtBefore,
        tgtNewId,
        label: `${srcAssignment.instructor_first} → ${targetSession.location_name}, wk ${targetSession.week_num}`,
      });

      await loadAll();
    } catch (err) {
      console.error("Drop failed:", err);
      setSaveError(`Couldn't save: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
      await loadAll();
    }
  }

  async function handlePick(targetSession, currentAssignment, instructorId, _warningsIgnored, role = "lead") {
    try {
      if (currentAssignment) {
        const prevInstructorId = currentAssignment.instructor_id;
        const prevStatus = currentAssignment.status;
        const { error: updErr } = await supabase
          .from("camp_assignments")
          .update({ instructor_id: instructorId, status: "proposed" })
          .eq("id", currentAssignment.id);
        if (updErr) throw updErr;
        setLastOp({
          type: "reassign",
          assignmentId: currentAssignment.id,
          prevInstructorId,
          prevStatus,
          label: `Reassigned ${targetSession.location_name}, wk ${targetSession.week_num}`,
        });
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from("camp_assignments")
          .insert({
            organization_id: org.id,
            camp_session_id: targetSession.id,
            instructor_id: instructorId,
            role,
            status: "proposed",
          })
          .select("id")
          .single();
        if (insErr) throw insErr;
        setLastOp({
          type: "assign",
          assignmentId: inserted.id,
          label: `Assigned ${role} on ${targetSession.location_name}, wk ${targetSession.week_num}`,
        });
      }

      setCandidatesFor(null);
      await loadAll();
    } catch (err) {
      console.error("Pick failed:", err);
      setSaveError(`Couldn't save: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  async function handleResetAcceptance(targetSession, currentAssignment) {
    if (!currentAssignment) return;
    try {
      const prevStatus = currentAssignment.status;
      const prevResponseAt = currentAssignment.instructor_response_at;
      const { error: updErr } = await supabase
        .from("camp_assignments")
        .update({ status: "published", instructor_response_at: null })
        .eq("id", currentAssignment.id);
      if (updErr) throw updErr;
      setLastOp({
        type: "reset_acceptance",
        assignmentId: currentAssignment.id,
        prevStatus,
        prevResponseAt,
        label: `Reset acceptance on ${targetSession.location_name}, wk ${targetSession.week_num}`,
      });
      setCandidatesFor(null);
      await loadAll();
    } catch (err) {
      console.error("Reset acceptance failed:", err);
      setSaveError(`Couldn't reset: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  async function handleRemoveAssignment(targetSession, currentAssignment) {
    if (!currentAssignment) return;
    try {
      const snapshot = {
        organization_id: org.id,
        camp_session_id: currentAssignment.camp_session_id,
        instructor_id: currentAssignment.instructor_id,
        role: currentAssignment.role,
        status: currentAssignment.status,
      };
      const { error: delErr } = await supabase
        .from("camp_assignments")
        .delete()
        .eq("id", currentAssignment.id);
      if (delErr) throw delErr;
      setLastOp({
        type: "remove",
        snapshot,
        label: `Removed instructor from ${targetSession.location_name}, wk ${targetSession.week_num}`,
      });
      setCandidatesFor(null);
      await loadAll();
    } catch (err) {
      console.error("Remove failed:", err);
      setSaveError(`Couldn't save: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  // Creates a new instructor + a minimal availability row scoped to *this* session
  // (admin's choice — see picker copy). Returns the new instructor's id.
  async function handleCreateInstructor({ firstName, lastName, email, confirmed }, targetSession) {
    const { data: newInst, error: instErr } = await supabase
      .from("instructors")
      .insert({
        organization_id: org.id,
        first_name: firstName.trim(),
        last_name: lastName?.trim() || null,
        email: email?.trim() || null,
        is_active: true,
      })
      .select("id, first_name, last_name")
      .single();
    if (instErr) throw instErr;

    const { error: availErr } = await supabase
      .from("instructor_availability")
      .insert({
        organization_id: org.id,
        cycle_id: state.cycle.id,
        instructor_id: newInst.id,
        session_types: [targetSession.session_type],
        available_weeks: [targetSession.week_num],
        needs_confirmation: !confirmed,
      });
    if (availErr) throw availErr;

    return newInst.id;
  }

  async function handleRerunAgent() {
    if (state.status !== "ready") return;
    if (state.cycle.status !== "collecting") return;
    const ok = window.confirm(
      "Re-run the matching agent for this cycle? This wipes existing proposed assignments and generates fresh ones from instructor surveys."
    );
    if (!ok) return;
    setBusy("rematching");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("match-instructors", {
        body: { cycle_id: state.cycle.id, dry_run: false },
      });
      if (error) {
        let realMsg = error.message ?? "function error";
        try {
          const body = await error.context?.json?.();
          if (body?.error) realMsg = body.error;
        } catch {}
        throw new Error(realMsg);
      }
      if (data?.error) throw new Error(data.error);
      await loadAll();
    } catch (err) {
      console.error("Re-run agent failed:", err);
      setSaveError(`Couldn't re-run the agent: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 8000);
    } finally {
      setBusy(null);
    }
  }

  async function handleApprove() {
    if (state.status !== "ready") return;
    setBusy("approving");
    setSaveError(null);
    try {
      const sessionIds = state.sessions.map((s) => s.id);
      if (sessionIds.length === 0) return;
      const { data, error: updErr } = await supabase
        .from("camp_assignments")
        .update({ status: "confirmed" })
        .eq("status", "proposed")
        .in("camp_session_id", sessionIds)
        .select("id");
      if (updErr) throw updErr;
      const flippedIds = (data ?? []).map((r) => r.id);
      const prevCycleStatus = state.cycle.status;
      if (prevCycleStatus === "collecting") {
        await supabase
          .from("scheduling_cycles")
          .update({ status: "scheduling" })
          .eq("id", state.cycle.id);
      }
      setLastOp({
        type: "approve",
        assignmentIds: flippedIds,
        prevCycleStatus,
        label: `Approved ${flippedIds.length} assignment${flippedIds.length === 1 ? "" : "s"}`,
      });
      await loadAll();
      setOfferDialog({ mode: "result", payload: { kind: "approve", count: flippedIds.length } });
    } catch (err) {
      console.error("Approve failed:", err);
      setSaveError(`Couldn't approve: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    } finally {
      setBusy(null);
    }
  }

  async function handleSendOffers(mode) {
    if (state.status !== "ready") return;
    setBusy("sending");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-offers", {
        body: { cycle_id: state.cycle.id, mode, instructor_ids: null, deadline: offerDeadline },
      });
      if (error) {
        let realMsg = error.message ?? "function error";
        try {
          const body = await error.context?.json?.();
          if (body?.error) realMsg = body.error;
        } catch {}
        throw new Error(realMsg);
      }
      if (data?.error) throw new Error(data.error);
      await loadAll();
      setOfferDialog({ mode: "result", payload: { kind: "send", mode, ...data } });
    } catch (err) {
      console.error("Send offers failed:", err);
      setSaveError(`Couldn't send: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
      setOfferDialog(null);
    } finally {
      setBusy(null);
    }
  }

  async function handleRollback() {
    if (state.status !== "ready") return;
    const confirmed = window.confirm(
      "Reset all already-sent offers so you can send them again? " +
      "Any Accept or Request change responses you've already received will be cleared. " +
      "Distance bonuses are kept."
    );
    if (!confirmed) return;
    setBusy("rolling_back");
    setSaveError(null);
    try {
      const sessionIds = state.sessions.map((s) => s.id);
      if (sessionIds.length === 0) return;
      const { data, error: rbErr } = await supabase
        .from("camp_assignments")
        .update({
          status: "confirmed",
          published_at: null,
          email_sent_at: null,
          instructor_response_at: null,
          change_request_message: null,
          deadline: null,
        })
        .eq("status", "published")
        .in("camp_session_id", sessionIds)
        .select("id");
      if (rbErr) throw rbErr;
      const count = data?.length ?? 0;
      setLastOp(null);
      await loadAll();
      setOfferDialog({ mode: "result", payload: { kind: "rollback", count } });
    } catch (err) {
      console.error("Rollback failed:", err);
      setSaveError(`Couldn't roll back: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    } finally {
      setBusy(null);
    }
  }

  async function handleRunReminders(dryRun) {
    if (state.status !== "ready") return;
    setBusy("reminders");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("offer-reminders-cron", {
        body: { dry_run: dryRun },
      });
      if (error) {
        let realMsg = error.message ?? "function error";
        try { const body = await error.context?.json?.(); if (body?.error) realMsg = body.error; } catch {}
        throw new Error(realMsg);
      }
      if (data?.error) throw new Error(data.error);
      await loadAll();
      setOfferDialog({ mode: "result", payload: { kind: "reminders", dry_run: dryRun, ...data } });
    } catch (err) {
      console.error("Reminders failed:", err);
      setSaveError(`Couldn't run reminders: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 8000);
    } finally {
      setBusy(null);
    }
  }

  async function handlePreviewOffers() {
    if (state.status !== "ready") return;
    setBusy("previewing");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-offers", {
        body: { cycle_id: state.cycle.id, mode: "preview", instructor_ids: null },
      });
      if (error) {
        // Read the actual response body so we can see the real error message.
        let realMsg = error.message ?? "function error";
        try {
          const body = await error.context?.json?.();
          if (body?.error) realMsg = body.error;
        } catch {}
        throw new Error(realMsg);
      }
      if (data?.error) throw new Error(data.error);
      setPreviewData(data);
    } catch (err) {
      console.error("Preview failed:", err);
      setSaveError(`Couldn't preview: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 9000);
    } finally {
      setBusy(null);
    }
  }

  async function handleUndo() {
    const op = lastOp;
    if (!op) return;
    setLastOp(null);
    setSaveError(null);
    try {
      if (op.type === "move") {
        // Reverse target side first to free the (session, role) slot if needed.
        if (op.tgtBefore) {
          const { error: tgtErr } = await supabase
            .from("camp_assignments")
            .update({ instructor_id: op.tgtBefore.instructor_id, status: op.tgtBefore.status })
            .eq("id", op.tgtBefore.id);
          if (tgtErr) throw tgtErr;
        } else if (op.tgtNewId) {
          const { error: delErr } = await supabase
            .from("camp_assignments")
            .delete()
            .eq("id", op.tgtNewId);
          if (delErr) throw delErr;
        }
        // Re-insert source row.
        const { error: srcErr } = await supabase
          .from("camp_assignments")
          .insert(op.srcSnapshot);
        if (srcErr) throw srcErr;
      } else if (op.type === "assign") {
        const { error: delErr } = await supabase
          .from("camp_assignments")
          .delete()
          .eq("id", op.assignmentId);
        if (delErr) throw delErr;
      } else if (op.type === "reassign") {
        const { error: updErr } = await supabase
          .from("camp_assignments")
          .update({ instructor_id: op.prevInstructorId, status: op.prevStatus })
          .eq("id", op.assignmentId);
        if (updErr) throw updErr;
      } else if (op.type === "remove") {
        const { error: insErr } = await supabase
          .from("camp_assignments")
          .insert(op.snapshot);
        if (insErr) throw insErr;
      } else if (op.type === "reset_acceptance") {
        const { error: updErr } = await supabase
          .from("camp_assignments")
          .update({ status: op.prevStatus, instructor_response_at: op.prevResponseAt })
          .eq("id", op.assignmentId);
        if (updErr) throw updErr;
      } else if (op.type === "approve") {
        if (op.assignmentIds.length > 0) {
          const { error: revertErr } = await supabase
            .from("camp_assignments")
            .update({ status: "proposed" })
            .in("id", op.assignmentIds);
          if (revertErr) throw revertErr;
        }
        if (op.prevCycleStatus && op.prevCycleStatus !== state.cycle.status) {
          await supabase
            .from("scheduling_cycles")
            .update({ status: op.prevCycleStatus })
            .eq("id", state.cycle.id);
        }
      }
      await loadAll();
    } catch (err) {
      console.error("Undo failed:", err);
      setSaveError(`Undo failed: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
      setLastOp(op);
      await loadAll();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <HeaderStrip
        cycle={cycle}
        counts={counts}
        missingSurveys={state.missingSurveys}
        lastOp={lastOp}
        onUndo={handleUndo}
        busy={busy}
        canApprove={cycle.status !== "published"}
        canSend={cycle.status === "scheduling" || cycle.status === "published"}
        canRematch={cycle.status === "collecting"}
        onApprove={handleApprove}
        onSendClick={() => setOfferDialog({ mode: "choose", payload: null })}
        onPreviewClick={handlePreviewOffers}
        onRerunAgent={handleRerunAgent}
        onRemindersClick={() => setOfferDialog({ mode: "reminders_choose", payload: null })}
      />
      {saveError && (
        <div style={{
          background: `${CORAL}1F`,
          border: `1px solid ${CORAL}`,
          borderRadius: 8,
          padding: "10px 14px",
          color: CORAL,
          fontWeight: 600,
          fontSize: 13,
          position: "sticky",
          top: 120,
          zIndex: 4,
        }}>
          {saveError}
        </div>
      )}
      <FilterBar
        cycleType={cycle.cycle_type}
        searchText={searchText}
        onSearchChange={setSearchText}
        instructors={state.instructors}
        selectedInstructors={selectedInstructors}
        onToggleInstructor={(id) => setSelectedInstructors((s) => toggleSet(s, id))}
        locations={locations}
        selectedLocations={selectedLocations}
        onToggleLocation={(name) => setSelectedLocations((s) => toggleSet(s, name))}
        selectedStatuses={selectedStatuses}
        onToggleStatus={(k) => setSelectedStatuses((s) => toggleSet(s, k))}
        onClear={clearFilters}
        hasFilters={hasFilters}
      />
      <TermOverview
        weeks={weeks}
        weekBuckets={weekBuckets}
        focusedWeek={focusedWeek}
        onFocus={setFocusedWeek}
      />
      <Legend />
      {focusedWeek != null ? (
        <WeeklyGrid
          week={weeks.find((w) => w.num === focusedWeek)}
          items={filteredEnrichedForWeek}
          cycleType={cycle.cycle_type}
          getValidationFor={getValidationFor}
          dragStateRef={dragStateRef}
          onDrop={handleDrop}
          onNeedsHireClick={(session) => setCandidatesFor({ session, currentAssignment: null, role: "lead" })}
          onInstructorClick={(session, currentAssignment, roleHint) => setCandidatesFor({
            session,
            currentAssignment,
            role: currentAssignment?.role ?? roleHint ?? "lead",
          })}
          onChangeRequestClick={(session, assignment) => setChangeRequestFor({ session, assignment })}
        />
      ) : (
        <div style={{
          background: "#fff",
          border: `1px dashed ${RULE}`,
          borderRadius: 8,
          padding: 28,
          textAlign: "center",
          color: MUTED,
          fontSize: 13,
        }}>
          {hasFilters
            ? `Filters active — click a week above to see matching ${unitLabel(cycle.cycle_type, 2)} in its day-by-day grid.`
            : "Click a week above to see its day-by-day grid."}
        </div>
      )}
      {offerDialog && (
        <OfferDialog
          dialog={offerDialog}
          onChoose={(mode) => handleSendOffers(mode)}
          onClose={() => setOfferDialog(null)}
          busy={busy === "sending"}
          deadline={offerDeadline}
          onDeadlineChange={setOfferDeadline}
          publishedCount={state.assignments?.filter((a) => a.status === "published").length ?? 0}
          onRollback={handleRollback}
          rollingBack={busy === "rolling_back"}
          onRunReminders={handleRunReminders}
          remindersBusy={busy === "reminders"}
        />
      )}
      {previewData && (
        <PreviewViewer
          data={previewData}
          onClose={() => setPreviewData(null)}
        />
      )}
      {changeRequestFor && (
        <ChangeRequestReview
          session={changeRequestFor.session}
          assignment={changeRequestFor.assignment}
          cycle={cycle}
          orgName={org?.name ?? "Journey to STEAM"}
          onClose={() => setChangeRequestFor(null)}
          onUnassign={async () => {
            await handleRemoveAssignment(changeRequestFor.session, changeRequestFor.assignment);
            setChangeRequestFor(null);
          }}
          onReassign={() => {
            setCandidatesFor({ session: changeRequestFor.session, currentAssignment: changeRequestFor.assignment, role: changeRequestFor.assignment.role });
            setChangeRequestFor(null);
          }}
        />
      )}
      {candidatesFor && (
        <CandidatePicker
          session={candidatesFor.session}
          currentAssignment={candidatesFor.currentAssignment}
          instructors={state.instructors}
          availabilityByInstructor={availabilityByInstructor}
          locPrefLookup={locPrefLookup}
          curPrefLookup={curPrefLookup}
          allAssignments={assignmentsWithSession}
          onClose={() => setCandidatesFor(null)}
          role={candidatesFor.role}
          onPick={(instructorId) => handlePick(candidatesFor.session, candidatesFor.currentAssignment, instructorId, null, candidatesFor.role)}
          onRemove={() => handleRemoveAssignment(candidatesFor.session, candidatesFor.currentAssignment)}
          onResetAcceptance={() => handleResetAcceptance(candidatesFor.session, candidatesFor.currentAssignment)}
          onCreateInstructor={async (form) => {
            const newId = await handleCreateInstructor(form, candidatesFor.session);
            await handlePick(candidatesFor.session, candidatesFor.currentAssignment, newId, null, candidatesFor.role);
          }}
        />
      )}
    </div>
  );
}

function toggleSet(s, key) {
  const next = new Set(s);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

function HeaderStrip({ cycle, counts, missingSurveys, lastOp, onUndo, busy, canApprove, canSend, canRematch, onApprove, onSendClick, onPreviewClick, onRerunAgent, onRemindersClick }) {
  return (
    <header style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: "18px 22px",
      display: "flex",
      flexWrap: "wrap",
      gap: 20,
      alignItems: "center",
      justifyContent: "space-between",
      position: "sticky",
      top: 0,
      zIndex: 5,
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>{cycleDisplayName(cycle.name)}</h1>
          <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>{cycle.status}</span>
        </div>
        <div style={{ color: MUTED, marginTop: 4, fontSize: 14 }}>{fmtRange(cycle.starts_on, cycle.ends_on)}</div>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <Counter label="Assigned" value={counts.assigned} tone="assigned" />
        <Counter label="Accepted" value={counts.accepted} tone="accepted" />
        <Counter label="Flagged" value={counts.flagged} tone="flagged" />
        <Counter label="Change req." value={counts.changeRequested} tone="change_requested" />
        <Counter label="Needs hire" value={counts.needsHire} tone="needs_hire" />
        <Counter label="Surveys out" value={missingSurveys} tone="muted" />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {lastOp && (
          <button
            type="button"
            onClick={onUndo}
            title={lastOp.label}
            style={{ ...btn("transparent", PLUM, true), padding: "7px 12px", fontSize: 13 }}
          >
            ↶ Undo
          </button>
        )}
        <button
          type="button"
          onClick={onRerunAgent}
          disabled={!canRematch || busy === "rematching"}
          title={canRematch
            ? "Re-run the matching agent on this cycle's surveys to regenerate proposed assignments"
            : "Re-running the matching agent isn't available once offers have been approved or sent — it only works on draft assignments before approval"}
          style={btn("transparent", PLUM, true, !canRematch || busy === "rematching")}
        >
          {busy === "rematching" ? "Re-running…" : "Re-run agent"}
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={!canApprove || busy === "approving"}
          title={canApprove ? "Flip all proposed assignments to confirmed" : "Already approved"}
          style={btn("transparent", PLUM, true, !canApprove || busy === "approving")}
        >
          {busy === "approving" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={onPreviewClick}
          disabled={busy === "previewing"}
          title="Render every offer email — no sends, no DB changes"
          style={btn("transparent", PLUM, true, busy === "previewing")}
        >
          {busy === "previewing" ? "Loading…" : "Preview offers"}
        </button>
        <button
          type="button"
          onClick={onSendClick}
          disabled={!canSend || busy === "sending"}
          title={canSend ? "Send the confirmed offers" : "Approve first to enable"}
          style={btn(PLUM, "#fff", false, !canSend || busy === "sending")}
        >
          Send offers
        </button>
        <button
          type="button"
          onClick={onRemindersClick}
          disabled={busy === "reminders"}
          title="Run reminder + deadline check (3 days before deadline → reminder; past deadline → flag for review)"
          style={btn("transparent", PLUM, true, busy === "reminders")}
        >
          {busy === "reminders" ? "Working…" : "Reminders"}
        </button>
      </div>
    </header>
  );
}

function Counter({ label, value, tone }) {
  const color =
    tone === "assigned" ? PLUM :
    tone === "accepted" ? OK_GREEN :
    tone === "flagged" ? GOLD :
    tone === "change_requested" ? CHANGE_REQ :
    tone === "needs_hire" ? CORAL : MUTED;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function FilterBar({
  cycleType,
  searchText, onSearchChange,
  instructors, selectedInstructors, onToggleInstructor,
  locations, selectedLocations, onToggleLocation,
  selectedStatuses, onToggleStatus,
  onClear, hasFilters,
}) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={`Search ${unitLabel(cycleType, 2)}, instructors, locations…`}
          name="schedule-search-filter"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          style={{
            flex: "1 1 240px",
            minWidth: 200,
            padding: "8px 12px",
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: "inherit",
            color: INK,
            background: "#fff",
          }}
        />
        <MultiSelect
          label="Instructors"
          options={instructors.map((i) => ({ key: i.id, label: `${i.first_name}${i.last_name ? " " + i.last_name : ""}` }))}
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
          <button type="button" onClick={onClear} style={{
            ...btn("transparent", MUTED, true),
            padding: "6px 10px",
            fontSize: 12,
          }}>
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
        style={{
          ...btn("#fff", INK, true),
          padding: "7px 10px",
          fontSize: 13,
          fontWeight: 500,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          borderColor: count > 0 ? PLUM : RULE,
        }}
      >
        <span>{label}</span>
        {count > 0 && (
          <span style={{
            background: PLUM,
            color: "#fff",
            borderRadius: 999,
            padding: "0 7px",
            fontSize: 11,
            fontWeight: 600,
          }}>{count}</span>
        )}
        <span style={{ fontSize: 10, color: MUTED }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          left: 0,
          minWidth: 220,
          maxHeight: 280,
          overflowY: "auto",
          background: "#fff",
          border: `1px solid ${RULE}`,
          borderRadius: 6,
          boxShadow: "0 4px 14px rgba(0,0,0,0.08)",
          zIndex: 10,
          padding: 6,
        }}>
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
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  background: isOn ? `${GOLD}1A` : "transparent",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "inherit",
                  color: INK,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{
                  width: 14, height: 14, borderRadius: 3,
                  border: `1.5px solid ${isOn ? PLUM : RULE}`,
                  background: isOn ? PLUM : "#fff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontSize: 10,
                  lineHeight: 1,
                  flex: "0 0 auto",
                }}>{isOn ? "✓" : ""}</span>
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
    if (i) pills.push({ key: `i:${id}`, label: i.first_name, onRemove: () => onToggleInstructor(id) });
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
        <span key={p.key} style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 4px 3px 10px",
          background: `${GOLD}1A`,
          border: `1px solid ${RULE}`,
          borderRadius: 999,
          fontSize: 12,
          color: INK,
        }}>
          <span>{p.label}</span>
          <button type="button" onClick={p.onRemove} aria-label="Remove filter" style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: "0 4px",
            fontSize: 14,
            color: MUTED,
            lineHeight: 1,
          }}>×</button>
        </span>
      ))}
    </div>
  );
}

function TermOverview({ weeks, weekBuckets, focusedWeek, onFocus }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks.length || 1}, minmax(0, 1fr))`, gap: 10 }}>
        {weeks.map((w) => {
          const dots = weekBuckets.get(w.num) ?? [];
          const isFocused = focusedWeek === w.num;
          return (
            <button
              key={w.num}
              type="button"
              onClick={() => onFocus(isFocused ? null : w.num)}
              style={{
                textAlign: "left",
                background: isFocused ? `${GOLD}1A` : CHALK,
                border: isFocused ? `2px solid ${PLUM}` : `0.5px solid ${RULE}`,
                borderRadius: 6,
                padding: "10px 10px 12px",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                minHeight: 96,
                fontFamily: "inherit",
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: INK }}>Week {w.num}</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{fmtShort(w.starts_on)}</div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: "auto" }}>
                {dots.length === 0 ? (
                  <span style={{ fontSize: 11, color: MUTED }}>—</span>
                ) : (
                  dots.map((d, i) => <Dot key={i} kind={d} />)
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Dot({ kind }) {
  const color =
    kind === "needs_hire" ? CORAL :
    kind === "flagged" ? GOLD :
    kind === "change_requested" ? CHANGE_REQ :
    kind === "accepted" ? OK_GREEN :
    PLUM;
  return <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", background: color, display: "inline-block" }} />;
}

function Legend() {
  const items = [
    { kind: "ok", label: "Assigned" },
    { kind: "accepted", label: "Accepted" },
    { kind: "flagged", label: "Flagged" },
    { kind: "change_requested", label: "Change requested" },
    { kind: "needs_hire", label: "Needs hire" },
  ];
  return (
    <div style={{ display: "flex", gap: 18, fontSize: 12, color: MUTED, paddingLeft: 4 }}>
      {items.map((it) => (
        <span key={it.kind} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Dot kind={it.kind} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function WeeklyGrid({ week, items, cycleType, getValidationFor, dragStateRef, onDrop, onNeedsHireClick, onInstructorClick, onChangeRequestClick }) {
  // Sort camps globally by (location, session-time) so they share a row across all
  // five day columns. Each row renders cells per weekday: an actual card when the
  // camp meets that day, an em-dash placeholder otherwise. A gold line separates
  // different locations.
  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const locA = a.session.location_name ?? "";
      const locB = b.session.location_name ?? "";
      if (locA !== locB) return locA.localeCompare(locB);
      const rA = SESSION_TIME_RANK[a.session.session_type] ?? 99;
      const rB = SESSION_TIME_RANK[b.session.session_type] ?? 99;
      return rA - rB;
    });
  }, [items]);

  const colorByLocation = useMemo(() => locationColorMap(sorted), [sorted]);

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: INK }}>
          Week {week?.num} <span style={{ fontWeight: 400, color: MUTED, fontSize: 13 }}>· {fmtShort(week?.starts_on)} – {fmtShort(week?.ends_on)}</span>
        </h2>
        <div style={{ fontSize: 12, color: MUTED }}>{items.length} {unitLabel(cycleType, items.length)} shown · drag an instructor chip onto another card to reassign</div>
      </div>

      {/* Day headers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, marginBottom: 8 }}>
        {WEEKDAYS.map((d) => (
          <div key={d} style={{
            fontSize: 11,
            fontWeight: 700,
            color: MUTED,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            paddingBottom: 4,
            borderBottom: `1px solid ${RULE}`,
          }}>
            {DAY_LABEL_FULL[d]}
          </div>
        ))}
      </div>

      {/* Rows */}
      {sorted.length === 0 ? (
        <div style={{
          minHeight: 80,
          border: `1px dashed ${RULE}`,
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: MUTED,
          fontSize: 14,
        }}>—</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sorted.map((e, idx) => {
            const prevLoc = idx > 0 ? sorted[idx - 1].session.location_name : null;
            const newGroup = idx > 0 && prevLoc !== e.session.location_name;
            const days = Array.isArray(e.session.class_days) ? e.session.class_days : WEEKDAYS;
            return (
              <React.Fragment key={e.session.id}>
                {newGroup && (
                  <div style={{
                    height: 0,
                    borderTop: `2px solid ${GOLD}66`,
                    margin: "4px 0",
                  }} />
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                  {WEEKDAYS.map((d) => days.includes(d) ? (
                    <ProgramCard
                      key={d}
                      item={e}
                      cardBg={colorByLocation.get(e.session.location_name) ?? LOCATION_PALETTE[0]}
                      getValidationFor={getValidationFor}
                      dragStateRef={dragStateRef}
                      onDrop={onDrop}
                      onNeedsHireClick={onNeedsHireClick}
                      onInstructorClick={onInstructorClick}
                      onChangeRequestClick={onChangeRequestClick}
                    />
                  ) : (
                    <div key={d} style={{
                      minHeight: 80,
                      border: `1px dashed ${RULE}`,
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: MUTED,
                      fontSize: 14,
                    }}>—</div>
                  ))}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProgramCard({ item, cardBg, getValidationFor, dragStateRef, onDrop, onNeedsHireClick, onInstructorClick, onChangeRequestClick }) {
  const { session, status, assignment, allAssignments, activeAssignments } = item;
  const [dropEffect, setDropEffect] = useState(null); // "ok" | "warn" | "block" | "self" | null
  const [hoverResult, setHoverResult] = useState(null); // full validation result during drag
  const isNeedsHire = status === "needs_hire";
  const isChangeRequested = status === "change_requested";
  // For change_requested cards, find the assignment that triggered it (status='change_requested')
  const changeReqAssignment = isChangeRequested
    ? activeAssignments.find((a) => a.status === "change_requested") ?? assignment
    : null;

  // Lead + developing.
  const lead = activeAssignments.find((a) => a.role === "lead") ?? null;
  const developing = activeAssignments.find((a) => a.role === "developing") ?? null;
  const wantsDeveloping = (session.current_enrollment ?? 0) >= DEVELOPING_THRESHOLD;
  const showDevelopingRow = wantsDeveloping || !!developing;
  const color = statusColor(status);
  const cdLabel = classDaysLabel(session.class_days);
  const enrollTone = enrollmentTone(session.current_enrollment);
  const enrollColor =
    enrollTone === "danger" ? CORAL :
    enrollTone === "warn" ? GOLD :
    enrollTone === "ok" ? OK_GREEN : MUTED;

  function evaluate() {
    const drag = dragStateRef.current;
    if (!drag) return { effect: null, result: null };
    if (drag.sourceSessionId === session.id) return { effect: "self", result: null };
    const srcAssignment = drag.assignment;
    if (!srcAssignment) return { effect: null, result: null };
    const result = getValidationFor(session, srcAssignment);
    if (!result.ok) return { effect: "block", result };
    if (result.warnings.length) return { effect: "warn", result };
    return { effect: "ok", result };
  }

  function onDragEnter(e) {
    e.preventDefault();
    const { effect, result } = evaluate();
    setDropEffect(effect);
    setHoverResult(result);
  }
  function onDragOver(e) {
    e.preventDefault();
    if (dropEffect == null) {
      const { effect, result } = evaluate();
      setDropEffect(effect);
      setHoverResult(result);
    }
    e.dataTransfer.dropEffect = dropEffect === "block" ? "none" : "move";
  }
  function onDragLeave() {
    setDropEffect(null);
    setHoverResult(null);
  }
  function onDropHandler(e) {
    e.preventDefault();
    setDropEffect(null);
    setHoverResult(null);
    onDrop(session);
  }

  const borderColor =
    dropEffect === "ok" ? OK_GREEN :
    dropEffect === "warn" ? GOLD :
    dropEffect === "block" ? CORAL :
    dropEffect === "self" ? MUTED :
    RULE;
  const baseBg = cardBg ?? LOCATION_PALETTE[0];
  const bgColor =
    dropEffect === "ok" ? `${OK_GREEN}33` :
    dropEffect === "warn" ? `${GOLD}33` :
    dropEffect === "block" ? `${CORAL}33` :
    baseBg;

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropHandler}
      onClick={
        isChangeRequested && onChangeRequestClick
          ? () => onChangeRequestClick(session, changeReqAssignment)
          : isNeedsHire && onNeedsHireClick
          ? () => onNeedsHireClick(session)
          : undefined
      }
      role={isNeedsHire || isChangeRequested ? "button" : undefined}
      tabIndex={isNeedsHire || isChangeRequested ? 0 : undefined}
      style={{
        position: "relative",
        background: bgColor,
        border: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: (isNeedsHire || isChangeRequested) ? "pointer" : "default",
        transition: "background 80ms ease, border-color 80ms ease",
      }}
      title={
        isChangeRequested ? "Click to review the instructor's change request" :
        isNeedsHire ? "Click to see eligible instructors" :
        undefined
      }
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
        {session.curriculum_name || "(unnamed)"}
      </div>
      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.3 }}>
        {titleCase(session.session_type)}
        {session.curriculum_category && ` · ${titleCase(session.curriculum_category)}`}
        {(session.start_time || session.end_time) && ` · ${fmtTimeRange(session.start_time, session.end_time)}`}
      </div>
      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.3 }}>{session.location_name}</div>
      {cdLabel && (
        <div style={{ fontSize: 10, color: PLUM, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
          {cdLabel}
        </div>
      )}
      {isChangeRequested && changeReqAssignment?.change_request_message && (
        <div style={{
          fontSize: 11,
          color: INK,
          background: `${CHANGE_REQ}1A`,
          border: `1px solid ${CHANGE_REQ}66`,
          borderRadius: 4,
          padding: "5px 8px",
          lineHeight: 1.35,
        }}>
          <span style={{ fontWeight: 600, color: CHANGE_REQ }}>“ </span>
          {changeReqAssignment.change_request_message.length > 60
            ? changeReqAssignment.change_request_message.slice(0, 60) + "…"
            : changeReqAssignment.change_request_message}
          <span style={{ fontWeight: 600, color: CHANGE_REQ }}> ”</span>
        </div>
      )}
      <SlotRow
        label="Lead"
        assignment={lead}
        session={session}
        role="lead"
        dragStateRef={dragStateRef}
        onClick={onInstructorClick}
      />
      {showDevelopingRow && (
        <SlotRow
          label="Developing"
          assignment={developing}
          session={session}
          role="developing"
          dragStateRef={null /* developing not draggable for now */}
          onClick={onInstructorClick}
        />
      )}
      <div style={{
        fontSize: 11,
        color: enrollColor,
        fontWeight: 600,
        textAlign: "right",
        marginTop: 4,
        whiteSpace: "nowrap",
      }}>
        {(!session.enrollment_synced_at && (session.current_enrollment ?? 0) === 0)
          ? "Enrollment TBD"
          : `${session.current_enrollment ?? 0} enrolled`}
      </div>
      {(dropEffect === "warn" || dropEffect === "block") && hoverResult && (
        <DragHoverPopup
          kind={dropEffect}
          warnings={hoverResult.warnings}
          hardBlocks={hoverResult.hardBlocks}
        />
      )}
    </div>
  );
}

function SlotRow({ label, assignment, session, role, dragStateRef, onClick, rightContent }) {
  const labelEl = (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      color: MUTED,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      flexShrink: 0,
    }}>{label}</span>
  );

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginTop: 2 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {labelEl}
        {assignment ? (
          <InstructorChip
            assignment={assignment}
            extraCount={0}
            needsHire={false}
            sourceSession={session}
            dragStateRef={dragStateRef ?? { current: null }}
            draggable={!!dragStateRef}
            onClick={onClick ? () => onClick(session, assignment) : undefined}
          />
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (onClick) onClick(session, null, role); }}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: CORAL,
              background: `${CORAL}14`,
              border: "none",
              padding: "3px 8px",
              borderRadius: 999,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Needs hire
          </button>
        )}
      </div>
      {rightContent}
    </div>
  );
}

function DragHoverPopup({ kind, warnings, hardBlocks }) {
  const isBlock = kind === "block";
  const color = isBlock ? CORAL : GOLD;
  const items = isBlock ? hardBlocks : warnings;
  return (
    <div style={{
      position: "absolute",
      left: 0,
      right: 0,
      top: "calc(100% + 4px)",
      background: "#fff",
      border: `1.5px solid ${color}`,
      borderRadius: 6,
      padding: "8px 10px",
      boxShadow: "0 6px 18px rgba(0,0,0,0.14)",
      zIndex: 20,
      pointerEvents: "none",
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginBottom: 4,
      }}>
        {isBlock ? "Blocked" : "Warnings"}
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, color: INK, fontSize: 12, lineHeight: 1.4 }}>
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}

function InstructorChip({ assignment, extraCount, needsHire, sourceSession, dragStateRef, onClick, draggable = true }) {
  if (needsHire || !assignment?.instructor_first) {
    return (
      <span style={{
        fontSize: 11,
        color: CORAL,
        fontWeight: 600,
        background: `${CORAL}14`,
        padding: "3px 8px",
        borderRadius: 999,
      }}>Needs hire</span>
    );
  }

  function onDragStart(e) {
    if (!dragStateRef) return;
    dragStateRef.current = {
      assignmentId: assignment.id,
      assignment,
      sourceSessionId: sourceSession.id,
    };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData(DRAG_MIME, assignment.id); } catch {}
  }
  function onDragEnd() {
    if (dragStateRef) dragStateRef.current = null;
  }
  function onChipClick(e) {
    e.stopPropagation();
    if (onClick) onClick();
  }

  const tentative = !!assignment.instructor_needs_confirmation;
  const accepted = assignment.status === "confirmed" && !!assignment.instructor_response_at;
  const baseTitle = draggable ? "Click to reassign · drag to move" : "Click to reassign";
  const tentativeTitle = tentative
    ? `Tentative — survey unconfirmed${assignment.instructor_notes ? `: "${assignment.instructor_notes}"` : ""}`
    : "";
  const acceptedTitle = accepted ? "Accepted by instructor" : "";

  return (
    <span
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={onChipClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={{
        fontSize: 11,
        color: INK,
        background: accepted ? `${OK_GREEN}26` : tentative ? `${GOLD}33` : CHALK,
        border: accepted ? `1px solid ${OK_GREEN}` : tentative ? `1px solid ${GOLD}` : "none",
        padding: "3px 8px",
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        cursor: onClick ? "pointer" : (draggable ? "grab" : "default"),
        userSelect: "none",
      }}
      title={[baseTitle, acceptedTitle, tentativeTitle].filter(Boolean).join(" · ")}
    >
      {draggable && <span aria-hidden="true" style={{ color: MUTED, fontSize: 10, lineHeight: 1 }}>⋮⋮</span>}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{assignment.instructor_first}</span>
      {accepted && (
        <span
          aria-hidden="true"
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: "#fff",
            background: OK_GREEN,
            borderRadius: "50%",
            width: 13,
            height: 13,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >✓</span>
      )}
      {tentative && (
        <span
          aria-hidden="true"
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: PLUM,
            background: GOLD,
            borderRadius: "50%",
            width: 13,
            height: 13,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >?</span>
      )}
      {extraCount > 0 && <span style={{ color: MUTED }}>+{extraCount}</span>}
    </span>
  );
}

function ChangeRequestReview({ session, assignment, cycle, orgName, onClose, onUnassign, onReassign }) {
  const [busy, setBusy] = useState(false);
  const firstName = assignment?.instructor_first ?? "Instructor";
  const email = assignment?.instructor_email;
  const subject = `Re: Your ${cycle?.name ?? ""} schedule — ${session.curriculum_name ?? "camp"}`;
  const body = [
    `Hi ${firstName},`,
    "",
    `Got your note about ${session.curriculum_name ?? "this camp"} (Week ${session.week_num}, ${session.location_name}).`,
    "",
    assignment?.change_request_message ? `You wrote: "${assignment.change_request_message}"` : "",
    "",
    "Wanted to talk through options — what would work best for you?",
    "",
    `— Jessica, ${orgName}`,
  ].filter(Boolean).join("\n");
  const mailto = email
    ? `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : null;

  async function doUnassign() {
    setBusy(true);
    try { await onUnassign(); } finally { setBusy(false); }
  }

  return (
    <ModalShell onClose={onClose} title="Change request">
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
            From {firstName} · Week {session.week_num}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 4 }}>
            {session.curriculum_name ?? "(unnamed)"}
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {session.location_name} · {titleCase(session.session_type)}
          </div>
        </div>

        <div style={{
          background: `${CHANGE_REQ}14`,
          border: `1px solid ${CHANGE_REQ}66`,
          borderRadius: 6,
          padding: 12,
          fontSize: 14,
          color: INK,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}>
          {assignment?.change_request_message || <em style={{ color: MUTED }}>(no message)</em>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <DialogChoice
            title={`Reassign someone else to this camp`}
            subtitle={`Open the candidate picker for ${session.curriculum_name ?? "this camp"} so you can swap ${firstName} out.`}
            onClick={onReassign}
            disabled={busy}
          />
          <DialogChoice
            title={`Unassign ${firstName} (mark Needs hire)`}
            subtitle="Removes their assignment; the slot becomes Needs hire. Undo available."
            onClick={doUnassign}
            disabled={busy}
            tone="warn"
          />
          {mailto ? (
            <a
              href={mailto}
              style={{
                ...btn("transparent", PLUM, true),
                textAlign: "left",
                padding: "10px 12px",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: PLUM }}>Email {firstName}</div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Opens your email client with a pre-filled reply at {email}.</div>
            </a>
          ) : (
            <div style={{ padding: 10, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 12, color: MUTED }}>
              No email on file for {firstName} — can't auto-compose a reply.
            </div>
          )}
        </div>
      </div>
      <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} disabled={busy} style={btn("transparent", MUTED, true)}>Close</button>
      </div>
    </ModalShell>
  );
}

function OfferDialog({ dialog, onChoose, onClose, busy, deadline, onDeadlineChange, publishedCount, onRollback, rollingBack, onRunReminders, remindersBusy }) {
  if (dialog.mode === "result" && dialog.payload?.kind === "approve") {
    return (
      <ModalShell onClose={onClose} title="Approved">
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.5 }}>
          {dialog.payload.count} assignment{dialog.payload.count === 1 ? "" : "s"} flipped from <em>proposed</em> to <em>confirmed</em>.
          You can now send offers.
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PLUM, "#fff")}>OK</button>
        </div>
      </ModalShell>
    );
  }
  if (dialog.mode === "result" && dialog.payload?.kind === "send") {
    const p = dialog.payload;
    // Only Real Send needs the roll-back escape hatch — Test is non-destructive.
    const showRollback = p.sent === 0 && p.mode === "send" && publishedCount > 0;
    return (
      <ModalShell onClose={onClose} title={p.mode === "send" ? "Offers sent" : p.mode === "test" ? "Sent to you" : "Preview"}>
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55 }}>
          {p.note ? <div style={{ color: MUTED, marginBottom: 8 }}>{p.note}</div> : null}
          <div><strong>{p.sent}</strong> email{p.sent === 1 ? "" : "s"} delivered.</div>
          {p.failed && p.failed.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, color: CORAL, marginBottom: 4 }}>Failures ({p.failed.length}):</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: MUTED, fontSize: 12 }}>
                {p.failed.map((f, i) => <li key={i}>{f.instructor_id.slice(0, 8)}… — {f.reason}</li>)}
              </ul>
            </div>
          )}
          {p.mode === "test" && p.sent > 0 && (
            <div style={{ marginTop: 12, padding: 10, background: `${GOLD}1A`, borderRadius: 6, fontSize: 12, color: INK }}>
              All emails went to <strong>jessica@journeytosteam.com</strong> only — your instructors didn't receive anything. Check your inbox.
            </div>
          )}
          {showRollback && (
            <div style={{ marginTop: 14, padding: 12, background: `${GOLD}1A`, border: `1px solid ${GOLD}66`, borderRadius: 6 }}>
              <div style={{ fontSize: 13, color: INK, marginBottom: 8 }}>
                <strong>{publishedCount}</strong> {publishedCount === 1 ? "instructor has" : "instructors have"} already been sent their offer. If you need to send again (after fixing something), reset them here first.
              </div>
              <button
                type="button"
                onClick={onRollback}
                disabled={rollingBack}
                style={{ ...btn(GOLD, INK, false, rollingBack), padding: "7px 12px", fontSize: 13 }}
              >
                {rollingBack ? "Resetting…" : `Reset ${publishedCount} already-sent ${publishedCount === 1 ? "offer" : "offers"}`}
              </button>
            </div>
          )}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PLUM, "#fff")}>Close</button>
        </div>
      </ModalShell>
    );
  }

  if (dialog.mode === "reminders_choose") {
    return (
      <ModalShell onClose={onClose} title="Reminders + deadline check">
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ color: MUTED }}>
            Runs two passes against your active cycle:
            <br />• Sends a reminder email to any instructor whose deadline is 2–4 days away and who hasn't responded yet
            <br />• Flags anyone whose deadline has already passed (the card turns Flagged in your calendar — no email)
          </div>
          <DialogChoice
            title="Preview (no emails, no flags)"
            subtitle="Shows you which instructors would get a reminder and how many camps would be flagged. Nothing changes."
            disabled={remindersBusy}
            onClick={() => onRunReminders(true)}
          />
          <DialogChoice
            title="Run it for real"
            subtitle="Sends reminder emails to non-responders and flags expired offers in your calendar."
            disabled={remindersBusy}
            onClick={() => onRunReminders(false)}
            tone="warn"
          />
          {remindersBusy && <div style={{ color: MUTED, fontSize: 12 }}>Working…</div>}
        </div>
      </ModalShell>
    );
  }

  if (dialog.mode === "result" && dialog.payload?.kind === "reminders") {
    const p = dialog.payload;
    const sent = p.reminder_results?.filter((r) => r.sent).length ?? 0;
    const wouldSend = p.reminder_results?.filter((r) => r.reason === "dry_run").length ?? 0;
    return (
      <ModalShell onClose={onClose} title={p.dry_run ? "Reminders preview" : "Reminders sent"}>
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55 }}>
          {p.dry_run ? (
            <>
              <div><strong>{wouldSend}</strong> instructor{wouldSend === 1 ? "" : "s"} would get a reminder email.</div>
              <div style={{ marginTop: 6 }}><strong>{p.expired_count}</strong> assignment{p.expired_count === 1 ? "" : "s"} would be flagged as past-deadline.</div>
            </>
          ) : (
            <>
              <div><strong>{sent}</strong> reminder email{sent === 1 ? "" : "s"} delivered.</div>
              <div style={{ marginTop: 6 }}><strong>{p.expired_count}</strong> assignment{p.expired_count === 1 ? "" : "s"} flagged as past-deadline.</div>
            </>
          )}
          {p.reminder_results && p.reminder_results.length > 0 && (
            <ul style={{ marginTop: 12, paddingLeft: 18, color: MUTED, fontSize: 12 }}>
              {p.reminder_results.map((r, i) => (
                <li key={i}>{r.email ?? r.instructor_id.slice(0, 8)} — {r.sent ? "sent" : r.reason}</li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PLUM, "#fff")}>Close</button>
        </div>
      </ModalShell>
    );
  }

  if (dialog.mode === "result" && dialog.payload?.kind === "rollback") {
    return (
      <ModalShell onClose={onClose} title="Reset">
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55 }}>
          <strong>{dialog.payload.count}</strong> {dialog.payload.count === 1 ? "offer is" : "offers are"} ready to be sent again. Distance bonuses are still there. Click <strong>Send offers</strong> when you're ready.
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PLUM, "#fff")}>OK</button>
        </div>
      </ModalShell>
    );
  }

  // mode === "choose"
  return (
    <ModalShell onClose={onClose} title="Send offers">
      <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ color: MUTED }}>
          Pick the date you want instructors to respond by, then choose how to send.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, background: "#fff" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5 }}>Respond by</span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => onDeadlineChange(e.target.value)}
            style={{ flex: 1, padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }}
          />
        </label>
        <DialogChoice
          title="Send to me first (recommended)"
          subtitle="Every instructor's offer arrives in your inbox so you can read exactly what they'll see. Nothing else changes — run this as many times as you want."
          disabled={busy}
          onClick={() => onChoose("test")}
          tone="warn"
        />
        <DialogChoice
          title="Send to all instructors"
          subtitle="Delivers each instructor's offer to their real email. They'll show on this page as awaiting response. Re-sending won't email anyone who's already received their offer."
          disabled={busy}
          onClick={() => onChoose("send")}
          tone="danger"
        />
        {busy && <div style={{ color: MUTED, fontSize: 12 }}>Working…</div>}
      </div>
    </ModalShell>
  );
}

function PreviewViewer({ data, onClose }) {
  const previews = data?.preview ?? [];
  const [idx, setIdx] = useState(0);
  if (previews.length === 0) {
    return (
      <ModalShell onClose={onClose} title="Preview">
        <div style={{ padding: 20, color: MUTED, fontSize: 14 }}>
          {data?.note ?? "No confirmed assignments to preview yet. Click Approve first."}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PLUM, "#fff")}>Close</button>
        </div>
      </ModalShell>
    );
  }
  const cur = previews[idx];
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%",
        maxWidth: 900,
        height: "85vh",
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${RULE}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
              Preview {idx + 1} of {previews.length} · {cur?.to}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: INK, marginTop: 2 }}>{cur?.subject}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} style={btn("transparent", PLUM, true, idx === 0)}>‹ Prev</button>
            <button type="button" onClick={() => setIdx((i) => Math.min(previews.length - 1, i + 1))} disabled={idx === previews.length - 1} style={btn("transparent", PLUM, true, idx === previews.length - 1)}>Next ›</button>
            <button type="button" onClick={onClose} style={btn(PLUM, "#fff")}>Close</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "hidden", background: CHALK, padding: 0 }}>
          <iframe
            title="Offer preview"
            srcDoc={cur?.html ?? ""}
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          />
        </div>
      </div>
    </div>
  );
}

function DialogChoice({ title, subtitle, onClick, disabled, tone }) {
  const border = tone === "danger" ? CORAL : tone === "warn" ? GOLD : RULE;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        textAlign: "left",
        background: "#fff",
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: "10px 12px",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{title}</div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{subtitle}</div>
    </button>
  );
}

function ModalShell({ title, children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%",
        maxWidth: 480,
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
      }}>
        <div style={{
          padding: "14px 20px",
          borderBottom: `1px solid ${RULE}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", fontSize: 22, color: MUTED, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CandidatePicker({
  session, currentAssignment, role = "lead", instructors, availabilityByInstructor,
  locPrefLookup, curPrefLookup, allAssignments,
  onClose, onPick, onRemove, onResetAcceptance, onCreateInstructor,
}) {
  const isReassign = !!currentAssignment;
  const currentInstructorId = currentAssignment?.instructor_id ?? null;
  // Same person can't be both lead and developing of the same camp.
  const otherRoleInstructorId = useMemo(() => {
    const otherRole = role === "lead" ? "developing" : "lead";
    const found = allAssignments.find((a) =>
      a.status !== "withdrawn" && a.session.id === session.id && a.role === otherRole
    );
    return found?.instructor_id ?? null;
  }, [allAssignments, session.id, role]);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ firstName: "", lastName: "", email: "", confirmed: false });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const candidates = useMemo(() => {
    const out = [];
    for (const inst of instructors) {
      if (inst.id === currentInstructorId) continue; // skip the one already assigned
      if (inst.id === otherRoleInstructorId) continue; // can't be both roles on same camp
      const avail = availabilityByInstructor.get(inst.id);
      if (!avail) continue;
      const sessionTypes = avail.session_types ?? [];
      const availableWeeks = avail.available_weeks ?? [];
      if (!availableWeeks.includes(session.week_num)) continue;
      if (session.session_type && !sessionTypes.includes(session.session_type)) continue;
      const conflict = allAssignments.find((a) =>
        a.status !== "withdrawn" &&
        a.id !== currentAssignment?.id &&
        a.instructor_id === inst.id &&
        a.session.week_num === session.week_num &&
        a.session.id !== session.id &&
        classDaysOverlap(a.session.class_days ?? WEEKDAYS, session.class_days ?? WEEKDAYS) &&
        sessionTimeOverlap(a.session.session_type, session.session_type)
      );
      if (conflict) continue;

      const locPref = locPrefLookup.get(`${inst.id}|${session.location_name}`);
      const curPref = curPrefLookup.get(`${inst.id}|${session.curriculum_category}`);
      const warningsForBanner = [];
      if (locPref === "not_preferred") warningsForBanner.push(`${inst.first_name} marked ${session.location_name} as not preferred.`);
      if (curPref === "not_preferred") warningsForBanner.push(`${inst.first_name} marked ${titleCase(session.curriculum_category)} as not preferred.`);
      if (session.enrollment_synced_at && session.current_enrollment != null && session.current_enrollment < MIN_ENROLLMENT) warningsForBanner.push(`Enrollment is ${session.current_enrollment} — below the ${MIN_ENROLLMENT}-student minimum.`);
      if (sessionTypes.includes("full_day") && (session.session_type === "morning" || session.session_type === "afternoon")) warningsForBanner.push(`${inst.first_name} is reserved for full-day work.`);
      if (avail.needs_confirmation) warningsForBanner.push(`${inst.first_name}'s availability is unconfirmed.`);

      let score = 0;
      if (locPref === "preferred") score += 2;
      if (curPref === "preferred") score += 2;
      if (locPref === "not_preferred") score -= 1;
      if (curPref === "not_preferred") score -= 1;
      if (avail.needs_confirmation) score -= 0.5;

      out.push({ instructor: inst, score, locPref, curPref, fullDayCapable: sessionTypes.includes("full_day"), needsConfirmation: !!avail.needs_confirmation, warningsForBanner });
    }
    return out.sort((a, b) => b.score - a.score);
  }, [session, currentAssignment, currentInstructorId, otherRoleInstructorId, instructors, availabilityByInstructor, locPrefLookup, curPrefLookup, allAssignments]);

  async function submitNewInstructor() {
    if (!addForm.firstName.trim()) {
      setAddError("First name is required.");
      return;
    }
    if (!addForm.email.trim()) {
      setAddError("Email is required.");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addForm.email.trim())) {
      setAddError("Please enter a valid email address.");
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      await onCreateInstructor(addForm);
    } catch (err) {
      setAddError(err.message ?? "Couldn't create instructor.");
      setAddBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "85vh",
          overflow: "hidden",
          background: "#fff",
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${RULE}`,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}>
          <div>
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
              {isReassign ? "Reassign" : "Assign"} {role === "developing" ? "developing" : "lead"} · Week {session.week_num}
            </div>
            <h2 style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 700, color: INK }}>
              {session.curriculum_name || "(unnamed)"}
            </h2>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
              {titleCase(session.session_type)} · {session.location_name}
              {(session.start_time || session.end_time) && ` · ${fmtTimeRange(session.start_time, session.end_time)}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 22,
              color: MUTED,
              cursor: "pointer",
              lineHeight: 1,
              padding: 4,
            }}
          >×</button>
        </div>

        {isReassign && (
          <div style={{
            padding: "10px 20px",
            background: CHALK,
            borderBottom: `1px solid ${RULE}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}>
            <div style={{ fontSize: 13, color: INK }}>
              Currently: <strong>{currentAssignment.instructor_first}{currentAssignment.instructor_last ? " " + currentAssignment.instructor_last : ""}</strong>
              {currentAssignment.status === "confirmed" && currentAssignment.instructor_response_at && (
                <span style={{ marginLeft: 8, fontSize: 11, color: OK_GREEN, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>✓ Accepted</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {currentAssignment.status === "confirmed" && currentAssignment.instructor_response_at && onResetAcceptance && (
                <button
                  type="button"
                  onClick={onResetAcceptance}
                  title="Set back to 'awaiting response' (use this to clear a test-accept you made via Admin preview)"
                  style={{ ...btn("transparent", GOLD, true), padding: "5px 10px", fontSize: 12, borderColor: GOLD }}
                >
                  Reset acceptance
                </button>
              )}
              <button
                type="button"
                onClick={onRemove}
                style={{ ...btn("transparent", CORAL, true), padding: "5px 10px", fontSize: 12 }}
              >
                Remove (mark needs hire)
              </button>
            </div>
          </div>
        )}

        <div style={{ overflowY: "auto", padding: 12, flex: 1 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600, padding: "4px 4px 8px" }}>
            Eligible instructors
          </div>
          {candidates.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: MUTED, fontSize: 13 }}>
              No eligible instructors. Check that the team has completed availability surveys and supports this session type — or add a new instructor below.
            </div>
          ) : (
            candidates.map(({ instructor, locPref, curPref, fullDayCapable, needsConfirmation, warningsForBanner }) => (
              <div key={instructor.id} style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                marginBottom: 6,
                gap: 10,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                    {instructor.first_name} {instructor.last_name ?? ""}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {locPref === "preferred" && <Badge color={OK_GREEN}>Prefers location</Badge>}
                    {curPref === "preferred" && <Badge color={OK_GREEN}>Prefers curriculum</Badge>}
                    {locPref === "not_preferred" && <Badge color={GOLD}>Location: not preferred</Badge>}
                    {curPref === "not_preferred" && <Badge color={GOLD}>Curriculum: not preferred</Badge>}
                    {fullDayCapable && (session.session_type === "morning" || session.session_type === "afternoon") && <Badge color={GOLD}>Full-day capable</Badge>}
                    {needsConfirmation && <Badge color={GOLD}>Unconfirmed availability</Badge>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onPick(instructor.id, warningsForBanner)}
                  style={{ ...btn(PLUM, "#fff"), padding: "7px 12px", fontSize: 13 }}
                >
                  {isReassign ? "Reassign" : "Assign"}
                </button>
              </div>
            ))
          )}
        </div>

        <div style={{ borderTop: `1px solid ${RULE}`, padding: "10px 14px" }}>
          {!addOpen ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{ ...btn("transparent", PLUM, true), width: "100%", padding: "8px 12px", fontSize: 13 }}
            >
              + Add new instructor
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: MUTED }}>
                Creates the instructor and assigns them to this slot only. Their availability survey will be marked pending.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  placeholder="First name *"
                  value={addForm.firstName}
                  onChange={(e) => setAddForm((f) => ({ ...f, firstName: e.target.value }))}
                  style={pickerInputStyle}
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="Last name"
                  value={addForm.lastName}
                  onChange={(e) => setAddForm((f) => ({ ...f, lastName: e.target.value }))}
                  style={pickerInputStyle}
                />
              </div>
              <input
                type="email"
                placeholder="Email *"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                style={pickerInputStyle}
              />
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: INK, cursor: "pointer", lineHeight: 1.4 }}>
                <input
                  type="checkbox"
                  checked={addForm.confirmed}
                  onChange={(e) => setAddForm((f) => ({ ...f, confirmed: e.target.checked }))}
                  style={{ marginTop: 2 }}
                />
                <span>I can confirm this person is available for this slot (skip the "survey pending" warning).</span>
              </label>
              {addError && <div style={{ color: CORAL, fontSize: 12 }}>{addError}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => { setAddOpen(false); setAddForm({ firstName: "", lastName: "", email: "", confirmed: false }); setAddError(""); }}
                  disabled={addBusy}
                  style={{ ...btn("transparent", MUTED, true), padding: "6px 12px", fontSize: 13 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitNewInstructor}
                  disabled={addBusy || !addForm.firstName.trim() || !addForm.email.trim()}
                  style={{ ...btn(PLUM, "#fff", false, addBusy), padding: "6px 12px", fontSize: 13 }}
                >
                  {addBusy ? "Adding…" : "Add & Assign"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const pickerInputStyle = {
  flex: 1,
  minWidth: 0,
  padding: "7px 10px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
  color: INK,
  background: "#fff",
};

function Badge({ color, children }) {
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 600,
      color,
      background: `${color}1A`,
      padding: "2px 8px",
      borderRadius: 999,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    }}>{children}</span>
  );
}

function Empty({ title, body, tone }) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${tone === "error" ? CORAL : RULE}`,
      borderRadius: 8,
      padding: 28,
      maxWidth: 520,
    }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: INK, margin: "0 0 6px" }}>{title}</h2>
      <p style={{ color: MUTED, fontSize: 14, margin: 0, lineHeight: 1.5 }}>{body}</p>
    </div>
  );
}

function btn(bg, fg, outlined = false, disabled = false) {
  return {
    display: "inline-block",
    padding: "8px 14px",
    background: bg,
    color: fg,
    border: outlined ? `1px solid ${fg}` : "none",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "inherit",
    textDecoration: "none",
    opacity: disabled ? 0.55 : 1,
  };
}
