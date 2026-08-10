// /admin/programs
// Calendar/list view of scheduled programs for a selected term.
// Row-level "Change class" affordance lets an admin swap a program's curriculum.
// Live enrollment count = registrations.payment_status='paid' (excluding cancelled).
// Multi-tenant: scoped by the caller's organization_id.
//
// Two view modes:
//   - calendar: programs grouped by day-of-week, sorted by start_time (default)
//   - by_school: programs grouped by program_location, sorted by day/time within school

// useRef is load-bearing, not decorative: the panel's row-resync effect compares
// against the row it was last seeded from. Adding the hook without adding the
// import white-screened /admin/programs while npm run build and 76 unit tests all
// passed - JSX is never type-checked, so a missing binding is a RUNTIME
// ReferenceError, invisible to every static gate.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import EditProgramCurriculumModal from "./EditProgramCurriculumModal.jsx";
import ShareProgram from "../../../components/ShareProgram.jsx";
import ShareLink from "../../../components/ShareLink.jsx";
import EnnieTip from "../../../components/EnnieTip.jsx";
import EmbedSnippet from "../../../components/EmbedSnippet.jsx";
import { buildCatalogUrl } from "../../../lib/regLinks.js";
import { fetchOrgTerms, formatTermLabel } from "../../../lib/terms.js";
import { getPermissions } from "../../../lib/permissions.js";
import { pixelWorkflowCreated } from "../../../lib/metaPixel.js";
import { PROGRAM_DESCRIPTION_MAX, describeDescriptionLength } from "../../../lib/programText.js";
import { GRADE_OPTIONS, audienceMode, audiencePatch, rangeBackwards, rangeBackwardsMessage } from "../../../lib/grades.js";
import {
  publishBlockedByStripe,
  publishErrorMessage,
  PUBLISH_GATE_CTA,
  PUBLISH_GATE_WHY,
  PUBLISH_GATE_STAYS_DRAFT_HINT,
  STRIPE_CONNECT_ROUTE,
} from "../../../lib/publishGate.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)

// Indexed by Date.getDay() (0 = Sunday) — used to warn when a program's first
// session date falls on a different weekday than its selected day-of-week.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
// Matches the RED on Payments, so "you've hit the limit" is the same colour the
// admin already uses for that meaning.
const RED = "#b53737";
const PANEL = "#fff";

const AMBER = "#a16207";
const ENROPS_GOLD = "#F8A638";  // brand warm accent (matches the email/brand palette)
const OK_GREEN = "#3a7c3a";

const DAYS_OF_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Mirror of the SQL function term_to_school_year() in
// supabase/migrations/20260601_district_calendars.sql. Update both together
// if the term naming convention ever changes.
function termToSchoolYearJs(term) {
  if (typeof term !== "string" || term.length < 4) return null;
  const prefix = term.slice(0, 2).toUpperCase();
  const yy = parseInt(term.slice(2), 10);
  if (!Number.isFinite(yy)) return null;
  if (prefix === "FA") return `20${String(yy).padStart(2, "0")}-20${String(yy + 1).padStart(2, "0")}`;
  if (prefix === "WI" || prefix === "SP") return `20${String(yy - 1).padStart(2, "0")}-20${String(yy).padStart(2, "0")}`;
  return null;
}
const DAY_LABELS = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

// programs.day_of_week is stored Title-Case ("Wednesday") — the public catalog
// echoes the column directly and the VIP bundle matches fall<->winter/spring on
// `=`, so case matters. Normalize on read (older rows and the pre-fix wizard
// wrote lowercase, which made the day picker below render blank because no
// option matched) and always write Title-Case back.
function titleDay(d) {
  if (typeof d !== "string" || !d) return "";
  return d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
}

