// Add or edit one camp session. Until this screen existed there was NO way to
// create a camp in the product at all - every one of the 51 SU26 rows went in by
// hand-written SQL, and the admin app could only ever read camp_sessions.
//
// WHY THIS IS THE CHUNK THAT CARRIES THE SEAT CAP. camp_sessions.max_capacity
// arrived in 20260923b, and a review of that migration found the cap would be
// permanently NULL - i.e. uncapped, i.e. the checkout gate would never fire -
// because nothing anywhere populated it. Creation is the only moment the number
// can be seeded, so it is seeded HERE, from curricula.class_size_max, exactly the
// way ProgramWizardNew seeds programs.max_capacity from the same column. Change
// that and camps oversell silently; the SU26 session that reached 17 children
// against a 14 cap is what that looks like.
//
// EVERY DEFAULT ON THIS FORM COMES FROM THE OPERATOR'S OWN DATA, never a literal.
// The times are read back from this org's most recent camp of the same kind, not
// hardcoded to J2S's 9-12 and 12:30-15:30. A second tenant runs different hours
// and must not have ours typed into their form.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { isUnset, GRADE_OPTIONS, rangeBackwards, rangeBackwardsMessage } from "../../../lib/grades.js";
import ModalShell from "../../../components/ModalShell.jsx";
import AddSchoolModal from "../schools/AddSchoolModal.jsx";
import FamiliesPayNote, { useOrgFeeConfig } from "../../../components/FamiliesPayNote.jsx";
import { pixelWorkflowCreated } from "../../../lib/metaPixel.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const DANGER = "#B3261E";

// "" / null / undefined -> NULL, anything else -> a number. Same shared isUnset
// the program wizard uses, so "not stated" means one thing across both builders.
const intOrNull = (v) => (isUnset(v) ? null : Number(v));

// The three session types camp_sessions_session_type_check allows. Listing them
// here rather than deriving them is deliberate: the CHECK constraint is the
// contract, and a value this form can produce that the constraint rejects is a
// save that fails at the database with a wall of SQL.
const SESSION_TYPES = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "full_day", label: "Full day" },
];

// camp_sessions.class_days stores lowercase day names, matching all 51 existing
// rows. Checked every reader before picking the spelling: the pay cron, the
// board's double-booking check and the refund proration helper all lowercase
// defensively, so case would not break pay or money. SchedulePrint's day-order
// sort is the one that does not normalise - it positions by indexOf against a
// lowercase list, so a capitalised day sorts to the front of the printed
// schedule. Cosmetic, but there is no reason to write the odd spelling.
const WEEKDAYS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
];

// camp_sessions_curriculum_category_check. Prefilled from the chosen curriculum's
// own category, which uses this same vocabulary - but curricula.category is
// NULLABLE, so an operator whose curriculum has no category still needs to pick
// one rather than hit a NOT NULL violation on save.
const CATEGORIES = [
  { value: "lego", label: "LEGO" },
  { value: "coding", label: "Coding" },
  { value: "robotics", label: "Robotics" },
];

const EMPTY = {
  location_id: "",
  room: "",
  week_num: "",
  session_type: "",
  curriculum_id: "",
  curriculum_category: "",
  start_time: "",
  end_time: "",
  class_days: WEEKDAYS.map((d) => d.value),
  // "grade" or "age" - the editor's MODE, not a claim about the camp. Mirrors the
  // program wizard, which defaults to grade and writes NULL for whichever pair is
  // not in use. Camps could only ever say ages before this, which made the
  // pricing sheet's "App Builders Camp, Grades 4 to 6" unsayable.
  age_format: "grade",
  // null, not 0: Kindergarten IS 0, so a truthiness check would delete it. See
  // isUnset in lib/grades.js - the one definition of "not stated" in the codebase.
  grade_min: null,
  grade_max: null,
  ages_min: "",
  ages_max: "",
  max_capacity: "",
  short_description: "",
  price_cents: null,
  early_bird_price_cents: null,
  early_bird_deadline: "",
  // false = we sell it. true = the partner or venue takes the registration and
  // we never put a checkout on it. The column existed on camp_sessions and
  // nothing ever set it; the other two arrived with this form.
  runs_own_registration: false,
  external_registration_url: "",
  list_in_public_catalog: false,
  notes: "",
};

// A Postgres `time` reads back as "09:00:00"; <input type="time"> wants "09:00".
function toTimeInput(t) {
  if (!t) return "";
  const m = /^(\d{2}):(\d{2})/.exec(String(t));
  return m ? `${m[1]}:${m[2]}` : "";
}

