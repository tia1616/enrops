// src/pages/admin/LocationsList.jsx
// Admin list + inline editor for program_locations. Replaces "Jessica gives Claude
// an address, Claude runs SQL" with a self-serve page. Address / room / contact /
// arrival / food / notes are all instructor-facing — they get rendered into every
// offer, patch, and reminder email under the camp row. District is admin-internal.
//
// Multi-tenant: all reads + writes scoped by org from useOutletContext.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const CORAL = "#D9694F";
const OK_GREEN = "#3a7c3a";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const FIELDS_INSTRUCTOR_FACING = new Set([
  "address", "room_number",
  "contact_name", "contact_phone", "contact_email",
  "arrival_instructions", "dismissal_instructions", "food_drink_policy", "notes",
]);

const EMPTY_DRAFT = {
  name: "",
  district: "",
  address: "",
  room_number: "",
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  arrival_instructions: "",
  dismissal_instructions: "",
  food_drink_policy: "",
  notes: "",
};

export default function LocationsList() {
  const { org } = useOutletContext() ?? {};
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null); // null | location id | 'new'
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    fetchLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function fetchLocations() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("program_locations")
      .select("id, name, district, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes, created_at")
      .eq("organization_id", org.id)
      .order("name", { ascending: true });
    if (err) {
      console.error("Load locations failed:", err);
      setError(`Couldn't load: ${err.message}`);
      setLoading(false);
      return;
    }
    setLocations(data ?? []);
    setLoading(false);
  }

  // Linked camp counts per location (per current cycles) — helps admin understand
  // what a venue's used for before they edit.
  const [campCounts, setCampCounts] = useState(new Map());
  useEffect(() => {
    if (!org?.id || locations.length === 0) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("camp_sessions")
        .select("location_id")
        .eq("organization_id", org.id);
      if (!alive) return;
      const m = new Map();
      for (const r of data ?? []) {
        if (!r.location_id) continue;
        m.set(r.location_id, (m.get(r.location_id) ?? 0) + 1);
      }
      setCampCounts(m);
    })();
    return () => { alive = false; };
  }, [org?.id, locations]);

  function startEdit(loc) {
    setError(null);
    setDraft({
      name: loc.name ?? "",
      district: loc.district ?? "",
      address: loc.address ?? "",
      room_number: loc.room_number ?? "",
      contact_name: loc.contact_name ?? "",
      contact_phone: loc.contact_phone ?? "",
      contact_email: loc.contact_email ?? "",
      arrival_instructions: loc.arrival_instructions ?? "",
      dismissal_instructions: loc.dismissal_instructions ?? "",
      food_drink_policy: loc.food_drink_policy ?? "",
      notes: loc.notes ?? "",
    });
    setEditingId(loc.id);
  }

  function startNew() {
    setError(null);
    setDraft({ ...EMPTY_DRAFT });
    setEditingId("new");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
  }

  function bind(field) {
    return {
      value: draft[field] ?? "",
      onChange: (e) => setDraft((d) => ({ ...d, [field]: e.target.value })),
    };
  }

  async function save() {
    if (!draft.name?.trim()) {
      setError("Name is required.");
      return;
    }
    if (draft.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.contact_email.trim())) {
      setError("Contact email doesn't look valid. Leave blank if you don't have one.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Normalize empty strings to null so they don't render as empty lines in emails.
      const payload = {};
      for (const [k, v] of Object.entries(draft)) {
        payload[k] = typeof v === "string" && v.trim() === "" ? null : (typeof v === "string" ? v.trim() : v);
      }
      if (editingId === "new") {
        const { error: insErr } = await supabase
          .from("program_locations")
          .insert({ ...payload, organization_id: org.id });
        if (insErr) throw insErr;
      } else {
        const { error: updErr } = await supabase
          .from("program_locations")
          .update(payload)
          .eq("id", editingId);
        if (updErr) throw updErr;
      }
      await fetchLocations();
      cancelEdit();
    } catch (err) {
      console.error("Save failed:", err);
      setError(`Couldn't save: ${err.message ?? "unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  if (!org) {
    return <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
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
          <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>Locations</h1>
          <div style={{ color: MUTED, marginTop: 4, fontSize: 14, maxWidth: 720 }}>
            Venues where your programs run. <strong>Address, room number, arrival
            and dismissal instructions, food/drink policy, venue contact, and
            notes</strong> all show up in every offer, add-on offer, and reminder
            email instructors get for a camp here — so write them with the instructor
            in mind.
          </div>
        </div>
        <button
          type="button"
          onClick={startNew}
          disabled={editingId === "new"}
          style={btn(PURPLE, "#fff", false, editingId === "new")}
        >
          + Add new venue
        </button>
      </header>

      {error && editingId === null && (
        <div style={errorBanner}>{error}</div>
      )}

      {loading ? (
        <div style={{ color: MUTED, fontSize: 14, padding: 16 }}>Loading venues…</div>
      ) : (
        <>
          {editingId === "new" && (
            <EditCard
              title="New venue"
              draft={draft}
              bind={bind}
              error={editingId === "new" ? error : null}
              saving={saving}
              onSave={save}
              onCancel={cancelEdit}
              isNew
            />
          )}
          {locations.length === 0 && editingId !== "new" ? (
            <div style={{
              background: "#fff",
              border: `1px dashed ${RULE}`,
              borderRadius: 8,
              padding: 36,
              textAlign: "center",
              color: MUTED,
              fontSize: 14,
            }}>
              No venues yet. Click <strong>+ Add new venue</strong> to set up your first one.
            </div>
          ) : (
            locations.map((loc) => (
              <div key={loc.id}>
                {editingId === loc.id ? (
                  <EditCard
                    title={loc.name}
                    draft={draft}
                    bind={bind}
                    error={error}
                    saving={saving}
                    onSave={save}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <DisplayCard loc={loc} campCount={campCounts.get(loc.id) ?? 0} onEdit={() => startEdit(loc)} />
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

function DisplayCard({ loc, campCount, onEdit }) {
  const fieldsToShow = [
    { label: "Address", value: loc.address, key: "address" },
    { label: "Room", value: loc.room_number, key: "room_number" },
    { label: "Arrival", value: loc.arrival_instructions, key: "arrival_instructions" },
    { label: "Dismissal", value: loc.dismissal_instructions, key: "dismissal_instructions" },
    { label: "Food/drink", value: loc.food_drink_policy, key: "food_drink_policy" },
    { label: "Notes", value: loc.notes, key: "notes" },
  ];
  const contactBits = [loc.contact_name, loc.contact_phone, loc.contact_email].filter(Boolean);
  const populatedFields = fieldsToShow.filter((f) => !!f.value);
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: "16px 22px",
      display: "flex",
      gap: 16,
      alignItems: "flex-start",
      justifyContent: "space-between",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>{loc.name}</div>
          {loc.district && (
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
              {loc.district}
            </div>
          )}
          <div style={{ fontSize: 12, color: MUTED }}>
            {campCount} camp{campCount === 1 ? "" : "s"} scheduled here
          </div>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {populatedFields.length === 0 && contactBits.length === 0 ? (
            <div style={{ fontSize: 13, color: CORAL, fontStyle: "italic" }}>
              No details filled in yet — instructors won't see any extra info for this venue.
            </div>
          ) : (
            <>
              {populatedFields.map((f) => (
                <div key={f.key} style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                  <span style={{ color: MUTED, fontWeight: 600 }}>{f.label}: </span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{f.value}</span>
                </div>
              ))}
              {contactBits.length > 0 && (
                <div style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                  <span style={{ color: MUTED, fontWeight: 600 }}>Venue contact: </span>
                  {contactBits.join(" · ")}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <button type="button" onClick={onEdit} style={btn("transparent", PURPLE, true)}>
        Edit
      </button>
    </div>
  );
}

function EditCard({ title, draft, bind, error, saving, onSave, onCancel, isNew }) {
  return (
    <div style={{
      background: "#fff",
      border: `2px solid ${PURPLE}`,
      borderRadius: 8,
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 14,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>
          {isNew ? "New venue" : `Editing ${title}`}
        </div>
        <div style={{ fontSize: 11, color: MUTED }}>
          Fields marked <span style={{ color: OK_GREEN, fontWeight: 600 }}>visible to instructors</span> show up in offer emails.
        </div>
      </div>

      <Field label="Venue name *" hint="The human-readable label that shows on the calendar and in emails." instructorFacing>
        <input type="text" {...bind("name")} placeholder="e.g. Hillsboro Tyson Rec Center" style={inputStyle} />
      </Field>

      <Field label="Address" instructorFacing>
        <input type="text" {...bind("address")} placeholder="e.g. 2037 Douglas St, Forest Grove, OR 97116" style={inputStyle} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Room number" instructorFacing>
          <input type="text" {...bind("room_number")} placeholder="e.g. Room 12 or Gym B" style={inputStyle} />
        </Field>
        <Field label="District (internal)" hint="Used for internal grouping — not shown to instructors.">
          <input type="text" {...bind("district")} placeholder="e.g. Hillsboro" style={inputStyle} />
        </Field>
      </div>

      <Field label="Arrival instructions" hint="Park where? Enter which door? Sign in where?" instructorFacing>
        <textarea {...bind("arrival_instructions")} placeholder="e.g. Park in the back lot, enter through the gym door, sign in at the front desk." rows={3} style={textareaStyle} />
      </Field>

      <Field label="Dismissal instructions" hint="Where does the instructor walk students to for pickup? Front door? Back parking lot?" instructorFacing>
        <textarea {...bind("dismissal_instructions")} placeholder="e.g. Walk students out the front doors to the parking lot and wait until each one is picked up." rows={3} style={textareaStyle} />
      </Field>

      <Field label="Food / drink policy" instructorFacing>
        <input type="text" {...bind("food_drink_policy")} placeholder="e.g. Peanut-free facility — no outside food in classrooms." style={inputStyle} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        <Field label="Venue contact name" instructorFacing>
          <input type="text" {...bind("contact_name")} placeholder="e.g. Jane Smith" style={inputStyle} />
        </Field>
        <Field label="Venue contact phone" instructorFacing>
          <input type="text" {...bind("contact_phone")} placeholder="e.g. 503-555-1234" style={inputStyle} />
        </Field>
        <Field label="Venue contact email" instructorFacing>
          <input type="email" {...bind("contact_email")} placeholder="e.g. jane@venue.org" style={inputStyle} />
        </Field>
      </div>

      <Field label="Notes" hint="Anything else worth telling the instructor about this venue." instructorFacing>
        <textarea {...bind("notes")} placeholder="e.g. Air conditioning is unreliable on hot days — bring a fan." rows={2} style={textareaStyle} />
      </Field>

      {error && <div style={errorBanner}>{error}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        <button type="button" onClick={onCancel} disabled={saving} style={btn("transparent", MUTED, true, saving)}>
          Cancel
        </button>
        <button type="button" onClick={onSave} disabled={saving} style={btn(PURPLE, "#fff", false, saving)}>
          {saving ? "Saving…" : (isNew ? "Add venue" : "Save changes")}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, instructorFacing, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {label}
        </label>
        {instructorFacing && (
          <span style={{
            fontSize: 10,
            color: OK_GREEN,
            background: `${OK_GREEN}14`,
            padding: "2px 6px",
            borderRadius: 999,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}>
            Visible to instructors
          </span>
        )}
      </div>
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

const errorBanner = {
  background: `${CORAL}1F`,
  border: `1px solid ${CORAL}`,
  borderRadius: 6,
  padding: "8px 12px",
  color: CORAL,
  fontWeight: 500,
  fontSize: 13,
};

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