export default function ProgramsCalendar() {
  const { user, org, orgMember } = useOutletContext();
  // A registration operator whose Stripe isn't connected can't be paid, so the
  // share and embed controls are withheld until it is. Deliberately `=== false`
  // rather than `!`: while the org is still loading, stripe_charges_enabled is
  // undefined, and the safe direction is to leave the buttons alone rather than
  // yank them from someone who IS connected.
  //
  // `uses_enrops_registration !== false` matches the class-schedule gate below:
  // an org that takes registration OUTSIDE enrops will never connect Stripe
  // here, so without this it gets a "Connect Stripe" prompt it can never clear.
  const cannotBePaidYet =
    org?.instructor_pay_model === "enrops_platform" &&
    org?.uses_enrops_registration !== false &&
    org?.stripe_charges_enabled === false;
  const perm = getPermissions(orgMember?.role);
  // Term starts empty — we don't guess a hardcoded term. fetchOrgTerms picks
  // the org's default (in-progress today, else next starting, else most recent
  // past) once orgId is known.
  const [term, setTerm] = useState(null);
  const [termOptions, setTermOptions] = useState([]); // [{ value, label }]
  const [termsLoaded, setTermsLoaded] = useState(false); // org_terms fetch resolved
  const [viewMode, setViewMode] = useState("calendar");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [programs, setPrograms] = useState([]);
  const [enrollmentByProgram, setEnrollmentByProgram] = useState({});
  const [curricula, setCurricula] = useState([]);
  const [editingProgram, setEditingProgram] = useState(null);
  const [editingFacility, setEditingFacility] = useState(null); // program object or null

  async function saveFacility({ programId, requested_at, approved_at, notes }) {
    const payload = {
      facility_requested_at: requested_at || null,
      facility_approved_at: approved_at || null,
      facility_notes: (notes ?? "").trim() || null,
    };
    const { error: updErr } = await supabase
      .from("programs")
      .update(payload)
      .eq("id", programId);
    if (updErr) throw updErr;
    setPrograms((prev) => prev.map((p) => (p.id === programId ? { ...p, ...payload } : p)));
  }

  // Flip a program from draft → open. The only place this was possible until
  // now was a direct SQL update — operators had to ask for help. Self-serve.
  async function publishProgram(programId) {
    // Stripe gate, second line of defence. The buttons that call this are
    // already replaced by a Connect link when the org can't be paid (see
    // ProgramRow and ExpandedProgramPanel), so reaching this branch means the
    // click came from somewhere those checks don't cover — a stale render, or
    // devtools. The database trigger is the third and last line; this one exists
    // so the operator gets a sentence instead of a Postgres error.
    const target = programs.find((p) => p.id === programId);
    if (publishBlockedByStripe(org, target)) {
      alert(`${PUBLISH_GATE_WHY} Connect Stripe on the Payments screen, then publish. ${PUBLISH_GATE_STAYS_DRAFT_HINT}`);
      return;
    }
    if (!confirm("Publish this program? It'll show in marketing campaigns and the public catalog.")) return;
    const { error: pubErr } = await supabase
      .from("programs")
      .update({ status: "open" })
      .eq("id", programId);
    if (pubErr) {
      alert(`Couldn't publish: ${publishErrorMessage(pubErr)}`);
      return;
    }
    // Advertising conversion. This is the path a wizard DRAFT takes to become
    // customer-facing, and it is the one a browser hook is most likely to miss:
    // the program was created in one session and published in another. Path 3
    // of 3 - see pixelWorkflowCreated.
    //
    // Unpublishing and republishing fires again. That is correct under "every
    // save", which is the agreed definition, not first-only.
    pixelWorkflowCreated();
    setPrograms((prev) => prev.map((p) => (p.id === programId ? { ...p, status: "open" } : p)));
  }

  // Flip open → draft so the operator can pause a program without deleting it
  // (a typo, a rethink, a cancellation in negotiation). Hides it from the
  // public catalog and marketing audience filters again.
  async function unpublishProgram(programId) {
    // The gate grandfathers a class that was ALREADY live when Stripe went away
    // — it stays live and stays editable. Unpublishing surrenders that: the row
    // stops being grandfathered the moment it leaves 'open', and publishing it
    // again is a new transition the trigger will refuse. So for these programs
    // this button is a one-way door, and it has to say so BEFORE the click, not
    // afterwards when the Publish control has turned into "Connect Stripe".
    const target = programs.find((p) => p.id === programId);
    const oneWay = publishBlockedByStripe(org, target);
    const question = oneWay
      ? "Unpublish this program? It'll be hidden from the public catalog and stop appearing in marketing campaigns. Existing registrations are unaffected.\n\nHeads up: because Stripe isn't connected, you won't be able to publish it again until it is."
      : "Unpublish this program? It'll be hidden from the public catalog and stop appearing in marketing campaigns. Existing registrations are unaffected.";
    if (!confirm(question)) return;
    const { error: unpubErr } = await supabase
      .from("programs")
      .update({ status: "draft" })
      .eq("id", programId);
    if (unpubErr) {
      alert(`Couldn't unpublish: ${unpubErr.message}`);
      return;
    }
    setPrograms((prev) => prev.map((p) => (p.id === programId ? { ...p, status: "draft" } : p)));
  }

  // Delete a program. Hard-blocked when there are active (non-cancelled)
  // registrations — those families would lose the link to their enrollment.
  // Operator must either cancel the registrations first or just unpublish.
  async function deleteProgram(programId) {
    // Real-time registration check, not a stale enrollment count from page load.
    const { data: regRows, error: regErr } = await supabase
      .from("registrations")
      .select("id", { count: "exact" })
      .eq("program_id", programId)
      .is("cancelled_at", null);
    if (regErr) {
      alert(`Couldn't check registrations: ${regErr.message}`);
      return;
    }
    if ((regRows?.length ?? 0) > 0) {
      alert(`This program has ${regRows.length} active registration${regRows.length === 1 ? "" : "s"}. Cancel them first, or unpublish the program instead of deleting.`);
      return;
    }
    if (!confirm("Delete this program permanently? This can't be undone.")) return;
    const { error: delErr } = await supabase
      .from("programs")
      .delete()
      .eq("id", programId);
    if (delErr) {
      alert(`Couldn't delete: ${delErr.message}`);
      return;
    }
    setPrograms((prev) => prev.filter((p) => p.id !== programId));
  }

  // Generic field update used by the inline expand-edit form. Mirrors the
  // facility-save pattern. Updates local state on success so the row reflects
  // the change without a full reload.
  async function updateProgramFields(programId, patch) {
    const { error: updErr } = await supabase
      .from("programs")
      .update(patch)
      .eq("id", programId);
    if (updErr) throw updErr;
    setPrograms((prev) => prev.map((p) => (p.id === programId ? { ...p, ...patch } : p)));
    // The derived session dates + "N sessions" count shown on the row (the pill, the
    // expanded dates list, Copy list) come from a bulk per-term RPC loaded once, so any
    // save that changes the schedule leaves them stale until a reload -- a "✓ Saved"
    // over a stale number. Refetch THIS one program's schedule and merge it so the row
    // reflects the save immediately (honest state). Only when a schedule-affecting field
    // actually changed, to avoid a needless round-trip on price/room/capacity edits.
    const SCHEDULE_KEYS = ["first_session_date", "session_count", "end_date", "schedule_mode", "program_location_id", "day_of_week"];
    if (SCHEDULE_KEYS.some((k) => k in patch)) {
      // A schedule save re-materializes session_count from the CURRENT calendars,
      // so this program is drift-free by construction now — clear any stale flag
      // (chunk 4) so the "Schedule out of date" badge disappears immediately.
      setDriftByProgram((prev) => {
        if (!(programId in prev)) return prev;
        const next = { ...prev };
        delete next[programId];
        return next;
      });
      // Same re-derive + merge the in-context skip uses — one helper, so a
      // future change to how dates refresh can't drift between the two paths.
      await refreshProgramSchedule(programId);
    }
  }

  // Re-derive ONE program's schedule and merge it into state, so a change made
  // outside the field-save path (an in-context "mark no-school day") updates the
  // dates the row + expanded panel show, without a full reload. Same read the
  // field-save refetch uses; single source of truth is the SQL derivation.
  async function refreshProgramSchedule(programId) {
    try {
      const { data: sched, error: schErr } = await supabase.rpc(
        "derive_program_session_schedule",
        { p_program_id: programId },
      );
      if (schErr) throw schErr;
      const arr = (sched ?? []).map((r) => ({ date: r.entry_date, kind: r.kind, reason: r.reason }));
      setSessionDatesByProgram((prev) => ({ ...prev, [programId]: arr }));
    } catch (e) {
      console.warn("Couldn't refresh derived dates after skip:", e?.message ?? e);
    }
  }

  // Copy a program into another term — same location/day/time/curriculum/price,
  // just a different term/class. Server-side RPC so it copies every column on
  // the row, not just the subset this view happens to select. New row always
  // lands as status='draft' with no first-session-date, so it never appears
  // live before the operator reviews it and picks real dates.
  async function duplicateProgram(programId, targetTerm) {
    const { data: newId, error: dupErr } = await supabase.rpc("duplicate_program", {
      p_program_id: programId,
      p_target_term: targetTerm,
    });
    if (dupErr) throw dupErr;
    // The copy can land in a term the picker has never listed (Jeff copied to
    // Winter but the term picker still showed only Fall, so the draft was
    // unreachable). Refresh the term list so the new term is selectable. The
    // duplicate_program RPC has already committed the row, so org_terms sees it;
    // still, guarantee the target is present in case the read is momentarily
    // behind, so the picker can never omit a term we just wrote into.
    // Add the target to the picker. Prefer a full refresh from org_terms, but
    // NEVER clobber the existing list when the refetch comes back empty:
    // fetchOrgTerms resolves to { terms: [] } on an RLS/transient error (it
    // does not throw), and rebuilding from [] would wipe FA26/etc. and leave
    // only the new term. So replace only when the refetch actually returned
    // terms; otherwise just merge the target into whatever we already have.
    const mergeTarget = (list) =>
      (list ?? []).some((o) => o.value === targetTerm)
        ? (list ?? [])
        : [...(list ?? []), { value: targetTerm, label: formatTermLabel(targetTerm) }];
    let refreshed = [];
    try {
      const { terms } = await fetchOrgTerms(org.id);
      refreshed = Array.isArray(terms) ? terms : [];
    } catch {
      refreshed = [];
    }
    if (refreshed.length > 0) {
      const opts = refreshed.map((t) => ({ value: t.term, label: formatTermLabel(t.term) }));
      setTermOptions(mergeTarget(opts));
    } else {
      setTermOptions((prev) => mergeTarget(prev));
    }
    return newId;
  }

  // Which term parents can currently see/register for (org-wide, not per-view).
  // Kept separate from `term` (the term this page is currently browsing) —
  // an operator can browse Winter's programs while Fall is still the open one.
  const [activeTerm, setActiveTerm] = useState(org?.active_registration_term ?? null);
  const [activeTermOpenCount, setActiveTermOpenCount] = useState(null); // null = not loaded yet
  const [switchingTerm, setSwitchingTerm] = useState(false);
  const [switchResult, setSwitchResult] = useState(null); // { ok: bool, message }

  useEffect(() => {
    setActiveTerm(org?.active_registration_term ?? null);
  }, [org?.active_registration_term]);

  useEffect(() => {
    if (!org?.id || !activeTerm) { setActiveTermOpenCount(null); return; }
    let alive = true;
    (async () => {
      const { count } = await supabase
        .from("programs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .eq("term", activeTerm)
        .eq("status", "open");
      if (alive) setActiveTermOpenCount(count ?? 0);
    })();
    return () => { alive = false; };
  }, [org?.id, activeTerm]);

  // Open the currently-browsed term for registration — flips the org-wide
  // active_registration_term. This is the one switch that actually controls
  // what parents can see (Publish only controls a single program's status;
  // it doesn't put it in front of anyone until its term is the active one).
  // Blocked when this term has no published programs yet — switching to an
  // empty term would show parents a blank catalog.
  async function openTermForRegistration() {
    if (!term || !org?.id || switchingTerm) return;
    const targetTerm = term; // snapshot — the dropdown could change under us during the awaits below
    setSwitchingTerm(true);
    setSwitchResult(null);
    try {
      // Count fresh from the DB rather than trusting local `programs` state:
      // that state can still hold the PREVIOUS term's rows while a term
      // switch's own fetch is still in flight, which would let a fast
      // double-click bypass the zero-count guard below. Also re-read the
      // org's current active term fresh (not the possibly-stale `activeTerm`
      // state) so the confirm text reflects reality if another admin session
      // just changed it.
      const [{ count: targetOpenCount }, { data: freshOrg }] = await Promise.all([
        supabase.from("programs").select("id", { count: "exact", head: true })
          .eq("organization_id", org.id).eq("term", targetTerm).eq("status", "open"),
        supabase.from("organizations").select("active_registration_term").eq("id", org.id).single(),
      ]);
      const currentActiveTerm = freshOrg?.active_registration_term ?? null;
      if (!targetOpenCount) {
        setSwitchResult({ ok: false, message: `Publish at least one ${formatTermLabel(targetTerm)} program first — there's nothing open here yet.` });
        return;
      }
      let fromOpenCount = 0;
      if (currentActiveTerm && currentActiveTerm !== targetTerm) {
        const { count } = await supabase.from("programs").select("id", { count: "exact", head: true })
          .eq("organization_id", org.id).eq("term", currentActiveTerm).eq("status", "open");
        fromOpenCount = count ?? 0;
      }
      const fromLabel = currentActiveTerm ? formatTermLabel(currentActiveTerm) : "no term";
      const confirmMsg = currentActiveTerm && currentActiveTerm !== targetTerm
        ? `Open ${formatTermLabel(targetTerm)} for registration?\n\nParents will stop seeing ${fromLabel}'s ${fromOpenCount} open program(s) and start seeing ${formatTermLabel(targetTerm)}'s ${targetOpenCount} open program(s) instead. Families already enrolled in ${fromLabel} are not affected.`
        : `Open ${formatTermLabel(targetTerm)} for registration? Parents will see its ${targetOpenCount} open program(s).`;
      if (!window.confirm(confirmMsg)) return;
      const { error: switchErr } = await supabase
        .from("organizations")
        .update({ active_registration_term: targetTerm })
        .eq("id", org.id);
      if (switchErr) throw switchErr;
      setSwitchResult({ ok: true, message: `${formatTermLabel(targetTerm)} is now open for registration. Refreshing…` });
      // Full reload, not just local state: `org` (and everything reading
      // org.active_registration_term from it — the per-program Share-link
      // gate, the catalog Share button) comes from AdminLayout's outlet
      // context, not this component. Setting local state alone would make
      // this banner say "open" while those still gate on the stale term.
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setSwitchResult({ ok: false, message: err.message ?? String(err) });
    } finally {
      setSwitchingTerm(false);
    }
  }

  // Load this org's terms once orgId is known: populate the dropdown and pick
  // the default (current/next) term. Re-resolves if the org ever changes.
  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    setTermsLoaded(false); // re-gate the programs load while the org's terms resolve
    (async () => {
      const { terms, defaultTerm } = await fetchOrgTerms(org.id);
      if (!alive) return;
      setTermOptions(
        (terms ?? []).map((t) => ({ value: t.term, label: formatTermLabel(t.term) })),
      );
      setTerm(defaultTerm); // null when the org has no terms yet → empty state
      setTermsLoaded(true);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  // Locations + curricula for the inline edit form's dropdowns. Loaded once
  // per org so every expand-row has the picker ready.
  const [locationsForPicker, setLocationsForPicker] = useState([]);
  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("program_locations")
        // address comes back so the edit panel can SHOW where the class runs.
        // Without it the picker displayed a bare name, so an operator could not
        // confirm which venue a program was actually attached to.
        .select("id, name, district, address")
        .eq("organization_id", org.id)
        .order("name");
      // null means "could not read", [] means "genuinely none". The picker puts
      // that distinction in front of the operator ("No locations yet"), so a
      // dropped error must not masquerade as an empty org -- this previously
      // destructured only `data`, and supabase-js RESOLVES query errors, so an
      // RLS denial read as "this org has no venues". Every consumer of this
      // prop already guards with `?? []`, so null is safe to pass down.
      if (alive) setLocationsForPicker(error ? null : (data ?? []));
    })();
    return () => { alive = false; };
  }, [org?.id]);
  const [sessionDatesByProgram, setSessionDatesByProgram] = useState({});
  // Range programs whose materialized session_count went STALE after a school
  // calendar changed (chunk 4). Keyed by program_id -> { stored, derived }; only
  // drifted programs are present. Re-derived from the CURRENT calendars server-side,
  // so a new/removed no-school day in the window surfaces as a flag on the row.
  const [driftByProgram, setDriftByProgram] = useState({});
  const [expandedDates, setExpandedDates] = useState(() => new Set());
  // Per-location calendar coverage for this term, keyed by program_location_id:
  //   Map<location_id, { hasDistrict, hasCalendar }> while a school year applies,
  //   or null when the term doesn't use district calendars / hasn't loaded.
  // Used to flag schools whose derived dates won't skip holidays yet.
  const [calendarCoverage, setCalendarCoverage] = useState(null);

  function toggleDatesExpanded(programId) {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(programId)) next.delete(programId);
      else next.add(programId);
      return next;
    });
  }

  // Expand-all / collapse-all for every program at a single school. Used by
  // the By-school view header so the operator can pop open every Facilitron
  // booking at one site without clicking each row.
  function toggleSchoolExpanded(programIds) {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      const allExpanded = programIds.every((id) => next.has(id));
      if (allExpanded) {
        for (const id of programIds) next.delete(id);
      } else {
        for (const id of programIds) next.add(id);
      }
      return next;
    });
  }

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
    // Wait for org_terms to resolve before deciding. Once loaded: if no term is
    // selectable (org has no programs yet), show the empty state instead of
    // querying with a null term or hanging on "Loading…".
    if (!org?.id || !termsLoaded) return;
    if (!term) { setPrograms([]); setLoading(false); return; }
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
            max_capacity, status, term, instructor_name, price_cents,
            short_description,
            grade_min, grade_max, age_min, age_max, age_format,
            runs_own_registration, external_registration_url, list_in_public_catalog,
            first_session_date, session_count, schedule_mode, end_date, organization_id,
            facility_requested_at, facility_approved_at, facility_notes,
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

        // Batch-fetch the full derived schedule for every program in this term.
        // Wraps derive_program_session_schedule() — the same weekly walk as
        // derive_program_session_dates(), but it also emits the SKIPPED
        // no-school days (with the district's reason) so we can show them
        // inline. Each value is an ordered array of
        // { date, kind: 'session' | 'no_school', reason }. RLS-gated via
        // SECURITY INVOKER. Session-only counts filter kind === 'session'.
        let datesByProgram = {};
        try {
          const { data: datesRows, error: datesErr } = await supabase.rpc(
            "programs_with_session_schedule",
            { p_organization_id: org.id, p_term: term },
          );
          if (datesErr) throw datesErr;
          for (const r of datesRows ?? []) {
            datesByProgram[r.program_id] = Array.isArray(r.schedule) ? r.schedule : [];
          }
        } catch (e) {
          // Don't break the page if dates can't load — the rest of the program
          // info is still useful. Just log so we notice.
          console.warn("Couldn't load derived session dates:", e?.message ?? e);
        }

        // Range-schedule drift (chunk 4): for every RANGE program in this term,
        // compare the materialized session_count to the count re-derived from the
        // CURRENT calendars. A difference means a school added/removed a no-school
        // day inside the window after the program was saved, so its stored dates
        // are stale. Flag it on the row; never silently shift the saved schedule.
        // Keep only the drifted rows so the map is empty in the common (no-drift) case.
        let driftMap = {};
        try {
          const { data: driftRows, error: driftErr } = await supabase.rpc(
            "range_programs_schedule_drift",
            { p_organization_id: org.id, p_term: term },
          );
          if (driftErr) throw driftErr;
          for (const r of driftRows ?? []) {
            if (
              r.stored_count != null &&
              r.derived_count != null &&
              r.derived_count !== r.stored_count
            ) {
              driftMap[r.program_id] = { stored: r.stored_count, derived: r.derived_count };
            }
          }
        } catch (e) {
          console.warn("Couldn't check range schedule drift:", e?.message ?? e);
        }

        // Per-location calendar coverage for this term. Structure-aware via
        // program_locations_calendar_coverage(), which matches a school's
        // calendar by the structured district_id link OR the legacy free-text
        // district — so a formalized school isn't falsely flagged as missing.
        // null = term doesn't use district calendars at all (e.g. summer camps),
        //        so never show the missing-calendar warning.
        const schoolYearForTerm = termToSchoolYearJs(term);
        let coverageByLocation = null;
        if (schoolYearForTerm) {
          coverageByLocation = new Map();
          try {
            const { data: covRows } = await supabase.rpc(
              "program_locations_calendar_coverage",
              { p_org_id: org.id, p_term: term },
            );
            for (const r of covRows ?? []) {
              coverageByLocation.set(r.location_id, {
                hasDistrict: r.has_district,
                hasCalendar: r.has_calendar,
              });
            }
          } catch (e) {
            console.warn("Couldn't load calendar coverage:", e?.message ?? e);
          }
        }

        if (mounted) {
          setPrograms(progRows ?? []);
          setEnrollmentByProgram(enrollment);
          setSessionDatesByProgram(datesByProgram);
          setDriftByProgram(driftMap);
          setCalendarCoverage(coverageByLocation);
          setExpandedDates(new Set()); // collapse all when term changes
        }
      } catch (e) {
        if (mounted) setError(e.message ?? String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [org?.id, term, termsLoaded]);

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
      {/* MOBILE PROGRAM ROWS. Each row is a 6-column grid with 450px of FIXED
          columns, so on a phone it overflowed horizontally and the cells at the
          end — enrollment and the roster chevron — were pushed off-screen. This
          page is now the lean operator's HOME, and enrollment is the number they
          come here for, so it can't be the thing that gets clipped.
          Under 900px the row reflows to "details | number" and wraps, keeping
          every cell on screen. !important because the row styles are inline. */}
      <style>{`
        @media (max-width: 900px) {
          [data-program-row] {
            grid-template-columns: 1fr auto !important;
            gap: 4px 12px !important;
            padding: 12px 14px !important;
            align-items: start !important;
          }
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Scheduled programs</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            What's running this term, by day or by school. Live enrollment numbers.
          </div>
        </div>
        {/* flexWrap is load-bearing on a phone: Share + Add-to-website + New
            program + the term picker is ~600px of non-shrinking controls, and
            without wrapping this row sets the page's minimum width, pushing
            EVERYTHING (including the enrollment numbers) off the right edge.
            The outer container already wraps; this inner group has to as well
            or the outer wrap can never take effect. */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {/* Sharing is withheld until the operator can actually be paid.
              Checkout is already blocked server-side when Stripe isn't
              connected, so nothing breaks if a link does get out — but handing
              someone a link that cannot take money, and letting them put it in
              a flyer, wastes the one thing they can't get back: the first
              families who click it. Only for registration operators; J2S and
              anyone already connected are untouched. */}
          {org?.slug && !cannotBePaidYet && (
            <ShareLink
              url={buildCatalogUrl(org.slug)}
              align="right"
              buttonLabel="Share registration page"
              panelTitle="Your registration page"
              description="One link to all your open programs — families pick a class and sign up. Put it in your bio, an email, or a flyer."
              qrFileBase="registration-page"
            />
          )}
          {cannotBePaidYet && (
            <Link
              to="/admin/finances"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "8px 14px", borderRadius: 8, fontSize: 13.5, fontWeight: 600,
                textDecoration: "none", background: "#FDF6E3",
                border: "1px solid #F0D48A", color: "#8a5a00",
              }}
            >
              Connect Stripe to share your link →
            </Link>
          )}
          {/* On-domain embed — the biggest differentiator vs Jumbula/Sawyer/
              CourseStorm, whose widgets redirect off-site or slow the page.
              Registration ops only; J2S runs its own site and doesn't need it.
              Held back for the same reason as the share link. */}
          {org?.slug && org?.instructor_pay_model === "enrops_platform" && !cannotBePaidYet && (
            <EmbedSnippet slug={org.slug} orgName={org.name} />
          )}
          <Link
            // Lean registration operators (enrops_platform) get the curriculum-free
            // QuickProgramBuilder; J2S / legacy tenants keep the full wizard.
            to={org?.instructor_pay_model === "enrops_platform" ? "/admin/programs/quick-new" : "/admin/programs/new"}
            style={{
              padding: "8px 14px",
              background: BRIGHT,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            + New program
          </Link>
          <select value={term ?? ""} onChange={(e) => setTerm(e.target.value)} style={selectStyle}>
            {!term && <option value="">{termsLoaded ? "No terms yet" : "Loading terms…"}</option>}
            {termOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          {/* "By school" groups by partner school — meaningless for a lean
              single-venue op, so show only Calendar for them. J2S keeps both. */}
          {org?.instructor_pay_model !== "enrops_platform" && (
            <div style={toggleGroup}>
              <button onClick={() => setViewMode("calendar")} style={viewMode === "calendar" ? toggleBtnActive : toggleBtn}>Calendar</button>
              <button onClick={() => setViewMode("by_school")} style={viewMode === "by_school" ? toggleBtnActive : toggleBtn}>By school</button>
            </div>
          )}
        </div>
      </div>

      {term && termsLoaded && (
        activeTerm === term ? (
          // Honest state: a term can be "open for registration" while the org has
          // no Stripe account connected — the page takes sign-ups but the money
          // has nowhere of theirs to land. Saying a plain green "open" there tells
          // an operator they're done when they aren't. Lean ops only; J2S is
          // connected and keeps the original banner exactly.
          org?.instructor_pay_model === "enrops_platform" && org?.stripe_charges_enabled === false ? (
            /* Enrops palette, not the generic amber used elsewhere on this page:
               ENROPS_GOLD (#F8A638) is the brand's warm accent, on a soft tint of
               itself, with brand purple text and the standard indigo primary
               action. The old #a16207 read as rust and belongs to no palette. */
            <div style={{ ...registrationBanner, background: "#FFF6E9", borderColor: ENROPS_GOLD, color: PURPLE }}>
              <span>
                {formatTermLabel(term)} is open for registration, but you can't get paid yet — connect Stripe to start receiving payments.
              </span>
              <Link
                to="/admin/finances"
                style={{ background: BRIGHT, color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 13, fontWeight: 600, textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" }}
              >
                Connect Stripe →
              </Link>
            </div>
          ) : (
            <div style={{ ...registrationBanner, background: "#f0f8f0", borderColor: "#bfd9bf", color: OK_GREEN }}>
              ✓ {formatTermLabel(term)} is open for registration — this is what parents see.
            </div>
          )
        ) : (
          <div style={{ ...registrationBanner, background: "#fff8ec", borderColor: "#f0dfb8", color: AMBER }}>
            <span>
              {formatTermLabel(term)} is not open for registration.
              {activeTerm && ` Parents currently see ${formatTermLabel(activeTerm)}.`}
            </span>
            {perm.canManageSettings ? (
              <button
                type="button"
                onClick={openTermForRegistration}
                disabled={switchingTerm}
                style={{
                  background: "transparent", color: AMBER, border: `1px solid ${AMBER}`, padding: "5px 12px",
                  borderRadius: 6, fontSize: 12.5, fontWeight: 700, fontFamily: "inherit",
                  cursor: switchingTerm ? "wait" : "pointer", whiteSpace: "nowrap",
                }}
              >{switchingTerm ? "Opening…" : `Open ${formatTermLabel(term)} for registration →`}</button>
            ) : (
              <span style={{ fontSize: 12.5, fontStyle: "italic" }}>Ask an owner or admin to open it.</span>
            )}
          </div>
        )
      )}
      {switchResult && (
        <div style={{
          ...registrationBanner,
          background: switchResult.ok ? "#f0f8f0" : "#fde7e7",
          borderColor: switchResult.ok ? "#bfd9bf" : "#f0c4c4",
          color: switchResult.ok ? OK_GREEN : "#b53737",
        }}>
          {switchResult.ok ? "✓ " : ""}{switchResult.message}
        </div>
      )}

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

      {loading && <div style={{ color: MUTED, padding: 12 }}>Loading {term ? `${formatTermLabel(term)} ` : ""}programs…</div>}
      {error && <div style={errorBox}>Could not load programs: {error}</div>}
      {!loading && !error && programs.length === 0 && (
        <div style={emptyState}>
          No programs scheduled{term ? ` for ${formatTermLabel(term)}` : ""} yet.
          {/* Uploading a weekly class schedule is a later tier, and the empty
              state is the worst place to offer it: a brand-new operator with
              zero programs sees it before anything else and follows it into a
              surface they can't use.
              NOT gated on lean alone — some enrops_platform orgs (Shoreview
              Chess, Mrs. Richelle) run registration outside enrops, and the
              class schedule is their actual home. Hide it only for operators
              who take registrations HERE. */}
          {!(org?.instructor_pay_model === "enrops_platform" && org?.uses_enrops_registration !== false) && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              Running ongoing classes instead of term registration?{" "}
              <Link to="/admin/class-schedule" style={{ color: BRIGHT, fontWeight: 600 }}>Upload your class schedule →</Link>
            </div>
          )}
        </div>
      )}

      {!loading && !error && programs.length > 0 && (
        viewMode === "calendar"
          ? <CalendarView
              programs={programs}
              enrollment={enrollmentByProgram}
              sessionDatesByProgram={sessionDatesByProgram}
              driftByProgram={driftByProgram}
              calendarCoverage={calendarCoverage}
              expandedDates={expandedDates}
              onToggleDates={toggleDatesExpanded}
              onEdit={setEditingProgram}
              onEditFacility={setEditingFacility}
              onPublish={publishProgram}
              onUnpublish={unpublishProgram}
              onDelete={deleteProgram}
              onUpdate={updateProgramFields}
              onScheduleChanged={refreshProgramSchedule}
              onDuplicate={duplicateProgram}
              termOptions={termOptions}
              locations={locationsForPicker}
              orgSlug={org?.slug}
              orgActiveTerm={org?.active_registration_term}
            />
          : <BySchoolView
              programs={programs}
              enrollment={enrollmentByProgram}
              sessionDatesByProgram={sessionDatesByProgram}
              driftByProgram={driftByProgram}
              calendarCoverage={calendarCoverage}
              expandedDates={expandedDates}
              onToggleDates={toggleDatesExpanded}
              onToggleSchool={toggleSchoolExpanded}
              onEdit={setEditingProgram}
              onEditFacility={setEditingFacility}
              onPublish={publishProgram}
              onUnpublish={unpublishProgram}
              onDelete={deleteProgram}
              onUpdate={updateProgramFields}
              onScheduleChanged={refreshProgramSchedule}
              onDuplicate={duplicateProgram}
              termOptions={termOptions}
              locations={locationsForPicker}
              orgSlug={org?.slug}
              orgActiveTerm={org?.active_registration_term}
            />
      )}

      {editingFacility && (
        <FacilityRequestModal
          program={editingFacility}
          onCancel={() => setEditingFacility(null)}
          onSave={async (vals) => {
            await saveFacility({ programId: editingFacility.id, ...vals });
            setEditingFacility(null);
          }}
        />
      )}

      {editingProgram && (
        <EditProgramCurriculumModal
          // Remount per program: the modal seeds match-mode defaults and the
          // picked curriculum from props in useState initializers, which don't
          // re-run on a prop change. Without this, reusing the instance for a
          // different program would silently carry the previous one's state.
          key={editingProgram.id}
          program={editingProgram}
          org={org}
          user={user}
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

function CalendarView({ programs, enrollment, sessionDatesByProgram, driftByProgram, calendarCoverage, expandedDates, onToggleDates, onEdit, onEditFacility, onPublish, onUnpublish, onDelete, onUpdate, onScheduleChanged, onDuplicate, termOptions, locations, orgSlug, orgActiveTerm }) {
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
    <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12 }}>
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
          {byDay[day].map((p) => (
            <ProgramRow
              key={p.id}
              program={p}
              e={enrollment[p.id]}
              sessionDates={sessionDatesByProgram?.[p.id]}
              drift={driftByProgram?.[p.id]}
              districtHasCalendar={districtHasCal(p, calendarCoverage)}
              isDatesExpanded={expandedDates?.has(p.id)}
              onToggleDates={onToggleDates}
              onEdit={onEdit}
              onEditFacility={onEditFacility}
              onPublish={onPublish}
              onUnpublish={onUnpublish}
              onDelete={onDelete}
              onUpdate={onUpdate}
              onScheduleChanged={onScheduleChanged}
              onDuplicate={onDuplicate}
              termOptions={termOptions}
              locations={locations}
              orgSlug={orgSlug}
              orgActiveTerm={orgActiveTerm}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function BySchoolView({ programs, enrollment, sessionDatesByProgram, driftByProgram, calendarCoverage, expandedDates, onToggleDates, onToggleSchool, onEdit, onEditFacility, onPublish, onUnpublish, onDelete, onUpdate, onScheduleChanged, onDuplicate, termOptions, locations, orgSlug, orgActiveTerm }) {
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
    <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12 }}>
      {bySchool.map(([school, list], idx) => {
        const summary = summarizeSchool(list, sessionDatesByProgram);
        const programIds = list.map((p) => p.id);
        const allExpanded = programIds.length > 0 && programIds.every((id) => expandedDates?.has(id));
        const hasAnyDates = summary.totalSessions > 0;
        return (
          <div key={school}>
            <div style={{
              padding: "10px 16px 10px",
              background: "#fafaf5",
              borderTop: idx === 0 ? "none" : `1px solid ${RULE}`,
              borderBottom: `1px solid ${RULE}`,
              fontSize: 13, fontWeight: 700, color: PURPLE,
              display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap",
              justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
                <div>
                  {school}
                  {list[0]?.program_locations?.district && (
                    <span style={{ color: MUTED, fontWeight: 400, fontSize: 11, marginLeft: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {list[0].program_locations.district}
                    </span>
                  )}
                </div>
                <div style={{ color: MUTED, fontWeight: 400, fontSize: 12 }}>
                  <strong style={{ color: INK }}>{list.length}</strong> program{list.length === 1 ? "" : "s"}
                  {summary.totalSessions > 0 && (
                    <>
                      {" · "}
                      <strong style={{ color: INK }}>{summary.totalSessions}</strong> session{summary.totalSessions === 1 ? "" : "s"} total
                    </>
                  )}
                  {summary.firstDate && summary.lastDate && (
                    <>
                      {" · "}
                      <strong style={{ color: INK }}>{formatFirstSessionDate(summary.firstDate)}</strong>
                      {" – "}
                      <strong style={{ color: INK }}>{formatFirstSessionDate(summary.lastDate)}</strong>
                    </>
                  )}
                  {list.length > 0 && (
                    <>
                      {" · "}
                      <strong style={{ color: summary.approvedCount === list.length ? OK_GREEN : (summary.approvedCount > 0 ? AMBER : MUTED) }}>
                        {summary.approvedCount}/{list.length}
                      </strong>
                      {" facilities approved"}
                    </>
                  )}
                </div>
              </div>
              {hasAnyDates && (
                <button
                  type="button"
                  onClick={() => onToggleSchool?.(programIds)}
                  style={{
                    background: "transparent",
                    border: `1px solid ${BRIGHT}`,
                    color: BRIGHT,
                    padding: "4px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                  title={allExpanded ? "Collapse every program at this site" : "Open every program's session dates at this site"}
                >
                  {allExpanded ? "Hide all dates" : "Show all dates"}
                </button>
              )}
            </div>
            {list.map((p) => (
              <ProgramRow
                key={p.id}
                program={p}
                e={enrollment[p.id]}
                sessionDates={sessionDatesByProgram?.[p.id]}
                drift={driftByProgram?.[p.id]}
                districtHasCalendar={districtHasCal(p, calendarCoverage)}
                isDatesExpanded={expandedDates?.has(p.id)}
                onToggleDates={onToggleDates}
                onEdit={onEdit}
                onEditFacility={onEditFacility}
                onPublish={onPublish}
                onUnpublish={onUnpublish}
                onDelete={onDelete}
                onUpdate={onUpdate}
                onScheduleChanged={onScheduleChanged}
                onDuplicate={onDuplicate}
                termOptions={termOptions}
                locations={locations}
                orgSlug={orgSlug}
                orgActiveTerm={orgActiveTerm}
                showDay
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// summarizeSchool — for the By-school view header. Counts total session
// instances across every program at this site, finds the overall date
// range, and tallies facility-booking progress so the admin can see
// "3 of 4 approved at Bonny Slope" at a glance.
function summarizeSchool(programs, sessionDatesByProgram) {
  let totalSessions = 0;
  let firstDate = null;
  let lastDate = null;
  let requestedCount = 0;
  let approvedCount = 0;
  for (const p of programs) {
    // Values are full schedules ({date,kind,reason}); count real sessions only.
    const sched = sessionDatesByProgram?.[p.id] ?? [];
    const sessionDates = sched.filter((x) => x?.kind === "session");
    totalSessions += sessionDates.length;
    for (const x of sessionDates) {
      const d = x.date;
      if (!firstDate || d < firstDate) firstDate = d;
      if (!lastDate || d > lastDate) lastDate = d;
    }
    if (p.facility_requested_at) requestedCount++;
    if (p.facility_approved_at) approvedCount++;
  }
  return { totalSessions, firstDate, lastDate, requestedCount, approvedCount };
}

// ---- Card ----

// districtHasCal returns:
//   true  → the program's school has a calendar resolved for this term
//   false → the school has a district (structured link or free-text) but no
//            calendar saved yet (warn the admin — holidays won't be subtracted)
//   null  → no warning to show. Either the term doesn't use district calendars
//          (e.g. SU camps) / coverage hasn't loaded, or the school has no
//          district at all.
function districtHasCal(program, calendarCoverage) {
  if (calendarCoverage == null) return null; // term doesn't use district calendars / not loaded
  const entry = calendarCoverage.get(program?.program_location_id);
  if (!entry || !entry.hasDistrict) return null;
  return entry.hasCalendar;
}

function ProgramRow({ program: p, e, sessionDates, drift, districtHasCalendar, isDatesExpanded, onToggleDates, onEdit, onEditFacility, onPublish, onUnpublish, onDelete, onUpdate, onScheduleChanged, onDuplicate, termOptions, locations, orgSlug, orgActiveTerm, showDay = false }) {
  // Lean registration ops have no curriculum library, no partner-school
  // facilities, and no instructors — hide those J2S-shaped affordances. J2S
  // (legacy_own_platform) keeps them all.
  const { org: rowOrg } = useOutletContext() ?? {};
  const isLean = rowOrg?.instructor_pay_model === "enrops_platform";
  const enr = e ?? { paid: 0, unpaid: 0, pending: 0 };
  const enrolled = enr.paid + enr.unpaid;
  const capacity = p.max_capacity ?? 0;
  const pct = capacity > 0 ? Math.min(1, enrolled / capacity) : 0;
  const isFull = capacity > 0 && enrolled >= capacity;
  const fillColor = isFull ? BRIGHT : pct >= 0.7 ? VIOLET : "#a8c47f";
  const isDraft = p.status === "draft";
  // A paid class can't go live before the money has somewhere to land. The
  // control is REPLACED rather than disabled: a greyed-out button still reads as
  // a feature you have, and this one has a next step worth offering.
  const publishBlocked = publishBlockedByStripe(rowOrg, p);

  const breakdownParts = [];
  if (enr.paid > 0) breakdownParts.push(`${enr.paid} paid`);
  if (enr.unpaid > 0) breakdownParts.push(`${enr.unpaid} on installments`);
  if (enr.pending > 0) breakdownParts.push(`+${enr.pending} pending`);
  const breakdown = breakdownParts.join(" · ");

  // sessionDates is the full schedule ({date,kind,reason}); the row count and
  // "No dates" flag reflect real sessions only (no-school rows don't count).
  const scheduleArr = Array.isArray(sessionDates) ? sessionDates : [];
  const sessionRowCount = scheduleArr.filter((x) => x?.kind === "session").length;
  const hasDates = sessionRowCount > 0;
  const dateCountLabel = hasDates
    ? `${sessionRowCount} session${sessionRowCount === 1 ? "" : "s"}`
    : "No dates";

  return (
    <>
    <div data-program-row style={{
      // 450px of FIXED columns before the flexible one, so on a phone the row
      // overflowed and the enrollment + action cells were pushed off-screen.
      // The mobile rule (in ProgramsCalendar's <style>) reflows this to two
      // columns so enrollment stays visible — it's the number an operator opens
      // this page for.
      display: "grid",
      gridTemplateColumns: "100px 1fr 110px 90px 80px 70px",
      gap: 14,
      alignItems: "center",
      padding: "10px 16px",
      borderBottom: isDatesExpanded ? "none" : `1px solid ${RULE}`,
      fontSize: 13,
      opacity: isDraft ? 0.55 : 1,
      background: isDraft ? "#fafaf5" : "transparent",
    }}>
      {/* Start date + time. By-school view also shows day-of-week. */}
      <div style={{ color: INK, fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>
        {showDay && p.day_of_week && (
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}>
            {DAY_LABELS[p.day_of_week.toLowerCase()]?.slice(0, 3) ?? p.day_of_week}
          </div>
        )}
        <div style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}>
          {p.first_session_date ? formatFirstSessionDate(p.first_session_date) : <span style={{ color: AMBER, fontWeight: 600 }}>No start</span>}
        </div>
        {formatTime(p.start_time) || <span style={{ color: MUTED, fontWeight: 400 }}>—</span>}
      </div>

      {/* Curriculum + school + instructor */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: INK, lineHeight: 1.3, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{p.curriculum ?? "Untitled"}</span>
          {/* A program can carry a typed-in class NAME with no link to the
              Offerings library — that's the common case, not "Untitled".
              The name looks fine on the page while parent emails silently
              lose the skills/projects blocks, so the row has to say it. */}
          {!isLean && !p.curriculum_id && (
            <span
              title="This program names a class but isn't linked to your Offerings library, so parent emails can't include its skills or projects"
              style={{
                fontSize: 10,
                color: MUTED,
                background: "#f0eee5",
                border: `1px solid ${RULE}`,
                padding: "2px 8px",
                borderRadius: 999,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                flexShrink: 0,
              }}
            >
              Not linked
            </span>
          )}
          {isDraft && (
            <>
              <span style={{
                fontSize: 10,
                color: AMBER,
                background: `${AMBER}1F`,
                padding: "2px 8px",
                borderRadius: 999,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                flexShrink: 0,
              }}>
                Draft
              </span>
              {onPublish && (
                publishBlocked ? (
                  <Link
                    to={STRIPE_CONNECT_ROUTE}
                    title={`${PUBLISH_GATE_WHY} ${PUBLISH_GATE_STAYS_DRAFT_HINT}`}
                    style={{
                      fontSize: 10,
                      color: "#8a5a00",
                      background: "#FDF6E3",
                      border: "1px solid #F0D48A",
                      padding: "2px 10px",
                      borderRadius: 999,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      textDecoration: "none",
                      fontFamily: "inherit",
                      flexShrink: 0,
                    }}
                  >
                    {PUBLISH_GATE_CTA} →
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPublish(p.id)}
                    title="Publish this program — shows in campaigns + public catalog"
                    style={{
                      fontSize: 10,
                      color: "#fff",
                      background: OK_GREEN,
                      border: "none",
                      padding: "2px 10px",
                      borderRadius: 999,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      flexShrink: 0,
                    }}
                  >
                    Publish →
                  </button>
                )
              )}
            </>
          )}
          {/* Chunk 4: this range program's saved session count no longer matches
              what its date window yields under the CURRENT school calendar (a
              no-school day was added or removed after it was saved). Flag it here
              so the operator sees it without expanding; the fix lives in the panel. */}
          {drift && (
            <span
              title={`A school-calendar change moved this program's class days. Its saved schedule has ${drift.stored} session${drift.stored === 1 ? "" : "s"}, but the dates now yield ${drift.derived}. Expand to review and update.`}
              style={{
                fontSize: 10,
                color: AMBER,
                background: `${AMBER}1F`,
                border: `1px solid ${AMBER}66`,
                padding: "2px 8px",
                borderRadius: 999,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                flexShrink: 0,
              }}
            >
              Schedule out of date
            </span>
          )}
          <button
            type="button"
            onClick={() => onToggleDates?.(p.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 10px",
              background: isDatesExpanded ? BRIGHT : `${BRIGHT}14`,
              color: isDatesExpanded ? "#fff" : BRIGHT,
              border: `1px solid ${BRIGHT}`,
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              flexShrink: 0,
            }}
            title="Expand to edit dates, time, capacity, status, and more"
          >
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0, transform: isDatesExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
              <path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {isDatesExpanded ? "Hide" : "Expand"}
          </button>
          {!isLean && <FacilityPill program={p} onClick={() => onEditFacility?.(p)} />}
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

      {/* Count + breakdown — click to open this program's roster */}
      <div style={{ textAlign: "right" }}>
        <Link
          to={`/admin/programs/${p.id}/roster`}
          title="View the enrolled students (roster, allergies, contacts)"
          style={{ fontSize: 13, fontWeight: 600, color: PURPLE, textDecoration: "none" }}
        >
          {enrolled}<span style={{ color: MUTED, fontWeight: 400 }}>{capacity > 0 ? ` / ${capacity}` : ""}</span>
          <span style={{ fontSize: 10, marginLeft: 3 }}>›</span>
        </Link>
        {breakdown && (
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{breakdown}</div>
        )}
      </div>

      {/* Sessions count (plain text) */}
      <div style={{ textAlign: "right", fontSize: 12, color: hasDates ? INK : MUTED }}>
        {dateCountLabel}
      </div>

      {/* Edit affordance */}
      <div style={{ textAlign: "right" }}>
        {onEdit && !isLean && (
          <button
            type="button"
            onClick={() => onEdit(p)}
            style={editLinkStyle}
            title={p.curriculum_id
              ? "Change the class for this program"
              : "Match this program to a class from your Offerings library"}
          >
            {p.curriculum_id ? "Change class" : "Match class"}
          </button>
        )}
      </div>
    </div>
    {isDatesExpanded && (
      <ExpandedProgramPanel
        program={p}
        dates={scheduleArr}
        drift={drift}
        districtHasCalendar={districtHasCalendar}
        onUpdate={onUpdate}
        onScheduleChanged={onScheduleChanged}
        onPublish={onPublish}
        onUnpublish={onUnpublish}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        termOptions={termOptions}
        locations={locations}
        orgSlug={orgSlug}
        orgActiveTerm={orgActiveTerm}
      />
    )}
    </>
  );
}

