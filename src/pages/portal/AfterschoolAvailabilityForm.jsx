// src/pages/portal/AfterschoolAvailabilityForm.jsx
// Afterschool availability survey (v2). Mirrors the real provider availability form:
//   - per-WEEKDAY time availability ("available from [time]", optional "until")
//   - how many days a week you want (a range)
//   - which AREAS you prefer to teach in (ranked)
// After-school is one class an hour, the same weekday all term, after dismissal —
// so we ask only what the matcher uses.
// "Available from 1:00" means we can place you in any class you can reach in time
// (arrive ~15 min before it starts) — so a part-time job until 1 doesn't cost you
// the 2:00 classes you could actually teach.
// We also capture specific dates the instructor already knows they can't make
// (unavailable_dates) — a weekly class isn't blocked by one missed session, so
// these surface as a "needs a sub that day" warning, not a scheduling block.
//
// Writes:
//   - one row to instructor_term_availability (weekday_availability, min/max_days,
//     notes, unavailable_dates)
//   - rows to instructor_term_area_preferences (one per area the instructor ranked)
// keyed by (org, instructor, term). Pre-fills from existing rows so instructors can edit.

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Enrops default)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";

const DAYS = [
  { value: "mon", label: "Monday" },
  { value: "tue", label: "Tuesday" },
  { value: "wed", label: "Wednesday" },
  { value: "thu", label: "Thursday" },
  { value: "fri", label: "Friday" },
];

const DAYS_RANGES = [
  { value: "no_limit", label: "No limit", min: null, max: null },
  { value: "1-2", label: "1–2 days a week", min: 1, max: 2 },
  { value: "3-4", label: "3–4 days a week", min: 3, max: 4 },
  { value: "4-5", label: "4–5 days a week", min: 4, max: 5 },
];

// Display labels only — the stored `preference` values stay preferred/available/
// unavailable (what the matcher reads). "Willing" avoids colliding with the
// weekday-availability question above.
const PREF_OPTIONS = [
  { value: "preferred", label: "Love to", color: OK_GREEN },
  { value: "available", label: "Happy to", color: "#6B7280" },
  { value: "unavailable", label: "Can't", color: CORAL },
];

