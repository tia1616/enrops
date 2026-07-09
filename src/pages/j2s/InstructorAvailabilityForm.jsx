// src/pages/j2s/InstructorAvailabilityForm.jsx
// In-portal availability survey. Replaces the Google Form → manual transcription
// loop from SU26. Instructor sets which weeks + session types + locations +
// curricula they'd like to work, plus role preference, Saturday availability,
// unavailable-date notes, and free notes.
//
// Writes to three tables: instructor_availability (one row), location prefs
// (one row per venue), curriculum prefs (one row per category). On submit we
// upsert the availability row and replace the pref rows for this (instructor,
// cycle) pair.
//
// Pre-fills from existing data so instructors can come back and edit.

import { useEffect, useMemo, useState } from "react";
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

// Display labels only — stored preference values stay highly_preferred/preferred/
// not_preferred/unavailable (what match-instructors reads). Warm 4-level scale,
// consistent with the after-school form's "Love to / Happy to / Can't".
const PREF_OPTIONS = [
  { value: "highly_preferred", label: "Love to", color: OK_GREEN },
  { value: "preferred", label: "Happy to", color: OK_GREEN },
  { value: "not_preferred", label: "Rather not", color: VIOLET },
  { value: "unavailable", label: "Can't", color: CORAL },
];

const SESSION_TYPES = [
  { value: "morning", label: "Morning", hint: "Typically 9am–12pm" },
  { value: "afternoon", label: "Afternoon", hint: "Typically 12:30–3:30pm" },
  { value: "full_day", label: "Full day", hint: "Typically 9am–3pm" },
];

const ROLE_OPTIONS = [
  { value: "lead_only", label: "Lead only", hint: "I want to be the main instructor for any camp I'm assigned." },
  { value: "lead_or_developing", label: "Either", hint: "I'm open to either lead or developing roles." },
  { value: "developing_only", label: "Developing only", hint: "I'd rather support a lead instructor for now." },
];

