// src/pages/j2s/AfterschoolAvailabilityForm.jsx
// Afterschool availability survey. Unlike the camp form (weeks + am/pm/full_day
// + curriculum + role tier), afterschool is one class an hour a week on a fixed
// weekday for the whole term. So we ask only what the afterschool matcher needs:
//   - which weekdays you can teach
//   - the afternoon window you're free (most afterschool runs after dismissal)
//   - specific dates you can't make
//   - how many days a week you want (your target load / seniority)
//   - which schools/locations you prefer
//
// Writes one row to instructor_term_availability, keyed by (org, instructor,
// term). Pre-fills from any existing row so instructors can come back and edit.

import { useEffect, useMemo, useState } from "react";
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

function fmtLong(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

export default function AfterschoolAvailabilityForm({ instructor, term, onSaved, onCancel }) {
  const orgId = instructor?.organization_id;
  const instructorId = instructor?.instructor_id ?? instructor?.id;

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [availableDays, setAvailableDays] = useState(new Set());
  const [earliestStart, setEarliestStart] = useState("");
  const [latestEnd, setLatestEnd] = useState("");
  const [maxDays, setMaxDays] = useState("");
  const [unavailableDates, setUnavailableDates] = useState([]); // array of "YYYY-MM-DD"
  const [newDate, setNewDate] = useState("");
  const [notes, setNotes] = useState("");
  const [locPrefs, setLocPrefs] = useState({}); // location_id -> preference

  const [locations, setLocations] = useState([]);
  const [hasExisting, setHasExisting] = useState(false);

  useEffect(() => {
    if (!instructorId || !orgId || !term) return;
    let alive = true;
    (async () => {
      const [availRes, venuesRes] = await Promise.all([
        supabase
          .from("instructor_term_availability")
          .select("available_days, earliest_start, latest_end, max_days, unavailable_dates, location_preferences, notes, submitted_at")
          .eq("instructor_id", instructorId)
          .eq("term", term)
          .maybeSingle(),
        supabase
          .from("program_locations")
          .select("id, name")
          .eq("organization_id", orgId)
          .order("name", { ascending: true }),
      ]);
      if (!alive) return;

      if (availRes.data) {
        setHasExisting(!!availRes.data.submitted_at);
        setAvailableDays(new Set(availRes.data.available_days ?? []));
        setEarliestStart((availRes.data.earliest_start ?? "").slice(0, 5));
        setLatestEnd((availRes.data.latest_end ?? "").slice(0, 5));
        setMaxDays(availRes.data.max_days != null ? String(availRes.data.max_days) : "");
        setUnavailableDates(availRes.data.unavailable_dates ?? []);
        setNotes(availRes.data.notes ?? "");
        setLocPrefs(availRes.data.location_preferences ?? {});
      }
      setLocations(venuesRes.data ?? []);
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [instructorId, orgId, term]);

  function toggleDay(value) {
    setAvailableDays((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  function addUnavailableDate() {
    if (!newDate) return;
    setUnavailableDates((prev) => (prev.includes(newDate) ? prev : [...prev, newDate].sort()));
    setNewDate("");
  }

  function removeUnavailableDate(d) {
    setUnavailableDates((prev) => prev.filter((x) => x !== d));
  }

  function setLocPref(locationId, preference) {
    setLocPrefs((prev) => ({ ...prev, [locationId]: preference }));
  }

  async function save() {
    setError(null);
    if (availableDays.size === 0) { setError("Pick at least one weekday you can teach."); return; }
    if (earliestStart && latestEnd && latestEnd <= earliestStart) {
      setError("Your latest end time needs to be after your earliest start time."); return;
    }

    setSaving(true);
    try {
      const payload = {
        organization_id: orgId,
        instructor_id: instructorId,
        term,
        available_days: DAYS.map((d) => d.value).filter((v) => availableDays.has(v)),
        earliest_start: earliestStart || null,
        latest_end: latestEnd || null,
        max_days: maxDays ? Number(maxDays) : null,
        unavailable_dates: unavailableDates,
        location_preferences: locPrefs,
        notes: notes.trim() || null,
        submitted_at: new Date().toISOString(),
        needs_confirmation: false,
      };
      const { error: saveErr } = await supabase
        .from("instructor_term_availability")
        .upsert(payload, { onConflict: "organization_id,instructor_id,term" });
      if (saveErr) throw saveErr;
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
          which days you can teach and where — you'll still get to accept or request
          changes on each class before it's confirmed.
        </p>
      </header>

      <Card title="Which weekdays can you teach?" subtitle="Pick every weekday you're open to. We'll only ever assign you classes that fit.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {DAYS.map((d) => {
            const on = availableDays.has(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                style={{
                  padding: "12px 14px",
                  background: on ? `${PURPLE}10` : "#fff",
                  border: `1px solid ${on ? PURPLE : RULE}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  fontSize: 14,
                  fontWeight: 600,
                  color: on ? PURPLE : INK,
                }}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="What time can you work?" subtitle="Most after-school classes start right after dismissal. Set the earliest you can start and the latest you can stay. Leave blank if you're flexible.">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: MUTED }}>
            Earliest start
            <input type="time" value={earliestStart} onChange={(e) => setEarliestStart(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: MUTED }}>
            Latest end
            <input type="time" value={latestEnd} onChange={(e) => setLatestEnd(e.target.value)} style={inputStyle} />
          </label>
        </div>
      </Card>

      <Card title="How many days a week do you want?" subtitle="Your target — we'll try not to assign you more classes than this. Leave blank for no limit.">
        <select value={maxDays} onChange={(e) => setMaxDays(e.target.value)} style={{ ...inputStyle, width: 180 }}>
          <option value="">No limit</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>{n} {n === 1 ? "day" : "days"} a week</option>
          ))}
        </select>
      </Card>

      <Card title="Specific dates you can't make" subtitle="Add any weekday you'll be out (a trip, an appointment). We'll skip classes that land on these dates when we match you.">
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: unavailableDates.length ? 12 : 0 }}>
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={inputStyle} />
          <button type="button" onClick={addUnavailableDate} disabled={!newDate} style={smallBtn}>Add date</button>
        </div>
        {unavailableDates.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {unavailableDates.map((d) => (
              <span key={d} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: `${CORAL}14`, border: `1px solid ${CORAL}`, color: CORAL,
                borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600,
              }}>
                {fmtLong(d)}
                <button type="button" onClick={() => removeUnavailableDate(d)} style={{
                  background: "none", border: "none", color: CORAL, cursor: "pointer",
                  fontSize: 15, lineHeight: 1, padding: 0, fontFamily: "inherit",
                }} aria-label={`Remove ${d}`}>×</button>
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card title="Where do you want to teach?" subtitle="Set your preference for each school. We'll prioritize highly preferred and avoid unavailable ones.">
        {locations.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13, fontStyle: "italic" }}>
            Your admin hasn't added any schools yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {locations.map((loc) => (
              <PrefRow key={loc.id} label={loc.name} value={locPrefs[loc.id]} onChange={(v) => setLocPref(loc.id, v)} />
            ))}
          </div>
        )}
      </Card>

      <Card title="Anything else we should know?" subtitle="Optional — constraints or preferences that don't fit above.">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. I can do Mondays only if it's the school near my house."
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

const smallBtn = {
  padding: "9px 14px", background: "transparent", border: `1px solid ${RULE}`,
  borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: PURPLE, cursor: "pointer",
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
