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

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CORAL = "#D9694F";
const OK_GREEN = "#3a7c3a";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const AMBER = "#a16207";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
  const [schoolYear, setSchoolYear] = useState(defaultSchoolYear());
  const [districts, setDistricts] = useState([]); // [{ district, location_count }]
  const [calendars, setCalendars] = useState([]); // district_calendars rows for current school year
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { district } | null
  const [viewing, setViewing] = useState(() => new Set()); // districts currently showing their dates inline
  const [topError, setTopError] = useState(null);

  function toggleViewing(district) {
    setViewing((prev) => {
      const next = new Set(prev);
      if (next.has(district)) next.delete(district);
      else next.add(district);
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
      const [locsRes, calsRes] = await Promise.all([
        supabase
          .from("program_locations")
          .select("district")
          .eq("organization_id", org.id)
          .not("district", "is", null),
        supabase
          .from("district_calendars")
          .select("*")
          .eq("organization_id", org.id)
          .eq("school_year", schoolYear),
      ]);
      if (locsRes.error) throw locsRes.error;
      if (calsRes.error) throw calsRes.error;

      const counts = new Map();
      for (const r of locsRes.data ?? []) {
        const d = (r.district ?? "").trim();
        if (!d) continue;
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      const list = [...counts.entries()]
        .map(([district, location_count]) => ({ district, location_count }))
        .sort((a, b) => a.district.localeCompare(b.district));
      setDistricts(list);
      setCalendars(calsRes.data ?? []);
    } catch (e) {
      console.error("Load calendars failed:", e);
      setTopError(`Couldn't load: ${e.message ?? "unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  function calendarFor(district) {
    return calendars.find((c) => c.district === district) ?? null;
  }

  if (!org) return <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <style>{`@keyframes calendarWaitPulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }`}</style>
      <header style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 8,
        padding: "18px 22px",
        display: "flex",
        flexWrap: "wrap",
        gap: 16,
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>School calendars</h1>
          <div style={{ color: MUTED, marginTop: 4, fontSize: 14, maxWidth: 720 }}>
            One calendar per district per school year. No-school dates feed every
            program's session schedule — what parents see, what shows up on
            instructor calendars, and which days you book on Facilitron / Mazevo.
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

      {topError && <div style={errorBanner}>{topError}</div>}

      {loading ? (
        <div style={{ color: MUTED, fontSize: 14, padding: 16 }}>Loading…</div>
      ) : districts.length === 0 ? (
        <div style={emptyState}>
          No districts yet. Add a location with a district name first, then come back here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {districts.map(({ district, location_count }) => {
            const cal = calendarFor(district);
            const isEditing = editing?.district === district;
            return (
              <div key={district}>
                {isEditing ? (
                  <CalendarEditor
                    org={org}
                    district={district}
                    schoolYear={schoolYear}
                    existing={cal}
                    onClose={() => setEditing(null)}
                    onSaved={async (savedSchoolYear) => {
                      setEditing(null);
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
                    district={district}
                    locationCount={location_count}
                    cal={cal}
                    isViewing={viewing.has(district)}
                    onToggleView={() => toggleViewing(district)}
                    onEdit={() => setEditing({ district })}
                  />
                )}
              </div>
            );
          })}
        </div>
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

function DistrictRow({ district, locationCount, cal, isViewing, onToggleView, onEdit }) {
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
          <button type="button" onClick={onToggleView} style={btn("transparent", PURPLE, true)}>
            {isViewing ? "Hide dates" : "View dates"}
          </button>
        )}
        <button type="button" onClick={onEdit} style={btn(cal ? "transparent" : PURPLE, cal ? PURPLE : "#fff", !!cal)}>
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
              ...btn("transparent", PURPLE, true),
              padding: "4px 10px",
              fontSize: 12,
              background: copied ? `${OK_GREEN}1F` : "transparent",
              color: copied ? OK_GREEN : PURPLE,
              borderColor: copied ? OK_GREEN : PURPLE,
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

function CalendarEditor({ org, district, schoolYear, existing, onClose, onSaved }) {
  const [extracting, setExtracting] = useState(false);
  const [extractStartedAt, setExtractStartedAt] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [extractError, setExtractError] = useState(null);
  const [extractRaw, setExtractRaw] = useState(null);
  const [extractMode, setExtractMode] = useState("url");
  const [urlInput, setUrlInput] = useState(existing?.source_url ?? "");
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
        body: { ...payload, school_year_hint: schoolYear },
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
      setExtractError("Paste a PDF URL first.");
      return;
    }
    setDraft((d) => ({ ...d, source_url: url }));
    runExtract({ url });
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
    const payload = {
      organization_id: org.id,
      district,
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
      border: `2px solid ${PURPLE}`,
      borderRadius: 8,
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: INK }}>
            {existing ? `Editing ${district} calendar` : `New calendar for ${district}`}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            School year <strong style={{ color: INK }}>{draft.school_year}</strong>
          </div>
        </div>
      </div>

      {/* Extract block */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>1. Pull dates from the district's calendar PDF</legend>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
          <ModeTab active={extractMode === "url"} onClick={() => setExtractMode("url")} label="Paste URL" />
          <ModeTab active={extractMode === "upload"} onClick={() => setExtractMode("upload")} label="Upload PDF" />
          <span style={{ fontSize: 12, color: MUTED }}>or skip and enter dates manually below.</span>
        </div>
        {extractMode === "url" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://district.edu/calendar.pdf"
              style={{ ...inputStyle, flex: 1 }}
              disabled={extracting}
            />
            <button type="button" onClick={onExtractUrl} disabled={extracting} style={btn(PURPLE, "#fff", false, extracting)}>
              {extracting ? "Reading…" : "Extract"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ ...btn(PURPLE, "#fff", false, extracting), cursor: extracting ? "default" : "pointer" }}>
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
        )}
        {extracting && (
          <div style={{ ...waitBanner, marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={spinnerDot} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: PURPLE }}>
                  Reading the calendar…
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  Usually takes 10–20 seconds.
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
          <div style={{ ...infoBanner, marginTop: 10 }}>
            <strong>Heads up:</strong> {modelNotes}
          </div>
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
        <button type="button" onClick={save} disabled={saving} style={btn(PURPLE, "#fff", false, saving)}>
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
        <button type="button" onClick={addRow} style={btn("transparent", PURPLE, true)}>+ Add date</button>
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
        ...btn(active ? PURPLE : "transparent", active ? "#fff" : PURPLE, !active),
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

const infoBanner = {
  background: `${AMBER}1F`,
  border: `1px solid ${AMBER}`,
  borderRadius: 6,
  padding: "8px 12px",
  color: AMBER,
  fontSize: 13,
};

const waitBanner = {
  background: `${VIOLET}14`,
  border: `1px solid ${VIOLET}66`,
  borderRadius: 6,
  padding: "10px 14px",
};

const spinnerDot = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: PURPLE,
  animation: "calendarWaitPulse 1s ease-in-out infinite",
};

const emptyState = {
  background: "#fff",
  border: `1px dashed ${RULE}`,
  borderRadius: 8,
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