// Subject categories come from the provider's curricula (see the load effect),
// so they're never hardcoded per tenant. Title-case the stored value for display.
function titleCaseCategory(value) {
  return String(value)
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// "2026-11-12" -> "Thu, Nov 12, 2026". Parsed at local noon so the date never
// slips a day across time zones.
function fmtDateLabel(d) {
  const dt = new Date(`${String(d).slice(0, 10)}T12:00:00`);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function termTitle(term) {
  if (!term) return "this term";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(term);
  if (!m) return term;
  const names = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${names[m[1]]} 20${m[2]}`;
}

// Each day is explicitly Available (with a start time) or Unavailable — no more
// "blank = not available" guessing. Default Unavailable; the instructor turns on
// the days they can teach.
const EMPTY_WEEK = () => ({
  mon: { available: false, from: "", until: "" },
  tue: { available: false, from: "", until: "" },
  wed: { available: false, from: "", until: "" },
  thu: { available: false, from: "", until: "" },
  fri: { available: false, from: "", until: "" },
});

export default function AfterschoolAvailabilityForm({ instructor, term, onSaved, onCancel }) {
  const orgId = instructor?.organization_id;
  const instructorId = instructor?.instructor_id ?? instructor?.id;

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [week, setWeek] = useState(EMPTY_WEEK());   // { mon: { from: "13:00", until: "17:00" }, ... }
  const [daysRange, setDaysRange] = useState("");
  const [notes, setNotes] = useState("");
  const [areaPrefs, setAreaPrefs] = useState({});   // area -> preference
  const [categories, setCategories] = useState([]); // preferred families (provider's curricula categories)
  const [categoryOptions, setCategoryOptions] = useState([]); // [{value,label}] from the org's curricula
  const [unavailableDates, setUnavailableDates] = useState([]); // ["2026-11-12", ...]
  const [dateToAdd, setDateToAdd] = useState("");

  const [areas, setAreas] = useState([]);
  const [hasExisting, setHasExisting] = useState(false);
  // Questions the operator turned off in Settings (org_survey_config). Hidden here
  // and skipped in validation. Empty = ask everything (default).
  const [disabled, setDisabled] = useState(() => new Set());

  useEffect(() => {
    if (!instructorId || !orgId || !term) return;
    let alive = true;
    (async () => {
      const [availRes, locRes, areaPrefRes, currRes, cfgRes] = await Promise.all([
        supabase
          .from("instructor_term_availability")
          .select("weekday_availability, min_days, max_days, notes, submitted_at, preferred_categories, unavailable_dates")
          .eq("instructor_id", instructorId)
          .eq("term", term)
          .maybeSingle(),
        supabase
          .from("program_locations")
          .select("area")
          .eq("organization_id", orgId)
          .not("area", "is", null),
        supabase
          .from("instructor_term_area_preferences")
          .select("area, preference")
          .eq("instructor_id", instructorId)
          .eq("term", term),
        // Subject categories are the provider's own — sourced from their curricula
        // (the same category the matcher reads), never hardcoded.
        supabase
          .from("curricula")
          .select("category")
          .eq("organization_id", orgId)
          .not("category", "is", null),
        supabase
          .from("org_survey_config")
          .select("disabled_questions")
          .eq("organization_id", orgId)
          .eq("context", "afterschool")
          .maybeSingle(),
      ]);
      if (!alive) return;

      setDisabled(new Set(Array.isArray(cfgRes.data?.disabled_questions) ? cfgRes.data.disabled_questions : []));

      if (availRes.data) {
        setHasExisting(!!availRes.data.submitted_at);
        const wd = availRes.data.weekday_availability ?? {};
        const next = EMPTY_WEEK();
        for (const d of DAYS) {
          const from = wd[d.value]?.from ?? "";
          next[d.value] = { available: !!from, from, until: wd[d.value]?.until ?? "" };
        }
        setWeek(next);
        const r = DAYS_RANGES.find(
          (x) => x.min === (availRes.data.min_days ?? null) && x.max === (availRes.data.max_days ?? null),
        );
        setDaysRange(r ? r.value : "no_limit");
        setNotes(availRes.data.notes ?? "");
        setCategories(Array.isArray(availRes.data.preferred_categories) ? availRes.data.preferred_categories : []);
        setUnavailableDates(
          Array.isArray(availRes.data.unavailable_dates)
            ? [...availRes.data.unavailable_dates].map((d) => String(d).slice(0, 10)).sort()
            : [],
        );
      }

      const distinctAreas = Array.from(
        new Set((locRes.data ?? []).map((l) => l.area).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b));
      setAreas(distinctAreas);

      const distinctCats = Array.from(
        new Set((currRes.data ?? []).map((c) => c.category).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b));
      setCategoryOptions(distinctCats.map((c) => ({ value: c, label: titleCaseCategory(c) })));

      const prefs = {};
      for (const r of areaPrefRes.data ?? []) prefs[r.area] = r.preference;
      setAreaPrefs(prefs);

      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [instructorId, orgId, term]);

  function setDayTime(day, field, value) {
    setWeek((prev) => ({ ...prev, [day]: { ...prev[day], [field]: value } }));
  }

  // Explicit per-day availability. Marking a day unavailable clears its times.
  function setDayAvailable(day, available) {
    setWeek((prev) => ({
      ...prev,
      [day]: available ? { ...prev[day], available: true } : { available: false, from: "", until: "" },
    }));
  }

  function setAreaPref(area, preference) {
    setAreaPrefs((prev) => ({ ...prev, [area]: preference }));
  }

  function toggleCategory(value) {
    setCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  function addUnavailableDate() {
    if (!dateToAdd) return;
    setUnavailableDates((prev) => (prev.includes(dateToAdd) ? prev : [...prev, dateToAdd].sort()));
    setDateToAdd("");
  }

  function removeUnavailableDate(d) {
    setUnavailableDates((prev) => prev.filter((x) => x !== d));
  }

  async function save() {
    setError(null);
    const anyDay = DAYS.some((d) => week[d.value]?.available);
    if (!anyDay) { setError("Mark at least one weekday as available."); return; }
    for (const d of DAYS) {
      const w = week[d.value];
      if (!w.available) continue;
      if (!w.from) { setError(`Set a start time for ${d.label}, or mark it unavailable.`); return; }
      if (w.until && w.until <= w.from) {
        setError(`On ${d.label}, the 'until' time needs to be after the 'from' time.`); return;
      }
    }
    if (!disabled.has("days_per_week") && !daysRange) { setError("Pick how many days a week you'd like to teach (choose 'No limit' if you have no cap)."); return; }
    if (!disabled.has("areas")) {
      const unrated = areas.filter((a) => !areaPrefs[a]);
      if (unrated.length > 0) { setError(`Please rate every area — still missing: ${unrated.join(", ")}.`); return; }
    }

    setSaving(true);
    try {
      const range = DAYS_RANGES.find((x) => x.value === daysRange) ?? DAYS_RANGES[0];
      // Only persist weekdays explicitly marked available (with a start time).
      const weekday_availability = {};
      for (const d of DAYS) {
        const w = week[d.value];
        if (w && w.available && w.from) weekday_availability[d.value] = w.until ? { from: w.from, until: w.until } : { from: w.from };
      }

      const { error: availErr } = await supabase
        .from("instructor_term_availability")
        .upsert(
          {
            organization_id: orgId,
            instructor_id: instructorId,
            term,
            weekday_availability,
            min_days: range.min,
            max_days: range.max,
            notes: notes.trim() || null,
            submitted_at: new Date().toISOString(),
            needs_confirmation: false,
            preferred_categories: categories,
            unavailable_dates: unavailableDates.length ? unavailableDates : null,
          },
          { onConflict: "organization_id,instructor_id,term" },
        );
      if (availErr) throw availErr;

      // Replace this instructor's area preferences for the term.
      const { error: delErr } = await supabase
        .from("instructor_term_area_preferences")
        .delete()
        .eq("instructor_id", instructorId)
        .eq("term", term);
      if (delErr) throw delErr;

      const prefRows = areas
        .filter((a) => areaPrefs[a])
        .map((a) => ({
          organization_id: orgId,
          instructor_id: instructorId,
          term,
          area: a,
          preference: areaPrefs[a],
        }));
      if (prefRows.length > 0) {
        const { error: insErr } = await supabase.from("instructor_term_area_preferences").insert(prefRows);
        if (insErr) throw insErr;
      }

      onSaved?.();
    } catch (err) {
      console.error("Afterschool availability save failed:", err);
      setError(err.message ?? "Couldn't save. Try again or contact your admin.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <div style={{ color: MUTED, fontSize: 14, padding: 24 }}>Loading your availability…</div>;
  }

  const title = termTitle(term);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <header style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: 24 }}>
        <div style={{ fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
          {hasExisting ? "Update your availability" : "Set up your availability"}
        </div>
        <h1 style={{ margin: "4px 0 6px", fontSize: 24, fontWeight: 700, color: INK, letterSpacing: -0.3 }}>
          {title} availability
        </h1>
        <p style={{ color: MUTED, fontSize: 14, margin: 0, lineHeight: 1.5 }}>
          After-school classes run once a week on the same weekday all term. Tell us
          which days and times you can teach and which areas you prefer — you'll still
          get to accept or request changes on each class before it's confirmed.
        </p>
      </header>

      <Card title="Which days and times can you teach?" subtitle="Mark each weekday available or unavailable. For the days you're available, set the earliest you can start (add an 'until' time only if you have to leave by a certain point). We'll only assign a class you can reach in time (about 15 minutes before it starts).">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {DAYS.map((d) => {
            const w = week[d.value];
            return (
              <div key={d.value} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 96px) auto 1fr", gap: 12, alignItems: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{d.label}</div>
                <div style={{ display: "inline-flex", border: `1px solid ${RULE}`, borderRadius: 999, overflow: "hidden" }}>
                  <button type="button" onClick={() => setDayAvailable(d.value, true)}
                    style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", border: "none", cursor: "pointer", background: w.available ? OK_GREEN : "#fff", color: w.available ? "#fff" : MUTED }}>
                    Available
                  </button>
                  <button type="button" onClick={() => setDayAvailable(d.value, false)}
                    style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", border: "none", borderLeft: `1px solid ${RULE}`, cursor: "pointer", background: !w.available ? CORAL : "#fff", color: !w.available ? "#fff" : MUTED }}>
                    Unavailable
                  </button>
                </div>
                {w.available ? (
                  <div style={{ display: "grid", gridTemplateColumns: "auto minmax(120px, 150px)", gap: "8px 10px", alignItems: "center", justifyContent: "start" }}>
                    <span style={{ fontSize: 13, color: MUTED }}>From</span>
                    <input type="time" value={w.from} onChange={(e) => setDayTime(d.value, "from", e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                    <span style={{ fontSize: 13, color: MUTED }}>Until <span style={{ fontSize: 11 }}>(optional)</span></span>
                    <input type="time" value={w.until} onChange={(e) => setDayTime(d.value, "until", e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>Won't teach this day</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {!disabled.has("days_per_week") && (
      <Card title="How many days a week do you want?" subtitle="Your target — we'll try not to assign you more classes than the top of this range.">
        <select value={daysRange} onChange={(e) => setDaysRange(e.target.value)} style={{ ...inputStyle, width: 220 }}>
          <option value="" disabled>Select…</option>
          {DAYS_RANGES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </Card>
      )}

      {!disabled.has("areas") && (
      <Card title="Which areas do you want to teach in?" subtitle="Rate every area: 'Love to' is where you'd most like to be, 'Happy to' means you're glad to teach there, and 'Can't' means we won't schedule you there.">

        {areas.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13, fontStyle: "italic" }}>
            Your admin hasn't set up teaching areas yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {areas.map((area) => (
              <PrefRow key={area} label={area} value={areaPrefs[area]} onChange={(v) => setAreaPref(area, v)} />
            ))}
          </div>
        )}
      </Card>
      )}

      {!disabled.has("subjects") && categoryOptions.length > 0 && (
        <Card title="Which do you most enjoy teaching?" subtitle="Pick any that apply — we'll try to send you classes in the subjects you like. You can teach all of them; this just helps us match well.">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {categoryOptions.map((opt) => {
              const on = categories.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleCategory(opt.value)}
                  style={{
                    padding: "8px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
                    border: `1px solid ${on ? OK_GREEN : RULE}`,
                    background: on ? `${OK_GREEN}1F` : "#fff",
                    color: on ? OK_GREEN : INK,
                  }}
                >
                  {on ? "✓ " : ""}{opt.label}
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {!disabled.has("unavailable_dates") && (
      <Card title="Any dates you already know you can't make?" subtitle="Optional. Add specific dates you'll be out this term (a holiday, an appointment). You'll still be assigned your weekly class — we just flag those dates so your admin can line up a sub.">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" value={dateToAdd} onChange={(e) => setDateToAdd(e.target.value)} style={{ ...inputStyle, width: 190 }} />
          <button type="button" onClick={addUnavailableDate} disabled={!dateToAdd}
            style={{ padding: "9px 16px", borderRadius: 6, border: `1px solid ${BRIGHT}`, background: dateToAdd ? "#fff" : CREAM, color: BRIGHT, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: dateToAdd ? "pointer" : "default", opacity: dateToAdd ? 1 : 0.5 }}>
            Add date
          </button>
        </div>
        {unavailableDates.length > 0 && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {unavailableDates.map((d) => (
              <span key={d} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 12px", borderRadius: 999, background: `${CORAL}14`, border: `1px solid ${CORAL}55`, color: INK, fontSize: 13, fontWeight: 600 }}>
                {fmtDateLabel(d)}
                <button type="button" onClick={() => removeUnavailableDate(d)} aria-label={`Remove ${fmtDateLabel(d)}`}
                  style={{ border: "none", background: "transparent", color: CORAL, fontSize: 16, lineHeight: 1, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>
      )}

      {!disabled.has("notes") && (
      <Card title="Anything else we should know?" subtitle="Optional — constraints or preferences that don't fit above.">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. I can do Mondays only if it's an area near my house."
          style={textareaStyle}
        />
      </Card>
      )}

      {error && (
        <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 12, borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{
        position: "sticky", bottom: 0, background: CREAM, paddingTop: 12, paddingBottom: 8,
        display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center",
      }}>
        <button type="button" onClick={onCancel} disabled={saving} style={cancelBtn(saving)}>Cancel</button>
        <button type="button" onClick={save} disabled={saving} style={primaryBtn(saving)}>
          {saving ? "Saving…" : (hasExisting ? "Save changes" : "Submit availability")}
        </button>
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <section style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK }}>{title}</h2>
      {subtitle && <p style={{ margin: "4px 0 12px", color: MUTED, fontSize: 13, lineHeight: 1.5 }}>{subtitle}</p>}
      {!subtitle && <div style={{ height: 12 }} />}
      {children}
    </section>
  );
}

function PrefRow({ label, value, onChange }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) auto", gap: 12, alignItems: "center", padding: "6px 0" }}>
      <div style={{ fontSize: 14, color: INK }}>{label}</div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {PREF_OPTIONS.map((opt) => {
          const on = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              style={{
                padding: "5px 10px",
                background: on ? opt.color : "#fff",
                color: on ? "#fff" : INK,
                border: `1px solid ${on ? opt.color : RULE}`,
                borderRadius: 999, fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const inputStyle = {
  padding: "9px 12px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
  color: INK,
  outline: "none",
  boxSizing: "border-box",
};

const textareaStyle = {
  width: "100%", padding: "10px 12px", border: `1px solid ${RULE}`, borderRadius: 6,
  fontSize: 14, fontFamily: "inherit", background: "#fff", color: INK, outline: "none",
  boxSizing: "border-box", resize: "vertical", minHeight: 60,
};

function primaryBtn(disabled) {
  return {
    padding: "12px 22px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6,
    fontSize: 15, fontWeight: 700, fontFamily: "inherit", cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

function cancelBtn(disabled) {
  return {
    padding: "12px 18px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`,
    borderRadius: 6, fontSize: 14, fontFamily: "inherit", cursor: disabled ? "default" : "pointer",
  };
}
