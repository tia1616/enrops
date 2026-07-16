// /admin/programs/new
// Wizard for creating a new program (afterschool / standard).
// Steps:
//   1. Curriculum + location  (+ term)
//   2. When + how many + live preview of session dates
//   3. Price + open registration (or save as draft)
//
// Multi-tenant: scoped by org.id from outlet context. Writes only happen on
// the final Step 3 submit (status='draft' or 'open' depending on choice).
//
// STAGE 2026-06-02: scaffold + Step 1 (pickers, curriculum-based pre-fills,
// Next-button validation). Steps 2 + 3 land next.

import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import ProgramPrereqEmptyState from "./ProgramPrereqEmptyState.jsx";
import AddSchoolModal from "../schools/AddSchoolModal.jsx";
import ShareProgram from "../../../components/ShareProgram.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const SOFT_GREEN_BG = "#f0fdf4";
const SOFT_GREEN_INK = "#166534";
const SOFT_AMBER_BG = "#fff7ed";
const SOFT_AMBER_BORDER = "#fed7aa";
const SOFT_AMBER_INK = "#9a3412";

// value MUST match how programs.day_of_week is stored (Title-Case, e.g.
// "Wednesday") — it's written straight to the column and compared with `=`
// elsewhere. This list used to carry lowercase values, which silently:
//   - rendered "wednesdays" on the public catalog (raw column echo),
//   - broke the VIP bundle match (fall "wednesday" != winter "Wednesday"),
//     so an eligible school quietly offered no bundle at all,
//   - and killed the conflict check below (day never matched).
// Keep these Title-Case.
const DAYS = [
  { value: "Monday", label: "Monday" },
  { value: "Tuesday", label: "Tuesday" },
  { value: "Wednesday", label: "Wednesday" },
  { value: "Thursday", label: "Thursday" },
  { value: "Friday", label: "Friday" },
  { value: "Saturday", label: "Saturday" },
  { value: "Sunday", label: "Sunday" },
];

// Mirror of term_to_school_year() — used to decide which district_calendars
// row corresponds to the chosen term. Kept in sync with ProgramsCalendar.
function termToSchoolYearJs(term) {
  if (typeof term !== "string" || term.length < 4) return null;
  const prefix = term.slice(0, 2).toUpperCase();
  const yy = parseInt(term.slice(2), 10);
  if (!Number.isFinite(yy)) return null;
  if (prefix === "FA") return `20${String(yy).padStart(2, "0")}-20${String(yy + 1).padStart(2, "0")}`;
  if (prefix === "WI" || prefix === "SP") return `20${String(yy - 1).padStart(2, "0")}-20${String(yy).padStart(2, "0")}`;
  return null;
}

function formatDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

// "15:30" -> "3:30pm". The DB stores time as text in HH:MM 24-hour from the
// HTML5 time input. Display goes lowercase pm/am.
function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

