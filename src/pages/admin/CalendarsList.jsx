// src/pages/admin/CalendarsList.jsx
// Admin list + editor for district_calendars. Each calendar source is a row
// for one (district, school_year) combination. Districts are auto-discovered
// from program_locations.district — the operator picks a district and either
// extracts the no-school dates from a PDF URL / upload, or enters them by
// hand. Calendars drive derive_program_session_dates() for every program in
// that district, which in turn feeds the parent portal, instructor schedules,
// automation emails, and (later) facility-reservation flyers.
//
// Multi-tenant: all reads + writes scoped by org from useOutletContext.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import EarlyReleaseChoice from "./EarlyReleaseChoice.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CORAL = "#D9694F";
const OK_GREEN = "#3a7c3a";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const AMBER = "#a16207";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Collapsible help: a clickable question that reveals a short answer.
const helpDetails = {
  background: "#faf7ed",
  border: "1px solid #ece1bf",
  borderRadius: 12,
  padding: "10px 16px",
  fontSize: 13.5,
  color: INK,
  maxWidth: 820,
};
const helpSummary = {
  cursor: "pointer",
  fontWeight: 700,
  color: PURPLE,
  fontSize: 13.5,
};

function defaultSchoolYear(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0 = Jan
  // April or later → admins are planning the next school year (FA setup,
  // facility reservations, etc.). Before April → current year still active.
  return m >= 3 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function schoolYearChoices(today = new Date()) {
  const def = defaultSchoolYear(today);
  const [a, b] = def.split("-").map(Number);
  return [
    `${a - 1}-${b - 1}`,
    `${a}-${b}`,
    `${a + 1}-${b + 1}`,
  ];
}

function formatDateLabel(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function formatRelativeDate(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function CalendarsList() {
  const { org } = useOutletContext() ?? {};
  const isLean = org?.instructor_pay_model === "enrops_platform";
  // Districts are discovered from each school's District field, which lives on
  // the venue surface - named "Locations" for every venue_model as of 2026-08-05
  // (mirror of AdminLayout's nav label; was Locations/Partners by venue_model).
  const venueLabel = "Locations";
  const [schoolYear, setSchoolYear] = useState(defaultSchoolYear());
  const [districts, setDistricts] = useState([]); // merged rows: [{ key, label, districtId, calendarKey, location_count }]
  const [calendars, setCalendars] = useState([]); // district_calendars rows for current school year
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { key } | null
  // Shown in the district's row straight after its calendar is saved, when that
  // calendar has occasional early-release days landing on a class's weekday.
  // Asked here rather than buried in Scheduled Programs because this is the
  // moment the dates arrive and the operator has the context in front of them.
  const [erPrompt, setErPrompt] = useState(null); // { key } | null
  const [viewing, setViewing] = useState(() => new Set()); // row keys currently showing their dates inline
  const [topError, setTopError] = useState(null);
  // Schools with no district at all, which this page could not previously offer a
  // calendar for. See the filter in loadAll.
  const [ownCalendarCandidates, setOwnCalendarCandidates] = useState([]);
  const [creatingFor, setCreatingFor] = useState(null); // school id mid-create

  // Give ONE school its own calendar source. This is the whole point of
  // district_type: the row it creates is a calendar target exactly like a district
  // (so upload, parse, early release and derive_program_session_dates all work with
  // no special case), but it is typed independent_school so the public registration
  // picker groups it under "Other schools & sites" instead of giving a single
  // private school its own district heading.
  async function giveSchoolItsOwnCalendar(school) {
    setCreatingFor(school.id);
    setTopError(null);
    try {
      const { data: created, error: dErr } = await supabase
        .from("districts")
        .insert({
          organization_id: org.id,
          name: school.name,
          district_type: "independent_school",
        })
        .select("id")
        .single();
      if (dErr) throw dErr;

      // Targeted single-field update, not a whole-row write: this screen holds none
      // of the school's other columns (arrival notes, contacts, room) and writing a
      // whole row from here would blank whatever it did not load. Org-scoped too, so
      // it cannot reach another tenant's row even if an id were wrong.
      const { error: lErr } = await supabase
        .from("program_locations")
        .update({ district_id: created.id })
        .eq("id", school.id)
        .eq("organization_id", org.id);
      if (lErr) throw lErr;

      await loadAll();
    } catch (e) {
      console.error("Give school its own calendar failed:", e);
      setTopError(`Couldn't set that school up: ${e.message ?? "unknown error"}`);
    } finally {
      setCreatingFor(null);
    }
  }

  function toggleViewing(key) {
    setViewing((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  useEffect(() => {
    if (!org?.id) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, schoolYear]);

  async function loadAll() {
    setLoading(true);
    setTopError(null);
    try {
      const [locsRes, calsRes, distRes] = await Promise.all([
        // id + name as well as the district link, because a school with NEITHER a
        // district_id nor a legacy free-text district has to be offered its own
        // calendar below, and that needs its name to create the row and its id to
        // link it.
        supabase
          .from("program_locations")
          .select("id, name, district, district_id")
          .eq("organization_id", org.id),
        supabase
          .from("district_calendars")
          .select("*")
          .eq("organization_id", org.id)
          .eq("school_year", schoolYear),
        supabase
          .from("districts")
          .select("id, name, calendar_key")
          .eq("organization_id", org.id),
      ]);
      if (locsRes.error) throw locsRes.error;
      if (calsRes.error) throw calsRes.error;
      if (distRes.error) throw distRes.error;

      const locs = locsRes.data ?? [];
      const structured = distRes.data ?? [];

      // Structured districts (the entity) — count schools linked via district_id.
      const linkedCounts = new Map();
      for (const r of locs) {
        if (r.district_id) linkedCounts.set(r.district_id, (linkedCounts.get(r.district_id) ?? 0) + 1);
      }
      const structuredRows = structured.map((d) => ({
        key: `d:${d.id}`,
        label: d.name,
        districtId: d.id,
        calendarKey: d.calendar_key ?? null,
        location_count: linkedCounts.get(d.id) ?? 0,
      }));

      // Legacy free-text districts (from program_locations.district) that are
      // NOT already represented by a structured district — matched by name or
      // calendar_key. Kept so calendars uploaded before districts existed still
      // appear until the operator formalizes them.
      const coveredText = new Set();
      for (const d of structured) {
        if (d.name) coveredText.add(d.name.trim().toLowerCase());
        if (d.calendar_key) coveredText.add(d.calendar_key.trim().toLowerCase());
      }
      const textCounts = new Map();
      for (const r of locs) {
        const d = (r.district ?? "").trim();
        if (!d || coveredText.has(d.toLowerCase())) continue;
        textCounts.set(d, (textCounts.get(d) ?? 0) + 1);
      }
      const legacyRows = [...textCounts.entries()].map(([label, location_count]) => ({
        key: `t:${label}`,
        label,
        districtId: null,
        calendarKey: null,
        location_count,
      }));

      const merged = [...structuredRows, ...legacyRows].sort((a, b) => a.label.localeCompare(b.label));
      setDistricts(merged);
      setCalendars(calsRes.data ?? []);

      // Schools this page could not offer a calendar for AT ALL: no district_id and
      // no legacy free-text district either, so they appear in neither list above.
      // Before 17 Aug the only route was to invent a district for them, which this
      // page's own empty state used to instruct - and inventing one is what put four
      // single-school "districts" in front of J2S families in the registration
      // picker. Now they get their own calendar source, typed independent_school so
      // the picker keeps them in one shared bucket (20260817a).
      //
      // Counted on prod 17 Aug: 12 of J2S's 63 sites, 3 of Jeff's 23, all 4 of
      // play-fit-fun's and both of shoreview-chess's.
      setOwnCalendarCandidates(
        (locs || [])
          .filter((r) => !r.district_id && !(r.district ?? "").trim())
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      );
    } catch (e) {
      console.error("Load calendars failed:", e);
      setTopError(`Couldn't load: ${e.message ?? "unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  // A calendar matches a structured district by district_id (or its legacy
  // calendar_key while it hasn't been stamped yet); a legacy row matches by the
  // free-text district string on an unstamped calendar.
  function calendarForRow(row) {
    if (row.districtId) {
      return calendars.find(
        (c) => c.district_id === row.districtId
          || (row.calendarKey && !c.district_id && c.district === row.calendarKey),
      ) ?? null;
    }
    return calendars.find((c) => !c.district_id && c.district === row.label) ?? null;
  }

  if (!org) return <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <style>{`@keyframes calendarWaitPulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }`}</style>
      <header style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 12,
        padding: "18px 22px",
        display: "flex",
        flexWrap: "wrap",
        gap: 16,
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>School calendars</h1>
          {/* Registration operators get the plain version: what it does for
              them, no facility-booking references (not part of this release)
              and no vendor names. */}
          <div style={{ color: MUTED, marginTop: 4, fontSize: 14, maxWidth: 720 }}>
            {isLean
              ? <>One calendar per district per school year. Your class dates skip that district&rsquo;s no-school and early-release days automatically.</>
              : <>One calendar per district per school year. No-school and early-release dates feed every program&rsquo;s session schedule — what parents see and what shows up on instructor calendars.</>}
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>
            School year
          </span>
          <select
            value={schoolYear}
            onChange={(e) => setSchoolYear(e.target.value)}
            style={selectStyle}
          >
            {schoolYearChoices().map((sy) => (
              <option key={sy} value={sy}>{sy}</option>
            ))}
          </select>
        </label>
      </header>

      {/* Help is collapsed by default (Jessica: too much text on screen). Each
          question is clickable and reveals a short answer - native <details> so
          it's accessible and needs no state. */}
      <details style={helpDetails}>
        <summary style={helpSummary}>How do I set this up?</summary>
        <ol style={{ margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.55 }}>
          <li>Pick the district for each of your schools under <strong>{venueLabel}</strong>, then choose that district below.</li>
          <li>Add its no-school days: <strong>upload a PDF</strong>, <strong>paste a link or the text</strong>, or <strong>type them in</strong>.</li>
          <li>Every class in that district then skips those days automatically.</li>
        </ol>
      </details>

      <details style={helpDetails}>
        <summary style={helpSummary}>How do early-release days work?</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.55 }}>
          <li>Pulled from the <strong>school calendar</strong> you add above — or add them by hand in the <strong>Early-release days</strong> list below.</li>
          <li><strong>Every week</strong> (e.g. every Wednesday)? Class still meets &mdash; set the program time for just after dismissal.</li>
          <li><strong>Some weeks only?</strong> We skip those like a no-school day.</li>
          <li>Needs the district&rsquo;s <strong>first &amp; last day of school</strong> set below.</li>
        </ul>
      </details>

      {topError && <div style={errorBanner}>{topError}</div>}

      {loading ? (
        <div style={{ color: MUTED, fontSize: 14, padding: 16 }}>Loading…</div>
      ) : districts.length === 0 && ownCalendarCandidates.length === 0 ? (
        <div style={emptyState}>
          No schools yet. Add one under <strong>{venueLabel}</strong>, then come back here to give
          it a calendar &mdash; either its district&rsquo;s, or its own if it doesn&rsquo;t follow one.
        </div>
      ) : districts.length === 0 ? (
        // Schools exist but none has a calendar source yet. This used to read "No
        // districts yet. Give a school a District ... then come back here", which
        // instructed the operator to invent a district for a private school - the
        // exact thing that put four one-school district headings in front of J2S
        // families. The list below is now the answer instead.
        <div style={emptyState}>
          None of your schools has a calendar yet. If a school follows a district calendar, set its{" "}
          <strong>District</strong> under <strong>{venueLabel}</strong>. If it doesn&rsquo;t &mdash; a
          private, charter or independent school &mdash; give it its own calendar below.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {districts.map((row) => {
            const cal = calendarForRow(row);
            const isEditing = editing?.key === row.key;
            return (
              <div key={row.key}>
                {erPrompt?.key === row.key ? (
                  <EarlyReleaseChoice
                    org={org}
                    districtId={row.districtId}
                    // Both keys, for the same reason the calendar row itself
                    // carries both: district_id is the structured link, and the
                    // free-text string is what a school linked before districts
                    // existed still matches on.
                    districtText={cal?.district ?? row.calendarKey ?? row.label}
                    districtLabel={row.label}
                    // Clicked "Class times" vs appeared after a save. Only
                    // governs whether "nothing to set here" is said out loud.
                    explicit={!!erPrompt.explicit}
                    onDone={async ({ changed }) => {
                      setErPrompt(null);
                      // Session dates just moved for these classes, so the
                      // counts on this page are stale.
                      if (changed) await loadAll();
                    }}
                  />
                ) : isEditing ? (
                  <CalendarEditor
                    org={org}
                    districtId={row.districtId}
                    districtLabel={row.label}
                    districtCalendarKey={row.calendarKey}
                    schoolYear={schoolYear}
                    existing={cal}
                    onClose={() => setEditing(null)}
                    onSaved={async (savedSchoolYear) => {
                      setEditing(null);
                      // Ask the early-release question now. The component works
                      // out whether there is anything to ask and closes itself
                      // if not, so this never leaves an empty row behind.
                      setErPrompt({ key: row.key });
                      // Jump the dropdown to the year just saved so the new
                      // row shows up immediately. No-op if it already matches.
                      if (savedSchoolYear && savedSchoolYear !== schoolYear) {
                        setSchoolYear(savedSchoolYear);
                        // schoolYear state change will trigger loadAll via the
                        // useEffect dependency — no need to call it here too.
                      } else {
                        await loadAll();
                      }
                    }}
                  />
                ) : (
                  <DistrictRow
                    district={row.label}
                    locationCount={row.location_count}
                    cal={cal}
                    isViewing={viewing.has(row.key)}
                    onToggleView={() => toggleViewing(row.key)}
                    onEdit={() => setEditing({ key: row.key })}
                    onEditEarlyRelease={() => setErPrompt({ key: row.key, explicit: true })}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* SCHOOLS THAT FOLLOW NOBODY'S CALENDAR. A private, charter or independent
          school has its own calendar and belongs to no district, so before 17 Aug it
          appeared nowhere on this page and the only way to give it dates was to
          invent a one-school district - which is what put "Catlin Gabel School" up
          as a district heading in front of J2S families.
          Giving it its own calendar creates a calendar source typed
          independent_school: every existing calendar mechanism treats it like a
          district, and the public picker keeps it in the shared
          "Other schools & sites" bucket instead of promoting it. */}
      {!loading && ownCalendarCandidates.length > 0 && (
        <section style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 18px" }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: INK, margin: 0 }}>
            Schools that don&rsquo;t follow a district calendar
          </h2>
          <p style={{ color: MUTED, fontSize: 13.5, margin: "6px 0 14px", lineHeight: 1.55, maxWidth: 640 }}>
            Private, charter and independent schools set their own dates, and so do libraries and
            community sites. Give one its own calendar and it works exactly like a district here
            &mdash; no-school days, early release, the lot. Families still see it grouped with your
            other non-district sites, not as a district of its own.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ownCalendarCandidates.map((s) => (
              <div
                key={s.id}
                style={{
                  display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                  border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px",
                }}
              >
                <span style={{ fontWeight: 600, color: INK, fontSize: 14, flex: "1 1 200px" }}>{s.name}</span>
                <span style={{ fontSize: 12, color: MUTED }}>No calendar yet</span>
                <button
                  type="button"
                  onClick={() => giveSchoolItsOwnCalendar(s)}
                  disabled={creatingFor === s.id}
                  style={{
                    background: creatingFor === s.id ? "#cfc6dc" : BRIGHT, color: "#fff", border: "none",
                    borderRadius: 999, padding: "7px 16px", fontSize: 13, fontWeight: 600,
                    fontFamily: "inherit", cursor: creatingFor === s.id ? "not-allowed" : "pointer",
                  }}
                >
                  {creatingFor === s.id ? "Setting up…" : "Give it its own calendar"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function isSafeHttpUrl(s) {
  if (typeof s !== "string") return false;
  return /^https?:\/\//i.test(s.trim());
}

function isCalendarConfigured(cal) {
  if (!cal) return false;
  const hasBounds = !!cal.first_day_of_school || !!cal.last_day_of_school;
  const hasDates = Array.isArray(cal.no_school_dates) && cal.no_school_dates.length > 0;
  return hasBounds || hasDates;
}

function DistrictRow({ district, locationCount, cal, isViewing, onToggleView, onEdit, onEditEarlyRelease }) {
  const noSchoolCount = Array.isArray(cal?.no_school_dates) ? cal.no_school_dates.length : 0;
  const earlyReleaseCount = Array.isArray(cal?.early_release_dates) ? cal.early_release_dates.length : 0;
  const status = isCalendarConfigured(cal) ? "configured" : cal ? "started" : "missing";
  const safeSourceUrl = isSafeHttpUrl(cal?.source_url) ? cal.source_url.trim() : null;
  const hasViewableDates = noSchoolCount > 0 || earlyReleaseCount > 0;
  return (
    <>
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      borderBottomLeftRadius: isViewing ? 0 : 8,
      borderBottomRightRadius: isViewing ? 0 : 8,
      borderBottom: isViewing ? "none" : `1px solid ${RULE}`,
      padding: "14px 20px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>{district}</div>
          <div style={{ fontSize: 12, color: MUTED }}>
            {locationCount} location{locationCount === 1 ? "" : "s"}
          </div>
          {status === "missing" ? (
            <span style={pill(AMBER)}>Needs setup</span>
          ) : status === "started" ? (
            <span style={pill(AMBER)}>Needs dates</span>
          ) : (
            <span style={pill(OK_GREEN)}>Ready</span>
          )}
        </div>
        {cal && (
          <div style={{ fontSize: 13, color: MUTED, marginTop: 4, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <span>
              <strong style={{ color: INK }}>{formatDateLabel(cal.first_day_of_school)}</strong>
              {" – "}
              <strong style={{ color: INK }}>{formatDateLabel(cal.last_day_of_school)}</strong>
            </span>
            <span>{noSchoolCount} no-school day{noSchoolCount === 1 ? "" : "s"}</span>
            {earlyReleaseCount > 0 && (
              <span>{earlyReleaseCount} early release{earlyReleaseCount === 1 ? "" : "s"}</span>
            )}
            {cal.updated_at && <span>Updated {formatRelativeDate(cal.updated_at)}</span>}
            {safeSourceUrl && (
              <a
                href={safeSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: PURPLE, textDecoration: "underline" }}
              >
                Source PDF
              </a>
            )}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {hasViewableDates && (
          <button type="button" onClick={onToggleView} style={btn("transparent", BRIGHT, true)}>
            {isViewing ? "Hide dates" : "View dates"}
          </button>
        )}
        {/* A PERMANENT WAY BACK IN. The early-release question used to appear
            only in the moment after a calendar was saved, which made it a
            one-shot: an operator who mistyped the time, or whose school moved
            its dismissal, had no way to reach it from here at all — they had to
            know that re-saving the calendar would re-ask. Jessica, 14 Aug.
            Shown whenever this calendar HAS early-release dates; the screen
            itself works out whether any class is actually affected and closes
            straight away if none is. */}
        {earlyReleaseCount > 0 && (
          <button type="button" onClick={onEditEarlyRelease} style={btn("transparent", BRIGHT, true)}>
            Class times
          </button>
        )}
        <button type="button" onClick={onEdit} style={btn(cal ? "transparent" : BRIGHT, cal ? BRIGHT : "#fff", !!cal)}>
          {cal ? "Edit" : "Add calendar"}
        </button>
      </div>
    </div>
    {isViewing && cal && <CalendarDatesView cal={cal} district={district} />}
    </>
  );
}

function CalendarDatesView({ cal, district }) {
  const noSchool = Array.isArray(cal.no_school_dates) ? cal.no_school_dates : [];
  const earlyRelease = Array.isArray(cal.early_release_dates) ? cal.early_release_dates : [];
  const [copied, setCopied] = useState(null); // 'no_school' | 'early_release' | null

  function copyDates(which, list) {
    const text = list.map((r) => `${formatDateLabel(r.date)}${r.reason ? ` - ${r.reason}` : ""}`).join("\n");
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(which);
        setTimeout(() => setCopied(null), 1500);
      },
      () => { /* clipboard blocked */ },
    );
  }

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderTop: "none",
      borderBottomLeftRadius: 8,
      borderBottomRightRadius: 8,
      padding: "14px 20px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}>
      <DateGroup
        title={`No-school days (${noSchool.length})`}
        emptyLabel="None"
        rows={noSchool}
        copied={copied === "no_school"}
        onCopy={() => copyDates("no_school", noSchool)}
      />
      <DateGroup
        title={`Early-release days (${earlyRelease.length})`}
        emptyLabel="None"
        rows={earlyRelease}
        copied={copied === "early_release"}
        onCopy={() => copyDates("early_release", earlyRelease)}
      />
    </div>
  );
}

function DateGroup({ title, emptyLabel, rows, copied, onCopy }) {
  const monthGroups = useMemo(() => groupByMonth(rows), [rows]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {title}
        </div>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={onCopy}
            style={{
              ...btn("transparent", BRIGHT, true),
              padding: "4px 10px",
              fontSize: 12,
              background: copied ? `${OK_GREEN}1F` : "transparent",
              color: copied ? OK_GREEN : BRIGHT,
              borderColor: copied ? OK_GREEN : BRIGHT,
            }}
            title="Copy this list to clipboard"
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED, fontStyle: "italic" }}>{emptyLabel}</div>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: "14px 24px",
        }}>
          {monthGroups.map(({ key, label, items }) => (
            <div key={key}>
              <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: INK,
                marginBottom: 4,
                paddingBottom: 3,
                borderBottom: `1px solid ${RULE}`,
              }}>
                {label}
                <span style={{ color: MUTED, fontWeight: 400, marginLeft: 6 }}>
                  · {items.length}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {items.map((r, i) => (
                  <div key={`${r.date}-${i}`} style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                      {formatShortDateLabel(r.date)}
                    </span>
                    {r.reason && <span style={{ color: MUTED, marginLeft: 6 }}>{r.reason}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Group {date, reason} rows by calendar month. Returns ordered array:
// [{ key: "2026-09", label: "September 2026", items: [...] }, ...]
function groupByMonth(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.date ?? "")) continue;
    const key = r.date.slice(0, 7);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  const out = [];
  const keys = [...map.keys()].sort();
  for (const key of keys) {
    const [y, m] = key.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, 1));
    const label = dt.toLocaleDateString(undefined, { timeZone: "UTC", month: "long", year: "numeric" });
    const items = map.get(key).slice().sort((a, b) => a.date.localeCompare(b.date));
    out.push({ key, label, items });
  }
  return out;
}

// Shorter than formatDateLabel — used inside month-grouped lists where the
// month + year is already shown as the heading. e.g. "Mon, Nov 26"
function formatShortDateLabel(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

function CalendarEditor({ org, districtId, districtLabel, districtCalendarKey, schoolYear, existing, onClose, onSaved }) {
  const [extracting, setExtracting] = useState(false);
  const [extractStartedAt, setExtractStartedAt] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [extractError, setExtractError] = useState(null);
  const [extractRaw, setExtractRaw] = useState(null);
  const [extractMode, setExtractMode] = useState("url");
  const [urlInput, setUrlInput] = useState(existing?.source_url ?? "");
  const [textInput, setTextInput] = useState("");
  const [modelNotes, setModelNotes] = useState(null);

  // Live elapsed timer while extracting
  useEffect(() => {
    if (!extracting || extractStartedAt == null) {
      setElapsedSec(0);
      return undefined;
    }
    setElapsedSec(0);
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - extractStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [extracting, extractStartedAt]);

  // Keep draft.school_year in sync if the parent dropdown changes while
  // the editor is open. Only updates when we're creating a new calendar —
  // editing an existing one keeps its own school_year.
  useEffect(() => {
    if (existing) return;
    setDraft((d) => (d.school_year === schoolYear ? d : { ...d, school_year: schoolYear }));
  }, [schoolYear, existing]);
  const [draft, setDraft] = useState({
    school_year: existing?.school_year ?? schoolYear,
    first_day_of_school: existing?.first_day_of_school ?? "",
    last_day_of_school: existing?.last_day_of_school ?? "",
    no_school_dates: Array.isArray(existing?.no_school_dates) ? existing.no_school_dates : [],
    early_release_dates: Array.isArray(existing?.early_release_dates) ? existing.early_release_dates : [],
    source_url: existing?.source_url ?? "",
    notes: existing?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  async function runExtract(payload) {
    setExtracting(true);
    setExtractStartedAt(Date.now());
    setExtractError(null);
    setExtractRaw(null);
    setModelNotes(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("extract-district-calendar", {
        body: { ...payload, organization_id: org.id, school_year_hint: schoolYear },
      });
      if (fnErr) {
        // Edge function returned a non-2xx; supabase-js still gives us the body via fnErr.context
        let msg = fnErr.message ?? "Extraction failed.";
        let rawDebug = null;
        try {
          const errBody = await fnErr.context?.json?.();
          if (errBody?.error) msg = errBody.error;
          if (errBody?.raw) rawDebug = errBody.raw;
        } catch { /* ignore */ }
        setExtractError(msg);
        setExtractRaw(rawDebug);
        return;
      }
      if (data?.error) {
        setExtractError(data.error);
        setExtractRaw(data?.raw ?? null);
        return;
      }
      setDraft((d) => ({
        ...d,
        first_day_of_school: data.first_day_of_school ?? d.first_day_of_school ?? "",
        last_day_of_school: data.last_day_of_school ?? d.last_day_of_school ?? "",
        no_school_dates: Array.isArray(data.no_school_dates) ? data.no_school_dates : d.no_school_dates,
        early_release_dates: Array.isArray(data.early_release_dates) ? data.early_release_dates : d.early_release_dates,
        school_year: data.school_year && /^\d{4}-\d{4}$/.test(data.school_year) ? data.school_year : d.school_year,
      }));
      setModelNotes(typeof data.model_notes === "string" && data.model_notes.trim() ? data.model_notes : null);
    } catch (e) {
      console.error("Extract failed:", e);
      setExtractError(e.message ?? "Extraction failed.");
    } finally {
      setExtracting(false);
      setExtractStartedAt(null);
    }
  }

  function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function onExtractUrl() {
    const url = urlInput.trim();
    if (!url) {
      setExtractError("Paste a link first (a calendar PDF or a calendar web page).");
      return;
    }
    setDraft((d) => ({ ...d, source_url: url }));
    runExtract({ url });
  }

  function onExtractText() {
    const text = textInput.trim();
    if (!text) {
      setExtractError("Paste the calendar text first.");
      return;
    }
    runExtract({ text });
  }

  function onFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setExtractError(`That PDF is too big (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 20 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = typeof result === "string" ? result.split(",")[1] : "";
      if (!base64) {
        setExtractError("Couldn't read that file.");
        return;
      }
      runExtract({ pdf_base64: base64, filename: file.name });
    };
    reader.onerror = () => setExtractError("Couldn't read that file.");
    reader.readAsDataURL(file);
  }

  function updateDateAt(list, i, field, val) {
    return list.map((row, idx) => (idx === i ? { ...row, [field]: val } : row));
  }

  async function save() {
    setSaveError(null);
    if (!draft.school_year || !/^\d{4}-\d{4}$/.test(draft.school_year)) {
      setSaveError("School year must be in the form YYYY-YYYY (e.g. 2026-2027).");
      return;
    }
    // Strip empties + dedupe
    function clean(list) {
      const seen = new Set();
      const out = [];
      for (const row of list) {
        const date = (row?.date ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (seen.has(date)) continue;
        seen.add(date);
        out.push({ date, reason: (row?.reason ?? "").trim().slice(0, 80) });
      }
      out.sort((a, b) => a.date.localeCompare(b.date));
      return out;
    }
    // district_calendars.district is NOT NULL. For a brand-new structured-district
    // calendar use its calendar_key (so it bridges any legacy free-text) or its
    // name; when editing an existing row keep its current string so legacy
    // free-text matching and the unique (org, district, school_year) key don't
    // shift. district_id is stamped so the date math is parent-safe (branch 1).
    const districtString = existing?.district ?? (districtCalendarKey || districtLabel);
    const payload = {
      organization_id: org.id,
      district: districtString,
      district_id: districtId ?? existing?.district_id ?? null,
      school_year: draft.school_year,
      first_day_of_school: draft.first_day_of_school || null,
      last_day_of_school: draft.last_day_of_school || null,
      no_school_dates: clean(draft.no_school_dates),
      early_release_dates: clean(draft.early_release_dates),
      source_url: draft.source_url || null,
      notes: draft.notes || null,
      updated_at: new Date().toISOString(),
    };
    setSaving(true);
    try {
      const userRes = await supabase.auth.getUser();
      const userId = userRes.data?.user?.id ?? null;
      if (existing?.id) {
        const { error: updErr } = await supabase
          .from("district_calendars")
          .update(payload)
          .eq("id", existing.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase
          .from("district_calendars")
          .insert({ ...payload, created_by: userId });
        if (insErr) throw insErr;
      }
      onSaved(payload.school_year);
    } catch (e) {
      console.error("Save failed:", e);
      setSaveError(`Couldn't save: ${e.message ?? "unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      background: "#fff",
      border: `2px solid ${BRIGHT}`,
      borderRadius: 12,
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: INK }}>
            {existing ? `Editing ${districtLabel} calendar` : `New calendar for ${districtLabel}`}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            School year <strong style={{ color: INK }}>{draft.school_year}</strong>
          </div>
        </div>
      </div>

      {/* Extract block */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>1. Pull dates from the district&rsquo;s calendar (PDF, web page, or pasted text)</legend>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <ModeTab active={extractMode === "url"} onClick={() => setExtractMode("url")} label="Paste a link" />
          <ModeTab active={extractMode === "upload"} onClick={() => setExtractMode("upload")} label="Upload PDF" />
          <ModeTab active={extractMode === "text"} onClick={() => setExtractMode("text")} label="Paste text" />
          <span style={{ fontSize: 12, color: MUTED }}>or skip and enter dates manually below.</span>
        </div>
        {extractMode === "url" ? (
          <div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://district.edu/calendar  (a PDF or a calendar web page)"
                style={{ ...inputStyle, flex: 1 }}
                disabled={extracting}
              />
              <button type="button" onClick={onExtractUrl} disabled={extracting} style={btn(BRIGHT, "#fff", false, extracting)}>
                {extracting ? "Reading…" : "Extract"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              A link to a PDF or a district calendar web page. If a page builds its
              calendar with JavaScript we may not be able to read it &mdash; upload the
              PDF or paste the text instead.
            </div>
          </div>
        ) : extractMode === "upload" ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ ...btn(BRIGHT, "#fff", false, extracting), cursor: extracting ? "default" : "pointer" }}>
              {extracting ? "Reading…" : "Choose PDF…"}
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={onFileSelected}
                disabled={extracting}
                style={{ display: "none" }}
              />
            </label>
            <span style={{ fontSize: 12, color: MUTED }}>PDF only, up to 20 MB.</span>
          </div>
        ) : (
          <div>
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={extracting}
              rows={6}
              placeholder="Paste the calendar text here - dates and their labels, e.g. 'Nov 27 Thanksgiving - no school', 'Every Wednesday early release'."
              style={{ ...inputStyle, width: "100%", resize: "vertical", minHeight: 120, fontFamily: "inherit", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button type="button" onClick={onExtractText} disabled={extracting} style={btn(BRIGHT, "#fff", false, extracting)}>
                {extracting ? "Reading…" : "Extract"}
              </button>
            </div>
          </div>
        )}
        {extracting && (
          <div style={{ ...waitBanner, marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={spinnerDot} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: PURPLE }}>
                  Reading the calendar…
                </div>
                {/* Honest per-source estimates. The old flat "10–20 seconds"
                    was measured on pasted text; a real multi-page district PDF
                    fetched from a URL took 1m30s, so the banner was promising
                    something it could miss by 5x. Pasted text really is quick. */}
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {extractMode === "text"
                    ? "Usually takes 10–20 seconds."
                    : "Usually takes 30–90 seconds. A long or multi-page PDF can take up to about 2 minutes."}
                </div>
              </div>
              <div style={{ marginLeft: "auto", fontSize: 18, fontWeight: 700, color: PURPLE, fontVariantNumeric: "tabular-nums" }}>
                {formatElapsed(elapsedSec)}
              </div>
            </div>
          </div>
        )}
        {extractError && (
          <div style={{ ...errorBanner, marginTop: 10 }}>
            <div>{extractError}</div>
            {extractRaw && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, color: CORAL, fontWeight: 600 }}>
                  Show what the AI actually returned (for debugging)
                </summary>
                <pre style={{
                  marginTop: 6,
                  padding: 10,
                  background: "#fff",
                  border: `1px solid ${RULE}`,
                  borderRadius: 4,
                  fontSize: 11,
                  color: INK,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 240,
                  overflow: "auto",
                }}>
                  {extractRaw}
                </pre>
              </details>
            )}
          </div>
        )}
        {modelNotes && (
          <details style={{ ...helpDetails, marginTop: 10 }}>
            <summary style={{ ...helpSummary, color: AMBER, fontWeight: 600 }}>Notes from the reader</summary>
            <div style={{ marginTop: 6, fontSize: 12.5, color: INK, lineHeight: 1.5 }}>{modelNotes}</div>
          </details>
        )}
      </fieldset>

      {/* Review / edit block */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>2. Review and edit</legend>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 12 }}>
          <Field label="School year">
            <input
              type="text"
              value={draft.school_year}
              onChange={(e) => setDraft((d) => ({ ...d, school_year: e.target.value }))}
              placeholder="2026-2027"
              style={inputStyle}
            />
          </Field>
          <Field label="First day of school">
            <input
              type="date"
              value={draft.first_day_of_school || ""}
              onChange={(e) => setDraft((d) => ({ ...d, first_day_of_school: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Last day of school">
            <input
              type="date"
              value={draft.last_day_of_school || ""}
              onChange={(e) => setDraft((d) => ({ ...d, last_day_of_school: e.target.value }))}
              style={inputStyle}
            />
          </Field>
        </div>

        <DateListEditor
          title="No-school days"
          subtitle="Programs skip these dates. Sorted automatically on save."
          rows={draft.no_school_dates}
          onChange={(rows) => setDraft((d) => ({ ...d, no_school_dates: rows }))}
          updateRow={(i, field, val) => setDraft((d) => ({ ...d, no_school_dates: updateDateAt(d.no_school_dates, i, field, val) }))}
        />
        <DateListEditor
          title="Early-release days"
          subtitle="Programs still meet, but you may want to flag instructors / parents. Not subtracted from session dates."
          rows={draft.early_release_dates}
          onChange={(rows) => setDraft((d) => ({ ...d, early_release_dates: rows }))}
          updateRow={(i, field, val) => setDraft((d) => ({ ...d, early_release_dates: updateDateAt(d.early_release_dates, i, field, val) }))}
        />

        <Field label="Source URL (kept for reference)">
          <input
            type="text"
            value={draft.source_url}
            onChange={(e) => setDraft((d) => ({ ...d, source_url: e.target.value }))}
            placeholder="https://district.edu/calendar.pdf"
            style={inputStyle}
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder="Anything to remember about this calendar — e.g. revisions, snow-day rules."
            rows={2}
            style={textareaStyle}
          />
        </Field>
      </fieldset>

      {saveError && <div style={errorBanner}>{saveError}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} disabled={saving} style={btn("transparent", MUTED, true, saving)}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving} style={btn(BRIGHT, "#fff", false, saving)}>
          {saving ? "Saving…" : (existing ? "Save changes" : "Save calendar")}
        </button>
      </div>
    </div>
  );
}

function DateListEditor({ title, subtitle, rows, onChange, updateRow }) {
  function addRow() {
    onChange([...(rows ?? []), { date: "", reason: "" }]);
  }
  function removeRow(i) {
    onChange((rows ?? []).filter((_, idx) => idx !== i));
  }
  return (
    <div style={{ marginTop: 6, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 0.4 }}>
            {title} ({rows?.length ?? 0})
          </div>
          {subtitle && <div style={{ fontSize: 12, color: MUTED }}>{subtitle}</div>}
        </div>
        <button type="button" onClick={addRow} style={btn("transparent", BRIGHT, true)}>+ Add date</button>
      </div>
      {(!rows || rows.length === 0) ? (
        <div style={{ fontSize: 13, color: MUTED, fontStyle: "italic", padding: "8px 0" }}>
          None yet. Extract a PDF above or click <strong>+ Add date</strong>.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((row, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr 40px", gap: 8, alignItems: "center" }}>
              <input
                type="date"
                value={row.date ?? ""}
                onChange={(e) => updateRow(i, "date", e.target.value)}
                style={inputStyle}
              />
              <input
                type="text"
                value={row.reason ?? ""}
                onChange={(e) => updateRow(i, "reason", e.target.value)}
                placeholder="Reason (e.g. Thanksgiving)"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                title="Remove"
                style={{
                  ...btn("transparent", CORAL, true),
                  padding: "6px 8px",
                  fontSize: 13,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModeTab({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...btn(active ? BRIGHT : "transparent", active ? "#fff" : BRIGHT, !active),
        padding: "6px 12px",
        fontSize: 13,
      }}
    >
      {label}
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </label>
      {hint && <div style={{ fontSize: 12, color: MUTED }}>{hint}</div>}
      {children}
    </div>
  );
}

const inputStyle = {
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

const textareaStyle = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 60,
};

const selectStyle = {
  ...inputStyle,
  width: "auto",
  cursor: "pointer",
};

const fieldsetStyle = {
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: "14px 18px 16px",
  margin: 0,
};

const legendStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: PURPLE,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  padding: "0 6px",
};

const errorBanner = {
  background: `${CORAL}1F`,
  border: `1px solid ${CORAL}`,
  borderRadius: 6,
  padding: "8px 12px",
  color: CORAL,
  fontWeight: 500,
  fontSize: 13,
};

const waitBanner = {
  background: `${BRIGHT}14`,
  border: `1px solid ${BRIGHT}66`,
  borderRadius: 6,
  padding: "10px 14px",
};

const spinnerDot = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: BRIGHT,
  animation: "calendarWaitPulse 1s ease-in-out infinite",
};

const emptyState = {
  background: "#fff",
  border: `1px dashed ${RULE}`,
  borderRadius: 12,
  padding: 36,
  textAlign: "center",
  color: MUTED,
  fontSize: 14,
};

function pill(color) {
  return {
    fontSize: 10,
    color,
    background: `${color}1F`,
    padding: "2px 8px",
    borderRadius: 999,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
}

function btn(bg, fg, outlined = false, disabled = false) {
  return {
    display: "inline-block",
    padding: "8px 14px",
    background: bg,
    color: fg,
    border: outlined ? `1px solid ${fg}` : "none",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "inherit",
    textDecoration: "none",
    opacity: disabled ? 0.5 : 1,
  };
}

function updateDateAt(list, i, field, val) {
  return list.map((row, idx) => (idx === i ? { ...row, [field]: val } : row));
}