function centsToDollars(cents) {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export default function CampSessionForm({ org, orgId, cycle, session = null, onClose, onSaved }) {
  const isEdit = Boolean(session?.id);
  // The all-in price note reads the org's fee config by slug, the same way the
  // program wizard does, so the two screens cannot disagree about what a family
  // actually pays.
  const feeConfig = useOrgFeeConfig(org?.slug);

  const [form, setForm] = useState(EMPTY);
  // Which fields the operator has typed in themselves. A prefill must never
  // overwrite a value they chose - same rule the program wizard follows when a
  // curriculum seeds class size.
  const [touched, setTouched] = useState(() => new Set());
  const [prefilled, setPrefilled] = useState([]);

  const [locations, setLocations] = useState([]);
  const [curricula, setCurricula] = useState([]);
  // Districts and partners exist only to feed the inline "Add a site" modal, the
  // same one the program wizard opens. Non-blocking if they fail, but NOT
  // harmless: AddSchoolModal's District field is required and matches against
  // this list, so an empty list pushes the operator into creating a duplicate
  // district that dies on the unique index. Surfaced, not swallowed.
  const [districts, setDistricts] = useState([]);
  const [partners, setPartners] = useState([]);
  const [districtsWarning, setDistrictsWarning] = useState("");
  const [addingSite, setAddingSite] = useState(false);
  // Start/end times this org has actually used, per session type, so the form can
  // default without inventing hours for somebody else's business.
  const [timeDefaults, setTimeDefaults] = useState({});
  // Two independent loads - the pickers, and (when editing) the camp's own row.
  // One shared flag would let whichever finished first clear it and render the
  // form with empty dropdowns while the other was still in flight.
  const [loadingLists, setLoadingLists] = useState(true);
  const [loadingRow, setLoadingRow] = useState(Boolean(session?.id));
  const loading = loadingLists || loadingRow;
  // The camp as it was when this form opened, for the three fields the form
  // DERIVES rather than edits: the two dates (derived from the chosen week) and
  // the camp's display name (derived from the chosen curriculum). Null when
  // adding, because there is nothing to preserve.
  //
  // WHY THIS EXISTS. Re-reading the row stopped an edit blanking columns the
  // form never shows. It did NOT stop an edit overwriting fields the form
  // recomputes, and on prod that is most of them: 6 of 51 camps deliberately run
  // a partial week (a Mon/Wed camp whose ends_on is before its week's Friday),
  // and 44 of 51 carry a display name different from their curriculum's internal
  // title. Recomputing on every save silently rewrote both. So the stored value
  // wins unless the operator actually changed the field it is derived from.
  const [baseline, setBaseline] = useState(null);
  // How many instructors are already on this camp (proposed, confirmed,
  // published - anything not withdrawn). Gates moving it, below.
  const [assignedInstructors, setAssignedInstructors] = useState(0);
  // Children already registered for this camp. The move guard covers them too:
  // re-dating a camp 8 children are booked into changes the dates their families
  // were given, with nothing emailing them, and shifts the refund proration for
  // registrations already taken. 46 of 51 prod camps have registrations and 6 of
  // those have no instructor at all, so an instructor-only guard would simply
  // not fire for them.
  const [enrolledChildren, setEnrolledChildren] = useState(0);
  // True when a count could not be read, so the refusal message can say it is
  // being careful rather than claiming a number it does not have.
  const [moveLockUnknown, setMoveLockUnknown] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const weeks = useMemo(() => (Array.isArray(cycle?.weeks) ? cycle.weeks : []), [cycle]);

  function field(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
    setTouched((t) => new Set(t).add(name));
  }

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      setLoadingLists(true);
      setLoadError("");
      try {
        const [locRes, curRes, timeRes, distRes, partRes] = await Promise.all([
          supabase
            .from("program_locations")
            .select("id, name")
            .eq("organization_id", orgId)
            .order("name"),
          supabase
            .from("curricula")
            .select("id, name, category, class_size_max, age_range_min, age_range_max")
            .eq("organization_id", orgId)
            .eq("status", "published")
            .order("name"),
          // Most recent first; the first row per session_type wins below.
          supabase
            .from("camp_sessions")
            .select("session_type, start_time, end_time, starts_on")
            .eq("organization_id", orgId)
            .order("starts_on", { ascending: false }),
          supabase
            .from("districts")
            .select("id, name, district_type")
            .eq("organization_id", orgId)
            .order("name"),
          supabase
            .from("partners")
            .select("id, partner_name")
            .eq("organization_id", orgId)
            .order("partner_name"),
        ]);
        if (cancelled) return;
        if (locRes.error) throw locRes.error;
        if (curRes.error) throw curRes.error;
        // Non-blocking: without it the time fields simply start empty, which is a
        // worse form but not a broken one. Refusing to open the whole screen
        // because a convenience default could not load would be the bug.
        if (timeRes.error) console.warn("[CampSessionForm] time defaults unavailable:", timeRes.error.message);

        setLocations(locRes.data ?? []);
        setCurricula(curRes.data ?? []);
        setDistricts(distRes.data ?? []);
        setPartners(partRes.data ?? []);
        if (distRes.error) {
          console.warn("[CampSessionForm] districts unavailable:", distRes.error.message);
          setDistrictsWarning("Your districts could not be loaded, so the district picker below is empty. Reload before adding a site, or you may create a duplicate district.");
        }

        const byType = {};
        for (const row of timeRes.data ?? []) {
          if (!byType[row.session_type]) {
            byType[row.session_type] = {
              start_time: toTimeInput(row.start_time),
              end_time: toTimeInput(row.end_time),
            };
          }
        }
        setTimeDefaults(byType);
      } catch (e) {
        if (!cancelled) setLoadError(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoadingLists(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // EDITING RE-READS THE ROW RATHER THAN TRUSTING WHAT IT WAS HANDED. The
  // schedule board's own query selects a narrow column list for the grid - no
  // max_capacity, no price, no location_id, no notes - so seeding this form from
  // the caller's object would show those fields BLANK and then write the blanks
  // back on save, quietly erasing the seat cap and the price of a camp that is
  // already selling. Every field this form writes is read here first, from the
  // row itself, so an edit can only ever change what the operator changed.
  useEffect(() => {
    if (!session?.id) return;
    let cancelled = false;
    (async () => {
      setLoadingRow(true);
      const { data, error } = await supabase
        .from("camp_sessions")
        .select("id, location_id, location_name, room, week_num, starts_on, ends_on, session_type, curriculum_id, curriculum_name, curriculum_category, start_time, end_time, class_days, age_format, grade_min, grade_max, ages_min, ages_max, max_capacity, short_description, price_cents, early_bird_price_cents, early_bird_deadline, runs_own_registration, external_registration_url, list_in_public_catalog, notes")
        .eq("id", session.id)
        .single();
      if (cancelled) return;
      if (error) {
        setLoadError(`Could not open that camp: ${error.message}`);
        setLoadingRow(false);
        return;
      }
      setForm({
        location_id: data.location_id ?? "",
        room: data.room ?? "",
        // A camp saved before this form knew about grades has age_format NULL.
        // Default the MODE to whichever pair actually holds values, so an
        // ages-based camp opens on ages rather than on an empty grade picker.
        age_format: data.age_format ?? ((data.grade_min != null || data.grade_max != null) ? "grade" : "age"),
        grade_min: data.grade_min,
        grade_max: data.grade_max,
        short_description: data.short_description ?? "",
        runs_own_registration: data.runs_own_registration ?? false,
        external_registration_url: data.external_registration_url ?? "",
        list_in_public_catalog: data.list_in_public_catalog ?? false,
        week_num: data.week_num ?? "",
        session_type: data.session_type ?? "",
        curriculum_id: data.curriculum_id ?? "",
        curriculum_category: data.curriculum_category ?? "",
        start_time: toTimeInput(data.start_time),
        end_time: toTimeInput(data.end_time),
        class_days: Array.isArray(data.class_days) && data.class_days.length
          ? data.class_days
          : WEEKDAYS.map((d) => d.value),
        ages_min: data.ages_min ?? "",
        ages_max: data.ages_max ?? "",
        max_capacity: data.max_capacity ?? "",
        price_cents: data.price_cents ?? null,
        early_bird_price_cents: data.early_bird_price_cents ?? null,
        early_bird_deadline: data.early_bird_deadline ?? "",
        notes: data.notes ?? "",
      });
      // Everything counts as already chosen: these are the operator's own
      // values, and picking a curriculum must not silently rewrite the capacity
      // or ages of a camp that is already running.
      setTouched(new Set(Object.keys(EMPTY)));
      // Is anyone already on this camp - an instructor, or a child? Moving a
      // camp with either is not a form problem, it is a payroll and a families
      // problem - see the submit guard.
      //
      // THIS COUNT FAILS CLOSED. Reading only `count` and defaulting a failure
      // to 0 made the guard fail OPEN: one dropped request and the form would
      // cheerfully let someone re-date a camp with instructors on it, which is
      // the exact corruption the guard exists to stop. An unknown count is
      // treated as "somebody is on this camp" instead, so the worst a failure
      // costs is a refused move.
      const [assignRes, regRes] = await Promise.all([
        supabase
          .from("camp_assignments")
          .select("id", { count: "exact", head: true })
          .eq("camp_session_id", session.id)
          .neq("status", "withdrawn"),
        supabase
          .from("registrations")
          .select("id", { count: "exact", head: true })
          .eq("camp_session_id", session.id),
      ]);
      if (cancelled) return;
      if (assignRes.error || regRes.error) {
        console.warn("[CampSessionForm] could not count who is on this camp:",
          assignRes.error?.message ?? regRes.error?.message);
        setMoveLockUnknown(true);
      }
      setAssignedInstructors(assignRes.error ? 1 : (assignRes.count ?? 0));
      setEnrolledChildren(regRes.error ? 1 : (regRes.count ?? 0));
      setBaseline({
        week_num: data.week_num ?? "",
        starts_on: data.starts_on,
        ends_on: data.ends_on,
        curriculum_id: data.curriculum_id ?? "",
        curriculum_name: data.curriculum_name,
        location_id: data.location_id ?? "",
        location_name: data.location_name,
        // Raw, NOT the Mon-Fri the day buttons fall back to showing. NULL and
        // Mon-Fri are different instructions downstream, so the difference has
        // to survive a save that never touched the days - see the submit.
        class_days: data.class_days,
      });
      setLoadingRow(false);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Picking a curriculum seeds category, ages and THE SEAT CAP. Untouched fields
  // only - see the `touched` note above.
  // Computed here rather than inside a setForm updater. An updater has to be a
  // pure function of the previous state: React is free to call it later, or
  // twice, so building the "filled in from this curriculum" list by pushing into
  // an outer array from inside one gave a list that was still empty when the
  // next line read it, and a doubled list under StrictMode's double-invoke.
  // This is an event handler, so `form` in scope is already the current state.
  function chooseCurriculum(curriculumId) {
    const cur = curricula.find((c) => c.id === curriculumId);
    setTouched((t) => new Set(t).add("curriculum_id"));
    if (!cur) {
      setForm((f) => ({ ...f, curriculum_id: curriculumId }));
      setPrefilled([]);
      return;
    }
    const next = { ...form, curriculum_id: curriculumId };
    const filled = [];
    if (!touched.has("curriculum_category") && cur.category) {
      next.curriculum_category = cur.category;
      filled.push("category");
    }
    // The whole reason the cap survives to the checkout gate.
    if (!touched.has("max_capacity") && cur.class_size_max != null) {
      next.max_capacity = cur.class_size_max;
      filled.push("class size");
    }
    if (!touched.has("ages_min") && cur.age_range_min != null) {
      next.ages_min = cur.age_range_min;
      filled.push("ages");
    }
    if (!touched.has("ages_max") && cur.age_range_max != null) {
      next.ages_max = cur.age_range_max;
      if (!filled.includes("ages")) filled.push("ages");
    }
    setForm(next);
    setPrefilled(filled);
  }

  // Choosing a session type fills the hours from the last camp of that kind.
  function chooseSessionType(value) {
    setTouched((t) => new Set(t).add("session_type"));
    const d = timeDefaults[value];
    setForm((f) => ({
      ...f,
      session_type: value,
      start_time: touched.has("start_time") ? f.start_time : (d?.start_time ?? f.start_time),
      end_time: touched.has("end_time") ? f.end_time : (d?.end_time ?? f.end_time),
    }));
  }

  // Turning a day ON used to rebuild the list from WEEKDAYS, which silently
  // DELETED anything this form has no chip for. class_days is a plain text[]
  // with no constraint to Mon-Fri: a weekend camp storing 'saturday' would load
  // with every chip off, and the first click on any chip would drop the Saturday
  // the camp actually runs - and with it the instructor's pay for that day and
  // its share of a refund. Keep whatever is already there, add the one day, and
  // sort into the canonical order with unknown days last.
  function toggleDay(day) {
    setTouched((t) => new Set(t).add("class_days"));
    setForm((f) => {
      if (f.class_days.includes(day)) {
        return { ...f, class_days: f.class_days.filter((d) => d !== day) };
      }
      const order = WEEKDAYS.map((d) => d.value);
      const rank = (d) => (order.indexOf(d) === -1 ? order.length : order.indexOf(d));
      return { ...f, class_days: [...f.class_days, day].sort((a, b) => rank(a) - rank(b)) };
    });
  }

  async function reloadDistricts() {
    const { data } = await supabase
      .from("districts")
      .select("id, name, district_type")
      .eq("organization_id", orgId)
      .order("name");
    setDistricts(data ?? []);
    if (data?.length) setDistrictsWarning("");
  }

  // A site created inline is selected straight away, so the operator lands back
  // on the camp with the site they just made already chosen. The room is cleared
  // because it belonged to the previous venue - same reasoning as the program
  // wizard's handleSchoolCreated.
  async function handleSiteCreated({ locationId }) {
    setAddingSite(false);
    const { data } = await supabase
      .from("program_locations")
      .select("id, name")
      .eq("organization_id", orgId)
      .order("name");
    setLocations(data ?? []);
    if (locationId) {
      setTouched((t) => new Set(t).add("location_id").add("room"));
      setForm((f) => ({ ...f, location_id: locationId, room: "" }));
    }
  }

  function handleMoney(name, value) {
    if (value === "" || value === null) { field(name, null); return; }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    field(name, Math.round(num * 100));
  }

  const selectedWeek = weeks.find((w) => String(w.num) === String(form.week_num)) ?? null;

  // The dates this camp will actually be stored with - the week's, unless the
  // week is untouched and the row already carried its own (a partial week).
  const effectiveRange = useMemo(() => {
    const weekSame = baseline && String(baseline.week_num) === String(form.week_num);
    if (weekSame) return { starts_on: baseline.starts_on, ends_on: baseline.ends_on };
    return selectedWeek ? { starts_on: selectedWeek.starts_on, ends_on: selectedWeek.ends_on } : null;
  }, [baseline, form.week_num, selectedWeek]);

  // Does the camp meet on ANY date inside its own range? A camp that ends on a
  // Wednesday but is set to meet Thursday and Friday meets on no date at all,
  // and nothing downstream says so: the pay cron seeds no day, so the instructor
  // teaches and Payroll stays empty, and refund proration reads an empty
  // schedule as "unknown" and hands back 100% of the enrops margin on every
  // cancellation. Cheap to catch here, expensive to find later.
  const meetsNoDay = useMemo(() => {
    if (!effectiveRange?.starts_on || !effectiveRange?.ends_on) return false;
    if (form.class_days.length === 0) return false; // its own error already
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const wanted = new Set(form.class_days.map((d) => String(d).trim().toLowerCase()));
    const cursor = new Date(`${effectiveRange.starts_on}T00:00:00Z`);
    const end = new Date(`${effectiveRange.ends_on}T00:00:00Z`);
    if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return false;
    for (let i = 0; i < 400 && cursor.getTime() <= end.getTime(); i++) {
      if (wanted.has(names[cursor.getUTCDay()])) return false;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return true;
  }, [effectiveRange, form.class_days]);

  // Every rule here mirrors a constraint on camp_sessions. Catching them in the
  // form is the difference between a sentence the operator can act on and a raw
  // Postgres error.
  const errors = useMemo(() => {
    const e = [];
    if (!form.location_id) e.push("Pick a site.");
    if (!selectedWeek) e.push("Pick a week.");
    if (!form.session_type) e.push("Pick morning, afternoon or full day.");
    if (!form.curriculum_id) e.push("Pick a curriculum.");
    if (!form.curriculum_category) e.push("Pick a category.");
    if (!form.start_time || !form.end_time) e.push("Set a start and end time.");
    if (form.start_time && form.end_time && form.start_time >= form.end_time) {
      e.push("The end time has to be after the start time.");
    }
    if (form.class_days.length === 0) e.push("Pick at least one day the camp meets.");
    if (meetsNoDay && effectiveRange) {
      e.push(`This camp runs ${effectiveRange.starts_on} to ${effectiveRange.ends_on}, and none of the days you picked fall in it. Pick a day inside those dates.`);
    }
    // MOVING A CAMP THAT ALREADY HAS INSTRUCTORS IS A PAYROLL PROBLEM, not a
    // scheduling one. Substitutions and delivery confirmations are keyed by
    // CALENDAR DATE (the pay view joins `sub.date = c.session_date`), so new
    // dates orphan every sub row: the join misses, pay falls back to the
    // original instructor, and the substitute who actually taught is not paid.
    // The instructor was also emailed the old dates and nothing here re-sends.
    // None of that is fixable from this form, so it refuses the move and leaves
    // the operator to withdraw the assignments first - deliberately, and
    // knowing what it costs.
    if (baseline && (assignedInstructors > 0 || enrolledChildren > 0)) {
      const who = moveLockUnknown
        ? "people may already be on this camp"
        : [
            assignedInstructors > 0 ? `${assignedInstructors} instructor${assignedInstructors === 1 ? "" : "s"}` : null,
            enrolledChildren > 0 ? `${enrolledChildren} ${enrolledChildren === 1 ? "child" : "children"}` : null,
          ].filter(Boolean).join(" and ");
      const lead = moveLockUnknown
        ? "We could not check who is on this camp, so"
        : `This camp already has ${who} on it, so`;
      if (String(baseline.week_num) !== String(form.week_num)) {
        e.push(`${lead} its week cannot be changed here. Take them off the camp first, or make a new camp in the other week.`);
      }
      if (baseline.location_id !== form.location_id) {
        e.push(`${lead} its site cannot be changed here. Take them off the camp first, or make a new camp at the other site.`);
      }
    }
    const capacity = intOrNull(form.max_capacity);
    if (capacity != null && capacity <= 0) {
      e.push("Leave the class size blank for no limit, or set it above zero.");
    }
    // Only the pair actually in use is checked - the other is written as NULL,
    // so a stale value behind the unselected tab must not block the save.
    // rangeBackwards/rangeBackwardsMessage are the shared helpers the program
    // wizard uses, so both builders phrase a backwards range identically.
    if (form.age_format === "grade") {
      if (rangeBackwards(form.grade_min, form.grade_max)) e.push(rangeBackwardsMessage("grades"));
    } else {
      const aMin = intOrNull(form.ages_min);
      const aMax = intOrNull(form.ages_max);
      if (aMin != null && aMax != null && aMin > aMax) e.push(rangeBackwardsMessage("ages"));
    }
    // A partner-run camp with nowhere to send families is a dead end on the
    // catalog. Mirrors the program wizard's pairing of the two fields.
    if (form.runs_own_registration && form.list_in_public_catalog
      && !form.external_registration_url.trim()) {
      e.push("This camp is listed but registers somewhere else, so it needs the link families should follow.");
    }
    // camp_sessions_eb_lower_than_regular / _eb_deadline_requires_eb_price.
    if (form.early_bird_price_cents != null && form.price_cents != null
      && form.early_bird_price_cents >= form.price_cents) {
      e.push("The early bird price has to be lower than the regular price.");
    }
    if (form.early_bird_deadline && form.early_bird_price_cents == null) {
      e.push("An early bird deadline needs an early bird price.");
    }
    return e;
  }, [form, selectedWeek, meetsNoDay, effectiveRange, baseline, assignedInstructors, enrolledChildren, moveLockUnknown]);

  async function handleSubmit() {
    setSaveError("");
    if (errors.length) return;
    setSaving(true);
    try {
      const location = locations.find((l) => l.id === form.location_id);
      const curriculum = curricula.find((c) => c.id === form.curriculum_id);
      if (!location) throw new Error("That site is no longer in your list. Pick another.");
      if (!curriculum) throw new Error("That curriculum is no longer published. Pick another.");

      // THE TWO DERIVED FIELDS KEEP THEIR STORED VALUE UNLESS THEIR SOURCE MOVED.
      //
      // Dates: a camp is not obliged to fill its week. Six camps on prod run a
      // partial one - a Mon/Wed camp whose ends_on falls before its week's
      // Friday - and rebuilding the dates from the week on every save would
      // quietly stretch them back out. Only a week the operator actually changed
      // re-derives them.
      //
      // Name: curriculum_name is what families and instructors READ - it is the
      // title on the board, the printed schedule, rosters, and the offer and
      // patch-offer emails. On prod 44 of 51 camps carry a name deliberately
      // different from their curriculum's internal title, so syncing it on every
      // save would rename most of the catalogue behind the operator's back. Only
      // a curriculum they actually changed re-derives it.
      // Name: location_name is the SAME problem and a worse one, because it is an
      // identity key, not just a label. apps-script-roster-sync branches on
      // `location_name.toLowerCase() === 'lacamas lodge'` and then finds the
      // sibling weeks with .eq('location_name', ...) and .eq('curriculum_name',
      // ...). Seven camps on prod store a shorter venue name than
      // program_locations holds ("Lacamas Lodge" vs "Camas P&R: Lacamas Lodge"),
      // so rewriting it on an unrelated edit would break the Lacamas roster
      // fan-out and un-group that camp from its siblings.
      const weekUnchanged = baseline && String(baseline.week_num) === String(form.week_num);
      const curriculumUnchanged = baseline && baseline.curriculum_id === form.curriculum_id;
      const locationUnchanged = baseline && baseline.location_id === form.location_id;

      // class_days: NULL and Mon-Fri are NOT the same instruction. The day
      // buttons show Mon-Fri when a row stores nothing, but for refund proration
      // a NULL means every day in the range counts (the widest reading, the one
      // that refunds most), while the pay cron seeds nothing at all for an empty
      // list. Writing the displayed default back would move real money. So an
      // untouched set of days keeps exactly what was stored, NULL included.
      const displayedDays = Array.isArray(baseline?.class_days) && baseline.class_days.length
        ? baseline.class_days
        : WEEKDAYS.map((d) => d.value);
      const daysUnchanged = baseline
        && form.class_days.length === displayedDays.length
        && form.class_days.every((d) => displayedDays.includes(d));

      // location_name is NOT NULL and denormalised alongside location_id - the
      // schedule board, rosters and the matcher's venue-region map all read the
      // name. Writing one without the other is what leaves a camp unplaceable.
      const payload = {
        location_id: location.id,
        location_name: locationUnchanged ? baseline.location_name : location.name,
        week_num: selectedWeek.num,
        starts_on: weekUnchanged ? baseline.starts_on : selectedWeek.starts_on,
        ends_on: weekUnchanged ? baseline.ends_on : selectedWeek.ends_on,
        session_type: form.session_type,
        curriculum_id: curriculum.id,
        curriculum_name: curriculumUnchanged ? baseline.curriculum_name : curriculum.name,
        curriculum_category: form.curriculum_category,
        room: form.room.trim() || null,
        start_time: form.start_time,
        end_time: form.end_time,
        class_days: daysUnchanged ? baseline.class_days : form.class_days,
        // Exactly one vocabulary is stored; the other pair is cleared. Same rule
        // and same intOrNull as the program wizard, so Kindergarten (grade 0)
        // survives - a truthiness check here would delete it.
        age_format: form.age_format,
        grade_min: form.age_format === "grade" ? intOrNull(form.grade_min) : null,
        grade_max: form.age_format === "grade" ? intOrNull(form.grade_max) : null,
        ages_min: form.age_format === "age" ? intOrNull(form.ages_min) : null,
        ages_max: form.age_format === "age" ? intOrNull(form.ages_max) : null,
        max_capacity: intOrNull(form.max_capacity),
        short_description: form.short_description.trim() || null,
        runs_own_registration: form.runs_own_registration,
        external_registration_url: form.runs_own_registration
          ? (form.external_registration_url.trim() || null)
          : null,
        list_in_public_catalog: form.runs_own_registration ? !!form.list_in_public_catalog : false,
        price_cents: form.price_cents,
        early_bird_price_cents: form.early_bird_price_cents,
        early_bird_deadline: form.early_bird_deadline || null,
        notes: form.notes.trim() || null,
      };

      if (isEdit) {
        // Named columns only. A whole-row write here would reset the fields this
        // form does not own - current_enrollment, enrollment_synced_at, status,
        // parent_session_id - and silently undo a roster sync or a cancellation.
        // .select() is what makes a refused write VISIBLE. An update whose rows
        // are all filtered away - by RLS, or by a camp deleted in another tab -
        // comes back with error null and no rows, so without asking for the row
        // back this reported success, closed the modal and reloaded a board that
        // had not changed. camp_sessions writes are owner/admin only, while the
        // board and its Edit links render for every org member, so that silent
        // path is reachable today. The insert below was already honest by
        // accident: .single() errors when nothing comes back.
        const { data: updated, error } = await supabase
          .from("camp_sessions")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", session.id)
          .eq("organization_id", orgId)
          .select("id");
        if (error) throw error;
        if (!updated || updated.length === 0) {
          throw new Error("That camp could not be saved. You may not have permission to change camps, or it was removed while you had it open.");
        }
        onSaved?.({ id: session.id, mode: "edit" });
      } else {
        const { data, error } = await supabase
          .from("camp_sessions")
          .insert({
            ...payload,
            organization_id: orgId,
            cycle_id: cycle.id,
            // status and current_enrollment take their column defaults
            // ('active', 0) rather than being restated here.
          })
          .select("id")
          .single();
        if (error) throw error;
        // Same conversion signal the program wizard fires when a program is
        // saved live. A camp has no draft state - camp_sessions.status is only
        // active or cancelled - so creating one IS the live save.
        pixelWorkflowCreated();
        onSaved?.({ id: data.id, mode: "create" });
      }
    } catch (e) {
      setSaveError(e.message ?? String(e));
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
  const labelStyle = {
    fontSize: 12,
    fontWeight: 600,
    color: INK,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    display: "block",
    marginBottom: 4,
  };

  const title = isEdit ? "Edit camp" : "Add a camp";

  if (loading) {
    return (
      <ModalShell title={title} onClose={onClose} maxWidth={620}>
        <div style={{ padding: 32, color: MUTED, textAlign: "center" }}>Loading your sites and curricula…</div>
      </ModalShell>
    );
  }

  if (loadError) {
    return (
      <ModalShell title={title} onClose={onClose} maxWidth={620}>
        <div style={{ padding: 24, color: DANGER, fontSize: 14 }}>{loadError}</div>
      </ModalShell>
    );
  }

  // The same inline site builder the program wizard opens, not a second one.
  // Rendered instead of the form rather than on top of it: both are modals, and
  // stacking two scrims puts the camp form's close-on-scrim-click underneath.
  //
  // CHECKED BEFORE the prerequisite empty state below, not after. Having no
  // sites yet is exactly when somebody needs to add one, and an empty state
  // that returned first would make the button it offers unreachable.
  if (addingSite) {
    return (
      <AddSchoolModal
        org={org}
        districts={districts}
        partners={partners}
        districtsWarning={districtsWarning}
        onClose={() => setAddingSite(false)}
        onDistrictsChanged={reloadDistricts}
        onCreated={handleSiteCreated}
      />
    );
  }

  if (locations.length === 0 || curricula.length === 0) {
    return (
      <ModalShell title={title} onClose={onClose} maxWidth={620}>
        <div style={{ padding: 24, fontSize: 14, color: INK, lineHeight: 1.6 }}>
          {locations.length === 0 && (
            <p style={{ marginTop: 0 }}>
              You need at least one site before you can put a camp anywhere.{" "}
              <button
                type="button"
                onClick={() => setAddingSite(true)}
                style={{ background: "transparent", border: "none", color: BRIGHT, fontSize: 14, fontFamily: "inherit", cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >Add one now</button>{" "}
              without leaving this screen.
            </p>
          )}
          {curricula.length === 0 && <p style={{ marginBottom: 0 }}>You need a published curriculum before you can schedule a camp. Publish one under Curricula.</p>}
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={title} onClose={onClose} maxWidth={620}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, color: MUTED }}>
          {/* No promise here about families seeing this camp: nothing sells a
              camp on enrops yet, and copy that says otherwise would be false on
              the day it ships. The catalog line belongs with the catalog. */}
          {cycle?.name ? <>Adding to <strong style={{ color: INK }}>{cycle.name}</strong>.</> : null}{" "}
          It goes on your schedule board, ready to assign an instructor to.
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <label style={labelStyle} htmlFor="camp-site">Site</label>
            <button
              type="button"
              onClick={() => setAddingSite(true)}
              style={{ background: "transparent", border: "none", color: BRIGHT, fontSize: 12, fontFamily: "inherit", cursor: "pointer", padding: 0, marginBottom: 4 }}
            >+ Add a site</button>
          </div>
          <select id="camp-site" value={form.location_id} onChange={(e) => field("location_id", e.target.value)} style={fieldStyle}>
            <option value="">Pick a site…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {districtsWarning && (
            <div style={{ fontSize: 12, color: DANGER, marginTop: 6 }}>{districtsWarning}</div>
          )}
        </div>

        <div>
          <label style={labelStyle} htmlFor="camp-room">Room (optional)</label>
          <input id="camp-room" type="text" value={form.room} onChange={(e) => field("room", e.target.value)} style={fieldStyle} placeholder="Leave blank to use the site's usual room" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="camp-week">Week</label>
            <select id="camp-week" value={form.week_num} onChange={(e) => field("week_num", e.target.value)} style={fieldStyle}>
              <option value="">Pick a week…</option>
              {weeks.map((w) => (
                <option key={w.num} value={w.num}>Week {w.num} · {w.starts_on} to {w.ends_on}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="camp-type">Morning, afternoon or full day</label>
            <select id="camp-type" value={form.session_type} onChange={(e) => chooseSessionType(e.target.value)} style={fieldStyle}>
              <option value="">Pick one…</option>
              {SESSION_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Days it meets</label>
          <div style={{ display: "flex", gap: 6 }}>
            {WEEKDAYS.map((d) => {
              const on = form.class_days.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleDay(d.value)}
                  aria-pressed={on}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    background: on ? `${PURPLE}10` : "#fff",
                    border: `1px solid ${on ? PURPLE : RULE}`,
                    borderRadius: 6,
                    color: on ? PURPLE : MUTED,
                    fontWeight: on ? 700 : 500,
                    fontFamily: "inherit",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >{d.label}</button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
            Turn off any day the camp does not run, like a holiday in the middle of the week.
            Instructors are paid per day it meets.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="camp-start">Starts</label>
            <input id="camp-start" type="time" value={form.start_time} onChange={(e) => field("start_time", e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="camp-end">Ends</label>
            <input id="camp-end" type="time" value={form.end_time} onChange={(e) => field("end_time", e.target.value)} style={fieldStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle} htmlFor="camp-curriculum">Curriculum</label>
          <select id="camp-curriculum" value={form.curriculum_id} onChange={(e) => chooseCurriculum(e.target.value)} style={fieldStyle}>
            <option value="">Pick a curriculum…</option>
            {curricula.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {prefilled.length > 0 && (
            <div style={{ fontSize: 12, color: BRIGHT, marginTop: 6 }}>
              Filled in from this curriculum: {prefilled.join(", ")}. Change anything that is different this time.
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="camp-category">Category</label>
            <select id="camp-category" value={form.curriculum_category} onChange={(e) => field("curriculum_category", e.target.value)} style={fieldStyle}>
              <option value="">Pick one…</option>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <label style={labelStyle}>Who it is for</label>
            <div style={{ display: "flex", gap: 6 }}>
              {[{ v: "grade", l: "By grade" }, { v: "age", l: "By age" }].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => field("age_format", o.v)}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    background: form.age_format === o.v ? `${PURPLE}10` : "#fff",
                    border: `1px solid ${form.age_format === o.v ? PURPLE : RULE}`,
                    borderRadius: 6,
                    color: form.age_format === o.v ? PURPLE : MUTED,
                    fontWeight: form.age_format === o.v ? 700 : 500,
                    fontFamily: "inherit",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >{o.l}</button>
              ))}
            </div>
          </div>
        </div>

        {form.age_format === "grade" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle} htmlFor="camp-grade-min">Lowest grade</label>
              <select id="camp-grade-min" value={form.grade_min ?? ""} onChange={(e) => field("grade_min", e.target.value === "" ? null : Number(e.target.value))} style={fieldStyle}>
                <option value="">Not stated</option>
                {GRADE_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle} htmlFor="camp-grade-max">Highest grade</label>
              <select id="camp-grade-max" value={form.grade_max ?? ""} onChange={(e) => field("grade_max", e.target.value === "" ? null : Number(e.target.value))} style={fieldStyle}>
                <option value="">Not stated</option>
                {GRADE_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle} htmlFor="camp-ages-min">Youngest age</label>
              <input id="camp-ages-min" type="number" min="0" value={form.ages_min} onChange={(e) => field("ages_min", e.target.value)} style={fieldStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="camp-ages-max">Oldest age</label>
              <input id="camp-ages-max" type="number" min="0" value={form.ages_max} onChange={(e) => field("ages_max", e.target.value)} style={fieldStyle} />
            </div>
          </div>
        )}

        <div>
          <label style={labelStyle} htmlFor="camp-blurb">Short description (families see this)</label>
          <textarea id="camp-blurb" rows={2} value={form.short_description} onChange={(e) => field("short_description", e.target.value)} style={{ ...fieldStyle, resize: "vertical" }} />
        </div>

        <div>
          <label style={labelStyle} htmlFor="camp-capacity">Most children who can join</label>
          <input id="camp-capacity" type="number" min="1" value={form.max_capacity} onChange={(e) => field("max_capacity", e.target.value)} style={{ ...fieldStyle, maxWidth: 160 }} />
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
            {/* States what the number IS, not what enforces it. The seat gate
                arrives with camp checkout; until then this would be promising
                a refusal nothing performs. */}
            The most children this camp can take. Leave it blank and the camp has no limit.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="camp-price">Price</label>
            <input id="camp-price" type="number" min="0" step="0.01" value={centsToDollars(form.price_cents)} onChange={(e) => handleMoney("price_cents", e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="camp-eb">Early bird price</label>
            <input id="camp-eb" type="number" min="0" step="0.01" value={centsToDollars(form.early_bird_price_cents)} onChange={(e) => handleMoney("early_bird_price_cents", e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="camp-eb-date">Early bird ends</label>
            <input id="camp-eb-date" type="date" value={form.early_bird_deadline} onChange={(e) => field("early_bird_deadline", e.target.value)} style={fieldStyle} />
          </div>
        </div>

        {/* What a family is actually charged, fee included - the same component
            and the same fee config the program wizard uses, so the two screens
            cannot quote different all-in prices for the same number typed. */}
        <FamiliesPayNote priceCents={form.price_cents} feeConfig={feeConfig} noun="camp" style={{ color: INK }} />

        <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 12 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={form.runs_own_registration}
              onChange={(e) => field("runs_own_registration", e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}>
              <strong>The site takes the registrations, not us.</strong> Use this when a
              parks department or partner sells the camp themselves. We will not take
              payment for it.
            </span>
          </label>
          {form.runs_own_registration && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.list_in_public_catalog}
                  onChange={(e) => field("list_in_public_catalog", e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}>
                  Still show it on our page, with a link out to them.
                </span>
              </label>
              {form.list_in_public_catalog && (
                <div>
                  <label style={labelStyle} htmlFor="camp-ext-url">Where families register</label>
                  <input id="camp-ext-url" type="url" value={form.external_registration_url} onChange={(e) => field("external_registration_url", e.target.value)} style={fieldStyle} placeholder="https://" />
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle} htmlFor="camp-notes">Notes (only you see these)</label>
          <textarea id="camp-notes" rows={2} value={form.notes} onChange={(e) => field("notes", e.target.value)} style={{ ...fieldStyle, resize: "vertical" }} />
        </div>

        {errors.length > 0 && (
          <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 10, fontSize: 13, color: INK }}>
            {errors.map((e) => <div key={e}>{e}</div>)}
          </div>
        )}
        {saveError && (
          <div style={{ color: DANGER, fontSize: 13 }}>{saveError}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          <button type="button" onClick={onClose} disabled={saving} style={{ padding: "9px 14px", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 6, color: INK, fontFamily: "inherit", fontSize: 14, cursor: saving ? "default" : "pointer" }}>Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || errors.length > 0}
            style={{
              padding: "9px 16px",
              background: saving || errors.length > 0 ? RULE : BRIGHT,
              border: "none",
              borderRadius: 6,
              color: saving || errors.length > 0 ? MUTED : "#fff",
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 600,
              cursor: saving || errors.length > 0 ? "default" : "pointer",
            }}
          >{saving ? "Saving…" : isEdit ? "Save changes" : "Add camp"}</button>
        </div>
      </div>
    </ModalShell>
  );
}