// Inline expand-edit panel. Shows the existing session-dates view at the
// bottom, an editable form for day/time/dates/capacity/price/location at
// the top, and the unpublish + delete actions on a footer row. The panel
// only renders when the operator clicks "Expand" on a program row.
function ExpandedProgramPanel({ program, dates, drift, districtHasCalendar, onUpdate, onScheduleChanged, onPublish, onUnpublish, onDelete, onDuplicate, termOptions, locations, orgSlug, orgActiveTerm }) {
  // Lean ops don't have partner-run registration or instructors — hide those.
  const { org: panelOrg } = useOutletContext() ?? {};
  const isLean = panelOrg?.instructor_pay_model === "enrops_platform";
  // Reads the SAVED row, not the local draft below: Publish writes status and
  // nothing else, so an unsaved price change must not talk the gate out of the
  // way. Saving first is what moves it.
  const publishBlocked = publishBlockedByStripe(panelOrg, program);
  // Local draft so the operator can edit several fields and save in one go
  // (avoid round-tripping the DB on every keystroke).
  const [draft, setDraft] = useState({
    // Normalized so a legacy lowercase row still selects its real day instead
    // of showing an empty picker (which looked like "no day set").
    day_of_week: titleDay(program.day_of_week),
    // Stored as 12-hour text ("2:45 PM"); <input type="time"> needs 24-hour.
    start_time: to24h(program.start_time),
    end_time: to24h(program.end_time),
    first_session_date: program.first_session_date ?? "",
    session_count: program.session_count ?? "",
    // Range mode: 'count' (default, the J2S way) vs 'range' (Jeff's way -- count
    // derives from start+end). end_date is only used in range mode.
    schedule_mode: program.schedule_mode === "range" ? "range" : "count",
    end_date: program.end_date ?? "",
    max_capacity: program.max_capacity ?? "",
    // Families-facing blurb on the registration page. Editable here so a program
    // that already exists can get one - the lean builder only just started
    // collecting it, so every program created before now has none.
    short_description: program.short_description ?? "",
    // The class NAME. For a lean provider this is free text typed once in the
    // builder and, until now, unchangeable afterwards - full-nav orgs got "Change
    // class", which swaps the curriculum behind it, not the name. `curriculum` is
    // NOT NULL, so the save below refuses to blank it.
    curriculum: program.curriculum ?? "",
    // Who the class is for. Neither pair was editable here at all, so a range set
    // at creation was permanent and one left blank could never be filled in.
    // Every one of these must be SELECTED above before it is written, or a save
    // would read undefined and null out J2S's 90 grade ranges.
    grade_min: program.grade_min ?? "",
    grade_max: program.grade_max ?? "",
    age_min: program.age_min ?? "",
    age_max: program.age_max ?? "",
    price_cents: program.price_cents ?? "",
    program_location_id: program.program_location_id ?? "",
    room: program.room ?? "",
    runs_own_registration: program.runs_own_registration ?? false,
    external_registration_url: program.external_registration_url ?? "",
    list_in_public_catalog: program.list_in_public_catalog ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Which pair the panel is currently editing, and the one coercion that has to be
  // right: "" means NOT STATED, but grade K is 0, which is falsy. `Number("") || null`
  // gives null for both, so K and blank become the same thing.
  // Which pair is on screen. Held OUTSIDE `draft` on purpose: every other key in
  // draft is a real `programs` column, and a UI-only key sitting among them is how
  // a future `.update(draft)` or key-diff ends up trying to write a column that
  // does not exist. Seeded from the row through the shared rule.
  const [panelMode, setPanelMode] = useState(() => audienceMode(program));

  // RE-READ THE ROW WHEN IT CHANGES UNDERNEATH US.
  //
  // `draft` is seeded once at mount, and this panel has no key, so anything that
  // edits the same row while the panel is open is invisible to it - and handleSave
  // writes every field from the draft. The live case: expand a class, then use
  // "Change class" in the same row header to swap the curriculum. The modal saves
  // and the row header updates, but the panel still holds the OLD name, so its next
  // save (even one aimed only at the room) writes that name back while curriculum_id
  // points at the new class. Publish/unpublish and the post-save merge take the same
  // path. Fields the operator has already edited are left alone - only the ones they
  // have not touched follow the row.
  // Nothing is written to the four audience columns until the operator actually
  // aims at them - see the save. Set by the pills AND by the range fields, because
  // "they picked grades" and "they typed a grade" are both intent. A ref rides
  // alongside the state so the resync effect below can read it without listing it as
  // a dependency and re-running every time it flips.
  const [audienceTouched, setAudienceTouched] = useState(false);
  const audienceTouchedRef = useRef(false);
  const seededFromRef = useRef(program);
  useEffect(() => {
    const prev = seededFromRef.current;
    if (prev === program) return;
    seededFromRef.current = program;
    setDraft((d) => {
      const next = { ...d };
      // Only adopt a field when it actually changed on the row AND the operator's
      // draft still matches what the row used to say (i.e. they have not edited it).
      //
      // COMPARED AS STRINGS, deliberately. The row supplies numbers (grade_min 3,
      // max_capacity 20, price_cents 1500) while every input in this panel writes
      // strings, so a raw === made "the operator has not edited this" permanently
      // false for any numeric field they had ever touched. The panel then refused to
      // adopt an outside change AND wrote its stale value back on the next save -
      // exactly the clobber this effect exists to prevent.
      const same = (a, b) => String(a ?? "") === String(b ?? "");
      for (const k of ["curriculum", "room", "short_description", "price_cents", "max_capacity", "program_location_id", "grade_min", "grade_max", "age_min", "age_max"]) {
        const was = prev?.[k] ?? "";
        const now = program?.[k] ?? "";
        if (!same(was, now) && same(d[k], was)) next[k] = now;
      }
      return next;
    });
    if (!audienceTouchedRef.current) setPanelMode(audienceMode(program));
  }, [program]);
  // SWITCHING THE TAB IS NOT AN EDIT. Only entering a VALUE is.
  //
  // The first attempt at this counted the pills as intent, which failed the exact
  // case it was written for: the operator clicks "Ages" purely to see what is
  // there, the (empty) age boxes appear, they save the room edit they came for -
  // and because "they touched it" was true, the empty pair was written and the
  // grade range was destroyed. Verified against the live row: it really did null
  // grades 0-5 on a J2S class.
  //
  // A save must write what the operator ENTERED, not which tab they were looking
  // at. Clearing a range on purpose is still possible and still explicit: set the
  // dropdowns back to the blank option, which IS a value edit.
  // ONE RULE: what is on screen is what gets written.
  //
  // This started as two variables - the tab being viewed and the pair last typed
  // into - so that switching tabs could not destroy an edit. Every fix to that
  // split produced a new defect: a save wrote a pair the operator could not see; the
  // backwards-range guard checked one pair while the save wrote the other, so
  // "Grades 5 to 2" could be waved through; and the panel and the builder ended up
  // disagreeing about which pair a submit writes. Three attempts, three new bugs.
  //
  // So the model is now the simple one. `panelMode` decides BOTH what is displayed
  // and what is saved, and `audienceTouched` is a plain "did they type a value".
  // Switching to an empty Ages tab and saving does clear the grades - but the empty
  // boxes are right there on screen, so it is visible rather than silent, which is
  // the property the two-variable version kept failing to deliver.
  function setAudience(key, value) {
    if (key === "mode") { setPanelMode(value); return; }
    setAudienceTouched(true);
    audienceTouchedRef.current = true;
    set(key, value);
  }
  const usingGradesInPanel = panelMode === "grades";
  // THE GUARD MUST CHECK THE PAIR THAT WILL BE WRITTEN, not the tab on screen.
  //
  // Splitting "which tab am I looking at" (panelMode) from "which pair did I type
  // in" (audienceTouched) opened an escape hatch: enter Grades 5 to 2, Save greys
  // out correctly, click the Ages pill - the guard re-evaluated against the empty
  // age pair, found nothing wrong, and re-enabled Save while the patch still wrote
  // the backwards grades, and "Grades 5-2" reached the family card.
  //
  // WHAT CHANGED SINCE: `programs_grade_range_valid` / `programs_age_range_valid`
  // (migration 20260807a, already applied to staging AND prod) now reject a
  // backwards range at the database. This guard is therefore no longer the only
  // thing standing between the operator and a bad row - but it is the only thing
  // standing between them and a raw Postgres constraint string, so it matters more
  // than before, not less. Every control that reaches handleSave needs it: the Save
  // button and the drift notice's "Update to N sessions", which is the same handler.
  //
  // audienceTouched is null until the operator types, and nothing is written then,
  // so there is nothing to guard.
  const audienceBackwardsInPanel = usingGradesInPanel
    ? rangeBackwards(draft.grade_min, draft.grade_max)
    : rangeBackwards(draft.age_min, draft.age_max);

  // Copy-to-term: pick a season + year to copy this program into as a draft.
  // Operators think "Winter 2027", not "WI27" - so we present a Season and a
  // Year dropdown and compose the term code ourselves. copyResult holds the
  // outcome message shown inline.
  const [copySeason, setCopySeason] = useState(""); // "FA" | "WI" | "SP" | "SU"
  const [copyYear, setCopyYear] = useState("");     // 4-digit year string, e.g. "2027"
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState(null); // { ok: bool, message }
  // FA{yy}/WI{yy}/... code the DB expects, composed from the two dropdowns.
  const copyTargetTerm = copySeason && copyYear
    ? `${copySeason}${String(Number(copyYear)).slice(-2)}`
    : "";
  // Year choices: this year through +3, enough to copy forward a season or two
  // without offering a scroll of irrelevant years. Labels are the full year.
  const copyYearChoices = (() => {
    const y = new Date().getFullYear();
    return [y, y + 1, y + 2, y + 3];
  })();

  // Range mode live preview: as the operator types start/end, ask the DB to derive
  // the count + skipped no-school days for THIS location's calendar. Params-based
  // (preview_program_range_schedule) so it reflects the typed-but-unsaved dates,
  // not the stored row. { count, skipped, first_session, last_session } | { error }.
  const [rangePreview, setRangePreview] = useState(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  useEffect(() => {
    if (draft.schedule_mode !== "range") { setRangePreview(null); setRangeLoading(false); return; }
    if (!draft.day_of_week || !draft.first_session_date || !draft.end_date || !draft.program_location_id || !program.organization_id) {
      setRangePreview(null); setRangeLoading(false); return;
    }
    let alive = true;
    setRangeLoading(true);
    supabase.rpc("preview_program_range_schedule", {
      p_organization_id: program.organization_id,
      p_location_id: draft.program_location_id,
      p_term: program.term,
      p_day_of_week: titleDay(draft.day_of_week),
      p_start_date: draft.first_session_date,
      p_end_date: draft.end_date,
    }).then(({ data, error }) => {
      if (!alive) return;
      setRangeLoading(false);
      setRangePreview(error ? { error: error.message } : data);
    });
    return () => { alive = false; };
  }, [draft.schedule_mode, draft.day_of_week, draft.first_session_date, draft.end_date, draft.program_location_id, program.organization_id, program.term]);

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
    setSaveError(null);
  }

  async function handleDuplicate() {
    const target = copyTargetTerm; // composed from the Season + Year dropdowns
    if (!target) return;
    // Composition can't produce a bad code, but the DB CHECK is the real gate;
    // keep a defensive guard so any future caller gets plain English, not a raw
    // Postgres constraint-violation string.
    if (!/^(FA|WI|SP|SU)\d{2}$/.test(target)) {
      setCopyResult({ ok: false, message: "Pick a season and a year to copy into." });
      return;
    }
    if (target === program.term) {
      setCopyResult({ ok: false, message: `This program is already in ${formatTermLabel(target)}. Pick a different term to copy into.` });
      return;
    }
    setCopying(true);
    setCopyResult(null);
    try {
      await onDuplicate(program.id, target);
      setCopyResult({ ok: true, message: `Copied as a draft in ${formatTermLabel(target)}. Switch the term picker above to find and edit it.` });
    } catch (err) {
      setCopyResult({ ok: false, message: err.message ?? String(err) });
    } finally {
      setCopying(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const isRange = draft.schedule_mode === "range";
      // Range mode: the count is DERIVED, not typed. Require a real window that
      // actually contains class days -- refuse to save a range program that would
      // resolve to 0 sessions (session_count is NOT NULL, and 0 is meaningless).
      let derivedCount = null;
      let rangeFirstSession = null;
      if (isRange) {
        if (!draft.day_of_week) {
          throw new Error("Range mode needs a day of the week for the class.");
        }
        if (!draft.first_session_date || !draft.end_date) {
          throw new Error("Range mode needs both a start date and an end date.");
        }
        if (draft.end_date < draft.first_session_date) {
          throw new Error("The end date is before the start date.");
        }
        if (rangeLoading) {
          throw new Error("Still calculating the sessions — give it a second, then save.");
        }
        if (rangePreview?.error) {
          throw new Error("Couldn't calculate the sessions for that window — check the dates.");
        }
        // The preview only runs once a location is set (it needs the school calendar).
        // If it never ran, say THAT rather than misreporting an empty window.
        if (!rangePreview) {
          throw new Error("Pick a location first — the schedule uses its school calendar.");
        }
        derivedCount = Number(rangePreview.count);
        if (!derivedCount || derivedCount < 1) {
          throw new Error("No class days fall between that start and end date — adjust the dates.");
        }
        // Store the DERIVED first actual session (a real chosen-weekday date), so
        // first_session_date is always a true class day and derive_program_session_dates
        // keys off the right weekday. NO fallback to the raw typed start -- that could be
        // a non-chosen-weekday date, which would silently re-derive on the wrong day (the
        // seam-bug class). first_session is guaranteed non-null here (count>=1 above).
        rangeFirstSession = rangePreview.first_session;
        if (!rangeFirstSession) {
          throw new Error("Couldn't determine the first class date — check the day and dates.");
        }
      } else {
        // Count mode: session_count is NOT NULL and 0 is meaningless. Guard here so a
        // blanked/zero field gives a plain message instead of a raw Postgres NOT NULL
        // error -- which would otherwise block saving EVERY other edit on the program.
        const n = draft.session_count === "" || draft.session_count === null ? NaN : Number(draft.session_count);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error("Number of sessions must be at least 1.");
        }
      }
      // Listing on the public reg page needs somewhere to send families.
      if (draft.runs_own_registration && draft.list_in_public_catalog && !draft.external_registration_url?.trim()) {
        throw new Error("Add the partner's registration link before listing it on your public page.");
      }
      const patch = {
        // The class weekday is the operator's choice in BOTH modes.
        day_of_week: draft.day_of_week ? titleDay(draft.day_of_week) : null,
        // Convert the 24-hour input values back to the stored 12-hour text format.
        start_time: draft.start_time ? to12hText(draft.start_time) : null,
        end_time: draft.end_time ? to12hText(draft.end_time) : null,
        first_session_date: isRange ? rangeFirstSession : (draft.first_session_date || null),
        schedule_mode: isRange ? "range" : "count",
        // end_date only means anything in range mode; null it in count mode so a
        // program switched back to count never carries a stale window.
        end_date: isRange ? (draft.end_date || null) : null,
        // Range mode materializes the DERIVED count into session_count -- the same
        // field count mode uses -- so pricing/payroll/emails/date-fns all keep
        // working unchanged. Computed from the typed dates (rangePreview), not from
        // the stored row.
        session_count: isRange
          ? derivedCount
          : (draft.session_count === "" || draft.session_count === null ? null : Number(draft.session_count)),
        max_capacity: draft.max_capacity === "" || draft.max_capacity === null ? null : Number(draft.max_capacity),
        // NULL rather than "" when cleared, so the catalog's `short_description &&`
        // guard reads it as absent instead of rendering an empty paragraph. Safe to
        // write because short_description is now SELECTED above -- without that the
        // draft would start undefined and every save here would blank a description
        // the operator never touched (91 of 95 prod programs have one).
        short_description: draft.short_description?.trim() ? draft.short_description.trim() : null,
        // NOT NULL in the database and the name families read on the card, so a
        // blank box keeps the existing name rather than failing the save or
        // publishing an untitled class. Guarded again below with a visible message.
        curriculum: draft.curriculum?.trim() ? draft.curriculum.trim() : program.curriculum,
        // AUDIENCE IS OMITTED UNLESS THE OPERATOR TOUCHED IT.
        //
        // The first version wrote all five columns on EVERY save, from whichever pill
        // happened to be selected. That made a routine edit destructive: open a class
        // showing "Grades K-5" to fix the room, click "Ages" once to see what is
        // there, save - and the grade range is gone, with no confirm and nothing left
        // on screen to restore it from. It also silently nulled the age range of any
        // row carrying both pairs, because the panel opens on grades.
        //
        // A save that the operator did not aim at this field must not write it. The
        // patch comes from ONE helper so the "never both" rule and the age_format
        // rule cannot drift from the builder's copy - they used to be four hand-copied
        // ternaries in two files.
        //
        // The `audienceTouched` gate is now belt AND braces: the changed-fields filter
        // below would drop these anyway when they match the row. It stays because it
        // is the one case where "unchanged" is not the whole story - switching to an
        // empty tab produces all-nulls, which genuinely DIFFER from the row and would
        // otherwise be sent as a deliberate clear.
        ...(audienceTouched
          ? audiencePatch(panelMode, {
            gradeMin: draft.grade_min, gradeMax: draft.grade_max,
            ageMin: draft.age_min, ageMax: draft.age_max,
          })
          : {}),
        price_cents: draft.price_cents === "" || draft.price_cents === null ? null : Number(draft.price_cents),
        program_location_id: draft.program_location_id || null,
        room: draft.room || null,
        runs_own_registration: !!draft.runs_own_registration,
        external_registration_url: draft.runs_own_registration
          ? (draft.external_registration_url?.trim() || null)
          : null,
        list_in_public_catalog: draft.runs_own_registration
          ? !!draft.list_in_public_catalog
          : false,
      };
      // Live-program guard: if this save actually CHANGES the schedule and the
      // program already has enrolled families, confirm first -- a schedule change
      // moves their real class dates. Checked at save time against live registrations
      // (like Delete), so the count is authoritative, not a stale prop. Only when a
      // schedule field truly changed, so price/room/capacity edits never prompt.
      const norm = (v) => (v === "" || v === undefined ? null : v);
      const scheduleChanged =
        norm(patch.schedule_mode) !== norm(program.schedule_mode ?? "count") ||
        norm(patch.first_session_date) !== norm(program.first_session_date) ||
        norm(patch.end_date) !== norm(program.end_date) ||
        Number(patch.session_count) !== Number(program.session_count) ||
        norm(patch.day_of_week) !== norm(program.day_of_week ? titleDay(program.day_of_week) : null) ||
        norm(patch.program_location_id) !== norm(program.program_location_id);
      if (scheduleChanged) {
        const { count: enrolledCount, error: regErr } = await supabase
          .from("registrations")
          .select("id", { count: "exact", head: true })
          .eq("program_id", program.id)
          .is("cancelled_at", null);
        // FAIL CLOSED: if the enrollment check errors we can't prove the program is
        // empty, so warn anyway rather than silently move possibly-enrolled families'
        // dates (Delete aborts on this error; here a soft confirm is enough).
        const mightBeEnrolled = regErr ? true : (enrolledCount ?? 0) > 0;
        if (mightBeEnrolled) {
          const lead = regErr
            ? "Couldn't confirm whether families are enrolled, so to be safe:"
            : `${enrolledCount} ${enrolledCount === 1 ? "family is" : "families are"} enrolled in this program.`;
          const ok = window.confirm(
            `${lead} Changing the schedule will move their class dates. Save anyway?`,
          );
          if (!ok) return; // finally{} resets saving
        }
      }
      // SEND ONLY WHAT CHANGED.
      //
      // This panel used to write all twenty fields on every save, so each save
      // asserted a value for everything the operator never touched - and any field
      // whose draft had gone stale became a silent overwrite. Nearly every
      // destructive bug found in this panel traces back to that one choice: an edit
      // aimed at the room nulled a grade range; a second tab's change was reverted;
      // a "Change class" swap was undone by a later price edit. Those are not
      // separate bugs, they are one bug wearing different hats.
      //
      // A save now carries the fields the operator actually changed and nothing
      // else, so a field nobody edited cannot be clobbered no matter how stale the
      // draft is. Compared as strings because inputs produce "20" where the row
      // holds 20, and null/undefined/"" all mean "not set" on one side or the other.
      //
      // `patch` (the full object) is still what scheduleChanged above and the draft
      // sync below read - they need the INTENDED value, not the delta.
      // Bookkeeping every save owes, whether or not it wrote anything.
      //
      //  - first_session_date: in range mode the stored value is the DERIVED first
      //    session (a real chosen-weekday date), not the typed window start.
      //  - end_date: count mode stores NULL (count programs have no window), but the
      //    draft still holds the old date, so a range->count save left the banner
      //    comparing a stale draft end date against the nulled stored value.
      //  - curriculum: a blank box falls back to the stored name, so without this
      //    the field stayed empty under a red warning after a successful save.
      //  - the audience edit is SPENT once stored. Without resetting it the panel
      //    stayed permanently "touched", resending all five audience columns from a
      //    stale draft on every later save.
      //
      // Hoisted into one function because the no-op path needs it too: it is the
      // banner's only way to learn the draft already matches the row.
      function reconcileDraftToStored() {
        setAudienceTouched(false);
        audienceTouchedRef.current = false;
        setDraft((d) => ({
          ...d,
          curriculum: patch.curriculum ?? d.curriculum,
          first_session_date: patch.first_session_date ?? "",
          end_date: patch.end_date ?? "",
        }));
      }
      // day_of_week is compared THROUGH titleDay, exactly as scheduleChanged above
      // does. Older rows store it lowercase, so a raw string compare made
      // "monday" !== "Monday" on every single save: the field was always in the
      // delta, the "nothing changed" branch could never fire, and a schedule column
      // was written while scheduleChanged had said false - slipping past the
      // enrolled-families confirm. Two definitions of "changed" forty lines apart
      // is the same split this component just finished removing elsewhere.
      const sameStored = (k, stored, next) => {
        if (k === "day_of_week") return norm(stored ? titleDay(stored) : null) === norm(next);
        return String(stored ?? "") === String(next ?? "");
      };
      const changed = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!sameStored(k, program[k], v)) changed[k] = v;
      }
      if (Object.keys(changed).length === 0) {
        // Nothing to write. Say so rather than round-tripping an empty update and
        // reporting success for work that never happened - but still reconcile the
        // draft below, because the banner it drives compares against the STORED
        // values and would otherwise stay stuck claiming unsaved changes forever,
        // which also hides the drift notice (it renders only when nothing is
        // pending). Skipping the write is not the same as skipping the bookkeeping.
        reconcileDraftToStored();
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
        return; // finally{} resets saving
      }
      await onUpdate(program.id, changed);
      // Sync the draft to what was actually STORED for every field the
      // "unsaved schedule changes" banner compares, so a good save always clears
      // it. Two fields the save rewrites out from under the draft:
      //  - first_session_date: in range mode the stored value is the DERIVED first
      //    session (a real chosen-weekday date), not the typed window start.
      //  - end_date: count mode stores NULL (count programs have no window), but the
      //    draft still holds the old date -- so a range->count save left the banner
      //    stuck comparing a stale draft end date against the nulled stored value.
      // The audience edit is SPENT once it is stored. Without this the panel stayed
      // permanently "touched": every later save - a room fix, a price change - kept
      // resending all five audience columns from a stale draft, so anything that
      // changed them in between (a second tab, a SQL correction, an import) was
      // silently reverted by an edit aimed at something else entirely. It also left
      // the row-resync deaf for the rest of the session.
      reconcileDraftToStored();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setSaveError(err.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  const isDraft = program.status === "draft";
  const isOpen = program.status === "open";

  // Unsaved SCHEDULE edits? The SESSION DATES list at the bottom shows the SAVED
  // schedule (from the derive fn), so it won't match the form's live preview until
  // Save. Flag that so an in-progress edit doesn't look like the feature is "missing
  // dates". Range mode: session_count is derived, so compare the inputs, not the count.
  const schedNorm = (v) => (v === "" || v === undefined ? null : v);
  const schedulePendingSave =
    schedNorm(draft.schedule_mode) !== schedNorm(program.schedule_mode ?? "count") ||
    schedNorm(draft.first_session_date) !== schedNorm(program.first_session_date) ||
    schedNorm(draft.end_date) !== schedNorm(program.end_date) ||
    schedNorm(draft.day_of_week ? titleDay(draft.day_of_week) : null) !== schedNorm(program.day_of_week ? titleDay(program.day_of_week) : null) ||
    schedNorm(draft.program_location_id) !== schedNorm(program.program_location_id) ||
    (draft.schedule_mode !== "range" && Number(draft.session_count) !== Number(program.session_count));

  // Chunk 4 drift notice: this range program's materialized session_count went
  // stale because a school calendar changed after it was saved. Show the count the
  // window yields NOW (live from the preview once it loads; the drift snapshot until
  // then) and offer a one-click fix that just re-runs the normal Save -- which
  // re-materializes session_count against the current calendars and fires the same
  // live-program confirm if families are enrolled. No second write path. Hidden once
  // the operator starts editing (the unsaved-changes banner + live count cover that),
  // and hidden the moment the numbers agree again (honest state).
  const driftDerived = drift && draft.schedule_mode === "range"
    ? (rangePreview && !rangePreview.error && !rangeLoading
        ? Number(rangePreview.count)
        : (drift.derived ?? null))
    : null;
  const showDriftNotice = !!drift
    && draft.schedule_mode === "range"
    && !schedulePendingSave
    && driftDerived != null
    && driftDerived !== Number(program.session_count);

  return (
    <div style={{
      padding: "14px 16px 16px 16px",
      background: "#fafaf5",
      borderBottom: `1px solid ${RULE}`,
      fontSize: 13,
    }}>
      {showDriftNotice && (
        <div style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          justifyContent: "space-between",
          padding: "10px 12px",
          marginBottom: 12,
          background: `${AMBER}14`,
          border: `1px solid ${AMBER}66`,
          borderRadius: 8,
          color: INK,
          fontSize: 12.5,
          lineHeight: 1.4,
        }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ color: "#8a5a00" }}>Schedule out of date.</strong>{" "}
            {driftDerived === 0
              ? `A calendar change means no class days fall in this window anymore. Its saved schedule still has ${program.session_count} session${Number(program.session_count) === 1 ? "" : "s"} — extend the end date below, then Save.`
              : `A school-calendar change means this program's dates now yield ${driftDerived} session${driftDerived === 1 ? "" : "s"}, but its saved schedule still has ${program.session_count}. Update to move families onto the corrected dates.`}
          </div>
          {driftDerived > 0 && (() => {
            // THIS BUTTON IS `handleSave` UNDER ANOTHER NAME, so it needs every guard
            // Save has. It was missing the backwards-range one, which made it the
            // escape hatch around it: type "Grades 8 to 2", watch Save grey out, then
            // click Update to N sessions instead and the same patch goes to a database
            // that now REFUSES the range (programs_grade_range_valid, 20260807a) - so
            // the operator gets a raw Postgres constraint string in the notice. Not
            // reachable on prod today only because the audience fields ship with this
            // branch; it would arrive reachable.
            const driftDisabled = saving || rangeLoading || !rangePreview || audienceBackwardsInPanel;
            return (
            <button
              type="button"
              onClick={handleSave}
              disabled={driftDisabled}
              style={{
                flexShrink: 0,
                padding: "7px 14px",
                background: BRIGHT,
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 12.5,
                fontWeight: 700,
                fontFamily: "inherit",
                cursor: driftDisabled ? "default" : "pointer",
                opacity: driftDisabled ? 0.6 : 1,
              }}
              title={audienceBackwardsInPanel
                ? rangeBackwardsMessage(panelMode)
                : "Re-derive the sessions from the current calendars and save. If families are enrolled, you'll be asked to confirm first."}
            >
              {saving ? "Updating…" : `Update to ${driftDerived} session${driftDerived === 1 ? "" : "s"}`}
            </button>
            );
          })()}
          {/* Surface a failed Update right here at the notice -- otherwise the only
              error message renders down by the form's Save button, off-screen from
              the button the operator just clicked, and the notice looks inert. */}
          {saveError && (
            <div style={{ flexBasis: "100%", color: "#b53737", fontSize: 12, fontWeight: 600 }}>
              {saveError}
            </div>
          )}
        </div>
      )}
      {/* Edit form — sectioned grid */}
      <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        Edit program
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 12,
        marginBottom: 12,
      }}>
        <ExpandField label="Day of week">
          {/* Editable in BOTH modes. In range mode this IS the class weekday the
              derivation follows -- the start date is only the window's earliest edge,
              and the schedule snaps to the first of THIS weekday on/after it.
              Option values are Title-Case to match how the column is stored -- a
              lowercase value breaks the VIP bundle match and renders lowercase on
              the public catalog. */}
          <select value={titleDay(draft.day_of_week)} onChange={(e) => set("day_of_week", e.target.value)} style={expandInputStyle}>
            <option value="">—</option>
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={DAY_LABELS[d]}>{DAY_LABELS[d]}</option>
            ))}
          </select>
        </ExpandField>
        <ExpandField label="Start time">
          <input type="time" value={draft.start_time ?? ""} onChange={(e) => set("start_time", e.target.value)} style={expandInputStyle} />
        </ExpandField>
        <ExpandField label="End time">
          <input type="time" value={draft.end_time ?? ""} onChange={(e) => set("end_time", e.target.value)} style={expandInputStyle} />
        </ExpandField>
        <ExpandField label="Scheduling">
          {/* Count = the usual way (set a number of sessions). Range = set a start
              and end date; the count derives. Default count; range is opt-in per program. */}
          <div style={{ display: "flex", gap: 0, border: `1.5px solid ${RULE}`, borderRadius: 6, overflow: "hidden" }}>
            {[["count", "By count"], ["range", "By dates"]].map(([mode, label]) => {
              const active = (draft.schedule_mode === "range") === (mode === "range");
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => set("schedule_mode", mode)}
                  style={{
                    flex: 1, padding: "7px 6px", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                    cursor: "pointer", border: "none",
                    background: active ? BRIGHT : "#fff",
                    color: active ? "#fff" : MUTED,
                  }}
                >{label}</button>
              );
            })}
          </div>
        </ExpandField>

        {draft.schedule_mode === "range" ? (
          <>
            <ExpandField label="Start date">
              <input type="date" value={draft.first_session_date ?? ""} onChange={(e) => set("first_session_date", e.target.value)} style={expandInputStyle} />
            </ExpandField>
            <ExpandField label="End date">
              <input type="date" value={draft.end_date ?? ""} onChange={(e) => set("end_date", e.target.value)} style={expandInputStyle} />
            </ExpandField>
            <ExpandField label="Sessions (from dates)">
              {/* Read-only: the count is never typed in range mode -- it derives. */}
              <div style={{
                ...expandInputStyle,
                background: "#f4f3ee", color: INK, display: "flex", alignItems: "center",
                minHeight: 36, fontSize: 12.5, lineHeight: 1.3,
              }}>
                {rangeLoading
                  ? "Calculating…"
                  : rangePreview?.error
                    ? <span style={{ color: "#b53737" }}>Couldn't calculate</span>
                    : (!draft.first_session_date || !draft.end_date)
                      ? <span style={{ color: MUTED }}>Set start & end</span>
                      : (draft.end_date < draft.first_session_date)
                        ? <span style={{ color: AMBER }}>End date is before the start date</span>
                        : rangePreview
                          ? (Number(rangePreview.count) > 0
                              ? <span><strong>{rangePreview.count}</strong> session{Number(rangePreview.count) === 1 ? "" : "s"}{Number(rangePreview.skipped) > 0 ? ` · ${rangePreview.skipped} no-school day${Number(rangePreview.skipped) === 1 ? "" : "s"} skipped` : ""}</span>
                              : <span style={{ color: AMBER }}>No class days in this window</span>)
                          : <span style={{ color: MUTED }}>—</span>}
              </div>
            </ExpandField>
          </>
        ) : (
          <>
            <ExpandField label="First session">
              <input type="date" value={draft.first_session_date ?? ""} onChange={(e) => set("first_session_date", e.target.value)} style={expandInputStyle} />
            </ExpandField>
            <ExpandField label="Sessions">
              <input type="number" min="1" max="40" value={draft.session_count ?? ""} onChange={(e) => set("session_count", e.target.value)} style={expandInputStyle} />
            </ExpandField>
          </>
        )}
        <ExpandField label="Capacity">
          <input type="number" min="0" max="999" value={draft.max_capacity ?? ""} onChange={(e) => set("max_capacity", e.target.value)} style={expandInputStyle} />
        </ExpandField>
        <ExpandField label="Price ($)">
          <input
            type="number" min="0" step="1"
            value={draft.price_cents == null || draft.price_cents === "" ? "" : Math.round(Number(draft.price_cents) / 100)}
            onChange={(e) => set("price_cents", e.target.value === "" ? "" : Math.round(Number(e.target.value) * 100))}
            style={expandInputStyle}
          />
        </ExpandField>
        <ExpandField label="Location *">
          <select value={draft.program_location_id ?? ""} onChange={(e) => set("program_location_id", e.target.value)} style={expandInputStyle}>
            {/* A prompt, not a choice. Location is required, so this option
                exists only to represent "not chosen yet" -- Save is blocked
                while it is selected. `locations === null` means the list could
                not be READ, which is not the same as the org having none: on a
                failed read the program's own location is still set, so the
                picker would otherwise render blank and silently look like the
                location had been lost. */}
            <option value="">
              {locations === null
                ? "Couldn't load locations"
                : locations.length === 0
                  ? "No locations yet"
                  : "— pick a location —"}
            </option>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.district ? ` (${l.district})` : ""}</option>
            ))}
          </select>
          {/* Warn on a failed read even when a location IS set, because that is
              exactly when the control misrepresents itself: the saved value has
              no matching <option>, so the field renders empty and an operator
              could "correct" it into something else. */}
          {locations === null ? (
            <div style={{ fontSize: 12, color: "#8a6d1f", marginTop: 4 }}>
              Couldn't load this org's locations — refresh before changing this field.
            </div>
          ) : !draft.program_location_id ? (
            <div style={{ fontSize: 12, color: "#8a6d1f", marginTop: 4 }}>
              {locations.length === 0
                ? "Add one under Programs → Locations, then pick it here."
                : "Every class needs a location — pick one to save."}
            </div>
          ) : (() => {
            // A location IS picked: show its address so the operator can confirm
            // the right venue is attached. The <option> only carries a name, and
            // two venues can share one. Blank would read as "we lost it", so the
            // address-less case says so instead.
            const picked = locations.find((l) => l.id === draft.program_location_id);
            if (!picked) return null;
            return picked.address?.trim() ? (
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>📍 {picked.address}</div>
            ) : (
              <div style={{ fontSize: 12, color: "#8a6d1f", marginTop: 4 }}>
                No address saved for this location yet — families won't see one.
              </div>
            );
          })()}
        </ExpandField>
        <ExpandField label="Room">
          <input type="text" value={draft.room ?? ""} onChange={(e) => set("room", e.target.value)} placeholder="e.g. Room 12" style={expandInputStyle} />
        </ExpandField>
        {/* WHO IT'S FOR. Grades or ages, the same one question the builder asks,
            switched by the same rule. Neither pair was editable here before, so a
            provider who left it blank at creation - all 13 of Jeff's classes - had
            no way to add it, and one set wrongly could never be corrected. */}
        {/* NOT inside ExpandField. ExpandField renders a bare <label> (no htmlFor),
            and a label forwards clicks to its first labelable descendant - which here
            would be the "Grades" pill. Clicking the caption, the "to" separator, or
            the empty space beside the fields would silently flip the mode. Every
            other ExpandField wraps a single input, so this was the first one where
            that forwarding could destroy data. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }} role="group" aria-label="Who this class is for">
          <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.3 }}>
            Who it&rsquo;s for
          </span>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {[["grades", "Grades"], ["ages", "Ages"]].map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setAudience("mode", val)}
                aria-pressed={panelMode === val}
                style={{
                  padding: "3px 10px", borderRadius: 999, fontSize: 11.5, fontWeight: 600,
                  fontFamily: "inherit", cursor: "pointer",
                  border: `1px solid ${panelMode === val ? BRIGHT : RULE}`,
                  background: panelMode === val ? BRIGHT : "#fff",
                  color: panelMode === val ? "#fff" : INK,
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {usingGradesInPanel ? (
              <>
                <select value={draft.grade_min ?? ""} onChange={(e) => setAudience("grade_min", e.target.value)} style={{ ...expandInputStyle, width: 74 }} aria-label="Lowest grade">
                  <option value="">—</option>
                  {GRADE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span style={{ fontSize: 12, color: MUTED }}>to</span>
                <select value={draft.grade_max ?? ""} onChange={(e) => setAudience("grade_max", e.target.value)} style={{ ...expandInputStyle, width: 74 }} aria-label="Highest grade">
                  <option value="">—</option>
                  {GRADE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </>
            ) : (
              <>
                <input type="text" inputMode="numeric" value={draft.age_min ?? ""} onChange={(e) => setAudience("age_min", e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} placeholder="5" style={{ ...expandInputStyle, width: 74 }} aria-label="Youngest age" />
                <span style={{ fontSize: 12, color: MUTED }}>to</span>
                <input type="text" inputMode="numeric" value={draft.age_max ?? ""} onChange={(e) => setAudience("age_max", e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} placeholder="12" style={{ ...expandInputStyle, width: 74 }} aria-label="Oldest age" />
              </>
            )}
          </div>
          {audienceBackwardsInPanel && (
            <div style={{ color: RED, fontSize: 11.5, marginTop: 4 }}>
              {rangeBackwardsMessage(panelMode)}
            </div>
          )}
        </div>
      </div>

      {/* The class NAME. Free text at creation for a lean provider and, until now,
          not editable anywhere afterwards. Full width because a class name is a
          sentence ("Beginner Ukulele, Tuesdays"), not a field-grid value.

          ONLY WHEN NOTHING ELSE OWNS THE NAME. A program linked to an Offerings
          record gets its name from that record, and the row header's "Change class"
          rewrites it on every re-match - so a free-text rename there produces two
          controls editing one field, silently diverging programs.curriculum from
          curricula.name with nothing on screen saying which won. Gated on the link
          rather than on the tenant, because that is the actual hazard: every lean
          program is unlinked, and an unlinked full-nav program is equally safe. */}
      {!program.curriculum_id && (
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.3 }}>
          Class name
          <input
            type="text"
            value={draft.curriculum ?? ""}
            onChange={(e) => set("curriculum", e.target.value)}
            maxLength={120}
            style={{ ...expandInputStyle, marginTop: 4, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}
          />
        </label>
        {!draft.curriculum?.trim() && (
          <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>
            A class needs a name — saving now keeps the current one, &ldquo;{program.curriculum}&rdquo;.
          </div>
        )}
      </div>
      )}

      {/* Description sits OUTSIDE the field grid because it needs the full width
          to be writable. Editable here (not only in the builder) so the programs
          that already exist can get one -- until now only the full-nav builder
          collected it, so a lean operator's whole catalog had none. */}
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.3 }}>
          Description
          <textarea
            value={draft.short_description ?? ""}
            onChange={(e) => set("short_description", e.target.value)}
            placeholder="What families should know - what they'll learn, what to bring, who it's for."
            maxLength={PROGRAM_DESCRIPTION_MAX}
            style={{ ...expandInputStyle, marginTop: 4, minHeight: 120, resize: "vertical", fontFamily: "inherit", textTransform: "none", letterSpacing: 0, fontWeight: 400, lineHeight: 1.5 }}
          />
        </label>
        {/* Same cap and same counter as the builder, from one constant. The number
            was hardcoded 600 in both files, so raising it meant finding both. */}
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
          Shown to families on the registration page, under the class name.
          Line breaks are kept, so you can write more than one paragraph.
        </div>
        {/* Own line, same as the builder: inline it read as the end of the
            sentence above rather than as a count. */}
        {(() => {
          const c = describeDescriptionLength(draft.short_description);
          return c ? (
            <div style={{ fontSize: 12, marginTop: 2, color: c.atLimit ? RED : MUTED, fontWeight: c.atLimit ? 600 : 400 }}>
              {c.text}
            </div>
          ) : null;
        })()}
      </div>

      {(() => {
        const fdw = draft.first_session_date ? WEEKDAY_NAMES[new Date(`${draft.first_session_date}T00:00:00`).getDay()] : null;
        return draft.day_of_week && fdw && fdw !== draft.day_of_week ? (
          <div style={{ background: "#FDF6E3", border: "1px solid #F0D48A", color: "#8a5a00", borderRadius: 6, padding: "8px 12px", fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
            Heads up: this date is a <strong>{fdw}</strong>, but the day is set to <strong>{draft.day_of_week}</strong>. Sessions will fall on {fdw}s — change the date or the day to match.
          </div>
        ) : null;
      })()}

      {/* Registration ownership — who collects sign-ups. Partner-run registration
          is a J2S/partner concept; a lean self-serve op always uses our checkout. */}
      {!isLean && (
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!draft.runs_own_registration}
            onChange={(e) => set("runs_own_registration", e.target.checked)}
          />
          Partner runs their own registration — families register with the partner, not our checkout
        </label>
        {draft.runs_own_registration && (
          <div style={{ marginTop: 8, maxWidth: 440 }}>
            <ExpandField label="Partner's registration link">
              <input
                type="url"
                inputMode="url"
                value={draft.external_registration_url ?? ""}
                onChange={(e) => set("external_registration_url", e.target.value)}
                placeholder="https://…  where families sign up"
                style={expandInputStyle}
              />
            </ExpandField>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: 13, color: INK, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!draft.list_in_public_catalog}
                onChange={(e) => set("list_in_public_catalog", e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                Also list it on our public reg page
                <span style={{ display: "block", fontSize: 12, color: MUTED, marginTop: 2 }}>
                  Off by default — the program stays off your catalog. Check this to show it with a "Register at the partner" link (needs a link above).
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
      )}

      {saveError && (
        <div style={{ background: "#fde7e7", color: "#b53737", padding: "8px 12px", borderRadius: 6, fontSize: 12.5, marginBottom: 10 }}>
          Couldn't save: {saveError}
        </div>
      )}

      {/* Action row: Save · Publish/Unpublish · Delete */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${RULE}` }}>
        {(() => {
          const rangeBusy = draft.schedule_mode === "range" && rangeLoading;
          // Location is required. Blocking Save is what makes the rule real --
          // the message under the picker would otherwise be advice the form does
          // not enforce, and the DB (program_location_id NOT NULL) would reject
          // the write with a constraint error nobody can read.
          const noLocation = !draft.program_location_id;
          // Same reasoning for a backwards range: the message beside the fields is
          // advice until the button enforces it, and "Grades 5 to 2" reaches the
          // catalog card as nonsense a parent has to decode.
          const disabled = saving || rangeBusy || noLocation || audienceBackwardsInPanel;
          return (
            <button
              type="button"
              onClick={handleSave}
              disabled={disabled}
              title={
                noLocation ? "Pick a location first — every class needs one."
                  : audienceBackwardsInPanel ? rangeBackwardsMessage(panelMode)
                    : undefined
              }
              style={{
                background: BRIGHT, color: "#fff", border: "none", padding: "8px 16px",
                borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                cursor: disabled ? (noLocation ? "not-allowed" : "wait") : "pointer",
                opacity: disabled ? 0.6 : 1,
              }}
            >{saving ? "Saving…" : rangeBusy ? "Calculating…" : "Save changes"}</button>
          );
        })()}
        {savedFlash && <span style={{ color: OK_GREEN, fontWeight: 600, fontSize: 12 }}>✓ Saved</span>}

        {/* Same rule as the page-level share: no link handed out until the
            operator can be paid for it. */}
        {isLean && panelOrg?.stripe_charges_enabled === false ? (
          <Link
            to="/admin/finances"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "7px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              textDecoration: "none", background: "#FDF6E3",
              border: "1px solid #F0D48A", color: "#8a5a00",
            }}
          >
            Connect Stripe to share this →
          </Link>
        ) : (
        <ShareProgram
          slug={orgSlug}
          activeTerm={orgActiveTerm}
          align="left"
          program={{
            id: program.id,
            curriculum: program.curriculum,
            status: program.status,
            term: program.term,
            runs_own_registration: program.runs_own_registration,
            external_registration_url: program.external_registration_url,
          }}
        />
        )}

        <div style={{ flex: 1 }} />

        {isDraft && (
          publishBlocked ? (
            // The reason goes ON the control, where the operator is looking —
            // not in a banner at the top of a panel they have scrolled past.
            <Link
              to={STRIPE_CONNECT_ROUTE}
              title={`${PUBLISH_GATE_WHY} ${PUBLISH_GATE_STAYS_DRAFT_HINT}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: "#FDF6E3", color: "#8a5a00", border: "1px solid #F0D48A",
                padding: "7px 14px", borderRadius: 6, fontSize: 12.5, fontWeight: 700,
                fontFamily: "inherit", textDecoration: "none",
              }}
            >{PUBLISH_GATE_CTA} →</Link>
          ) : (
            <button
              type="button"
              onClick={() => onPublish?.(program.id)}
              style={{
                background: OK_GREEN, color: "#fff", border: "none", padding: "8px 14px",
                borderRadius: 6, fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
              }}
              title="Publish — show in catalog + marketing"
            >Publish →</button>
          )
        )}
        {isOpen && (
          <button
            type="button"
            onClick={() => onUnpublish?.(program.id)}
            style={{
              background: "transparent", color: AMBER, border: `1px solid ${AMBER}`, padding: "7px 14px",
              borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
            }}
            title="Unpublish — hide from catalog and stop appearing in marketing"
          >Unpublish</button>
        )}
        <button
          type="button"
          onClick={() => onDelete?.(program.id)}
          style={{
            background: "transparent", color: "#b53737", border: `1px solid #b53737`, padding: "7px 14px",
            borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
          }}
          title="Delete this program permanently (blocked if registrations exist)"
        >Delete</button>
      </div>

      {/* Copy to term — same location/day/time/curriculum/price, into another
          term, as a draft. Season + Year dropdowns compose the term code so the
          operator never sees or types a raw code like "WI27". */}
      <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${RULE}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Copy to another term
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={copySeason}
            onChange={(e) => { setCopySeason(e.target.value); setCopyResult(null); }}
            style={{ ...expandInputStyle, width: 130 }}
            aria-label="Season to copy into"
          >
            <option value="">Season…</option>
            <option value="FA">Fall</option>
            <option value="WI">Winter</option>
            <option value="SP">Spring</option>
            <option value="SU">Summer</option>
          </select>
          <select
            value={copyYear}
            onChange={(e) => { setCopyYear(e.target.value); setCopyResult(null); }}
            style={{ ...expandInputStyle, width: 110 }}
            aria-label="Year to copy into"
          >
            <option value="">Year…</option>
            {copyYearChoices.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
          <button
            type="button"
            onClick={handleDuplicate}
            disabled={copying || !copyTargetTerm}
            style={{
              background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, padding: "7px 14px",
              borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
              cursor: copying || !copyTargetTerm ? "default" : "pointer",
              opacity: copying || !copyTargetTerm ? 0.6 : 1,
            }}
            title="Create a draft copy of this program in the chosen term"
          >{copying ? "Copying…" : (copyTargetTerm ? `Copy to ${formatTermLabel(copyTargetTerm)} →` : "Copy →")}</button>
        </div>
        {copyResult && (
          <div style={{
            marginTop: 8, fontSize: 12.5,
            color: copyResult.ok ? OK_GREEN : "#b53737",
          }}>
            {copyResult.ok ? "✓ " : ""}{copyResult.message}
          </div>
        )}
      </div>

      {/* Session dates view (existing) */}
      {schedulePendingSave && (
        <div style={{ fontSize: 12, color: AMBER, fontWeight: 600, marginBottom: 6 }}>
          Unsaved schedule changes — the dates below update when you Save.
        </div>
      )}
      <SessionDatesPanel program={program} dates={dates} districtHasCalendar={districtHasCalendar} onScheduleChanged={onScheduleChanged} inline />
    </div>
  );
}

