// src/pages/admin/Schedule.jsx
// Scheduling Calendar UI — header strip, filter bar, term overview, weekly grid,
// instructor drag-and-drop with hard-block + loud-warning validation.
// Edit drawer + send-offers + multi-week occurrence modal land in follow-up passes.
// Multi-tenant: all data RLS-scoped by org.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../context/AuthContext.jsx";
import { defaultTenantSlug } from "../../lib/tenants.js";
import { fetchOrgTerms } from "../../lib/terms.js";
import { resolveBoardSendIntro } from "../../lib/boardSendCopy.js";
import HatGuide from "../../components/HatGuide";
import Chevron from "../../components/Chevron.jsx";
import NotifyRemovalModal from "./NotifyRemovalModal";
import AssignSubModal from "./AssignSubModal";
import AfterschoolSchedule from "./AfterschoolSchedule";
import ClassScheduleView from "./ClassScheduleView.jsx";
import NeedsCoverBanner from "../../components/NeedsCoverBanner.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
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

// Sub statuses that are "live" — shown on the schedule, counted by the
// instructor filter, and eligible for swap. Excludes declined/missed.
const SUB_SHOWN_STATUSES = new Set(["pending", "confirmed", "taught"]);

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

// Human list of dates: up to 2 shown, then "+N more".
function listDates(dates) {
  const sorted = [...dates].sort();
  if (sorted.length <= 2) return sorted.map(fmtShort).join(" and ");
  return `${fmtShort(sorted[0])}, ${fmtShort(sorted[1])} +${sorted.length - 2} more`;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Which of an instructor's unavailable dates fall inside a camp's week span (on a
// day the camp actually meets). Non-blocking — surfaced as "needs a sub".
function campUnavailableConflicts(av, session) {
  const blackout = Array.isArray(av?.unavailable_dates) ? av.unavailable_dates.map((d) => String(d).slice(0, 10)) : [];
  if (!blackout.length || !session?.starts_on || !session?.ends_on) return [];
  const s = String(session.starts_on).slice(0, 10);
  const e = String(session.ends_on).slice(0, 10);
  // Match the board's render default: a camp with no class_days meets Mon–Fri.
  const classDays = (Array.isArray(session.class_days) && session.class_days.length)
    ? session.class_days.map((x) => String(x).toLowerCase())
    : ["monday", "tuesday", "wednesday", "thursday", "friday"];
  return blackout
    .filter((d) => {
      if (d < s || d > e) return false;
      const wd = WEEKDAY_NAMES[new Date(`${d}T12:00:00`).getDay()];
      return classDays.includes(wd);
    })
    .sort();
}

function addDaysIso(isoDate, n) {
  if (!isoDate || typeof n !== "number" || n < 0) return null;
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
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
  const { user } = useAuth();
  // Test/preview sends route to the logged-in admin's own inbox (the edge fn
  // falls back to the tenant's alert_email if this is missing).
  const testRecipient = user?.email;

  // Time-saved receipt (fire-and-forget, never blocks the action). Same helper and
  // estimates as the after-school board, so the two can't drift into claiming
  // different savings for the same job. Deliberately conservative — an inflated
  // number is a lie the operator can't check.
  function logTimeSaved({ actionType, label, hours, entityType = null, entityId = null }) {
    if (!org?.id || !hours) return;
    supabase
      .from("time_saved_events")
      .insert({
        organization_id: org.id,
        action_type: actionType,
        action_label: label,
        hours_saved: hours,
        related_entity_type: entityType,
        related_entity_id: entityId,
        created_by: user?.id ?? null,
      })
      .then(({ error }) => { if (error) console.warn("[Schedule] time-saved receipt failed:", error.message); });
  }
  const [state, setState] = useState({ status: "loading" });
  const [focusedWeek, setFocusedWeek] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [selectedInstructors, setSelectedInstructors] = useState(() => new Set());
  const [selectedLocations, setSelectedLocations] = useState(() => new Set());
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set());
  const [saveError, setSaveError] = useState(null); // serious-error banner (DB failures only)
  const [busy, setBusy] = useState(null); // "approving" | "sending" | "previewing" | "rematching" | null
  const [offerDialog, setOfferDialog] = useState(null); // { mode: 'choose' | 'result', payload: any }
  // null = send to everyone with a confirmed/proposed assignment in this cycle.
  // Set<instructor_id> = restrict the send to only those instructors. The
  // OfferDialog's choose mode renders an "Advanced: pick instructors" panel
  // that toggles this. Useful for testing (send only to yourself), staged
  // rollouts ("just the new hires this week"), or fixing one specific
  // instructor's offer without re-emailing everyone.
  const [selectedInstructorIds, setSelectedInstructorIds] = useState(null);
  // Patch-offer preview exclusion. When previewing "5 more camps to send"
  // and the admin wants to drop one or more instructors from the send,
  // they tick "Skip this one" on the preview. We track instructor_ids to
  // exclude. handleConfirmPatchSend filters assignment_ids accordingly.
  const [excludedInstructorIds, setExcludedInstructorIds] = useState(() => new Set());
  const [previewData, setPreviewData] = useState(null); // { previews: [...] } from preview mode
  const [offerDeadline, setOfferDeadline] = useState(() => businessDaysFromToday(5));
  const [autoReminders, setAutoReminders] = useState(true);
  const [lastOp, setLastOp] = useState(null); // { type, ... } — supports a single-step undo
  const [candidatesFor, setCandidatesFor] = useState(null); // { session, currentAssignment | null }
  const [assignSubFor, setAssignSubFor] = useState(null); // { session, currentAssignment }
  const [changeRequestFor, setChangeRequestFor] = useState(null); // { session, assignment }
  const [notifyRemoval, setNotifyRemoval] = useState(null); // { mode, session, assignment, instructor, onProceed }
  const [offerNewPrompt, setOfferNewPrompt] = useState(null); // { assignmentId, name, sessionLabel } — nudge to email a freshly-assigned instructor
  // When user reassigns from a change-request modal, we stash the request's id so the
  // candidate-picker's onPick can auto-advance to the next change request afterward.
  const [reassigningChangeRequestId, setReassigningChangeRequestId] = useState(null);
  const [emailActivityOpen, setEmailActivityOpen] = useState(false);
  const [newCycleOpen, setNewCycleOpen] = useState(false);
  // Open-survey dialog state. mode 'choose' shows the preview/test/send buttons +
  // optional deadline picker; mode 'result' shows the send outcome.
  const [surveyDialog, setSurveyDialog] = useState(null); // { mode: 'choose' | 'result', payload: any }
  const [orgSurveyIntro, setOrgSurveyIntro] = useState(""); // operator's saved default camp intro (org_survey_config)
  const [surveyIntro, setSurveyIntro] = useState(""); // editable lead paragraph for this send
  const [orgOfferIntro, setOrgOfferIntro] = useState(""); // operator's saved default offer intro (automations body_override)
  const [offerIntro, setOfferIntro] = useState(""); // editable intro for the current offer send
  const [surveySelectedIds, setSurveySelectedIds] = useState(null); // Set<id> recipients | null = all emailable
  const [surveyDeadline, setSurveyDeadline] = useState(() => businessDaysFromToday(10));
  // Term/cycle picker — list of all non-archived cycles for this org + the currently
  // viewed one. selectedCycleId=null means "use the latest one I find" (default).
  const [allCycles, setAllCycles] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState(null);
  // After-school terms run on the same /admin/schedule page via a unified term
  // selector. scheduleMode 'afterschool' short-circuits the entire camp UI and
  // renders <AfterschoolSchedule> instead. afterschoolTerms is the distinct list
  // of term codes this org has programs or an open survey for.
  const [afterschoolTerms, setAfterschoolTerms] = useState([]);
  // Org's default term (in-progress today, else next starting, else most recent
  // past) from org_terms. Used to pick which after-school term to land on when
  // the operator switches into after-school mode, instead of just the first/
  // most-recent discovered term.
  const [defaultAfterschoolTerm, setDefaultAfterschoolTerm] = useState(null);
  const [scheduleMode, setScheduleMode] = useState("camp"); // "camp" | "afterschool"
  const [selectedTerm, setSelectedTerm] = useState(null); // afterschool term code, e.g. "FA26"
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
        .eq("cycle_type", "summer_camp")
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
        .select("id, location_name, week_num, session_type, curriculum_category, curriculum_name, start_time, end_time, current_enrollment, enrollment_synced_at, class_days, status, starts_on, ends_on")
        .eq("cycle_id", cycle.id)
        .eq("status", "active")
        .order("location_name", { ascending: true });
      if (sessionsRes.error) throw sessionsRes.error;
      const sessions = sessionsRes.data ?? [];
      const sessionIds = sessions.map((s) => s.id);

      const [assignmentsRes, instructorsRes, availabilityRes, locPrefRes, curPrefRes, declinesRes, cfgRes] = await Promise.all([
        sessionIds.length
          ? supabase
              .from("camp_assignments")
              .select("id, camp_session_id, status, role, change_request_message, distance_bonus_cents, flags, instructor_response_at, flagged_reason, email_sent_at, instructor:instructors(id, first_name, last_name, email)")
              .in("camp_session_id", sessionIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("instructors")
          .select("id, first_name, last_name, preferred_name, email")
          .eq("organization_id", org.id)
          .eq("is_active", true)
          .order("first_name", { ascending: true }),
        supabase
          .from("instructor_availability")
          .select("instructor_id, session_types, available_weeks, needs_confirmation, notes, unavailable_dates, submitted_at")
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
        // Operator's saved survey config — the default camp intro used when the
        // survey email goes out. Non-critical: a missing row = no saved default.
        supabase
          .from("org_survey_config")
          .select("intro")
          .eq("organization_id", org.id)
          .eq("context", "camp")
          .maybeSingle(),
      ]);
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (instructorsRes.error) throw instructorsRes.error;
      if (availabilityRes.error) throw availabilityRes.error;
      if (locPrefRes.error) throw locPrefRes.error;
      if (curPrefRes.error) throw curPrefRes.error;
      if (declinesRes.error) throw declinesRes.error;
      setOrgSurveyIntro(cfgRes?.data?.intro ?? "");

      // Operator's saved default intros for the board sends, authored in
      // Comms > Automations > Instructors (automations.body_override). Each takes
      // priority over the fallback set just above (survey: org_survey_config;
      // offer: the edge fn's per-instructor default). Shared resolver so the four
      // board copies (survey/offer × camp/after-school) stay in one place.
      const savedSurveyIntro = await resolveBoardSendIntro(supabase, org.id, "availability_survey");
      if (savedSurveyIntro) setOrgSurveyIntro(savedSurveyIntro);
      const savedOfferIntro = await resolveBoardSendIntro(supabase, org.id, "assignment_offer");
      if (savedOfferIntro) setOrgOfferIntro(savedOfferIntro);

      // Load substitutions for all camp assignments so the grid can show sub indicators.
      const assignmentIds = (assignmentsRes.data ?? []).map((a) => a.id);
      let substitutions = [];
      if (assignmentIds.length > 0) {
        const { data: subRows, error: subErr } = await supabase
          .from("assignment_substitutions")
          .select("id, parent_assignment_id, date, status, sub_tier, sub_instructor_id, sub:instructors!sub_instructor_id(first_name, last_name)")
          .eq("parent_assignment_type", "camp")
          .in("parent_assignment_id", assignmentIds);
        if (subErr) console.warn("[Schedule] sub load failed:", subErr.message);
        else substitutions = subRows ?? [];
      }

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

      // Index subs by "assignmentId:date" for O(1) lookup in the grid.
      const subsByKey = new Map();
      for (const s of substitutions) {
        subsByKey.set(`${s.parent_assignment_id}:${s.date}`, s);
      }

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
        subsByKey,
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

  // Discover which after-school terms this org has so the term selector can offer
  // them. Union of programs.term and afterschool_survey_state.term. Independent of
  // the camp load so it works even when there are no camp cycles yet.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!org?.id) return;
      const [progRes, surveyRes, cycleRes] = await Promise.all([
        supabase.from("programs").select("term").eq("organization_id", org.id).not("term", "is", null),
        supabase.from("afterschool_survey_state").select("term").eq("organization_id", org.id),
        supabase.from("scheduling_cycles").select("name").eq("organization_id", org.id).eq("cycle_type", "afterschool").neq("status", "archived"),
      ]);
      if (!alive) return;
      const terms = new Set();
      (progRes.data ?? []).forEach((r) => { if (r.term) terms.add(r.term); });
      (surveyRes.data ?? []).forEach((r) => { if (r.term) terms.add(r.term); });
      (cycleRes.data ?? []).forEach((r) => { if (r.name) terms.add(r.name); });
      // Chronological order (e.g. Fall 2026 -> Winter 2027 -> Spring 2027), not alphabetical.
      const SEASON_MONTH = { SU: 6, FA: 9, WI: 1, SP: 4 };
      const termSortKey = (code) => {
        const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code || "");
        if (!m) return 0;
        return (2000 + parseInt(m[2], 10)) * 100 + (SEASON_MONTH[m[1]] || 0);
      };
      const sortedTerms = [...terms].sort((a, b) => termSortKey(a) - termSortKey(b));
      setAfterschoolTerms(sortedTerms);

      // Resolve the org's default term so after-school mode lands on the current
      // term. Keep the data-discovered list above as the source of options; only
      // use org_terms to choose the default. Fall back to the existing behavior
      // (first discovered term) if the org default isn't among the after-school
      // terms (e.g. the default term has no programs yet).
      const { defaultTerm } = await fetchOrgTerms(org.id);
      if (!alive) return;
      const firstDiscovered = sortedTerms.length ? sortedTerms[0] : null;
      setDefaultAfterschoolTerm(
        defaultTerm && sortedTerms.includes(defaultTerm) ? defaultTerm : firstDiscovered,
      );
    })();
    return () => { alive = false; };
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
      // Date-specific unavailability flagged by the assigned lead/developing that
      // lands inside this camp's week — surfaced on the card as "needs a sub".
      const leadA = ownActive.find((a) => a.role === "lead") ?? null;
      const devA = ownActive.find((a) => a.role === "developing") ?? null;
      const leadSubNeeded = leadA ? campUnavailableConflicts(availMap.get(leadA.instructor_id), s) : [];
      const devSubNeeded = devA ? campUnavailableConflicts(availMap.get(devA.instructor_id), s) : [];
      byId.set(s.id, { session: s, status, assignment: lead, allAssignments: own, activeAssignments: ownActive, leadSubNeeded, devSubNeeded });
    }
    return byId;
  }, [state]);

  // sessionId -> { ids:Set<instructor_id>, names:string[] } for live subs.
  // Lets the instructor filter/search surface a person on weeks they only SUB
  // (the lead/developing assignments are the only thing matchesFilters saw before).
  const subInfoBySession = useMemo(() => {
    const m = new Map();
    if (state.status !== "ready" || !enriched) return m;
    const asgToSession = new Map();
    for (const e of enriched.values()) {
      for (const a of e.allAssignments) asgToSession.set(a.id, e.session.id);
    }
    for (const s of (state.subsByKey ? state.subsByKey.values() : [])) {
      if (!SUB_SHOWN_STATUSES.has(s.status)) continue;
      const sid = asgToSession.get(s.parent_assignment_id);
      if (!sid) continue;
      if (!m.has(sid)) m.set(sid, { ids: new Set(), names: [] });
      const entry = m.get(sid);
      if (s.sub_instructor_id) entry.ids.add(s.sub_instructor_id);
      const nm = [s.sub?.first_name, s.sub?.last_name].filter(Boolean).join(" ");
      if (nm) entry.names.push(nm);
    }
    return m;
  }, [state, enriched]);

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
    const subInfo = subInfoBySession.get(e.session.id);
    if (selectedInstructors.size) {
      const ids = e.activeAssignments.map((a) => a.instructor_id).filter(Boolean);
      let hit = ids.some((id) => selectedInstructors.has(id));
      if (!hit && subInfo?.ids) {
        for (const id of subInfo.ids) { if (selectedInstructors.has(id)) { hit = true; break; } }
      }
      if (!hit) return false;
    }
    if (q) {
      const haystack = [
        e.session.curriculum_name, e.session.curriculum_category, e.session.session_type, e.session.location_name,
        ...e.activeAssignments.flatMap((a) => [a.instructor_first, a.instructor_last]),
        ...(subInfo?.names ?? []),
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
    // Needs-hire is per OPEN SLOT, matching the coral "Needs hire" badges on the
    // cards: a camp always needs a lead, and a camp with >= DEVELOPING_THRESHOLD
    // enrolled also wants a developing instructor. Count each unfilled slot so the
    // header agrees with what's visible on the board. (Was session-level — only
    // counted camps with ZERO assignments, so a filled-lead/empty-developing camp
    // read as 0 needs-hire while the card showed a coral "Needs hire".)
    let needsHire = 0;
    if (enriched) {
      for (const e of enriched.values()) {
        const active = e.activeAssignments ?? [];
        const hasLead = active.some((a) => a.role === "lead");
        const hasDeveloping = active.some((a) => a.role === "developing");
        const wantsDeveloping = (e.session.current_enrollment ?? 0) >= DEVELOPING_THRESHOLD;
        if (!hasLead) needsHire++;
        if (wantsDeveloping && !hasDeveloping) needsHire++;
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
          onClick: () => openSurvey(),
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
          onClick: () => openOfferDialog(),
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
      const bucket = m.get(wn);
      // Primary dot: the camp's overall (lead) status. Already 'needs_hire'
      // (coral) when the camp has zero instructors.
      bucket.push(e.status);
      // Slot-aware coral dots so the board matches the header "Needs hire"
      // counter, which counts unfilled LEAD + DEVELOPING slots — not whole
      // empty camps. Without this, a camp with its lead but missing the
      // developing co-instructor it wants (enrollment >= threshold) showed a
      // green dot while the header read "1 needs hire". One coral per gap:
      const active = e.activeAssignments ?? [];
      const hasLead = active.some((a) => a.role === "lead");
      const hasDeveloping = active.some((a) => a.role === "developing");
      const wantsDeveloping = (e.session.current_enrollment ?? 0) >= DEVELOPING_THRESHOLD;
      // Has assignments but no lead — primary dot won't be coral, so add one.
      if (!hasLead && active.length > 0) bucket.push("needs_hire");
      // Big-enough camp missing its developing co-instructor.
      if (wantsDeveloping && !hasDeveloping) bucket.push("needs_hire");
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

  // Outside-registration tenants: their families register elsewhere, so there's no
  // term/camp machinery — scheduling IS the uploaded weekly class_schedule, and
  // instructors are assigned right here (the platform's one place to assign).
  if (org && org.uses_enrops_registration === false) {
    return (
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ color: INK, fontSize: 24, fontWeight: 800, margin: "0 0 6px" }}>Schedule</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: 0, lineHeight: 1.5 }}>
            Your weekly classes and who teaches them. Assign a coach to each class below.
            Add or change classes under{" "}
            <Link to="/admin/class-schedule" style={{ color: BRIGHT, fontWeight: 600 }}>Class schedule</Link>.
          </p>
        </div>
        <ClassScheduleView orgId={org.id} assignable />
      </div>
    );
  }

  // After-school mode short-circuits the entire camp UI. The afterschool component
  // renders its own header with the unified term selector (camp cycles + terms).
  if (scheduleMode === "afterschool" && selectedTerm) return (
    <AfterschoolSchedule
      org={org}
      term={selectedTerm}
      campCycles={allCycles}
      afterschoolTerms={afterschoolTerms}
      onSwitchTerm={(t) => setSelectedTerm(t)}
      onSwitchToCamp={(cid) => { setScheduleMode("camp"); setSelectedCycleId(cid); }}
    />
  );

  if (state.status === "loading") return <div style={{ color: MUTED, fontSize: 14 }}>Loading schedule…</div>;
  if (state.status === "empty") return (
    <>
      <Empty
        title="No active cycle yet"
        body="A scheduling cycle is one term of camps or classes (e.g. SU26, FA26). Create one to start matching instructors to programs."
        action={{ label: "+ Create your first cycle", onClick: () => setNewCycleOpen(true) }}
      />
      {afterschoolTerms.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            onClick={() => { setScheduleMode("afterschool"); setSelectedTerm(defaultAfterschoolTerm ?? afterschoolTerms[0]); }}
            style={{
              background: BRIGHT, color: "#fff", border: "none", borderRadius: 8,
              padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            View after-school schedule ({cycleDisplayName(defaultAfterschoolTerm ?? afterschoolTerms[0])})
          </button>
        </div>
      )}
      {newCycleOpen && (
        <NewCycleModal
          orgId={org?.id}
          onClose={() => setNewCycleOpen(false)}
          onCreated={(c) => {
            setNewCycleOpen(false);
            if (c.cycle_type === "afterschool") { setScheduleMode("afterschool"); setSelectedTerm(c.name); }
            else { setSelectedCycleId(c.id); }
          }}
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
    // Reassignment of a previously-emailed instructor: pause to let admin
    // preview a removal notice for the displaced instructor before the UPDATE
    // (which wipes their email trail). New instructor doesn't change here.
    if (
      currentAssignment &&
      currentAssignment.email_sent_at &&
      currentAssignment.instructor_id &&
      currentAssignment.instructor_id !== instructorId
    ) {
      const displaced = state.instructors.find((i) => i.id === currentAssignment.instructor_id);
      setNotifyRemoval({
        mode: "reassign",
        session: targetSession,
        assignment: currentAssignment,
        instructor: displaced,
        onProceed: async () => {
          setNotifyRemoval(null);
          await doPick(targetSession, currentAssignment, instructorId, role);
        },
      });
      return;
    }
    await doPick(targetSession, currentAssignment, instructorId, role);
  }

  async function doPick(targetSession, currentAssignment, instructorId, role = "lead") {
    // Capture before the mutation: have any offers in this cycle already gone out?
    // If so, the new instructor won't be swept up in a future bulk send and needs
    // their own patch offer — so we'll nudge to email them right after the swap.
    const cycleMidFlight =
      state.status === "ready" && state.assignments.some((a) => a.email_sent_at);
    try {
      let newAssignmentId = null;
      if (currentAssignment) {
        const prevInstructorId = currentAssignment.instructor_id;
        const prevStatus = currentAssignment.status;
        // If the outgoing instructor had flagged a change request, record the
        // decline BEFORE we overwrite the row — otherwise reassigning silently
        // discards it and the picker keeps re-suggesting them for this camp.
        // Mirrors the same record in doRemoveAssignment (the Remove button); the
        // `!== instructorId` guard means re-confirming the same person is not a
        // self-decline.
        if (prevStatus === "change_requested" && prevInstructorId && prevInstructorId !== instructorId) {
          await supabase
            .from("session_declined_instructors")
            .upsert({
              organization_id: org.id,
              cycle_id: state.cycle.id,
              camp_session_id: currentAssignment.camp_session_id,
              instructor_id: prevInstructorId,
              reason: "change_request",
            }, { onConflict: "camp_session_id,instructor_id" });
        }
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
        newAssignmentId = currentAssignment.id;
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
        newAssignmentId = inserted.id;
        setLastOp({
          type: "assign",
          assignmentId: inserted.id,
          label: `Assigned ${role} on ${targetSession.location_name}, wk ${targetSession.week_num}`,
        });
      }

      setCandidatesFor(null);
      await loadAll();

      // Consistent nudge: this cycle's offers already went out, so the instructor
      // just dropped in won't be emailed by a future bulk send. Offer to send their
      // patch offer now (works directly on the draft row); "Later" leaves them in
      // the Hat's "needs an offer email" tip.
      if (cycleMidFlight && newAssignmentId) {
        const inst = state.instructors.find((i) => i.id === instructorId);
        setOfferNewPrompt({
          assignmentId: newAssignmentId,
          name: inst
            ? inst.preferred_name || inst.first_name || "this instructor"
            : "this instructor",
          sessionLabel: `${targetSession.location_name}, week ${targetSession.week_num}`,
        });
      }
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
    // If we already informed this instructor (email_sent_at set), pause to let
    // the admin preview a "no longer on your schedule" notice before deleting.
    // The deletion is silent at the DB layer (UNIQUE(session,role) forces DELETE
    // over UPDATE 'withdrawn'), so the instructor only learns via this email.
    if (currentAssignment.email_sent_at && currentAssignment.instructor_id) {
      const instructor = state.instructors.find((i) => i.id === currentAssignment.instructor_id);
      setNotifyRemoval({
        mode: "remove",
        session: targetSession,
        assignment: currentAssignment,
        instructor,
        onProceed: async () => {
          setNotifyRemoval(null);
          await doRemoveAssignment(targetSession, currentAssignment);
        },
      });
      return;
    }
    await doRemoveAssignment(targetSession, currentAssignment);
  }

  async function doRemoveAssignment(targetSession, currentAssignment) {
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
      // ~6 min per camp to place by hand: availability, region preference,
      // double-booking and week caps across the whole roster.
      const placed = Number(data?.summary?.assigned ?? data?.assigned ?? 0);
      if (placed > 0) {
        logTimeSaved({
          actionType: "camp_matched",
          label: `Matched ${placed} camp${placed === 1 ? "" : "s"} for ${cycleDisplayName(state.cycle.name)}`,
          hours: Math.round(placed * 0.1 * 100) / 100,
        });
      }
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
      // ~1 min per camp to sign off one by one.
      if (flippedIds.length > 0) {
        logTimeSaved({
          actionType: "camp_matches_approved",
          label: `Approved ${flippedIds.length} camp ${flippedIds.length === 1 ? "match" : "matches"} for ${cycleDisplayName(state.cycle.name)}`,
          hours: Math.round(flippedIds.length * 0.017 * 100) / 100,
        });
      }
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
      // selectedInstructorIds: null means "everyone with assignments in this
      // cycle"; a Set means "only this subset". Convert Set -> array for the
      // edge function payload.
      const idsPayload = selectedInstructorIds ? Array.from(selectedInstructorIds) : null;
      const { data, error } = await supabase.functions.invoke("send-offers", {
        body: { cycle_id: state.cycle.id, mode, instructor_ids: idsPayload, deadline: offerDeadline, test_recipient: testRecipient, intro_message: offerIntro.trim() || null },
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
      // ~8 min per instructor to write and send their camp schedule by hand. Only a
      // real send that reached someone counts — a preview or test saves nothing, and a
      // 0-sent run saved nothing either.
      if (mode === "send") {
        const sentCount = Number(data?.sent ?? 0);
        if (sentCount > 0) {
          logTimeSaved({
            actionType: "camp_offers_sent",
            label: `Emailed ${sentCount} instructor${sentCount === 1 ? "" : "s"} their ${cycleDisplayName(state.cycle.name)} camp offer`,
            hours: Math.round(sentCount * 0.133 * 100) / 100,
          });
        }
      }
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

  // In-app preview: renders the real offer email(s) without sending. Returns
  // [{ instructor_id, to, subject, html, text }].
  async function previewOffers() {
    if (state.status !== "ready") return [];
    const idsPayload = selectedInstructorIds ? Array.from(selectedInstructorIds) : null;
    const { data, error } = await supabase.functions.invoke("send-offers", {
      body: { cycle_id: state.cycle.id, mode: "preview", instructor_ids: idsPayload, deadline: offerDeadline, test_recipient: testRecipient, intro_message: offerIntro.trim() || null },
    });
    if (error) {
      let realMsg = error.message ?? "function error";
      try { const body = await error.context?.json?.(); if (body?.error) realMsg = body.error; } catch {}
      throw new Error(realMsg);
    }
    if (data?.error) throw new Error(data.error);
    return data.preview || [];
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
        body: { dry_run: dryRun, scope: "camp" },
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

  // Built-in fallback intro when the operator hasn't saved a default. Matches
  // the edge fn's own default copy so an unchanged send reads the same.
  function builtinCampIntro() {
    return `We're planning the ${cycleDisplayName(state.cycle?.name)} schedule and want to know when and where you'd like to work.`;
  }

  function openOfferDialog() {
    // Seed from the operator's saved default only. When they haven't saved one we
    // leave it blank so the send passes intro_message: null and the edge fn builds
    // each instructor's personalized intro (their own camp count + cycle dates) —
    // a single shared string here can't carry per-instructor counts.
    setOfferIntro(orgOfferIntro.trim());
    setOfferDialog({ mode: "choose", payload: null });
  }

  // Open the survey drawer. Seed the intro from the operator's saved default
  // (else the built-in copy) and pre-select recipients: never sent → all
  // emailable instructors; already open → only the non-responders (the
  // straggler / new-hire nudge). Only emailable instructors are selectable.
  function openSurvey() {
    if (state.status !== "ready") return;
    const submitted = new Set((state.availability ?? []).filter((a) => a.submitted_at).map((a) => a.instructor_id));
    const alreadyOpen = !!state.cycle.availability_survey_opened_at;
    const preselect = state.instructors
      .filter((i) => !!i.email)
      .filter((i) => (alreadyOpen ? !submitted.has(i.id) : true))
      .map((i) => i.id);
    setSurveySelectedIds(new Set(preselect));
    setSurveyIntro(orgSurveyIntro.trim() || builtinCampIntro());
    // Restore the cycle's existing deadline on a re-send (blank stays blank);
    // default to +10 business days only on a first open. Without this, reopening
    // the drawer to nudge stragglers would silently reset the deadline to +10 and
    // email the wrong date on send. Mirrors the after-school openSurvey.
    setSurveyDeadline(alreadyOpen
      ? (state.cycle.survey_deadline ? String(state.cycle.survey_deadline).slice(0, 10) : "")
      : businessDaysFromToday(10));
    setSurveyDialog({ mode: "choose", payload: null });
  }

  // Emailable recipients actually targeted by a real send: selected ∩ has-email.
  function surveyRecipientIds() {
    if (state.status !== "ready") return [];
    return state.instructors
      .filter((i) => !!i.email && (surveySelectedIds ? surveySelectedIds.has(i.id) : true))
      .map((i) => i.id);
  }

  // Release the availability survey to instructors. mode 'preview' returns the
  // rendered email for review without sending; mode 'send' actually emails the
  // selected instructors and flips availability_survey_opened_at on the cycle so
  // the portal banner unlocks. Deadline (optional) writes to survey_deadline.
  async function handleSendSurvey(mode) {
    if (state.status !== "ready") return;
    // Target the selected instructors on a real send. Preview/test don't need a
    // recipient list (preview renders one sample; test goes to the caller).
    const ids = mode === "send" ? surveyRecipientIds() : null;
    // Safety: never let a real send fall through to "everyone". The edge fn treats
    // a missing instructor_ids as all-active, so an empty selection must hard-stop
    // here rather than rely on the button's disabled state alone.
    if (mode === "send" && (!ids || ids.length === 0)) {
      setSaveError("Pick at least one instructor before sending the survey.");
      setTimeout(() => setSaveError(null), 6000);
      return;
    }
    setBusy("sending_survey");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-availability-survey", {
        body: {
          cycle_id: state.cycle.id,
          mode,
          deadline: surveyDeadline || null,
          app_base_url: window.location.origin,
          // Edited intro for this send (seeded from the operator's saved default).
          // Blank = the edge fn's built-in copy.
          intro: surveyIntro.trim() || null,
          ...(ids && ids.length > 0 ? { instructor_ids: ids } : {}),
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
      const idsPayload = selectedInstructorIds ? Array.from(selectedInstructorIds) : null;
      const { data, error } = await supabase.functions.invoke("send-offers", {
        body: { cycle_id: state.cycle.id, mode: "preview", instructor_ids: idsPayload, deadline: offerDeadline, test_recipient: testRecipient, intro_message: offerIntro.trim() || null },
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
    // Drop assignments whose instructor is excluded via the preview's
    // "skip this one" toggle. assignmentInstructorMap is built from
    // state.assignments which has both ids loaded.
    const assignmentInstructorMap = new Map(
      (state?.assignments ?? []).map((a) => [a.id, a.instructor_id])
    );
    const filteredIds = ids.filter((id) => {
      const inst = assignmentInstructorMap.get(id);
      return inst && !excludedInstructorIds.has(inst);
    });
    if (filteredIds.length === 0) {
      setSaveError("Nothing to send — every preview was skipped.");
      setTimeout(() => setSaveError(null), 6000);
      return;
    }
    setBusy("patching");
    setSaveError(null);
    try {
      const { data, error } = await supabase.functions.invoke("send-patch-offer", {
        body: { assignment_ids: filteredIds, mode: "send" },
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
        afterschoolTerms={afterschoolTerms}
        onSwitchCycle={setSelectedCycleId}
        onSwitchToAfterschool={(t) => { setScheduleMode("afterschool"); setSelectedTerm(t); }}
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
        onSurveyClick={() => openSurvey()}
        onSendClick={() => openOfferDialog()}
        onPreviewClick={handlePreviewOffers}
        onRerunAgent={handleRerunAgent}
        onRemindersClick={() => setOfferDialog({ mode: "reminders_choose", payload: null })}
        nextReminders={nextRemindersForecast}
        onOpenEmailActivity={() => setEmailActivityOpen(true)}
        onArchiveCycle={handleArchiveCycle}
        onUnarchiveCycle={handleUnarchiveCycle}
      />
      <NeedsCoverBanner org={org} parentType="camp" />
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
          subsByKey={state.subsByKey}
          getValidationFor={getValidationFor}
          dragStateRef={dragStateRef}
          onDrop={handleDrop}
          onNeedsHireClick={(session) => setCandidatesFor({ session, currentAssignment: null, role: "lead" })}
          onInstructorClick={(session, currentAssignment, roleHint, dayDate) => setCandidatesFor({
            session,
            currentAssignment,
            role: currentAssignment?.role ?? roleHint ?? "lead",
            dayDate: dayDate ?? null,
          })}
          onSubClick={(session, parentAssignment, dayDate) => setAssignSubFor({
            session,
            currentAssignment: parentAssignment,
            defaultDate: dayDate ?? null,
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
          onClose={() => { setOfferDialog(null); setSelectedInstructorIds(null); }}
          busy={busy === "sending"}
          deadline={offerDeadline}
          onDeadlineChange={setOfferDeadline}
          autoReminders={autoReminders}
          onAutoRemindersChange={setAutoReminders}
          intro={offerIntro}
          onIntroChange={setOfferIntro}
          defaultIntro={orgOfferIntro.trim()}
          publishedCount={state.assignments?.filter((a) => a.status === "published").length ?? 0}
          onRollback={handleRollback}
          rollingBack={busy === "rolling_back"}
          onRunReminders={handleRunReminders}
          remindersBusy={busy === "reminders"}
          eligibleInstructors={(() => {
            // Build a unique, sorted list of instructors who have any
            // proposed/confirmed assignment in this cycle. These are the
            // people who'd get an email on a send. Used to render the
            // "pick instructors" picker.
            if (!state?.assignments || !state?.instructors) return [];
            const idsWithAssignments = new Set(
              state.assignments
                .filter((a) => ["proposed", "confirmed", "published"].includes(a.status))
                .map((a) => a.instructor_id)
            );
            return state.instructors
              .filter((i) => idsWithAssignments.has(i.id))
              .map((i) => ({
                id: i.id,
                name: `${i.preferred_name || i.first_name || ""} ${i.last_name || ""}`.trim() || i.email || "Unnamed",
                email: i.email,
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
          })()}
          selectedInstructorIds={selectedInstructorIds}
          onSelectedInstructorIdsChange={setSelectedInstructorIds}
          onPreview={previewOffers}
        />
      )}
      {newCycleOpen && (
        <NewCycleModal
          orgId={org?.id}
          onClose={() => setNewCycleOpen(false)}
          onCreated={(c) => {
            setNewCycleOpen(false);
            if (c.cycle_type === "afterschool") { setScheduleMode("afterschool"); setSelectedTerm(c.name); }
            else { setSelectedCycleId(c.id); }
          }}
        />
      )}
      {surveyDialog && (
        <SurveyDialog
          dialog={surveyDialog}
          cycleDisplay={cycleDisplayName(cycle.name)}
          instructors={state.instructors}
          availability={state.availability}
          alreadyOpen={!!cycle.availability_survey_opened_at}
          selectedIds={surveySelectedIds}
          setSelectedIds={setSurveySelectedIds}
          intro={surveyIntro}
          setIntro={setSurveyIntro}
          defaultIntro={orgSurveyIntro.trim() || builtinCampIntro()}
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
          onClose={() => { setPreviewData(null); setExcludedInstructorIds(new Set()); }}
          onSend={previewData.patchAssignmentIds ? handleConfirmPatchSend : undefined}
          sendLabel={(() => {
            if (!previewData.patchAssignmentIds) return undefined;
            const total = previewData.preview?.length ?? 0;
            const included = Math.max(0, total - excludedInstructorIds.size);
            if (included === 0) return "Nothing to send";
            return included === 1 ? "Send this offer" : `Send ${included} offers`;
          })()}
          excludedInstructorIds={excludedInstructorIds}
          onToggleExclude={previewData.patchAssignmentIds ? (instructorId) => {
            setExcludedInstructorIds((cur) => {
              const next = new Set(cur);
              if (next.has(instructorId)) next.delete(instructorId);
              else next.add(instructorId);
              return next;
            });
          } : undefined}
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
          onAssignSub={() => {
            const armed = {
              session: candidatesFor.session,
              currentAssignment: candidatesFor.currentAssignment,
              defaultDate: candidatesFor.dayDate ?? null,
            };
            setCandidatesFor(null);
            setAssignSubFor(armed);
          }}
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
      {assignSubFor && (
        <AssignSubModal
          parentAssignment={assignSubFor.currentAssignment}
          parentType="camp"
          sessionInfo={{
            curriculum_name: assignSubFor.session?.curriculum_name,
            location_name: assignSubFor.session?.location_name,
            starts_on: assignSubFor.session?.starts_on,
            ends_on: assignSubFor.session?.ends_on,
            week_num: assignSubFor.session?.week_num,
          }}
          defaultDate={assignSubFor.defaultDate}
          organizationId={org?.id}
          instructors={state.instructors}
          onClose={() => setAssignSubFor(null)}
          onSubmitted={() => {
            loadAll();
          }}
        />
      )}
      {notifyRemoval && (
        <NotifyRemovalModal
          mode={notifyRemoval.mode}
          instructor={notifyRemoval.instructor}
          assignment={notifyRemoval.assignment}
          session={notifyRemoval.session}
          org={org}
          remainingActiveCount={
            state.assignments.filter(
              (a) =>
                a.instructor_id === notifyRemoval.assignment.instructor_id &&
                a.id !== notifyRemoval.assignment.id &&
                a.status !== "withdrawn" &&
                a.status !== "declined",
            ).length
          }
          onCancel={() => setNotifyRemoval(null)}
          onProceed={notifyRemoval.onProceed}
        />
      )}
      {offerNewPrompt && (
        <div
          onClick={() => setOfferNewPrompt(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "40px 16px",
            zIndex: 115,
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              width: "100%",
              maxWidth: 440,
              border: "1px solid #e2dfd5",
              borderRadius: 12,
              padding: 22,
              boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
            }}
          >
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a1a", margin: 0 }}>
              Email {offerNewPrompt.name} their offer?
            </h2>
            <p style={{ color: "#6b6b6b", fontSize: 13.5, marginTop: 8, lineHeight: 1.5 }}>
              {offerNewPrompt.name} is now on {offerNewPrompt.sessionLabel}. Offers for this
              cycle have already gone out, so they won't be emailed automatically — send their
              offer now, or do it later from the schedule.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setOfferNewPrompt(null)}
                style={{
                  padding: "9px 14px",
                  border: "1px solid #e2dfd5",
                  background: "transparent",
                  color: "#1a1a1a",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                  fontFamily: "inherit",
                }}
              >
                Later
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = offerNewPrompt.assignmentId;
                  setOfferNewPrompt(null);
                  handlePreviewPatchOffers([id]);
                }}
                style={{
                  padding: "9px 14px",
                  border: "none",
                  background: BRIGHT,
                  color: "#fff",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "inherit",
                }}
              >
                Email now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function toggleSet(s, key) {
  const next = new Set(s);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

function HeaderStrip({ cycle, allCycles, afterschoolTerms = [], onSwitchCycle, onSwitchToAfterschool, onOpenNewCycle, phaseLabel, counts, missingSurveys, lastOp, onUndo, busy, canApprove, canSend, canRematch, canRunReminders, onApprove, onSurveyClick, onSendClick, onPreviewClick, onRerunAgent, onRemindersClick, nextReminders, onOpenEmailActivity, onArchiveCycle, onUnarchiveCycle }) {
  const otherCycles = (allCycles ?? []).filter((c) => c.id !== cycle.id);
  const hasOtherViews = otherCycles.length > 0 || (afterschoolTerms ?? []).length > 0;
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
          {hasOtherViews ? (
            <select
              value={cycle.id}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith("as:")) { onSwitchToAfterschool && onSwitchToAfterschool(v.slice(3)); }
                else { onSwitchCycle && onSwitchCycle(v); }
              }}
              title="Switch to another scheduling cycle or after-school term"
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: INK,
                letterSpacing: -0.2,
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
              <optgroup label="Camps">
                <option value={cycle.id}>{cycleDisplayName(cycle.name)}</option>
                {otherCycles.map((c) => (
                  <option key={c.id} value={c.id}>{cycleDisplayName(c.name)}</option>
                ))}
              </optgroup>
              {(afterschoolTerms ?? []).length > 0 && (
                <optgroup label="After-school">
                  {afterschoolTerms.map((t) => (
                    <option key={`as:${t}`} value={`as:${t}`}>{cycleDisplayName(t)}</option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <h1 style={{ fontSize: 14, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.2 }}>{cycleDisplayName(cycle.name)}</h1>
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
          <a
            href={`/admin/schedule/print?cycle=${cycle.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open a printable schedule (browser Save as PDF works) — for emailing to your materials coordinator"
            style={{
              color: PURPLE,
              fontSize: 13,
              fontWeight: 500,
              textDecoration: "underline",
            }}
          >
            Print schedule →
          </a>
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
        {onSurveyClick && (
          <button
            type="button"
            onClick={onSurveyClick}
            title={cycle.availability_survey_opened_at ? "Send the availability survey again (e.g. to instructors who haven't responded)" : "Send the availability survey to instructors"}
            style={{ ...btn("transparent", BRIGHT, true), padding: "7px 12px", fontSize: 13 }}
          >
            {cycle.availability_survey_opened_at ? "Resend survey" : "Send survey"}
          </button>
        )}
        {lastOp && (
          <button
            type="button"
            onClick={onUndo}
            title={lastOp.label}
            style={{ ...btn("transparent", BRIGHT, true), padding: "7px 12px", fontSize: 13 }}
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
            style={btn("transparent", BRIGHT, true, busy === "rematching")}
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
            style={btn("transparent", BRIGHT, true, busy === "approving")}
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
              style={btn("transparent", BRIGHT, true, busy === "previewing")}
            >
              {busy === "previewing" ? "Loading…" : "Preview offers"}
            </button>
            <button
              type="button"
              onClick={onSendClick}
              disabled={busy === "sending"}
              title="Send the confirmed offers to every assigned instructor"
              style={btn(BRIGHT, "#fff", false, busy === "sending")}
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
            style={btn("transparent", BRIGHT, true, busy === "reminders")}
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
            background: BRIGHT,
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
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14 }}>
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

function WeeklyGrid({ week, items, cycleType, recentlyUpdated, subsByKey, getValidationFor, dragStateRef, onDrop, onNeedsHireClick, onInstructorClick, onSubClick, onChangeRequestClick }) {
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
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14 }}>
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
                      dayDate={addDaysIso(week?.starts_on, WEEKDAYS.indexOf(d))}
                      subsByKey={subsByKey}
                      cardBg={colorByLocation.get(e.session.location_name) ?? LOCATION_PALETTE[0]}
                      flash={e.activeAssignments.some((a) => recentlyUpdated?.has(a.id))}
                      getValidationFor={getValidationFor}
                      dragStateRef={dragStateRef}
                      onDrop={onDrop}
                      onNeedsHireClick={onNeedsHireClick}
                      onInstructorClick={(session, currentAssignment, roleHint) =>
                        onInstructorClick(session, currentAssignment, roleHint, addDaysIso(week?.starts_on, WEEKDAYS.indexOf(d)))
                      }
                      onSubClick={(session, parentAssignment) =>
                        onSubClick(session, parentAssignment, addDaysIso(week?.starts_on, WEEKDAYS.indexOf(d)))
                      }
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

function ProgramCard({ item, dayDate, subsByKey, cardBg, flash, getValidationFor, dragStateRef, onDrop, onNeedsHireClick, onInstructorClick, onSubClick, onChangeRequestClick }) {
  const { session, status, assignment, allAssignments, activeAssignments, leadSubNeeded = [], devSubNeeded = [] } = item;
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

  // Subs covering this day — look up per assignment.
  const leadSub = lead && dayDate && subsByKey ? subsByKey.get(`${lead.id}:${dayDate}`) ?? null : null;
  const devSub = developing && dayDate && subsByKey ? subsByKey.get(`${developing.id}:${dayDate}`) ?? null : null;
  // Only surface live subs (pending/confirmed/taught) — a declined sub leaves the lead covering.
  const leadSubActive = leadSub && SUB_SHOWN_STATUSES.has(leadSub.status) ? leadSub : null;
  const devSubActive = devSub && SUB_SHOWN_STATUSES.has(devSub.status) ? devSub : null;
  // In the day-grid each card is one weekday; only flag the conflict on the day it
  // actually falls (dayDate). In dateless views (no dayDate) show all conflict dates.
  const leadDayConflicts = dayDate ? leadSubNeeded.filter((d) => d === dayDate) : leadSubNeeded;
  const devDayConflicts = dayDate ? devSubNeeded.filter((d) => d === dayDate) : devSubNeeded;
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
      {leadSubActive && (
        <SubLine sub={leadSubActive} onClick={() => onSubClick && lead && onSubClick(session, lead)} />
      )}
      {leadDayConflicts.length > 0 && (
        <div style={{ fontSize: 11, color: CORAL, fontWeight: 600, lineHeight: 1.35, marginTop: 2 }}>
          ⚠ out {listDates(leadDayConflicts)} — needs a sub
        </div>
      )}
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
      {showDevelopingRow && devSubActive && (
        <SubLine sub={devSubActive} onClick={() => onSubClick && developing && onSubClick(session, developing)} />
      )}
      {showDevelopingRow && devDayConflicts.length > 0 && (
        <div style={{ fontSize: 11, color: CORAL, fontWeight: 600, lineHeight: 1.35, marginTop: 2 }}>
          ⚠ out {listDates(devDayConflicts)} — needs a sub
        </div>
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

// Clickable sub indicator, rendered on its OWN line under the lead/developing
// chip so it never competes for width in the narrow day cards. Truncates with
// an ellipsis instead of wrapping. Click opens the assign-sub modal for that day.
function SubLine({ sub, onClick }) {
  const confirmed = sub.status === "confirmed" || sub.status === "taught";
  const subName = sub.sub ? [sub.sub.first_name, sub.sub.last_name].filter(Boolean).join(" ") : "Sub";
  const color = confirmed ? OK_GREEN : VIOLET;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (onClick) onClick(); }}
      title="Change or resend this sub"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        alignSelf: "flex-start", maxWidth: "100%",
        marginTop: 2, padding: "1px 8px",
        fontSize: 10, fontWeight: 600, color,
        background: `${color}14`, border: `1px solid ${color}44`,
        borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
        whiteSpace: "nowrap", overflow: "hidden",
      }}
    >
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, flexShrink: 0 }}>Sub</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{subName}</span>
      <span style={{ flexShrink: 0 }}>{confirmed ? "✓" : "· pending"}</span>
    </button>
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
                    <button type="button" onClick={sendReply} disabled={replyBusy || !replyText.trim()} style={{ ...btn(BRIGHT, "#fff", false, replyBusy || !replyText.trim()), padding: "6px 12px", fontSize: 12 }}>
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

function OfferDialog({ dialog, onChoose, onClose, busy, deadline, onDeadlineChange, autoReminders, onAutoRemindersChange, intro, onIntroChange, defaultIntro, publishedCount, onRollback, rollingBack, onRunReminders, remindersBusy, eligibleInstructors = [], selectedInstructorIds, onSelectedInstructorIdsChange, onPreview }) {
  const [previews, setPreviews] = useState(null);
  const [pvIdx, setPvIdx] = useState(0);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState(null);
  const hasPreview = previews && previews.length > 0;
  const nameById = new Map(eligibleInstructors.map((i) => [i.id, i.name]));
  async function doPreview() {
    setPvBusy(true); setPvErr(null);
    try {
      const p = await onPreview();
      setPreviews(p); setPvIdx(0);
      if (!p.length) setPvErr("Nothing to preview — approve some assignments first.");
    } catch (e) {
      setPvErr(e.message || "Couldn't build the preview.");
    } finally { setPvBusy(false); }
  }

  if (dialog.mode === "result" && dialog.payload?.kind === "approve") {
    return (
      <ModalShell onClose={onClose} title="Approved">
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.5 }}>
          {dialog.payload.count} assignment{dialog.payload.count === 1 ? "" : "s"} flipped from <em>proposed</em> to <em>confirmed</em>.
          You can now send offers.
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>OK</button>
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
              All emails went to <strong>{p.test_recipient || "your inbox"}</strong> only — your instructors didn't receive anything. Check your inbox.
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
          <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>Close</button>
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
          <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>Close</button>
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
          <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>OK</button>
        </div>
      </ModalShell>
    );
  }

  // mode === "choose"
  return (
    <ModalShell onClose={onClose} title="Send offers" maxWidth={hasPreview ? 760 : 480}>
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
        <label style={{ fontSize: 13, fontWeight: 600, color: INK }}>Message to instructors</label>
        <textarea
          value={intro ?? ""}
          onChange={(e) => onIntroChange(e.target.value)}
          rows={3}
          placeholder="Leave blank to give each instructor their own summary (their camp count + your cycle dates). Type here to write one note for everyone instead."
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 6, border: `1px solid ${RULE}`, fontSize: 13, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: -4 }}>
          <span style={{ fontSize: 12, color: MUTED }}>The assignment table, response buttons, and deadline are added automatically.</span>
          {defaultIntro && (intro ?? "").trim() !== defaultIntro && <button type="button" onClick={() => onIntroChange(defaultIntro)} style={{ border: "none", background: "none", color: BRIGHT, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Reset to default</button>}
        </div>
        <InstructorPickerPanel
          eligibleInstructors={eligibleInstructors}
          selectedInstructorIds={selectedInstructorIds}
          onChange={onSelectedInstructorIdsChange}
        />
        <DialogChoice
          title={pvBusy ? "Building preview…" : hasPreview ? "Refresh preview" : "Preview the email (recommended)"}
          subtitle="See exactly what instructors will receive — rendered right here, no email sent."
          disabled={pvBusy || (selectedInstructorIds && selectedInstructorIds.size === 0)}
          onClick={doPreview}
        />
        {pvErr && <div style={{ color: CORAL, fontSize: 12 }}>{pvErr}</div>}
        {hasPreview && (
          <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${RULE}`, background: "#faf9f6" }}>
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
            <iframe title="Offer email preview" srcDoc={previews[pvIdx]?.html} style={{ width: "100%", height: 440, border: "none", background: "#fff", display: "block" }} />
          </div>
        )}
        <DialogChoice
          title="Send to me first"
          subtitle={selectedInstructorIds
            ? `Generates only the ${selectedInstructorIds.size} selected instructor${selectedInstructorIds.size === 1 ? "'s" : "s'"} offer${selectedInstructorIds.size === 1 ? "" : "s"} and routes to your inbox. Nothing else changes.`
            : "Every instructor's offer arrives in your inbox so you can read exactly what they'll see. Nothing else changes — run this as many times as you want."}
          disabled={busy || (selectedInstructorIds && selectedInstructorIds.size === 0)}
          onClick={() => onChoose("test")}
          tone="warn"
        />
        <DialogChoice
          title={selectedInstructorIds ? `Send to ${selectedInstructorIds.size} selected instructor${selectedInstructorIds.size === 1 ? "" : "s"}` : "Send to all instructors"}
          subtitle={selectedInstructorIds
            ? "Delivers only to the instructors you picked above. Others won't receive anything."
            : "Delivers each instructor's offer to their real email. They'll show on this page as awaiting response. Re-sending won't email anyone who's already received their offer."}
          disabled={busy || (selectedInstructorIds && selectedInstructorIds.size === 0)}
          onClick={() => onChoose("send")}
          tone="danger"
        />
        {busy && <div style={{ color: MUTED, fontSize: 12 }}>Working…</div>}
      </div>
    </ModalShell>
  );
}

// Collapsible "Pick instructors" picker. Default state: "Everyone" (no
// selection). When the user opens it and picks specific instructors, the
// parent state flips to a Set<instructor_id>, which both the test and real
// send paths use to scope the email blast.
function InstructorPickerPanel({ eligibleInstructors, selectedInstructorIds, onChange }) {
  const [open, setOpen] = useState(!!selectedInstructorIds);
  if (eligibleInstructors.length === 0) return null;

  const isSubset = !!selectedInstructorIds;
  const summary = isSubset
    ? `${selectedInstructorIds.size} of ${eligibleInstructors.length} selected`
    : `All ${eligibleInstructors.length} instructors`;

  function toggle(id) {
    const cur = selectedInstructorIds ?? new Set(eligibleInstructors.map((i) => i.id));
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // If the user just unchecked one or kept it a real subset, persist as
    // a Set. If they re-selected everyone, fall back to null (= all).
    if (next.size === eligibleInstructors.length) onChange(null);
    else onChange(next);
  }

  function selectAll() {
    onChange(null);
  }

  function selectNone() {
    onChange(new Set());
  }

  function selectMyselfOnly() {
    // "Me" = whatever instructor row matches the most likely current admin.
    // We don't have the admin's instructor row directly here, but if the
    // admin is in eligibleInstructors (admin-who-teaches), they'll be
    // identifiable. For now: just clear to empty so user can tick their
    // own name. Could be smarter later.
    onChange(new Set());
  }

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 12, background: "#fff" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "10px 12px",
          textAlign: "left",
          fontSize: 13,
          color: INK,
          fontFamily: "inherit",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span><strong>Pick instructors:</strong> {summary}</span>
        <Chevron open={open} color={MUTED} />
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${RULE}`, padding: "10px 12px", background: "#fafaf6" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 11 }}>
            <button type="button" onClick={selectAll}
              style={{ background: "transparent", border: `1px solid ${RULE}`, color: PURPLE, borderRadius: 4, padding: "3px 8px", fontFamily: "inherit", cursor: "pointer", fontWeight: 600 }}>
              All
            </button>
            <button type="button" onClick={selectNone}
              style={{ background: "transparent", border: `1px solid ${RULE}`, color: MUTED, borderRadius: 4, padding: "3px 8px", fontFamily: "inherit", cursor: "pointer", fontWeight: 600 }}>
              None
            </button>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {eligibleInstructors.map((i) => {
              const checked = selectedInstructorIds ? selectedInstructorIds.has(i.id) : true;
              return (
                <label key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, cursor: "pointer", padding: "3px 0" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(i.id)}
                    style={{ margin: 0 }}
                  />
                  <span>{i.name}</span>
                  {i.email && <span style={{ color: MUTED, fontSize: 11 }}>· {i.email}</span>}
                </label>
              );
            })}
          </div>
          {selectedInstructorIds && selectedInstructorIds.size === 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: CORAL }}>
              Pick at least one instructor to send.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// SurveyDialog: lets the admin release the availability survey to instructors.
// 'preview' opens the rendered email in PreviewViewer; 'test' sends one sample
// email to the logged-in caller without flipping the cycle's opened_at; 'send'
// actually emails every active instructor and unlocks the portal banner.
function SurveyDialog({ dialog, cycleDisplay, instructors = [], availability = [], alreadyOpen, selectedIds, setSelectedIds, intro, setIntro, defaultIntro, deadline, onDeadlineChange, busy, onChoose, onClose }) {
  if (dialog.mode === "result") {
    const p = dialog.payload;
    return (
      <ModalShell onClose={onClose} title={p.mode === "send" ? "Survey released" : "Test send complete"}>
        <div style={{ padding: 20, fontSize: 14, color: INK, lineHeight: 1.55 }}>
          <div>
            {p.mode === "test"
              ? <>A sample email was delivered to <strong>your inbox</strong>.</>
              : <><strong>{p.sent}</strong> of {p.recipient_count ?? "?"} email{p.sent === 1 ? "" : "s"} delivered.</>}
          </div>
          {p.mode === "send" && p.sent > 0 && (
            <div style={{ marginTop: 10, padding: 10, background: `#3a7c3a1A`, borderRadius: 6, fontSize: 13, color: INK }}>
              The portal banner is now live for instructors. They can submit their availability any time before the deadline.
            </div>
          )}
          {p.mode === "test" && p.sent > 0 && (
            <div style={{ marginTop: 10, padding: 10, background: `${VIOLET}1A`, borderRadius: 6, fontSize: 12, color: INK }}>
              A test email went to <strong>your inbox</strong> only — the survey hasn't actually been released yet.
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
          <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>OK</button>
        </div>
      </ModalShell>
    );
  }
  // Recipient math — only emailable instructors can be sent to, so all counts and
  // bulk actions operate over that set. Non-responders = emailable who haven't
  // submitted (the straggler / new-hire nudge).
  const submitted = new Set((availability ?? []).filter((a) => a.submitted_at).map((a) => a.instructor_id));
  const emailable = (instructors ?? []).filter((i) => !!i.email);
  const emailableCount = emailable.length;
  const missingEmailCount = (instructors ?? []).length - emailableCount;
  const selCount = emailable.filter((i) => selectedIds?.has(i.id)).length;
  const allSelected = emailableCount > 0 && selCount === emailableCount;
  const nonResponderCount = emailable.filter((i) => !submitted.has(i.id)).length;
  const linkStyle = { border: "none", background: "none", color: BRIGHT, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 };

  function toggle(id) {
    const next = new Set(selectedIds ?? []);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedIds(next);
  }

  return (
    <ModalShell
      onClose={busy ? undefined : onClose}
      title={`${alreadyOpen ? "Send" : "Open"} ${cycleDisplay} availability survey`}
    >
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, maxHeight: "70vh", overflowY: "auto" }}>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          Emails instructors a link to their portal where they'll fill out which weeks, areas, and subjects they want to work.
          {alreadyOpen && nonResponderCount > 0 && ` ${nonResponderCount} haven't responded yet — pre-selected below.`}
        </div>

        <label style={{ fontSize: 13, fontWeight: 600, color: INK }}>Message to instructors</label>
        <textarea
          value={intro ?? ""}
          onChange={(e) => setIntro(e.target.value)}
          rows={3}
          placeholder={defaultIntro}
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 6, border: `1px solid ${RULE}`, fontSize: 13, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: -4 }}>
          <span style={{ fontSize: 12, color: MUTED }}>The button, link, and signature are added automatically.</span>
          {defaultIntro && (intro ?? "").trim() !== defaultIntro && <button type="button" onClick={() => setIntro(defaultIntro)} style={linkStyle}>Reset to default</button>}
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

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: INK }}>
            {selCount === 0 ? "No instructors selected" : allSelected ? `Sending to all ${emailableCount}` : `Sending to ${selCount} of ${emailableCount}`}
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            {alreadyOpen && nonResponderCount > 0 && <button type="button" onClick={() => setSelectedIds(new Set(emailable.filter((i) => !submitted.has(i.id)).map((i) => i.id)))} style={linkStyle}>Non-responders</button>}
            <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(emailable.map((i) => i.id)))} style={linkStyle}>{allSelected ? "Clear all" : "Select all"}</button>
          </div>
        </div>
        <div style={{ maxHeight: 160, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 6, padding: 8 }}>
          {(instructors ?? []).length === 0 && <div style={{ fontSize: 13, color: MUTED, padding: "4px 6px" }}>No active instructors.</div>}
          {(instructors ?? []).map((i) => {
            const noEmail = !i.email;
            const checked = !noEmail && (selectedIds?.has(i.id) ?? false);
            const hasSubmitted = submitted.has(i.id);
            const name = (i.preferred_name || i.first_name || "") + (i.last_name ? ` ${i.last_name}` : "");
            return (
              <label key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", fontSize: 13, cursor: noEmail ? "default" : "pointer", opacity: noEmail ? 0.55 : 1 }}>
                <input type="checkbox" checked={checked} disabled={noEmail} onChange={() => toggle(i.id)} />
                <span style={{ flex: 1 }}>{name || i.email}</span>
                {noEmail
                  ? <span style={{ fontSize: 11, color: CORAL }}>no email</span>
                  : hasSubmitted
                    ? <span style={{ fontSize: 11, color: OK_GREEN }}>responded</span>
                    : <span style={{ fontSize: 11, color: MUTED }}>no response</span>}
              </label>
            );
          })}
        </div>
        {missingEmailCount > 0 && <div style={{ fontSize: 12, color: MUTED, marginTop: -4 }}>{missingEmailCount} instructor{missingEmailCount === 1 ? "" : "s"} without an email can't be sent to.</div>}

        <DialogChoice
          title="Preview the email"
          subtitle="Renders what one instructor would see. No emails are sent and the survey stays closed."
          disabled={busy}
          onClick={() => onChoose("preview")}
          tone="neutral"
        />
        <DialogChoice
          title="Send to me first (recommended)"
          subtitle="A sample email arrives in your inbox so you can read exactly what instructors will see. Survey stays closed — re-run as many times as you want."
          disabled={busy}
          onClick={() => onChoose("test")}
          tone="warn"
        />
        <DialogChoice
          title={alreadyOpen ? "Send to selected instructors" : "Open survey to selected instructors"}
          subtitle={selCount === 0 ? "Pick at least one instructor above." : `Emails ${selCount} instructor${selCount === 1 ? "" : "s"} for real and unlocks the portal banner. They can update answers any time before the deadline.`}
          disabled={busy || selCount === 0}
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
  if (loc.dismissal_instructions) lines.push(`<div><strong>Dismissal:</strong> ${emailEscape(loc.dismissal_instructions)}</div>`);
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
    const isAfterschool = cycleType === "afterschool";
    if (!isAfterschool) {
      if (!startsOn || !endsOn) { setError("Pick both a start date and an end date."); return; }
      if (startsOn >= endsOn) { setError("End date has to be after start date."); return; }
      if (derivedWeeks.length === 0) { setError("Date range doesn't include any full Mon–Fri weeks."); return; }
    }

    setSaving(true);
    try {
      const { data, error: insErr } = await supabase
        .from("scheduling_cycles")
        .insert({
          organization_id: orgId,
          name: cycleName,
          cycle_type: cycleType,
          // After-school is registration-driven: dates come from programs, not here.
          starts_on: isAfterschool ? null : startsOn,
          ends_on: isAfterschool ? null : endsOn,
          status: "collecting",
          weeks: isAfterschool ? [] : derivedWeeks,
          auto_reminders_enabled: isAfterschool ? false : autoReminders,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      onCreated?.({ id: data.id, cycle_type: cycleType, name: cycleName });
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

        {cycleType === "afterschool" ? (
          <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 10, fontSize: 12, color: INK, lineHeight: 1.5 }}>
            After-school class dates, schools, curriculum, and enrollment all come from your
            registration on Enrops — there's nothing to set here. As families register, this
            term's classes fill in automatically. (Not running registration on Enrops? You'll
            be able to upload your schedule instead.)
          </div>
        ) : (
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
        )}

        {cycleType !== "afterschool" && derivedWeeks.length > 0 && (
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

        {cycleType !== "afterschool" && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
            <input type="checkbox" checked={autoReminders} onChange={(e) => setAutoReminders(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              <strong>Auto-send offer reminders</strong> — email any instructor who hasn't responded to their offer 3 days before the accept-by deadline (recommended).
            </span>
          </label>
        )}

        {error && (
          <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, borderRadius: 6, padding: "8px 12px", color: CORAL, fontWeight: 500, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
      <div style={{ padding: "0 20px 20px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} disabled={saving} style={btn("transparent", MUTED, true, saving)}>Cancel</button>
        <button type="button" onClick={save} disabled={saving} style={btn(BRIGHT, "#fff", false, saving)}>
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
            .select("id, name, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes")
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
        border: `1px solid ${RULE}`, borderRadius: 12,
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

function PreviewViewer({ data, onClose, onSend, sendLabel, sending, excludedInstructorIds, onToggleExclude }) {
  const previews = data?.preview ?? [];
  const [idx, setIdx] = useState(0);
  const supportsExclude = !!onToggleExclude;
  if (previews.length === 0) {
    return (
      <ModalShell onClose={onClose} title="Preview">
        <div style={{ padding: 20, color: MUTED, fontSize: 14 }}>
          {data?.note ?? "No confirmed assignments to preview yet. Click Approve first."}
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>Close</button>
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
        borderRadius: 12,
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
            {supportsExclude && cur?.instructor_id && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: excludedInstructorIds?.has(cur.instructor_id) ? CORAL : INK, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!excludedInstructorIds?.has(cur.instructor_id)}
                  onChange={() => onToggleExclude(cur.instructor_id)}
                  style={{ margin: 0 }}
                />
                <span>
                  {excludedInstructorIds?.has(cur.instructor_id) ? (
                    <strong>Skipped — won't send to {cur?.to}</strong>
                  ) : (
                    <span>Include in send</span>
                  )}
                </span>
              </label>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} style={btn("transparent", BRIGHT, true, idx === 0)}>‹ Prev</button>
            <button type="button" onClick={() => setIdx((i) => Math.min(previews.length - 1, i + 1))} disabled={idx === previews.length - 1} style={btn("transparent", BRIGHT, true, idx === previews.length - 1)}>Next ›</button>
            <button type="button" onClick={onClose} disabled={sending} style={btn("transparent", BRIGHT, true, sending)}>Cancel</button>
            {onSend && (() => {
              const sendDisabled = sending || sendLabel === "Nothing to send";
              return (
                <button type="button" onClick={onSend} disabled={sendDisabled} style={btn(BRIGHT, "#fff", false, sendDisabled)}>
                  {sending ? "Sending…" : (sendLabel ?? "Send")}
                </button>
              );
            })()}
            {!onSend && <button type="button" onClick={onClose} style={btn(BRIGHT, "#fff")}>Close</button>}
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

function ModalShell({ title, children, onClose, maxWidth = 480 }) {
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
        maxWidth,
        maxHeight: "90vh",
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 12,
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
  onAssignSub,
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
      const dateConflicts = campUnavailableConflicts(avail, session);
      if (dateConflicts.length) warningsForBanner.push(`${inst.first_name} is unavailable on ${listDates(dateConflicts)} — would need a sub.`);

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
          borderRadius: 12,
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
                    style={{ ...btn("transparent", BRIGHT, true), padding: "5px 10px", fontSize: 12 }}
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
                    style={{ ...btn("transparent", BRIGHT, true), padding: "5px 10px", fontSize: 12, opacity: (resendArmed || resendBusy) ? 0.6 : 1 }}
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
                {onAssignSub && (
                  <button
                    type="button"
                    onClick={onAssignSub}
                    title="Assign a substitute for a single day in this assignment — the sub gets an offer email"
                    style={{ ...btn("transparent", BRIGHT, true), padding: "5px 10px", fontSize: 12 }}
                  >
                    Assign sub for a day
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
                    style={{ ...btn(BRIGHT, "#fff", false, resendBusy), padding: "6px 12px", fontSize: 12 }}
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
                        style={{ ...btn(BRIGHT, "#fff", false, msgBusy || !msgText.trim()), padding: "6px 12px", fontSize: 12 }}
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
                <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
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
              </div>
            )}
          </div>
        )}

        <div style={{ overflowY: "auto", padding: 12, flex: 1, minHeight: 120 }}>
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
                  style={{ ...btn(BRIGHT, "#fff"), padding: "7px 12px", fontSize: 13 }}
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
                          style={{ ...btn("transparent", BRIGHT, true), padding: "4px 10px", fontSize: 11 }}
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
              style={{ ...btn("transparent", BRIGHT, true), width: "100%", padding: "8px 12px", fontSize: 13 }}
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
                  style={{ ...btn(BRIGHT, "#fff", false, addBusy), padding: "6px 12px", fontSize: 13 }}
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
          style={{ ...btn(BRIGHT, "#fff"), marginTop: 16 }}
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
