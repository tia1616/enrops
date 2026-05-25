// src/pages/admin/Schedule.jsx
// Scheduling Calendar UI — header strip, filter bar, term overview, weekly grid,
// instructor drag-and-drop with hard-block + loud-warning validation.
// Edit drawer + send-offers + multi-week occurrence modal land in follow-up passes.
// Multi-tenant: all data RLS-scoped by org.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { defaultTenantSlug } from "../../lib/tenants.js";
import HatGuide from "../../components/HatGuide";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
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
        flagged_reason: a.flagged_reason ?? null,
      };
    }
  }
  if (best.status === "change_requested") return "change_requested";
  // Published rows past the deadline are auto-flagged by the expire pass.
  if (best.flagged_reason) return "flagged";
  if (Array.isArray(best.flags) && best.flags.length > 0) return "flagged";
  // Instructor has actively accepted = confirmed + a response timestamp.
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

// Morning at location A + afternoon at location B on the same day is physically
// impossible (the instructor would need to teleport between sites mid-day). Same
// location is fine — back-to-back at one school is normal. Catches the "Skyler
// already does afternoons in Forest Grove, don't offer her mornings in Portland"
// case that sessionTimeOverlap alone would miss.
function sameDayDifferentLocationConflict(existing, target) {
  if (!existing || !target) return false;
  if (existing.location_name === target.location_name) return false;
  const a = existing.session_type, b = target.session_type;
  if ((a === "morning" && b === "afternoon") || (a === "afternoon" && b === "morning")) return true;
  return false;
}

// Whether an instructor's surveyed session_types covers a target camp's session_type.
// "full_day" availability implies they can do morning OR afternoon halves too — they
// said they're free all day, so we can still offer them a half. (Not the other way:
// a morning-only instructor can't cover a full_day camp.) Admin gets a soft warning
// at drop time so they know they're filling a half slot for someone reserved for full.
function instructorCoversSessionType(sessionTypes, sessionType) {
  if (!sessionType) return true;
  if (sessionTypes.includes(sessionType)) return true;
  if (sessionTypes.includes("full_day") && (sessionType === "morning" || sessionType === "afternoon")) return true;
  return false;
}

