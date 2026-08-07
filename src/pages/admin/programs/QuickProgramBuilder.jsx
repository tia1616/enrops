// QuickProgramBuilder — the lean, curriculum-free program builder for self-serve
// registration operators (dance, martial arts, music, chess, etc.). Registration
// MVP, Chunk 3 slice 1.
//
// Unlike ProgramWizardNew (J2S's curriculum-based wizard), this asks for nothing
// but the essentials — name, price, spots, a simple repeating schedule — and gets
// the operator a LIVE, shareable registration link in one screen. No curriculum,
// no location prerequisite, no term picker.
//
// A few fields are set silently so the generated link actually works downstream
// (verified against the public catalog query in Home.jsx):
//   - term   = org.active_registration_term  (catalog + share link gate on this)
//   - status = 'open'                         (live immediately)
//   - runs_own_registration = false           (native enrops checkout)
//   - curriculum_id = null (no curriculum); program_location_id is REQUIRED
// The operator never sees "term" — it's enrichment-provider vocabulary, not theirs.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import ShareProgram from "../../../components/ShareProgram.jsx";
import ProgramSteps from "../../../components/ProgramSteps.jsx";
import { STRIPE_CONNECT_ESTIMATE_SENTENCE } from "../../../lib/stripeConnectEstimate.js";
import EnnieTip from "../../../components/EnnieTip.jsx";
import PlacesAutocomplete, { PlacesLookupHint } from "../../../components/PlacesAutocomplete.jsx";
import { ensureBrowserSafeImage, downscaleImage, extensionFor } from "../../../lib/heicConvert.js";
import { WaiverOrgName } from "../../../components/OrgNameInText.jsx";
import {
  useCancellationPolicy,
  cancellationCopy,
  cancellationAuthorship,
  CancellationPolicyBody,
  CancellationPolicyLoadError,
  CANCELLATION_POLICY_LABEL,
} from "../../../components/CancellationPolicyInline.jsx";
import { pixelWorkflowCreated } from "../../../lib/metaPixel.js";
import { PROGRAM_DESCRIPTION_MAX, describeDescriptionLength } from "../../../lib/programText.js";
import { GRADE_OPTIONS } from "../../../lib/grades.js";

// Match ProgramWizardNew's palette so the two builders read as one system.
// Monotonic where available. performance.now() is immune to the system clock
// being changed underneath us mid-build; Date.now() is the fallback for anything
// that lacks it.
function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
// Matches the RED used on the Payments screen, so "you've hit the limit" reads the
// same everywhere in the admin rather than being a new colour nobody has learned.
const RED = "#b53737";