// The HTML <input type="time"> gives 24-hour "HH:MM". programs.start_time/
// end_time are stored as 12-hour text ("3:30 PM") — the format the matcher and
// schedule view parse. Convert on save so a new program's time matches existing
// rows and isn't dropped by the matcher's 12-hour parser.
function toDbTime12h(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return hhmm;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm; // not the 24h picker format — leave as-is
  const h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${min} ${ampm}`;
}

function dayLabel(dow) {
  const found = DAYS.find((d) => d.value === dow);
  return found ? found.label : "";
}

function termLabel(term) {
  const found = TERM_OPTIONS.find((t) => t.value === term);
  return found ? found.label : term;
}

const TERM_OPTIONS = [
  { value: "FA26", label: "Fall 2026 (FA26)" },
  { value: "WI27", label: "Winter 2027 (WI27)" },
  { value: "SP27", label: "Spring 2027 (SP27)" },
];

const STEP_LABELS = ["What & where", "When & how many", "Price & open"];

const inputStyle = {
  width: "100%", padding: "10px 12px",
  border: `1.5px solid ${RULE}`, borderRadius: 8,
  fontSize: 14, color: INK, background: "#fff",
  fontFamily: "inherit",
};

const labelStyle = {
  display: "block", fontSize: 13, fontWeight: 600,
  color: INK, marginBottom: 6,
};

const fieldGroup = { marginBottom: 18 };

export default function ProgramWizardNew() {
  const { org } = useOutletContext();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [prereqs, setPrereqs] = useState({ hasCurricula: false, hasLocations: false });
  const [curricula, setCurricula] = useState([]);
  const [locations, setLocations] = useState([]);
  // For the inline "Add a school" modal (reused from the Schools surface).
  const [districts, setDistricts] = useState([]);
  const [partners, setPartners] = useState([]);
  const [addingSchool, setAddingSchool] = useState(false);

  // Wizard state. Written only on final submit. Pre-fills from curriculum
  // happen in the curriculum-change handler.
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState({
    term: "FA26",
    curriculum_id: null,
    curriculum: "", // denormalized name (NOT NULL column)
    program_location_id: null,
    day_of_week: "",
    start_time: "",
    end_time: "",
    first_session_date: "",
    session_count: 8,
    max_capacity: 18,
    age_format: "grade",
    grade_min: 0,
    grade_max: 5,
    age_min: null,
    age_max: null,
    price_cents: null,
    short_description: "",
    // false = we run checkout (public catalog). true = the partner/venue runs
    // their own registration; program is live + scheduled but never shown in the
    // public catalog with a checkout. Mirrors camp_sessions.runs_own_registration.
    runs_own_registration: false,
    external_registration_url: "",
    list_in_public_catalog: false,
  });
  const [prefilledFromCurriculum, setPrefilledFromCurriculum] = useState(false);

  // Step 2 derived state — live preview of session dates, district-calendar
  // soft warning, and same-loc/day/time conflict soft warning.
  const [previewDates, setPreviewDates] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // { district: "Portland" } when location has a district but no calendar
  // saved for the term's school year. null otherwise.
  const [calendarWarning, setCalendarWarning] = useState(null);
  // Array of existing programs that overlap location + day + time window.
  const [conflicts, setConflicts] = useState([]);

  // Step 3 / submit state.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [savedProgramId, setSavedProgramId] = useState(null);
  const [savedAsStatus, setSavedAsStatus] = useState(null); // 'open' | 'draft'

  // Load prereq counts + the dropdown options for Step 1. One trip, on mount.
  // Curricula filter to status='published' so drafts/extracting don't show
  // (they can't be assigned to a program yet — would fail on save).
  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [cRes, lRes, dRes, pRes] = await Promise.all([
          supabase
            .from("curricula")
            .select(
              "id, name, short_description, session_count, " +
              "grade_min, grade_max, age_range_min, age_range_max, " +
              "class_size_min, class_size_max",
            )
            .eq("organization_id", org.id)
            .eq("status", "published")
            .order("name"),
          supabase
            .from("program_locations")
            .select("id, name, district, district_id, closure_dates")
            .eq("organization_id", org.id)
            .order("name"),
          // Districts + partners feed the inline "Add a school" modal. Non-blocking
          // if they fail — the wizard still works, the modal just has empty pickers.
          supabase
            .from("districts")
            .select("id, name")
            .eq("organization_id", org.id)
            .order("name"),
          supabase
            .from("partners")
            .select("id, partner_name")
            .eq("organization_id", org.id)
            .order("partner_name"),
        ]);
        if (cRes.error) throw cRes.error;
        if (lRes.error) throw lRes.error;
        if (mounted) {
          setCurricula(cRes.data ?? []);
          setLocations(lRes.data ?? []);
          setDistricts(dRes.data ?? []);
          setPartners(pRes.data ?? []);
          setPrereqs({
            hasCurricula: (cRes.data?.length ?? 0) > 0,
            hasLocations: (lRes.data?.length ?? 0) > 0,
          });
        }
      } catch (e) {
        if (mounted) setError(e.message ?? String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [org?.id]);

  // Debounced live preview of session dates. Fires when the inputs needed by
  // preview_program_session_dates change: first_session_date, session_count,
  // program_location_id, term, organization.
  useEffect(() => {
    if (!org?.id) return;
    if (!formData.first_session_date || !formData.session_count
        || !formData.program_location_id) {
      setPreviewDates(null);
      setPreviewError("");
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const handle = setTimeout(async () => {
      try {
        const { data, error: rpcErr } = await supabase.rpc(
          "preview_program_session_dates",
          {
            p_organization_id: org.id,
            p_location_id: formData.program_location_id,
            p_term: formData.term,
            p_first_date: formData.first_session_date,
            p_count: formData.session_count,
          },
        );
        if (cancelled) return;
        if (rpcErr) throw rpcErr;
        setPreviewDates(Array.isArray(data) ? data : []);
        setPreviewError("");
      } catch (e) {
        if (cancelled) return;
        setPreviewDates(null);
        setPreviewError(e.message ?? String(e));
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [
    org?.id,
    formData.first_session_date,
    formData.session_count,
    formData.program_location_id,
    formData.term,
  ]);

  // District-calendar soft warning. If the chosen location has a district
  // (structured link or legacy free-text) but no matching calendar exists for
  // the term's school year, warn — date math will run without district closures
  // subtracted. matching_district_calendars() is the single source of truth and
  // matches a school's calendar the same way derive/preview do.
  useEffect(() => {
    if (!org?.id || !formData.program_location_id) {
      setCalendarWarning(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const loc = locations.find((l) => l.id === formData.program_location_id);
      if (!loc?.district && !loc?.district_id) {
        if (!cancelled) setCalendarWarning(null);
        return;
      }
      const schoolYear = termToSchoolYearJs(formData.term);
      if (!schoolYear) {
        if (!cancelled) setCalendarWarning(null);
        return;
      }
      const { data, error: calErr } = await supabase.rpc(
        "matching_district_calendars",
        {
          p_org_id: org.id,
          p_location_id: formData.program_location_id,
          p_term: formData.term,
        },
      );
      if (cancelled) return;
      if (calErr) {
        // Don't block the wizard on a calendar lookup error.
        setCalendarWarning(null);
        return;
      }
      const hasCalendar = Array.isArray(data) && data.length > 0;
      setCalendarWarning(
        hasCalendar
          ? null
          : { district: loc.district || "this school's district", schoolYear },
      );
    })();
    return () => { cancelled = true; };
  }, [org?.id, formData.program_location_id, formData.term, locations]);

  // Conflict soft warning. Looks for existing programs at the same location +
  // day of week + overlapping time window in the same term. Soft warn only —
  // some providers run multiple programs at the same site/time.
  useEffect(() => {
    if (!org?.id || !formData.program_location_id || !formData.day_of_week
        || !formData.start_time || !formData.end_time) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: convErr } = await supabase
        .from("programs")
        .select("id, curriculum, start_time, end_time")
        .eq("organization_id", org.id)
        .eq("program_location_id", formData.program_location_id)
        .eq("term", formData.term)
        .eq("day_of_week", formData.day_of_week)
        .lt("start_time", formData.end_time)
        .gt("end_time", formData.start_time);
      if (cancelled) return;
      if (convErr) {
        setConflicts([]);
        return;
      }
      setConflicts(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [
    org?.id,
    formData.program_location_id,
    formData.day_of_week,
    formData.start_time,
    formData.end_time,
    formData.term,
  ]);

  // When provider picks a curriculum: pre-fill defaults from that curriculum.
  // Provider can edit anything in Step 2. We only auto-fill if the field is
  // still at its default — never overwrite something they've already typed.
  function handleCurriculumChange(curriculumId) {
    const cur = curricula.find((c) => c.id === curriculumId);
    if (!cur) {
      setFormData((f) => ({ ...f, curriculum_id: null, curriculum: "" }));
      setPrefilledFromCurriculum(false);
      return;
    }
    setFormData((f) => {
      // Prefer grade range if either field is set; fall back to age range.
      const hasGrade = cur.grade_min != null || cur.grade_max != null;
      const hasAge = cur.age_range_min != null || cur.age_range_max != null;
      const ageFormat = hasGrade ? "grade" : hasAge ? "age" : f.age_format;
      return {
        ...f,
        curriculum_id: cur.id,
        curriculum: cur.name,
        short_description: f.short_description || cur.short_description || "",
        session_count: cur.session_count ?? f.session_count,
        age_format: ageFormat,
        grade_min: hasGrade ? (cur.grade_min ?? f.grade_min) : f.grade_min,
        grade_max: hasGrade ? (cur.grade_max ?? f.grade_max) : f.grade_max,
        age_min: hasAge ? cur.age_range_min : f.age_min,
        age_max: hasAge ? cur.age_range_max : f.age_max,
        max_capacity: cur.class_size_max ?? f.max_capacity,
      };
    });
    setPrefilledFromCurriculum(true);
  }

  function handleLocationChange(locationId) {
    setFormData((f) => ({ ...f, program_location_id: locationId || null }));
  }

  // Refetch the location dropdown after the inline "Add a school" modal creates a
  // venue, and auto-select the brand-new one so the operator doesn't hunt for it.
  async function reloadLocations() {
    const { data } = await supabase
      .from("program_locations")
      .select("id, name, district, district_id, closure_dates")
      .eq("organization_id", org.id)
      .order("name");
    setLocations(data ?? []);
  }
  async function reloadDistricts() {
    const { data } = await supabase
      .from("districts")
      .select("id, name")
      .eq("organization_id", org.id)
      .order("name");
    setDistricts(data ?? []);
  }
  async function handleSchoolCreated({ locationId }) {
    setAddingSchool(false);
    await reloadLocations();
    if (locationId) {
      setFormData((f) => ({ ...f, program_location_id: locationId }));
    }
  }

  function handleTermChange(term) {
    setFormData((f) => ({ ...f, term }));
  }

  // Generic field setter for Step 2 inputs. Coerces empty strings → null for
  // optional numeric fields.
  function handleField(field, value) {
    setFormData((f) => ({ ...f, [field]: value }));
  }

  // Step 1 is complete when curriculum + location + term are all set.
  const step1Valid = Boolean(
    formData.curriculum_id && formData.program_location_id && formData.term,
  );

  // Step 2 is complete when the time + date inputs are all set. Capacity and
  // session_count have defaults, so they only need to be > 0.
  const step2Valid = Boolean(
    formData.day_of_week
    && formData.start_time
    && formData.end_time
    && formData.first_session_date
    && formData.session_count > 0
    && formData.max_capacity > 0
    && formData.start_time < formData.end_time,
  );

  // Step 3 valid when price is set (≥ 0) for programs WE run. For partner-run
  // programs we never collect payment, so price isn't required.
  const step3Valid = formData.runs_own_registration
    ? true
    : Boolean(formData.price_cents !== null && formData.price_cents >= 0);

  // Which calendar source the preview was actually able to use. Drives the
  // "Confirmed through ..." line in the preview box.
  //   - 'district' = location has a district set + that district's calendar
  //     for the term's school year is loaded
  //   - 'location' = location has saved closure_dates (with or without district)
  //   - null      = nothing to confirm against; preview is just weekly stride
  const selectedLocation = locations.find(
    (l) => l.id === formData.program_location_id,
  );
  const locationHasClosures =
    Array.isArray(selectedLocation?.closure_dates)
    && selectedLocation.closure_dates.length > 0;
  let confirmationSource = null;
  if (selectedLocation) {
    if ((selectedLocation.district || selectedLocation.district_id) && !calendarWarning) {
      confirmationSource = { kind: "district", name: selectedLocation.district || "school district" };
    } else if (locationHasClosures) {
      confirmationSource = { kind: "location" };
    }
  }

  // Final submit. Writes one row to programs. Status depends on which button
  // they hit. Always writes program_type='standard' for the afterschool v1
  // wizard — provider can flip via existing edit affordance if they need the
  // J2S 'coding_robotics' price tier.
  async function handleSubmit(status) {
    if (!step1Valid || !step2Valid || !step3Valid) {
      setSubmitError("Some required fields are still empty.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        organization_id: org.id,
        term: formData.term,
        curriculum_id: formData.curriculum_id,
        curriculum: formData.curriculum, // NOT NULL denormalized name
        program_location_id: formData.program_location_id,
        day_of_week: formData.day_of_week,
        // Store 12-hour text ("3:30 PM") to match existing data + the matcher.
        start_time: toDbTime12h(formData.start_time),
        end_time: toDbTime12h(formData.end_time),
        first_session_date: formData.first_session_date,
        session_count: formData.session_count,
        // Legacy column: nullable, defaults to 8. Some downstream code (pricing
        // formula fallback, possibly older reports) still reads `sessions` not
        // `session_count`. Write both to the same value so nothing silently
        // disagrees. Deprecate-and-drop is a separate cleanup.
        sessions: formData.session_count,
        max_capacity: formData.max_capacity,
        age_format: formData.age_format,
        // Only write the active range; null the other so we don't lie.
        grade_min: formData.age_format === "grade" ? formData.grade_min : null,
        grade_max: formData.age_format === "grade" ? formData.grade_max : null,
        age_min: formData.age_format === "age" ? formData.age_min : null,
        age_max: formData.age_format === "age" ? formData.age_max : null,
        // Partner-run programs don't take payment through us; default price to 0
        // so the NOT-null-friendly column stays clean and no $ ever shows.
        price_cents: formData.runs_own_registration
          ? (formData.price_cents ?? 0)
          : formData.price_cents,
        short_description: formData.short_description || null,
        program_type: "standard",
        runs_own_registration: formData.runs_own_registration,
        external_registration_url: formData.runs_own_registration
          ? (formData.external_registration_url.trim() || null)
          : null,
        list_in_public_catalog: formData.runs_own_registration
          ? !!formData.list_in_public_catalog
          : false,
        status, // 'draft' or 'open'
      };
      const { data, error: insErr } = await supabase
        .from("programs")
        .insert(payload)
        .select("id")
        .single();
      if (insErr) throw insErr;
      setSavedProgramId(data.id);
      setSavedAsStatus(status);
    } catch (e) {
      setSubmitError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render branches ----

  if (loading) {
    return (
      <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>
        Checking what you've got set up…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, color: "#b53737" }}>
        Couldn't check your setup: {error}
      </div>
    );
  }

  if (!prereqs.hasCurricula || !prereqs.hasLocations) {
    return (
      <ProgramPrereqEmptyState
        hasCurricula={prereqs.hasCurricula}
        hasLocations={prereqs.hasLocations}
      />
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => navigate("/admin/programs")}
          style={{
            background: "none", border: "none", color: MUTED,
            fontSize: 14, cursor: "pointer", padding: 0,
          }}
        >
          ← Back to programs
        </button>
        <h1 style={{
          fontSize: 26, fontWeight: 700, color: INK,
          margin: "12px 0 4px", letterSpacing: "-0.01em",
        }}>
          New program
        </h1>
        <div style={{ fontSize: 13, color: MUTED }}>
          Step {currentStep} of 3 · {STEP_LABELS[currentStep - 1]}
        </div>
        <WizardRecap currentStep={currentStep} formData={formData} selectedLocation={selectedLocation} />
      </div>

      <div style={{
        background: PANEL, border: `1px solid ${RULE}`,
        borderRadius: 10, padding: 24, minHeight: 240,
      }}>
        {currentStep === 1 && (
          <Step1WhatAndWhere
            formData={formData}
            curricula={curricula}
            locations={locations}
            prefilledFromCurriculum={prefilledFromCurriculum}
            onCurriculumChange={handleCurriculumChange}
            onLocationChange={handleLocationChange}
            onTermChange={handleTermChange}
            onAddSchool={() => setAddingSchool(true)}
          />
        )}
        {currentStep === 2 && (
          <Step2WhenAndHowMany
            formData={formData}
            onField={handleField}
            previewDates={previewDates}
            previewLoading={previewLoading}
            previewError={previewError}
            calendarWarning={calendarWarning}
            confirmationSource={confirmationSource}
            conflicts={conflicts}
          />
        )}
        {currentStep === 3 && (
          <Step3PriceAndOpen
            formData={formData}
            onField={handleField}
            submitting={submitting}
            submitError={submitError}
            savedProgramId={savedProgramId}
            savedAsStatus={savedAsStatus}
            orgSlug={org?.slug}
            orgActiveTerm={org?.active_registration_term}
            onSubmit={handleSubmit}
            onBackToPrograms={() => navigate("/admin/programs")}
            step3Valid={step3Valid}
          />
        )}
      </div>

      {/* Step nav — hidden once the program has been saved (Step 3 success
          state owns the primary action from that point). */}
      {!savedProgramId && (
        <div style={{
          display: "flex", justifyContent: "space-between",
          marginTop: 20, gap: 12,
        }}>
          <button
            onClick={() => {
              if (currentStep === 1) navigate("/admin/programs");
              else setCurrentStep((s) => s - 1);
            }}
            disabled={submitting}
            style={{
              padding: "10px 16px", background: "#fff",
              border: `1.5px solid ${RULE}`, borderRadius: 8,
              color: INK, fontSize: 14,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting ? 0.5 : 1,
            }}
          >
            {currentStep === 1 ? "Cancel" : "Back"}
          </button>
          {currentStep < 3 && (
            <button
              onClick={() => setCurrentStep((s) => Math.min(3, s + 1))}
              disabled={
                (currentStep === 1 && !step1Valid)
                || (currentStep === 2 && !step2Valid)
              }
              style={{
                padding: "10px 18px", background: BRIGHT, color: "#fff",
                border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
                cursor:
                  (currentStep === 1 && !step1Valid)
                  || (currentStep === 2 && !step2Valid)
                    ? "not-allowed" : "pointer",
                opacity:
                  (currentStep === 1 && !step1Valid)
                  || (currentStep === 2 && !step2Valid)
                    ? 0.5 : 1,
              }}
            >
              Next
            </button>
          )}
        </div>
      )}

      {addingSchool && (
        <AddSchoolModal
          org={org}
          districts={districts}
          partners={partners}
          onClose={() => setAddingSchool(false)}
          onDistrictsChanged={reloadDistricts}
          onCreated={handleSchoolCreated}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Running summary of selections so far, rendered under the step indicator.
// On Step 1 we have nothing to recap; on Steps 2 + 3 we show what's locked in.
// ---------------------------------------------------------------
function WizardRecap({ currentStep, formData, selectedLocation }) {
  if (currentStep === 1) return null;

  const parts = [];
  if (formData.curriculum) parts.push(formData.curriculum);
  if (selectedLocation?.name) parts.push(`at ${selectedLocation.name}`);
  parts.push(`for ${termLabel(formData.term)}`);

  // Step 3 adds the timing chunk locked in during Step 2.
  let timing = null;
  if (currentStep === 3) {
    const dayPlural = dayLabel(formData.day_of_week)
      ? `${dayLabel(formData.day_of_week)}s`
      : "";
    const timeRange = formData.start_time && formData.end_time
      ? `${formatTime(formData.start_time)}–${formatTime(formData.end_time)}`
      : "";
    const sessions = formData.session_count && formData.first_session_date
      ? `${formData.session_count} session${formData.session_count === 1 ? "" : "s"} starting ${formatDate(formData.first_session_date)}`
      : "";
    timing = [dayPlural && timeRange ? `${dayPlural} ${timeRange}` : "", sessions]
      .filter(Boolean)
      .join(" · ");
  }

  return (
    <div style={{
      marginTop: 10, padding: "10px 12px",
      background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8,
      fontSize: 13, color: INK, lineHeight: 1.5,
    }}>
      <span style={{ color: MUTED, fontWeight: 600, marginRight: 6 }}>
        Building:
      </span>
      {parts.join(" ")}
      {timing && (
        <>
          <br />
          <span style={{ color: MUTED, fontWeight: 600, marginRight: 6 }}>
            Timing:
          </span>
          {timing}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Step 1 — What & where
// ---------------------------------------------------------------
function Step1WhatAndWhere({
  formData,
  curricula,
  locations,
  prefilledFromCurriculum,
  onCurriculumChange,
  onLocationChange,
  onTermChange,
  onAddSchool,
}) {
  return (
    <div>
      <div style={fieldGroup}>
        <label htmlFor="term" style={labelStyle}>Term</label>
        <select
          id="term"
          value={formData.term}
          onChange={(e) => onTermChange(e.target.value)}
          style={inputStyle}
        >
          {TERM_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div style={fieldGroup}>
        <label htmlFor="curriculum" style={labelStyle}>Offering</label>
        <select
          id="curriculum"
          value={formData.curriculum_id ?? ""}
          onChange={(e) => onCurriculumChange(e.target.value || null)}
          style={inputStyle}
        >
          <option value="">— Choose an offering —</option>
          {curricula.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <a
            href="/admin/curricula/new"
            target="_blank"
            rel="noreferrer"
            style={{ color: PURPLE, textDecoration: "none" }}
          >
            + Add a new offering
          </a>
          <span style={{ color: MUTED, marginLeft: 8 }}>opens in a new tab</span>
        </div>
      </div>

      <div style={fieldGroup}>
        <label htmlFor="location" style={labelStyle}>Location</label>
        <select
          id="location"
          value={formData.program_location_id ?? ""}
          onChange={(e) => onLocationChange(e.target.value || null)}
          style={inputStyle}
        >
          <option value="">— Choose a location —</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}{l.district ? ` · ${l.district}` : ""}
            </option>
          ))}
        </select>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <button
            type="button"
            onClick={onAddSchool}
            style={{
              background: "none", border: "none", padding: 0,
              color: PURPLE, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            + Add a school / venue
          </button>
          <span style={{ color: MUTED, marginLeft: 8 }}>add the venue (and its umbrella org) without leaving</span>
        </div>
      </div>

      {prefilledFromCurriculum && (
        <div style={{
          marginTop: 4, padding: "10px 12px",
          background: SOFT_GREEN_BG, borderRadius: 8,
          color: SOFT_GREEN_INK, fontSize: 13, lineHeight: 1.5,
        }}>
          I pre-filled some defaults from this offering — number of sessions,
          age or grade range, and class size. You can edit them in the next step.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Step 2 — When & how many
// ---------------------------------------------------------------
function Step2WhenAndHowMany({
  formData,
  onField,
  previewDates,
  previewLoading,
  previewError,
  calendarWarning,
  confirmationSource,
  conflicts,
}) {
  const [showAllDates, setShowAllDates] = useState(false);
  const timeRangeInvalid =
    formData.start_time && formData.end_time
    && formData.start_time >= formData.end_time;

  return (
    <div>
      <div style={fieldGroup}>
        <label htmlFor="day_of_week" style={labelStyle}>Day of the week</label>
        <select
          id="day_of_week"
          value={formData.day_of_week}
          onChange={(e) => onField("day_of_week", e.target.value)}
          style={inputStyle}
        >
          <option value="">— Pick a day —</option>
          {DAYS.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 12, ...fieldGroup }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="start_time" style={labelStyle}>Start time</label>
          <input
            id="start_time"
            type="time"
            value={formData.start_time}
            onChange={(e) => onField("start_time", e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="end_time" style={labelStyle}>End time</label>
          <input
            id="end_time"
            type="time"
            value={formData.end_time}
            onChange={(e) => onField("end_time", e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>
      {timeRangeInvalid && (
        <div style={{ marginTop: -10, marginBottom: 14, color: "#b53737", fontSize: 13 }}>
          End time has to be after start time.
        </div>
      )}

      <div style={fieldGroup}>
        <label htmlFor="first_session_date" style={labelStyle}>First session date</label>
        <input
          id="first_session_date"
          type="date"
          value={formData.first_session_date}
          onChange={(e) => onField("first_session_date", e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={{ display: "flex", gap: 12, ...fieldGroup }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="session_count" style={labelStyle}>Number of sessions</label>
          <input
            id="session_count"
            type="number"
            min={1}
            value={formData.session_count ?? ""}
            onChange={(e) => onField("session_count", Number(e.target.value) || 0)}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="max_capacity" style={labelStyle}>Max students</label>
          <input
            id="max_capacity"
            type="number"
            min={1}
            value={formData.max_capacity ?? ""}
            onChange={(e) => onField("max_capacity", Number(e.target.value) || 0)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Age / grade range */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Who is this for?</label>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 13 }}>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="radio"
              name="age_format"
              checked={formData.age_format === "grade"}
              onChange={() => onField("age_format", "grade")}
            />
            Grades
          </label>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="radio"
              name="age_format"
              checked={formData.age_format === "age"}
              onChange={() => onField("age_format", "age")}
            />
            Ages
          </label>
        </div>
        {formData.age_format === "grade" ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number" min={0} max={12}
              value={formData.grade_min ?? ""}
              onChange={(e) => onField("grade_min", Number(e.target.value) || 0)}
              style={{ ...inputStyle, width: 80 }}
              aria-label="Grade min"
            />
            <span style={{ color: MUTED }}>to</span>
            <input
              type="number" min={0} max={12}
              value={formData.grade_max ?? ""}
              onChange={(e) => onField("grade_max", Number(e.target.value) || 0)}
              style={{ ...inputStyle, width: 80 }}
              aria-label="Grade max"
            />
            <span style={{ color: MUTED, fontSize: 13, marginLeft: 8 }}>(K = 0)</span>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number" min={0} max={99}
              value={formData.age_min ?? ""}
              onChange={(e) => onField("age_min", Number(e.target.value) || null)}
              style={{ ...inputStyle, width: 80 }}
              aria-label="Age min"
            />
            <span style={{ color: MUTED }}>to</span>
            <input
              type="number" min={0} max={99}
              value={formData.age_max ?? ""}
              onChange={(e) => onField("age_max", Number(e.target.value) || null)}
              style={{ ...inputStyle, width: 80 }}
              aria-label="Age max"
            />
            <span style={{ color: MUTED, fontSize: 13, marginLeft: 8 }}>years old</span>
          </div>
        )}
      </div>

      <div style={fieldGroup}>
        <label htmlFor="short_description" style={labelStyle}>
          Short description <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="short_description"
          value={formData.short_description}
          onChange={(e) => onField("short_description", e.target.value)}
          rows={2}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
          placeholder="A sentence or two for families. Auto-filled from the offering if you left it blank."
        />
      </div>

      {/* Live preview */}
      <div style={{
        marginTop: 24, padding: "16px 18px",
        background: CREAM, border: `1px solid ${RULE}`, borderRadius: 10,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 8 }}>
          Session dates preview
        </div>
        {previewLoading && (
          <div style={{ color: MUTED, fontSize: 13 }}>Working it out…</div>
        )}
        {!previewLoading && previewError && (
          <div style={{ color: "#b53737", fontSize: 13 }}>
            Couldn't generate preview: {previewError}
          </div>
        )}
        {!previewLoading && !previewError && !previewDates && (
          <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
            Pick a first session date and number of sessions and I'll show
            you the actual dates, with school closures left out.
          </div>
        )}
        {!previewLoading && !previewError && previewDates && previewDates.length > 0 && (
          <>
            <PreviewBody
              dates={previewDates}
              expectedCount={formData.session_count}
              showAll={showAllDates}
              onToggle={() => setShowAllDates((s) => !s)}
            />
            {confirmationSource && (
              <div style={{
                marginTop: 10, fontSize: 13,
                color: SOFT_GREEN_INK, lineHeight: 1.5,
              }}>
                ✓ Confirmed through{" "}
                {confirmationSource.kind === "district"
                  ? <>your uploaded <strong>{confirmationSource.name}</strong> school calendar</>
                  : "this location's saved closures"}
                .
              </div>
            )}
          </>
        )}
        {!previewLoading && !previewError && previewDates && previewDates.length === 0 && (
          <div style={{ color: SOFT_AMBER_INK, fontSize: 13, lineHeight: 1.5 }}>
            I couldn't fit your sessions in. There might be too many closures
            on this day of the week, or the term might be too short.
          </div>
        )}
      </div>

      {/* Calendar soft warn */}
      {calendarWarning && (
        <div style={{
          marginTop: 12, padding: "12px 14px",
          background: SOFT_AMBER_BG, border: `1px solid ${SOFT_AMBER_BORDER}`,
          borderRadius: 8, fontSize: 13, color: SOFT_AMBER_INK, lineHeight: 1.5,
        }}>
          This location is in <strong>{calendarWarning.district}</strong> but I
          don't have that district's calendar for {calendarWarning.schoolYear} yet,
          so I can't skip school holidays automatically.{" "}
          <Link
            to="/admin/calendars"
            style={{ color: SOFT_AMBER_INK, textDecoration: "underline" }}
          >
            Add it now
          </Link>{" "}
          (or keep going and I'll add days manually later).
        </div>
      )}

      {/* Conflict soft warn */}
      {conflicts.length > 0 && (
        <div style={{
          marginTop: 12, padding: "12px 14px",
          background: SOFT_AMBER_BG, border: `1px solid ${SOFT_AMBER_BORDER}`,
          borderRadius: 8, fontSize: 13, color: SOFT_AMBER_INK, lineHeight: 1.5,
        }}>
          Heads up — you already have {conflicts.length === 1 ? "a program" : `${conflicts.length} programs`} at
          this location on the same day during this time window:{" "}
          {conflicts.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? "; " : ""}
              <strong>{c.curriculum}</strong> ({c.start_time}–{c.end_time})
            </span>
          ))}.
          If that's intentional (two programs running side by side), keep going.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Registration-mode radio option (Step 3).
// ---------------------------------------------------------------
function RegModeOption({ checked, onChange, disabled, title, desc }) {
  return (
    <label style={{
      display: "flex", gap: 10, alignItems: "flex-start",
      cursor: disabled ? "default" : "pointer",
      padding: "10px 12px", borderRadius: 8,
      border: `1.5px solid ${checked ? BRIGHT : RULE}`,
      background: checked ? "#f6f4ff" : "#fff",
    }}>
      <input
        type="radio"
        name="registration_mode"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{ marginTop: 2 }}
      />
      <span>
        <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: INK }}>{title}</span>
        <span style={{ display: "block", fontSize: 12.5, color: MUTED, lineHeight: 1.45, marginTop: 2 }}>{desc}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------
// Step 3 — Price & open
// ---------------------------------------------------------------
function Step3PriceAndOpen({
  formData,
  onField,
  submitting,
  submitError,
  savedProgramId,
  savedAsStatus,
  orgSlug,
  orgActiveTerm,
  onSubmit,
  onBackToPrograms,
  step3Valid,
}) {
  const isPartner = formData.runs_own_registration;

  // Dollars display — formData.price_cents is the canonical store.
  const dollars = formData.price_cents == null ? "" : (formData.price_cents / 100).toFixed(2);

  function handlePriceChange(value) {
    if (value === "" || value === null) {
      onField("price_cents", null);
      return;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    onField("price_cents", Math.round(num * 100));
  }

  // ---- Saved success state ----
  if (savedProgramId) {
    const isOpen = savedAsStatus === "open";
    // The public catalog only serves one term — a program opened for a later
    // term is scheduled but not yet registerable by families (and has no public
    // link to share). Keep the success copy honest about that.
    const inCatalogTerm = !!orgActiveTerm && formData.term === orgActiveTerm;
    const familiesCanRegister = isOpen && !isPartner && inCatalogTerm;
    let heading;
    let body;
    if (!isOpen) {
      heading = "Saved as a draft.";
      body = "Only you can see it for now. When you're ready, publish it from your program list.";
    } else if (isPartner) {
      heading = "Your program is set up.";
      body = "It's on your schedule and rosters and will be included when you match instructors. It won't show in your public catalog — the partner runs registration.";
    } else if (!inCatalogTerm) {
      heading = "Your program is scheduled.";
      body = "It's on your calendar and rosters. Families can't register yet — your public registration page covers the current term, and this is a later one. It opens to families when that term's registration begins.";
    } else {
      heading = "Your program is live.";
      body = "Families can register now. You'll see them show up on the calendar as they sign up.";
    }
    return (
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: INK, marginBottom: 8 }}>
          {heading}
        </div>
        <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>
          {body}
        </p>
        {familiesCanRegister && (
          <div style={{ marginBottom: 20 }}>
            <ShareProgram
              slug={orgSlug}
              activeTerm={orgActiveTerm}
              align="left"
              program={{ id: savedProgramId, curriculum: formData.curriculum, status: "open", term: formData.term }}
            />
          </div>
        )}
        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={onBackToPrograms}
            style={{
              padding: "10px 18px", background: BRIGHT, color: "#fff",
              border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Back to programs
          </button>
        </div>
      </div>
    );
  }

  // ---- Form state ----
  return (
    <div>
      {/* Who runs registration? Drives whether this program is publicly
          registerable (enrops) or partner-managed (scheduled but no checkout). */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Who runs registration?</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <RegModeOption
            checked={!isPartner}
            onChange={() => onField("runs_own_registration", false)}
            disabled={submitting}
            title="We run registration"
            desc="Families sign up and pay through your public catalog."
          />
          <RegModeOption
            checked={isPartner}
            onChange={() => onField("runs_own_registration", true)}
            disabled={submitting}
            title="Partner runs their own registration"
            desc="Families register with the partner, not through our checkout. It still schedules and shows on your rosters."
          />
        </div>
      </div>

      {isPartner ? (
        <div style={fieldGroup}>
          <label htmlFor="ext_url" style={labelStyle}>
            Partner's registration link <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id="ext_url"
            type="url"
            inputMode="url"
            value={formData.external_registration_url}
            onChange={(e) => onField("external_registration_url", e.target.value)}
            style={inputStyle}
            placeholder="https://…  where families sign up"
          />
          <div style={{ marginTop: 6, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
            We'll keep this on file so you can drop it into marketing emails. Add or change it any time.
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, fontSize: 13, color: INK, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!!formData.list_in_public_catalog}
              onChange={(e) => onField("list_in_public_catalog", e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Also list it on our public reg page
              <span style={{ display: "block", fontSize: 12, color: MUTED, marginTop: 2 }}>
                Off by default — the program stays off your catalog. Check this to show it with a "Register at the partner" link (needs a link above).
              </span>
            </span>
          </label>
          <div style={{ marginTop: 12, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
            When you invite these families to the portal, they'll sign your required waivers first.{" "}
            <a href="/admin/waivers" target="_blank" rel="noreferrer" style={{ color: BRIGHT, textDecoration: "none" }}>Set up waivers ↗</a>
          </div>
        </div>
      ) : (
        <div style={fieldGroup}>
          <label htmlFor="price" style={labelStyle}>Price per student</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: MUTED, fontSize: 16 }}>$</span>
            <input
              id="price"
              type="number"
              min={0}
              step="0.01"
              value={dollars}
              onChange={(e) => handlePriceChange(e.target.value)}
              style={{ ...inputStyle, maxWidth: 160 }}
              placeholder="0.00"
            />
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
            Set to 0 for a free program. You can add early-bird discounts and
            promo codes after this is created — they usually boost sign-ups.
          </div>
          <div style={{ marginTop: 12, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
            Families will read and sign your required waivers during checkout.{" "}
            <a href="/admin/waivers" target="_blank" rel="noreferrer" style={{ color: BRIGHT, textDecoration: "none" }}>Set up waivers ↗</a>
          </div>
        </div>
      )}

      <div style={{
        marginTop: 24, padding: "16px 18px",
        background: CREAM, border: `1px solid ${RULE}`, borderRadius: 10,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 8 }}>
          Ready to publish?
        </div>
        <p style={{ margin: "0 0 14px", color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
          {isPartner
            ? "Adding this puts it on your schedule and rosters so you can match instructors. Saving as a draft keeps it private until you're ready."
            : "Opening registration puts this program in your public catalog so families can sign up. Saving as a draft keeps it private — you can publish from the program list anytime."}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => onSubmit("open")}
            disabled={submitting || !step3Valid}
            style={{
              padding: "10px 18px", background: BRIGHT, color: "#fff",
              border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
              cursor: submitting || !step3Valid ? "not-allowed" : "pointer",
              opacity: submitting || !step3Valid ? 0.5 : 1,
            }}
          >
            {submitting ? "Working…" : isPartner ? "Add to schedule" : "Open registration"}
          </button>
          <button
            onClick={() => onSubmit("draft")}
            disabled={submitting || !step3Valid}
            style={{
              padding: "10px 18px", background: "#fff", color: BRIGHT,
              border: `1.5px solid ${BRIGHT}`, borderRadius: 8,
              fontSize: 14, fontWeight: 600,
              cursor: submitting || !step3Valid ? "not-allowed" : "pointer",
              opacity: submitting || !step3Valid ? 0.5 : 1,
            }}
          >
            Save as draft
          </button>
        </div>
      </div>

      {submitError && (
        <div style={{
          marginTop: 14, padding: "10px 12px",
          background: "#fef2f2", border: "1px solid #fecaca",
          borderRadius: 8, color: "#991b1b", fontSize: 13, lineHeight: 1.5,
        }}>
          Couldn't save: {submitError}
        </div>
      )}
    </div>
  );
}

function PreviewBody({ dates, expectedCount, showAll, onToggle }) {
  const first = dates[0];
  const last = dates[dates.length - 1];
  const skipped = expectedCount > dates.length ? expectedCount - dates.length : 0;
  const visible = showAll ? dates : dates.slice(0, 6);
  return (
    <div>
      <div style={{ fontSize: 14, color: INK, lineHeight: 1.5 }}>
        <strong>{dates.length} session{dates.length === 1 ? "" : "s"}</strong>
        {" "}from {formatDate(first)} to {formatDate(last)}.
        {skipped > 0 && (
          <span style={{ color: MUTED }}> ({skipped} potential date{skipped === 1 ? "" : "s"} skipped for closures.)</span>
        )}
      </div>
      <div style={{
        marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6,
      }}>
        {visible.map((d) => (
          <span
            key={d}
            style={{
              padding: "3px 8px", background: "#fff",
              border: `1px solid ${RULE}`, borderRadius: 6,
              fontSize: 12, color: INK,
            }}
          >
            {formatDate(d)}
          </span>
        ))}
      </div>
      {dates.length > 6 && (
        <button
          type="button"
          onClick={onToggle}
          style={{
            marginTop: 10, background: "none", border: "none",
            color: PURPLE, fontSize: 13, cursor: "pointer", padding: 0,
            textDecoration: "underline",
          }}
        >
          {showAll ? "Show fewer" : `Show all ${dates.length}`}
        </button>
      )}
    </div>
  );
}
