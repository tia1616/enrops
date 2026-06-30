// /admin/programs
// Calendar/list view of scheduled programs for a selected term.
// Row-level "Change class" affordance lets an admin swap a program's curriculum.
// Live enrollment count = registrations.payment_status='paid' (excluding cancelled).
// Multi-tenant: scoped by the caller's organization_id.
//
// Two view modes:
//   - calendar: programs grouped by day-of-week, sorted by start_time (default)
//   - by_school: programs grouped by program_location, sorted by day/time within school

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import EditProgramCurriculumModal from "./EditProgramCurriculumModal.jsx";
import ShareProgram from "../../../components/ShareProgram.jsx";
import ShareLink from "../../../components/ShareLink.jsx";
import { buildCatalogUrl } from "../../../lib/regLinks.js";
import { fetchOrgTerms, formatTermLabel } from "../../../lib/terms.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const AMBER = "#a16207";
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

export default function ProgramsCalendar() {
  const { org } = useOutletContext();
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
    if (!confirm("Publish this program? It'll show in marketing campaigns and the public catalog.")) return;
    const { error: pubErr } = await supabase
      .from("programs")
      .update({ status: "open" })
      .eq("id", programId);
    if (pubErr) {
      alert(`Couldn't publish: ${pubErr.message}`);
      return;
    }
    setPrograms((prev) => prev.map((p) => (p.id === programId ? { ...p, status: "open" } : p)));
  }

  // Flip open → draft so the operator can pause a program without deleting it
  // (a typo, a rethink, a cancellation in negotiation). Hides it from the
  // public catalog and marketing audience filters again.
  async function unpublishProgram(programId) {
    if (!confirm("Unpublish this program? It'll be hidden from the public catalog and stop appearing in marketing campaigns. Existing registrations are unaffected.")) return;
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
      const { data } = await supabase
        .from("program_locations")
        .select("id, name, district")
        .eq("organization_id", org.id)
        .order("name");
      if (alive) setLocationsForPicker(data ?? []);
    })();
    return () => { alive = false; };
  }, [org?.id]);
  const [sessionDatesByProgram, setSessionDatesByProgram] = useState({});
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
            runs_own_registration, external_registration_url, list_in_public_catalog,
            first_session_date, session_count,
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

        // Batch-fetch derived session dates for every program in this term.
        // Wraps derive_program_session_dates() which skips district closures
        // and location closure_dates. RLS-gated via SECURITY INVOKER.
        let datesByProgram = {};
        try {
          const { data: datesRows, error: datesErr } = await supabase.rpc(
            "programs_with_session_dates",
            { p_organization_id: org.id, p_term: term },
          );
          if (datesErr) throw datesErr;
          for (const r of datesRows ?? []) {
            datesByProgram[r.program_id] = Array.isArray(r.session_dates) ? r.session_dates : [];
          }
        } catch (e) {
          // Don't break the page if dates can't load — the rest of the program
          // info is still useful. Just log so we notice.
          console.warn("Couldn't load derived session dates:", e?.message ?? e);
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Scheduled programs</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            What's running this term, by day or by school. Live enrollment numbers.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {org?.slug && (
            <ShareLink
              url={buildCatalogUrl(org.slug)}
              align="right"
              buttonLabel="Share registration page"
              panelTitle="Your registration page"
              description="One link to all your open programs — families pick a class and sign up. Put it in your bio, an email, or a flyer."
              qrFileBase="registration-page"
            />
          )}
          <Link
            to="/admin/programs/new"
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
          <div style={toggleGroup}>
            <button onClick={() => setViewMode("calendar")} style={viewMode === "calendar" ? toggleBtnActive : toggleBtn}>Calendar</button>
            <button onClick={() => setViewMode("by_school")} style={viewMode === "by_school" ? toggleBtnActive : toggleBtn}>By school</button>
          </div>
        </div>
      </div>

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

      {loading && <div style={{ color: MUTED, padding: 12 }}>Loading {term ? `${term} ` : ""}programs…</div>}
      {error && <div style={errorBox}>Could not load programs: {error}</div>}
      {!loading && !error && programs.length === 0 && (
        <div style={emptyState}>No programs scheduled{term ? ` for ${term}` : ""} yet.</div>
      )}

      {!loading && !error && programs.length > 0 && (
        viewMode === "calendar"
          ? <CalendarView
              programs={programs}
              enrollment={enrollmentByProgram}
              sessionDatesByProgram={sessionDatesByProgram}
              calendarCoverage={calendarCoverage}
              expandedDates={expandedDates}
              onToggleDates={toggleDatesExpanded}
              onEdit={setEditingProgram}
              onEditFacility={setEditingFacility}
              onPublish={publishProgram}
              onUnpublish={unpublishProgram}
              onDelete={deleteProgram}
              onUpdate={updateProgramFields}
              locations={locationsForPicker}
              orgSlug={org?.slug}
              orgActiveTerm={org?.active_registration_term}
            />
          : <BySchoolView
              programs={programs}
              enrollment={enrollmentByProgram}
              sessionDatesByProgram={sessionDatesByProgram}
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
          program={editingProgram}
          org={org}
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

function CalendarView({ programs, enrollment, sessionDatesByProgram, calendarCoverage, expandedDates, onToggleDates, onEdit, onEditFacility, onPublish, onUnpublish, onDelete, onUpdate, locations, orgSlug, orgActiveTerm }) {
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
              districtHasCalendar={districtHasCal(p, calendarCoverage)}
              isDatesExpanded={expandedDates?.has(p.id)}
              onToggleDates={onToggleDates}
              onEdit={onEdit}
              onEditFacility={onEditFacility}
              onPublish={onPublish}
              onUnpublish={onUnpublish}
              onDelete={onDelete}
              onUpdate={onUpdate}
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

function BySchoolView({ programs, enrollment, sessionDatesByProgram, calendarCoverage, expandedDates, onToggleDates, onToggleSchool, onEdit, onEditFacility, onPublish, onUnpublish, onDelete, onUpdate, locations, orgSlug, orgActiveTerm }) {
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
                districtHasCalendar={districtHasCal(p, calendarCoverage)}
                isDatesExpanded={expandedDates?.has(p.id)}
                onToggleDates={onToggleDates}
                onEdit={onEdit}
                onEditFacility={onEditFacility}
                onPublish={onPublish}
                onUnpublish={onUnpublish}
                onDelete={onDelete}
                onUpdate={onUpdate}
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
    const dates = sessionDatesByProgram?.[p.id] ?? [];
    totalSessions += dates.length;
    for (const d of dates) {
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

function ProgramRow({ program: p, e, sessionDates, districtHasCalendar, isDatesExpanded, onToggleDates, onEdit, onEditFacility, onPublish, onUnpublish, onDelete, onUpdate, locations, orgSlug, orgActiveTerm, showDay = false }) {
  const enr = e ?? { paid: 0, unpaid: 0, pending: 0 };
  const enrolled = enr.paid + enr.unpaid;
  const capacity = p.max_capacity ?? 0;
  const pct = capacity > 0 ? Math.min(1, enrolled / capacity) : 0;
  const isFull = capacity > 0 && enrolled >= capacity;
  const fillColor = isFull ? BRIGHT : pct >= 0.7 ? VIOLET : "#a8c47f";
  const isDraft = p.status === "draft";

  const breakdownParts = [];
  if (enr.paid > 0) breakdownParts.push(`${enr.paid} paid`);
  if (enr.unpaid > 0) breakdownParts.push(`${enr.unpaid} on installments`);
  if (enr.pending > 0) breakdownParts.push(`+${enr.pending} pending`);
  const breakdown = breakdownParts.join(" · ");

  const datesArr = Array.isArray(sessionDates) ? sessionDates : [];
  const hasDates = datesArr.length > 0;
  const dateCountLabel = hasDates
    ? `${datesArr.length} session${datesArr.length === 1 ? "" : "s"}`
    : "No dates";

  return (
    <>
    <div style={{
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
              )}
            </>
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
          <FacilityPill program={p} onClick={() => onEditFacility?.(p)} />
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
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(p)}
            style={editLinkStyle}
            title="Change the class for this program"
          >
            Change class
          </button>
        )}
      </div>
    </div>
    {isDatesExpanded && (
      <ExpandedProgramPanel
        program={p}
        dates={datesArr}
        districtHasCalendar={districtHasCalendar}
        onUpdate={onUpdate}
        onPublish={onPublish}
        onUnpublish={onUnpublish}
        onDelete={onDelete}
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
function ExpandedProgramPanel({ program, dates, districtHasCalendar, onUpdate, onPublish, onUnpublish, onDelete, locations, orgSlug, orgActiveTerm }) {
  // Local draft so the operator can edit several fields and save in one go
  // (avoid round-tripping the DB on every keystroke).
  const [draft, setDraft] = useState({
    day_of_week: program.day_of_week ?? "",
    // Stored as 12-hour text ("2:45 PM"); <input type="time"> needs 24-hour.
    start_time: to24h(program.start_time),
    end_time: to24h(program.end_time),
    first_session_date: program.first_session_date ?? "",
    session_count: program.session_count ?? "",
    max_capacity: program.max_capacity ?? "",
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

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
    setSaveError(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const patch = {
        day_of_week: draft.day_of_week || null,
        // Convert the 24-hour input values back to the stored 12-hour text format.
        start_time: draft.start_time ? to12hText(draft.start_time) : null,
        end_time: draft.end_time ? to12hText(draft.end_time) : null,
        first_session_date: draft.first_session_date || null,
        session_count: draft.session_count === "" || draft.session_count === null ? null : Number(draft.session_count),
        max_capacity: draft.max_capacity === "" || draft.max_capacity === null ? null : Number(draft.max_capacity),
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
      await onUpdate(program.id, patch);
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

  return (
    <div style={{
      padding: "14px 16px 16px 16px",
      background: "#fafaf5",
      borderBottom: `1px solid ${RULE}`,
      fontSize: 13,
    }}>
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
          <select value={draft.day_of_week ?? ""} onChange={(e) => set("day_of_week", e.target.value)} style={expandInputStyle}>
            <option value="">—</option>
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={d}>{DAY_LABELS[d]}</option>
            ))}
          </select>
        </ExpandField>
        <ExpandField label="Start time">
          <input type="time" value={draft.start_time ?? ""} onChange={(e) => set("start_time", e.target.value)} style={expandInputStyle} />
        </ExpandField>
        <ExpandField label="End time">
          <input type="time" value={draft.end_time ?? ""} onChange={(e) => set("end_time", e.target.value)} style={expandInputStyle} />
        </ExpandField>
        <ExpandField label="First session">
          <input type="date" value={draft.first_session_date ?? ""} onChange={(e) => set("first_session_date", e.target.value)} style={expandInputStyle} />
        </ExpandField>
        <ExpandField label="Sessions">
          <input type="number" min="1" max="40" value={draft.session_count ?? ""} onChange={(e) => set("session_count", e.target.value)} style={expandInputStyle} />
        </ExpandField>
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
        <ExpandField label="Location">
          <select value={draft.program_location_id ?? ""} onChange={(e) => set("program_location_id", e.target.value)} style={expandInputStyle}>
            <option value="">— pick a location —</option>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.district ? ` (${l.district})` : ""}</option>
            ))}
          </select>
        </ExpandField>
        <ExpandField label="Room">
          <input type="text" value={draft.room ?? ""} onChange={(e) => set("room", e.target.value)} placeholder="e.g. Room 12" style={expandInputStyle} />
        </ExpandField>
      </div>

      {/* Registration ownership — who collects sign-ups for this program. */}
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

      {saveError && (
        <div style={{ background: "#fde7e7", color: "#b53737", padding: "8px 12px", borderRadius: 6, fontSize: 12.5, marginBottom: 10 }}>
          Couldn't save: {saveError}
        </div>
      )}

      {/* Action row: Save · Publish/Unpublish · Delete */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            background: BRIGHT, color: "#fff", border: "none", padding: "8px 16px",
            borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1,
          }}
        >{saving ? "Saving…" : "Save changes"}</button>
        {savedFlash && <span style={{ color: OK_GREEN, fontWeight: 600, fontSize: 12 }}>✓ Saved</span>}

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

        <div style={{ flex: 1 }} />

        {isDraft && (
          <button
            type="button"
            onClick={() => onPublish?.(program.id)}
            style={{
              background: OK_GREEN, color: "#fff", border: "none", padding: "8px 14px",
              borderRadius: 6, fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
            }}
            title="Publish — show in catalog + marketing"
          >Publish →</button>
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

      {/* Session dates view (existing) */}
      <SessionDatesPanel program={program} dates={dates} districtHasCalendar={districtHasCalendar} inline />
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

function SessionDatesPanel({ program, dates, districtHasCalendar, inline = false }) {
  const [copied, setCopied] = useState(false);

  function copyList() {
    const text = dates.map(formatSessionDate).join("\n");
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => { /* clipboard blocked — ignore */ },
    );
  }

  const district = program.program_locations?.district ?? null;
  // Free-text district may be absent once a school is linked structurally;
  // fall back to a generic label so the warning never reads "... for  —".
  const districtLabel = district || "this school's district";
  const showMissingCalendarWarning = districtHasCalendar === false;

  // No dates to show? Skip the panel entirely.
  if (!Array.isArray(dates) || dates.length === 0) {
    if (inline) return null;
    return null;
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
          Session dates · {dates.length}
        </div>
        <div style={{ fontSize: 12, color: MUTED }}>
          Derived from this program's first session, day of week, and the {district || "location"} school calendar.
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
      </div>
      <div style={{ fontSize: 13, color: INK, marginBottom: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div>
          <span style={{ color: MUTED, fontWeight: 600 }}>Instructor: </span>
          {program.instructor_name
            ? <span>{program.instructor_name}</span>
            : <span style={{ color: MUTED, fontStyle: "italic" }}>Not assigned yet</span>}
        </div>
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
        {dates.map((d) => (
          <div key={d} style={{ color: INK, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
            {formatSessionDate(d)}
          </div>
        ))}
      </div>
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
