// src/pages/j2s/AfterschoolAvailabilityForm.jsx
// Afterschool availability survey (v2). Mirrors the real provider availability form:
//   - per-WEEKDAY time availability ("available from [time]", optional "until")
//   - how many days a week you want (a range)
//   - which AREAS you prefer to teach in (ranked)
// After-school is one class an hour, the same weekday all term, after dismissal —
// so we ask only what the matcher uses. No curriculum, no blackout dates.
// "Available from 1:00" means we can place you in any class you can reach in time
// (arrive ~15 min before it starts) — so a part-time job until 1 doesn't cost you
// the 2:00 classes you could actually teach.
//
// Writes:
//   - one row to instructor_term_availability (weekday_availability, min/max_days, notes)
//   - rows to instructor_term_area_preferences (one per area the instructor ranked)
// keyed by (org, instructor, term). Pre-fills from existing rows so instructors can edit.

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
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
  { value: "", label: "No limit", min: null, max: null },
  { value: "1-2", label: "1–2 days a week", min: 1, max: 2 },
  { value: "3-4", label: "3–4 days a week", min: 3, max: 4 },
  { value: "4-5", label: "4–5 days a week", min: 4, max: 5 },
];

const PREF_OPTIONS = [
  { value: "highly_preferred", label: "Highly preferred", color: OK_GREEN },
  { value: "preferred", label: "Preferred", color: OK_GREEN },
  { value: "not_preferred", label: "Not preferred", color: VIOLET },
  { value: "unavailable", label: "Unavailable", color: CORAL },
];

function termTitle(term) {
  if (!term) return "this term";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(term);
  if (!m) return term;
  const names = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${names[m[1]]} 20${m[2]}`;
}

const EMPTY_WEEK = () => ({
  mon: { from: "", until: "" },
  tue: { from: "", until: "" },
  wed: { from: "", until: "" },
  thu: { from: "", until: "" },
  fri: { from: "", until: "" },
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

  const [areas, setAreas] = useState([]);
  const [hasExisting, setHasExisting] = useState(false);

  useEffect(() => {
    if (!instructorId || !orgId || !term) return;
    let alive = true;
    (async () => {
      const [availRes, locRes, areaPrefRes] = await Promise.all([
        supabase
          .from("instructor_term_availability")
          .select("weekday_availability, min_days, max_days, notes, submitted_at")
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
      ]);
      if (!alive) return;

      if (availRes.data) {
        setHasExisting(!!availRes.data.submitted_at);
        const wd = availRes.data.weekday_availability ?? {};
        const next = EMPTY_WEEK();
        for (const d of DAYS) {
          next[d.value] = { from: wd[d.value]?.from ?? "", until: wd[d.value]?.until ?? "" };
        }
        setWeek(next);
        const r = DAYS_RANGES.find(
          (x) => x.min === (availRes.data.min_days ?? null) && x.max === (availRes.data.max_days ?? null),
        );
        setDaysRange(r ? r.value : "");
        setNotes(availRes.data.notes ?? "");
      }

      const distinctAreas = Array.from(
        new Set((locRes.data ?? []).map((l) => l.area).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b));
      setAreas(distinctAreas);

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

  function setAreaPref(area, preference) {
    setAreaPrefs((prev) => ({ ...prev, [area]: preference }));
  }

  async function save() {
    setError(null);
    const anyDay = DAYS.some((d) => week[d.value]?.from);
    if (!anyDay) { setError("Add a 'from' time for at least one weekday you can teach."); return; }
    for (const d of DAYS) {
      const w = week[d.value];
      if (w.from && w.until && w.until <= w.from) {
        setError(`On ${d.label}, the 'until' time needs to be after the 'from' time.`); return;
      }
    }

    setSaving(true);
    try {
      const range = DAYS_RANGES.find((x) => x.value === daysRange) ?? DAYS_RANGES[0];
      // Only persist weekdays that have a 'from' time.
      const weekday_availability = {};
      for (const d of DAYS) {
        const w = week[d.value];
        if (w && w.from) weekday_availability[d.value] = w.until ? { from: w.from, until: w.until } : { from: w.from };
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

      <Card title="Which days and times can you teach?" subtitle="For each weekday you can work, set the earliest you can start. Add an 'until' time only if you have to leave by a certain point. Leave a day blank if you can't teach that day. We'll only assign a class you can reach in time (about 15 minutes before it starts).">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {DAYS.map((d) => {
            const w = week[d.value];
            return (
              <div key={d.value} style={{ display: "grid", gridTemplateColumns: "minmax(96px, 110px) 1fr", gap: 12, alignItems: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{d.label}</div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: MUTED }}>
                    From
                    <input type="time" value={w.from} onChange={(e) => setDayTime(d.value, "from", e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: MUTED }}>
                    Until <span style={{ fontSize: 11 }}>(optional)</span>
                    <input type="time" value={w.until} onChange={(e) => setDayTime(d.value, "until", e.target.value)} style={inputStyle} disabled={!w.from} />
                  </label>
                  {!w.from && <span style={{ fontSize: 12, color: MUTED }}>Not available</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="How many days a week do you want?" subtitle="Your target — we'll try not to assign you more classes than the top of this range.">
        <select value={daysRange} onChange={(e) => setDaysRange(e.target.value)} style={{ ...inputStyle, width: 220 }}>
          {DAYS_RANGES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </Card>

      <Card title="Which areas do you want to teach in?" subtitle="Set your preference for each area. We'll prioritize highly preferred and only assign an unavailable area as a last resort (with an extra bonus).">
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

      <Card title="Anything else we should know?" subtitle="Optional — constraints or preferences that don't fit above.">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. I can do Mondays only if it's an area near my house."
          style={textareaStyle}
        />
      </Card>

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
    padding: "12px 22px", background: PURPLE, color: "#fff", border: "none", borderRadius: 6,
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