// validateDrop returns { ok: boolean, hardBlocks: [msg], warnings: [msg] }.
// `srcAssignmentId` is excluded from double-booking checks because it's the row being moved.
// `srcRole` preserves lead-vs-developing on drop and gates developing → low-enrollment camps.
function validateDrop({
  instructor, availability, locPref, curPref,
  targetSession, otherAssignments, srcAssignmentId, srcRole,
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
  if (!instructorCoversSessionType(sessionTypes, targetSession.session_type)) {
    hardBlocks.push(`${firstName} doesn't work ${titleCase(targetSession.session_type)} sessions.`);
  }
  // Developing instructors can only land on camps that have a developing slot —
  // either enrollment ≥ threshold or an existing developing assignment to swap into.
  if (srcRole === "developing") {
    const targetHasDevSlot = (targetSession.current_enrollment ?? 0) >= DEVELOPING_THRESHOLD;
    const targetHasDevAssignment = otherAssignments.some(
      (a) => a.camp_session_id === targetSession.id
        && a.role === "developing"
        && a.status !== "withdrawn"
        && a.id !== srcAssignmentId
    );
    if (!targetHasDevSlot && !targetHasDevAssignment) {
      hardBlocks.push(`${firstName} is a developing instructor — this camp doesn't have a developing slot yet (needs ${DEVELOPING_THRESHOLD}+ enrolled).`);
    }
  }
  // Double-booking — class_days-aware AND session-time-aware (morning+afternoon don't conflict).
  // Also catches morning+afternoon at DIFFERENT locations on the same day (impossible travel).
  const conflicts = otherAssignments.filter((a) =>
    a.id !== srcAssignmentId &&
    a.status !== "withdrawn" &&
    a.instructor_id === instructor?.id &&
    a.session.week_num === targetSession.week_num &&
    a.session.id !== targetSession.id &&
    classDaysOverlap(a.session.class_days ?? WEEKDAYS, targetSession.class_days ?? WEEKDAYS) &&
    (sessionTimeOverlap(a.session.session_type, targetSession.session_type) ||
     sameDayDifferentLocationConflict(a.session, targetSession))
  );
  if (conflicts.length) {
    const c = conflicts[0].session;
    if (sessionTimeOverlap(c.session_type, targetSession.session_type)) {
      hardBlocks.push(`${firstName} would be double-booked: also on ${c.location_name} (${c.session_type}) week ${c.week_num}.`);
    } else {
      hardBlocks.push(`${firstName} already has a ${c.session_type} camp at ${c.location_name} that week — they can't be in two locations on the same day.`);
    }
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
  const [autoReminders, setAutoReminders] = useState(true);
  const [lastOp, setLastOp] = useState(null); // { type, ... } — supports a single-step undo
  const [candidatesFor, setCandidatesFor] = useState(null); // { session, currentAssignment | null }
  const [changeRequestFor, setChangeRequestFor] = useState(null); // { session, assignment }
  // When user reassigns from a change-request modal, we stash the request's id so the
  // candidate-picker's onPick can auto-advance to the next change request afterward.
  const [reassigningChangeRequestId, setReassigningChangeRequestId] = useState(null);
  const [emailActivityOpen, setEmailActivityOpen] = useState(false);
  const [newCycleOpen, setNewCycleOpen] = useState(false);
  // Open-survey dialog state. mode 'choose' shows the preview/test/send buttons +
  // optional deadline picker; mode 'result' shows the send outcome.
  const [surveyDialog, setSurveyDialog] = useState(null); // { mode: 'choose' | 'result', payload: any }
  const [surveyDeadline, setSurveyDeadline] = useState(() => businessDaysFromToday(10));
  // Term/cycle picker — list of all non-archived cycles for this org + the currently
  // viewed one. selectedCycleId=null means "use the latest one I find" (default).
  const [allCycles, setAllCycles] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState(() => new Set()); // assignment ids that flashed via realtime

  const dragStateRef = useRef(null);
  // stateRef mirrors the latest state so async callbacks can read post-DB-update assignments
  // without going through stale closures.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  // IDs the admin has chosen to skip during this change-request walk. Cleared when a
  // walk starts (Hat click or calendar-card click) so skipped items resurface next time.
  const skippedThisWalkRef = useRef(new Set());

  async function loadAll() {
    if (!org?.id) return;
    try {
      // Fetch every non-archived cycle so the term picker has a complete list,
      // then choose which one to load: explicit selectedCycleId wins, else the
      // most recently created cycle.
      const { data: cyclesList, error: cyclesErr } = await supabase
        .from("scheduling_cycles")
        .select("id, name, cycle_type, starts_on, ends_on, status, weeks, auto_reminders_enabled, availability_survey_opened_at, survey_deadline")
        .eq("organization_id", org.id)
        .neq("status", "archived")
        .order("starts_on", { ascending: false, nullsFirst: false });
      if (cyclesErr) throw cyclesErr;
      setAllCycles(cyclesList ?? []);
      if (!cyclesList || cyclesList.length === 0) { setState({ status: "empty" }); return; }
      const cycle = selectedCycleId
        ? (cyclesList.find((c) => c.id === selectedCycleId) ?? cyclesList[0])
        : cyclesList[0];

      const sessionsRes = await supabase
        .from("camp_sessions")
        .select("id, location_name, week_num, session_type, curriculum_category, curriculum_name, start_time, end_time, current_enrollment, enrollment_synced_at, class_days, status")
        .eq("cycle_id", cycle.id)
        .eq("status", "active")
        .order("location_name", { ascending: true });
      if (sessionsRes.error) throw sessionsRes.error;
      const sessions = sessionsRes.data ?? [];
      const sessionIds = sessions.map((s) => s.id);

      const [assignmentsRes, instructorsRes, availabilityRes, locPrefRes, curPrefRes, declinesRes] = await Promise.all([
        sessionIds.length
          ? supabase
              .from("camp_assignments")
              .select("id, camp_session_id, status, role, change_request_message, distance_bonus_cents, flags, instructor_response_at, flagged_reason, email_sent_at, instructor:instructors(id, first_name, last_name, email)")
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
        supabase
          .from("session_declined_instructors")
          .select("camp_session_id, instructor_id, reason")
          .eq("cycle_id", cycle.id),
      ]);
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (instructorsRes.error) throw instructorsRes.error;
      if (availabilityRes.error) throw availabilityRes.error;
      if (locPrefRes.error) throw locPrefRes.error;
      if (curPrefRes.error) throw curPrefRes.error;
      if (declinesRes.error) throw declinesRes.error;

      const assignments = (assignmentsRes.data ?? []).map((a) => ({
        id: a.id,
        camp_session_id: a.camp_session_id,
        status: a.status,
        role: a.role,
        change_request_message: a.change_request_message ?? null,
        distance_bonus_cents: a.distance_bonus_cents ?? null,
        flags: Array.isArray(a.flags) ? a.flags : [],
        instructor_response_at: a.instructor_response_at ?? null,
        flagged_reason: a.flagged_reason ?? null,
        email_sent_at: a.email_sent_at ?? null,
        instructor_id: a.instructor?.id ?? null,
        instructor_first: a.instructor?.first_name ?? null,
        instructor_last: a.instructor?.last_name ?? null,
        instructor_email: a.instructor?.email ?? null,
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
        declines: declinesRes.data ?? [],
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
  }, [org?.id, selectedCycleId]);

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
          // Flash the card for ~2s so the admin notices a fresh response.
          if (row.id) {
            setRecentlyUpdated((prev) => {
              const next = new Set(prev);
              next.add(row.id);
              return next;
            });
            setTimeout(() => {
              setRecentlyUpdated((prev) => {
                if (!prev.has(row.id)) return prev;
                const next = new Set(prev);
                next.delete(row.id);
                return next;
              });
            }, 2200);
          }
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
              flags: Array.isArray(payload.new.flags) ? payload.new.flags : [],
              instructor_response_at: payload.new.instructor_response_at ?? null,
              instructor_id: payload.new.instructor_id,
              // Realtime payloads don't include joined data — preserve our prior
              // instructor name/email if we already have it, else they'll show up
              // on the next full loadAll().
              instructor_first: s.assignments.find((a) => a.id === payload.new.id)?.instructor_first ?? null,
              instructor_last: s.assignments.find((a) => a.id === payload.new.id)?.instructor_last ?? null,
              instructor_email: s.assignments.find((a) => a.id === payload.new.id)?.instructor_email ?? null,
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
  // declinedBySession: sessionId → Set<instructorId> that previously turned this camp
  // down (status=change_requested at time of admin remove). Picker filters these out.
  const declinedBySession = useMemo(() => {
    if (state.status !== "ready") return new Map();
    const m = new Map();
    for (const d of state.declines ?? []) {
      if (!m.has(d.camp_session_id)) m.set(d.camp_session_id, new Set());
      m.get(d.camp_session_id).add(d.instructor_id);
    }
    return m;
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
    if (state.status !== "ready") return { assigned: 0, accepted: 0, flagged: 0, changeRequested: 0, needsHire: 0, activeInstructors: 0 };
    // Per-assignment counters — each lead and developing row counts independently so
    // an accepted lead + awaiting developing reads as 1 accepted + 1 assigned, not 1 accepted.
    let assigned = 0, accepted = 0, flagged = 0, changeRequested = 0;
    for (const a of state.assignments) {
      if (a.status === "withdrawn") continue;
      if (a.status === "change_requested") { changeRequested++; continue; }
      if (a.flagged_reason || (Array.isArray(a.flags) && a.flags.length > 0)) { flagged++; continue; }
      if (a.status === "confirmed" && a.instructor_response_at) { accepted++; continue; }
      assigned++;
    }
    // Needs-hire stays session-level: it's the count of camps with no active assignments.
    let needsHire = 0;
    if (enriched) {
      for (const e of enriched.values()) {
        if (e.status === "needs_hire") needsHire++;
      }
    }
    return { assigned, accepted, flagged, changeRequested, needsHire, activeInstructors: state.instructors.length };
  }, [state, enriched]);

  // Instructor Hat — "what should I do next?" tips surfaced above the calendar.
  // v1 is deterministic: collects all relevant tips and stacks them in priority order.
  // Per platform principle: max 5 on deck (we currently only have ~4 possible tips).
  // Translate raw cycle.status + assignment-state into a human-friendly phase
  // label for the header chip. Maps to the workflow stage the admin is actually in.
  const derivedPhase = useMemo(() => {
    if (state.status !== "ready") return "";
    const status = state.cycle.status;
    if (status === "collecting") return "Collecting surveys";
    const A = state.assignments;
    const anyProposed = A.some((a) => a.status === "proposed");
    const anyConfirmed = A.some((a) => a.status === "confirmed");
    const anyPublished = A.some((a) => a.status === "published");
    const anyAwaiting = A.some((a) => a.status === "published" && !a.instructor_response_at);
    if (anyProposed && !anyConfirmed && !anyPublished) return "Building draft";
    if (anyConfirmed && !anyPublished) return "Ready to send";
    if (anyAwaiting) return "Awaiting responses";
    if (anyPublished) return "All responses in";
    return status;
  }, [state]);

  // Forecast for the next reminder fire: groups awaiting-response rows by their
  // deadline-minus-3-days fire date, returns the soonest. Lets admin see "May 22
  // → 3 instructors" without invoking the cron.
  const nextRemindersForecast = useMemo(() => {
    if (state.status !== "ready") return null;
    function addDays(iso, days) {
      const d = new Date(`${iso}T00:00:00`);
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const pending = state.assignments.filter(
      (a) => a.status === "published"
        && !a.reminder_sent_at
        && a.email_sent_at
        && a.deadline
        && !a.instructor_response_at
        && a.status !== "withdrawn"
    );
    if (pending.length === 0) return null;
    const buckets = new Map();
    for (const a of pending) {
      const computed = addDays(a.deadline, -3);
      const fire = computed < todayIso ? todayIso : computed;
      if (!buckets.has(fire)) buckets.set(fire, { instructors: new Set(), camps: 0 });
      const b = buckets.get(fire);
      b.instructors.add(a.instructor_id);
      b.camps += 1;
    }
    const next = [...buckets.keys()].sort()[0];
    const b = buckets.get(next);
    return { fireDate: next, instructorCount: b.instructors.size, campCount: b.camps };
  }, [state]);

  const nextTips = useMemo(() => {
    if (state.status !== "ready") return [];
    const cycleId = state.cycle.id;
    const tips = [];

    // Tip 0 (highest priority): availability survey hasn't been released yet.
    // Fires before anything else because no instructor work happens until the
    // survey goes out. Hides itself once availability_survey_opened_at is set.
    if (!state.cycle.availability_survey_opened_at && state.instructors.length > 0) {
      const n = state.instructors.length;
      tips.push({
        key: `${cycleId}.openSurvey`,
        message: `Ready to ask instructors when they can work this ${cycleDisplayName(state.cycle.name)}? Releasing the survey emails ${n} active instructor${n === 1 ? "" : "s"} a link to fill it out.`,
        primary: {
          label: `Open survey · ${n} recipient${n === 1 ? "" : "s"}`,
          onClick: () => setSurveyDialog({ mode: "choose", payload: null }),
        },
      });
    }

    // Has the initial bulk send happened yet? If any row has email_sent_at, yes.
    // Used to distinguish "first-time bulk send" from "patch a few rows after bulk."
    const anyEmailed = state.assignments.some((a) => a.email_sent_at);

    // Tip A: pending unsent offers — fires once bulk send has happened and there
    // are rows the admin assigned afterward (the Skyler case).
    const pending = state.assignments.filter(
      (a) => a.instructor_id && !a.email_sent_at && a.status !== "withdrawn"
    );
    if (anyEmailed && pending.length > 0) {
      const sample = pending[0];
      const sampleSession = state.sessions.find((s) => s.id === sample.camp_session_id);
      const who = sample.instructor_first || "An instructor";
      const what = sampleSession
        ? `${sampleSession.curriculum_name} at ${sampleSession.location_name}`
        : "their new camp";
      const distinctInstructors = new Set(pending.map((a) => a.instructor_id)).size;
      const lead = pending.length === 1
        ? `${who} got assigned to ${what} but hasn't been emailed yet.`
        : `${pending.length} new assignments haven't been emailed yet (${distinctInstructors} instructor${distinctInstructors === 1 ? "" : "s"}).`;
      const loading = busy === "patching";
      const label = loading
        ? "Loading preview…"
        : (pending.length === 1 ? `Preview the offer for ${who}` : `Preview ${distinctInstructors} pending email${distinctInstructors === 1 ? "" : "s"}`);
      tips.push({
        key: `${cycleId}.pendingPatches`,
        message: `${lead} Want to review what would be sent?`,
        primary: { label, disabled: loading, onClick: () => handlePreviewPatchOffers(pending.map((a) => a.id)) },
      });
    }

    // Tip B: change requests waiting for review.
    if (counts.changeRequested > 0) {
      const first = state.assignments.find((a) => a.status === "change_requested");
      const firstSession = first ? state.sessions.find((s) => s.id === first.camp_session_id) : null;
      const n = counts.changeRequested;
      tips.push({
        key: `${cycleId}.changeRequest`,
        message: n === 1
          ? `${first?.instructor_first ?? "An instructor"} asked to swap their schedule. Want to review the request?`
          : `${n} instructors asked to swap their schedule. Want to review the requests?`,
        primary: {
          label: n === 1 ? "Review change request" : `Review ${n} change requests`,
          onClick: () => {
            if (firstSession && first) {
              skippedThisWalkRef.current = new Set();
              setFocusedWeek(firstSession.week_num);
              setChangeRequestFor({ session: firstSession, assignment: first });
            }
          },
        },
      });
    }

    // Tip C: first-time bulk send — only fires when NOTHING has been emailed yet.
    if (!anyEmailed && counts.assigned + counts.accepted > 0) {
      const total = counts.assigned + counts.accepted;
      tips.push({
        key: `${cycleId}.bulkSend`,
        message: `${total} camp${total === 1 ? "" : "s"} ${total === 1 ? "is" : "are"} ready to send out to instructors. Want to send all the offers now?`,
        primary: {
          label: "Send offers",
          onClick: () => setOfferDialog({ mode: "choose", payload: null }),
        },
      });
    }

    // Tip D: celebration only when bulk send happened and nothing else is pending.
    if (
      tips.length === 0 &&
      anyEmailed &&
      counts.flagged === 0 &&
      counts.needsHire === 0
    ) {
      tips.push({
        key: null,
        celebrate: true,
        message: "Everything's responded to. Cycle's locked in. ✨",
      });
    }

    return tips;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, counts, busy]);

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
  if (state.status === "empty") return (
    <>
      <Empty
        title="No active cycle yet"
        body="A scheduling cycle is one term of camps or classes (e.g. SU26, FA26). Create one to start matching instructors to programs."
        action={{ label: "+ Create your first cycle", onClick: () => setNewCycleOpen(true) }}
      />
      {newCycleOpen && (
        <NewCycleModal
          orgId={org?.id}
          onClose={() => setNewCycleOpen(false)}
          onCreated={(newId) => { setNewCycleOpen(false); setSelectedCycleId(newId); }}
        />
      )}
    </>
  );
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
      srcRole: srcAssignment.role ?? "lead",
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
    // Preserve role on move: a developing instructor stays developing on the target,
    // a lead stays lead. Find the target session's slot for that same role (if any).
    const srcRole = srcAssignment.role || "lead";
    const targetSameRole = state.assignments.find(
      (a) => a.camp_session_id === targetSession.id && a.role === srcRole && a.status !== "withdrawn"
    );
    const tgtBefore = targetSameRole ? {
      id: targetSameRole.id,
      instructor_id: targetSameRole.instructor_id,
      status: targetSameRole.status,
    } : null;

    try {
      let tgtNewId = null;
      if (targetSameRole) {
        // Swap in place — UPDATE the existing role-row to point at the new instructor.
        // Wipe the displaced instructor's email/response trail so the new instructor
        // surfaces as "needs an offer email" in the Hat tip.
        const { error: updErr } = await supabase
          .from("camp_assignments")
          .update({
            instructor_id: srcAssignment.instructor_id,
            status: "proposed",
            email_sent_at: null,
            reminder_sent_at: null,
            deadline: null,
            instructor_response_at: null,
            flagged_reason: null,
            published_at: null,
            change_request_message: null,
          })
          .eq("id", targetSameRole.id);
        if (updErr) throw updErr;
      } else {
        // No existing assignment for that role — INSERT.
        const { data: inserted, error: insErr } = await supabase
          .from("camp_assignments")
          .insert({
            organization_id: org.id,
            camp_session_id: targetSession.id,
            instructor_id: srcAssignment.instructor_id,
            role: srcRole,
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
        // Reassign — wipe the previous instructor's email/response trail so the
        // new instructor surfaces in the Hat's "needs an offer email" tip and
        // doesn't inherit the old deadline or acceptance.
        const { error: updErr } = await supabase
          .from("camp_assignments")
          .update({
            instructor_id: instructorId,
            status: "proposed",
            email_sent_at: null,
            reminder_sent_at: null,
            deadline: null,
            instructor_response_at: null,
            flagged_reason: null,
            published_at: null,
            change_request_message: null,
          })
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
      // If the instructor was being removed after they (or admin via picker) flagged
      // a change request, remember it so the picker won't suggest them for this same
      // camp again. Plain admin removals (no change_requested status) are NOT recorded
      // — admin might just be reorganizing and may want them re-suggested later.
      if (currentAssignment.status === "change_requested" && currentAssignment.instructor_id) {
        await supabase
          .from("session_declined_instructors")
          .upsert({
            organization_id: org.id,
            cycle_id: state.cycle.id,
            camp_session_id: currentAssignment.camp_session_id,
            instructor_id: currentAssignment.instructor_id,
            reason: "change_request",
          }, { onConflict: "camp_session_id,instructor_id" });
      }
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

    // Soft guard: if fewer than half the active instructors have submitted
    // availability, warn the admin before running. They can still proceed —
    // some cycles deliberately match on early returns — but it surfaces a
    // common "I forgot to wait for surveys" mistake.
    const total = state.instructors.length;
    const submitted = state.availability.filter((a) => !a.needs_confirmation).length;
    if (total > 0 && submitted / total < 0.5) {
      const proceed = window.confirm(
        `Only ${submitted} of ${total} instructors have submitted availability so far. ` +
        `Running the match agent now means the draft will only consider those ${submitted}. ` +
        `Continue anyway?`
      );
      if (!proceed) return;
    }

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

  async function handleArchiveCycle() {
    if (!state?.cycle?.id) return;
    if (state.cycle.status === "archived") return;
    const confirmed = window.confirm(
      `Archive ${cycleDisplayName(state.cycle.name)}?\n\n` +
      `Instructors will no longer see this term on their schedules. ` +
      `Past assignments stay in the database for reporting and payroll. ` +
      `You can unarchive later if needed.`
    );
    if (!confirmed) return;
    setBusy("archiving");
    setSaveError(null);
    try {
      const prevCycleStatus = state.cycle.status;
      const { error: updErr } = await supabase
        .from("scheduling_cycles")
        .update({ status: "archived" })
        .eq("id", state.cycle.id);
      if (updErr) throw updErr;
      setLastOp({
        type: "archive_cycle",
        cycleId: state.cycle.id,
        prevCycleStatus,
        label: `Archived ${cycleDisplayName(state.cycle.name)}`,
      });
      await loadAll();
    } catch (err) {
      console.error("Archive cycle failed:", err);
      setSaveError(`Couldn't archive: ${err.message ?? "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleUnarchiveCycle() {
    if (!state?.cycle?.id) return;
    if (state.cycle.status !== "archived") return;
    const confirmed = window.confirm(
      `Unarchive ${cycleDisplayName(state.cycle.name)}?\n\n` +
      `Instructors will see this term on their schedules again.`
    );
    if (!confirmed) return;
    setBusy("archiving");
    setSaveError(null);
    try {
      // Restore to 'published' — that's the safe default for a previously-
      // active cycle. If we wanted to remember the exact prior state we'd
      // need to persist it; simpler to default and let admin re-publish if
      // needed.
      const { error: updErr } = await supabase
        .from("scheduling_cycles")
        .update({ status: "published" })
        .eq("id", state.cycle.id);
      if (updErr) throw updErr;
      setLastOp({
        type: "unarchive_cycle",
        cycleId: state.cycle.id,
        prevCycleStatus: "archived",
        label: `Unarchived ${cycleDisplayName(state.cycle.name)}`,
      });
      await loadAll();
    } catch (err) {
      console.error("Unarchive cycle failed:", err);
      setSaveError(`Couldn't unarchive: ${err.message ?? "unknown error"}`);
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
      // Write the auto-reminders preference on the cycle before the real send
      // (the cron reads it daily to decide whether to fire for this cycle's rows).
      if (mode === "send" && state.cycle.auto_reminders_enabled !== autoReminders) {
        await supabase
          .from("scheduling_cycles")
          .update({ auto_reminders_enabled: autoReminders })
          .eq("id", state.cycle.id);
      }
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

  // Release the availability survey to instructors. mode 'preview' returns the
  // rendered email for review without sending; mode 'send' actually emails every
  // active instructor and flips availability_survey_opened_at on the cycle so
  // the portal banner unlocks. Deadline (optional) writes to survey_deadline.
  async function handleSendSurvey(mode) {
    if (state.status !== "ready") return;
    setBusy("sending_survey");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-availability-survey", {
        body: {
          cycle_id: state.cycle.id,
          mode,
          deadline: surveyDeadline || null,
        },
      });
      if (error) {
        let realMsg = error.message ?? "function error";
        try { const body = await error.context?.json?.(); if (body?.error) realMsg = body.error; } catch {}
        throw new Error(realMsg);
      }
      if (data?.error) throw new Error(data.error);
      if (mode === "preview") {
        // Show the first rendered email in the existing PreviewViewer.
        setPreviewData(data);
      } else {
        await loadAll();
        setSurveyDialog({ mode: "result", payload: { mode, ...data } });
      }
    } catch (err) {
      console.error("Send availability survey failed:", err);
      setSaveError(`Couldn't send survey: ${err.message ?? "unknown error"}`);
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
        body: { cycle_id: state.cycle.id, mode: "preview", instructor_ids: null, deadline: offerDeadline },
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

  // Undo a recorded decline so the picker suggests this instructor again for
  // this camp. Used by the "Re-suggest" button under the declined list.
  async function handleUndecline(sessionId, instructorId) {
    if (!sessionId || !instructorId) return;
    try {
      const { error } = await supabase
        .from("session_declined_instructors")
        .delete()
        .eq("camp_session_id", sessionId)
        .eq("instructor_id", instructorId);
      if (error) throw error;
      await loadAll();
    } catch (err) {
      console.error("Undecline failed:", err);
      setSaveError(`Couldn't re-suggest: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 6000);
    }
  }

  // Resend an offer that's already gone out (e.g. instructor says they didn't
  // receive it). Clears email_sent_at / reminder_sent_at / deadline on that row so
  // send-patch-offer picks it up, refreshes state, then opens the patch preview.
  async function handleResendOffer(assignmentId) {
    if (!assignmentId) return;
    setBusy("patching");
    setSaveError(null);
    try {
      const { error: upErr } = await supabase
        .from("camp_assignments")
        .update({ email_sent_at: null, reminder_sent_at: null, deadline: null })
        .eq("id", assignmentId);
      if (upErr) throw upErr;
      await loadAll();
      setCandidatesFor(null);
      await handlePreviewPatchOffers([assignmentId]);
    } catch (err) {
      console.error("Resend offer failed:", err);
      setSaveError(`Couldn't prepare resend: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 9000);
      setBusy(null);
    }
  }

  // Send a free-form message to an instructor through the existing offer-message-reply
  // edge function (same path as the Reply button on the Change Request modal). The
  // message lands in their inbox + the instructor_offer_messages thread tied to the
  // chosen assignment.
  async function handleSendInstructorMessage(assignmentId, message) {
    if (!assignmentId || !message?.trim()) return { ok: false, error: "Message is empty" };
    try {
      const { data, error } = await supabase.functions.invoke("offer-message-reply", {
        body: { camp_assignment_id: assignmentId, message: message.trim() },
      });
      if (error) {
        let real = error.message ?? "send failed";
        try { const b = await error.context?.json?.(); if (b?.error) real = b.error; } catch {}
        throw new Error(real);
      }
      if (data?.error) throw new Error(data.error);
      return { ok: true };
    } catch (err) {
      console.error("Send instructor message failed:", err);
      return { ok: false, error: err.message ?? "Couldn't send" };
    }
  }

  // Patch-offer flow: preview first, then send on confirm. Sends a
  // "You have another camp to accept" email per instructor for assignments
  // added AFTER bulk send-offers ran (the Skyler case).
  async function handlePreviewPatchOffers(assignmentIds) {
    if (!assignmentIds || assignmentIds.length === 0) return;
    setBusy("patching");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-patch-offer", {
        body: { assignment_ids: assignmentIds, mode: "preview" },
      });
      if (error) {
        let real = error.message ?? "preview failed";
        try { const b = await error.context?.json?.(); if (b?.error) real = b.error; } catch {}
        throw new Error(real);
      }
      if (data?.error) throw new Error(data.error);
      setPreviewData({
        preview: data?.preview ?? [],
        patchAssignmentIds: assignmentIds,
      });
    } catch (err) {
      console.error("send-patch-offer preview failed:", err);
      setSaveError(`Couldn't load preview: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 9000);
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirmPatchSend() {
    const ids = previewData?.patchAssignmentIds;
    if (!ids || ids.length === 0) return;
    setBusy("patching");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-patch-offer", {
        body: { assignment_ids: ids, mode: "send" },
      });
      if (error) {
        let real = error.message ?? "send failed";
        try { const b = await error.context?.json?.(); if (b?.error) real = b.error; } catch {}
        throw new Error(real);
      }
      if (data?.error) throw new Error(data.error);
      setPreviewData(null);
      await loadAll();
    } catch (err) {
      console.error("send-patch-offer send failed:", err);
      setSaveError(`Couldn't send: ${err.message ?? "unknown error"}`);
      setTimeout(() => setSaveError(null), 9000);
    } finally {
      setBusy(null);
    }
  }

  // After unassigning, reassigning, or skipping a change_requested row, queue up the
  // next pending one so the admin walks through them without re-clicking the Hat.
  // Reads from stateRef + skippedThisWalkRef to dodge stale closure data.
  function advanceOrCloseChangeRequest(justHandledAssignmentId) {
    const fresh = stateRef.current;
    if (fresh.status !== "ready") { setChangeRequestFor(null); return; }
    const skipped = skippedThisWalkRef.current;
    const remaining = fresh.assignments.filter(
      (a) => a.status === "change_requested"
        && a.id !== justHandledAssignmentId
        && !skipped.has(a.id)
    );
    if (remaining.length === 0) {
      setChangeRequestFor(null);
      skippedThisWalkRef.current = new Set();
      return;
    }
    const next = remaining[0];
    const sess = fresh.sessions.find((s) => s.id === next.camp_session_id);
    if (sess) setChangeRequestFor({ session: sess, assignment: next });
    else { setChangeRequestFor(null); skippedThisWalkRef.current = new Set(); }
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
        allCycles={allCycles}
        onSwitchCycle={setSelectedCycleId}
        onOpenNewCycle={() => setNewCycleOpen(true)}
        phaseLabel={derivedPhase}
        counts={counts}
        missingSurveys={state.missingSurveys}
        lastOp={lastOp}
        onUndo={handleUndo}
        busy={busy}
        canApprove={cycle.status !== "published" && state.assignments.some((a) => a.status === "proposed")}
        canSend={state.assignments.some((a) => a.status === "confirmed")}
        canRematch={cycle.status === "collecting"}
        canRunReminders={state.assignments.some((a) => a.status === "published" && !a.instructor_response_at)}
        onApprove={handleApprove}
        onSendClick={() => setOfferDialog({ mode: "choose", payload: null })}
        onPreviewClick={handlePreviewOffers}
        onRerunAgent={handleRerunAgent}
        onRemindersClick={() => setOfferDialog({ mode: "reminders_choose", payload: null })}
        nextReminders={nextRemindersForecast}
        onOpenEmailActivity={() => setEmailActivityOpen(true)}
        onArchiveCycle={handleArchiveCycle}
        onUnarchiveCycle={handleUnarchiveCycle}
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
      {nextTips.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {nextTips.map((t, i) => (
            <HatGuide key={t.key ?? `tip-${i}`} character="instructor" tip={t} />
          ))}
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
          recentlyUpdated={recentlyUpdated}
          getValidationFor={getValidationFor}
          dragStateRef={dragStateRef}
          onDrop={handleDrop}
          onNeedsHireClick={(session) => setCandidatesFor({ session, currentAssignment: null, role: "lead" })}
          onInstructorClick={(session, currentAssignment, roleHint) => setCandidatesFor({
            session,
            currentAssignment,
            role: currentAssignment?.role ?? roleHint ?? "lead",
          })}
          onChangeRequestClick={(session, assignment) => {
            skippedThisWalkRef.current = new Set();
            setChangeRequestFor({ session, assignment });
          }}
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
          autoReminders={autoReminders}
          onAutoRemindersChange={setAutoReminders}
          publishedCount={state.assignments?.filter((a) => a.status === "published").length ?? 0}
          onRollback={handleRollback}
          rollingBack={busy === "rolling_back"}
          onRunReminders={handleRunReminders}
          remindersBusy={busy === "reminders"}
        />
      )}
      {newCycleOpen && (
        <NewCycleModal
          orgId={org?.id}
          onClose={() => setNewCycleOpen(false)}
          onCreated={(newId) => { setNewCycleOpen(false); setSelectedCycleId(newId); }}
        />
      )}
      {surveyDialog && (
        <SurveyDialog
          dialog={surveyDialog}
          cycleDisplay={cycleDisplayName(cycle.name)}
          recipientCount={state.instructors.length}
          deadline={surveyDeadline}
          onDeadlineChange={setSurveyDeadline}
          busy={busy === "sending_survey"}
          onChoose={(mode) => handleSendSurvey(mode)}
          onClose={() => setSurveyDialog(null)}
        />
      )}
      {emailActivityOpen && (
        <EmailActivityModal
          cycleDisplay={`${cycleDisplayName(cycle.name)} · ${cycle.status}`}
          cycle={cycle}
          orgName={org?.name ?? "Journey to STEAM"}
          assignments={state.assignments}
          sessions={state.sessions}
          instructors={state.instructors}
          onClose={() => setEmailActivityOpen(false)}
        />
      )}
      {previewData && (
        <PreviewViewer
          data={previewData}
          onClose={() => setPreviewData(null)}
          onSend={previewData.patchAssignmentIds ? handleConfirmPatchSend : undefined}
          sendLabel={previewData.patchAssignmentIds ? (previewData.preview?.length === 1 ? "Send this offer" : `Send ${previewData.preview?.length ?? 0} offers`) : undefined}
          sending={busy === "patching"}
        />
      )}
      {changeRequestFor && (
        <ChangeRequestReview
          session={changeRequestFor.session}
          assignment={changeRequestFor.assignment}
          cycle={cycle}
          orgName={org?.name ?? "Journey to STEAM"}
          instructors={state.instructors}
          onClose={() => {
            setChangeRequestFor(null);
            skippedThisWalkRef.current = new Set();
          }}
          onUnassign={async () => {
            const handledId = changeRequestFor.assignment.id;
            await handleRemoveAssignment(changeRequestFor.session, changeRequestFor.assignment);
            advanceOrCloseChangeRequest(handledId);
          }}
          onReassign={() => {
            setReassigningChangeRequestId(changeRequestFor.assignment.id);
            setCandidatesFor({ session: changeRequestFor.session, currentAssignment: changeRequestFor.assignment, role: changeRequestFor.assignment.role });
            setChangeRequestFor(null);
          }}
          onSkip={() => {
            const handledId = changeRequestFor.assignment.id;
            skippedThisWalkRef.current.add(handledId);
            advanceOrCloseChangeRequest(handledId);
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
          declinedInstructorIds={declinedBySession.get(candidatesFor.session.id) ?? new Set()}
          onUndecline={(instructorId) => handleUndecline(candidatesFor.session.id, instructorId)}
          onClose={() => {
            setCandidatesFor(null);
            // Picker closed without picking — drop the pending advance so the next click of the Hat re-opens cleanly.
            setReassigningChangeRequestId(null);
          }}
          role={candidatesFor.role}
          onPick={async (instructorId) => {
            await handlePick(candidatesFor.session, candidatesFor.currentAssignment, instructorId, null, candidatesFor.role);
            if (reassigningChangeRequestId) {
              const handledId = reassigningChangeRequestId;
              setReassigningChangeRequestId(null);
              advanceOrCloseChangeRequest(handledId);
            }
          }}
          onRemove={() => handleRemoveAssignment(candidatesFor.session, candidatesFor.currentAssignment)}
          onResetAcceptance={() => handleResetAcceptance(candidatesFor.session, candidatesFor.currentAssignment)}
          onResendOffer={() => handleResendOffer(candidatesFor.currentAssignment?.id)}
          onSendMessage={(text) => handleSendInstructorMessage(candidatesFor.currentAssignment?.id, text)}
          onCreateInstructor={async (form) => {
            const newId = await handleCreateInstructor(form, candidatesFor.session);
            await handlePick(candidatesFor.session, candidatesFor.currentAssignment, newId, null, candidatesFor.role);
            if (reassigningChangeRequestId) {
              const handledId = reassigningChangeRequestId;
              setReassigningChangeRequestId(null);
              advanceOrCloseChangeRequest(handledId);
            }
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

function HeaderStrip({ cycle, allCycles, onSwitchCycle, onOpenNewCycle, phaseLabel, counts, missingSurveys, lastOp, onUndo, busy, canApprove, canSend, canRematch, canRunReminders, onApprove, onSendClick, onPreviewClick, onRerunAgent, onRemindersClick, nextReminders, onOpenEmailActivity, onArchiveCycle, onUnarchiveCycle }) {
  const otherCycles = (allCycles ?? []).filter((c) => c.id !== cycle.id);
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
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          {otherCycles.length > 0 ? (
            <select
              value={cycle.id}
              onChange={(e) => onSwitchCycle && onSwitchCycle(e.target.value)}
              title="Switch to another scheduling cycle"
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: INK,
                letterSpacing: -0.4,
                fontFamily: "inherit",
                background: "transparent",
                border: "none",
                borderBottom: `2px dotted ${RULE}`,
                padding: "0 22px 2px 0",
                cursor: "pointer",
                appearance: "none",
                backgroundImage: `linear-gradient(45deg, transparent 50%, ${MUTED} 50%), linear-gradient(135deg, ${MUTED} 50%, transparent 50%)`,
                backgroundPosition: "calc(100% - 12px) center, calc(100% - 7px) center",
                backgroundSize: "5px 5px, 5px 5px",
                backgroundRepeat: "no-repeat",
              }}
            >
              <option value={cycle.id}>{cycleDisplayName(cycle.name)}</option>
              {otherCycles.map((c) => (
                <option key={c.id} value={c.id}>{cycleDisplayName(c.name)}</option>
              ))}
            </select>
          ) : (
            <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>{cycleDisplayName(cycle.name)}</h1>
          )}
          <span style={{
            fontSize: 11,
            color: PURPLE,
            background: `${VIOLET}22`,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 999,
          }}>{phaseLabel || cycle.status}</span>
          {onOpenNewCycle && (
            <button
              type="button"
              onClick={onOpenNewCycle}
              title="Set up a new term cycle (e.g. FA26)"
              style={{
                background: "transparent",
                border: "none",
                color: PURPLE,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
                padding: "2px 4px",
                textDecoration: "underline",
              }}
            >
              + New cycle
            </button>
          )}
          {cycle.status === "archived" ? (
            onUnarchiveCycle && (
              <button
                type="button"
                onClick={onUnarchiveCycle}
                title="Restore this cycle from archived to its prior status"
                style={{
                  background: "transparent",
                  border: "none",
                  color: MUTED,
                  fontSize: 12,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  padding: "2px 4px",
                  textDecoration: "underline",
                }}
              >
                Unarchive
              </button>
            )
          ) : (
            onArchiveCycle && (
              <button
                type="button"
                onClick={onArchiveCycle}
                title="Archive this cycle. Hides it from instructors' schedules; admin can still see it. Use after the term is over."
                style={{
                  background: "transparent",
                  border: "none",
                  color: MUTED,
                  fontSize: 12,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  padding: "2px 4px",
                  textDecoration: "underline",
                }}
              >
                Archive cycle
              </button>
            )
          )}
        </div>
        <div style={{ color: MUTED, marginTop: 4, fontSize: 14 }}>{fmtRange(cycle.starts_on, cycle.ends_on)}</div>
        <div style={{ marginTop: 8, fontSize: 13, color: MUTED, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          {nextReminders && (
            <span>
              Next reminders fire <strong style={{ color: INK }}>{fmtShort(nextReminders.fireDate)}</strong>
              {" → "}
              {nextReminders.instructorCount} instructor{nextReminders.instructorCount === 1 ? "" : "s"} · {nextReminders.campCount} camp{nextReminders.campCount === 1 ? "" : "s"}
            </span>
          )}
          {onOpenEmailActivity && (
            <button
              type="button"
              onClick={onOpenEmailActivity}
              style={{
                background: "transparent",
                border: "none",
                color: PURPLE,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
              }}
            >
              View email activity →
            </button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <Counter label="Assigned" value={counts.assigned} tone="assigned" />
        <Counter label="Accepted" value={counts.accepted} tone="accepted" />
        <Counter label="Flagged" value={counts.flagged} tone="flagged" />
        <Counter label="Change req." value={counts.changeRequested} tone="change_requested" />
        <Counter label="Needs hire" value={counts.needsHire} tone="needs_hire" />
        {cycle.availability_survey_opened_at ? (
          <Counter
            label="Surveys in"
            value={(counts.activeInstructors ?? 0) - missingSurveys}
            suffix={` / ${counts.activeInstructors ?? 0}`}
            tone="muted"
          />
        ) : (
          <Counter label="Survey" value="—" hint="Not sent" tone="muted" />
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {lastOp && (
          <button
            type="button"
            onClick={onUndo}
            title={lastOp.label}
            style={{ ...btn("transparent", PURPLE, true), padding: "7px 12px", fontSize: 13 }}
          >
            ↶ Undo
          </button>
        )}
        {canRematch && (
          <button
            type="button"
            onClick={onRerunAgent}
            disabled={busy === "rematching"}
            title="Re-run the matching agent on this cycle's surveys to regenerate a fresh draft of proposed assignments"
            style={btn("transparent", PURPLE, true, busy === "rematching")}
          >
            {busy === "rematching" ? "Re-running…" : "Re-run matching"}
          </button>
        )}
        {canApprove && (
          <button
            type="button"
            onClick={onApprove}
            disabled={busy === "approving"}
            title="Lock in the AI's draft assignments — flips every proposed row to confirmed so you can send offers. This is the draft-approval gate, not instructor acceptances."
            style={btn("transparent", PURPLE, true, busy === "approving")}
          >
            {busy === "approving" ? "Approving…" : "Approve draft"}
          </button>
        )}
        {canSend && (
          <>
            <button
              type="button"
              onClick={onPreviewClick}
              disabled={busy === "previewing"}
              title="Render every offer email so you can review before sending — no real sends, no DB changes"
              style={btn("transparent", PURPLE, true, busy === "previewing")}
            >
              {busy === "previewing" ? "Loading…" : "Preview offers"}
            </button>
            <button
              type="button"
              onClick={onSendClick}
              disabled={busy === "sending"}
              title="Send the confirmed offers to every assigned instructor"
              style={btn(PURPLE, "#fff", false, busy === "sending")}
            >
              Send offers
            </button>
          </>
        )}
        {canRunReminders && (
          <button
            type="button"
            onClick={onRemindersClick}
            disabled={busy === "reminders"}
            title="Fire reminder emails right now to anyone whose response is still pending (the cron auto-fires 2–3 days before each deadline — this is for manual nudges)"
            style={btn("transparent", PURPLE, true, busy === "reminders")}
          >
            {busy === "reminders" ? "Working…" : "Send reminders now"}
          </button>
        )}
      </div>
    </header>
  );
}

function Counter({ label, value, tone, suffix, hint }) {
  const color =
    tone === "assigned" ? PURPLE :
    tone === "accepted" ? OK_GREEN :
    tone === "flagged" ? VIOLET :
    tone === "change_requested" ? CHANGE_REQ :
    tone === "needs_hire" ? CORAL : MUTED;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>
        {value}
        {suffix && <span style={{ fontSize: 14, fontWeight: 500, color: MUTED }}>{suffix}</span>}
      </div>
      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 }}>
        {label}{hint && <span style={{ textTransform: "none", marginLeft: 4, fontStyle: "italic" }}>· {hint}</span>}
      </div>
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
          borderColor: count > 0 ? PURPLE : RULE,
        }}
      >
        <span>{label}</span>
        {count > 0 && (
          <span style={{
            background: PURPLE,
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
                  background: isOn ? `${VIOLET}1A` : "transparent",
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
                  border: `1.5px solid ${isOn ? PURPLE : RULE}`,
                  background: isOn ? PURPLE : "#fff",
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
          background: `${VIOLET}1A`,
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
                background: isFocused ? `${VIOLET}1A` : CREAM,
                border: isFocused ? `2px solid ${PURPLE}` : `0.5px solid ${RULE}`,
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
    kind === "flagged" ? VIOLET :
    kind === "change_requested" ? CHANGE_REQ :
    kind === "accepted" ? OK_GREEN :
    PURPLE;
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

function WeeklyGrid({ week, items, cycleType, recentlyUpdated, getValidationFor, dragStateRef, onDrop, onNeedsHireClick, onInstructorClick, onChangeRequestClick }) {
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
                    borderTop: `2px solid ${VIOLET}66`,
                    margin: "4px 0",
                  }} />
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                  {WEEKDAYS.map((d) => days.includes(d) ? (
                    <ProgramCard
                      key={d}
                      item={e}
                      cardBg={colorByLocation.get(e.session.location_name) ?? LOCATION_PALETTE[0]}
                      flash={e.activeAssignments.some((a) => recentlyUpdated?.has(a.id))}
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

function ProgramCard({ item, cardBg, flash, getValidationFor, dragStateRef, onDrop, onNeedsHireClick, onInstructorClick, onChangeRequestClick }) {
  const { session, status, assignment, allAssignments, activeAssignments } = item;
  const [dropEffect, setDropEffect] = useState(null); // "ok" | "warn" | "block" | "self" | null
  const [hoverResult, setHoverResult] = useState(null); // full validation result during drag
  const isNeedsHire = status === "needs_hire";
  const isChangeRequested = status === "change_requested";
  // Flagged-state can come from change_requested OR an auto-expire flagged_reason.
  // For deadline-passed cards, route the click into the same review modal so admin
  // can Reassign / Unassign / Reply.
  const flaggedAssignment = activeAssignments.find((a) => a.flagged_reason) ?? null;
  const isDeadlinePassed = status === "flagged" && !!flaggedAssignment && !isChangeRequested;
  // For change_requested cards, find the assignment that triggered it (status='change_requested')
  const changeReqAssignment = isChangeRequested
    ? activeAssignments.find((a) => a.status === "change_requested") ?? assignment
    : isDeadlinePassed ? flaggedAssignment : null;

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
    enrollTone === "warn" ? VIOLET :
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
    dropEffect === "warn" ? VIOLET :
    dropEffect === "block" ? CORAL :
    dropEffect === "self" ? MUTED :
    RULE;
  const baseBg = cardBg ?? LOCATION_PALETTE[0];
  const bgColor =
    dropEffect === "ok" ? `${OK_GREEN}33` :
    dropEffect === "warn" ? `${VIOLET}33` :
    dropEffect === "block" ? `${CORAL}33` :
    baseBg;

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropHandler}
      onClick={
        (isChangeRequested || isDeadlinePassed) && onChangeRequestClick
          ? () => onChangeRequestClick(session, changeReqAssignment)
          : isNeedsHire && onNeedsHireClick
          ? () => onNeedsHireClick(session)
          : undefined
      }
      role={isNeedsHire || isChangeRequested || isDeadlinePassed ? "button" : undefined}
      tabIndex={isNeedsHire || isChangeRequested || isDeadlinePassed ? 0 : undefined}
      style={{
        position: "relative",
        background: bgColor,
        border: `1px solid ${flash ? VIOLET : borderColor}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: (isNeedsHire || isChangeRequested || isDeadlinePassed) ? "pointer" : "default",
        transition: "background 600ms ease, border-color 600ms ease, box-shadow 600ms ease",
        boxShadow: flash ? `0 0 0 3px ${VIOLET}55` : "none",
      }}
      title={
        isChangeRequested ? "Click to review the instructor's change request" :
        isDeadlinePassed ? "Click to handle — instructor didn't respond by the deadline" :
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
        <div style={{ fontSize: 10, color: PURPLE, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
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
          dragStateRef={dragStateRef}
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
  const color = isBlock ? CORAL : VIOLET;
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

  const accepted = assignment.status === "confirmed" && !!assignment.instructor_response_at;
  // Survey-level "maybe" flag — only relevant before the instructor explicitly accepts the offer.
  // Once accepted, the survey uncertainty is moot, so we drop the ? badge.
  const tentative = !!assignment.instructor_needs_confirmation && !accepted;
  // Matcher flags persisted on the row by compute_distance_bonus() trigger:
  // location_override = instructor marked this region 'unavailable' (carries $50 bonus)
  // location_low_pref = instructor marked this region 'not_preferred' (no bonus, but worth surfacing)
  const flagsArr = Array.isArray(assignment.flags) ? assignment.flags : [];
  const hasOverride = flagsArr.includes("location_override");
  const hasLowPref = flagsArr.includes("location_low_pref");
  const flagBadgeKind = hasOverride ? "override" : hasLowPref ? "low_pref" : null;
  const baseTitle = draggable ? "Click to reassign · drag to move" : "Click to reassign";
  const tentativeTitle = tentative
    ? `Tentative — survey unconfirmed${assignment.instructor_notes ? `: "${assignment.instructor_notes}"` : ""}`
    : "";
  const acceptedTitle = accepted ? "Accepted by instructor" : "";
  const flagTitle = hasOverride
    ? `Not-preferred / unavailable location — $${(assignment.distance_bonus_cents ?? 5000) / 100} hardship bonus added`
    : hasLowPref
    ? "Assigned to a not-preferred location"
    : "";

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
        background: accepted ? `${OK_GREEN}26` : tentative ? `${VIOLET}33` : CREAM,
        border: accepted ? `1px solid ${OK_GREEN}` : tentative ? `1px solid ${VIOLET}` : "none",
        padding: "3px 8px",
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        cursor: onClick ? "pointer" : (draggable ? "grab" : "default"),
        userSelect: "none",
      }}
      title={[baseTitle, acceptedTitle, tentativeTitle, flagTitle].filter(Boolean).join(" · ")}
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
            color: PURPLE,
            background: VIOLET,
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
      {flagBadgeKind && (
        <span
          aria-hidden="true"
          style={{
            fontSize: 9,
            fontWeight: 800,
            color: "#fff",
            background: flagBadgeKind === "override" ? CORAL : VIOLET,
            borderRadius: "50%",
            width: 13,
            height: 13,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >{flagBadgeKind === "override" ? "$" : "!"}</span>
      )}
      {extraCount > 0 && <span style={{ color: MUTED }}>+{extraCount}</span>}
    </span>
  );
}

function ChangeRequestReview({ session, assignment, cycle, orgName, instructors = [], onClose, onUnassign, onReassign, onSkip }) {
  const [busy, setBusy] = useState(false);
  const [unassignArmed, setUnassignArmed] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [replySent, setReplySent] = useState(false);
  const [thread, setThread] = useState([]);
  const firstName = assignment?.instructor_first ?? "Instructor";
  const isDeadlinePassed = assignment?.flagged_reason === "deadline_passed";

  // Reset the confirmation arming whenever the modal opens on a different change request
  // (auto-advance reuses this component instance to walk the queue).
  useEffect(() => { setUnassignArmed(false); }, [assignment?.id]);

  useEffect(() => {
    if (!assignment?.id) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("instructor_offer_messages")
        .select("id, sender_role, sender_instructor_id, message, created_at")
        .eq("camp_assignment_id", assignment.id)
        .order("created_at", { ascending: true });
      if (alive) setThread(data ?? []);
    })();
    return () => { alive = false; };
  }, [assignment?.id, replySent]);

  async function doUnassign() {
    setBusy(true);
    try { await onUnassign(); } finally { setBusy(false); }
  }

  async function sendReply() {
    if (!replyText.trim()) return;
    setReplyBusy(true);
    setReplyError("");
    try {
      const { data, error } = await supabase.functions.invoke("offer-message-reply", {
        body: { camp_assignment_id: assignment.id, message: replyText.trim() },
      });
      if (error) {
        let realMsg = error.message ?? "send failed";
        try { const b = await error.context?.json?.(); if (b?.error) realMsg = b.error; } catch {}
        throw new Error(realMsg);
      }
      if (data?.error) throw new Error(data.error);
      setReplySent(true);
      setReplyText("");
    } catch (err) {
      setReplyError(err.message ?? "Couldn't send.");
    } finally {
      setReplyBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} title={isDeadlinePassed ? "No response by deadline" : "Change request"}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
            {isDeadlinePassed ? `${firstName} didn't respond` : `From ${firstName}`} · Week {session.week_num}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 4 }}>
            {session.curriculum_name ?? "(unnamed)"}
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {session.location_name} · {titleCase(session.session_type)}
          </div>
        </div>

        <div style={{
          background: isDeadlinePassed ? `${VIOLET}1A` : `${CHANGE_REQ}14`,
          border: `1px solid ${isDeadlinePassed ? VIOLET : CHANGE_REQ}66`,
          borderRadius: 6,
          padding: 12,
          fontSize: 14,
          color: INK,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}>
          {isDeadlinePassed
            ? <span>No response received by the deadline. The offer is still in their inbox — but {firstName} hasn't tapped Accept or Request change. You can reach out, reassign someone else, or mark this slot as Needs hire.</span>
            : assignment?.change_request_message || <em style={{ color: MUTED }}>(no message)</em>
          }
        </div>

        {thread.length > 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Conversation
            </div>
            {thread.map((m) => {
              const isInstructor = m.sender_role === "instructor";
              const isSystem = m.sender_role === "system";
              // Attribute instructor messages by actual sender (sender_instructor_id).
              // Historical messages without it (pre-fix) render as "Prior instructor"
              // so a reassigned row doesn't mislead admin about who said what.
              let label;
              if (isInstructor) {
                if (m.sender_instructor_id === assignment?.instructor_id) {
                  label = firstName;
                } else if (m.sender_instructor_id) {
                  const sender = instructors.find((i) => i.id === m.sender_instructor_id);
                  label = sender ? sender.first_name : "Instructor";
                } else {
                  label = "Prior instructor";
                }
              } else if (isSystem) {
                label = "System";
              } else {
                label = "You";
              }
              return (
                <div key={m.id} style={{
                  padding: "8px 10px",
                  background: isSystem ? "#f5f3ed" : (isInstructor ? `${CHANGE_REQ}10` : `${PURPLE}10`),
                  border: `1px solid ${isSystem ? RULE : (isInstructor ? `${CHANGE_REQ}40` : `${PURPLE}40`)}`,
                  borderRadius: 6,
                  fontSize: 13,
                  color: INK,
                  lineHeight: 1.45,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                    {label} · {new Date(m.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.message}</div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <DialogChoice
            title={`Reassign someone else to this camp`}
            subtitle={`Open the candidate picker for ${session.curriculum_name ?? "this camp"} so you can swap ${firstName} out.`}
            onClick={onReassign}
            disabled={busy}
          />
          {unassignArmed ? (
            <div style={{
              background: `${CORAL}14`,
              border: `1px solid ${CORAL}`,
              borderRadius: 6,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}>
              <div style={{ fontSize: 14, color: INK, fontWeight: 600 }}>
                Really unassign {firstName} from {session.curriculum_name ?? "this camp"} ({session.location_name}, Week {session.week_num})?
              </div>
              <div style={{ fontSize: 12, color: MUTED }}>
                Their assignment is removed and the slot becomes Needs hire. You can undo from the header.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={doUnassign}
                  disabled={busy}
                  style={{
                    padding: "8px 14px",
                    background: CORAL,
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    cursor: busy ? "default" : "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? "Unassigning…" : `Yes, unassign ${firstName}`}
                </button>
                <button
                  type="button"
                  onClick={() => setUnassignArmed(false)}
                  disabled={busy}
                  style={{
                    padding: "8px 14px",
                    background: "transparent",
                    color: INK,
                    border: `1px solid ${RULE}`,
                    borderRadius: 6,
                    cursor: busy ? "default" : "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    fontFamily: "inherit",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <DialogChoice
              title={`Unassign ${firstName} (mark Needs hire)`}
              subtitle="Removes their assignment; the slot becomes Needs hire. Undo available."
              onClick={() => setUnassignArmed(true)}
              disabled={busy}
              tone="warn"
            />
          )}
          {!replyOpen ? (
            <DialogChoice
              title={`Reply to ${firstName}`}
              subtitle="Send a message via Enrops. It emails them and saves a copy to your conversation thread."
              onClick={() => setReplyOpen(true)}
              disabled={busy}
            />
          ) : (
            <div style={{ border: `1px solid ${PURPLE}`, borderRadius: 6, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>Reply to {firstName}</div>
              {replySent ? (
                <div style={{ fontSize: 13, color: OK_GREEN, fontWeight: 500 }}>
                  ✓ Sent. They'll get an email; your message is saved in the thread.
                </div>
              ) : (
                <>
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder={`e.g., Hi ${firstName}, can you tell me a bit more? Just want to make sure I understand…`}
                    rows={4}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      border: `1px solid ${RULE}`,
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: "inherit",
                      color: INK,
                      background: "#fff",
                      boxSizing: "border-box",
                      resize: "vertical",
                    }}
                  />
                  {replyError && <div style={{ color: CORAL, fontSize: 12 }}>{replyError}</div>}
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button type="button" onClick={() => { setReplyOpen(false); setReplyText(""); setReplyError(""); }} disabled={replyBusy} style={{ ...btn("transparent", MUTED, true), padding: "6px 10px", fontSize: 12 }}>
                      Cancel
                    </button>
                    <button type="button" onClick={sendReply} disabled={replyBusy || !replyText.trim()} style={{ ...btn(PURPLE, "#fff", false, replyBusy || !replyText.trim()), padding: "6px 12px", fontSize: 12 }}>
                      {replyBusy ? "Sending…" : "Send"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            title="Leave this one as-is and move to the next change request"
            style={{
              padding: "8px 14px",
              background: "transparent",
              color: PURPLE,
              border: "none",
              borderRadius: 6,
              cursor: busy ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "inherit",
              textDecoration: "underline",
            }}
          >
            Skip — review later →
          </button>
        ) : <div />}
        <button type="button" onClick={onClose} disabled={busy} style={btn("transparent", MUTED, true)}>Close</button>
      </div>
    </ModalShell>
  );
}

function OfferDialog({ dialog, onChoose, onClose, busy, deadline, onDeadlineChange, autoReminders, onAutoRemindersChange, publishedCount, onRollback, rollingBack, onRunReminders, remindersBusy }) {
  if (dialog.mode === "result" && dialog.payload?.kind === "approve") {
    return (
      <ModalShell onClose={onClose} title="Approved">
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.5 }}>
          {dialog.payload.count} assignment{dialog.payload.count === 1 ? "" : "s"} flipped from <em>proposed</em> to <em>confirmed</em>.
          You can now send offers.
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>OK</button>
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
            <div style={{ marginTop: 12, padding: 10, background: `${VIOLET}1A`, borderRadius: 6, fontSize: 12, color: INK }}>
              All emails went to <strong>jessica@journeytosteam.com</strong> only — your instructors didn't receive anything. Check your inbox.
            </div>
          )}
          {showRollback && (
            <div style={{ marginTop: 14, padding: 12, background: `${VIOLET}1A`, border: `1px solid ${VIOLET}66`, borderRadius: 6 }}>
              <div style={{ fontSize: 13, color: INK, marginBottom: 8 }}>
                <strong>{publishedCount}</strong> {publishedCount === 1 ? "instructor has" : "instructors have"} already been sent their offer. If you need to send again (after fixing something), reset them here first.
              </div>
              <button
                type="button"
                onClick={onRollback}
                disabled={rollingBack}
                style={{ ...btn(VIOLET, INK, false, rollingBack), padding: "7px 12px", fontSize: 13 }}
              >
                {rollingBack ? "Resetting…" : `Reset ${publishedCount} already-sent ${publishedCount === 1 ? "offer" : "offers"}`}
              </button>
            </div>
          )}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>Close</button>
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
    const upcoming = p.upcoming ?? [];
    const formatDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" });
    return (
      <ModalShell onClose={onClose} title={p.dry_run ? "Reminders preview" : "Reminders sent"}>
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55 }}>
          {p.dry_run ? (
            <>
              <div><strong>Today:</strong> {wouldSend} reminder{wouldSend === 1 ? "" : "s"} would fire now, {p.expired_count} card{p.expired_count === 1 ? "" : "s"} would be flagged past-deadline.</div>
            </>
          ) : (
            <>
              <div><strong>{sent}</strong> reminder email{sent === 1 ? "" : "s"} delivered.</div>
              <div style={{ marginTop: 6 }}><strong>{p.expired_count}</strong> assignment{p.expired_count === 1 ? "" : "s"} flagged as past-deadline.</div>
            </>
          )}
          {upcoming.length > 0 && (
            <div style={{ marginTop: 16, padding: 12, background: `${VIOLET}1A`, border: `1px solid ${VIOLET}66`, borderRadius: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                Auto-scheduled
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, color: INK, fontSize: 13 }}>
                {upcoming.map((u, i) => (
                  <li key={i}>
                    <strong>{formatDate(u.fire_date)}</strong> — {u.instructor_count} instructor{u.instructor_count === 1 ? "" : "s"} ({u.assignment_count} camp{u.assignment_count === 1 ? "" : "s"})
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8, fontSize: 11, color: MUTED }}>
                These fire automatically — you don't need to come back and click anything.
              </div>
            </div>
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
          <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>Close</button>
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
          <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>OK</button>
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
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", fontSize: 13, color: INK, cursor: "pointer", lineHeight: 1.45 }}>
          <input
            type="checkbox"
            checked={autoReminders}
            onChange={(e) => onAutoRemindersChange(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Auto-send a reminder 3 days before the deadline</strong> to anyone who hasn't responded.
            <br />
            <span style={{ color: MUTED, fontSize: 12 }}>
              Runs daily on its own — no need to remember to click. Past-deadline offers are also auto-flagged in your calendar.
            </span>
          </span>
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

// SurveyDialog: lets the admin release the availability survey to instructors.
// 'preview' opens the rendered email in PreviewViewer; 'test' routes every send
// to the test inbox without flipping the cycle's opened_at; 'send' actually
// emails every active instructor and unlocks the portal banner.
function SurveyDialog({ dialog, cycleDisplay, recipientCount, deadline, onDeadlineChange, busy, onChoose, onClose }) {
  if (dialog.mode === "result") {
    const p = dialog.payload;
    return (
      <ModalShell onClose={onClose} title={p.mode === "send" ? "Survey released" : "Test send complete"}>
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55 }}>
          <div><strong>{p.sent}</strong> of {p.recipient_count ?? "?"} email{p.sent === 1 ? "" : "s"} delivered.</div>
          {p.mode === "send" && p.sent > 0 && (
            <div style={{ marginTop: 10, padding: 10, background: `#3a7c3a1A`, borderRadius: 6, fontSize: 13, color: INK }}>
              The portal banner is now live for instructors. They can submit their availability any time before the deadline.
            </div>
          )}
          {p.mode === "test" && p.sent > 0 && (
            <div style={{ marginTop: 10, padding: 10, background: `${VIOLET}1A`, borderRadius: 6, fontSize: 12, color: INK }}>
              All emails went to <strong>jessica@journeytosteam.com</strong> only — the survey hasn't actually been released yet.
            </div>
          )}
          {p.failed && p.failed.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, color: CORAL, marginBottom: 4 }}>Failures ({p.failed.length}):</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: MUTED, fontSize: 12 }}>
                {p.failed.map((f, i) => <li key={i}>{f.instructor_id.slice(0, 8)}… — {f.reason}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>OK</button>
        </div>
      </ModalShell>
    );
  }
  return (
    <ModalShell
      onClose={busy ? undefined : onClose}
      title={`Open ${cycleDisplay} availability survey`}
    >
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          Emails {recipientCount} active instructor{recipientCount === 1 ? "" : "s"} a link to /j2s/instructor where they'll fill out which weeks, locations, and subjects they want to work.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: INK }}>
          <span style={{ minWidth: 110 }}>Submit by (optional):</span>
          <input
            type="date"
            value={deadline ?? ""}
            onChange={(e) => onDeadlineChange(e.target.value)}
            style={{ flex: 1, padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }}
          />
        </label>
        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.45, marginTop: -4 }}>
          Shown in the email and the portal banner. Leave blank for no deadline.
        </div>
        <DialogChoice
          title="Preview the email"
          subtitle="Renders what one instructor would see. No emails are sent and the survey stays closed."
          disabled={busy}
          onClick={() => onChoose("preview")}
          tone="neutral"
        />
        <DialogChoice
          title="Send to me first (recommended)"
          subtitle="Every instructor's email arrives in your inbox so you can read exactly what they'll see. Survey stays closed — re-run as many times as you want."
          disabled={busy}
          onClick={() => onChoose("test")}
          tone="warn"
        />
        <DialogChoice
          title="Open survey to all instructors"
          subtitle={`Emails ${recipientCount} active instructor${recipientCount === 1 ? "" : "s"} for real and unlocks the portal banner. They can update their answers any time before the deadline.`}
          disabled={busy}
          onClick={() => onChoose("send")}
          tone="danger"
        />
        {busy && <div style={{ color: MUTED, fontSize: 12 }}>Working…</div>}
      </div>
    </ModalShell>
  );
}

// ---- Email preview renderers ----------------------------------------------
// Mirror the templates in send-offers / send-patch-offer / offer-reminders-cron
// so clicking a row in EmailActivityModal can show "what this instructor saw"
// without round-tripping to an edge function. Drift risk if email templates
// diverge later — keep in sync if you change the server templates.

const EMAIL_BRAND = {
  primary: "#1C004F",
  pageBg: "#FBFBFB",
  text: "#1a1a1a",
  muted: "#6b6b6b",
  border: "#e2dfd5",
};

function emailFmtDateLong(dateStr) {
  if (!dateStr) return "";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

function emailFmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

function emailClassDaysSummary(days) {
  if (!Array.isArray(days) || days.length === 0) return "";
  const order = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const short = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };
  if (days.length === 5 && order.slice(0, 5).every((d) => days.includes(d))) return "Mon–Fri";
  return days.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((d) => short[d] ?? d).join(", ");
}

function emailDollars(cents) {
  if (!cents) return "";
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function emailEscape(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderVenueDetailsBlockHtml(loc) {
  if (!loc) return "";
  const { muted, border } = EMAIL_BRAND;
  const lines = [];
  if (loc.address) lines.push(`<div>${emailEscape(loc.address)}${loc.room_number ? ` · Room ${emailEscape(loc.room_number)}` : ""}</div>`);
  else if (loc.room_number) lines.push(`<div>Room ${emailEscape(loc.room_number)}</div>`);
  if (loc.arrival_instructions) lines.push(`<div><strong>Arrival:</strong> ${emailEscape(loc.arrival_instructions)}</div>`);
  if (loc.food_drink_policy) lines.push(`<div><strong>Food/drink:</strong> ${emailEscape(loc.food_drink_policy)}</div>`);
  const contact = [loc.contact_name, loc.contact_phone, loc.contact_email].filter(Boolean).map(emailEscape);
  if (contact.length) lines.push(`<div><strong>Venue contact:</strong> ${contact.join(" · ")}</div>`);
  if (loc.notes) lines.push(`<div><strong>Notes:</strong> ${emailEscape(loc.notes)}</div>`);
  if (lines.length === 0) return "";
  return `<div style="margin-top:6px;font-size:12px;color:${muted};line-height:1.5;">${lines.join("")}</div>`;
}

function renderCampRowHtml(camp, locationsById, primary) {
  const { s, a } = camp;
  if (!s) return "";
  const { muted, text, border } = EMAIL_BRAND;
  const loc = s.location_id ? locationsById.get(s.location_id) : null;
  const venue = renderVenueDetailsBlockHtml(loc);
  const bonus = a.distance_bonus_cents
    ? `<div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">Includes a ${emailDollars(a.distance_bonus_cents)} distance bonus</div>`
    : "";
  const role = a.role === "developing"
    ? `<span style="font-size:11px;color:${muted};text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-left:6px;">Developing</span>`
    : "";
  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid ${border};">
        <div style="font-size:15px;font-weight:700;color:${text};line-height:1.3;">${emailEscape(s.curriculum_name ?? "Camp")}${role}</div>
        <div style="font-size:13px;color:${muted};margin-top:4px;line-height:1.4;">
          Week ${s.week_num} · ${emailFmtDateLong(s.starts_on)} – ${emailFmtDateLong(s.ends_on)} · ${emailClassDaysSummary(s.class_days)}<br />
          ${emailEscape(s.location_name ?? "")} · ${titleCase(s.session_type)} ${emailFmtTime(s.start_time)}–${emailFmtTime(s.end_time)}
        </div>
        ${venue}
        ${bonus}
      </td>
    </tr>
  `;
}

// Wrap the inner body HTML in the standard outer email shell (background, container,
// header strip, footer).
function emailShellHtml({ orgName, headlineHtml, bodyHtml, ctaUrl, ctaSubtitle, footerHtml, badgeText }) {
  const { pageBg, text, muted, border, primary } = EMAIL_BRAND;
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${pageBg};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${text};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${pageBg};padding:32px 16px;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${border};border-radius:10px;">
      <tr><td style="padding:28px 32px 8px;">
        <div style="font-size:13px;color:${muted};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${emailEscape(orgName)}${badgeText ? ` · ${emailEscape(badgeText)}` : ""}</div>
        <h1 style="margin:6px 0 0;font-size:22px;color:${text};font-weight:700;letter-spacing:-0.3px;">${headlineHtml}</h1>
      </td></tr>
      <tr><td style="padding:14px 32px 6px;font-size:15px;color:${text};line-height:1.55;">${bodyHtml}</td></tr>
      ${ctaUrl ? `<tr><td style="padding:24px 32px 6px;" align="left">
        <a href="${ctaUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:16px;font-weight:700;letter-spacing:0.2px;">Review and respond →</a>
        ${ctaSubtitle ? `<div style="font-size:12px;color:${muted};margin-top:10px;">${ctaSubtitle}</div>` : ""}
      </td></tr>` : ""}
      <tr><td style="padding:14px 32px 24px;font-size:13px;color:${muted};line-height:1.55;">${footerHtml}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function renderCampsTableHtml(camps, locationsById, primary) {
  const rows = camps.map((c) => renderCampRowHtml(c, locationsById, primary)).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`;
}

function renderOfferEmailHtml({ assignment, instructorCamps, locationsById, cycle, orgName, portalUrl, deadline }) {
  const firstName = assignment.instructor_first ?? "there";
  const cycleDisp = cycleDisplayName(cycle.name);
  const campCount = instructorCamps.length;
  const unit = unitLabel(cycle.cycle_type, campCount);
  const deadlineLine = deadline ? `<br /><br /><strong>Please respond by ${emailFmtDateLong(deadline)}.</strong>` : "";
  const headline = `Your ${emailEscape(cycleDisp)} schedule is ready`;
  const body = `Hi ${emailEscape(firstName)},<br /><br />Your proposed schedule for ${emailEscape(cycleDisp)} is below. <strong>Please tap Accept or Request change on each of the ${campCount} ${unit}</strong> — your schedule isn't confirmed until we hear back from you on every one.${deadlineLine}<br /><br />${renderCampsTableHtml(instructorCamps, locationsById, EMAIL_BRAND.primary)}`;
  const footer = `Once you've responded to every ${unitLabel(cycle.cycle_type, 1)}, you're set. Questions? Just reply to this email.<br /><br />— Jessica, ${emailEscape(orgName)}`;
  return emailShellHtml({ orgName, headlineHtml: headline, bodyHtml: body, ctaUrl: portalUrl, ctaSubtitle: `You'll see each ${unitLabel(cycle.cycle_type, 1)} with an <strong>Accept</strong> and <strong>Request change</strong> button.`, footerHtml: footer });
}

function renderPatchEmailHtml({ instructorCamps, locationsById, cycle, orgName, portalUrl, deadline, instructorFirst }) {
  const firstName = instructorFirst ?? "there";
  const cycleDisp = cycleDisplayName(cycle.name);
  const isOne = instructorCamps.length === 1;
  const unit = unitLabel(cycle.cycle_type, instructorCamps.length);
  const oneUnit = unitLabel(cycle.cycle_type, 1);
  const deadlineLine = deadline ? `<br /><br /><strong>Please respond by ${emailFmtDateLong(deadline)}.</strong>` : "";
  const headline = isOne ? `You have another ${oneUnit} to accept` : `You have ${instructorCamps.length} more ${unit} to accept`;
  const intro = isOne
    ? `Good news — another ${oneUnit} just got added to your ${emailEscape(cycleDisp)} schedule. <strong>Please tap Accept or Request change</strong> when you get a moment.`
    : `${instructorCamps.length} more ${unit} just got added to your ${emailEscape(cycleDisp)} schedule. <strong>Please tap Accept or Request change on each one</strong> when you get a moment.`;
  const body = `Hi ${emailEscape(firstName)},<br /><br />${intro}${deadlineLine}<br /><br />${renderCampsTableHtml(instructorCamps, locationsById, EMAIL_BRAND.primary)}`;
  const footer = `Questions? Just reply to this email.<br /><br />— Jessica, ${emailEscape(orgName)}`;
  return emailShellHtml({ orgName, headlineHtml: headline, bodyHtml: body, ctaUrl: portalUrl, ctaSubtitle: `You'll see ${isOne ? `the new ${oneUnit}` : `each new ${oneUnit}`} with an <strong>Accept</strong> and <strong>Request change</strong> button.`, footerHtml: footer, badgeText: cycleDisp });
}

function renderReminderEmailHtml({ instructorCamps, locationsById, cycle, orgName, portalUrl, deadline, instructorFirst }) {
  const firstName = instructorFirst ?? "there";
  const cycleDisp = cycleDisplayName(cycle.name);
  const unit = unitLabel(cycle.cycle_type, instructorCamps.length);
  const headline = `Quick reminder — please respond`;
  const body = `Hi ${emailEscape(firstName)},<br /><br />Just a nudge — your ${emailEscape(cycleDisp)} schedule is still waiting for your response. <strong>Please tap Accept or Request change on each ${unitLabel(cycle.cycle_type, 1)}</strong> by <strong>${emailFmtDateLong(deadline)}</strong>.<br /><br />${renderCampsTableHtml(instructorCamps, locationsById, EMAIL_BRAND.primary)}`;
  const footer = `Already responded? You can ignore this email — sometimes the timing crosses. Questions? Just reply.<br /><br />— Jessica, ${emailEscape(orgName)}`;
  return emailShellHtml({ orgName, headlineHtml: headline, bodyHtml: body, ctaUrl: portalUrl, ctaSubtitle: null, footerHtml: footer });
}

// ---- end email preview renderers ------------------------------------------

// Modal for creating a new scheduling cycle. Replaces "Claude inserts a row by SQL"
// with a self-serve form: term + year + cycle type + date range. Weeks (Mon-Fri)
// are auto-derived from the date range so admin doesn't have to think about them.
// On save: INSERT scheduling_cycles, return new id so the parent can switch to it.
function NewCycleModal({ orgId, onClose, onCreated }) {
  // Smart default for term: pick the next likely term based on today's month.
  // Apr-Aug → Fall; Sep-Oct → Winter; Nov-Jan → Spring; Feb-Mar → Summer.
  const todaysMonth = new Date().getMonth(); // 0=Jan
  const defaultTerm = todaysMonth >= 3 && todaysMonth <= 7 ? "FA"
                    : todaysMonth >= 8 && todaysMonth <= 9 ? "WI"
                    : (todaysMonth >= 10 || todaysMonth <= 0) ? "SP"
                    : "SU";
  const defaultYearTwoDigit = String((new Date().getFullYear() + (todaysMonth >= 10 ? 1 : 0)) % 100).padStart(2, "0");

  const [term, setTerm] = useState(defaultTerm);
  const [year, setYear] = useState(defaultYearTwoDigit);
  const [cycleType, setCycleType] = useState("summer_camp");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [autoReminders, setAutoReminders] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const cycleName = `${term}${year}`;

  // Compute derived weeks (Mon-Fri spans) for the preview chip.
  const derivedWeeks = useMemo(() => {
    if (!startsOn || !endsOn) return [];
    return computeWeeks(startsOn, endsOn);
  }, [startsOn, endsOn]);

  async function save() {
    setError(null);
    if (!/^(SU|FA|WI|SP)$/.test(term)) { setError("Pick a term."); return; }
    if (!/^\d{2}$/.test(year)) { setError("Year should be 2 digits (e.g. 27)."); return; }
    if (!startsOn || !endsOn) { setError("Pick both a start date and an end date."); return; }
    if (startsOn >= endsOn) { setError("End date has to be after start date."); return; }
    if (derivedWeeks.length === 0) { setError("Date range doesn't include any full Mon–Fri weeks."); return; }

    setSaving(true);
    try {
      const { data, error: insErr } = await supabase
        .from("scheduling_cycles")
        .insert({
          organization_id: orgId,
          name: cycleName,
          cycle_type: cycleType,
          starts_on: startsOn,
          ends_on: endsOn,
          status: "collecting",
          weeks: derivedWeeks,
          auto_reminders_enabled: autoReminders,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      onCreated?.(data.id);
    } catch (err) {
      console.error("Create cycle failed:", err);
      const msg = err.message || "Couldn't create cycle.";
      if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) {
        setError(`A cycle named "${cycleName}" already exists. Pick a different term or year.`);
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  const fieldStyle = {
    padding: "8px 10px",
    border: `1px solid ${RULE}`,
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "inherit",
    color: INK,
    background: "#fff",
    outline: "none",
    boxSizing: "border-box",
    width: "100%",
  };

  return (
    <ModalShell onClose={onClose} title="Set up a new cycle">
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          A cycle is one term — a block of camps or after-school classes. Once you set
          one up, you can collect availability surveys, run the matching agent, and
          send offers from the schedule page.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>Term</label>
            <select value={term} onChange={(e) => setTerm(e.target.value)} style={fieldStyle}>
              <option value="SU">Summer</option>
              <option value="FA">Fall</option>
              <option value="WI">Winter</option>
              <option value="SP">Spring</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>Year (2-digit)</label>
            <input type="text" inputMode="numeric" maxLength={2} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="27" style={fieldStyle} />
          </div>
        </div>

        <div style={{ fontSize: 12, color: MUTED }}>
          Cycle code will be <strong style={{ color: INK }}>{cycleName}</strong> — what instructors see in their offer emails.
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>What kind of cycle</label>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { value: "summer_camp", label: "Summer / break camps", hint: "Week-long camps, Mon–Fri" },
              { value: "afterschool",  label: "After-school classes",  hint: "Weekly recurring classes" },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setCycleType(opt.value)}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  background: cycleType === opt.value ? `${PURPLE}10` : "#fff",
                  border: `1px solid ${cycleType === opt.value ? PURPLE : RULE}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: cycleType === opt.value ? PURPLE : INK }}>{opt.label}</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{opt.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>First day of the term</label>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>Last day of the term</label>
            <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} style={fieldStyle} />
          </div>
        </div>

        {derivedWeeks.length > 0 && (
          <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 10, fontSize: 12, color: INK, lineHeight: 1.5 }}>
            <strong>Auto-derived:</strong> {derivedWeeks.length} week{derivedWeeks.length === 1 ? "" : "s"} (Mon–Fri)
            {" — "}
            Week 1: {fmtShort(derivedWeeks[0].starts_on)} – {fmtShort(derivedWeeks[0].ends_on)}
            {derivedWeeks.length > 1 && (
              <>
                {" "}…{" "}
                Week {derivedWeeks.length}: {fmtShort(derivedWeeks[derivedWeeks.length - 1].starts_on)} – {fmtShort(derivedWeeks[derivedWeeks.length - 1].ends_on)}
              </>
            )}
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={autoReminders} onChange={(e) => setAutoReminders(e.target.checked)} />
          <span>
            <strong>Auto-send reminders</strong> 3 days before each deadline (recommended)
          </span>
        </label>

        {error && (
          <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, borderRadius: 6, padding: "8px 12px", color: CORAL, fontWeight: 500, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
      <div style={{ padding: "0 20px 20px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} disabled={saving} style={btn("transparent", MUTED, true, saving)}>Cancel</button>
        <button type="button" onClick={save} disabled={saving} style={btn(PURPLE, "#fff", false, saving)}>
          {saving ? "Setting up…" : "Create cycle"}
        </button>
      </div>
    </ModalShell>
  );
}

// Given a start + end ISO date, generate the list of Mon-Fri weeks fully contained
// in that range. Skips a partial last week if the term ends mid-week. Matches the
// shape stored in scheduling_cycles.weeks (jsonb array of {num, starts_on, ends_on}).
function computeWeeks(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  const cursor = new Date(start);
  const dow = cursor.getDay(); // 0=Sun, 1=Mon, ...
  const daysToMon = (1 - dow + 7) % 7;
  cursor.setDate(cursor.getDate() + daysToMon);

  const weeks = [];
  let num = 1;
  while (cursor <= end) {
    const wStart = new Date(cursor);
    const wEnd = new Date(cursor);
    wEnd.setDate(wEnd.getDate() + 4);
    if (wEnd > end) break;
    weeks.push({
      num,
      starts_on: wStart.toISOString().slice(0, 10),
      ends_on: wEnd.toISOString().slice(0, 10),
    });
    num++;
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

// Cycle-wide email activity log: every offer / patch / reminder / reply that touched
// any assignment in this cycle. Reads directly from instructor_offer_messages —
// send-offers, send-patch-offer, offer-reminders-cron, and offer-message-reply all
// write to that table now, so the timeline is complete without JS-side synthesis.
function EmailActivityModal({ cycleDisplay, cycle, orgName, assignments, sessions, instructors, onClose }) {
  const instructorsById = useMemo(() => {
    const m = new Map();
    for (const i of instructors ?? []) m.set(i.id, i);
    return m;
  }, [instructors]);
  const [rows, setRows] = useState([]);
  const [locationsById, setLocationsById] = useState(new Map());
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("all"); // all | offers | patches | reminders | replies
  const [searchText, setSearchText] = useState("");
  const [expandedRowId, setExpandedRowId] = useState(null);

  const sessionsById = useMemo(() => {
    const m = new Map();
    for (const s of sessions ?? []) m.set(s.id, s);
    return m;
  }, [sessions]);
  const assignmentsById = useMemo(() => {
    const m = new Map();
    for (const a of assignments ?? []) m.set(a.id, a);
    return m;
  }, [assignments]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const ids = (assignments ?? []).map((a) => a.id);
      if (ids.length === 0) { setLoaded(true); return; }
      const [msgRes, locRes] = await Promise.all([
        supabase
          .from("instructor_offer_messages")
          .select("id, camp_assignment_id, sender_role, sender_instructor_id, message, created_at")
          .in("camp_assignment_id", ids)
          .order("created_at", { ascending: false }),
        (async () => {
          const locIds = Array.from(new Set((sessions ?? []).map((s) => s.location_id).filter(Boolean)));
          if (locIds.length === 0) return { data: [] };
          return supabase
            .from("program_locations")
            .select("id, name, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, food_drink_policy, notes")
            .in("id", locIds);
        })(),
      ]);
      if (!alive) return;
      if (msgRes.error) { setRows([]); setLoaded(true); return; }
      setRows(msgRes.data ?? []);
      const locMap = new Map();
      for (const l of locRes.data ?? []) locMap.set(l.id, l);
      setLocationsById(locMap);
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [assignments, sessions]);

  // Classify each message row into a kind (offer / patch / reminder / reply / flag)
  // and compute the instructor name to display (varies for instructor_reply events
  // tagged with a real sender_instructor_id vs the current assignment holder).
  const events = useMemo(() => {
    return rows.map((m) => {
      const role = m.sender_role;
      const text = (m.message || "").toLowerCase();
      let kind;
      if (role === "system" && text.startsWith("reminder email")) kind = "reminder";
      else if (role === "system" && text.startsWith("patch offer")) kind = "patch";
      else if (role === "system" && text.startsWith("offer email")) kind = "offer";
      else if (role === "system" && text.startsWith("deadline passed")) kind = "flag";
      else if (role === "instructor") kind = "instructor_reply";
      else if (role === "admin") kind = "admin_reply";
      else kind = "system_other";

      // Attribute instructor replies to the actual sender (if tagged); for everything
      // else use the current assignment holder so the search box behaves intuitively.
      let displayedName = "";
      if (kind === "instructor_reply" && m.sender_instructor_id) {
        const sender = instructorsById.get(m.sender_instructor_id);
        displayedName = sender ? `${sender.first_name ?? ""}${sender.last_name ? " " + sender.last_name : ""}`.trim() : "";
      } else if (kind === "instructor_reply") {
        displayedName = ""; // historical — render as "Prior instructor" later
      } else {
        const a = assignmentsById.get(m.camp_assignment_id);
        displayedName = a ? `${a.instructor_first ?? ""}${a.instructor_last ? " " + a.instructor_last : ""}`.trim() : "";
      }

      return {
        id: m.id,
        kind,
        sender: role,
        sender_instructor_id: m.sender_instructor_id,
        created_at: m.created_at,
        camp_assignment_id: m.camp_assignment_id,
        message: m.message,
        displayedName,
      };
    });
  }, [rows, instructorsById, assignmentsById]);

  const searchNeedle = searchText.trim().toLowerCase();
  const matchesSearch = (e) => !searchNeedle || (e.displayedName || "").toLowerCase().includes(searchNeedle);

  const filtered = useMemo(() => {
    const kindAllowed = (e) => {
      if (filter === "all") return true;
      const allowed = {
        offers:    new Set(["offer"]),
        patches:   new Set(["patch"]),
        reminders: new Set(["reminder"]),
        replies:   new Set(["admin_reply", "instructor_reply"]),
      }[filter] ?? new Set();
      return allowed.has(e.kind);
    };
    return events.filter((e) => kindAllowed(e) && matchesSearch(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, filter, searchNeedle]);

  // Counts reflect the current search — chips show how many of each kind match
  // the typed name, so admin can scan "Tiffany has 4 offers, 0 patches" at a glance.
  const counts = useMemo(() => {
    const pool = events.filter(matchesSearch);
    return {
      all: pool.length,
      offers: pool.filter((e) => e.kind === "offer").length,
      patches: pool.filter((e) => e.kind === "patch").length,
      reminders: pool.filter((e) => e.kind === "reminder").length,
      replies: pool.filter((e) => e.kind === "admin_reply" || e.kind === "instructor_reply").length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, searchNeedle]);

  function kindPill(kind) {
    const map = {
      offer:             { label: "Offer",            bg: PURPLE,        fg: "#fff" },
      patch:             { label: "Add-on offer",     bg: VIOLET,        fg: PURPLE   },
      reminder:          { label: "Reminder",         bg: `${PURPLE}33`, fg: PURPLE   },
      admin_reply:       { label: "Your message",     bg: `${OK_GREEN}22`, fg: OK_GREEN },
      instructor_reply:  { label: "Instructor reply", bg: `${CHANGE_REQ}22`, fg: CHANGE_REQ },
      flag:              { label: "Deadline flag",    bg: `${CORAL}22`, fg: CORAL },
      system_other:      { label: "System",           bg: CREAM,       fg: MUTED  },
    }[kind] ?? { label: kind, bg: CREAM, fg: MUTED };
    return (
      <span style={{ background: map.bg, color: map.fg, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
        {map.label}
      </span>
    );
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 60, padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 820, height: "85vh", background: "#fff",
        border: `1px solid ${RULE}`, borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${RULE}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>{cycleDisplay}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: INK, marginTop: 2 }}>Email activity</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", fontSize: 22, color: MUTED, cursor: "pointer", padding: 4, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "10px 20px", borderBottom: `1px solid ${RULE}`, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ position: "relative", display: "flex" }}>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search by instructor name…"
              autoComplete="off"
              name="email-activity-search"
              style={{
                flex: 1,
                padding: "8px 32px 8px 12px",
                fontSize: 13,
                fontFamily: "inherit",
                color: INK,
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText("")}
                aria-label="Clear search"
                title="Clear search"
                style={{
                  position: "absolute",
                  right: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  fontSize: 16,
                  color: MUTED,
                  cursor: "pointer",
                  padding: "0 6px",
                  lineHeight: 1,
                }}
              >×</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { key: "all",       label: `All (${counts.all})` },
              { key: "offers",    label: `Offers (${counts.offers})` },
              { key: "patches",   label: `Add-on offers (${counts.patches})` },
              { key: "reminders", label: `Reminders (${counts.reminders})` },
              { key: "replies",   label: `Replies (${counts.replies})` },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  padding: "5px 10px",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  border: `1px solid ${filter === f.key ? PURPLE : RULE}`,
                  background: filter === f.key ? PURPLE : "#fff",
                  color: filter === f.key ? "#fff" : INK,
                  borderRadius: 999,
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "10px 20px 20px" }}>
          {!loaded ? (
            <div style={{ padding: 24, textAlign: "center", color: MUTED, fontSize: 13 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: MUTED, fontSize: 13 }}>
              {searchNeedle
                ? `No email activity matching "${searchText}"${filter !== "all" ? " in this filter" : ""}.`
                : (filter !== "all" ? "No email activity in this filter." : "No email activity yet.")}
            </div>
          ) : (
            filtered.map((e) => {
              const a = assignmentsById.get(e.camp_assignment_id);
              const s = a ? sessionsById.get(a.camp_session_id) : null;
              // For instructor replies, attribute to the actual sender (looked up via
              // sender_instructor_id). For everything else, show the assignment's
              // current holder. Historical instructor replies without a sender_instructor_id
              // render as "Prior instructor" so they're not falsely attributed.
              let who;
              if (e.kind === "instructor_reply") {
                if (e.sender_instructor_id) {
                  const sender = instructorsById.get(e.sender_instructor_id);
                  who = sender ? `${sender.first_name ?? ""}${sender.last_name ? " " + sender.last_name : ""}`.trim() : "Instructor";
                } else {
                  who = "Prior instructor";
                }
              } else {
                who = a ? `${a.instructor_first ?? ""}${a.instructor_last ? " " + a.instructor_last : ""}`.trim() : "(unknown instructor)";
              }
              const where = s ? `${s.curriculum_name ?? "—"} · ${s.location_name ?? "—"} · Wk ${s.week_num}` : "—";
              const previewable = e.kind === "offer" || e.kind === "patch" || e.kind === "reminder";
              const expanded = expandedRowId === e.id;
              return (
                <div key={e.id} style={{
                  padding: "10px 0",
                  borderBottom: `1px solid ${RULE}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}>
                  <div
                    onClick={previewable ? () => setExpandedRowId(expanded ? null : e.id) : undefined}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      cursor: previewable ? "pointer" : "default",
                    }}
                  >
                    {kindPill(e.kind)}
                    <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{who || "(no name)"}</span>
                    <span style={{ fontSize: 12, color: MUTED, marginLeft: "auto" }}>
                      {new Date(e.created_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                    {previewable && (
                      <span style={{ fontSize: 12, color: PURPLE, fontWeight: 500 }}>
                        {expanded ? "Hide email ▲" : "View email ▼"}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: MUTED }}>{where}</div>
                  {e.kind === "instructor_reply" || e.kind === "admin_reply" ? (
                    <div style={{ fontSize: 13, color: INK, marginTop: 2, whiteSpace: "pre-wrap" }}>{e.message}</div>
                  ) : null}
                  {expanded && previewable && (
                    <EmailPreviewPanel
                      event={e}
                      assignment={a}
                      session={s}
                      assignments={assignments}
                      sessions={sessions}
                      sessionsById={sessionsById}
                      locationsById={locationsById}
                      cycle={cycle}
                      orgName={orgName}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// Renders the actual email an instructor saw, inline below a clicked row in
// EmailActivityModal. Looks up the same bundled-camps logic each send function
// uses (one instructor can get several camps in one email when timestamps match).
function EmailPreviewPanel({ event, assignment, session, assignments, sessions, sessionsById, locationsById, cycle, orgName }) {
  if (!assignment || !session || !cycle) {
    return (
      <div style={{ marginTop: 8, padding: 12, border: `1px solid ${RULE}`, borderRadius: 6, background: CREAM, fontSize: 12, color: MUTED }}>
        Couldn't load the camp this email was tied to (the assignment or session was removed).
      </div>
    );
  }

  // The send functions bundle all of an instructor's camps that went out in the same
  // wave. Approximate that here: find assignments for the same instructor where the
  // matching event timestamp is within 60 seconds of this one (typical bulk send).
  const sameInstructorAssignments = (assignments ?? []).filter((a) => a.instructor_id === assignment.instructor_id);
  const ts = new Date(event.created_at).getTime();
  const bundled = sameInstructorAssignments
    .map((a) => ({ a, s: sessionsById.get(a.camp_session_id) }))
    .filter((row) => !!row.s)
    .sort((x, y) => (x.s.starts_on ?? "").localeCompare(y.s.starts_on ?? ""));

  // Filter to camps whose event occurred near this one — best-effort grouping.
  // For reminders / patches: a single event usually maps to a single camp.
  // For offers: bulk send wave shares a millisecond-class timestamp.
  let instructorCamps;
  if (event.kind === "offer") {
    instructorCamps = bundled.filter(({ a }) => {
      if (!a.email_sent_at) return false;
      return Math.abs(new Date(a.email_sent_at).getTime() - ts) < 60_000;
    });
    if (instructorCamps.length === 0) instructorCamps = [{ a: assignment, s: session }];
  } else {
    instructorCamps = [{ a: assignment, s: session }];
  }

  // Recover deadline from the system message text when it ended in "deadline YYYY-MM-DD".
  const deadlineMatch = /deadline\s+(\d{4}-\d{2}-\d{2})/i.exec(event.message || "");
  const deadline = deadlineMatch ? deadlineMatch[1] : assignment.deadline ?? null;

  // Portal URL embedded in the instructor email. Built from the same tenant
  // slug the admin's org uses (org info comes via useOutletContext at the
  // top of the file; threaded down via orgName here -- v1 uses the default
  // tenant. When multi-tenant lands, plumb orgSlug as a prop alongside
  // orgName so this string is per-tenant.)
  const portalUrl = `${window.location.origin}/${defaultTenantSlug()}/instructor`;
  const ctx = {
    assignment,
    instructorCamps,
    locationsById,
    cycle,
    orgName,
    portalUrl,
    deadline,
    instructorFirst: assignment.instructor_first,
  };

  let html;
  if (event.kind === "offer") html = renderOfferEmailHtml(ctx);
  else if (event.kind === "patch") html = renderPatchEmailHtml(ctx);
  else if (event.kind === "reminder") html = renderReminderEmailHtml(ctx);
  else html = "";

  return (
    <div style={{ marginTop: 8, border: `1px solid ${RULE}`, borderRadius: 6, overflow: "hidden", background: CREAM }}>
      <iframe
        title="Email preview"
        srcDoc={html}
        style={{ width: "100%", height: 520, border: "none", background: "#fff" }}
      />
    </div>
  );
}

function PreviewViewer({ data, onClose, onSend, sendLabel, sending }) {
  const previews = data?.preview ?? [];
  const [idx, setIdx] = useState(0);
  if (previews.length === 0) {
    return (
      <ModalShell onClose={onClose} title="Preview">
        <div style={{ padding: 20, color: MUTED, fontSize: 14 }}>
          {data?.note ?? "No confirmed assignments to preview yet. Click Approve first."}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>Close</button>
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
            <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} style={btn("transparent", PURPLE, true, idx === 0)}>‹ Prev</button>
            <button type="button" onClick={() => setIdx((i) => Math.min(previews.length - 1, i + 1))} disabled={idx === previews.length - 1} style={btn("transparent", PURPLE, true, idx === previews.length - 1)}>Next ›</button>
            <button type="button" onClick={onClose} disabled={sending} style={btn("transparent", PURPLE, true, sending)}>Cancel</button>
            {onSend && (
              <button type="button" onClick={onSend} disabled={sending} style={btn(PURPLE, "#fff", false, sending)}>
                {sending ? "Sending…" : (sendLabel ?? "Send")}
              </button>
            )}
            {!onSend && <button type="button" onClick={onClose} style={btn(PURPLE, "#fff")}>Close</button>}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "hidden", background: CREAM, padding: 0 }}>
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
  const border = tone === "danger" ? CORAL : tone === "warn" ? VIOLET : RULE;
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
        maxHeight: "90vh",
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "14px 20px",
          borderBottom: `1px solid ${RULE}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          background: "#fff",
        }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", fontSize: 22, color: MUTED, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function CandidatePicker({
  session, currentAssignment, role = "lead", instructors, availabilityByInstructor,
  locPrefLookup, curPrefLookup, allAssignments,
  declinedInstructorIds = new Set(),
  onClose, onPick, onRemove, onResetAcceptance, onResendOffer, onSendMessage, onCreateInstructor, onUndecline,
}) {
  const declinedInstructors = useMemo(() => {
    if (!declinedInstructorIds || declinedInstructorIds.size === 0) return [];
    return instructors.filter((i) => declinedInstructorIds.has(i.id));
  }, [declinedInstructorIds, instructors]);
  const [declinedExpanded, setDeclinedExpanded] = useState(false);
  const isReassign = !!currentAssignment;
  const currentInstructorId = currentAssignment?.instructor_id ?? null;
  const currentFirstName = currentAssignment?.instructor_first ?? "this instructor";
  const hasBeenEmailed = !!currentAssignment?.email_sent_at;

  // Inline action UI state for the new buttons.
  const [resendArmed, setResendArmed] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgText, setMsgText] = useState("");
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgError, setMsgError] = useState("");
  const [msgSent, setMsgSent] = useState(false);
  const [thread, setThread] = useState([]);

  // Reset inline state when the picker is reused for a different assignment.
  useEffect(() => {
    setResendArmed(false);
    setResendBusy(false);
    setMsgOpen(false);
    setMsgText("");
    setMsgError("");
    setMsgSent(false);
    setThread([]);
  }, [currentAssignment?.id]);

  // Load message thread for the current assignment so admin can see prior
  // back-and-forth with the instructor (offers, reminders, replies, requests).
  // Refetched after each new message send so the admin's reply shows immediately.
  useEffect(() => {
    if (!currentAssignment?.id) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("instructor_offer_messages")
        .select("id, sender_role, sender_instructor_id, message, created_at")
        .eq("camp_assignment_id", currentAssignment.id)
        .order("created_at", { ascending: true });
      if (alive) setThread(data ?? []);
    })();
    return () => { alive = false; };
  }, [currentAssignment?.id, msgSent]);

  async function handleSendMessageClick() {
    if (!msgText.trim() || !onSendMessage) return;
    setMsgBusy(true);
    setMsgError("");
    try {
      const res = await onSendMessage(msgText);
      if (res?.ok) {
        setMsgSent(true);
        setMsgText("");
      } else {
        setMsgError(res?.error ?? "Couldn't send.");
      }
    } finally {
      setMsgBusy(false);
    }
  }
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
      if (declinedInstructorIds.has(inst.id)) continue; // already turned this camp down
      const avail = availabilityByInstructor.get(inst.id);
      if (!avail) continue;
      const sessionTypes = avail.session_types ?? [];
      const availableWeeks = avail.available_weeks ?? [];
      if (!availableWeeks.includes(session.week_num)) continue;
      if (!instructorCoversSessionType(sessionTypes, session.session_type)) continue;
      const conflict = allAssignments.find((a) =>
        a.status !== "withdrawn" &&
        a.id !== currentAssignment?.id &&
        a.instructor_id === inst.id &&
        a.session.week_num === session.week_num &&
        a.session.id !== session.id &&
        classDaysOverlap(a.session.class_days ?? WEEKDAYS, session.class_days ?? WEEKDAYS) &&
        (sessionTimeOverlap(a.session.session_type, session.session_type) ||
         sameDayDifferentLocationConflict(a.session, session))
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
  }, [session, currentAssignment, currentInstructorId, otherRoleInstructorId, instructors, availabilityByInstructor, locPrefLookup, curPrefLookup, allAssignments, declinedInstructorIds]);

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
            background: CREAM,
            borderBottom: `1px solid ${RULE}`,
          }}>
            <div style={{
              padding: "10px 20px",
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
                {onSendMessage && (
                  <button
                    type="button"
                    onClick={() => { setMsgOpen((v) => !v); setMsgSent(false); setMsgError(""); }}
                    title={`Send ${currentFirstName} a message — emails them and saves a copy to the conversation thread`}
                    style={{ ...btn("transparent", PURPLE, true), padding: "5px 10px", fontSize: 12 }}
                  >
                    {msgOpen ? "Cancel message" : `Message ${currentFirstName}`}
                  </button>
                )}
                {onResendOffer && hasBeenEmailed && (
                  <button
                    type="button"
                    onClick={() => setResendArmed(true)}
                    disabled={resendArmed || resendBusy}
                    title={`Resend the offer email for this ${role === "developing" ? "developing slot" : "camp"} — opens preview before sending`}
                    style={{ ...btn("transparent", PURPLE, true), padding: "5px 10px", fontSize: 12, opacity: (resendArmed || resendBusy) ? 0.6 : 1 }}
                  >
                    Resend offer email
                  </button>
                )}
                {currentAssignment.status === "confirmed" && currentAssignment.instructor_response_at && onResetAcceptance && (
                  <button
                    type="button"
                    onClick={onResetAcceptance}
                    title="Set back to 'awaiting response' (use this to clear a test-accept you made via Admin preview)"
                    style={{ ...btn("transparent", VIOLET, true), padding: "5px 10px", fontSize: 12, borderColor: VIOLET }}
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

            {resendArmed && (
              <div style={{
                margin: "0 20px 12px",
                padding: 10,
                background: `${VIOLET}1A`,
                border: `1px solid ${VIOLET}`,
                borderRadius: 6,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}>
                <div style={{ fontSize: 13, color: INK, fontWeight: 600 }}>
                  Resend the offer email to {currentFirstName} for {session.curriculum_name ?? "this camp"} ({session.location_name}, Week {session.week_num})?
                </div>
                <div style={{ fontSize: 12, color: MUTED }}>
                  A fresh email will go out. Their original deadline gets reset to 5 business days from today.
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={async () => { setResendBusy(true); try { await onResendOffer(); } finally { setResendBusy(false); } }}
                    disabled={resendBusy}
                    style={{ ...btn(PURPLE, "#fff", false, resendBusy), padding: "6px 12px", fontSize: 12 }}
                  >
                    {resendBusy ? "Preparing preview…" : `Yes, resend to ${currentFirstName}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setResendArmed(false)}
                    disabled={resendBusy}
                    style={{ ...btn("transparent", MUTED, true), padding: "6px 12px", fontSize: 12 }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {msgOpen && (
              <div style={{
                margin: "0 20px 12px",
                padding: 10,
                background: "#fff",
                border: `1px solid ${PURPLE}`,
                borderRadius: 6,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}>
                <div style={{ fontSize: 13, color: INK, fontWeight: 600 }}>
                  Message {currentFirstName}
                </div>
                {msgSent ? (
                  <div style={{ fontSize: 13, color: OK_GREEN, fontWeight: 500 }}>
                    ✓ Sent. They'll get an email; your message is saved in the conversation thread.
                  </div>
                ) : (
                  <>
                    <textarea
                      value={msgText}
                      onChange={(e) => setMsgText(e.target.value)}
                      placeholder={`e.g., Hi ${currentFirstName}, quick question about your schedule…`}
                      rows={4}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        border: `1px solid ${RULE}`,
                        borderRadius: 6,
                        fontSize: 13,
                        fontFamily: "inherit",
                        color: INK,
                        background: "#fff",
                        boxSizing: "border-box",
                        resize: "vertical",
                      }}
                    />
                    {msgError && <div style={{ color: CORAL, fontSize: 12 }}>{msgError}</div>}
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        onClick={() => { setMsgOpen(false); setMsgText(""); setMsgError(""); }}
                        disabled={msgBusy}
                        style={{ ...btn("transparent", MUTED, true), padding: "6px 10px", fontSize: 12 }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSendMessageClick}
                        disabled={msgBusy || !msgText.trim()}
                        style={{ ...btn(PURPLE, "#fff", false, msgBusy || !msgText.trim()), padding: "6px 12px", fontSize: 12 }}
                      >
                        {msgBusy ? "Sending…" : "Send message"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {thread.length > 0 && (
              <div style={{ padding: "0 20px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Conversation with {currentFirstName}
                </div>
                {thread.map((m) => {
                  const isInstructor = m.sender_role === "instructor";
                  const isSystem = m.sender_role === "system";
                  // Attribute by actual sender when possible. Historical instructor
                  // messages (no sender_instructor_id) on a reassigned row would
                  // otherwise be falsely attributed to the new instructor.
                  let label;
                  if (isInstructor) {
                    if (m.sender_instructor_id === currentAssignment?.instructor_id) {
                      label = currentFirstName;
                    } else if (m.sender_instructor_id) {
                      const sender = instructors.find((i) => i.id === m.sender_instructor_id);
                      label = sender ? sender.first_name : "Instructor";
                    } else {
                      label = "Prior instructor";
                    }
                  } else if (isSystem) {
                    label = "System";
                  } else {
                    label = "You";
                  }
                  return (
                    <div key={m.id} style={{
                      padding: "8px 10px",
                      background: isSystem ? "#f5f3ed" : (isInstructor ? `${CHANGE_REQ}10` : `${PURPLE}10`),
                      border: `1px solid ${isSystem ? RULE : (isInstructor ? `${CHANGE_REQ}40` : `${PURPLE}40`)}`,
                      borderRadius: 6,
                      fontSize: 13,
                      color: INK,
                      lineHeight: 1.45,
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                        {label} · {new Date(m.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.message}</div>
                    </div>
                  );
                })}
              </div>
            )}
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
                    {locPref === "not_preferred" && <Badge color={VIOLET}>Location: not preferred</Badge>}
                    {curPref === "not_preferred" && <Badge color={VIOLET}>Curriculum: not preferred</Badge>}
                    {fullDayCapable && (session.session_type === "morning" || session.session_type === "afternoon") && <Badge color={VIOLET}>Full-day capable</Badge>}
                    {needsConfirmation && <Badge color={VIOLET}>Unconfirmed availability</Badge>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onPick(instructor.id, warningsForBanner)}
                  style={{ ...btn(PURPLE, "#fff"), padding: "7px 12px", fontSize: 13 }}
                >
                  {isReassign ? "Reassign" : "Assign"}
                </button>
              </div>
            ))
          )}

          {declinedInstructors.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${RULE}` }}>
              <button
                type="button"
                onClick={() => setDeclinedExpanded((v) => !v)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: MUTED,
                  fontSize: 12,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  padding: "4px 0",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span>Previously declined this camp ({declinedInstructors.length})</span>
                <span style={{ fontSize: 11 }}>{declinedExpanded ? "▲" : "▼"}</span>
              </button>
              {declinedExpanded && (
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>
                    Recorded because they (or you, after their change request) marked the camp as declined.
                    Click <strong>Re-suggest</strong> if this was a mistake — the instructor will show up in the list above.
                  </div>
                  {declinedInstructors.map((inst) => (
                    <div key={inst.id} style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 10px",
                      background: "#f7f6ef",
                      border: `1px solid ${RULE}`,
                      borderRadius: 6,
                      fontSize: 13,
                      color: INK,
                    }}>
                      <span>{inst.first_name} {inst.last_name ?? ""}</span>
                      {onUndecline && (
                        <button
                          type="button"
                          onClick={() => onUndecline(inst.id)}
                          style={{ ...btn("transparent", PURPLE, true), padding: "4px 10px", fontSize: 11 }}
                        >
                          Re-suggest
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${RULE}`, padding: "10px 14px" }}>
          {!addOpen ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{ ...btn("transparent", PURPLE, true), width: "100%", padding: "8px 12px", fontSize: 13 }}
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
                  style={{ ...btn(PURPLE, "#fff", false, addBusy), padding: "6px 12px", fontSize: 13 }}
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

function Empty({ title, body, tone, action }) {
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
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{ ...btn(PURPLE, "#fff"), marginTop: 16 }}
        >
          {action.label}
        </button>
      )}
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