function ExpandField({ label, children }) {
  return (
    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.3 }}>
      {label}
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

const expandInputStyle = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  color: INK,
  border: `1px solid ${RULE}`,
  borderRadius: 5,
  fontFamily: "inherit",
  background: "#fff",
  boxSizing: "border-box",
};

function SessionDatesPanel({ program, dates, districtHasCalendar, onScheduleChanged, inline = false }) {
  // Lean ops have no instructors and no partner-school calendars.
  const { org: sdpOrg } = useOutletContext() ?? {};
  const isLean = sdpOrg?.instructor_pay_model === "enrops_platform";
  const [copied, setCopied] = useState(false);
  // In-context "mark a no-school day": lets the operator drop a class date right
  // here without hunting for the School calendar page. Writes via the
  // add_program_no_school_date RPC (district calendar, or the location's own
  // closures when there's no district), then re-derives so the list below shows
  // the real shifted schedule.
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipDate, setSkipDate] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipErr, setSkipErr] = useState(null);
  const [skipDone, setSkipDone] = useState(null);
  // 'district' = whole district's calendar; 'location' = just this school's own
  // closures. Defaulted on open (district when the location has one, else forced
  // to location). Drives the write target, the reason field, and the copy.
  const [skipScope, setSkipScope] = useState("district");

  // `dates` is the full schedule: [{ date, kind: 'session'|'no_school', reason }].
  const schedule = Array.isArray(dates) ? dates : [];
  const sessions = schedule.filter((x) => x?.kind === "session");
  const closureCount = schedule.length - sessions.length;

  function copyList() {
    // Copy real meeting dates only — the no-school rows are context, not sessions.
    const text = sessions.map((x) => formatSessionDate(x.date)).join("\n");
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => { /* clipboard blocked — ignore */ },
    );
  }

  async function confirmSkip() {
    if (!skipDate) return;
    setSkipBusy(true);
    setSkipErr(null);
    try {
      const { error } = await supabase.rpc("add_program_no_school_date", {
        p_program_id: program.id,
        p_date: skipDate,
        p_reason: skipReason.trim() || null,
        p_scope: skipScope,
      });
      if (error) throw error;
      // Re-derive so the list below reflects the real, shifted schedule rather
      // than a guess computed here (single source of truth is the SQL derivation).
      if (onScheduleChanged) await onScheduleChanged(program.id);
      setSkipDone(skipDate);
      setSkipOpen(false);
      setSkipDate("");
      setSkipReason("");
      setTimeout(() => setSkipDone(null), 5000);
    } catch (e) {
      setSkipErr(e?.message || "Couldn't mark that date. Please try again.");
    } finally {
      setSkipBusy(false);
    }
  }

  const district = program.program_locations?.district ?? null;
  // Free-text district may be absent once a school is linked structurally;
  // fall back to a generic label so the warning never reads "... for  —".
  const districtLabel = district || "this school's district";
  const showMissingCalendarWarning = districtHasCalendar === false;

  // No dates yet? Say so honestly (mode-aware) instead of vanishing -- otherwise a
  // program with an incomplete schedule looks like a rendering gap.
  if (sessions.length === 0) {
    const hint = program.schedule_mode === "range"
      ? "set a start and end date to generate the schedule"
      : "set a first session date to generate the schedule";
    return (
      <div style={{ fontSize: 12.5, color: MUTED, padding: inline ? "8px 0 0" : "8px 12px" }}>
        No session dates yet — {hint}.
      </div>
    );
  }

  // When nested inside ExpandedProgramPanel ("inline"), drop our outer box
  // (the parent already provides padding + background + border) so the
  // section reads as a continuation of the edit form, not a fresh card.
  const Wrapper = inline ? "div" : "div";
  const wrapperStyle = inline ? { fontSize: 13 } : {
    padding: "12px 16px 14px 90px",
    background: "#fafaf5",
    borderBottom: `1px solid ${RULE}`,
    fontSize: 13,
  };

  return (
    <Wrapper style={wrapperStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Session dates · {sessions.length}
        </div>
        {/* Light-touch coaching (EnnieTip = the "?" bubble). Kept OUTSIDE the
            uppercase heading above so the bubble text doesn't inherit
            text-transform. Adds what the subtitle doesn't say: it's district-wide
            and flows to families + instructors on its own. */}
        <EnnieTip title="What's a no-school day?">
          A day school is closed, so class doesn't meet. Your schedule skips it and
          runs a week or more longer, and that updates for families and instructors
          automatically. Missing one? Use "Mark a no-school day" — choose all of
          your district for a district holiday, or just this school if the day is
          specific to your school and not district-wide.
        </EnnieTip>
        <div style={{ fontSize: 12, color: MUTED }}>
          Derived from this program's first session and day of week{!isLean ? `, and the ${district || "location"} school calendar` : ""}.
          {closureCount > 0 && " No-school days are shown struck through and don't count as sessions."}
        </div>
        <button
          type="button"
          onClick={copyList}
          style={{
            ...editLinkStyle,
            background: copied ? `${VIOLET}33` : "transparent",
            color: copied ? PURPLE : PURPLE,
          }}
          title="Copy the date list to clipboard (one per line)"
        >
          {copied ? "✓ Copied" : "Copy list"}
        </button>
        {/* Needs a location to record against (district calendar is resolved via
            the location; the school-only fallback writes the location's own
            closures). No location -> nowhere to write, so don't offer it. */}
        {program.program_location_id && (
          <button
            type="button"
            onClick={() => { setSkipErr(null); setSkipReason(""); setSkipDate(sessions[0]?.date ?? ""); setSkipScope(district ? "district" : "location"); setSkipOpen(true); }}
            style={{ ...editLinkStyle }}
            title="Remove a class date from this program (e.g. a no-school day your calendar doesn't cover yet)"
          >
            Mark a no-school day
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, color: INK, marginBottom: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
        {!isLean && (
          <div>
            <span style={{ color: MUTED, fontWeight: 600 }}>Instructor: </span>
            {program.instructor_name
              ? <span>{program.instructor_name}</span>
              : <span style={{ color: MUTED, fontStyle: "italic" }}>Not assigned yet</span>}
          </div>
        )}
        {program.room && (
          <div>
            <span style={{ color: MUTED, fontWeight: 600 }}>Room: </span>
            <span>{program.room}</span>
          </div>
        )}
      </div>
      {showMissingCalendarWarning && (
        <div style={{
          background: `${AMBER}1F`,
          border: `1px solid ${AMBER}66`,
          borderRadius: 6,
          padding: "8px 12px",
          color: AMBER,
          fontSize: 12,
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}>
          <strong>Heads up:</strong>
          <span>No calendar saved for {districtLabel} — these dates are weekly only, holidays not subtracted.</span>
          <a
            href="/admin/calendars"
            style={{ color: AMBER, fontWeight: 600, textDecoration: "underline" }}
          >
            Set up {districtLabel} calendar →
          </a>
        </div>
      )}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
        gap: "4px 12px",
      }}>
        {schedule.map((x, idx) => (
          x.kind === "no_school" ? (
            <div key={`${x.date}-ns-${idx}`} style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: MUTED }}>
              <span style={{ textDecoration: "line-through" }}>{formatSessionDate(x.date)}</span>
              <span style={{ fontStyle: "italic" }}> · {x.reason || "No school"}</span>
            </div>
          ) : (
            <div key={`${x.date}-s-${idx}`} style={{ color: INK, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
              {formatSessionDate(x.date)}
            </div>
          )
        ))}
      </div>

      {skipDone && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: OK_GREEN, fontWeight: 600 }}>
          ✓ {formatSessionDate(skipDone)} marked a no-school day — the dates above updated.
        </div>
      )}

      {skipOpen && (
        <div
          onClick={() => !skipBusy && setSkipOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", zIndex: 300 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 460, width: "100%", padding: 20, boxShadow: "0 10px 40px rgba(0,0,0,0.25)", fontFamily: "inherit" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: PURPLE, marginBottom: 12 }}>Mark a no-school day</div>
            <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Which class date is off?</label>
            <select
              value={skipDate}
              onChange={(e) => setSkipDate(e.target.value)}
              disabled={skipBusy}
              style={{ width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", marginBottom: 12, background: "#fff", color: INK }}
            >
              {sessions.map((s) => <option key={s.date} value={s.date}>{formatSessionDate(s.date)}</option>)}
            </select>
            {/* Scope: a district holiday -> the whole district's calendar (every
                program there skips it); a day only THIS school is closed -> just
                this location. Only offer the district option when the location
                actually has a district to write to. */}
            {district ? (
              <>
                <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Who's off that day?</label>
                <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={skipBusy}
                    onClick={() => setSkipScope("district")}
                    style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${skipScope === "district" ? BRIGHT : RULE}`, background: skipScope === "district" ? BRIGHT : "#fff", color: skipScope === "district" ? "#fff" : INK, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: skipBusy ? "not-allowed" : "pointer" }}
                  >
                    All of {district}
                  </button>
                  <button
                    type="button"
                    disabled={skipBusy}
                    onClick={() => { setSkipScope("location"); setSkipReason(""); }}
                    style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${skipScope === "location" ? BRIGHT : RULE}`, background: skipScope === "location" ? BRIGHT : "#fff", color: skipScope === "location" ? "#fff" : INK, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: skipBusy ? "not-allowed" : "pointer" }}
                  >
                    Just this school
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
                Applies to <strong>this school only</strong> — its location has no district set.
              </div>
            )}
            {/* Reason is stored only on the district calendar ({date, reason}); the
                location closure list is a plain date[] with nowhere to keep one, so
                hide it when the scope is this-school-only. */}
            {skipScope === "district" && (
              <>
                <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Reason (optional)</label>
                <input
                  type="text"
                  value={skipReason}
                  onChange={(e) => setSkipReason(e.target.value)}
                  disabled={skipBusy}
                  placeholder="e.g. Teacher workday"
                  style={{ width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", marginBottom: 12, color: INK }}
                />
              </>
            )}
            <div style={{ background: "#faf7ed", border: "1px solid #ece1bf", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: INK, marginBottom: 14, lineHeight: 1.5 }}>
              {skipScope === "district"
                ? <>This adds <strong>{skipDate ? formatSessionDate(skipDate) : "this date"}</strong> to <strong>{districtLabel}</strong>'s school calendar, so <strong>every program in {districtLabel}</strong> skips it too. Your class keeps all <strong>{sessions.length}</strong> session{sessions.length === 1 ? "" : "s"}, so the last class moves about a week or more later.</>
                : <>This adds <strong>{skipDate ? formatSessionDate(skipDate) : "this date"}</strong> to <strong>this school's</strong> own no-school days, so only <strong>this school's</strong> classes skip it. Your class keeps all <strong>{sessions.length}</strong> session{sessions.length === 1 ? "" : "s"}, so the last class moves about a week or more later.</>}
            </div>
            {skipErr && <div style={{ fontSize: 12.5, color: "#b3261e", marginBottom: 10 }}>{skipErr}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setSkipOpen(false)} disabled={skipBusy} style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: skipBusy ? "not-allowed" : "pointer" }}>Cancel</button>
              <button type="button" onClick={confirmSkip} disabled={skipBusy || !skipDate} style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: (skipBusy || !skipDate) ? "not-allowed" : "pointer", opacity: (skipBusy || !skipDate) ? 0.6 : 1 }}>{skipBusy ? "Marking…" : "Mark no-school day"}</button>
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  );
}

function formatSessionDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

function FacilityPill({ program, onClick }) {
  const requested = program?.facility_requested_at;
  const approved = program?.facility_approved_at;
  let label, fg, bg;
  if (approved) {
    label = `Approved ${formatFirstSessionDate(approved)}`;
    fg = OK_GREEN;
    bg = `${OK_GREEN}1F`;
  } else if (requested) {
    label = `Requested ${formatFirstSessionDate(requested)}`;
    fg = AMBER;
    bg = `${AMBER}1F`;
  } else {
    label = "Facility not requested";
    fg = MUTED;
    bg = `${MUTED}14`;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 10px",
        background: bg,
        color: fg,
        border: `1px solid ${fg}66`,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: "pointer",
        flexShrink: 0,
      }}
      title="Click to log facility request and approval dates"
    >
      {label}
    </button>
  );
}

function FacilityRequestModal({ program, onCancel, onSave }) {
  const [requested, setRequested] = useState(program.facility_requested_at ?? "");
  const [approved, setApproved] = useState(program.facility_approved_at ?? "");
  const [notes, setNotes] = useState(program.facility_notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setError(null);
    if (approved && requested && approved < requested) {
      setError("Approval date can't be before the request date.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ requested_at: requested, approved_at: approved, notes });
    } catch (e) {
      setError(`Couldn't save: ${e.message ?? "unknown error"}`);
      setSaving(false);
    }
  }

  async function clearAll() {
    setError(null);
    setSaving(true);
    try {
      await onSave({ requested_at: "", approved_at: "", notes: "" });
    } catch (e) {
      setError(`Couldn't clear: ${e.message ?? "unknown error"}`);
      setSaving(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel?.(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28, 0, 79, 0.35)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div style={{
        background: PANEL,
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        maxWidth: 540,
        width: "100%",
        padding: "20px 24px",
        boxShadow: "0 12px 32px rgba(0,0,0,0.15)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>Facility request</div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {program.curriculum} · {program.program_locations?.name ?? "(no location)"}
            {program.day_of_week ? ` · ${program.day_of_week}` : ""}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={facLabel}>Request submitted</span>
          <input
            type="date"
            value={requested ?? ""}
            onChange={(e) => setRequested(e.target.value)}
            style={facInput}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={facLabel}>Approved</span>
          <input
            type="date"
            value={approved ?? ""}
            onChange={(e) => setApproved(e.target.value)}
            style={facInput}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={facLabel}>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder='e.g. "Waiting on PTA approval", "Facilitron request ID 12345"'
            rows={2}
            style={{ ...facInput, resize: "vertical", minHeight: 60 }}
          />
        </label>

        {error && (
          <div style={{
            background: "#fdecea",
            border: "1px solid #d9694f",
            color: "#d9694f",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 500,
          }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <button
            type="button"
            onClick={clearAll}
            disabled={saving || (!program.facility_requested_at && !program.facility_approved_at && !program.facility_notes)}
            style={{
              ...facBtn(MUTED, "transparent", true),
              opacity: (saving || (!program.facility_requested_at && !program.facility_approved_at && !program.facility_notes)) ? 0.4 : 1,
            }}
            title="Reset all three fields to empty"
          >
            Clear
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancel} disabled={saving} style={facBtn(MUTED, "transparent", true)}>
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving} style={facBtn("#fff", BRIGHT, false)}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const facLabel = {
  fontSize: 12,
  fontWeight: 600,
  color: INK,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const facInput = {
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

function facBtn(fg, bg, outlined) {
  return {
    padding: "8px 16px",
    background: bg,
    color: fg,
    border: outlined ? `1px solid ${fg}` : "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function formatFirstSessionDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
}

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

// programs.start_time/end_time are stored as 12-hour text ("2:45 PM"), but
// <input type="time"> only accepts 24-hour "HH:MM". to24h seeds the input;
// to12hText converts the input's value back to the stored format on save.
function to24h(t) {
  if (!t || typeof t !== "string") return "";
  const ampm = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])[Mm]\s*$/.exec(t);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (ampm[3].toLowerCase() === "p") h += 12;
    return `${String(h).padStart(2, "0")}:${ampm[2]}`;
  }
  const hhmm = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
  if (hhmm) return `${String(parseInt(hhmm[1], 10)).padStart(2, "0")}:${hhmm[2]}`;
  return "";
}
function to12hText(t) {
  if (!t || typeof t !== "string") return t;
  if (/[ap]m/i.test(t)) return t; // already 12-hour
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
  if (!m) return t;
  const h = parseInt(m[1], 10);
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${m[2]} ${ampm}`;
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
  background: BRIGHT,
  color: "#fff",
};

const summaryBar = {
  display: "flex",
  gap: 18,
  alignItems: "center",
  padding: "10px 14px",
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 12,
  marginBottom: 14,
  fontSize: 13,
  color: INK,
};

const dayColumn = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 12,
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
  borderRadius: 10,
  padding: 10,
};

const registrationBanner = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  padding: "10px 14px",
  border: "1px solid",
  borderRadius: 10,
  marginBottom: 14,
  fontSize: 13,
  fontWeight: 600,
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
  borderRadius: 12,
  padding: 28,
  textAlign: "center",
  color: MUTED,
  fontSize: 14,
};
