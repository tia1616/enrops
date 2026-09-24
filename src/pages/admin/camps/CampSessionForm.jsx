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
import { isUnset } from "../../../lib/grades.js";
import ModalShell from "../../../components/ModalShell.jsx";

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

// camp_sessions.class_days stores lowercase day names - that is the spelling the
// 51 existing rows use and the spelling session-confirmation-cron lowercases and
// matches against when it seeds a pay line. A capitalised day here would mean an
// instructor silently never gets paid for that day.
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
  week_num: "",
  session_type: "",
  curriculum_id: "",
  curriculum_category: "",
  start_time: "",
  end_time: "",
  class_days: WEEKDAYS.map((d) => d.value),
  ages_min: "",
  ages_max: "",
  max_capacity: "",
  price_cents: null,
  early_bird_price_cents: null,
  early_bird_deadline: "",
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

export default function CampSessionForm({ orgId, cycle, session = null, onClose, onSaved }) {
  const isEdit = Boolean(session?.id);

  const [form, setForm] = useState(EMPTY);
  // Which fields the operator has typed in themselves. A prefill must never
  // overwrite a value they chose - same rule the program wizard follows when a
  // curriculum seeds class size.
  const [touched, setTouched] = useState(() => new Set());
  const [prefilled, setPrefilled] = useState([]);

  const [locations, setLocations] = useState([]);
  const [curricula, setCurricula] = useState([]);
  // Start/end times this org has actually used, per session type, so the form can
  // default without inventing hours for somebody else's business.
  const [timeDefaults, setTimeDefaults] = useState({});
  // Two independent loads - the pickers, and (when editing) the camp's own row.
  // One shared flag would let whichever finished first clear it and render the
  // form with empty dropdowns while the other was still in flight.
  const [loadingLists, setLoadingLists] = useState(true);
  const [loadingRow, setLoadingRow] = useState(Boolean(session?.id));
  const loading = loadingLists || loadingRow;
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
        const [locRes, curRes, timeRes] = await Promise.all([
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
        .select("id, location_id, week_num, session_type, curriculum_id, curriculum_category, start_time, end_time, class_days, ages_min, ages_max, max_capacity, price_cents, early_bird_price_cents, early_bird_deadline, notes")
        .eq("id", session.id)
        .single();
      if (cancelled) return;
      if (error) {
        setLoadError(`Could not open that camp: `);
        setLoadingRow(false);
        return;
      }
      setForm({
        location_id: data.location_id ?? "",
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
      setLoadingRow(false);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Picking a curriculum seeds category, ages and THE SEAT CAP. Untouched fields
  // only - see the `touched` note above.
  function chooseCurriculum(curriculumId) {
    const cur = curricula.find((c) => c.id === curriculumId);
    setTouched((t) => new Set(t).add("curriculum_id"));
    if (!cur) {
      setForm((f) => ({ ...f, curriculum_id: curriculumId }));
      setPrefilled([]);
      return;
    }
    const filled = [];
    setForm((f) => {
      const next = { ...f, curriculum_id: curriculumId };
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
      }
      return next;
    });
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

  function toggleDay(day) {
    setTouched((t) => new Set(t).add("class_days"));
    setForm((f) => ({
      ...f,
      class_days: f.class_days.includes(day)
        ? f.class_days.filter((d) => d !== day)
        : WEEKDAYS.map((d) => d.value).filter((d) => f.class_days.includes(d) || d === day),
    }));
  }

  function handleMoney(name, value) {
    if (value === "" || value === null) { field(name, null); return; }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    field(name, Math.round(num * 100));
  }

  const selectedWeek = weeks.find((w) => String(w.num) === String(form.week_num)) ?? null;

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
    const capacity = intOrNull(form.max_capacity);
    if (capacity != null && capacity <= 0) {
      e.push("Leave the class size blank for no limit, or set it above zero.");
    }
    const aMin = intOrNull(form.ages_min);
    const aMax = intOrNull(form.ages_max);
    if (aMin != null && aMax != null && aMin > aMax) e.push("The youngest age has to be below the oldest.");
    // camp_sessions_eb_lower_than_regular / _eb_deadline_requires_eb_price.
    if (form.early_bird_price_cents != null && form.price_cents != null
      && form.early_bird_price_cents >= form.price_cents) {
      e.push("The early bird price has to be lower than the regular price.");
    }
    if (form.early_bird_deadline && form.early_bird_price_cents == null) {
      e.push("An early bird deadline needs an early bird price.");
    }
    return e;
  }, [form, selectedWeek]);

  async function handleSubmit() {
    setSaveError("");
    if (errors.length) return;
    setSaving(true);
    try {
      const location = locations.find((l) => l.id === form.location_id);
      const curriculum = curricula.find((c) => c.id === form.curriculum_id);
      if (!location) throw new Error("That site is no longer in your list. Pick another.");
      if (!curriculum) throw new Error("That curriculum is no longer published. Pick another.");

      // location_name is NOT NULL and denormalised alongside location_id - the
      // schedule board, rosters and the matcher's venue-region map all read the
      // name. Writing one without the other is what leaves a camp unplaceable.
      const payload = {
        location_id: location.id,
        location_name: location.name,
        week_num: selectedWeek.num,
        starts_on: selectedWeek.starts_on,
        ends_on: selectedWeek.ends_on,
        session_type: form.session_type,
        curriculum_id: curriculum.id,
        curriculum_name: curriculum.name,
        curriculum_category: form.curriculum_category,
        start_time: form.start_time,
        end_time: form.end_time,
        class_days: form.class_days,
        ages_min: intOrNull(form.ages_min),
        ages_max: intOrNull(form.ages_max),
        max_capacity: intOrNull(form.max_capacity),
        price_cents: form.price_cents,
        early_bird_price_cents: form.early_bird_price_cents,
        early_bird_deadline: form.early_bird_deadline || null,
        notes: form.notes.trim() || null,
      };

      if (isEdit) {
        // Named columns only. A whole-row write here would reset the fields this
        // form does not own - current_enrollment, enrollment_synced_at, status,
        // parent_session_id - and silently undo a roster sync or a cancellation.
        const { error } = await supabase
          .from("camp_sessions")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", session.id)
          .eq("organization_id", orgId);
        if (error) throw error;
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

  if (locations.length === 0 || curricula.length === 0) {
    return (
      <ModalShell title={title} onClose={onClose} maxWidth={620}>
        <div style={{ padding: 24, fontSize: 14, color: INK, lineHeight: 1.6 }}>
          {locations.length === 0 && <p style={{ marginTop: 0 }}>You need at least one site before you can put a camp anywhere. Add one under Schools &amp; sites.</p>}
          {curricula.length === 0 && <p style={{ marginBottom: 0 }}>You need a published curriculum before you can schedule a camp. Publish one under Curricula.</p>}
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={title} onClose={onClose} maxWidth={620}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, color: MUTED }}>
          {cycle?.name ? <>Adding to <strong style={{ color: INK }}>{cycle.name}</strong>.</> : null}{" "}
          Families see this camp once registration opens for this term.
        </div>

        <div>
          <label style={labelStyle} htmlFor="camp-site">Site</label>
          <select id="camp-site" value={form.location_id} onChange={(e) => field("location_id", e.target.value)} style={fieldStyle}>
            <option value="">Pick a site…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
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
          <div>
            <label style={labelStyle} htmlFor="camp-ages-min">Youngest age</label>
            <input id="camp-ages-min" type="number" min="0" value={form.ages_min} onChange={(e) => field("ages_min", e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="camp-ages-max">Oldest age</label>
            <input id="camp-ages-max" type="number" min="0" value={form.ages_max} onChange={(e) => field("ages_max", e.target.value)} style={fieldStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle} htmlFor="camp-capacity">Most children who can join</label>
          <input id="camp-capacity" type="number" min="1" value={form.max_capacity} onChange={(e) => field("max_capacity", e.target.value)} style={{ ...fieldStyle, maxWidth: 160 }} />
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
            Registration stops accepting children once the camp reaches this number.
            Leave it blank and the camp takes everyone who signs up.
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