// Title-Case — written straight to programs.day_of_week and compared with `=`
// on the public catalog. Lowercase silently breaks the match (see the note in
// ProgramWizardNew). Keep these Title-Case.
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Indexed by Date.getDay() (0 = Sunday). Used to warn when the chosen first
// class date's weekday doesn't match the selected day-of-week — the session
// dates derive from the DATE's weekday, so a mismatch silently meets on the
// wrong day.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Convert a native <input type="time"> value ("15:30", 24h) to the "3:30 PM" text
// the rest of the app stores + reads (catalog, checkout, matcher). Mirrors the
// same helper in ProgramWizardNew so both builders write start_time identically.
function toDbTime12h(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${min} ${ampm}`;
}

const labelStyle = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  // 16px MINIMUM: iOS Safari auto-zooms the page when a focused input is under
  // 16px. Operators build programs on their phones, so anything smaller makes
  // the builder lurch on every field tap.
  fontSize: 16,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  fontFamily: "inherit",
  background: "#fff",
};
const helpStyle = { fontSize: 12, color: MUTED, marginTop: 4 };

export default function QuickProgramBuilder() {
  // setOrg matters here: saving the onboarding answers writes to the DB and to
  // local state, but AdminLayout fetches `org` once per mount. Without telling
  // the shell, org.onboarding_completed_at stays null for the rest of the
  // session, so navigating away and clicking "New class" re-mounts this
  // component, re-seeds from the stale org, and asks the three questions all
  // over again - with the answers blank and the guardian/pickup checkboxes back
  // at their defaults, quietly switching on a question the operator had turned
  // off.
  const { org, setOrg } = useOutletContext();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState(""); // -> programs.short_description
  // null until there is something to say, so an empty field is not nagged at.
  const descCount = describeDescriptionLength(description);
  const [room, setRoom] = useState(""); // -> programs.room; optional, often unknown yet
  const [price, setPrice] = useState("");
  const [spots, setSpots] = useState("18");
  const [day, setDay] = useState("");
  const [startDate, setStartDate] = useState("");
  const [sessions, setSessions] = useState("8");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  // The three onboarding answers. Held locally as well as on the org row because
  // the org comes from the outlet and won't re-fetch after we save — without this
  // the operator would answer the questions and watch the form not change.
  const [profile, setProfile] = useState({
    venue_answer: org?.venue_answer ?? null,
    program_cadence: org?.program_cadence ?? null,
    default_age_min: org?.default_age_min ?? null,
    default_age_max: org?.default_age_max ?? null,
    onboarding_completed_at: org?.onboarding_completed_at ?? null,
  });
  useEffect(() => {
    if (!org) return;
    setProfile((p) => (p.onboarding_completed_at ? p : {
      venue_answer: org.venue_answer ?? null,
      program_cadence: org.program_cadence ?? null,
      default_age_min: org.default_age_min ?? null,
      default_age_max: org.default_age_max ?? null,
      onboarding_completed_at: org.onboarding_completed_at ?? null,
    }));
  }, [org]);

  // Who the class is for: GRADES or AGES, never both.
  //
  // Jessica: "afterschool is always done by grades. only camps are done by ages.
  // provider won't show both." This builder makes afterschool-shaped programs, so
  // grades lead - but ages stay one click away, because a dance or music studio
  // genuinely thinks in ages and one-off workshops often do too.
  //
  // The default is not blindly 'grades'. An org that answered the setup question
  // with an age range has told us how it thinks, and switching it to grades would
  // quietly drop a range it had been getting for free on every class. So: ages if
  // they gave us ages, grades otherwise. On prod today that means grades for
  // everyone - not one lean org has a default age range set, and Jeff completed
  // setup while leaving that question blank.
  const [audienceMode, setAudienceMode] = useState(
    () => (org?.default_age_min != null || org?.default_age_max != null ? "ages" : "grades"),
  );
  // Once the operator has picked, nothing may pick for them again. The seeding
  // effect below runs when the org row lands, which is after mount - without this
  // it could reach back over a deliberate choice.
  const audienceTouchedRef = useRef(false);
  function chooseAudienceMode(next) {
    audienceTouchedRef.current = true;
    setAudienceMode(next);
  }
  const [gradeMin, setGradeMin] = useState("");
  const [gradeMax, setGradeMax] = useState("");

  // Age range for THIS program, pre-filled from the answer above. Kept editable
  // per program: "we teach 5-12" is the usual case, "this one is teens only" is
  // the exception worth allowing without a trip to settings.
  const [ageMin, setAgeMin] = useState("");
  const [ageMax, setAgeMax] = useState("");
  useEffect(() => {
    setAgeMin((v) => (v === "" && profile.default_age_min != null ? String(profile.default_age_min) : v));
    setAgeMax((v) => (v === "" && profile.default_age_max != null ? String(profile.default_age_max) : v));
    // The org row arrives after mount, so the mode has to follow it - otherwise an
    // org WITH default ages still opens on grades and the prefill lands on a hidden
    // pair of fields. Only while the operator has not typed anything of their own.
    if (!audienceTouchedRef.current
      && (profile.default_age_min != null || profile.default_age_max != null)) {
      setAudienceMode("ages");
    }
  }, [profile.default_age_min, profile.default_age_max]);

  // Weekly series vs one-off workshop. An operator who told us they only run one
  // shape never sees the choice; one who runs both picks per program.
  const cadence = profile.program_cadence;
  const [mode, setMode] = useState(cadence === "one_off" ? "one_off" : "weekly");
  useEffect(() => {
    if (cadence === "one_off") setMode("one_off");
    else if (cadence === "weekly_term") setMode("weekly");
  }, [cadence]);
  const isOneOff = mode === "one_off";
  const showModeToggle = cadence === "both";

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [createdId, setCreatedId] = useState(null);

  // How long this build actually took. We refused to print a made-up "your first
  // program takes N minutes" in the step strip, so this is what earns the right
  // to print a real one later.
  //
  // The clock starts when the builder mounts and RESTARTS in resetForAnother:
  // building a second class in the same session would otherwise be recorded as
  // having taken since the page first opened, which would inflate the "every
  // program after the first" figure - the one the strip most wants to be small
  // and true.
  const startedAtRef = useRef(new Date().toISOString());
  // The DURATION is measured on a monotonic clock and sent as elapsed_ms.
  // started_at above is kept for context only and is no longer load-bearing:
  // comparing a browser timestamp against the server's now() meant an operator
  // whose laptop ran a couple of minutes fast had EVERY row rejected by a CHECK,
  // silently, from the one table that exists to collect them. performance.now()
  // also survives the user changing their system clock mid-build.
  const startedMsRef = useRef(nowMs());
  const createdThisSessionRef = useRef(0);
  // Photo (optional). Uploaded to the existing public org-assets bucket the
  // moment it's picked, so the operator sees the real image before saving.
  const [photoUrl, setPhotoUrl] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoErr, setPhotoErr] = useState("");

  // Phone-width layout. This file styles inline, so there is no stylesheet to put
  // a media query in - and the one place it matters is the Cancel/Create row: side
  // by side at 375px, "Create program & get link" wraps to two lines and both
  // buttons grow to 69px tall to match. Measured on staging at 375x812. Operators
  // build classes on their phones, so that is the case to get right, not the
  // exception. 480 rather than 375 so a wrapped label never happens at all.
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 480);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 480);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Is the org able to actually take money yet? The share link goes live the
  // moment a program is created, but Arielle's rule is "never a payment-less
  // live page" — so on success we nudge the operator to connect Stripe FIRST
  // (the WOW), before they share. null = still loading, don't nudge yet.
  const [chargesEnabled, setChargesEnabled] = useState(null);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("organizations")
        .select("stripe_charges_enabled")
        .eq("id", org.id)
        .maybeSingle();
      if (!cancelled) setChargesEnabled(!!data?.stripe_charges_enabled);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Locations the operator has set up (Programs -> Locations). One location
  // auto-selects (no need to pick when there's only one); 2+ shows a picker;
  // none means they must add one before this class can be created -- location
  // is REQUIRED, so an empty list is a blocker to clear, not a valid answer.
  const [locations, setLocations] = useState([]);
  // Whether that list could be READ at all. Kept apart from `locations.length`
  // because "you have none" and "we could not find out" are different facts,
  // and we say the first one out loud to the operator.
  const [locationsFailed, setLocationsFailed] = useState(false);
  const [locationId, setLocationId] = useState("");
  // A room number belongs to ONE building, so switching venue must not keep it.
  // Without this: pick Ainsworth, type "Room 12", realise it is the wrong school,
  // switch to Downtown Studio — the field stays filled and the class saves with a
  // room number from a different site, which then prints on the instructor's roster
  // email and sends them to the wrong door. An effect rather than a handler on the
  // select, because locationId is written in THREE places (the select, the inline
  // add-a-site, and the reset after a create) and a guard covering one of them is
  // the bug this codebase keeps re-learning.
  //
  // MUST live below the useState for locationId. It was first written up beside the
  // `room` state ~100 lines earlier, where `locationId` is still in the temporal
  // dead zone: the dependency array is evaluated during render, so the component
  // threw "Cannot access 'P' before initialization" and the whole builder rendered
  // as a BLANK PAGE. npm run build and the unit tests both passed - it is a runtime
  // error only, caught by loading the real page.
  useEffect(() => { setRoom(""); }, [locationId]);
  // Does this org already have programs? Decides whether the first-class
  // questions are appropriate. null = not counted yet (never assume either way).
  const [programCount, setProgramCount] = useState(null);
  // The count could not be established at all (network rejection). Kept separate
  // from the count itself so the failure does not have to masquerade as a value.
  const [countFailed, setCountFailed] = useState(false);
  // Whether the Google address lookup could actually start. Drives honest copy
  // under the field instead of a box that silently does nothing.
  const [lookupDown, setLookupDown] = useState(false);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      // Re-arm for this org: a failure recorded for a previous org.id must not
      // decide what this one sees.
      setCountFailed(false);
      setLocationsFailed(false);

      // The two reads get their own try blocks on purpose. Sharing one meant a
      // failure of EITHER was recorded as the same state, so a dead count made
      // the locations list look empty and vice versa -- and "empty" is a claim
      // we put in front of the operator ("No locations yet"), not just an
      // internal flag. Note both previously destructured only `data`/`count`
      // and dropped `error` on the floor: supabase-js RESOLVES query errors, so
      // an RLS denial or a bad column never reached the catch at all and simply
      // read as "this org has nothing".
      try {
        const { data, error: locErr } = await supabase
          .from("program_locations")
          // address comes back so the picker can SHOW where the class actually
          // is. Selecting only id+name is why an operator who had just looked
          // an address up could not see it again anywhere on this screen.
          // district_id comes back so we can warn when the chosen location has
          // no district — its class dates then never skip no-school days, and
          // three of the four ways to create a location leave it unset. The
          // legacy free-text `district` comes back too: it still resolves
          // closures through the legacy calendar match, so a location carrying
          // one is NOT broken and must not be warned about.
          .select("id, name, address, district_id, district")
          .eq("organization_id", org.id)
          .order("name");
        if (cancelled) return;
        if (locErr) {
          setLocationsFailed(true);
        } else {
          const locs = data ?? [];
          setLocations(locs);
          if (locs.length === 1) setLocationId(locs[0].id);
        }
      } catch {
        if (!cancelled) setLocationsFailed(true);
      }

      try {
        const { count, error: cntErr } = await supabase
          .from("programs")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org.id);
        if (cancelled) return;
        if (cntErr) setCountFailed(true);
        else setProgramCount(count ?? 0);
      } catch {
        // Query errors arrive as cntErr above; reaching here means a genuine
        // network rejection (offline, DNS, CORS). Either way the count is
        // unknown, and both must land on the same state.
        // Left alone this leaves programCount null forever, and countPending
        // renders a bare "Loading..." off null -- a spinner that never resolves
        // and never says why, the same dead-feature class as the address lookup.
        //
        // Fall FORWARD to the builder, not back to the questions. Falling back
        // to 0 would mean a transient blip re-asks an established org to "set up
        // your first class" -- precisely the complaint this count exists to fix,
        // and Riverbend has 3 live programs. Skipping the questions for a
        // genuinely new org is the cheaper mistake: onboarding_completed_at is
        // still unset, so they get asked on the next load.
        if (!cancelled) setCountFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Inline "add a location" so a new op can set their venue right here instead
  // of detouring to the Locations tab. Writes to program_locations, then selects
  // it. Load-bearing now that location is required: this is what makes the
  // requirement always satisfiable without leaving the form.
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocName, setNewLocName] = useState("");
  const [newLocAddress, setNewLocAddress] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);
  const [locErr, setLocErr] = useState("");

  // Same gate the other location surfaces use: without a Maps key the widget
  // degrades to a plain input, so don't offer to fill in an address we can't find.
  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  // Called when the operator picks a place from the dropdown. Fills the canonical
  // name and the address — but never clobbers an address they already typed
  // themselves (they may have pasted it before clicking the suggestion). Mirrors
  // applyPlace in LocationsList so the two screens behave identically.
  function applyPlace({ name, address }) {
    if (name) setNewLocName(name);
    setNewLocAddress((prev) => (prev && prev.trim() ? prev : (address || prev)));
  }

  async function saveNewLocation() {
    const nm = newLocName.trim();
    if (!nm || savingLoc) return;
    setSavingLoc(true);
    setLocErr("");
    try {
      // program_locations.slug is NOT NULL + globally unique; generate one from
      // the name with a random suffix (mirrors LocationsList).
      const base = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "venue";
      const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const { data, error } = await supabase
        .from("program_locations")
        .insert({ organization_id: org.id, name: nm, address: newLocAddress.trim() || null, slug })
        // Read the address back too, so the just-added location shows its
        // address immediately instead of only after a page reload. district_id
        // comes back for the same reason the list read selects it — the
        // no-district warning must be right for a just-added location too (this
        // path doesn't set one, so it is always null here).
        .select("id, name, address, district_id, district")
        .single();
      if (error) throw error;
      setLocations((ls) => [...ls, { id: data.id, name: data.name, address: data.address, district_id: data.district_id ?? null, district: data.district ?? null }].sort((a, b) => a.name.localeCompare(b.name)));
      setLocationId(data.id);
      setAddingLocation(false);
      setNewLocName("");
      setNewLocAddress("");
    } catch (e) {
      setLocErr(e?.message ?? "Couldn't save that location.");
    } finally {
      setSavingLoc(false);
    }
  }

  const priceCents = Math.round(parseFloat(price || "0") * 100);
  const spotsNum = parseInt(spots || "0", 10);
  const sessionsNum = parseInt(sessions || "0", 10);
  const priceValid = price !== "" && Number.isFinite(priceCents) && priceCents >= 0;

  // Warn (don't block) when the first class date falls on a different weekday
  // than the selected day — the derived sessions follow the date, not the day.
  const firstDateWeekday = startDate ? WEEKDAY_NAMES[new Date(`${startDate}T00:00:00`).getDay()] : null;
  const dayMismatch = !isOneOff && !!(day && firstDateWeekday && firstDateWeekday !== day);

  // A one-off workshop has no day-of-the-week to choose — it happens on a date,
  // and the day follows from it. programs.day_of_week is NOT NULL and the public
  // catalog matches on it, so it is derived rather than left empty.
  const effectiveDay = isOneOff ? firstDateWeekday : day;
  const usingGrades = audienceMode === "grades";
  // parseInt, not Number(), and compared against "" first: grade K is 0, and every
  // shortcut here (`Number(x) || null`, `if (!min)`) silently deletes it.
  const ageMinNum = ageMin === "" ? null : parseInt(ageMin, 10);
  const ageMaxNum = ageMax === "" ? null : parseInt(ageMax, 10);
  const gradeMinNum = gradeMin === "" ? null : parseInt(gradeMin, 10);
  const gradeMaxNum = gradeMax === "" ? null : parseInt(gradeMax, 10);
  // Only the pair that is actually on screen can be wrong. An age range left
  // backwards in a hidden field must not block a save that never writes it.
  const ageRangeBackwards = !usingGrades
    && ageMinNum != null && ageMaxNum != null && ageMinNum > ageMaxNum;
  const gradeRangeBackwards = usingGrades
    && gradeMinNum != null && gradeMaxNum != null && gradeMinNum > gradeMaxNum;
  const audienceBackwards = ageRangeBackwards || gradeRangeBackwards;

  // The row behind the current pick, so the field can show its address rather
  // than just the name the <option> already carries.
  const selectedLocation = locations.find((l) => l.id === locationId) ?? null;

  // Location is REQUIRED, not optional. Every program families can register for
  // happens somewhere, and "somewhere" is on the receipt, the reminder and the
  // parent's calendar. Optional meant the picker could sit empty with nothing to
  // pick and no explanation -- a dead end we would otherwise have to paper over
  // with a coaching tooltip. Requiring it deletes that state instead of
  // explaining it. Always satisfiable: "+ Add a location" is right here, so an
  // operator with none can create one without leaving this form.
  const valid =
    name.trim() !== "" && priceValid && spotsNum >= 1 && !audienceBackwards &&
    (isOneOff ? !!startDate : !!day) && !!locationId;

  // ---- First-program onboarding ----------------------------------------
  //
  // Creating the first program IS the onboarding. Rather than a settings tour
  // nobody finishes, we ask three questions once, and each one changes the form
  // directly underneath it. Only ever shown to registration operators, and only
  // until they answer.
  const isLean = org?.instructor_pay_model === "enrops_platform";
  // An org that already has programs is demonstrably not setting up its FIRST
  // class, whatever onboarding_completed_at says. That column only landed in
  // 20260725d, so every org created before it is NULL forever and was being
  // asked the first-class questions on every single visit to the builder --
  // Riverbend has 3 live programs and still got "Let's set up your first class".
  // programCount is null until counted, so we show neither screen prematurely.
  const needsOnboarding =
    isLean && !profile.onboarding_completed_at && programCount === 0;
  // Still counting. If the count FAILED we stop waiting and fall through to the
  // builder (programCount stays null, so needsOnboarding is false) rather than
  // holding the operator on a spinner we know will never resolve.
  const countPending =
    isLean && !profile.onboarding_completed_at && programCount === null && !countFailed;

  const [ansVenue, setAnsVenue] = useState(profile.venue_answer ?? "");
  const [ansCadence, setAnsCadence] = useState(profile.program_cadence ?? "");
  const [ansAgeMin, setAnsAgeMin] = useState(profile.default_age_min != null ? String(profile.default_age_min) : "");
  const [ansAgeMax, setAnsAgeMax] = useState(profile.default_age_max != null ? String(profile.default_age_max) : "");
  const [askSecondGuardian, setAskSecondGuardian] = useState(true);
  const [askPickup, setAskPickup] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileErr, setProfileErr] = useState("");
  // The operator hasn't touched the pickup toggle yet, so answering "we go to
  // schools" is still allowed to set it for them.
  const [pickupTouched, setPickupTouched] = useState(false);

  // Going out to other people's sites is what makes dismissal and pickup
  // questions matter: the child leaves from somewhere the operator doesn't
  // control. A studio where parents walk in the door doesn't need them, and
  // asking anyway is the kind of clutter that makes a form feel like paperwork.
  useEffect(() => {
    if (pickupTouched) return;
    setAskPickup(ansVenue === "goes_to_sites" || ansVenue === "both");
  }, [ansVenue, pickupTouched]);

  // Waivers already exist — provisioning seeds them. The operator has just never
  // been shown them, which is why "do we even have a waiver?" is a question we
  // get. Naming them here is the whole fix.
  const [waivers, setWaivers] = useState([]);
  const [openWaiverId, setOpenWaiverId] = useState(null);
  // The cancellation policy is shown in the SAME box as the waivers, so it is
  // loaded alongside them rather than by a card of its own.
  const { policy, failed: policyFailed, retry: retryPolicy } = useCancellationPolicy(org?.id);
  // Every program this builder creates is runs_own_registration: false, so the
  // org flag alone decides whether families meet the policy at checkout.
  const policyCopy = cancellationCopy({
    usesEnropsRegistration: org?.uses_enrops_registration,
  });
  const [extraQuestions, setExtraQuestions] = useState([]);
  const [showInherited, setShowInherited] = useState(false);
  // Loaded for every lean operator, not just first-run: the returning-operator
  // line below summarises these in place rather than sending anyone to Settings
  // mid-build.
  useEffect(() => {
    if (!org?.id || !isLean) return;
    let cancelled = false;
    (async () => {
      const [{ data: wv }, { data: qs }] = await Promise.all([
        supabase
          .from("waivers")
          .select("id, name, required, content")
          .eq("organization_id", org.id)
          .eq("active", true)
          // Required first, so the one families can DECLINE doesn't lead a list
          // headed "They sign". Same order the waiver manager uses.
          .order("required", { ascending: false })
          .order("created_at"),
        supabase
          .from("custom_reg_fields")
          .select("label")
          .eq("organization_id", org.id)
          .eq("is_active", true)
          .order("sort_order"),
      ]);
      if (cancelled) return;
      setWaivers(wv ?? []);
      setExtraQuestions((qs ?? []).map((q) => q.label).filter(Boolean));
    })();
    return () => { cancelled = true; };
  }, [org?.id, isLean]);

  const ansAgeMinNum = ansAgeMin === "" ? null : parseInt(ansAgeMin, 10);
  const ansAgeMaxNum = ansAgeMax === "" ? null : parseInt(ansAgeMax, 10);
  const ansAgeBackwards = ansAgeMinNum != null && ansAgeMaxNum != null && ansAgeMinNum > ansAgeMaxNum;
  const profileValid = !!ansVenue && !!ansCadence && !ansAgeBackwards;

  async function saveProfile() {
    if (!profileValid || savingProfile) return;
    setSavingProfile(true);
    setProfileErr("");
    try {
      const patch = {
        venue_answer: ansVenue,
        program_cadence: ansCadence,
        default_age_min: ansAgeMinNum,
        default_age_max: ansAgeMaxNum,
        onboarding_completed_at: new Date().toISOString(),
      };
      const { error } = await supabase.from("organizations").update(patch).eq("id", org.id);
      if (error) throw error;

      // The standard questions they just confirmed. Same upsert shape the
      // registration-questions page uses (conflict on organization_id,field_key),
      // so the two surfaces can't fight over the same row.
      const standard = [
        { key: "guardian_secondary", label: "Second parent or guardian", on: askSecondGuardian, required: false, sort: 0 },
        { key: "dismissal_method", label: "How does your child leave?", on: askPickup, required: true, sort: 1 },
        { key: "authorized_pickup", label: "Besides the parent(s) listed in registration, who else is allowed to pick up your child?", on: askPickup, required: true, sort: 2 },
      ];
      for (const f of standard) {
        if (f.on) {
          const { error: e } = await supabase.from("custom_reg_fields").upsert({
            organization_id: org.id,
            standard_key: f.key,
            field_key: `std_${f.key}`,
            label: f.label,
            field_type: "standard",
            is_required: f.required,
            is_active: true,
            applies_to: "all",
            sort_order: f.sort,
          }, { onConflict: "organization_id,field_key" });
          if (e) throw e;
        } else {
          // Off means off, including for the row provisioning seeded. Update by
          // the same key we would have inserted, so this works whether or not a
          // row exists.
          const { error: e } = await supabase
            .from("custom_reg_fields")
            .update({ is_active: false })
            .eq("organization_id", org.id)
            .eq("field_key", `std_${f.key}`);
          if (e) throw e;
        }
      }

      setProfile((p) => ({ ...p, ...patch }));
      // Correct the shell's copy too, so the card doesn't come back.
      setOrg?.((o) => (o ? { ...o, ...patch } : o));
      // Answering swaps the questions for the (longer) builder form in place, so
      // the browser keeps whatever scroll offset the questions left behind and
      // drops the operator into the MIDDLE of a form they have not seen the top
      // of. Put them at the start of it.
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "auto" });
    } catch (e) {
      setProfileErr(e?.message ?? "Couldn't save that. Please try again.");
    } finally {
      setSavingProfile(false);
    }
  }

  // Upload the photo to org-assets. Mirrors BrandLogoSettings' logo/banner
  // upload exactly: the <org id>/ path prefix is what satisfies the bucket's
  // org_assets_org_admin_insert RLS policy. iPhone HEIC is converted first
  // (heic2any lazy-loads, so it costs nothing unless a HEIC is actually picked)
  // — operators building on a phone is the common case for this field.
  async function handlePhotoPick(file) {
    if (!file) return;
    setPhotoErr("");
    // Friendly pre-checks so the operator never sees a raw storage error.
    // 2 MB is the bucket's own limit; check BEFORE the round trip.
    setUploadingPhoto(true); // resizing happens before the network call, but it
                             // is the same wait from the operator's side
    const safe = await (async () => {
      try {
        // HEIC first (iPhone default), then shrink. Phone photos are routinely
        // 3-5 MB and far larger than anything we render, so without this the
        // 2 MB bucket cap rejects most of a camera roll and asks the operator
        // to go and resize a photo by hand.
        const browserSafe = await ensureBrowserSafeImage(file);
        return await downscaleImage(browserSafe);
      } catch {
        return file; // conversion failed — fall through to the checks below
      }
    })();
    if (!["image/jpeg", "image/png", "image/webp"].includes(safe.type)) {
      setUploadingPhoto(false);
      setPhotoErr("That file type isn't supported. Try a JPG, PNG, or WEBP.");
      return;
    }
    // Should now be unreachable for ordinary photos — kept as a real backstop
    // for the cases downscaling bails on (canvas blocked, decode failure).
    if (safe.size > 2 * 1024 * 1024) {
      setUploadingPhoto(false);
      setPhotoErr("We couldn't shrink that one enough. Try a different photo.");
      return;
    }
    // already true from the resize step above
    try {
      const path = `${org.id}/program-photos/${Date.now()}.${extensionFor(safe)}`;
      const { error: upErr } = await supabase.storage
        .from("org-assets")
        .upload(path, safe, { contentType: safe.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setPhotoUrl(pub.publicUrl);
    } catch (e) {
      setPhotoErr(e?.message ?? "Couldn't upload that photo.");
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleCreate() {
    if (!valid || submitting) return;
    setSubmitting(true);
    setErr("");
    try {
      const payload = {
        organization_id: org.id,
        // Stamp the org's active term so the program lands in the public catalog
        // and the share link resolves. Operator never picks this.
        term: org.active_registration_term,
        curriculum: name.trim(), // NOT NULL display name; no curriculum record
        curriculum_id: null,
        // Optional; NULL (not "") so the catalog card's `short_description &&`
        // guard treats "not written" as absent rather than rendering an empty line.
        short_description: description.trim() || null,
        program_location_id: locationId || null,
        // Optional on purpose, and NULL when blank. Jessica's constraint: "we set up
        // programs and open for registration before actually knowing the classroom #
        // often" - she is still waiting on several schools and Facilitron - so this
        // must never gate creating a class. It is here for the operator who DOES
        // already know, so they are not made to come back for one field.
        // Per-program, distinct from the venue-level default on the location; the
        // roster email prefers this and falls back to that.
        room: room.trim() || null,
        day_of_week: effectiveDay,
        start_time: startTime ? toDbTime12h(startTime) : null,
        end_time: endTime ? toDbTime12h(endTime) : null,
        first_session_date: startDate || null,
        session_count: isOneOff ? 1 : (sessionsNum >= 1 ? sessionsNum : 1),
        max_capacity: spotsNum,
        // Grades OR ages, never both, and EVERY ONE OF THESE FOUR IS WRITTEN
        // EXPLICITLY. programs.grade_min/grade_max default to 0 and 5 in the
        // database, so an insert that merely omits them stamps the row "Grades
        // K-5" - a school-year assumption inherited from J2S that nobody chose and
        // that a dance studio has no use for. Omitting the unused pair is not the
        // same as nulling it.
        //
        // age_format records WHICH question was answered, but only when there is
        // an answer: a program that states no range should not claim to be
        // grade-shaped. That keeps it honest for the editor that reads it back.
        age_min: usingGrades ? null : ageMinNum,
        age_max: usingGrades ? null : ageMaxNum,
        grade_min: usingGrades ? gradeMinNum : null,
        grade_max: usingGrades ? gradeMaxNum : null,
        age_format: usingGrades
          ? (gradeMinNum != null || gradeMaxNum != null ? "grade" : null)
          : (ageMinNum != null || ageMaxNum != null ? "age" : null),
        price_cents: priceCents,
        program_type: "standard",
        photo_url: photoUrl || null, // optional; NULL renders the no-image card
        runs_own_registration: false, // native enrops checkout
        status: "open", // live the moment it's created
      };
      const { data, error } = await supabase
        .from("programs")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      // Advertising conversion. This builder always writes status 'open', so
      // every successful save here is a live, customer-facing registration
      // workflow. Path 1 of 3 - see pixelWorkflowCreated.
      pixelWorkflowCreated();
      setCreatedId(data.id);
      recordBuildTiming(data.id);
      // This org now has one more program than it did at mount. Without this,
      // "Create another" brings the form back with programCount still 0 and the
      // strip greets a second program with "Your first program" - the exact
      // first-vs-repeat contrast the component exists to draw.
      //
      // AFTER recordBuildTiming on purpose. That call reads programCount from
      // this render's closure, so the order does not actually change was_first,
      // but keeping the read before the write means nobody has to prove that
      // again later.
      setProgramCount((c) => (typeof c === "number" ? c + 1 : c));
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Fire-and-forget. Deliberately NOT awaited and NOT inside the save's try
  // block: this is telemetry, and a failed metric write must never surface as an
  // error on a screen that is telling the operator their program is live. The
  // operator's next decision does not depend on it, which is the only reason a
  // quiet console warning is the right level here.
  function recordBuildTiming(programId) {
    // programCount is null when the count failed. was_first is NOT NULL, and a
    // guessed value would quietly corrupt the very split this table exists to
    // measure, so record nothing rather than something made up.
    // Belt AND braces. This is CALLED from inside the save's try block (the
    // program id it needs is scoped there), so anything that threw synchronously
    // out of here would be caught by that catch and shown to the operator as a
    // failed save - on a screen where the program was in fact created and is
    // live. They would retry and end up with a duplicate. A metric must never be
    // able to do that, so it swallows its own failures, including a rejected
    // promise as well as a returned error.
    try {
      if (programCount === null || programCount === undefined) return;
      const wasFirst = programCount === 0 && createdThisSessionRef.current === 0;
      createdThisSessionRef.current += 1;
      supabase
        .from("program_build_timings")
        .insert({
          organization_id: org.id,
          program_id: programId,
          was_first: wasFirst,
          started_at: startedAtRef.current,
          // The authoritative figure: start and finish read from the SAME
          // monotonic clock, so no amount of skew between this machine and the
          // server can make it nonsense or get the row rejected.
          elapsed_ms: Math.max(0, Math.round(nowMs() - startedMsRef.current)),
        })
        .then(({ error }) => {
          if (error) console.warn("[QuickProgramBuilder] build timing not recorded", error.message);
        })
        .catch((e) => console.warn("[QuickProgramBuilder] build timing not recorded", e?.message ?? e));
    } catch (e) {
      console.warn("[QuickProgramBuilder] build timing not recorded", e?.message ?? e);
    }
  }

  function resetForAnother() {
    // Restart the clock: the next class is a NEW build, and timing it from the
    // original page load is how the "every program after the first" number would
    // end up several minutes too big.
    startedAtRef.current = new Date().toISOString();
    startedMsRef.current = nowMs();
    setName("");
    // Must clear with the name: "add another class" that kept the previous
    // description would silently publish the wrong copy on the next class.
    setDescription("");
    setPrice("");
    setSpots("18");
    setDay("");
    setStartDate("");
    setSessions("8");
    setStartTime("");
    setEndTime("");
    setLocationId(locations.length === 1 ? locations[0].id : "");
    setPhotoUrl("");
    setPhotoErr("");
    setErr("");
    setCreatedId(null);
    // Back to the operator's usual ages rather than blank — the next class is
    // almost always for the same children.
    setAgeMin(profile.default_age_min != null ? String(profile.default_age_min) : "");
    setAgeMax(profile.default_age_max != null ? String(profile.default_age_max) : "");
    // Grades carry over for the same reason, and so does the grades-or-ages choice:
    // a provider who thinks in grades thinks in grades for the next class too, and
    // being asked to re-pick it 25 times is the kind of friction Jeff hit with the
    // term picker. There is no org-level default grade range to fall back to, so
    // the values themselves are simply kept as typed.

    // Room is per-CLASS, so it must clear. Ages carry over because the next class is
    // usually for the same children; a room number never is, and a stale one would
    // send an instructor to the wrong door.
    //
    // NOT redundant with the `useEffect(..., [locationId])` that also clears it. For a
    // single-location org this reset sets locationId to the value it ALREADY holds, so
    // React bails out, the effect never fires, and "add another class" would carry the
    // previous class's room number. The effect covers switching venue; this covers
    // building the next class at the same venue. Deleting either one reopens a case.
    setRoom("");
    if (cadence !== "both") setMode(cadence === "one_off" ? "one_off" : "weekly");
  }

  // Leaving the form without creating anything.
  //
  // "Dirty" is measured against what the form SEEDS ITSELF WITH, not against
  // blank. Ages pre-fill from the org's usual range, spots and sessions have
  // defaults, and a single-location org gets its one location auto-selected - so
  // comparing to "" would make an untouched form report itself dirty and confirm
  // on every cancel, which trains the operator to click through the one prompt
  // that is supposed to protect them.
  const seededAgeMin = profile.default_age_min != null ? String(profile.default_age_min) : "";
  const seededAgeMax = profile.default_age_max != null ? String(profile.default_age_max) : "";
  const seededLocationId = locations.length === 1 ? locations[0].id : "";
  const seededMode = cadence === "one_off" ? "one_off" : "weekly";
  const formIsDirty =
    name.trim() !== "" ||
    description.trim() !== "" ||
    room.trim() !== "" ||
    price.trim() !== "" ||
    day !== "" ||
    startDate !== "" ||
    startTime !== "" ||
    endTime !== "" ||
    photoUrl !== "" ||
    locationId !== seededLocationId ||
    ageMin !== seededAgeMin ||
    ageMax !== seededAgeMax ||
    // Grades have no org-level seed, so anything at all in them is the operator's.
    gradeMin !== "" ||
    gradeMax !== "" ||
    spots !== "18" ||
    sessions !== "8" ||
    mode !== seededMode ||
    // The inline "+ Add a site" sub-form. Its two inputs are the ONLY typed text on
    // this screen that lives outside the program fields, and an operator with no
    // locations yet types a venue name and a full street address into them before
    // anything else exists. Leaving them out meant Cancel threw that away in
    // silence, because every program field was still untouched.
    newLocName.trim() !== "" ||
    newLocAddress.trim() !== "";

  function handleCancel() {
    if (formIsDirty) {
      // Claims only the CLASS. The first draft said "nothing has been created yet",
      // which is false the moment an operator uses "+ Add a site" inline: that
      // inserts a real program_locations row before this form is ever submitted, and
      // it correctly survives the cancel. A message must not assert more than it
      // knows.
      const ok = window.confirm(
        "Leave without creating this class? The details you've typed will be lost.",
      );
      if (!ok) return;
    }
    navigate("/admin/programs");
  }

  // Guard: outlet not ready yet.
  if (!org) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  // Still counting this org's programs. Showing either screen now risks flashing
  // the wrong one and yanking the page out from under whoever is reading it.
  if (countPending && !createdId) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  // ---- First-program onboarding: three questions, asked once ----
  if (needsOnboarding && !createdId) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: INK, marginBottom: 6 }}>
          Let&rsquo;s set up your first class
        </div>
        <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.6, margin: "0 0 24px" }}>
          Three quick questions, so we can set things up the way you actually run
          them. You can change any of this later.
        </p>

        <div style={{ display: "grid", gap: 22 }}>
          <ChoiceQuestion
            label="Where do your classes happen?"
            value={ansVenue}
            onChange={setAnsVenue}
            options={[
              { value: "own_space", label: "At our own space", help: "A studio, gym, or center you run" },
              { value: "goes_to_sites", label: "We go out to schools or other sites", help: "You teach at someone else's place" },
              { value: "both", label: "A bit of both" },
            ]}
          />

          <ChoiceQuestion
            label="How do your classes usually run?"
            value={ansCadence}
            onChange={setAnsCadence}
            options={[
              { value: "weekly_term", label: "A weekly series", help: "Same day each week, over several weeks" },
              { value: "one_off", label: "One-off workshops", help: "A single day or session" },
              { value: "both", label: "A bit of both" },
            ]}
          />

          <div>
            <div style={{ ...labelStyle, fontSize: 14, marginBottom: 8 }}>What ages do you teach?</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, color: MUTED }}>Ages</span>
              <input
                style={{ ...inputStyle, width: 84 }}
                value={ansAgeMin}
                onChange={(e) => setAnsAgeMin(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                inputMode="numeric"
                placeholder="5"
                aria-label="Youngest age"
              />
              <span style={{ fontSize: 14, color: MUTED }}>to</span>
              <input
                style={{ ...inputStyle, width: 84 }}
                value={ansAgeMax}
                onChange={(e) => setAnsAgeMax(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                inputMode="numeric"
                placeholder="12"
                aria-label="Oldest age"
              />
            </div>
            <div style={helpStyle}>
              Families see this on your class page. Leave blank if it varies.
            </div>
            {ansAgeBackwards && (
              <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>
                The first age should be the younger one.
              </div>
            )}
          </div>

          {/* Already done for them. Shown, not asked — an operator who has never
              seen their own waiver assumes they don't have one. */}
          <div style={{ border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px", background: "#FBFBFB" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: INK, marginBottom: 8 }}>
              Already set up for you
            </div>
            <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: "0 0 10px" }}>
              Your registration form asks each family for the child&rsquo;s name and
              birth date, allergies and medical notes, an emergency contact, and
              the parent&rsquo;s contact details.
            </p>

            <CheckRow
              checked={askSecondGuardian}
              onChange={setAskSecondGuardian}
              label="Also ask for a second parent or guardian"
            />
            <CheckRow
              checked={askPickup}
              onChange={(v) => { setPickupTouched(true); setAskPickup(v); }}
              label="Ask how each child leaves, and who else can pick them up"
            />
            {askPickup && (ansVenue === "goes_to_sites" || ansVenue === "both") && !pickupTouched && (
              <div style={{ fontSize: 12, color: MUTED, margin: "2px 0 8px 26px", lineHeight: 1.5 }}>
                Turned on because you teach at other people&rsquo;s sites, where
                knowing who collects a child matters. Untick it if you don&rsquo;t need it.
              </div>
            )}

            {/* ONE box for everything families see. The cancellation policy used
                to sit in its own bordered block underneath, which still read as
                a separate announcement bolted beneath the waivers - from the
                operator's side it is one question, so it is one box, and the
                policy is named and bolded exactly like the waivers because it
                is the same kind of thing (Jessica, 2026-07-30).

                Every program this builder creates sets
                runs_own_registration: false, so the org flag alone decides the
                wording. Nothing here navigates: sending someone to the editor
                mid-build drops them out of a half-filled class with no way
                back. */}
            {(waivers.length > 0 || policy || policyFailed) && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}` }}>
                {/* Guarded, not just handed the arrays: with no waivers AND a
                    policy that failed to load there is nothing to name, and an
                    unguarded sentence renders the orphan word "Families." */}
                {(waivers.length > 0 || policy) && (
                  <div style={{ fontSize: 13, color: INK, lineHeight: 1.6 }}>
                    <FamiliesSeeSentence
                      waivers={waivers}
                      policy={policy}
                      policyCopy={policyCopy}
                    />
                  </div>
                )}
                {policy && (
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
                    {cancellationAuthorship(policy)}
                  </div>
                )}
                {policyFailed && (
                  <div style={{ marginTop: 4 }}>
                    <CancellationPolicyLoadError onRetry={retryPolicy} />
                  </div>
                )}
                {(waivers.length > 0 || policy) && (
                  <button
                    type="button"
                    onClick={() => setOpenWaiverId((id) => (id === "all" ? null : "all"))}
                    aria-expanded={openWaiverId === "all"}
                    style={{ marginTop: 6, background: "none", border: "none", color: BRIGHT, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                  >
                    {openWaiverId === "all" ? "Hide the wording" : "Read the wording"}
                  </button>
                )}
                {openWaiverId === "all" && (
                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    {waivers.map((w) => (
                      <div key={w.id}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 4 }}>
                          {w.name}{w.required === false ? " (families can decline this one)" : ""}
                        </div>
                        {/* Business name drawn bold inside the wording, so a
                            page of boilerplate reads at a glance as already
                            personalised rather than a generic template. */}
                        <div style={{ maxHeight: 160, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff", padding: 10, fontSize: 12, color: MUTED, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                          <WaiverOrgName content={w.content} orgName={org?.name} />
                        </div>
                      </div>
                    ))}
                    {policy && (
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 4 }}>
                          {CANCELLATION_POLICY_LABEL}
                        </div>
                        <CancellationPolicyBody policy={policy} orgName={org?.name} />
                      </div>
                    )}
                  </div>
                )}
                {/* Prominent, not muted grey: "can I change this?" is the
                    question this whole box provokes, and it was previously
                    answered twice in 12px grey - once here and once more inside
                    the expander. Said ONCE, in the operator's own colour. */}
                <div style={{ marginTop: 10, fontSize: 12.5, color: INK, fontWeight: 600, lineHeight: 1.5 }}>
                  You can change any of this any time in Settings, under Waivers &amp; policies.
                </div>
              </div>
            )}

            {org.email && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}`, fontSize: 13, color: INK, lineHeight: 1.6 }}>
                When a family replies to one of your emails, it goes to{" "}
                <strong style={{ wordBreak: "break-all" }}>{org.email}</strong>.
                {/* Deliberately not a link. Everything on this screen has to
                    keep them on this screen; changing the address is a Settings
                    job they can do any time, and saying where it lives is
                    enough. */}
                <span style={{ color: MUTED }}> You can change that later in Settings.</span>
              </div>
            )}
          </div>

          {profileErr && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b53737", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>
              {profileErr}
            </div>
          )}

          {/* Same trap as the form below it: one button, and it was the only way
              off the screen. Nothing here is saved until "Next", so leaving costs
              nothing and the questions come back next time.

              Ordered in the DOM for the same reason as the footer below: CSS
              `order` repaints without moving keyboard focus, so the tab order
              would disagree with what is on screen. */}
          {(() => {
            const nextButton = (
              <button
                onClick={saveProfile}
                disabled={!profileValid || savingProfile}
                style={{ ...primaryBtn, flex: 1, opacity: !profileValid || savingProfile ? 0.55 : 1, cursor: !profileValid || savingProfile ? "not-allowed" : "pointer" }}
              >
                {savingProfile ? "Saving…" : "Next: build my first class →"}
              </button>
            );
            const notNowButton = (
              <button
                type="button"
                onClick={() => navigate("/admin/programs")}
                disabled={savingProfile}
                style={{ ...secondaryBtn, flex: narrow ? 1 : "0 0 auto", opacity: savingProfile ? 0.55 : 1, cursor: savingProfile ? "not-allowed" : "pointer" }}
              >
                Not now
              </button>
            );
            return (
              <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: 10, alignItems: "stretch" }}>
                {narrow ? <>{nextButton}{notNowButton}</> : <>{notNowButton}{nextButton}</>}
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  // ---- Success: program is live, hand over the shareable link ----
  if (createdId) {
    // Arielle's rule: never a payment-less live page. If Stripe isn't connected
    // yet, lead with that step (the WOW) and dim the share link until it is.
    const notConnected = chargesEnabled === false;
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
        {/* Honest state: with Stripe not connected the page exists but can't take
            money, so "live" overstates it — and it directly contradicted the
            "One step left: connect Stripe" panel right below. Say "almost live"
            until charges are enabled. `notConnected` is only true when we KNOW
            charges are off (=== false), so an unresolved check never downgrades
            the wording for an operator who is actually connected. */}
        <div style={{ fontSize: 22, fontWeight: 700, color: INK, marginBottom: 8 }}>
          {notConnected ? "Your program is almost live." : "Your program is live."}
        </div>

        {/* Always 3 here, and it needs no branching. Info and Publish are both
            done, so step 3 is either "Connect Stripe" in progress (when that step
            exists) or one past the end, meaning all done. The old version threaded
            notConnected through the first-program branch only and hardcoded 3 for
            everyone else, which ticked BOTH pips and said "it's live" directly
            above "One step left: connect Stripe". */}
        {isLean && (
          <ProgramSteps count={programCount} chargesEnabled={chargesEnabled} current={3} />
        )}

        {notConnected ? (
          <>
            <div style={{ background: "#EEEDFE", border: "1px solid #CECBF6", borderRadius: 12, padding: "16px 18px", marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#26215C", marginBottom: 4 }}>
                One step left: connect Stripe to get paid
              </div>
              <p style={{ fontSize: 13.5, color: "#3C3489", lineHeight: 1.55, margin: "0 0 12px" }}>
                {/* Was "land straight in your bank account… takes about 5 minutes".
                    Two problems, both fixed 2026-07-31: money settles in the
                    operator's own Stripe account and Stripe pays out to the bank
                    on its own schedule, so "straight in your bank" promised a
                    timeline we don't control; and the duration disagreed with the
                    MEASURED figure on the Payments screen (48s for an operator
                    who already has Stripe). One task quoted two different times
                    on two screens. */}
                Connect Stripe so families&rsquo; payments go straight into your own account. {STRIPE_CONNECT_ESTIMATE_SENTENCE} &mdash; then share your link.
              </p>
              <button onClick={() => navigate("/admin/finances")} style={primaryBtn}>
                Connect Stripe →
              </button>
            </div>
          </>
        ) : (
          <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>
            Families can register now. Share the link below — you'll see sign-ups show
            up as they come in.
          </p>
        )}

        {/* No share panel until Stripe is connected.
            It used to render dimmed to 60% with "share it once you're set up",
            which is a control that looks disabled but isn't - the panel still
            opened, and its dropdown landed on top of the buttons below it,
            which is the mess Jessica photographed. A greyed-out control also
            still reads as a feature you have.
            Consistent with the Programs page, which withholds the same three
            controls for the same reason: a link that can't take money is worth
            nothing until it can. */}
        {!notConnected && (
          <div style={{ marginBottom: 24 }}>
            <ShareProgram
              slug={org.slug}
              activeTerm={org.active_registration_term}
              align="left"
              program={{
                id: createdId,
                curriculum: name.trim(),
                status: "open",
                term: org.active_registration_term,
                runs_own_registration: false,
              }}
            />
          </div>
        )}

        {/* Where an operator learns their logo exists. Deliberately in BOTH
            states, not just the connected one: the not-connected branch has no
            share panel, so hanging this off the panel would mean the operator
            who most needs setup help never sees it. Kept to one quiet line so it
            never competes with "One step left: connect Stripe" above. */}
        <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: "0 0 20px" }}>
          Want your own logo on the page families see?{" "}
          <button
            type="button"
            onClick={() => navigate("/admin/branding")}
            style={{
              background: "none", border: "none", padding: 0, font: "inherit",
              color: BRIGHT, fontWeight: 600, cursor: "pointer", textDecoration: "underline",
            }}
          >
            Add it in Settings
          </button>{" "}
          any time.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button onClick={resetForAnother} style={primaryBtn}>
            Create another
          </button>
          <button
            onClick={() => navigate("/admin/programs")}
            style={{ ...primaryBtn, background: "#fff", color: BRIGHT, border: `1px solid ${RULE}` }}
          >
            Back to programs
          </button>
        </div>
      </div>
    );
  }

  // ---- The lean form ----

  // Held as elements so the two footer orders (Cancel|Create on a wide screen,
  // Create above Cancel on a phone) can be emitted in real DOM order without
  // writing the markup twice. See the note at the footer for why CSS `order`
  // was the wrong tool.
  const createButton = (
    <button
      onClick={handleCreate}
      disabled={!valid || submitting}
      style={{ ...primaryBtn, flex: 1, opacity: !valid || submitting ? 0.55 : 1, cursor: !valid || submitting ? "not-allowed" : "pointer" }}
    >
      {submitting ? "Creating…" : "Create program & get link"}
    </button>
  );
  const cancelButton = (
    <button
      type="button"
      onClick={handleCancel}
      disabled={submitting}
      style={{ ...secondaryBtn, flex: narrow ? 1 : "0 0 auto", opacity: submitting ? 0.55 : 1, cursor: submitting ? "not-allowed" : "pointer" }}
    >
      Cancel
    </button>
  );

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      {/* The ONE tip on this screen, at the title - same placement rule as every
          other page. Deliberately not a fee explainer (that lives on Payments,
          where the fee does) and not a sprinkle through the form: during a first
          run, anything important enough to explain should be said in the copy,
          not hidden behind a click a first-timer will not go looking for. What a
          "?" is genuinely good for here is the question the copy cannot answer
          without bloating every field - whether any of this is permanent. */}
      <div style={{ fontSize: 22, fontWeight: 700, color: INK, marginBottom: 4, display: "flex", alignItems: "center", gap: 2 }}>
        Create a program
        <EnnieTip title="Can I change this later?">
          Yes &mdash; the name, price, times and dates can all be edited after you
          publish. Families who already registered keep the price they paid.
        </EnnieTip>
      </div>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.55, margin: "0 0 20px" }}>
        The essentials only. You'll get a shareable registration link the moment
        you save.
      </p>

      {/* Lean only. A legacy operator has had Stripe connected for years, so a
          strip whose third step is "Connect Stripe" would be describing a road
          they finished long ago. */}
      {isLean && <ProgramSteps count={programCount} chargesEnabled={chargesEnabled} current={1} />}

      <div style={{ display: "grid", gap: 18 }}>
        {/* Every class after the first inherits the questions and waivers set
            during onboarding. Saying so once, quietly, is the difference between
            "it just works" and "did it ask them anything?" */}
        {/* Shows what will be asked, IN PLACE. This used to be a "Change" link
            straight to Settings, which threw an operator out of a half-filled
            class with no route back - the same trap as the onboarding card's
            waiver link. Nothing here navigates: the answer to "what do these
            say?" is shown, and the answer to "how do I change them?" is a
            sentence, because Settings is thirty seconds away once the class is
            saved. */}
        {/* `|| programCount > 0` closes a hole between this panel and the
            first-run card above. The card needs programCount === 0 and this
            panel needed the onboarding flag, so a lean org with programs but a
            NULL flag matched NEITHER and saw no waiver summary and no
            cancellation policy at all. That state is reachable: the column only
            landed in 20260725d, so every org created before it is NULL forever,
            and any program created outside this builder leaves it NULL with a
            non-zero count. The two conditions stay mutually exclusive (the card
            requires a zero count), so nothing renders twice, and programCount is
            null until counted, so a failed count falls back to the old
            behaviour rather than flashing the panel on. */}
        {isLean && (profile.onboarding_completed_at || programCount > 0) && (
          <div style={{ fontSize: 13, color: MUTED, background: "#FBFBFB", border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span>Using your usual questions and waivers.</span>
              <button
                type="button"
                onClick={() => setShowInherited((v) => !v)}
                aria-expanded={showInherited}
                style={{ background: "none", border: "none", color: BRIGHT, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >
                {showInherited ? "Hide" : "See what that means"}
              </button>
            </div>
            {showInherited && (
              <div style={{ marginTop: 8, lineHeight: 1.6 }}>
                <div>
                  <strong style={{ color: INK }}>Families are asked for</strong> their child&rsquo;s name and
                  birth date, allergies and medical notes, an emergency contact, and the parent&rsquo;s
                  contact details
                  {extraQuestions.length > 0 && <>, plus: {extraQuestions.join(", ")}</>}.
                </div>
                {(waivers.length > 0 || policy) && (
                  <div style={{ marginTop: 4 }}>
                    {/* Same one-box treatment as the first-run card: the policy
                        is named and bolded alongside the waivers rather than
                        arriving in a block of its own underneath.

                        Split the same way, for the same reason - a family only
                        signs these if they register through enrops, while the
                        policy is published publicly either way. Rolling both
                        into one "They see ..." list quietly applied the wrong
                        qualifier to each half. */}
                    {waivers.length > 0 && (
                      <>
                        <strong style={{ color: INK }}>They sign</strong>{" "}
                        {waivers.map((w, i) => (
                          <span key={w.id}>
                            {i > 0 && (i === waivers.length - 1 ? " and " : ", ")}
                            <strong style={{ color: INK }}>{w.name}</strong>
                          </span>
                        ))}
                        , if you run registration through enrops.{" "}
                      </>
                    )}
                    {policy && (
                      <>
                        {/* "also" only when something preceded it. */}
                        <strong style={{ color: INK }}>
                          {waivers.length > 0 ? "They also read" : "They read"}
                        </strong>{" "}
                        your{" "}
                        <strong style={{ color: INK }}>{CANCELLATION_POLICY_LABEL}</strong>.{" "}
                      </>
                    )}
                    {/* Naming the documents without letting anyone read them is
                        half an answer - same expander as the first-run card,
                        and it opens in place for the same reason. */}
                    <button
                      type="button"
                      onClick={() => setOpenWaiverId((id) => (id === "inherited" ? null : "inherited"))}
                      aria-expanded={openWaiverId === "inherited"}
                      style={{ background: "none", border: "none", color: BRIGHT, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                    >
                      {openWaiverId === "inherited" ? "Hide the wording" : "Read the wording"}
                    </button>
                  </div>
                )}
                {openWaiverId === "inherited" && (
                  <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
                    {waivers.map((w) => (
                      <div key={w.id}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 4 }}>
                          {w.name}{w.required === false ? " (families can decline this one)" : ""}
                        </div>
                        <div style={{ maxHeight: 160, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff", padding: 10, fontSize: 12, color: MUTED, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                          <WaiverOrgName content={w.content} orgName={org?.name} />
                        </div>
                      </div>
                    ))}
                    {policy && (
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 4 }}>
                          {CANCELLATION_POLICY_LABEL}
                        </div>
                        <CancellationPolicyBody policy={policy} orgName={org?.name} />
                      </div>
                    )}
                  </div>
                )}
                {/* A returning operator who never opened this still hasn't read
                    the promise made in their name, so the authorship line
                    stays outside the expander. */}
                {policy && (
                  <div style={{ marginTop: 4, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
                    {cancellationAuthorship(policy)}
                  </div>
                )}
                {policyFailed && (
                  <div style={{ marginTop: 4 }}>
                    <CancellationPolicyLoadError onRetry={retryPolicy} />
                  </div>
                )}
                {/* Bolded: this is the instruction, not commentary. It's the
                    answer to the question the whole panel provokes. */}
                <div style={{ marginTop: 6, color: INK, fontWeight: 600 }}>
                  To change any of it, finish this class first — it&rsquo;s all in Settings, under
                  Registration questions and Waivers &amp; policies.
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <label style={labelStyle} htmlFor="qpb-name">Program name</label>
          <input
            id="qpb-name"
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Beginner Ballet, Tuesdays"
            maxLength={120}
          />
        </div>

        {/* Description. programs.short_description already existed and already
            renders on the registration page, but only the FULL-NAV builder
            (ProgramWizardNew) ever collected it - so a lean operator had no way
            to describe a class at all, and their catalog cards showed a bare
            name. 91 of 95 prod programs have one; the lean org that asked for
            this had 0 of 4. Optional on purpose: it must never block creating a
            class. */}
        <div>
          <label style={labelStyle} htmlFor="qpb-description">Description (optional)</label>
          <textarea
            id="qpb-description"
            style={{ ...inputStyle, minHeight: 120, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What families should know - what they'll learn, what to bring, who it's for."
            maxLength={PROGRAM_DESCRIPTION_MAX}
          />
          {/* The cap USED to be a bare maxLength={600} with nothing on screen about
              it, so an operator typed past the end and the browser silently dropped
              the rest - Jeff wrote five descriptions and every one stopped dead at
              599 characters. A limit the writer cannot see is the actual defect, so
              the counter is not decoration. */}
          <div style={helpStyle}>
            Shown to families on your registration page, under the class name.
            Line breaks are kept, so you can write more than one paragraph.
          </div>
          {/* Its OWN line, not the tail of the help sentence. Inline, it read as
              "...more than one paragraph. 4 characters." - an unfinished sentence
              rather than a count. Jessica found that on prod. */}
          {descCount && (
            <div style={{ ...helpStyle, marginTop: 2, color: descCount.atLimit ? RED : MUTED, fontWeight: descCount.atLimit ? 600 : 400 }}>
              {descCount.text}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="qpb-price">Price</label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 12, top: 10, color: MUTED, fontSize: 15 }}>$</span>
              <input
                id="qpb-price"
                style={{ ...inputStyle, paddingLeft: 24 }}
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                placeholder="0.00"
              />
            </div>
          </div>
          <div>
            <label style={labelStyle} htmlFor="qpb-spots">Spots</label>
            <input
              id="qpb-spots"
              style={inputStyle}
              value={spots}
              onChange={(e) => setSpots(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              placeholder="18"
            />
          </div>
        </div>

        <div>
          <label style={labelStyle} htmlFor="qpb-photo">Photo <span style={{ fontWeight: 400, color: "#6b6b6b" }}>(optional)</span></label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {photoUrl && (
              <img
                src={photoUrl}
                alt="Program photo preview"
                style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, border: `1px solid ${RULE}` }}
              />
            )}
            <div>
              <input
                id="qpb-photo"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; handlePhotoPick(f); }}
                disabled={uploadingPhoto}
                style={{ fontSize: 14 }}
              />
              <div style={{ fontSize: 12, color: "#6b6b6b", marginTop: 4 }}>
                {uploadingPhoto
                  ? "Adding your photo…"
                  : photoUrl
                  ? "Looks good. Pick another to replace it."
                  : "A photo makes your class stand out to families. Straight from your camera roll is fine — we'll resize it."}
              </div>
              {photoUrl && !uploadingPhoto && (
                <button
                  type="button"
                  onClick={() => { setPhotoUrl(""); setPhotoErr(""); }}
                  style={{ marginTop: 6, background: "none", border: "none", color: BRIGHT, fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>
          {photoErr && <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>{photoErr}</div>}
        </div>

        <div>
          {/* The word changes with the answer: an operator with their own studio
              thinks "where we teach", one who drives to schools thinks "which
              site". Same field, their vocabulary. */}
          <label style={labelStyle} htmlFor="qpb-location">
            {profile.venue_answer === "goes_to_sites" ? "Which site? *" : "Location *"}
          </label>
          {addingLocation ? (
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, background: "#FBFBFB" }}>
              {/* The lookup belongs on the NAME field, not the address field —
                  an operator types where they teach, not its street address, and
                  expects the address to appear. This mirrors LocationsList and
                  AddSchoolModal, which both put PlacesAutocomplete on the name;
                  this screen had it on the address alone, so typing a venue name
                  produced no suggestions and nothing ever autofilled. */}
              {placesEnabled ? (
                <PlacesAutocomplete
                  value={newLocName}
                  onChange={setNewLocName}
                  onSelect={applyPlace}
                  onLookupUnavailable={setLookupDown}
                  placeholder="Location name (e.g. Downtown Studio)"
                  style={{ ...inputStyle, marginBottom: 4 }}
                  // Both of these existed on the plain <input> this replaced and
                  // were lost in the swap: without maxLength the name is
                  // unbounded into a `text` column, and without autoFocus the
                  // operator has to click again into the very field the form was
                  // opened for.
                  maxLength={80}
                  autoFocus
                />
              ) : (
                <input
                  style={{ ...inputStyle, marginBottom: 4 }}
                  value={newLocName}
                  onChange={(e) => setNewLocName(e.target.value)}
                  placeholder="Location name (e.g. Downtown Studio)"
                  maxLength={80}
                  autoFocus
                />
              )}
              {/* Never a box that silently does nothing: say whether the lookup
                  is working. Copy lives in PlacesAutocomplete so all four
                  surfaces say the same thing. */}
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
                <PlacesLookupHint enabled={placesEnabled} down={lookupDown} />
              </div>
              <input
                style={inputStyle}
                value={newLocAddress}
                onChange={(e) => setNewLocAddress(e.target.value)}
                placeholder="Address (optional)"
              />
              {locErr && <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>{locErr}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" onClick={saveNewLocation} disabled={savingLoc || !newLocName.trim()} style={{ ...primaryBtn, opacity: savingLoc || !newLocName.trim() ? 0.55 : 1 }}>
                  {savingLoc ? "Saving…" : "Save location"}
                </button>
                <button type="button" onClick={() => { setAddingLocation(false); setNewLocName(""); setNewLocAddress(""); setLocErr(""); }} style={{ ...primaryBtn, background: "#fff", color: BRIGHT, border: `1px solid ${RULE}` }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* "No specific location" is gone: it was the opt-out that let a
                  program go live with nowhere to be. The remaining empty option
                  is a prompt, not a choice -- it cannot be submitted. */}
              {/* "No specific location" is gone: it was the opt-out that let a
                  program go live with nowhere to be. The remaining empty option
                  is a prompt, not a choice -- it cannot be submitted. Never
                  claim "none" when the read failed: the operator would believe
                  it and add a venue they already have. */}
              <select id="qpb-location" style={inputStyle} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">
                  {locationsFailed
                    ? "Couldn't load your locations"
                    : locations.length === 0
                      ? "No locations yet — add one below"
                      : "Choose where this class runs"}
                </option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {/* Was a 13px <span onClick> — no button semantics, no tap target,
                  invisible as an action on a phone. A real button at 44px, the
                  minimum touch size the mobile audit holds every control to. */}
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setAddingLocation(true)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    minHeight: 44, padding: "10px 16px",
                    background: "#fff", color: BRIGHT,
                    border: `1px solid ${BRIGHT}`, borderRadius: 8,
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  + {profile.venue_answer === "goes_to_sites" || profile.venue_answer === "both" ? "Add a site" : "Add a location"}
                </button>
              </div>
              {/* Four states, four sentences, and the load-failure one comes
                  first because it is the only one where we do NOT know what the
                  operator has. Telling them to "add one" here would have them
                  create a duplicate of a venue that already exists. */}
              {locationsFailed && (
                <div style={{ ...helpStyle, color: "#8a6d1f" }}>
                  Couldn't load your locations just now. Refresh the page before adding one, so you don't end up with a duplicate.
                </div>
              )}
              {!locationsFailed && locations.length === 0 && profile.venue_answer === "own_space" && (
                <div style={helpStyle}>
                  Add your space once and every class you build will use it.
                </div>
              )}
              {!locationsFailed && locations.length === 0 && (profile.venue_answer === "goes_to_sites" || profile.venue_answer === "both") && (
                <div style={helpStyle}>
                  Add each school or site you teach at — families pick from these when they register.
                </div>
              )}
              {!locationsFailed && locations.length > 0 && !locationId && (
                <div style={helpStyle}>
                  Pick where this class runs — families see it when they register.
                </div>
              )}
              {/* Once something IS picked, show its address. The picker only
                  ever showed a name, so an operator who had just looked an
                  address up had no way to confirm it was attached to the venue
                  they chose. Two states, because 2 of 66 prod locations have no
                  address and a blank line would read as "we lost it". */}
              {!locationsFailed && selectedLocation && (
                selectedLocation.address?.trim() ? (
                  <div style={helpStyle}>📍 {selectedLocation.address}</div>
                ) : (
                  <div style={{ ...helpStyle, color: "#8a6d1f" }}>
                    No address saved for this location yet — families won't see one. Add it under Programs → Locations.
                  </div>
                )
              )}
              {/* Classroom, optional, and only once a location is chosen — "Room 12"
                  means nothing without knowing which building. Sits AFTER the venue's
                  own address/add-a-site controls rather than between them, so the
                  location block stays one thing and this reads as the next question.
                  Deliberately NOT required. Jessica: "we set up programs and open for
                  registration before actually knowing the classroom # often" — she is
                  still waiting on several schools and Facilitron. So this is for the
                  operator who already knows, and it stays editable afterwards on the
                  Scheduled Programs panel for everyone else. */}
              {locationId && (
                <div style={{ marginTop: 12 }}>
                  <label style={labelStyle} htmlFor="qpb-room">Classroom or room number (optional)</label>
                  <input
                    id="qpb-room"
                    type="text"
                    style={inputStyle}
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                    placeholder="e.g. Room 12, Gym B, Music Room"
                    maxLength={60}
                  />
                  <div style={helpStyle}>
                    Appears on instructor rosters. Leave it blank if you don&rsquo;t know yet
                    &mdash; you can add it later from Scheduled programs.
                  </div>
                </div>
              )}
              {/* A location with no district has no school calendar, so this
                  class's dates will NOT skip no-school days. Three of the four
                  ways to create a location (this inline add, bulk import, the
                  program builder) leave the district unset, so say it here —
                  where the class is being built — not only on the Locations
                  page. Silent is the failure mode we're removing. */}
              {!locationsFailed && selectedLocation && !selectedLocation.district_id
                && !(selectedLocation.district && String(selectedLocation.district).trim()) && (
                <div style={{ ...helpStyle, color: "#8a6d1f" }}>
                  This location has no district yet, so these class dates won&rsquo;t skip no-school days.
                  Set its district on the Locations page.
                </div>
              )}
            </>
          )}
        </div>

        {/* Operators who told us they run both shapes choose per class. Everyone
            else just gets the fields that match how they work. */}
        {showModeToggle && (
          <div>
            <div style={labelStyle}>Is this a weekly series or a one-off?</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[{ v: "weekly", l: "Weekly series" }, { v: "one_off", l: "One-off workshop" }].map((o) => {
                const on = mode === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setMode(o.v)}
                    style={{
                      padding: "9px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                      fontSize: 14, fontWeight: 600,
                      background: on ? "#EEEDFE" : "#fff",
                      color: on ? "#26215C" : INK,
                      border: `1px solid ${on ? BRIGHT : RULE}`,
                    }}
                  >
                    {o.l}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!isOneOff && (
          <div>
            <label style={labelStyle} htmlFor="qpb-day">Day of the week</label>
            <select
              id="qpb-day"
              style={inputStyle}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            >
              <option value="">Choose a day…</option>
              {DAYS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <div style={helpStyle}>Which day the class meets each week.</div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="qpb-start-time">Start time</label>
            <input
              id="qpb-start-time"
              type="time"
              style={inputStyle}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="qpb-end-time">End time</label>
            <input
              id="qpb-end-time"
              type="time"
              style={inputStyle}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>

        {isOneOff ? (
          <div>
            <label style={labelStyle} htmlFor="qpb-start-date">Date</label>
            <input
              id="qpb-start-date"
              type="date"
              style={inputStyle}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <div style={helpStyle}>
              {firstDateWeekday
                ? `A single session on this ${firstDateWeekday}.`
                : "The day this workshop runs."}
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle} htmlFor="qpb-start-date">First class date</label>
              <input
                id="qpb-start-date"
                type="date"
                style={inputStyle}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <div style={helpStyle}>Optional.</div>
            </div>
            <div>
              <label style={labelStyle} htmlFor="qpb-sessions"># of classes</label>
              <input
                id="qpb-sessions"
                style={inputStyle}
                value={sessions}
                onChange={(e) => setSessions(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                placeholder="8"
              />
              <div style={helpStyle}>How many weekly sessions.</div>
            </div>
          </div>
        )}

        {/* Who it's for. ONE question with two vocabularies, not two questions -
            a class is described by grades or by ages, never both, so the toggle
            swaps the fields rather than adding a second row an operator could
            fill in twice. Optional either way: it must never block creating a
            class, and Jeff built 13 without stating one. */}
        <div>
          <label style={labelStyle}>
            Who it&rsquo;s for <span style={{ fontWeight: 400, color: MUTED }}>(optional)</span>
          </label>
          {/* Two small buttons rather than a select: it is a choice between two
              things, and a dropdown to pick between two is a click too many. */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {[["grades", "Grades"], ["ages", "Ages"]].map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => chooseAudienceMode(val)}
                aria-pressed={audienceMode === val}
                style={{
                  padding: "6px 14px", borderRadius: 999, fontSize: 13, fontWeight: 600,
                  fontFamily: "inherit", cursor: "pointer",
                  border: `1px solid ${audienceMode === val ? BRIGHT : RULE}`,
                  background: audienceMode === val ? BRIGHT : "#fff",
                  color: audienceMode === val ? "#fff" : INK,
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
          {usingGrades ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, color: MUTED }}>Grades</span>
              {/* A select, not a text box: K is not a number, and typing "K" into
                  a numeric field is the sort of thing that silently becomes 0 or
                  nothing. The option list is the shared one - it used to be
                  written four different ways, one of which stopped at 6th. */}
              <select
                style={{ ...inputStyle, width: 96 }}
                value={gradeMin}
                onChange={(e) => setGradeMin(e.target.value)}
                aria-label="Lowest grade for this class"
              >
                <option value="">—</option>
                {GRADE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span style={{ fontSize: 14, color: MUTED }}>to</span>
              <select
                style={{ ...inputStyle, width: 96 }}
                value={gradeMax}
                onChange={(e) => setGradeMax(e.target.value)}
                aria-label="Highest grade for this class"
              >
                <option value="">—</option>
                {GRADE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, color: MUTED }}>Ages</span>
            <input
              style={{ ...inputStyle, width: 84 }}
              value={ageMin}
              onChange={(e) => setAgeMin(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              inputMode="numeric"
              placeholder="5"
              aria-label="Youngest age for this class"
            />
            <span style={{ fontSize: 14, color: MUTED }}>to</span>
            <input
              style={{ ...inputStyle, width: 84 }}
              value={ageMax}
              onChange={(e) => setAgeMax(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              inputMode="numeric"
              placeholder="12"
              aria-label="Oldest age for this class"
            />
          </div>
          )}
          <div style={helpStyle}>Shown to families on your class page.</div>
          {ageRangeBackwards && (
            <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>
              The first age should be the younger one.
            </div>
          )}
          {gradeRangeBackwards && (
            <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>
              The first grade should be the lower one.
            </div>
          )}
        </div>

        {dayMismatch && (
          <div style={{ background: "#FDF6E3", border: "1px solid #F0D48A", color: "#8a5a00", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.5 }}>
            Heads up: your first class date is a <strong>{firstDateWeekday}</strong>, but you chose <strong>{day}</strong>.
            Classes will meet on {firstDateWeekday}s. Pick a {day} date, or change the day to match.
          </div>
        )}

        {err && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b53737", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>
            {err}
          </div>
        )}

        {/* Cancel BESIDE Create, not instead of it. Until now the only button on
            this form was the irreversible one: there was no cancel, no back, no
            discard, and the only navigate("/admin/programs") was on the SUCCESS
            screen - i.e. reachable only after the class was already live. The
            escape was the sidebar, which on a phone is behind a menu. Jessica hit
            this trying the builder on prod, where publishing is not a rehearsal. */}
        {/* On a phone they STACK, primary on top, each full width - the label does
            not fit beside a Cancel at 375px and wrapping it made both buttons 69px
            tall. On a wider screen they share one row, Cancel first so the
            irreversible button keeps the position it has always had.

            ORDERED IN THE DOM, not with CSS `order`. The first version used
            order:0/1 to flip them, which moves only the PAINT: keyboard focus and
            screen readers still follow source order, so tabbing out of the last
            field landed on the publish button while the eye was on a Cancel to its
            left. On the one control here that cannot be undone, "what you tab to"
            and "what you see" have to be the same button. */}
        <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: 10, alignItems: "stretch" }}>
          {narrow ? (
            <>
              {createButton}
              {cancelButton}
            </>
          ) : (
            <>
              {cancelButton}
              {createButton}
            </>
          )}
        </div>
        {/* Says what the button does. This builder writes status "open" with the
            org's active term, which is exactly what the public catalog gates on, so
            the class is live the moment it saves - there is no draft and no preview
            here. Jeff wants that immediacy; the problem was only that nothing on
            screen said so.

            TWO SENTENCES, because "your registration page" is not a place every
            tenant has. Two prod orgs (Mrs. Richelle, Shoreview Chess) run
            uses_enrops_registration = false - their families register elsewhere and
            never see an enrops page - which is the same trap `cancellationCopy` was
            written to escape. `=== true` and not `!== false`, matching that helper:
            the fallback has to be the sentence that is true in BOTH states, and
            "there is no draft" is the part Jessica actually needed to know. */}
        <div style={{ ...helpStyle, marginTop: -4, textAlign: "center" }}>
          {org?.uses_enrops_registration === true
            ? "This publishes the class to your registration page straight away."
            : "This creates the class straight away — there is no draft to review first."}
        </div>
      </div>
    </div>
  );
}

// A question answered by tapping one of three cards. Big targets rather than a
// dropdown: this is the first thing a new operator touches, often on a phone,
// and a <select> hides the choices behind an extra tap.
// Everything a family is shown, with each document drawn bold - waivers and the
// cancellation policy alike, because to the operator they are the same kind of
// thing.
//
// TWO SENTENCES, NOT ONE, because the two halves are true under DIFFERENT
// conditions and a single sentence cannot carry two different qualifiers.
// Waivers are only ever seen by a family registering through enrops, so that
// clause says so out loud (Jessica, 2026-07-30) - a provider who takes
// registrations elsewhere was previously told families sign documents those
// families never see. The policy clause does NOT take that qualifier: the
// policy is published publicly under their business name either way, and
// `cancellationCopy` already branches it on uses_enrops_registration.
//
// Each state is written out rather than assembled from a shared trunk with
// optional bits, so every one can be read aloud against the state that selects
// it. The no-waivers case is reachable the moment an operator deactivates their
// last waiver, and it takes `leadPrefixAlone` because "Families ALSO read" is a
// lie when the policy is the only thing named.
function FamiliesSeeSentence({ waivers, policy, policyCopy }) {
  const waiverSentence =
    waivers.length === 0 ? null : waivers.length === 1 ? (
      <>
        Families sign your <strong>{waivers[0].name}</strong> before they finish
        registering, if you run registration through enrops.
      </>
    ) : (
      <>
        Families sign{" "}
        {waivers.map((w, i) => (
          <span key={w.id}>
            {i > 0 && (i === waivers.length - 1 ? " and " : ", ")}
            <strong>{w.name}</strong>
          </span>
        ))}{" "}
        before they finish registering, if you run registration through enrops.
      </>
    );

  const policySentence = policy ? (
    <>
      {waiverSentence ? policyCopy.leadPrefix : policyCopy.leadPrefixAlone}
      <strong>{CANCELLATION_POLICY_LABEL}</strong>
      {policyCopy.leadSuffix}
    </>
  ) : null;

  return (
    <>
      {waiverSentence}
      {waiverSentence && policySentence ? " " : null}
      {policySentence}
    </>
  );
}

function ChoiceQuestion({ label, value, onChange, options }) {
  return (
    <div>
      <div style={{ ...labelStyle, fontSize: 14, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "grid", gap: 8 }} role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const selected = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.value)}
              style={{
                textAlign: "left",
                padding: "12px 14px",
                borderRadius: 10,
                cursor: "pointer",
                fontFamily: "inherit",
                background: selected ? "#EEEDFE" : "#fff",
                border: `1px solid ${selected ? BRIGHT : RULE}`,
                boxShadow: selected ? `inset 0 0 0 1px ${BRIGHT}` : "none",
              }}
            >
              <div style={{ fontSize: 14.5, fontWeight: 600, color: selected ? "#26215C" : INK }}>{o.label}</div>
              {o.help && <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>{o.help}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CheckRow({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, marginTop: 1, flex: "0 0 auto", accentColor: BRIGHT }}
      />
      <span style={{ fontSize: 13.5, color: INK, lineHeight: 1.5 }}>{label}</span>
    </label>
  );
}

const primaryBtn = {
  padding: "12px 20px",
  background: BRIGHT,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

// The way OUT. Quiet on purpose - it sits next to the irreversible button and
// must not compete with it - but a real button, not a text link, because it is
// the only exit from this form that is not the sidebar.
const secondaryBtn = {
  padding: "12px 20px",
  background: "#fff",
  color: INK,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};