// Subject categories come from the provider's curricula (loaded in the effect),
// so they're never hardcoded per tenant. Title-case the stored value for display.
function titleCaseCategory(value) {
  return String(value)
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function fmtShort(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "2026-07-22" -> "Wed, Jul 22, 2026" (parsed at local noon so it never slips a day).
function fmtDateLabel(d) {
  const dt = new Date(`${String(d).slice(0, 10)}T12:00:00`);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function termTitle(cycle) {
  if (!cycle?.name) return "this cycle";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(cycle.name);
  if (!m) return cycle.name;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

export default function InstructorAvailabilityForm({ instructor, cycle, onSaved, onCancel }) {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // State for every field on the form
  const [availableWeeks, setAvailableWeeks] = useState(new Set());
  const [sessionTypes, setSessionTypes] = useState(new Set());
  const [rolePref, setRolePref] = useState("lead_or_developing");
  const [saturdaysOk, setSaturdaysOk] = useState(false);
  const [unavailableDates, setUnavailableDates] = useState([]); // ["2026-07-22", ...]
  const [dateToAdd, setDateToAdd] = useState("");
  const [notes, setNotes] = useState("");
  const [locPrefs, setLocPrefs] = useState({}); // location_name -> preference
  const [curPrefs, setCurPrefs] = useState({}); // category -> preference

  const [locations, setLocations] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]); // [{value,label}] from the org's curricula
  const [hasExisting, setHasExisting] = useState(false);

  const cycleWeeks = useMemo(() => Array.isArray(cycle?.weeks) ? cycle.weeks : [], [cycle]);

  // Load anything already saved + the venue list.
  useEffect(() => {
    if (!instructor?.instructor_id || !cycle?.id || !instructor?.organization_id) return;
    let alive = true;
    (async () => {
      const [availRes, locPrefRes, curPrefRes, venuesRes, currRes] = await Promise.all([
        supabase
          .from("instructor_availability")
          .select("session_types, available_weeks, role_preference, saturdays_ok, unavailable_dates, notes, submitted_at")
          .eq("instructor_id", instructor.instructor_id)
          .eq("cycle_id", cycle.id)
          .maybeSingle(),
        supabase
          .from("instructor_location_preferences")
          .select("location_name, preference")
          .eq("instructor_id", instructor.instructor_id)
          .eq("cycle_id", cycle.id),
        supabase
          .from("instructor_curriculum_preferences")
          .select("curriculum_category, preference")
          .eq("instructor_id", instructor.instructor_id)
          .eq("cycle_id", cycle.id),
        supabase
          .from("program_locations")
          .select("id, name")
          .eq("organization_id", instructor.organization_id)
          .order("name", { ascending: true }),
        // Subject categories are the provider's own — from their curricula.
        supabase
          .from("curricula")
          .select("category")
          .eq("organization_id", instructor.organization_id)
          .not("category", "is", null),
      ]);
      if (!alive) return;

      // Pre-fill from existing availability row (if any).
      if (availRes.data) {
        setHasExisting(!!availRes.data.submitted_at);
        setSessionTypes(new Set(availRes.data.session_types ?? []));
        setAvailableWeeks(new Set(availRes.data.available_weeks ?? []));
        setRolePref(availRes.data.role_preference ?? "lead_or_developing");
        setSaturdaysOk(!!availRes.data.saturdays_ok);
        setUnavailableDates(
          Array.isArray(availRes.data.unavailable_dates)
            ? [...availRes.data.unavailable_dates].map((d) => String(d).slice(0, 10)).sort()
            : [],
        );
        setNotes(availRes.data.notes ?? "");
      }

      // Pre-fill prefs (location + curriculum) from existing rows.
      const locMap = {};
      for (const r of locPrefRes.data ?? []) locMap[r.location_name] = r.preference;
      setLocPrefs(locMap);

      const curMap = {};
      for (const r of curPrefRes.data ?? []) curMap[r.curriculum_category] = r.preference;
      setCurPrefs(curMap);

      setLocations(venuesRes.data ?? []);

      const distinctCats = Array.from(
        new Set((currRes.data ?? []).map((c) => c.category).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b));
      setCategoryOptions(distinctCats.map((c) => ({ value: c, label: titleCaseCategory(c) })));

      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [instructor, cycle]);

  function toggleWeek(num) {
    setAvailableWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  }

  function toggleSessionType(value) {
    setSessionTypes((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  function addUnavailableDate() {
    if (!dateToAdd) return;
    setUnavailableDates((prev) => (prev.includes(dateToAdd) ? prev : [...prev, dateToAdd].sort()));
    setDateToAdd("");
  }

  function removeUnavailableDate(d) {
    setUnavailableDates((prev) => prev.filter((x) => x !== d));
  }

  function setLocPref(locationName, preference) {
    setLocPrefs((prev) => ({ ...prev, [locationName]: preference }));
  }

  function setCurPref(category, preference) {
    setCurPrefs((prev) => ({ ...prev, [category]: preference }));
  }

  function selectAllWeeks() {
    setAvailableWeeks(new Set(cycleWeeks.map((w) => w.num)));
  }

  function clearAllWeeks() {
    setAvailableWeeks(new Set());
  }

  async function save() {
    setError(null);
    if (availableWeeks.size === 0) { setError("Pick at least one week you're available."); return; }
    if (sessionTypes.size === 0) { setError("Pick at least one session type (Morning, Afternoon, or Full day)."); return; }
    if (!rolePref) { setError("Pick a role preference."); return; }

    setSaving(true);
    try {
      // 1) Upsert the availability row.
      const availPayload = {
        organization_id: instructor.organization_id,
        cycle_id: cycle.id,
        instructor_id: instructor.instructor_id,
        session_types: Array.from(sessionTypes),
        available_weeks: Array.from(availableWeeks).sort((a, b) => a - b),
        role_preference: rolePref,
        saturdays_ok: saturdaysOk,
        unavailable_dates: unavailableDates.length ? unavailableDates : null,
        notes: notes.trim() || null,
        submitted_at: new Date().toISOString(),
        needs_confirmation: false,
      };
      const { error: availErr } = await supabase
        .from("instructor_availability")
        .upsert(availPayload, { onConflict: "instructor_id,cycle_id" });
      if (availErr) throw availErr;

      // 2) Replace location prefs.
      await supabase
        .from("instructor_location_preferences")
        .delete()
        .eq("instructor_id", instructor.instructor_id)
        .eq("cycle_id", cycle.id);
      const locRows = Object.entries(locPrefs)
        .filter(([, pref]) => !!pref)
        .map(([location_name, preference]) => ({
          organization_id: instructor.organization_id,
          cycle_id: cycle.id,
          instructor_id: instructor.instructor_id,
          location_name,
          preference,
        }));
      if (locRows.length > 0) {
        const { error: locErr } = await supabase
          .from("instructor_location_preferences")
          .insert(locRows);
        if (locErr) throw locErr;
      }

      // 3) Replace curriculum prefs.
      await supabase
        .from("instructor_curriculum_preferences")
        .delete()
        .eq("instructor_id", instructor.instructor_id)
        .eq("cycle_id", cycle.id);
      const curRows = Object.entries(curPrefs)
        .filter(([, pref]) => !!pref)
        .map(([curriculum_category, preference]) => ({
          organization_id: instructor.organization_id,
          cycle_id: cycle.id,
          instructor_id: instructor.instructor_id,
          curriculum_category,
          preference,
        }));
      if (curRows.length > 0) {
        const { error: curErr } = await supabase
          .from("instructor_curriculum_preferences")
          .insert(curRows);
        if (curErr) throw curErr;
      }

      onSaved?.();
    } catch (err) {
      console.error("Availability save failed:", err);
      setError(err.message ?? "Couldn't save. Try again or contact your admin.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <div style={{ color: MUTED, fontSize: 14, padding: 24 }}>Loading your availability…</div>;
  }

  const cycleTitle = termTitle(cycle);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <header style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: 24 }}>
        <div style={{ fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
          {hasExisting ? "Update your availability" : "Set up your availability"}
        </div>
        <h1 style={{ margin: "4px 0 6px", fontSize: 24, fontWeight: 700, color: INK, letterSpacing: -0.3 }}>
          {cycleTitle} availability
        </h1>
        <p style={{ color: MUTED, fontSize: 14, margin: 0, lineHeight: 1.5 }}>
          Tell us when and where you'd like to work. We'll use this to match you to camps — you'll still get to accept or request changes on each camp before it's confirmed.
        </p>
      </header>

      <Card title="Which weeks are you available?" subtitle={`${cycleTitle} runs ${fmtShort(cycle.starts_on)} – ${fmtShort(cycle.ends_on)}.`}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <button type="button" onClick={selectAllWeeks} style={smallBtn}>Select all</button>
          <button type="button" onClick={clearAllWeeks} style={smallBtn}>Clear all</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          {cycleWeeks.map((w) => {
            const on = availableWeeks.has(w.num);
            return (
              <button
                key={w.num}
                type="button"
                onClick={() => toggleWeek(w.num)}
                style={{
                  padding: "10px 12px",
                  background: on ? `${PURPLE}10` : "#fff",
                  border: `1px solid ${on ? PURPLE : RULE}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  color: on ? PURPLE : INK,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>Week {w.num}</div>
                <div style={{ fontSize: 12, color: on ? PURPLE : MUTED, marginTop: 2 }}>
                  {fmtShort(w.starts_on)} – {fmtShort(w.ends_on)}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="What time of day?" subtitle="Pick any combination — Full day implies you're also available for Morning or Afternoon half-days.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
          {SESSION_TYPES.map((s) => {
            const on = sessionTypes.has(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => toggleSessionType(s.value)}
                style={{
                  padding: "12px 14px",
                  background: on ? `${PURPLE}10` : "#fff",
                  border: `1px solid ${on ? PURPLE : RULE}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  color: on ? PURPLE : INK,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>{s.label}</div>
                <div style={{ fontSize: 12, color: on ? PURPLE : MUTED, marginTop: 2 }}>{s.hint}</div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Specific dates you can't work" subtitle="Picked a week but have a trip or appointment on one day? Add those dates. You'll still be assigned the camp — we just flag the dates so your admin can line up a sub.">
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

      <Card title="Where do you want to work?" subtitle="Set your preference for each venue. We'll prioritize the ones you love and avoid the ones you can't do.">
        {locations.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13, fontStyle: "italic" }}>
            Your admin hasn't added any venues yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {locations.map((loc) => (
              <PrefRow
                key={loc.id}
                label={loc.name}
                value={locPrefs[loc.name]}
                onChange={(v) => setLocPref(loc.name, v)}
              />
            ))}
          </div>
        )}
      </Card>

      {categoryOptions.length > 0 && (
        <Card title="What do you like to teach?" subtitle="Pick your preference for each subject. We'll match you to camps you'll enjoy.">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {categoryOptions.map((c) => (
              <PrefRow
                key={c.value}
                label={c.label}
                value={curPrefs[c.value]}
                onChange={(v) => setCurPref(c.value, v)}
              />
            ))}
          </div>
        </Card>
      )}

      <Card title="Are you interested in:" subtitle="Lead means you run the camp. Developing means you support an experienced lead instructor.">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ROLE_OPTIONS.map((r) => {
            const on = rolePref === r.value;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => setRolePref(r.value)}
                style={{
                  padding: "10px 14px",
                  background: on ? `${PURPLE}10` : "#fff",
                  border: `1px solid ${on ? PURPLE : RULE}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: on ? PURPLE : INK }}>{r.label}</div>
                <div style={{ fontSize: 12, color: on ? PURPLE : MUTED, marginTop: 2 }}>{r.hint}</div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Saturday availability">
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={saturdaysOk} onChange={(e) => setSaturdaysOk(e.target.checked)} />
          <span>Yes, I can work some Saturdays this {cycleTitle.split(" ")[0].toLowerCase()}.</span>
        </label>
      </Card>

      <Card title="Anything else we should know?" subtitle="Optional — let your admin know about constraints, preferences, or anything that doesn't fit above.">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. I'm new to teaching robotics so I'd like a developing role for any robotics camp."
          style={textareaStyle}
        />
      </Card>

      {error && (
        <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 12, borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{
        position: "sticky",
        bottom: 0,
        background: CREAM,
        paddingTop: 12,
        paddingBottom: 8,
        display: "flex",
        gap: 10,
        justifyContent: "flex-end",
        alignItems: "center",
      }}>
        <button type="button" onClick={onCancel} disabled={saving} style={cancelBtn(saving)}>
          Cancel
        </button>
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
    <div style={{
      display: "grid",
      gridTemplateColumns: "minmax(160px, 1fr) auto",
      gap: 12,
      alignItems: "center",
      padding: "6px 0",
    }}>
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
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                whiteSpace: "nowrap",
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
  width: "100%",
  padding: "10px 12px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
  color: INK,
  outline: "none",
  boxSizing: "border-box",
  resize: "vertical",
  minHeight: 60,
};

const smallBtn = {
  padding: "5px 10px",
  background: "transparent",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 12,
  fontFamily: "inherit",
  color: PURPLE,
  cursor: "pointer",
};

function primaryBtn(disabled) {
  return {
    padding: "12px 22px",
    background: BRIGHT,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 15,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

function cancelBtn(disabled) {
  return {
    padding: "12px 18px",
    background: "transparent",
    color: MUTED,
    border: `1px solid ${RULE}`,
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "inherit",
    cursor: disabled ? "default" : "pointer",
  };
}
