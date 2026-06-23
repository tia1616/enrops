// src/pages/admin/LocationsList.jsx
// Admin list + inline editor for program_locations. Replaces "Jessica gives Claude
// an address, Claude runs SQL" with a self-serve page. Address / room / contact /
// arrival / food / notes are all instructor-facing — they get rendered into every
// offer, patch, and reminder email under the camp row. District is admin-internal.
//
// Multi-tenant: all reads + writes scoped by org from useOutletContext.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import PlacesAutocomplete from "../../components/PlacesAutocomplete";
import FindMissingAddressesModal from "./FindMissingAddressesModal";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
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

// Friendly labels for partner type — used in the Linked partner dropdown so
// the operator sees "Vancouver Parks & Rec · Parks & Rec" instead of the
// raw enum value.
const PARTNER_TYPE_LABELS = {
  public_school: "Public school",
  private_school: "Private school",
  charter_school: "Charter school",
  school_district: "School district",
  parks_rec: "Parks & Rec",
  community_org: "Community org",
  church: "Church",
};
function partnerTypeLabel(t) { return PARTNER_TYPE_LABELS[t] ?? t; }

// Pull the city out of a US address like "123 Main St, Portland, OR 97201".
function parseCity(address) {
  if (!address) return "";
  const m = /,\s*([^,]+),\s*[A-Za-z]{2}\b/.exec(address);
  return m ? m[1].trim() : "";
}

// Sentinel value for the District picker's "create a new district" option.
const NEW_DISTRICT = "__new__";

const EMPTY_DRAFT = {
  name: "",
  district: "",
  district_id: "",      // structured link to the districts entity (FK)
  newDistrictName: "",  // transient — only used when creating a district inline
  area: "",
  address: "",
  room_number: "",
  partner_id: "",
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  arrival_instructions: "",
  dismissal_instructions: "",
  parent_arrival_instructions: "",
  parent_dismissal_instructions: "",
  food_drink_policy: "",
  notes: "",
};

