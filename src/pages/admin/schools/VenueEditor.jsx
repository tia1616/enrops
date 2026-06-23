// VenueEditor — self-contained add/edit for a single program_locations row.
//
// This is the SAME field set + save logic as the classic Locations tab
// (LocationsList.jsx), lifted into a reusable component so the unified Schools
// detail drawer can edit a venue without losing a single field:
//   name · address · area · room · district (picker + create inline) + legacy
//   district code · arrival (instructor + parents) · dismissal (instructor +
//   parents) · food/drink policy · venue contact name/phone/email · notes.
//
// Instructor-facing fields keep their "visible to instructors" badge — they
// render into every offer/patch/reminder email, so the operator needs the
// same signal here as on the classic tab.
//
// Multi-tenant: all writes scoped by org passed in from the caller.

import { useState } from "react";
import { supabase } from "../../../lib/supabase";
import PlacesAutocomplete from "../../../components/PlacesAutocomplete";

const BRIGHT = "#5847C9";
const OK_GREEN = "#3a7c3a";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CORAL = "#D9694F";

const NEW_DISTRICT = "__new__";

function parseCity(address) {
  if (!address) return "";
  const m = /,\s*([^,]+),\s*[A-Za-z]{2}\b/.exec(address);
  return m ? m[1].trim() : "";
}

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

function emptyDraft() {
  return {
    name: "",
    district: "",
    district_id: "",
    newDistrictName: "",
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
}

function draftFrom(loc) {
  return {
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
  };
}

export default function VenueEditor({
  org,
  location = null,
  districts = [],
  partners = [],
  lockedPartnerId = null,
  onSaved,
  onCancel,
  onDistrictsChanged,
}) {
  const isNew = !location;
  const [draft, setDraft] = useState(
    location ? draftFrom(location) : { ...emptyDraft(), partner_id: lockedPartnerId ?? "" },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  function bind(field) {
    return {
      value: draft[field] ?? "",
      onChange: (e) => setDraft((d) => ({ ...d, [field]: e.target.value })),
    };
  }

  function applyPlace({ name, address }) {
    setDraft((d) => ({
      ...d,
      name: name || d.name,
      address: d.address && d.address.trim() ? d.address : (address || d.address),
    }));
  }

  async function save() {
    if (!draft.name?.trim()) { setError("Name is required."); return; }
    if (draft.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.contact_email.trim())) {
      setError("Contact email doesn't look valid. Leave blank if you don't have one.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Resolve the district picker (create inline if needed, dedupe by name).
      let resolvedDistrictId = draft.district_id || null;
      if (draft.district_id === NEW_DISTRICT) {
        const newName = (draft.newDistrictName || "").trim();
        if (!newName) { setError("Enter a name for the new district, or pick an existing one."); setSaving(false); return; }
        const existingMatch = districts.find(
          (d) => (d.name ?? "").trim().toLowerCase() === newName.toLowerCase(),
        );
        if (existingMatch) {
          resolvedDistrictId = existingMatch.id;
        } else {
          const { data: newDistrict, error: distErr } = await supabase
            .from("districts")
            .insert({ organization_id: org.id, name: newName })
            .select("id")
            .single();
          if (distErr) throw distErr;
          resolvedDistrictId = newDistrict.id;
          if (onDistrictsChanged) await onDistrictsChanged();
        }
      }

      const payload = {};
      for (const [k, v] of Object.entries(draft)) {
        if (k === "district_id" || k === "newDistrictName") continue;
        payload[k] = typeof v === "string" && v.trim() === "" ? null : (typeof v === "string" ? v.trim() : v);
      }
      payload.district_id = resolvedDistrictId;
      payload.area = (draft.area && draft.area.trim()) ? draft.area.trim() : (parseCity(draft.address) || null);
      if (lockedPartnerId) payload.partner_id = lockedPartnerId;

      let savedLoc;
      if (isNew) {
        const base = (draft.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "venue";
        const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
        const { data, error: insErr } = await supabase
          .from("program_locations")
          .insert({ ...payload, slug, organization_id: org.id })
          .select("*")
          .single();
        if (insErr) throw insErr;
        savedLoc = data;
      } else {
        const { data, error: updErr } = await supabase
          .from("program_locations")
          .update(payload)
          .eq("id", location.id)
          .select("*")
          .single();
        if (updErr) throw updErr;
        savedLoc = data;
      }
      if (onSaved) await onSaved(savedLoc);
    } catch (err) {
      console.error("[VenueEditor] save failed:", err);
      setError(`Couldn't save: ${err.message ?? "unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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

      {!lockedPartnerId && (
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
      )}

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
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving} style={btn("transparent", MUTED, true, saving)}>
            Cancel
          </button>
        )}
        <button type="button" onClick={save} disabled={saving} style={btn(BRIGHT, "#fff", false, saving)}>
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
            fontSize: 10, color: OK_GREEN, background: `${OK_GREEN}14`,
            padding: "2px 6px", borderRadius: 999, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: 0.4,
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
  padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6,
  fontSize: 14, fontFamily: "inherit", color: INK, background: "#fff",
  outline: "none", boxSizing: "border-box", width: "100%",
};
const textareaStyle = { ...inputStyle, resize: "vertical", minHeight: 60 };
const errorBanner = {
  background: `${CORAL}1F`, border: `1px solid ${CORAL}`, borderRadius: 6,
  padding: "8px 12px", color: CORAL, fontWeight: 500, fontSize: 13,
};
function btn(bg, fg, outlined = false, disabled = false) {
  return {
    display: "inline-block", padding: "8px 14px", background: bg, color: fg,
    border: outlined ? `1px solid ${fg}` : "none", borderRadius: 6,
    cursor: disabled ? "default" : "pointer", fontSize: 14, fontWeight: 500,
    fontFamily: "inherit", opacity: disabled ? 0.5 : 1,
  };
}
