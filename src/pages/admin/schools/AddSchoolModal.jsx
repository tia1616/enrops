// AddSchoolModal — the unified, fast "Add a school" flow.
//
// One step: type the name (Places autocomplete fills the address), pick a type,
// optionally a district, and save. Behind the scenes it writes BOTH a partners
// row and an auto-linked program_locations row (1:1), so every school created
// here is clean from day one — the operator never sees the two-table plumbing.
//
// For umbrellas (Parks & Rec, a district that runs many sites), an "advanced"
// toggle attaches the new venue to an EXISTING partner instead of creating a
// new one — that's how you add venue #2..N under one umbrella.
//
// Contacts + arrival/dismissal/food/notes are intentionally deferred: after
// save we hand the new school to its detail drawer so the operator can add them
// then — or later. Add stays frictionless; nothing is required but the name.

import { useState } from "react";
import { supabase } from "../../../lib/supabase";
import PlacesAutocomplete from "../../../components/PlacesAutocomplete";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";

const NEW_DISTRICT = "__new__";

const PARTNER_TYPES = [
  { v: "public_school", label: "Public school" },
  { v: "private_school", label: "Private school" },
  { v: "charter_school", label: "Charter school" },
  { v: "school_district", label: "School district" },
  { v: "parks_rec", label: "Parks & Rec" },
  { v: "community_org", label: "Community org" },
  { v: "church", label: "Church" },
];

function parseCity(address) {
  if (!address) return "";
  const m = /,\s*([^,]+),\s*[A-Za-z]{2}\b/.exec(address);
  return m ? m[1].trim() : "";
}

export default function AddSchoolModal({ org, districts = [], partners = [], onClose, onCreated, onDistrictsChanged }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("public_school");
  const [address, setAddress] = useState("");
  const [area, setArea] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [newDistrictName, setNewDistrictName] = useState("");
  const [umbrellaMode, setUmbrellaMode] = useState(false);
  const [umbrellaPartnerId, setUmbrellaPartnerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  function applyPlace({ name: placeName, address: placeAddr }) {
    if (placeName) setName(placeName);
    if (placeAddr && !address.trim()) setAddress(placeAddr);
  }

  async function resolveDistrictId() {
    if (districtId !== NEW_DISTRICT) return districtId || null;
    const nm = newDistrictName.trim();
    if (!nm) throw new Error("Enter a name for the new district, or pick an existing one.");
    const existing = districts.find((d) => (d.name ?? "").trim().toLowerCase() === nm.toLowerCase());
    if (existing) return existing.id;
    const { data, error: dErr } = await supabase
      .from("districts").insert({ organization_id: org.id, name: nm }).select("id").single();
    if (dErr) throw dErr;
    if (onDistrictsChanged) await onDistrictsChanged();
    return data.id;
  }

  async function save() {
    setError("");
    const trimmed = name.trim();
    if (!trimmed) { setError("School name is required."); return; }
    if (umbrellaMode && !umbrellaPartnerId) { setError("Pick the umbrella partner this venue belongs to."); return; }
    setBusy(true);
    try {
      const resolvedDistrictId = await resolveDistrictId();
      const resolvedArea = area.trim() || parseCity(address) || null;

      // 1) Partner: reuse the umbrella, or create a fresh 1:1 partner for this school.
      let partnerId;
      if (umbrellaMode) {
        partnerId = umbrellaPartnerId;
      } else {
        const { data: partnerRow, error: pErr } = await supabase
          .from("partners")
          .insert({
            organization_id: org.id,
            partner_name: trimmed,
            partner_type: type || null,
            location_area: resolvedArea,
          })
          .select("id")
          .single();
        if (pErr) throw pErr;
        partnerId = partnerRow.id;
      }

      // 2) Venue: auto-linked to the partner above.
      const base = (trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "venue";
      const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const { data: locRow, error: lErr } = await supabase
        .from("program_locations")
        .insert({
          organization_id: org.id,
          name: trimmed,
          address: address.trim() || null,
          area: resolvedArea,
          district_id: resolvedDistrictId,
          partner_id: partnerId,
          slug,
        })
        .select("id")
        .single();
      if (lErr) {
        // If the partner was just created but the venue failed, surface it clearly —
        // the partner row is harmless (shows as contact-only) and can be retried.
        throw lErr;
      }

      if (onCreated) await onCreated({ partnerId, locationId: locRow.id });
    } catch (e) {
      console.error("[AddSchoolModal] save failed", e);
      setError(e.message ?? "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(28,0,79,0.32)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "6vh 16px", zIndex: 200, fontFamily: "inherit",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 12, maxWidth: 560, width: "100%",
          padding: 24, maxHeight: "88vh", overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: INK }}>Add a school</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          Just the name to start — we'll fill in the address. Add contacts, arrival
          instructions, and the rest right after, or any time later.
        </p>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label>
            <Lbl>School name *</Lbl>
            {placesEnabled ? (
              <PlacesAutocomplete
                value={name}
                onChange={(v) => setName(v)}
                onSelect={applyPlace}
                placeholder="e.g. Ainsworth Elementary, Portland"
                style={inputStyle}
              />
            ) : (
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ainsworth Elementary" style={inputStyle} disabled={busy} />
            )}
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label>
              <Lbl>Type</Lbl>
              <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle} disabled={busy || umbrellaMode}>
                {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </label>
            <label>
              <Lbl>District (optional)</Lbl>
              <select value={districtId} onChange={(e) => setDistrictId(e.target.value)} style={inputStyle} disabled={busy}>
                <option value="">— no district —</option>
                {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value={NEW_DISTRICT}>+ Create a new district…</option>
              </select>
            </label>
          </div>

          {districtId === NEW_DISTRICT && (
            <label>
              <Lbl>New district name</Lbl>
              <input type="text" value={newDistrictName} onChange={(e) => setNewDistrictName(e.target.value)} placeholder="e.g. Portland Public Schools" style={inputStyle} disabled={busy} autoFocus />
            </label>
          )}

          <label>
            <Lbl>Address</Lbl>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Filled from the name, or type it in" style={inputStyle} disabled={busy} />
          </label>

          <div style={{ borderTop: `1px solid ${RULE}`, paddingTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
              <input type="checkbox" checked={umbrellaMode} onChange={(e) => setUmbrellaMode(e.target.checked)} disabled={busy} />
              This venue belongs to a bigger organization (Parks &amp; Rec, a district)
            </label>
            {umbrellaMode && (
              <div style={{ marginTop: 8 }}>
                <select value={umbrellaPartnerId} onChange={(e) => setUmbrellaPartnerId(e.target.value)} style={inputStyle} disabled={busy}>
                  <option value="">— pick the umbrella partner —</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.partner_name}</option>)}
                </select>
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>
                  The venue links to this partner instead of creating a new one. Roster
                  emails go to the umbrella's contacts.
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>
          <button type="button" onClick={onClose} disabled={busy}
            style={{ padding: "9px 16px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: busy ? "wait" : "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy}
            style={{ padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Adding…" : "Add school"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "9px 11px", fontSize: 14, border: `1px solid ${RULE}`,
  borderRadius: 6, fontFamily: "inherit", background: "#fff", color: INK, boxSizing: "border-box",
};

function Lbl({ children }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: MUTED, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
      {children}
    </span>
  );
}