export default function LocationsList() {
  const { org } = useOutletContext() ?? {};
  const [searchParams, setSearchParams] = useSearchParams();
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null); // null | location id | 'new'
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [findingAddresses, setFindingAddresses] = useState(false);

  // Bulk "find missing addresses" requires Maps to be configured + at least
  // one location missing an address. Hidden otherwise.
  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const missingAddressCount = useMemo(
    () => locations.filter((l) => !l.address || !String(l.address).trim()).length,
    [locations],
  );

  useEffect(() => {
    if (!org?.id) return;
    fetchLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  // Auto-open a specific location's editor when arriving with ?edit=<id> —
  // used by ImportContactsModal's "Edit details" links so the operator lands
  // directly on the row that needs arrival instructions, food policy, etc.
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!editId || locations.length === 0) return;
    const target = locations.find((l) => l.id === editId);
    if (target) {
      startEdit(target);
      // Strip the param so refresh doesn't re-open.
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      setSearchParams(next, { replace: true });
      // Bring the row into view in case the list is long.
      setTimeout(() => {
        document.getElementById(`location-row-${editId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations, searchParams]);

  async function fetchLocations() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("program_locations")
      .select("id, name, district, district_id, area, address, room_number, partner_id, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, parent_arrival_instructions, parent_dismissal_instructions, food_drink_policy, notes, created_at")
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

  // Active partners for the Partner dropdown on the edit form — lets the
  // operator manually link any location to its umbrella partner (e.g.
  // Firstenburg → Vancouver Parks & Rec) when the import's auto-link
  // couldn't infer it from names alone.
  const [partners, setPartners] = useState([]);
  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("partners")
        .select("id, partner_name, partner_type")
        .eq("organization_id", org.id)
        .eq("inactive", false)
        .order("partner_name", { ascending: true });
      if (alive) setPartners(data ?? []);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  // Districts (the structured grouping entity) for the District picker — lets
  // the operator attach a school to "Portland Public Schools district" once
  // instead of retyping a code per school. Created inline from the picker.
  const [districts, setDistricts] = useState([]);
  async function fetchDistricts() {
    if (!org?.id) return;
    const { data } = await supabase
      .from("districts")
      .select("id, name")
      .eq("organization_id", org.id)
      .order("name", { ascending: true });
    setDistricts(data ?? []);
  }
  useEffect(() => {
    fetchDistricts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  const districtNameById = useMemo(() => {
    const m = new Map();
    for (const d of districts) m.set(d.id, d.name);
    return m;
  }, [districts]);

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
      district_id: loc.district_id ?? "",
      newDistrictName: "",
      area: loc.area ?? "",
      address: loc.address ?? "",
      room_number: loc.room_number ?? "",
      partner_id: loc.partner_id ?? "",
      contact_name: loc.contact_name ?? "",
      contact_phone: loc.contact_phone ?? "",
      contact_email: loc.contact_email ?? "",
      arrival_instructions: loc.arrival_instructions ?? "",
      dismissal_instructions: loc.dismissal_instructions ?? "",
      parent_arrival_instructions: loc.parent_arrival_instructions ?? "",
      parent_dismissal_instructions: loc.parent_dismissal_instructions ?? "",
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

  // Called from PlacesAutocomplete when the operator picks a place from the
  // Google Places dropdown. Fills the canonical name and address — never
  // overwrites a non-empty address the operator already typed (in case they
  // pasted before clicking the suggestion).
  function applyPlace({ name, address }) {
    setDraft((d) => ({
      ...d,
      name: name || d.name,
      address: d.address && d.address.trim() ? d.address : (address || d.address),
    }));
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
      // Resolve the District picker. "+ Create new district" inserts the district
      // entity first; otherwise use the selected id (or null to unlink). The
      // legacy free-text `district` column is left untouched — it stays the
      // fallback for calendar matching, and district_id is purely additive.
      let resolvedDistrictId = draft.district_id || null;
      if (draft.district_id === NEW_DISTRICT) {
        const newName = (draft.newDistrictName || "").trim();
        if (!newName) {
          setError("Enter a name for the new district, or pick an existing one.");
          return;
        }
        const { data: newDistrict, error: distErr } = await supabase
          .from("districts")
          .insert({ organization_id: org.id, name: newName })
          .select("id")
          .single();
        if (distErr) throw distErr;
        resolvedDistrictId = newDistrict.id;
      }

      // Normalize empty strings to null so they don't render as empty lines in emails.
      // district_id + newDistrictName are handled explicitly above, not via the loop.
      const payload = {};
      for (const [k, v] of Object.entries(draft)) {
        if (k === "district_id" || k === "newDistrictName") continue;
        payload[k] = typeof v === "string" && v.trim() === "" ? null : (typeof v === "string" ? v.trim() : v);
      }
      payload.district_id = resolvedDistrictId;
      // Area defaults to the address city when left blank (matches the availability survey + matcher).
      payload.area = (draft.area && draft.area.trim()) ? draft.area.trim() : (parseCity(draft.address) || null);
      if (editingId === "new") {
        // program_locations.slug is NOT NULL and globally UNIQUE, but the form
        // doesn't collect one. Generate it from the name with a short random
        // suffix so it's unique even if another tenant has the same venue name.
        const base = (draft.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "venue";
        const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
        const { error: insErr } = await supabase
          .from("program_locations")
          .insert({ ...payload, slug, organization_id: org.id });
        if (insErr) throw insErr;
      } else {
        const { error: updErr } = await supabase
          .from("program_locations")
          .update(payload)
          .eq("id", editingId);
        if (updErr) throw updErr;
      }
      await fetchLocations();
      await fetchDistricts();
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
        borderRadius: 12,
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {placesEnabled && missingAddressCount > 0 && (
            <button
              type="button"
              onClick={() => setFindingAddresses(true)}
              title="Look up addresses for every location that doesn't have one yet"
              style={{
                padding: "10px 14px",
                background: "transparent",
                color: BRIGHT,
                border: `1.5px solid ${BRIGHT}`,
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              ✨ Find missing addresses ({missingAddressCount})
            </button>
          )}
          <button
            type="button"
            onClick={startNew}
            disabled={editingId === "new"}
            style={btn(BRIGHT, "#fff", false, editingId === "new")}
          >
            + Add new venue
          </button>
        </div>
      </header>

      {findingAddresses && (
        <FindMissingAddressesModal
          orgId={org.id}
          locations={locations}
          onClose={() => setFindingAddresses(false)}
          onSaved={() => { fetchLocations(); setFindingAddresses(false); }}
        />
      )}

      {error && editingId === null && (
        <div style={errorBanner}>{error}</div>
      )}

      {loading ? (
        <div style={{ color: MUTED, fontSize: 14, padding: 16 }}>Loading venues…</div>
      ) : locations.length === 0 ? (
        <div style={{
          background: "#fff",
          border: `1px dashed ${RULE}`,
          borderRadius: 12,
          padding: 36,
          textAlign: "center",
          color: MUTED,
          fontSize: 14,
        }}>
          No venues yet. Click <strong>+ Add new venue</strong> to set up your first one.
        </div>
      ) : (
        locations.map((loc) => (
          <div key={loc.id} id={`location-row-${loc.id}`}>
            <DisplayCard loc={loc} campCount={campCounts.get(loc.id) ?? 0} districtName={districtNameById.get(loc.district_id)} onEdit={() => startEdit(loc)} />
          </div>
        ))
      )}

      {/* Add / edit a venue in a right-side drawer — keeps the venues list in view. */}
      {editingId !== null && (
        <div
          onClick={cancelEdit}
          style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(28,0,79,0.28)", display: "flex", justifyContent: "flex-end" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 560, height: "100%", background: "#fff", boxShadow: "-12px 0 40px rgba(0,0,0,0.18)", overflowY: "auto", borderTopLeftRadius: 12, borderBottomLeftRadius: 12 }}
          >
            <EditCard
              title={editingId === "new" ? "New venue" : (locations.find((l) => l.id === editingId)?.name ?? "")}
              draft={draft}
              bind={bind}
              applyPlace={applyPlace}
              partners={partners}
              districts={districts}
              error={error}
              saving={saving}
              onSave={save}
              onCancel={cancelEdit}
              isNew={editingId === "new"}
              inDrawer
            />
          </div>
        </div>
      )}
    </div>
  );
}

function DisplayCard({ loc, campCount, districtName, onEdit }) {
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
      borderRadius: 12,
      padding: "16px 22px",
      display: "flex",
      gap: 16,
      alignItems: "flex-start",
      justifyContent: "space-between",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>{loc.name}</div>
          {(districtName || loc.district) && (
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
              {districtName || loc.district}
            </div>
          )}
          {campCount > 0 && (
            <div style={{ fontSize: 12, color: MUTED }}>
              {campCount} camp{campCount === 1 ? "" : "s"} scheduled here
            </div>
          )}
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
      <button type="button" onClick={onEdit} style={btn("transparent", BRIGHT, true)}>
        Edit
      </button>
    </div>
  );
}

function EditCard({ title, draft, bind, applyPlace, partners, districts, error, saving, onSave, onCancel, isNew, inDrawer }) {
  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  return (
    <div style={{
      background: "#fff",
      border: inDrawer ? "none" : `2px solid ${BRIGHT}`,
      borderRadius: inDrawer ? 0 : 12,
      padding: inDrawer ? "22px 24px 28px" : "20px 22px",
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

      <Field
        label="Venue name *"
        hint={placesEnabled
          ? "Start typing — we'll find the school or venue and fill in the address for you. Or just type the name."
          : "The human-readable label that shows on the calendar and in emails."}
        instructorFacing
      >
        {placesEnabled ? (
          <PlacesAutocomplete
            value={draft.name ?? ""}
            onChange={(v) => bind("name").onChange({ target: { value: v } })}
            onSelect={applyPlace}
            placeholder="e.g. Ainsworth Elementary, Portland"
            style={inputStyle}
          />
        ) : (
          <input type="text" {...bind("name")} placeholder="e.g. Hillsboro Tyson Rec Center" style={inputStyle} />
        )}
      </Field>

      <Field label="Address" instructorFacing>
        <input type="text" {...bind("address")} placeholder="e.g. 2037 Douglas St, Forest Grove, OR 97116" style={inputStyle} />
      </Field>

      <Field label="Area" hint="The area this venue is in (e.g. Portland, Hillsboro). Instructors rank areas in their availability survey, and instructor matching uses it. Defaults to the city from the address.">
        <input type="text" {...bind("area")} placeholder={parseCity(draft.address) ? `e.g. ${parseCity(draft.address)} (from address)` : "e.g. Portland"} style={inputStyle} />
        {!draft.area?.trim() && parseCity(draft.address) && (
          <button
            type="button"
            onClick={() => setDraft((d) => ({ ...d, area: parseCity(d.address) }))}
            style={{ marginTop: 6, background: "transparent", border: "none", color: BRIGHT, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            Use &quot;{parseCity(draft.address)}&quot;
          </button>
        )}
      </Field>

      <Field
        label="District"
        hint="Group this school under a district (e.g. Portland Public Schools) so its academic calendar applies automatically. Set one up once, then attach every school in it. Not shown to instructors."
      >
        <select {...bind("district_id")} style={inputStyle}>
          <option value="">— no district —</option>
          {(districts ?? []).map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
          <option value={NEW_DISTRICT}>+ Create a new district…</option>
        </select>
        {draft.district_id === NEW_DISTRICT && (
          <input
            type="text"
            {...bind("newDistrictName")}
            placeholder="New district name, e.g. Portland Public Schools"
            style={{ ...inputStyle, marginTop: 8 }}
            autoFocus
          />
        )}
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Room number" instructorFacing>
          <input type="text" {...bind("room_number")} placeholder="e.g. Room 12 or Gym B" style={inputStyle} />
        </Field>
        <Field label="Legacy district code (internal)" hint="Older free-text code, kept only to match calendars you uploaded before districts existed. Prefer the District picker above.">
          <input type="text" {...bind("district")} placeholder="e.g. Hillsboro" style={inputStyle} />
        </Field>
      </div>

      <Field
        label="Linked partner"
        hint="The org that operates this venue — usually the school itself, or the umbrella for community venues (e.g. Firstenburg → Vancouver Parks & Rec). Roster emails go to this partner's contacts."
      >
        <select {...bind("partner_id")} style={inputStyle}>
          <option value="">— not linked —</option>
          {(partners ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.partner_name}{p.partner_type ? ` · ${partnerTypeLabel(p.partner_type)}` : ""}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Arrival instructions (instructor)" hint="Park where? Door codes? Sign-in routine? Keys? — only seen by instructors, never sent to parents." instructorFacing>
        <textarea {...bind("arrival_instructions")} placeholder="e.g. Park in the back lot, enter through the gym door, sign in at the front desk. Door code: 4827#." rows={3} style={textareaStyle} />
      </Field>

      <Field label="Arrival instructions (parents)" hint="What parents need to know to drop their kid off — sent in welcome emails 7 days before the first session. Leave blank to skip the arrival block in parent welcomes.">
        <textarea {...bind("parent_arrival_instructions")} placeholder="e.g. A school staff member will bring students to the lunchroom at 3pm. Pickup at 4pm from the front parking lot." rows={3} style={textareaStyle} />
      </Field>

      <Field label="Dismissal instructions (instructor)" hint="Where the instructor walks students to for pickup, including any key/badge return routine — instructor-only." instructorFacing>
        <textarea {...bind("dismissal_instructions")} placeholder="e.g. Walk students out to the front parking lot. Return classroom key to the office." rows={3} style={textareaStyle} />
      </Field>

      <Field label="Dismissal instructions (parents)" hint="Parent-safe dismissal text — sent in welcome emails. Often already covered in the arrival paragraph; leave blank if so.">
        <textarea {...bind("parent_dismissal_instructions")} placeholder="e.g. Pickup is at the lobby at 12:30pm sharp." rows={3} style={textareaStyle} />
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
        <button type="button" onClick={onSave} disabled={saving} style={btn(BRIGHT, "#fff", false, saving)}>
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
