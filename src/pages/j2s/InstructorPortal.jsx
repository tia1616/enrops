// src/pages/j2s/InstructorPortal.jsx
// Minimal instructor portal: magic-link sign-in, list of published assignments,
// Accept or Request Change per camp. Class detail + My Availability are v2.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { displayFirstName } from "../../lib/instructorName";
import { avatarUrl } from "../../lib/avatars";
import InstructorAvailabilityForm from "./InstructorAvailabilityForm.jsx";
import AfterschoolAvailabilityForm from "./AfterschoolAvailabilityForm.jsx";
import InstructorProfile from "./InstructorProfile.jsx";
import Chevron from "../../components/Chevron.jsx";
import WizardHost from "../onboarding/WizardHost.jsx";
import { fetchLegalDocument } from "../../lib/legalDoc.js";
import { linkifyText } from "../../lib/linkifyText.jsx";
import PwaInstallButton from "../../components/pwa/PwaInstallButton.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Enrops default; tenant-skinnable later)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";

function fmt(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function fmtShort(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

function titleCase(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function dollars(cents) {
  if (!cents) return "";
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

export default function InstructorPortal() {
  // Unified home for everything instructor: sign-in, onboarding wizard,
  // schedule, profile. The phase machine routes between sub-states.
  //
  //   loading      -> initial render before session check
  //   login        -> not signed in; render sign-in surface
  //   linking      -> session exists; fetching instructor + onboarding rows
  //   onboarding   -> overall_status indicates wizard needed; render WizardHost
  //   ready        -> onboarded contractor; render schedule + profile
  //   error        -> unrecoverable load failure
  const navigate = useNavigate();
  const [phase, setPhase] = useState("loading");
  const [email, setEmail] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [error, setError] = useState("");
  const [instructor, setInstructor] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [coInstructors, setCoInstructors] = useState({}); // { [camp_session_id]: [{ name, role, email, phone }] } — camp co-teachers
  const [coInstructorsProgram, setCoInstructorsProgram] = useState({}); // { [program_id]: [...] } — after-school co-teachers
  const [programAssignments, setProgramAssignments] = useState([]); // after-school offers
  const [subAssignments, setSubAssignments] = useState([]); // assignment_substitutions where I'm the sub
  const [actingOn, setActingOn] = useState(null);
  const [subActingOn, setSubActingOn] = useState(null); // { id, action } for in-flight Accept/Decline
  const [changeFor, setChangeFor] = useState(null);
  const [changeText, setChangeText] = useState("");
  const [impersonating, setImpersonating] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [editingCycleId, setEditingCycleId] = useState(null);
  const [afterschoolSurveys, setAfterschoolSurveys] = useState([]); // [{ term, opened_at, deadline, submitted_at }]
  const [editingTerm, setEditingTerm] = useState(null);
  const [view, setView] = useState("schedule");
  const [showPast, setShowPast] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState(null);
  const [selectedSubId, setSelectedSubId] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const asEmail = params.get("as");

        const { data: { session } } = await supabase.auth.getSession();
        if (!mounted) return;
        if (!session?.user) {
          setPhase("login");
          return;
        }

        if (asEmail) {
          // Admin-impersonation path: fetch the named instructor and load their
          // view. Works only when the signed-in user is an org admin/owner —
          // RLS on instructors limits other roles.
          setPhase("linking");
          const { data: target, error: targetErr } = await supabase
            .from("instructors")
            .select("id, organization_id, first_name, last_name, preferred_name, email")
            .ilike("email", asEmail)
            .eq("is_active", true)
            .maybeSingle();
          if (!mounted) return;
          if (targetErr || !target) {
            setError(`No active instructor found for ${asEmail}. (Are you signed in as an admin of the right org?)`);
            setPhase("error");
            return;
          }
          setInstructor({
            instructor_id: target.id,
            organization_id: target.organization_id,
            first_name: target.first_name,
            last_name: target.last_name,
            preferred_name: target.preferred_name,
          });
          setImpersonating({ asEmail: target.email, signedInEmail: session.user.email });
          const targetInst = {
            instructor_id: target.id,
            organization_id: target.organization_id,
            first_name: target.first_name,
            last_name: target.last_name,
            preferred_name: target.preferred_name,
          };
          await Promise.all([loadAssignments(target.id), loadAfterschoolAssignments(target.id), loadSubAssignments(target.id), loadCycles(targetInst), loadAfterschoolSurveys(targetInst)]);
          setPhase("ready");
          return;
        }

        await linkAndLoad();
      } catch (err) {
        if (mounted) {
          setError(err.message ?? "Couldn't load.");
          setPhase("error");
        }
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function linkAndLoad() {
    setPhase("linking");
    setError("");
    try {
      const { data: linkData, error: linkErr } = await supabase.functions.invoke("link-instructor", {
        body: {},
      });
      if (linkErr || linkData?.error) {
        throw new Error(linkData?.error ?? linkErr?.message ?? "Couldn't find your instructor record.");
      }
      // Fetch the full instructor row for profile fields (RLS self-read).
      const { data: full } = await supabase
        .from("instructors")
        .select("id, first_name, last_name, preferred_name, email, phone, photo_url, shirt_size, first_aid_cpr_url, first_aid_cpr_expires_at, contractor_tier, organization_id")
        .eq("id", linkData.instructor_id)
        .maybeSingle();
      const fullInstructor = { ...linkData, ...(full ?? {}) };
      setInstructor(fullInstructor);

      // Check onboarding status. If they're an unfinished contractor invite,
      // render the wizard inline instead of the schedule view.
      const { data: onboardingRow } = await supabase
        .from("contractor_onboarding_status")
        .select("overall_status, current_step, steps_completed, checkr_status, stripe_connect_status, stripe_payouts_enabled, stripe_connect_account_id, completed_at")
        .eq("instructor_id", linkData.instructor_id)
        .maybeSingle();

      if (onboardingRow?.overall_status === "declined") {
        navigate(`/j2s/onboarding/declined`, { replace: true });
        return;
      }
      if (onboardingRow?.overall_status === "abandoned") {
        navigate(`/j2s/onboarding/abandoned`, { replace: true });
        return;
      }

      // Statuses that render the wizard or its completion variant:
      // invited, in_progress, pending_background_check, pending_stripe,
      // payouts_disabled. The wizard's CompletionScreen handles the
      // pending_* and payouts_disabled states. 'complete' falls through to
      // the schedule view.
      //
      // EXCEPTION: instructors who have ever been complete (completed_at set)
      // keep schedule access regardless of current status. They earned it
      // once; a later regression (e.g., Stripe payouts disabled) shouldn't
      // boot them back into the wizard — they should see their schedule and
      // be told separately about whatever needs attention.
      const wizardStatuses = new Set([
        "invited",
        "in_progress",
        "pending_background_check",
        "pending_stripe",
        "payouts_disabled",
      ]);
      const everCompleted = Boolean(onboardingRow?.completed_at);
      if (onboardingRow && wizardStatuses.has(onboardingRow.overall_status) && !everCompleted) {
        setOnboarding(onboardingRow);
        setPhase("onboarding");
        return;
      }

      // No onboarding row OR overall_status='complete' OR 'not_invited':
      // they're a regular onboarded instructor; render the schedule.
      await Promise.all([loadAssignments(linkData.instructor_id), loadAfterschoolAssignments(linkData.instructor_id), loadSubAssignments(linkData.instructor_id), loadCycles(linkData), loadAfterschoolSurveys(linkData)]);
      setPhase("ready");
    } catch (err) {
      setError(err.message ?? "Couldn't link your account.");
      setPhase("error");
    }
  }

  // Called when the wizard completes a step or status flips. Re-read
  // onboarding so phase can flip to 'ready' (showing the schedule) if
  // overall_status is now 'complete'.
  async function refetchOnboardingStatus() {
    if (!instructor?.id) return;
    const { data: row } = await supabase
      .from("contractor_onboarding_status")
      .select("overall_status, current_step, steps_completed, checkr_status, stripe_connect_status, stripe_payouts_enabled, stripe_connect_account_id, completed_at")
      .eq("instructor_id", instructor.id)
      .maybeSingle();
    if (!row) return;
    setOnboarding(row);
    if (row.overall_status === "complete" || row.completed_at) {
      // Either freshly complete or already-been-complete — drop into the
      // schedule view immediately.
      await Promise.all([loadAssignments(instructor.id), loadAfterschoolAssignments(instructor.id), loadSubAssignments(instructor.id), loadCycles(instructor), loadAfterschoolSurveys(instructor)]);
      setPhase("ready");
    }
  }

  // Re-fetch the instructor row (used after Profile saves changes so the
  // schedule view reflects updated avatar / preferred name without a full
  // page reload).
  async function refetchInstructor() {
    if (!instructor?.instructor_id && !instructor?.id) return;
    const id = instructor.instructor_id ?? instructor.id;
    const { data: full } = await supabase
      .from("instructors")
      .select("id, first_name, last_name, preferred_name, email, phone, photo_url, shirt_size, first_aid_cpr_url, first_aid_cpr_expires_at, contractor_tier")
      .eq("id", id)
      .maybeSingle();
    if (full) setInstructor((cur) => ({ ...cur, ...full }));
  }

  async function loadAssignments(instructorId) {
    // Per amended spec §2.2: filter to active cycles + non-terminal statuses.
    // `published_at IS NOT NULL` already excludes 'proposed'; we additionally
    // exclude 'withdrawn'/'declined' so admin-removed rows don't linger on
    // the instructor's schedule. Cycle filter excludes archived prior-term
    // assignments (matters once FA26 lands; SU26-only today).
    const { data, error: aErr } = await supabase
      .from("camp_assignments")
      .select("id, status, role, distance_bonus_cents, flags, change_request_message, instructor_response_at, camp_session_id, camp_sessions(id, location_name, location_id, week_num, session_type, curriculum_id, curriculum_name, starts_on, ends_on, start_time, end_time, class_days, current_enrollment, ages_min, ages_max, cycle_id, scheduling_cycles:cycle_id(status), program_locations:location_id(id, name, address, contact_phone, room_number, arrival_instructions, dismissal_instructions)), instructor_offer_messages(id, sender_role, sender_instructor_id, message, created_at)")
      .eq("instructor_id", instructorId)
      .not("published_at", "is", null)
      .in("status", ["published", "change_requested", "confirmed"])
      .order("camp_sessions(starts_on)", { ascending: true });
    if (aErr) throw aErr;
    // Load everything; we partition into current vs archived at render time
    // so a "Show past camps" toggle can pull them in without a re-fetch.
    setAssignments(data ?? []);

    // Co-instructors on the same camp sessions (e.g. a lead's developing
    // instructor and vice-versa). camp_assignments RLS scopes instructors to
    // their own rows, so the co-instructor's name comes from a SECURITY DEFINER
    // RPC that self-scopes to sessions this instructor is actually on. Names
    // only — no contact info. Best-effort: a failure here never blocks the
    // schedule from rendering.
    const { data: coRows, error: coErr } = await supabase.rpc("get_my_camp_coinstructors");
    if (coErr) {
      console.warn("[loadAssignments] co-instructors fetch failed:", coErr.message);
      setCoInstructors({});
    } else {
      const bySession = {};
      for (const r of coRows ?? []) {
        (bySession[r.camp_session_id] ||= []).push({
          instructor_id: r.instructor_id, name: r.name, role: r.role, email: r.email, phone: r.phone,
        });
      }
      setCoInstructors(bySession);
    }
  }

  // After-school offers (program_assignments). Mirrors loadAssignments but for
  // the term/program-shaped offer loop. Tagged kind:'program' so the shared
  // accept / request-change handlers route to respond-to-assignment with
  // program_assignment_id.
  async function loadAfterschoolAssignments(instructorId) {
    const { data, error: aErr } = await supabase
      .from("program_assignments")
      .select("id, status, role, distance_bonus_cents, flags, change_request_message, instructor_response_at, deadline, published_at, program_id, programs(id, curriculum, day_of_week, start_time, end_time, session_count, term, program_location_id, program_locations:program_location_id(id, name, address, contact_phone, room_number, arrival_instructions, dismissal_instructions)), instructor_offer_messages(id, sender_role, sender_instructor_id, message, created_at)")
      .eq("instructor_id", instructorId)
      .not("published_at", "is", null)
      .in("status", ["published", "change_requested", "confirmed"]);
    if (aErr) {
      console.warn("[loadAfterschoolAssignments] failed:", aErr.message);
      setProgramAssignments([]);
      return;
    }
    setProgramAssignments((data ?? []).map((a) => ({ ...a, kind: "program" })));

    // After-school co-instructors (mirrors the camp path). Self-scoped RPC; names
    // + contact for the other instructor(s) on the same class. Best-effort.
    const { data: coRows, error: coErr } = await supabase.rpc("get_my_program_coinstructors");
    if (coErr) {
      console.warn("[loadAfterschoolAssignments] co-instructors fetch failed:", coErr.message);
      setCoInstructorsProgram({});
    } else {
      const byProgram = {};
      for (const r of coRows ?? []) {
        (byProgram[r.program_id] ||= []).push({
          instructor_id: r.instructor_id, name: r.name, role: r.role, email: r.email, phone: r.phone,
        });
      }
      setCoInstructorsProgram(byProgram);
    }
  }

  // Single-day sub assignments where this instructor is the SUB (not the
  // regular). Pending rows render as offer cards with Accept/Decline;
  // confirmed/taught rows render as sub days in the schedule.
  //
  // assignment_substitutions has no FK to camp_assignments/program_assignments
  // (polymorphic via parent_assignment_type, trigger-validated), so the parent
  // join can't be inlined in the select — we resolve in a second round-trip.
  async function loadSubAssignments(instructorId) {
    const { data: rows, error: sErr } = await supabase
      .from("assignment_substitutions")
      .select("id, date, status, sub_tier, notes, email_sent_at, parent_assignment_id, parent_assignment_type")
      .eq("sub_instructor_id", instructorId)
      .order("date", { ascending: true });
    if (sErr) {
      console.warn("[loadSubAssignments] failed:", sErr.message);
      setSubAssignments([]);
      return;
    }
    const all = rows ?? [];
    if (all.length === 0) { setSubAssignments([]); return; }

    // Parent camp/program display fields come from a SECURITY DEFINER resolver
    // (get_my_sub_details) that returns ONLY whitelisted fields — the sub never
    // reads the raw parent assignment row, which carries the regular instructor's
    // comp (distance_bonus_cents) and private decline/change notes. Reshape the
    // result back into the camp_parent / program_parent shape the sub cards and
    // detail view already expect, so nothing downstream changes.
    const { data: details, error: dErr } = await supabase.rpc("get_my_sub_details");
    if (dErr) console.warn("[loadSubAssignments] details fetch failed:", dErr.message);
    const bySubId = new Map((details ?? []).map((d) => [d.substitution_id, d]));

    const enriched = all.map((r) => {
      const d = bySubId.get(r.id) ?? null;
      const camp_parent = (r.parent_assignment_type === "camp" && d)
        ? {
            id: d.parent_assignment_id,
            instructor_id: d.covered_instructor_id,
            camp_sessions: d.session ? { ...d.session, program_locations: d.location ?? null } : null,
          }
        : null;
      const program_parent = (r.parent_assignment_type === "program" && d)
        ? {
            id: d.parent_assignment_id,
            instructor_id: d.covered_instructor_id,
            programs: d.session ? { ...d.session, program_locations: d.location ?? null } : null,
          }
        : null;
      return { ...r, camp_parent, program_parent };
    });
    setSubAssignments(enriched);
  }

  // Resolve the co-instructor list for a sub. loadAssignments /
  // loadAfterschoolAssignments populate these maps via SECURITY DEFINER RPCs
  // that (as of the sub-visibility fix) include sessions/programs the caller is
  // subbing on, so a sub sees the lead + whoever they're covering for.
  function subCoInstructors(s) {
    if (!s) return [];
    return s.parent_assignment_type === "camp"
      ? (coInstructors[s.camp_parent?.camp_sessions?.id] || [])
      : (coInstructorsProgram[s.program_parent?.programs?.id] || []);
  }

  // Load any open cycles (not archived) for this instructor's org plus a flag
  // for whether they've already filled out their availability for each. Used
  // to surface "Set up your availability" / "Update availability" banners.
  async function loadCycles(loadedInstructor) {
    if (!loadedInstructor?.organization_id || !loadedInstructor?.instructor_id) return;
    // Only surface cycles where the admin has actually opened the survey to
    // instructors. NULL availability_survey_opened_at = admin hasn't released
    // it yet, so the portal stays quiet about that cycle.
    const { data: cycleRows, error: cErr } = await supabase
      .from("scheduling_cycles")
      .select("id, name, cycle_type, starts_on, ends_on, weeks, status, availability_survey_opened_at, survey_deadline")
      .eq("organization_id", loadedInstructor.organization_id)
      .not("availability_survey_opened_at", "is", null)
      .order("starts_on", { ascending: true });
    if (cErr) {
      console.warn("Couldn't load cycles for availability survey:", cErr);
      return;
    }
    const ids = (cycleRows ?? []).map((c) => c.id);
    let submittedMap = {};
    if (ids.length > 0) {
      const { data: availRows } = await supabase
        .from("instructor_availability")
        .select("cycle_id, submitted_at")
        .eq("instructor_id", loadedInstructor.instructor_id)
        .in("cycle_id", ids);
      for (const r of availRows ?? []) submittedMap[r.cycle_id] = r.submitted_at;
    }
    setCycles((cycleRows ?? []).map((c) => ({
      ...c,
      submitted_at: submittedMap[c.id] ?? null,
    })));
  }

  async function loadAfterschoolSurveys(loadedInstructor) {
    if (!loadedInstructor?.organization_id || !loadedInstructor?.instructor_id) return;
    // Only surface terms where the admin has released the afterschool survey.
    const { data: stateRows, error: sErr } = await supabase
      .from("afterschool_survey_state")
      .select("term, opened_at, deadline")
      .eq("organization_id", loadedInstructor.organization_id)
      .order("opened_at", { ascending: true });
    if (sErr) {
      console.warn("Couldn't load afterschool surveys:", sErr);
      return;
    }
    const terms = (stateRows ?? []).map((r) => r.term);
    let submittedMap = {};
    if (terms.length > 0) {
      const { data: availRows } = await supabase
        .from("instructor_term_availability")
        .select("term, submitted_at")
        .eq("instructor_id", loadedInstructor.instructor_id)
        .in("term", terms);
      for (const r of availRows ?? []) submittedMap[r.term] = r.submitted_at;
    }
    setAfterschoolSurveys((stateRows ?? []).map((r) => ({
      ...r,
      submitted_at: submittedMap[r.term] ?? null,
    })));
  }

  async function handleSignIn(e) {
    e.preventDefault();
    if (!email) return;
    setSendBusy(true);
    setSendMsg("");
    setError("");
    try {
      // Return the user to whatever tenant portal they're signing in from
      // (derive the slug from the current path; never hardcode a tenant).
      const seg = window.location.pathname.split("/").filter(Boolean)[0];
      const returnTo = seg
        ? `${window.location.origin}/${seg}/instructor`
        : `${window.location.origin}${window.location.pathname}`;
      const body = { email, redirect_to: returnTo, context: "instructor" };
      // One silent retry: the magic-link function can cold-start, and the first
      // invoke occasionally returns a transient non-2xx. Retrying once keeps a
      // one-off blip from ever reaching the instructor as an error.
      let data, fnErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        ({ data, error: fnErr } = await supabase.functions.invoke("auth-send-magic-link", { body }));
        if (!fnErr && !data?.error) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 900));
      }
      if (fnErr || data?.error) throw new Error("send_failed");
      setSendMsg(`Check ${email} for your sign-in link.`);
    } catch {
      // Never surface a raw SDK/edge message (e.g. "Edge Function returned a
      // non-2xx status code") — instructors get plain-language copy per the
      // no-tech-jargon rule.
      setError("We couldn't send your sign-in link just now. Please try again in a moment.");
    } finally {
      setSendBusy(false);
    }
  }

  async function handleGoogle() {
    setSendBusy(true);
    setError("");
    const seg = window.location.pathname.split("/").filter(Boolean)[0];
    const returnTo = seg
      ? `${window.location.origin}/${seg}/instructor`
      : `${window.location.origin}${window.location.pathname}`;
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: returnTo },
    });
    if (err) {
      setError("We couldn't start Google sign-in just now. Please try again, or use the email link below.");
      setSendBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setInstructor(null);
    setAssignments([]);
    setCoInstructors({});
    setCoInstructorsProgram({});
    setProgramAssignments([]);
    setPhase("login");
  }

  // Chunk F: Accept + Request Change now route through respond-to-assignment.
  // Direct UPDATE on camp_assignments is being removed once this UI ships —
  // the edge function is the sole instructor write path going forward.
  async function reloadAssignmentLists() {
    if (!instructor?.instructor_id) return;
    await Promise.all([
      loadAssignments(instructor.instructor_id),
      loadAfterschoolAssignments(instructor.instructor_id),
    ]);
  }

  function assignmentIdKey(assignment) {
    return assignment?.kind === "program" ? "program_assignment_id" : "camp_assignment_id";
  }

  async function handleAccept(assignment) {
    setActingOn(assignment.id);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "respond-to-assignment",
        { body: { [assignmentIdKey(assignment)]: assignment.id, action: "accept", ...(impersonating ? { acting_instructor_id: instructor.instructor_id } : {}) } }
      );
      if (fnErr || data?.error) {
        // already_confirmed is treated as success — admin or another tab
        // beat us to it. Refetch and move on.
        if (data?.error === "already_confirmed") {
          await reloadAssignmentLists();
          return;
        }
        if (data?.error === "assignment_closed" || data?.error === "forbidden") {
          // Admin withdrew it (or reassigned). Quiet refetch so the stale
          // card disappears with a small note.
          setError("That assignment is no longer available — your coordinator may have made a change.");
          await reloadAssignmentLists();
          return;
        }
        throw new Error(data?.error || fnErr?.message || "Couldn't accept.");
      }
      await reloadAssignmentLists();
    } catch (err) {
      setError(err.message ?? "Couldn't accept.");
    } finally {
      setActingOn(null);
    }
  }

  async function submitChangeRequest() {
    if (!changeFor || !changeText.trim()) return;
    setActingOn(changeFor.id);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "respond-to-assignment",
        {
          body: {
            [assignmentIdKey(changeFor)]: changeFor.id,
            action: "request_change",
            message: changeText.trim(),
            ...(impersonating ? { acting_instructor_id: instructor.instructor_id } : {}),
          },
        }
      );
      if (fnErr || data?.error) {
        if (data?.error === "already_confirmed") {
          // Stale tab — they confirmed in another tab, then tried to
          // request change here. Treat as "actually you already accepted."
          setError("You already accepted this — refresh and you'll see it confirmed.");
          setChangeFor(null);
          setChangeText("");
          await reloadAssignmentLists();
          return;
        }
        if (data?.error === "assignment_closed" || data?.error === "forbidden") {
          setError("That assignment is no longer available — your coordinator may have made a change.");
          setChangeFor(null);
          setChangeText("");
          await reloadAssignmentLists();
          return;
        }
        throw new Error(data?.error || fnErr?.message || "Couldn't send your request.");
      }
      setChangeFor(null);
      setChangeText("");
      await reloadAssignmentLists();
    } catch (err) {
      setError(err.message ?? "Couldn't send your request.");
    } finally {
      setActingOn(null);
    }
  }

  async function handleSubMarkTaught(substitutionId) {
    setSubActingOn({ id: substitutionId, action: "mark" });
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "confirm-sub-delivery",
        { body: { substitution_id: substitutionId } },
      );
      if (fnErr || data?.error) {
        throw new Error(data?.detail || data?.error || fnErr?.message || "Couldn't mark this day.");
      }
      await loadSubAssignments(instructor.instructor_id);
    } catch (err) {
      setError(err.message ?? "Couldn't mark this day.");
    } finally {
      setSubActingOn(null);
    }
  }

  async function handleSubResponse(substitutionId, action, declineReason) {
    setSubActingOn({ id: substitutionId, action });
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "respond-to-sub-offer",
        { body: { substitution_id: substitutionId, action, decline_reason: declineReason || undefined } },
      );
      if (fnErr || data?.error) {
        if (data?.error === "already_responded") {
          // Stale tab — refetch and move on.
          await loadSubAssignments(instructor.instructor_id);
          return;
        }
        if (data?.error === "forbidden") {
          setError("That sub offer is no longer available.");
          await loadSubAssignments(instructor.instructor_id);
          return;
        }
        throw new Error(data?.error || fnErr?.message || "Couldn't send your response.");
      }
      // Optimistic local update so the card moves immediately — the re-fetch
      // below confirms, but avoids a stale-read window where the pending card
      // lingers after accept.
      setSubAssignments((prev) =>
        action === "decline"
          ? prev.filter((s) => s.id !== substitutionId)
          : prev.map((s) => s.id === substitutionId ? { ...s, status: "confirmed" } : s),
      );
      // Refresh the sub list AND the co-instructor maps: accepting flips the sub
      // to confirmed, which is what makes the parent camp readable and surfaces
      // the lead/co-instructors — those maps come from loadAssignments, so they'd
      // otherwise stay stale (lines blank) until a full reload.
      await Promise.all([
        loadSubAssignments(instructor.instructor_id),
        loadAssignments(instructor.instructor_id),
        loadAfterschoolAssignments(instructor.instructor_id),
      ]);
    } catch (err) {
      setError(err.message ?? "Couldn't send your response.");
    } finally {
      setSubActingOn(null);
    }
  }

  if (phase === "loading" || phase === "linking") {
    return <Shell><div style={{ color: MUTED, fontSize: 14, padding: 24 }}>Loading…</div></Shell>;
  }

  if (phase === "login") {
    return (
      <Shell>
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 28, maxWidth: 400 }}>
          <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: PURPLE }}>Instructor sign in</h1>
          <p style={{ margin: "0 0 18px", color: MUTED, fontSize: 14 }}>Sign in to view your schedule and respond to offers.</p>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={sendBusy}
            style={{
              width: "100%",
              padding: "10px 14px",
              background: "#fff",
              color: INK,
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: sendBusy ? "wait" : "pointer",
              opacity: sendBusy ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <GoogleG />
            Continue with Google
          </button>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: "0 0 16px",
            color: MUTED,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}>
            <span style={{ flex: 1, height: 1, background: RULE }} />
            or
            <span style={{ flex: 1, height: 1, background: RULE }} />
          </div>

          <form onSubmit={handleSignIn}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                fontSize: 14,
                fontFamily: "inherit",
                background: "#fff",
                color: INK,
                boxSizing: "border-box",
              }}
            />
            <button
              type="submit"
              disabled={sendBusy || !email}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "10px 14px",
                background: BRIGHT,
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: sendBusy ? "wait" : "pointer",
                opacity: sendBusy ? 0.7 : 1,
              }}
            >
              {sendBusy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
          {sendMsg && (
            <div style={{ marginTop: 14, padding: 10, borderRadius: 6, background: `${OK_GREEN}1A`, color: OK_GREEN, fontSize: 13 }}>{sendMsg}</div>
          )}
          {error && (
            <div style={{ marginTop: 14, padding: 10, borderRadius: 6, background: `${CORAL}1A`, color: CORAL, fontSize: 13 }}>{error}</div>
          )}
        </div>
      </Shell>
    );
  }

  if (phase === "error") {
    // Map raw SDK / edge-function errors to human-readable copy. Per the
    // "no tech jargon" rule: "Edge Function returned a non-2xx status code"
    // is meaningless to an instructor. The common cause when an admin/owner
    // (no instructor row) lands here is just that — no instructor record —
    // so the friendlier message points them at what to do.
    const friendly = (() => {
      const raw = (error || '').toString();
      if (/non-2xx|edge function|status code/i.test(raw)) {
        return "Your account isn't fully set up as an instructor yet. If you're a contractor, ask your operator to send you an onboarding invite. If you're the operator, this is the instructor view — the admin tools live at the /admin page.";
      }
      if (/no.*instructor.*found|not an instructor/i.test(raw)) {
        return "We couldn't find an instructor record for you. Your operator may not have invited you yet, or you might be signed in with a different email.";
      }
      if (raw && raw.length < 120) return raw;
      return "Something went wrong loading your schedule. Try signing out and back in.";
    })();

    return (
      <Shell>
        <div style={{ background: "#fff", border: `1px solid ${CORAL}`, borderRadius: 12, padding: 28, maxWidth: 540 }}>
          <h1 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700, color: INK }}>We couldn't load your schedule</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px", lineHeight: 1.5 }}>{friendly}</p>
          <button type="button" onClick={signOut} style={{ padding: "8px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
            Sign out and try again
          </button>
        </div>
      </Shell>
    );
  }

  // Wizard inline — unfinished contractor onboarding lives at this same
  // URL so it's one home for everything instructor-side. WizardHost dispatches
  // to the right screen (or the completion variant for pending_* statuses).
  if (phase === "onboarding") {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <WizardHost
          slug="j2s"
          instructor={{ ...instructor, id: instructor.id ?? instructor.instructor_id }}
          onboarding={onboarding}
          onComplete={refetchOnboardingStatus}
          onDismiss={async () => {
            // Pending_* and payouts_disabled statuses won't flip to 'complete',
            // but the contractor still wants out of the completion card and
            // into the schedule view. Load schedule data and switch phases.
            await Promise.all([loadAssignments(instructor.id), loadAfterschoolAssignments(instructor.id), loadSubAssignments(instructor.id), loadCycles(instructor), loadAfterschoolSurveys(instructor)]);
            setPhase("ready");
          }}
        />
      </Shell>
    );
  }

  // ready
  // Split current (cycle not archived) vs past (cycle archived).
  // Within current: needsResponse (published/change_requested) vs confirmed.
  const isArchived = (a) => a.camp_sessions?.scheduling_cycles?.status === "archived";
  const currentAssignments = assignments.filter((a) => !isArchived(a));
  const pastAssignments = assignments.filter(isArchived);
  const confirmedSubCount = subAssignments.filter((s) => s.status === "confirmed" || s.status === "taught").length;
  const totalCount = currentAssignments.length + confirmedSubCount;
  const needsResponse = currentAssignments.filter(
    (a) => a.status === "published" || a.status === "change_requested"
  );
  const accepted = currentAssignments.filter((a) => a.status === "confirmed" && a.instructor_response_at);
  // After-school offers (no cycle archive concept yet — show all loaded).
  const needsResponseAS = programAssignments.filter(
    (a) => a.status === "published" || a.status === "change_requested"
  );
  const acceptedAS = programAssignments.filter((a) => a.status === "confirmed" && a.instructor_response_at);

  // CPR cert expiry nudge: render a clickable pill if the cert is expired or
  // within 60 days of expiring. Tap → opens the profile screen where the
  // upload + expiry field live.
  const cprExpiresAt = instructor?.first_aid_cpr_expires_at;
  const cprPill = (() => {
    if (!cprExpiresAt) return null;
    const expiry = new Date(`${cprExpiresAt}T00:00:00`);
    const today = new Date(new Date().toDateString());
    const daysUntil = Math.floor((expiry - today) / 86_400_000);
    if (daysUntil < 0) return { label: "CPR expired — update", expired: true };
    if (daysUntil <= 60) return { label: `CPR expires in ${daysUntil}d`, expired: false };
    return null;
  })();

  // Cycles that are open + the instructor hasn't filled out availability yet,
  // or has but might want to update. We surface a banner per cycle.
  const editingCycle = editingCycleId ? cycles.find((c) => c.id === editingCycleId) : null;
  const needsSurvey = cycles.filter((c) => !c.submitted_at);
  const updatableSurveys = cycles.filter((c) => !!c.submitted_at && c.status !== "archived");
  const needsAfterschoolSurvey = afterschoolSurveys.filter((s) => !s.submitted_at);
  const updatableAfterschoolSurveys = afterschoolSurveys.filter((s) => !!s.submitted_at);

  // While editing availability for a cycle, hide the assignment list entirely.
  if (editingCycle) {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        {impersonating && (
          <div style={{
            background: `${VIOLET}1F`,
            border: `1px solid ${VIOLET}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 14,
            fontSize: 13,
            color: INK,
            lineHeight: 1.5,
          }}>
            <strong>Admin preview</strong> — saving will write to <em>{impersonating.asEmail}</em>'s availability.
          </div>
        )}
        <InstructorAvailabilityForm
          instructor={instructor}
          cycle={editingCycle}
          onSaved={async () => {
            setEditingCycleId(null);
            await loadCycles(instructor);
          }}
          onCancel={() => setEditingCycleId(null)}
        />
      </Shell>
    );
  }

  // While editing afterschool availability for a term, hide the assignment list.
  if (editingTerm) {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        {impersonating && (
          <div style={{
            background: `${VIOLET}1F`,
            border: `1px solid ${VIOLET}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 14,
            fontSize: 13,
            color: INK,
            lineHeight: 1.5,
          }}>
            <strong>Admin preview</strong> — saving will write to <em>{impersonating.asEmail}</em>'s availability.
          </div>
        )}
        <AfterschoolAvailabilityForm
          instructor={instructor}
          term={editingTerm}
          onSaved={async () => {
            setEditingTerm(null);
            await loadAfterschoolSurveys(instructor);
          }}
          onCancel={() => setEditingTerm(null)}
        />
      </Shell>
    );
  }

  if (view === "profile") {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <InstructorProfile
          instructor={{ ...instructor, id: instructor.id ?? instructor.instructor_id }}
          onBack={() => setView("schedule")}
          onSaved={refetchInstructor}
        />
      </Shell>
    );
  }

  if (view === "documents") {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <DocumentsView onBack={() => setView("schedule")} />
      </Shell>
    );
  }

  if (view === "pay") {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <PayView
          instructorId={instructor.id ?? instructor.instructor_id}
          onBack={() => setView("schedule")}
        />
      </Shell>
    );
  }

  if (view === "assignment-detail") {
    const selected = assignments.find((a) => a.id === selectedAssignmentId);
    if (!selected) {
      // Assignment vanished (cycle archived, admin withdrew). Bounce back.
      setView("schedule");
      setSelectedAssignmentId(null);
      return null;
    }
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <AssignmentDetailView
          assignment={selected}
          coInstructors={coInstructors[selected.camp_session_id] || []}
          onBack={() => { setView("schedule"); setSelectedAssignmentId(null); }}
        />
      </Shell>
    );
  }

  if (view === "sub-detail") {
    const selectedSub = subAssignments.find((s) => s.id === selectedSubId);
    if (!selectedSub) {
      // Sub vanished (admin reassigned/withdrew). Bounce back.
      setView("schedule");
      setSelectedSubId(null);
      return null;
    }
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <SubDetailView
          sub={selectedSub}
          coInstructors={subCoInstructors(selectedSub)}
          onBack={() => { setView("schedule"); setSelectedSubId(null); }}
          onMarkTaught={() => handleSubMarkTaught(selectedSub.id)}
          markBusy={subActingOn?.id === selectedSub.id && subActingOn?.action === "mark"}
          error={error}
        />
      </Shell>
    );
  }

  return (
    <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
      {impersonating && (
        <div style={{
          background: `${VIOLET}1F`,
          border: `1px solid ${VIOLET}`,
          borderRadius: 8,
          padding: "10px 14px",
          marginBottom: 14,
          fontSize: 13,
          color: INK,
          lineHeight: 1.5,
        }}>
          <strong>Admin preview</strong> — you're signed in as <em>{impersonating.signedInEmail}</em> and viewing <em>{impersonating.asEmail}</em>'s portal. Accept and Request change actions will fire on this instructor's behalf.
        </div>
      )}
      <header style={{ marginBottom: 18, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          {instructor.photo_url && (
            <img
              src={avatarUrl(instructor.photo_url)}
              alt=""
              style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0 }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: INK, letterSpacing: -0.3 }}>
              Hi {displayFirstName(instructor)} 👋
            </h1>
            <p style={{ color: MUTED, margin: "4px 0 0", fontSize: 14 }}>
              You have {totalCount + programAssignments.length} {programAssignments.length > 0 && totalCount === 0 ? `class${programAssignments.length === 1 ? "" : "es"}` : `camp${totalCount + programAssignments.length === 1 ? "" : "s"}`} on your schedule
              {(needsResponse.length + needsResponseAS.length) > 0 && ` · ${needsResponse.length + needsResponseAS.length} awaiting your response`}.
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <PwaInstallButton />
          <button
            type="button"
            onClick={() => setView("pay")}
            style={{
              background: "transparent",
              border: `1px solid ${PURPLE}`,
              color: PURPLE,
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Pay
          </button>
          <button
            type="button"
            onClick={() => setView("documents")}
            style={{
              background: "transparent",
              border: `1px solid ${PURPLE}`,
              color: PURPLE,
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Documents
          </button>
          <button
            type="button"
            onClick={() => setView("profile")}
            style={{
              background: "transparent",
              border: `1px solid ${PURPLE}`,
              color: PURPLE,
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            My profile →
          </button>
        </div>
      </header>

      {error && (
        <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {error}
        </div>
      )}

      {cprPill && (
        <button
          type="button"
          onClick={() => setView("profile")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 14,
            padding: "6px 12px",
            background: cprPill.expired ? `${CORAL}1F` : `${VIOLET}1F`,
            border: `1px solid ${cprPill.expired ? CORAL : VIOLET}`,
            borderRadius: 999,
            color: cprPill.expired ? CORAL : INK,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          {cprPill.label} →
        </button>
      )}

      {needsSurvey.length > 0 && (
        <div style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          {needsSurvey.map((c) => (
            <SurveyBanner
              key={c.id}
              cycle={c}
              onStart={() => setEditingCycleId(c.id)}
            />
          ))}
        </div>
      )}

      {needsAfterschoolSurvey.length > 0 && (
        <div style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          {needsAfterschoolSurvey.map((s) => (
            <AfterschoolSurveyBanner
              key={s.term}
              survey={s}
              onStart={() => setEditingTerm(s.term)}
            />
          ))}
        </div>
      )}

      {subAssignments.filter((s) => s.status === "pending").length > 0 && (
        <Section title="Sub day offers">
          {subAssignments.filter((s) => s.status === "pending").map((s) => (
            <SubOfferCard
              key={s.id}
              sub={s}
              coInstructors={subCoInstructors(s)}
              busy={subActingOn?.id === s.id}
              busyAction={subActingOn?.id === s.id ? subActingOn.action : null}
              onAccept={() => handleSubResponse(s.id, "accept")}
              onDecline={(reason) => handleSubResponse(s.id, "decline", reason)}
            />
          ))}
        </Section>
      )}

      {(needsResponse.length > 0 || needsResponseAS.length > 0) && (
        <Section title="Needs your response">
          {needsResponse.map((a) => (
            <AssignmentCard
              key={a.id}
              assignment={a}
              coInstructors={coInstructors[a.camp_session_id] || []}
              messages={a.instructor_offer_messages || []}
              busy={actingOn === a.id}
              onAccept={() => handleAccept(a)}
              onRequestChange={() => { setChangeFor(a); setChangeText(""); }}
            />
          ))}
          {needsResponseAS.map((a) => (
            <AfterschoolAssignmentCard
              key={a.id}
              assignment={a}
              coInstructors={coInstructorsProgram[a.program_id] || []}
              messages={a.instructor_offer_messages || []}
              busy={actingOn === a.id}
              onAccept={() => handleAccept(a)}
              onRequestChange={() => { setChangeFor(a); setChangeText(""); }}
            />
          ))}
        </Section>
      )}

      {(accepted.length > 0 || acceptedAS.length > 0 || subAssignments.some((s) => s.status === "confirmed" || s.status === "taught")) && (
        <Section title="Confirmed schedule">
          {accepted.map((a) => (
            <AssignmentCard
              key={a.id}
              assignment={a}
              coInstructors={coInstructors[a.camp_session_id] || []}
              readOnly
              onOpen={() => { setSelectedAssignmentId(a.id); setView("assignment-detail"); }}
            />
          ))}
          {acceptedAS.map((a) => (
            <AfterschoolAssignmentCard key={a.id} assignment={a} coInstructors={coInstructorsProgram[a.program_id] || []} readOnly />
          ))}
          {subAssignments.filter((s) => s.status === "confirmed" || s.status === "taught").map((s) => (
            <SubOfferCard
              key={s.id}
              sub={s}
              coInstructors={subCoInstructors(s)}
              readOnly
              onOpen={() => { setSelectedSubId(s.id); setView("sub-detail"); }}
            />
          ))}
        </Section>
      )}

      {currentAssignments.length === 0 && programAssignments.length === 0 && confirmedSubCount === 0 && needsSurvey.length === 0 && needsAfterschoolSurvey.length === 0 && pastAssignments.length === 0 && (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 28, color: MUTED, textAlign: "center" }}>
          No schedule yet. Your admin will email you when it's ready.
        </div>
      )}

      {pastAssignments.length > 0 && (
        <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${RULE}` }}>
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              color: MUTED,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              padding: 0,
            }}
          >
            <Chevron open={showPast} color={BRIGHT} style={{ marginRight: 5, verticalAlign: "middle" }} /> Past camps ({pastAssignments.length})
          </button>
          {showPast && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {pastAssignments.map((a) => (
                <AssignmentCard key={a.id} assignment={a} readOnly />
              ))}
            </div>
          )}
        </div>
      )}

      {updatableSurveys.length > 0 && (
        <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
            Your availability
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {updatableSurveys.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13, color: INK }}>
                <span>
                  {cycleLabel(c)} <span style={{ color: MUTED }}>· submitted {fmtShort(c.submitted_at?.slice(0, 10))}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setEditingCycleId(c.id)}
                  style={{ background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}
                >
                  Update availability
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {updatableAfterschoolSurveys.length > 0 && (
        <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
            Your after-school availability
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {updatableAfterschoolSurveys.map((s) => (
              <div key={s.term} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13, color: INK }}>
                <span>
                  {termLabel(s.term)} <span style={{ color: MUTED }}>· submitted {fmtShort(s.submitted_at?.slice(0, 10))}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setEditingTerm(s.term)}
                  style={{ background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}
                >
                  Update availability
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {changeFor && (
        <ChangeRequestDialog
          assignment={changeFor}
          value={changeText}
          onChange={setChangeText}
          busy={actingOn === changeFor.id}
          onSubmit={submitChangeRequest}
          onClose={() => { setChangeFor(null); setChangeText(""); }}
        />
      )}
    </Shell>
  );
}

function cycleLabel(cycle) {
  if (!cycle?.name) return "Cycle";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(cycle.name);
  if (!m) return cycle.name;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

function SurveyBanner({ cycle, onStart }) {
  const title = cycleLabel(cycle);
  return (
    <div style={{
      background: `${VIOLET}1F`,
      border: `1px solid ${VIOLET}`,
      borderRadius: 10,
      padding: "14px 16px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.6 }}>
          New: set up your availability
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 2 }}>
          Tell us when you can work this {title}
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
          {fmtShort(cycle.starts_on)} – {fmtShort(cycle.ends_on)} · ~2 minutes
          {cycle.survey_deadline && (
            <> · <span style={{ color: CORAL, fontWeight: 600 }}>please submit by {fmtShort(cycle.survey_deadline.slice(0, 10))}</span></>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onStart}
        style={{
          padding: "9px 14px",
          background: BRIGHT,
          color: "#fff",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Start
      </button>
    </div>
  );
}

function termLabel(term) {
  if (!term) return "Term";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(term);
  if (!m) return term;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

function AfterschoolSurveyBanner({ survey, onStart }) {
  const title = termLabel(survey.term);
  return (
    <div style={{
      background: `${VIOLET}1F`,
      border: `1px solid ${VIOLET}`,
      borderRadius: 10,
      padding: "14px 16px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.6 }}>
          New: set up your after-school availability
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 2 }}>
          Tell us which days you can teach this {title}
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
          ~2 minutes
          {survey.deadline && (
            <> · <span style={{ color: CORAL, fontWeight: 600 }}>please submit by {fmtShort(survey.deadline.slice(0, 10))}</span></>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onStart}
        style={{
          padding: "9px 14px",
          background: BRIGHT,
          color: "#fff",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Start
      </button>
    </div>
  );
}

function Shell({ children, instructorName, onSignOut }) {
  return (
    <div style={{
      minHeight: "100vh",
      background: CREAM,
      fontFamily: "'Poppins', system-ui, sans-serif",
      color: INK,
      padding: "32px 16px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontWeight: 800, fontSize: 22, color: PURPLE, letterSpacing: -0.3 }}>Enrops</span>
            <span style={{ fontSize: 13, color: MUTED }}>Instructor portal</span>
          </div>
          {instructorName && onSignOut && (
            <button type="button" onClick={onSignOut} style={{ background: "transparent", border: `1px solid ${PURPLE}`, color: PURPLE, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
              Sign out
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
        {title}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

// Sub-day card. Pending rows render Accept/Decline. Confirmed/taught rows
// render read-only with the day's venue + lesson context + a single-day
// Mark Taught button (date-of or after). The component reads from either
// sub.camp_parent (camp sub) or sub.program_parent (afterschool sub) — set
// by loadSubAssignments.
function SubOfferCard({ sub, busy, busyAction, onAccept, onDecline, readOnly, onOpen, coInstructors = [] }) {
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState("");

  const isCamp = sub.parent_assignment_type === "camp";
  const coveredInstructorId = isCamp ? sub.camp_parent?.instructor_id : sub.program_parent?.instructor_id;
  const sess = isCamp ? sub.camp_parent?.camp_sessions ?? null : null;
  const prog = !isCamp ? sub.program_parent?.programs ?? null : null;
  const loc = isCamp ? sess?.program_locations ?? null : prog?.program_locations ?? null;

  const curriculumName = isCamp ? (sess?.curriculum_name ?? "this camp") : (prog?.curriculum ?? "this program");
  const venueName = loc?.name ?? (isCamp ? sess?.location_name : null) ?? "";
  const startTime = isCamp ? sess?.start_time : prog?.start_time;
  const endTime = isCamp ? sess?.end_time : prog?.end_time;
  const timeRange = startTime && endTime ? `${fmtTimePretty(startTime)}–${fmtTimePretty(endTime)}` : (startTime ? fmtTimePretty(startTime) : "");

  const friendlyDate = sub.date
    ? new Date(`${sub.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : "";

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 18px", marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: VIOLET, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 4 }}>
        Sub · {sub.sub_tier === "lead" ? "Lead" : "Developing"}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{curriculumName}</div>
      <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
        {friendlyDate}{timeRange ? ` · ${timeRange}` : ""}{venueName ? ` · ${venueName}` : ""}
      </div>
      {coInstructors.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <SubInstructorLines coInstructors={coInstructors} coveredInstructorId={coveredInstructorId} />
        </div>
      )}
      {/* Location + arrival/dismissal + notes render inline on the pending
          offer so the instructor can decide whether to accept. On the confirmed
          (read-only) card they move behind "View details" to keep the schedule
          list compact and consistent with the camp cards. */}
      {!readOnly && loc?.address && (
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{loc.address}</div>
      )}
      {!readOnly && loc?.arrival_instructions && (
        <div style={{ fontSize: 13, color: INK, marginTop: 8 }}>
          <span style={{ color: MUTED, fontWeight: 600 }}>Arrival: </span>{loc.arrival_instructions}
        </div>
      )}
      {!readOnly && loc?.dismissal_instructions && (
        <div style={{ fontSize: 13, color: INK, marginTop: 4 }}>
          <span style={{ color: MUTED, fontWeight: 600 }}>Dismissal: </span>{loc.dismissal_instructions}
        </div>
      )}
      {!readOnly && sub.notes && (
        <div style={{ fontSize: 13, color: INK, marginTop: 8, padding: 10, background: CREAM, borderLeft: `3px solid ${VIOLET}`, borderRadius: 4 }}>
          <span style={{ color: MUTED, fontWeight: 600 }}>Note: </span>{sub.notes}
        </div>
      )}

      {readOnly ? (
        <>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sub.status === "taught" ? OK_GREEN : MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {sub.status === "taught" ? "✓ Taught" : "✓ Accepted"}
            </div>
          </div>
          {onOpen && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={onOpen}
                style={{
                  background: "transparent",
                  border: "none",
                  color: PURPLE,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {isCamp ? "View details, roster, and materials →" : "View details →"}
              </button>
            </div>
          )}
        </>
      ) : (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            style={{ background: BRIGHT, color: "#fff", border: `1px solid ${BRIGHT}`, padding: "8px 14px", fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {busy && busyAction === "accept" ? "Accepting…" : "Accept"}
          </button>
          <button
            type="button"
            onClick={() => setDeclineOpen((v) => !v)}
            disabled={busy}
            style={{ background: "transparent", color: CORAL, border: `1px solid ${CORAL}`, padding: "8px 14px", fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            Can't make it
          </button>
        </div>
      )}

      {declineOpen && !readOnly && (
        <div style={{ marginTop: 10, padding: 12, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Anything you want to tell them? (optional)</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="e.g. I'm out of town that day"
            style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => { setDeclineOpen(false); onDecline(reason.trim()); }}
              disabled={busy}
              style={{ background: CORAL, color: "#fff", border: `1px solid ${CORAL}`, padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
            >
              {busy && busyAction === "decline" ? "Sending…" : "Send decline"}
            </button>
            <button
              type="button"
              onClick={() => { setDeclineOpen(false); setReason(""); }}
              disabled={busy}
              style={{ background: "transparent", color: MUTED, border: `1px solid ${RULE}`, padding: "6px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtTimePretty(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

function roleLabel(r) {
  return r === "developing" ? "Developing" : "Lead";
}

// Instructor lines for a SUB. A sub covers one instructor's slot for a single
// day, so the person whose day they're filling (the parent assignment's
// instructor) isn't on site that day — showing them under "Teaching with" would
// be wrong. Split them out as "Covering for" and hand the remaining instructor(s)
// — the ones actually there that day, e.g. the lead — to CoInstructorLine.
function SubInstructorLines({ coInstructors = [], coveredInstructorId }) {
  if (!coInstructors.length) return null;
  const covered = coveredInstructorId
    ? coInstructors.find((c) => c.instructor_id === coveredInstructorId) ?? null
    : null;
  const teammates = coInstructors.filter((c) => c.instructor_id !== coveredInstructorId);
  return (
    <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
      {covered && (
        <div style={{ marginBottom: teammates.length ? 4 : 0 }}>
          Covering for <span style={{ color: INK, fontWeight: 600 }}>{covered.name}</span> ({roleLabel(covered.role)})
        </div>
      )}
      <CoInstructorLine coInstructors={teammates} />
    </div>
  );
}

// Names the other instructor(s) on the same camp/class — a lead sees their
// developing instructor, a developing instructor sees their lead — with each
// other's email + phone so co-teachers can coordinate directly.
function CoInstructorLine({ coInstructors = [] }) {
  if (!coInstructors.length) return null;
  return (
    <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
      {coInstructors.map((c, i) => {
        const tel = c.phone ? c.phone.replace(/[^0-9+]/g, "") : "";
        return (
          <div key={`${c.instructor_id || c.name}-${i}`} style={{ marginTop: i > 0 ? 4 : 0 }}>
            Teaching with ({roleLabel(c.role)}){" "}
            <span style={{ color: INK, fontWeight: 600 }}>{c.name}</span>
            {(c.email || c.phone) && (
              <span>
                {" — "}
                {c.email && (
                  <a href={`mailto:${c.email}`} style={{ color: PURPLE, textDecoration: "underline" }}>{c.email}</a>
                )}
                {c.email && c.phone ? " · " : ""}
                {c.phone && (
                  <a href={`tel:${tel}`} style={{ color: PURPLE, textDecoration: "underline" }}>{c.phone}</a>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AssignmentCard({ assignment, coInstructors = [], messages = [], busy, onAccept, onRequestChange, readOnly, onOpen }) {
  const s = assignment.camp_sessions;
  if (!s) return null;
  const role = assignment.role === "developing" ? "Developing" : "Lead";
  const statusColor =
    assignment.status === "confirmed" ? OK_GREEN :
    assignment.status === "change_requested" ? VIOLET :
    PURPLE;
  const statusLabel =
    assignment.status === "confirmed" ? "Confirmed ✓" :
    assignment.status === "change_requested" ? "Change requested — waiting on admin" :
    "Awaiting your response";

  // Per amended spec §4.4: when status is change_requested, look at the
  // newest message in the thread. If it's from admin (sender_role='admin'),
  // the instructor's "Request change" button re-enables — they can send
  // another change request OR accept the original offer. If the newest
  // message is the instructor's own (or there's no admin reply yet), the
  // Request Change button is disabled.
  const sortedMsgs = [...messages].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  const latestMsg = sortedMsgs[0];
  const awaitingAdminReply =
    assignment.status === "change_requested" &&
    latestMsg?.sender_role === "instructor";
  const requestChangeDisabled = busy || awaitingAdminReply;

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderLeft: `3px solid ${statusColor}`,
      borderRadius: 8,
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
            {s.curriculum_name} <span style={{ fontWeight: 400, color: MUTED, fontSize: 12, marginLeft: 4 }}>· {role}</span>
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.4 }}>
            Week {s.week_num} · {fmtShort(s.starts_on)} – {fmtShort(s.ends_on)}<br />
            {s.location_name} · {titleCase(s.session_type)} {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
          </div>
        </div>
        <span style={{ fontSize: 11, color: statusColor, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right", maxWidth: 130, flexShrink: 0, lineHeight: 1.35 }}>
          {statusLabel}
        </span>
      </div>

      <CoInstructorLine coInstructors={coInstructors} />

      {assignment.distance_bonus_cents ? (
        <div style={{ fontSize: 13, color: PURPLE, fontWeight: 600 }}>
          + {dollars(assignment.distance_bonus_cents)} distance bonus
        </div>
      ) : null}

      {/* Message thread renders on change_requested cards. Read-only on
          instructor side; admin replies via offer-message-reply elsewhere. */}
      {assignment.status === "change_requested" && messages.length > 0 && (
        <div style={{ marginTop: 4, padding: 10, background: `${VIOLET}10`, border: `1px solid ${VIOLET}`, borderRadius: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Messages
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[...messages]
              .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
              .map((m) => (
                <div key={m.id} style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: m.sender_role === "admin" ? PURPLE : MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 6 }}>
                    {m.sender_role === "admin" ? "Admin" : "You"}
                  </span>
                  {m.message}
                </div>
              ))}
          </div>
        </div>
      )}

      {readOnly && onOpen && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={onOpen}
            style={{
              background: "transparent",
              border: "none",
              color: PURPLE,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              padding: 0,
            }}
          >
            View details, roster, and materials →
          </button>
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            style={{
              padding: "8px 14px",
              background: BRIGHT,
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : "Accept"}
          </button>
          <button
            type="button"
            onClick={onRequestChange}
            disabled={requestChangeDisabled}
            title={awaitingAdminReply ? "You already requested a change — wait for your coordinator to reply, then you can send another." : ""}
            style={{
              padding: "8px 14px",
              background: "transparent",
              color: PURPLE,
              border: `1px solid ${PURPLE}`,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: requestChangeDisabled ? "not-allowed" : "pointer",
              opacity: requestChangeDisabled ? 0.5 : 1,
            }}
          >
            {assignment.status === "change_requested" ? "Send another change request" : "Request change"}
          </button>
        </div>
      )}
    </div>
  );
}

function AfterschoolAssignmentCard({ assignment, coInstructors = [], messages = [], busy, onAccept, onRequestChange, readOnly }) {
  const p = assignment.programs;
  if (!p) return null;
  const statusColor =
    assignment.status === "confirmed" ? OK_GREEN :
    assignment.status === "change_requested" ? VIOLET :
    PURPLE;
  const statusLabel =
    assignment.status === "confirmed" ? "Confirmed ✓" :
    assignment.status === "change_requested" ? "Change requested — waiting on admin" :
    "Awaiting your response";

  const sortedMsgs = [...messages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const latestMsg = sortedMsgs[0];
  const awaitingAdminReply = assignment.status === "change_requested" && latestMsg?.sender_role === "instructor";
  const requestChangeDisabled = busy || awaitingAdminReply;

  const when = [asDayName(p.day_of_week), [p.start_time, p.end_time].filter(Boolean).join("–")].filter(Boolean).join(" · ");
  const loc = p.program_locations;

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderLeft: `3px solid ${statusColor}`,
      borderRadius: 8,
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
            {p.curriculum || "Class"} <span style={{ fontWeight: 400, color: PURPLE, fontSize: 12, marginLeft: 4 }}>· after-school</span>
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.4 }}>
            {when} · <strong style={{ color: PURPLE, fontWeight: 600 }}>all term</strong><br />
            {loc?.name || ""}{loc?.room_number ? ` · Room ${loc.room_number}` : ""}
          </div>
        </div>
        <span style={{ fontSize: 11, color: statusColor, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right", maxWidth: 130, flexShrink: 0, lineHeight: 1.35 }}>
          {statusLabel}
        </span>
      </div>

      <CoInstructorLine coInstructors={coInstructors} />

      {assignment.distance_bonus_cents ? (
        <div style={{ fontSize: 13, color: PURPLE, fontWeight: 600 }}>
          + {dollars(assignment.distance_bonus_cents)} bonus
        </div>
      ) : null}

      {assignment.status === "change_requested" && messages.length > 0 && (
        <div style={{ marginTop: 4, padding: 10, background: `${VIOLET}10`, border: `1px solid ${VIOLET}`, borderRadius: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Messages
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[...messages]
              .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
              .map((m) => (
                <div key={m.id} style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: m.sender_role === "admin" ? PURPLE : MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 6 }}>
                    {m.sender_role === "admin" ? "Admin" : "You"}
                  </span>
                  {m.message}
                </div>
              ))}
          </div>
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            style={{ padding: "8px 14px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Saving…" : "Accept"}
          </button>
          <button
            type="button"
            onClick={onRequestChange}
            disabled={requestChangeDisabled}
            title={awaitingAdminReply ? "You already requested a change — wait for your coordinator to reply, then you can send another." : ""}
            style={{ padding: "8px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 500, fontFamily: "inherit", cursor: requestChangeDisabled ? "not-allowed" : "pointer", opacity: requestChangeDisabled ? 0.5 : 1 }}
          >
            {assignment.status === "change_requested" ? "Send another change request" : "Request change"}
          </button>
        </div>
      )}
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  );
}

function asDayName(dow) {
  if (dow == null) return "";
  const k = String(dow).trim().toLowerCase();
  const map = { monday: "Mondays", tuesday: "Tuesdays", wednesday: "Wednesdays", thursday: "Thursdays", friday: "Fridays" };
  return map[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
}

function ChangeRequestDialog({ assignment, value, onChange, busy, onSubmit, onClose }) {
  const isProgram = assignment.kind === "program";
  const s = assignment.camp_sessions;
  const p = assignment.programs;
  const crTitle = isProgram ? (p?.curriculum ?? "Class") : s?.curriculum_name;
  const crSub = isProgram
    ? [asDayName(p?.day_of_week), p?.program_locations?.name].filter(Boolean).join(" · ")
    : `Week ${s?.week_num} · ${s?.location_name}`;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        width: "100%",
        maxWidth: 480,
      }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
            Request change
          </div>
          <h2 style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 700, color: INK }}>
            {crTitle}
          </h2>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {crSub}
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 6 }}>
            Tell your admin why
          </label>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="e.g., I can't do this week — my kids are at a different camp."
            rows={4}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              fontFamily: "inherit",
              color: INK,
              background: "#fff",
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />
          <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
            Your admin will see your message and either reassign this camp or reply.
          </div>
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={onSubmit} disabled={busy || !value.trim()} style={{ padding: "8px 14px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: (busy || !value.trim()) ? 0.6 : 1 }}>
            {busy ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Documents view: lists the contractor's reference documents.
//
// Three doc keys come from `legal_documents` via the existing
// get-legal-document edge function (RLS hides legal_documents from
// instructor JWTs, so the wizard helper is reused). W-9 / tax forms are
// not stored here — Stripe handles them and surfaces them via the Express
// dashboard, so that row links out instead of opening an inline reader.
const DRAWER_DOCS = [
  { key: "contractor_agreement", label: "Independent contractor agreement" },
  { key: "pay_schedule", label: "Pay schedule" },
  { key: "attendance_policy", label: "Attendance policy (absence, tardy, pay deductions)" },
];

function DocumentsView({ onBack }) {
  const [openKey, setOpenKey] = useState(null);

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{
          background: "transparent",
          border: "none",
          color: PURPLE,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          padding: 0,
          marginBottom: 12,
        }}
      >
        ← Back
      </button>
      <h1 style={{ margin: "0 0 4px", fontSize: 24, fontWeight: 700, color: INK, letterSpacing: -0.3 }}>
        Documents
      </h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "0 0 18px" }}>
        Your agreement, pay schedule, attendance policy, and tax forms — all in one place.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {DRAWER_DOCS.map((d) => (
          <LegalDocRow
            key={d.key}
            docKey={d.key}
            label={d.label}
            isOpen={openKey === d.key}
            onToggle={() => setOpenKey((cur) => (cur === d.key ? null : d.key))}
          />
        ))}
        <StripeTaxFormsRow />
      </div>
    </div>
  );
}

function LegalDocRow({ docKey, label, isOpen, onToggle }) {
  const [doc, setDoc] = useState(null); // { title, body_text, version }
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // BUG FIX: `loading` was in the deps array previously, which caused the
    // setLoading(true) below to trigger a re-render -> the effect's cleanup
    // cancelled the in-flight fetch -> setDoc/setLoading(false) never ran ->
    // "Loading…" forever. Removed from deps. The `doc` check is sufficient
    // to prevent re-fetches after success.
    if (!isOpen || doc) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data, error } = await fetchLegalDocument(docKey);
        if (cancelled) return;
        if (error) {
          setLoadErr("Couldn't load this document. Try again, or contact your admin.");
          setLoading(false);
          return;
        }
        setDoc({
          title: data.title,
          body_text: data.body_text,
          version: data.document_version,
        });
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error("[DocumentsView] load failed", err);
          setLoadErr("Something went wrong.");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, docKey, doc]);

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "14px 16px",
          textAlign: "left",
          fontSize: 15,
          fontWeight: 600,
          color: INK,
          fontFamily: "inherit",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{label}</span>
        <Chevron open={isOpen} color={MUTED} size={14} />
      </button>
      {isOpen && (
        <div style={{ borderTop: `1px solid ${RULE}`, padding: "14px 16px", background: "#fafaf6" }}>
          {loading && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}
          {loadErr && <div style={{ color: CORAL, fontSize: 13 }}>{loadErr}</div>}
          {doc && (
            <div>
              <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>
                Version {doc.version}
              </div>
              <div style={{ maxHeight: "50vh", overflowY: "auto", fontSize: 14, color: INK, lineHeight: 1.55 }}>
                {(doc.body_text || "").split(/\n\s*\n/).map((para, i) => (
                  <p key={i} style={{ margin: "0 0 10px", whiteSpace: "pre-wrap" }}>
                    {linkifyText(para)}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StripeTaxFormsRow() {
  // W-9 + 1099 live in Stripe Express. We can't render them inline — Stripe
  // requires authentication on their domain. The signed-in deep link
  // hands them straight into their own dashboard without a re-login.
  return (
    <StripeExpressDeepLink
      variant="row"
      title="W-9 and 1099 tax forms"
      subtitle="Stored by Stripe — opens your Stripe Express dashboard."
    />
  );
}

// Renders a button (or full-width row) that, on click, fetches a fresh
// signed Stripe Express login link from create-stripe-express-login-link
// and opens it in a new tab. Two visual variants:
//   variant="row"     — full-width card matching the legal-doc rows
//                       (used in DocumentsView).
//   variant="button"  — compact pill (used in PayView footer).
//
// Disables itself + surfaces a "complete Stripe onboarding first" hint
// when the instructor doesn't have a stripe_connect_account_id yet.
function StripeExpressDeepLink({ variant = "button", title, subtitle }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function open() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const { data, error } = await supabase.functions.invoke(
        "create-stripe-express-login-link",
        { body: {} },
      );
      if (error || data?.error) {
        if (data?.error === "no_stripe_account") {
          setErr("Finish your Stripe onboarding first — it's in your onboarding wizard.");
        } else {
          setErr(data?.stripe_message || data?.error || error?.message || "Couldn't open your Stripe dashboard.");
        }
        return;
      }
      if (!data?.url) {
        setErr("Couldn't open your Stripe dashboard.");
        return;
      }
      // Open in a new tab. The link is short-lived (~5 minutes) so the
      // user should click → open → use immediately. We don't cache.
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      console.error("[StripeExpressDeepLink] failed", e);
      setErr("Couldn't open your Stripe dashboard. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (variant === "row") {
    return (
      <div>
        <button
          type="button"
          onClick={open}
          disabled={busy}
          style={{
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 8,
            padding: "14px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
            cursor: busy ? "wait" : "pointer",
            fontFamily: "inherit",
            textAlign: "left",
            color: INK,
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{subtitle}</div>
            )}
          </div>
          <span style={{ color: PURPLE, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
            {busy ? "Opening…" : "Open Stripe →"}
          </span>
        </button>
        {err && (
          <div style={{ marginTop: 6, padding: "8px 12px", background: `${CORAL}1F`, color: CORAL, borderRadius: 6, fontSize: 12 }}>
            {err}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        style={{
          padding: "10px 16px",
          background: "#fff",
          border: `1px solid ${PURPLE}`,
          color: PURPLE,
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: busy ? "wait" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "Opening…" : (title ?? "Open Stripe payouts dashboard →")}
      </button>
      {err && (
        <div style={{ marginTop: 6, padding: "8px 12px", background: `${CORAL}1F`, color: CORAL, borderRadius: 6, fontSize: 12 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function AssignmentDetailView({ assignment, coInstructors = [], onBack }) {
  const s = assignment.camp_sessions;
  const role = assignment.role === "developing" ? "Developing" : "Lead";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{
          background: "transparent",
          border: "none",
          color: PURPLE,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          padding: 0,
          marginBottom: 12,
        }}
      >
        ← Back to schedule
      </button>

      <div style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderLeft: `3px solid ${OK_GREEN}`,
        borderRadius: 8,
        padding: "16px 18px",
        marginBottom: 18,
      }}>
        <div style={{ fontSize: 11, color: OK_GREEN, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Confirmed
        </div>
        <h1 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 700, color: INK, letterSpacing: -0.3, lineHeight: 1.25 }}>
          {s.curriculum_name}
        </h1>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
          Week {s.week_num} · {fmt(s.starts_on)} – {fmt(s.ends_on)}<br />
          {s.location_name} · {titleCase(s.session_type)} {fmtTime(s.start_time)}–{fmtTime(s.end_time)}<br />
          {role} instructor
          {(s.ages_min || s.ages_max) ? ` · ages ${s.ages_min ?? "?"}–${s.ages_max ?? "?"}` : ""}
        </div>
        {coInstructors.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <CoInstructorLine coInstructors={coInstructors} />
          </div>
        )}
        {assignment.distance_bonus_cents ? (
          <div style={{ marginTop: 8, fontSize: 13, color: PURPLE, fontWeight: 600 }}>
            + {dollars(assignment.distance_bonus_cents)} distance bonus
          </div>
        ) : null}
      </div>

      <LocationSection location={s.program_locations} fallbackName={s.location_name} />
      <DailyCheckInSection
        assignmentId={assignment.id}
        campSessionId={s.id}
        startsOn={s.starts_on}
        endsOn={s.ends_on}
      />
      <RosterSection campSessionId={s.id} enrollment={s.current_enrollment} startsOn={s.starts_on} />
      <LessonsSection curriculumId={s.curriculum_id} curriculumName={s.curriculum_name} />
    </div>
  );
}

// Detail page for a confirmed sub day — the counterpart to AssignmentDetailView,
// reached from the read-only SubOfferCard's "View details" link so the schedule
// list stays compact. A sub is a single day (sub.date), so there's no multi-day
// DailyCheckInSection — the card itself carries the one-tap "Mark this day as
// taught". Roster + lessons only apply to camp subs (mirrors the card's prior
// inline behavior); program subs show location only.
function SubDetailView({ sub, onBack, onMarkTaught, markBusy, error, coInstructors = [] }) {
  const isCamp = sub.parent_assignment_type === "camp";
  const sess = isCamp ? sub.camp_parent?.camp_sessions ?? null : null;
  const prog = !isCamp ? sub.program_parent?.programs ?? null : null;
  const loc = isCamp ? sess?.program_locations ?? null : prog?.program_locations ?? null;
  const coveredInstructorId = isCamp ? sub.camp_parent?.instructor_id : sub.program_parent?.instructor_id;

  const curriculumName = isCamp ? (sess?.curriculum_name ?? "this camp") : (prog?.curriculum ?? "this program");
  const venueName = loc?.name ?? (isCamp ? sess?.location_name : null) ?? "";
  const startTime = isCamp ? sess?.start_time : prog?.start_time;
  const endTime = isCamp ? sess?.end_time : prog?.end_time;
  const timeRange = startTime && endTime ? `${fmtTimePretty(startTime)}–${fmtTimePretty(endTime)}` : (startTime ? fmtTimePretty(startTime) : "");
  const curriculumId = isCamp ? sess?.curriculum_id : prog?.curriculum_id;

  const friendlyDate = sub.date
    ? new Date(`${sub.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : "";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{
          background: "transparent",
          border: "none",
          color: PURPLE,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          padding: 0,
          marginBottom: 12,
        }}
      >
        ← Back to schedule
      </button>

      {error && (
        <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderLeft: `3px solid ${OK_GREEN}`,
        borderRadius: 8,
        padding: "16px 18px",
        marginBottom: 18,
      }}>
        <div style={{ fontSize: 11, color: VIOLET, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>
          Sub · {sub.sub_tier === "lead" ? "Lead" : "Developing"}
        </div>
        <h1 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 700, color: INK, letterSpacing: -0.3, lineHeight: 1.25 }}>
          {curriculumName}
        </h1>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
          {friendlyDate}{timeRange ? ` · ${timeRange}` : ""}{venueName ? ` · ${venueName}` : ""}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: sub.status === "taught" ? OK_GREEN : MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {sub.status === "taught" ? "✓ Taught" : "✓ Accepted"}
        </div>
        {coInstructors.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <SubInstructorLines coInstructors={coInstructors} coveredInstructorId={coveredInstructorId} />
          </div>
        )}
        {sub.notes && (
          <div style={{ fontSize: 13, color: INK, marginTop: 12, padding: 10, background: CREAM, borderLeft: `3px solid ${VIOLET}`, borderRadius: 4 }}>
            <span style={{ color: MUTED, fontWeight: 600 }}>Note: </span>{sub.notes}
          </div>
        )}
      </div>

      <LocationSection location={loc} fallbackName={venueName} />
      <SubCheckInSection sub={sub} onMarkTaught={onMarkTaught} markBusy={markBusy} />
      {isCamp && sess?.id && (
        <RosterSection campSessionId={sess.id} enrollment={sess.current_enrollment} startsOn={sess.starts_on} />
      )}
      {isCamp && curriculumId && (
        <LessonsSection curriculumId={curriculumId} curriculumName={curriculumName} />
      )}
    </div>
  );
}

// Single-day check-in for a sub — the one-day counterpart to DailyCheckInSection.
// A sub covers exactly one date, so there's one row: "Upcoming" before the day,
// a "Mark taught" button on/after it, and a green ✓ once taught. Marking routes
// through the parent's confirm-sub-delivery handler so the schedule card and this
// row stay in sync.
function SubCheckInSection({ sub, onMarkTaught, markBusy }) {
  if (!sub?.date) return null;
  const today = todayLocalISO();
  const isTaught = sub.status === "taught";
  const isFuture = sub.date > today;

  return (
    <Section title="Daily check-in">
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 16px" }}>
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 12, lineHeight: 1.5 }}>
          Mark this day after you teach it.{" "}
          {isTaught ? (
            <span style={{ color: OK_GREEN, fontWeight: 600 }}>All set — thanks!</span>
          ) : (
            <span>This is how your admin knows the day was covered.</span>
          )}
        </div>
        <DayRow
          date={sub.date}
          isToday={sub.date === today}
          isFuture={isFuture}
          existing={isTaught ? {} : null}
          loading={false}
          busy={markBusy}
          onMark={onMarkTaught}
        />
      </div>
    </Section>
  );
}

// Location details: address (Google Maps link), main phone (tel: link),
// room number, and separately-labeled arrival + dismissal procedures.
// Graceful fallback when address/phone/procedures are still null (TBD
// camp partners or sites where the partner hasn't sent procedures yet).
function LocationSection({ location, fallbackName }) {
  const name = location?.name || fallbackName;
  const address = location?.address || null;
  const phone = location?.contact_phone || null;
  const room = location?.room_number || null;
  const arrival = location?.arrival_instructions || null;
  const dismissal = location?.dismissal_instructions || null;
  const hasAnyDetails = address || phone || room || arrival || dismissal;

  const mapsHref = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;
  const telHref = phone ? `tel:${phone.replace(/[^0-9+]/g, "")}` : null;

  return (
    <section style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: "14px 16px",
      marginBottom: 14,
    }}>
      <div style={{ fontSize: 11, color: MUTED, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
        Location
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
        {name}
      </div>
      {room && (
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
          {room}
        </div>
      )}

      {address && (
        <div style={{ marginTop: 10 }}>
          <a
            href={mapsHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: PURPLE, fontSize: 14, textDecoration: "underline" }}
          >
            {address}
          </a>
          <div style={{ marginTop: 6 }}>
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block",
                padding: "6px 12px",
                background: BRIGHT,
                color: "#fff",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Open in Maps →
            </a>
          </div>
        </div>
      )}

      {phone && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Main phone
          </div>
          <a href={telHref} style={{ color: PURPLE, fontSize: 16, fontWeight: 600, textDecoration: "underline" }}>
            {phone}
          </a>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            Front desk / building main line. Use for anything urgent on-site.
          </div>
        </div>
      )}

      {arrival && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Arrival
          </div>
          <div style={{ fontSize: 14, color: INK, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {arrival}
          </div>
        </div>
      )}

      {dismissal && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Dismissal
          </div>
          <div style={{ fontSize: 14, color: INK, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {dismissal}
          </div>
        </div>
      )}

      {!hasAnyDetails && (
        <div style={{ marginTop: 10, fontSize: 13, color: MUTED, fontStyle: "italic" }}>
          Details coming soon — your Program Manager is still finalizing this site's info. Reach out to them if you need anything before then.
        </div>
      )}
    </section>
  );
}

// Daily check-in: one row per weekday between camp starts_on and ends_on.
// Past or today: "Mark taught" button that calls the edge function. Already
// marked: checkmark + when. Future: dimmed and inert.
//
// Assumes weekday-only camps (Mon-Fri). If a tenant ever runs Saturday/
// Sunday camps, this will hide those days and we need a workdays setting.
// Same shape as `session_type` on camp_sessions — a v2 enhancement.
function DailyCheckInSection({ assignmentId, campSessionId, startsOn, endsOn }) {
  const [confirmations, setConfirmations] = useState(null); // null = loading; Map by date string
  const [busyDate, setBusyDate] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!campSessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("session_delivery_confirmations")
          .select("id, session_date, confirmed_by, confirmed_at, pay_status")
          .eq("camp_session_id", campSessionId);
        if (cancelled) return;
        if (error) {
          console.error("[DailyCheckInSection] load failed", error);
          setErr("Couldn't load your check-ins. Refresh to try again.");
          setConfirmations(new Map());
          return;
        }
        const m = new Map();
        for (const r of data ?? []) m.set(r.session_date, r);
        setConfirmations(m);
      } catch (e) {
        if (!cancelled) {
          console.error("[DailyCheckInSection] load failed", e);
          setErr("Couldn't load your check-ins.");
          setConfirmations(new Map());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [campSessionId]);

  const days = useMemo(() => weekdayRange(startsOn, endsOn), [startsOn, endsOn]);
  const todayStr = todayLocalISO();

  async function markTaught(dateStr) {
    if (busyDate) return;
    setBusyDate(dateStr);
    setErr("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "confirm-session-taught",
        { body: { camp_assignment_id: assignmentId, session_date: dateStr } },
      );
      if (fnErr || data?.error) {
        setErr(humanizeConfirmError(data?.error || fnErr?.message));
        return;
      }
      // Update local state with the returned confirmation.
      setConfirmations((m) => {
        const next = new Map(m);
        next.set(dateStr, data.confirmation);
        return next;
      });
    } catch (e) {
      console.error("[DailyCheckInSection] mark failed", e);
      setErr("Couldn't save your check-in. Try again.");
    } finally {
      setBusyDate(null);
    }
  }

  if (days.length === 0) return null;

  const marked = confirmations ? confirmations.size : 0;
  const total = days.length;

  return (
    <Section title="Daily check-in">
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 16px" }}>
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 12, lineHeight: 1.5 }}>
          Mark each day after you teach it. {marked > 0 ? (
            <span style={{ color: OK_GREEN, fontWeight: 600 }}>{marked} of {total} marked.</span>
          ) : (
            <span>This is how your admin knows the session happened.</span>
          )}
        </div>

        {err && (
          <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {days.map((d) => {
            const existing = confirmations?.get(d);
            const isFuture = d > todayStr;
            const isToday = d === todayStr;
            return (
              <DayRow
                key={d}
                date={d}
                isToday={isToday}
                isFuture={isFuture}
                existing={existing}
                loading={confirmations === null}
                busy={busyDate === d}
                onMark={() => markTaught(d)}
              />
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function DayRow({ date, isToday, isFuture, existing, loading, busy, onMark }) {
  const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const confirmedAt = existing?.confirmed_at
    ? new Date(existing.confirmed_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const byAdmin = existing && existing.confirmed_by === "admin";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        background: existing ? `${OK_GREEN}0F` : isFuture ? "#fafafa" : CREAM,
        border: `1px solid ${existing ? `${OK_GREEN}55` : RULE}`,
        borderRadius: 6,
        opacity: isFuture ? 0.55 : 1,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
          {dayLabel}
          {isToday && !existing && (
            <span style={{ marginLeft: 8, fontSize: 10, color: PURPLE, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Today
            </span>
          )}
        </div>
        {existing && (
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            Marked taught{confirmedAt ? ` · ${confirmedAt}` : ""}
            {byAdmin && " · by admin"}
          </div>
        )}
      </div>

      {existing ? (
        <span style={{ color: OK_GREEN, fontSize: 18, fontWeight: 700 }} title="Marked taught">✓</span>
      ) : isFuture ? (
        <span style={{ color: MUTED, fontSize: 11, fontStyle: "italic" }}>
          {loading ? "" : "Upcoming"}
        </span>
      ) : (
        <button
          type="button"
          onClick={onMark}
          disabled={busy || loading}
          style={{
            padding: "6px 12px",
            background: BRIGHT,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: busy ? "wait" : "pointer",
            opacity: busy || loading ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {busy ? "Saving…" : "Mark taught"}
        </button>
      )}
    </div>
  );
}

// Generate Mon-Fri dates in [start, end] inclusive. Both inputs YYYY-MM-DD.
// Skips Saturdays (day=6) and Sundays (day=0).
function weekdayRange(start, end) {
  if (!start || !end) return [];
  const out = [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${dd}`);
  }
  return out;
}

function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function humanizeConfirmError(code) {
  if (!code) return "Couldn't save your check-in. Try again.";
  if (code === "session_date_in_future") return "You can't mark a future day taught yet.";
  if (code === "session_date_out_of_range") return "That date isn't within this camp's range.";
  if (code === "assignment_not_confirmed") return "This camp isn't fully confirmed yet — talk to your admin.";
  if (code === "forbidden") return "You're not assigned to this camp.";
  if (code === "session_covered_by_substitute") return "A substitute is covering this day — they'll handle the check-in.";
  return "Couldn't save your check-in. Try again.";
}

// Real per-camper roster for the camp_session. RLS gates this — the
// migration `instructors_read_camp_rosters` lets a confirmed instructor
// read registrations + their linked students for camps they're teaching.
//
// Three render states:
//   1. Loading.
//   2. We have rows: list them with name, grade/age, allergies (red
//      if non-empty), emergency contact, dietary, medical notes,
//      photo-release flag.
//   3. Nothing in registrations yet for this camp: fall back to the
//      aggregate enrollment count + "your admin imports the roster
//      before camp starts" copy.
function RosterSection({ campSessionId, enrollment, startsOn }) {
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!campSessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("registrations")
          .select(`
            id, status, payment_status, registered_at, notes,
            authorized_pickup_contacts, photo_release_consent,
            student:students (
              id, first_name, last_name, grade, birthdate, pronouns,
              allergies, dietary_restrictions, medical_notes, medical_conditions,
              epipen_required, medications_at_program,
              emergency_contact_name, emergency_contact_phone,
              special_needs_accommodations
            ),
            parent:parents (
              first_name, last_name, email, phone
            )
          `)
          .eq("camp_session_id", campSessionId)
          .not("status", "in", "(cancelled,withdrawn)")
          .order("registered_at", { ascending: true });
        if (cancelled) return;
        if (error) {
          console.error("[RosterSection] load failed", error);
          setErr("Couldn't load the roster. Refresh to try again.");
          setRows([]);
          return;
        }
        setRows(data ?? []);
      } catch (e) {
        if (!cancelled) {
          console.error("[RosterSection] load failed", e);
          setErr("Couldn't load the roster.");
          setRows([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [campSessionId]);

  const aggregateCount = typeof enrollment === "number" ? enrollment : null;
  const startTxt = startsOn ? fmtShort(startsOn) : null;

  return (
    <Section title="Roster">
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 16px" }}>
        {err && (
          <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
            {err}
          </div>
        )}

        {rows === null && !err && (
          <div style={{ color: MUTED, fontSize: 13 }}>Loading roster…</div>
        )}

        {rows !== null && rows.length === 0 && !err && (
          <div style={{ color: INK, fontSize: 14, lineHeight: 1.5 }}>
            {aggregateCount !== null ? (
              <div>
                <strong>{aggregateCount}</strong> camper{aggregateCount === 1 ? "" : "s"} registered so far.
              </div>
            ) : (
              <div>Enrollment count syncs from your registration platform before camp starts.</div>
            )}
            <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>
              The full roster (names, ages, allergies, emergency contacts) lands here
              {startTxt ? ` closer to ${startTxt}` : " closer to your start date"} — your admin will let you know when it's ready.
            </div>
          </div>
        )}

        {rows !== null && rows.length > 0 && (
          <>
            <div style={{ color: MUTED, fontSize: 12, marginBottom: 10 }}>
              {rows.length} camper{rows.length === 1 ? "" : "s"} on the roster
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rows.map((r) => (
                <CamperRow key={r.id} registration={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function CamperRow({ registration }) {
  const s = registration.student;
  if (!s) return null;
  const p = registration.parent;
  const displayName = `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "Unnamed camper";
  const age = ageFromDob(s.birthdate);
  const hasAllergies = (s.allergies ?? "").trim().length > 0;
  const hasMedical = ((s.medical_notes ?? "") + (s.medical_conditions ?? "")).trim().length > 0 || s.epipen_required;
  const parentName = p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "";

  return (
    <div
      style={{
        background: CREAM,
        border: `1px solid ${RULE}`,
        borderLeft: hasAllergies || hasMedical ? `3px solid ${CORAL}` : `1px solid ${RULE}`,
        borderRadius: 6,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
            {displayName}
            {s.pronouns && (
              <span style={{ color: MUTED, fontSize: 11, marginLeft: 6, fontWeight: 500 }}>
                ({s.pronouns})
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {age !== null && <>age {age}</>}
            {s.grade != null && <>{age !== null ? " · " : ""}grade {s.grade}</>}
          </div>
        </div>
      </div>

      {/* Parent contact — always show if we have a parent row at all.
          The instructor calls the parent first for pickup or anything
          non-emergency; emergency contact is the secondary number. */}
      {p && (
        <div style={{ marginTop: 8, padding: "6px 10px", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, color: INK }}>
          <strong style={{ color: INK }}>Parent:</strong>{" "}
          {parentName || <em style={{ color: MUTED }}>name not on file</em>}
          {p.phone && <> · {p.phone}</>}
          {p.email && <> · {p.email}</>}
        </div>
      )}

      {hasAllergies && (
        <div style={{ marginTop: 6, padding: "6px 10px", background: `${CORAL}1F`, border: `1px solid ${CORAL}55`, borderRadius: 4, fontSize: 12, color: INK }}>
          <strong style={{ color: CORAL }}>Allergies:</strong> {s.allergies}
        </div>
      )}

      {/* Always show a Medical line. If something's there, render it
          (with EpiPen flag in coral if applicable). If nothing's there,
          state "None reported by parent" so the instructor knows the
          parent affirmatively answered "No"/"None" in the Squarespace
          health-conditions field. */}
      <div style={{ marginTop: 6, padding: "6px 10px", background: hasMedical ? `${CORAL}10` : "#fff", border: `1px solid ${hasMedical ? `${CORAL}33` : RULE}`, borderRadius: 4, fontSize: 12, color: INK }}>
        <strong>Medical:</strong>{" "}
        {hasMedical ? (
          <>
            {s.epipen_required && <span style={{ color: CORAL, fontWeight: 700 }}>EpiPen required. </span>}
            {[s.medical_conditions, s.medical_notes, s.medications_at_program ? `Meds: ${s.medications_at_program}` : null]
              .filter(Boolean)
              .join(" · ") || <em style={{ color: MUTED }}>None reported by parent</em>}
          </>
        ) : (
          <em style={{ color: MUTED }}>None reported by parent</em>
        )}
      </div>

      {s.dietary_restrictions && (
        <div style={{ marginTop: 6, fontSize: 12, color: INK }}>
          <strong>Dietary:</strong> {s.dietary_restrictions}
        </div>
      )}

      {s.special_needs_accommodations && (
        <div style={{ marginTop: 6, fontSize: 12, color: INK }}>
          <strong>Accommodations:</strong> {s.special_needs_accommodations}
        </div>
      )}

      {(s.emergency_contact_name || s.emergency_contact_phone) && (
        <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
          <strong style={{ color: INK }}>Emergency contact:</strong>{" "}
          {s.emergency_contact_name}
          {s.emergency_contact_phone && ` · ${s.emergency_contact_phone}`}
        </div>
      )}

      {registration.authorized_pickup_contacts && (
        <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
          <strong style={{ color: INK }}>Authorized pickup:</strong> {registration.authorized_pickup_contacts}
        </div>
      )}

      {registration.notes && (
        <div style={{ marginTop: 6, fontSize: 12, color: MUTED, fontStyle: "italic" }}>
          Note: {registration.notes}
        </div>
      )}
    </div>
  );
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

function LessonsSection({ curriculumId, curriculumName }) {
  const [docs, setDocs] = useState(null); // null = loading, [] = empty
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!curriculumId) {
      setDocs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke(
          "get-instructor-curriculum-docs",
          { body: { curriculum_id: curriculumId } },
        );
        if (cancelled) return;
        if (error || data?.error) {
          setErr(data?.error === "not_assigned_to_curriculum"
            ? "We couldn't find materials for this camp yet."
            : "Couldn't load materials. Try again later.");
          setDocs([]);
          return;
        }
        setDocs(data?.documents ?? []);
      } catch (e) {
        if (!cancelled) {
          console.error("[LessonsSection] load failed", e);
          setErr("Couldn't load materials.");
          setDocs([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [curriculumId]);

  return (
    <Section title="Lessons & materials">
      <div style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 8,
        padding: "14px 16px",
      }}>
        {docs === null ? (
          <div style={{ color: MUTED, fontSize: 13 }}>Loading materials…</div>
        ) : err ? (
          <div style={{ color: MUTED, fontSize: 13 }}>{err}</div>
        ) : docs.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
            No materials uploaded yet for <strong style={{ color: INK }}>{curriculumName}</strong>. Your admin will add the instructor guide and materials list before camp starts.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {DOC_TYPE_ORDER.map((type) => {
              const inType = docs.filter((d) => d.doc_type === type);
              if (inType.length === 0) return null;
              return (
                <div key={type}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
                    {DOC_TYPE_LABEL[type]}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {inType.map((d) => <DocLinkRow key={d.id} doc={d} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Section>
  );
}

const DOC_TYPE_ORDER = ["instructor_guide", "materials_list", "student_materials", "other"];
const DOC_TYPE_LABEL = {
  instructor_guide: "Instructor guide",
  materials_list: "Materials list",
  student_materials: "Student materials",
  other: "Other",
};

function docViewerUrl(signedUrl, filename) {
  if (!signedUrl || !filename) return signedUrl;
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "pdf" || !["docx","doc","xlsx","xls","pptx","ppt","txt","md"].includes(ext)) return signedUrl;
  return `https://docs.google.com/gview?url=${encodeURIComponent(signedUrl)}&embedded=true`;
}

function fileExtBadge(filename) {
  if (!filename) return null;
  const ext = (filename.split(".").pop() || "").toUpperCase();
  if (!ext) return null;
  const colors = { PDF: "#c0392b", DOCX: "#2b5797", DOC: "#2b5797", XLSX: "#217346", XLS: "#217346", TXT: "#6b6b6b", MD: "#6b6b6b" };
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: colors[ext] || "#6b6b6b", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>
      {ext}
    </span>
  );
}

function DocLinkRow({ doc }) {
  const name = doc.original_filename || (doc.source_type === "drive_link" ? "Open in Drive" : "Open");
  const href = doc.download_url;
  if (!href) {
    return (
      <div style={{ fontSize: 13, color: MUTED, padding: "8px 10px", background: "#fafaf6", border: `1px solid ${RULE}`, borderRadius: 6 }}>
        {name} — temporarily unavailable.
      </div>
    );
  }
  const viewUrl = doc.source_type === "drive_link" ? href : docViewerUrl(href, doc.original_filename);
  const isDirect = viewUrl === href;
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 4,
      padding: "10px 12px",
      background: "#fafaf6",
      border: `1px solid ${RULE}`,
      borderRadius: 6,
    }}>
      <a
        href={viewUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          textDecoration: "none",
          color: INK,
          fontSize: 13,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", marginRight: 12 }}>
          {fileExtBadge(doc.original_filename)}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        </span>
        <span style={{ color: PURPLE, fontWeight: 600, flexShrink: 0 }}>
          Open →
        </span>
      </a>
      {!isDirect && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: MUTED, textDecoration: "underline", marginLeft: 1 }}
        >
          Can't view? Download instead
        </a>
      )}
    </div>
  );
}

// PayView: instructor's own pay summary. Groups their
// session_delivery_confirmations by camp_session and adds distance bonus
// (from the linked camp_assignment, paid once per camp). Top of page
// shows season totals.
//
// RLS already restricts session_delivery_confirmations to the
// instructor's own rows via instructor_read_confirmations
// (instructor_id = private.current_instructor_id()). We pass the
// explicit .eq() too as defense-in-depth.
//
// Status copy is user-friendly, not the raw enum:
//   pending  -> "Processing"
//   approved -> "Approved for payout"
//   adjusted -> "Adjusted"
//   withheld -> "Held — contact admin"
function PayView({ instructorId, onBack }) {
  const [data, setData] = useState(null); // null = loading
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!instructorId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: confs, error: confErr } = await supabase
          .from("session_delivery_confirmations")
          .select(
            `id, camp_session_id, session_date, session_type, confirmed_by,
             confirmed_at, pay_status, pay_amount_cents,
             pay_adjustment_cents, pay_adjustment_reason`
          )
          .eq("instructor_id", instructorId)
          .not("camp_session_id", "is", null)
          .order("session_date", { ascending: false });
        if (confErr) throw confErr;
        if (cancelled) return;

        const rows = confs ?? [];
        if (rows.length === 0) {
          setData({ camps: [], totals: emptyTotals() });
          return;
        }

        const sessionIds = [...new Set(rows.map((r) => r.camp_session_id))];

        const [{ data: sessions }, { data: assignments }] = await Promise.all([
          supabase
            .from("camp_sessions")
            .select("id, curriculum_name, starts_on, ends_on, location_name, week_num, session_type")
            .in("id", sessionIds),
          supabase
            .from("camp_assignments")
            .select("camp_session_id, role, distance_bonus_cents")
            .eq("instructor_id", instructorId)
            .in("camp_session_id", sessionIds),
        ]);

        const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));
        const assignmentBySession = new Map(
          (assignments ?? []).map((a) => [a.camp_session_id, a])
        );

        // Group by camp_session.
        const grouped = new Map();
        for (const r of rows) {
          if (!grouped.has(r.camp_session_id)) {
            const sess = sessionById.get(r.camp_session_id);
            const assn = assignmentBySession.get(r.camp_session_id);
            grouped.set(r.camp_session_id, {
              session: sess,
              role: assn?.role ?? null,
              distance_bonus_cents: assn?.distance_bonus_cents ?? 0,
              confirmations: [],
            });
          }
          grouped.get(r.camp_session_id).confirmations.push(r);
        }

        const camps = [...grouped.values()]
          .filter((g) => g.session) // skip rows whose camp_session is missing
          .sort((a, b) =>
            (b.session.starts_on ?? "").localeCompare(a.session.starts_on ?? "")
          );

        // Totals across everything visible to this instructor.
        const totals = camps.reduce(
          (acc, c) => {
            const base = c.confirmations.reduce((s, r) => s + (r.pay_amount_cents ?? 0), 0);
            const bonus = c.confirmations.reduce((s, r) => s + (r.pay_adjustment_cents ?? 0), 0);
            const distance = c.distance_bonus_cents ?? 0;
            const grand = base + bonus + distance;
            acc.base += base;
            acc.bonus += bonus;
            acc.distance += distance;
            acc.grand += grand;
            // Stage-by-status totals.
            for (const r of c.confirmations) {
              const stage = r.pay_status === "approved" ? "approved"
                : r.pay_status === "withheld" ? "held"
                : "processing";
              acc.byStage[stage] += (r.pay_amount_cents ?? 0) + (r.pay_adjustment_cents ?? 0);
            }
            // Distance bonus follows the worst-case status of any confirmation.
            const worst = worstPayStatus(c.confirmations.map((r) => r.pay_status));
            const stage = worst === "approved" ? "approved" : worst === "withheld" ? "held" : "processing";
            acc.byStage[stage] += distance;
            return acc;
          },
          { base: 0, bonus: 0, distance: 0, grand: 0, byStage: { approved: 0, processing: 0, held: 0 } }
        );

        if (!cancelled) setData({ camps, totals });
      } catch (e) {
        console.error("[PayView] load failed", e);
        if (!cancelled) {
          setErr("Couldn't load your pay. Try again.");
          setData({ camps: [], totals: emptyTotals() });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [instructorId]);

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{
          background: "transparent",
          border: "none",
          color: PURPLE,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          padding: 0,
          marginBottom: 12,
        }}
      >
        ← Back to schedule
      </button>

      <h1 style={{ margin: "0 0 6px", fontSize: 24, fontWeight: 700, color: INK, letterSpacing: -0.3 }}>
        Your pay
      </h1>
      <p style={{ color: MUTED, margin: "0 0 18px", fontSize: 13, lineHeight: 1.5 }}>
        Earned from camps you marked taught. Updates the moment you check in on the assignment detail.
      </p>

      {err && (
        <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {err}
        </div>
      )}

      {data === null && (
        <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
      )}

      {data !== null && data.camps.length === 0 && !err && (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 28, color: MUTED, textAlign: "center", lineHeight: 1.5 }}>
          You haven't marked any sessions taught yet. Open a confirmed camp, then use <strong>Daily check-in</strong> after each day to start tracking pay.
        </div>
      )}

      {data !== null && data.camps.length > 0 && (
        <>
          <PayTotalsCard totals={data.totals} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            {data.camps.map((c) => (
              <PayCampCard key={c.session.id} entry={c} />
            ))}
          </div>
        </>
      )}

      {data !== null && (
        <div style={{ marginTop: 22, padding: "16px 18px", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12 }}>
          <div style={{ fontSize: 13, color: INK, fontWeight: 600, marginBottom: 4 }}>
            Manage payouts, bank info, and tax docs
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
            Opens your Stripe Express. If your account isn&rsquo;t finished yet, you&rsquo;ll land on the setup form to add your bank, address, and SSN &mdash; Stripe will pick up where you left off. If you&rsquo;re done, you go straight to your payouts dashboard where your W&#8209;9 and 1099 live.
          </div>
          <StripeExpressDeepLink variant="button" title="Open your Stripe Express →" />
        </div>
      )}
    </div>
  );
}

function PayTotalsCard({ totals }) {
  return (
    <div style={{ background: PURPLE, color: "#fff", borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.8 }}>
        Total earned
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, marginTop: 2, letterSpacing: -0.5 }}>
        {dollars(totals.grand)}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 10,
        marginTop: 14,
        fontSize: 11,
      }}>
        <StageBlock label="Processing" amount={totals.byStage.processing} />
        <StageBlock label="Approved" amount={totals.byStage.approved} />
        <StageBlock label="On hold" amount={totals.byStage.held} />
      </div>
    </div>
  );
}

function StageBlock({ label, amount }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 10px" }}>
      <div style={{ opacity: 0.8, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{dollars(amount)}</div>
    </div>
  );
}

function PayCampCard({ entry }) {
  const s = entry.session;
  const confs = entry.confirmations.slice().sort((a, b) => (a.session_date ?? "").localeCompare(b.session_date ?? ""));
  const base = confs.reduce((acc, r) => acc + (r.pay_amount_cents ?? 0), 0);
  const bonus = confs.reduce((acc, r) => acc + (r.pay_adjustment_cents ?? 0), 0);
  const distance = entry.distance_bonus_cents ?? 0;
  const grand = base + bonus + distance;
  const worst = worstPayStatus(confs.map((r) => r.pay_status));
  const friendlyStatus = friendlyPayStatus(worst);

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
            {s.curriculum_name}
            {s.week_num && (
              <span style={{ color: MUTED, marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
                · Week {s.week_num}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.5 }}>
            {fmtShort(s.starts_on)} – {fmtShort(s.ends_on)}
            {s.location_name && ` · ${s.location_name}`}
            {entry.role && ` · ${entry.role}`}
          </div>
        </div>
        <div style={{ textAlign: "right", minWidth: 120 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>
            {dollars(grand)}
          </div>
          <div
            style={{
              display: "inline-block",
              marginTop: 4,
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: friendlyStatus.color,
              background: `${friendlyStatus.color}1F`,
              border: `1px solid ${friendlyStatus.color}55`,
            }}
          >
            {friendlyStatus.label}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}`, fontSize: 12, color: MUTED, lineHeight: 1.6 }}>
        <div>
          <strong>{confs.length} day{confs.length === 1 ? "" : "s"} marked taught:</strong>{" "}
          {confs.map((c, i) => (
            <span key={c.id}>
              {fmtShort(c.session_date)}
              {c.confirmed_by === "admin" && (
                <span style={{ fontStyle: "italic" }}> (by admin)</span>
              )}
              {i < confs.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 12 }}>
          <span>Base: <strong style={{ color: INK }}>{dollars(base)}</strong></span>
          {bonus > 0 && <span>Bonus: <strong style={{ color: INK }}>{dollars(bonus)}</strong></span>}
          {distance > 0 && <span>Distance: <strong style={{ color: INK }}>{dollars(distance)}</strong></span>}
        </div>
        {confs.some((c) => c.pay_adjustment_reason) && (
          <div style={{ marginTop: 6, fontStyle: "italic" }}>
            {confs.filter((c) => c.pay_adjustment_reason).map((c) => c.pay_adjustment_reason).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

function worstPayStatus(statuses) {
  const order = ["withheld", "adjusted", "pending", "approved"];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses[0] ?? "pending";
}

function friendlyPayStatus(s) {
  switch (s) {
    case "approved":
      return { label: "Approved for payout", color: OK_GREEN };
    case "adjusted":
      return { label: "Adjusted", color: VIOLET };
    case "withheld":
      return { label: "Held — contact admin", color: CORAL };
    case "pending":
    default:
      return { label: "Processing", color: "#b67e00" };
  }
}

function emptyTotals() {
  return { base: 0, bonus: 0, distance: 0, grand: 0, byStage: { approved: 0, processing: 0, held: 0 } };
}
