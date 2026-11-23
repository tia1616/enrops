// AddSchoolModal — the unified, fast "Add a location" flow.
//
// One step: type the name (Places autocomplete fills the address), pick a type,
// choose the district, and save. When "This is at a school or another
// organization's site" is ticked it writes BOTH a partners row and an auto-linked
// program_locations row (1:1) through save_site; unticked (a studio, the
// provider's own space) it writes the site alone.
//
// DISTRICT IS AN EXPLICIT CHOICE (2026-08-05). The district select used to
// default to "" = "no public district", so an operator who never touched it got
// a location with no district — and therefore programs whose dates never skip
// no-school days, with nothing on screen saying so. On prod, 17 of one
// provider's 22 locations were in that state. Now "" means UNCHOSEN and save
// refuses it; "no district" is still available but must be picked deliberately,
// and states its consequence. Nothing here auto-detects a district (Places fills
// only name + address) — the operator always chooses.
//
// For umbrellas (Parks & Rec, a district that runs many sites), an "advanced"
// toggle attaches the new venue to an EXISTING partner instead of creating a
// new one — that's how you add venue #2..N under one umbrella.
//
// Contacts + arrival/dismissal/food/notes are intentionally deferred: after
// save we hand the new school to its detail drawer so the operator can add them
// then — or later. Add stays frictionless; nothing is required but the name.

import { useState, useEffect, useRef } from "react";
import { supabase } from "../../../lib/supabase";
import { groupingDistricts } from "../../../lib/districts.js";
import { saveSite, NEW_DISTRICT, NO_DISTRICT } from "../../../lib/saveSite.js";
import PlacesAutocomplete, { PlacesLookupHint } from "../../../components/PlacesAutocomplete";
import DistrictsWarning from "../../../components/DistrictsWarning.jsx";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";

// NEW_DISTRICT / NO_DISTRICT come from lib/saveSite.js. NO_DISTRICT is the
// explicit "this place has no district" (a library, church, private site), kept
// distinct from "" so an untouched select can't silently mean "no district".
const NEW_UMBRELLA = "__new_umbrella__";

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

export default function AddSchoolModal({ org, districts = [], partners = [], onClose, onCreated, onDistrictsChanged, districtsWarning = "", initialUmbrellaPartnerId = "" }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("public_school");
  const [address, setAddress] = useState("");
  const [area, setArea] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [newDistrictName, setNewDistrictName] = useState("");
  // "Is this at a school or another organization's site?" Every provider gets
  // this one list now, including studios, so the school partner is no longer
  // assumed. Starts ticked for partner-first orgs (J2S, Jeff: every site has
  // been a partner site) and for a self-serve provider who said they go out to
  // sites; unticked for a studio.
  // initialUmbrellaPartnerId: opened from the contact import's "Add a site" for
  // a district or Parks & Rec it just imported. Starts on "belongs to a bigger
  // organization" with that partner picked, so the operator only types the
  // real venue's name, address and district (Jessica 2026-11-20: the import
  // used to save a site named after the district itself, with nothing else).
  const [atPartner, setAtPartner] = useState(
    initialUmbrellaPartnerId
      ? true
      : org?.venue_model === "own_venue" ? org?.venue_answer === "goes_to_sites" : true,
  );
  const [umbrellaMode, setUmbrellaMode] = useState(!!initialUmbrellaPartnerId);
  const [umbrellaPartnerId, setUmbrellaPartnerId] = useState(initialUmbrellaPartnerId || "");
  const [newUmbrellaName, setNewUmbrellaName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The error banner sits at the TOP of a max-height/scrollable dialog while Save
  // is at the BOTTOM, so a refusal could render off-screen and read as a dead
  // button. That matters more now that "you haven't chosen a district" is a
  // reachable refusal (it fires on the untouched default), so pull the message
  // into view whenever one appears.
  const errorRef = useRef(null);
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [error]);

  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  // Whether the Google lookup actually started. Without this the field degrades
  // to a plain box on failure and says nothing, which reads as broken.
  const [lookupDown, setLookupDown] = useState(false);

  function applyPlace({ name: placeName, address: placeAddr }) {
    if (placeName) setName(placeName);
    if (placeAddr && !address.trim()) setAddress(placeAddr);
  }

  async function save() {
    setError("");
    const trimmed = name.trim();
    if (!trimmed) { setError("Location name is required."); return; }
    if (atPartner && umbrellaMode && !umbrellaPartnerId) { setError("Pick the umbrella org this venue belongs to, or create one."); return; }
    if (atPartner && umbrellaMode && umbrellaPartnerId === NEW_UMBRELLA && !newUmbrellaName.trim()) {
      setError("Enter a name for the new umbrella org."); return;
    }
    setBusy(true);
    try {
      // ONE transaction (save_site): district, school partner and site land
      // together or not at all. This used to be three separate inserts, and a
      // failed site insert left an orphan partner behind.
      //   - umbrella, existing  -> link to it
      //   - umbrella, new       -> create it (a same-name umbrella is reused)
      //   - otherwise           -> create this school's own 1:1 partner
      const useUmbrella = atPartner && umbrellaMode;
      const isUmbrellaPick = useUmbrella && umbrellaPartnerId !== NEW_UMBRELLA;
      const isUmbrellaNew = useUmbrella && umbrellaPartnerId === NEW_UMBRELLA;
      const row = await saveSite(supabase, {
        organizationId: org.id,
        name: trimmed,
        address,
        area: area.trim() || parseCity(address) || "",
        atPartner,
        partnerId: isUmbrellaPick ? umbrellaPartnerId : null,
        partnerName: isUmbrellaNew ? newUmbrellaName : "",
        partnerType: !atPartner || useUmbrella ? "" : type,
        partnerIsUmbrella: useUmbrella,
        districtChoice: districtId,
        newDistrictName,
      });
      if (districtId === NEW_DISTRICT && onDistrictsChanged) await onDistrictsChanged();

      if (onCreated) await onCreated({ partnerId: row.partner_id, locationId: row.id });
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
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: INK }}>Add a location</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          Just the name to start — we'll fill in the address. Add contacts, arrival
          instructions, and the rest right after, or any time later.
        </p>

        {error && (
          <div ref={errorRef} style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label>
            <Lbl>Location name *</Lbl>
            {placesEnabled ? (
              <PlacesAutocomplete
                value={name}
                onChange={(v) => setName(v)}
                onSelect={applyPlace}
                onLookupUnavailable={setLookupDown}
                placeholder="e.g. Ainsworth Elementary, Portland"
                style={inputStyle}
              />
            ) : (
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ainsworth Elementary" style={inputStyle} disabled={busy} />
            )}
            {/* This modal has no hint slot, so the status line goes directly
                under the field the operator is typing into. */}
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
              <PlacesLookupHint enabled={placesEnabled} down={lookupDown} />
            </div>
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14, color: INK, cursor: "pointer", lineHeight: 1.4 }}>
            <input type="checkbox" checked={atPartner} onChange={(e) => setAtPartner(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
            <span>
              This is at a school or another organization&apos;s site
              <span style={{ display: "block", fontSize: 12, color: MUTED, marginTop: 2 }}>
                We&apos;ll add it as a school partner too, so you can send them rosters.
              </span>
            </span>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: atPartner ? "1fr 1fr" : "1fr", gap: 14 }}>
            {atPartner && (
              <label>
                <Lbl>Type</Lbl>
                <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle} disabled={busy || umbrellaMode}>
                  {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
              </label>
            )}
            <label>
              <Lbl>District *</Lbl>
              <select value={districtId} onChange={(e) => setDistrictId(e.target.value)} style={inputStyle} disabled={busy}>
                <option value="">Choose a district…</option>
                {/* groupingDistricts: never offer an independent_school row as another
                    school's district. `districts` stays unfiltered for the
                    name-match-before-create in ensureDistrict above. */}
                {groupingDistricts(districts).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value={NEW_DISTRICT}>+ Create a new district…</option>
                <option value={NO_DISTRICT}>No district (library, church, private site)</option>
              </select>
              {/* INSIDE the modal, because this modal is position:fixed at zIndex 200
                  and covers whatever banner the page behind it is showing. This field
                  is required and its match-before-create reads the same list, so an
                  operator who cannot see the warning creates a duplicate district. */}
              <DistrictsWarning message={districtsWarning} />
            </label>
          </div>

          {/* Say what the district DOES, and what skipping it costs, right where
              the choice is made. Three states, three sentences (no shared
              fallback that would overstate the unchosen case). */}
          <div style={{ fontSize: 12, color: districtId === NO_DISTRICT ? "#8a6d1f" : MUTED, marginTop: -6, lineHeight: 1.5 }}>
            {districtId === NO_DISTRICT
              ? "No district means no school calendar here, so this location's class dates won't skip no-school days. You can set a district later."
              : districtId === ""
                ? "The district's calendar is what makes class dates skip no-school days. Pick the one this location follows."
                /* Deliberately conditional: a just-created district (and an
                   existing one nobody has uploaded a calendar for yet) has no
                   no-school dates on file, so promising dates "will skip
                   automatically" would be false in exactly the state a new
                   operator is in. */
                : "Class dates here will skip this district's no-school days once its school calendar is on file."}
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

          {atPartner && <div style={{ borderTop: `1px solid ${RULE}`, paddingTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
              <input type="checkbox" checked={umbrellaMode} onChange={(e) => setUmbrellaMode(e.target.checked)} disabled={busy} />
              This venue belongs to a bigger organization (Parks &amp; Rec, a district)
            </label>
            {umbrellaMode && (
              <div style={{ marginTop: 8 }}>
                <select value={umbrellaPartnerId} onChange={(e) => setUmbrellaPartnerId(e.target.value)} style={inputStyle} disabled={busy}>
                  <option value="">— pick the umbrella org —</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.partner_name}</option>)}
                  <option value={NEW_UMBRELLA}>+ Create a new umbrella org…</option>
                </select>
                {umbrellaPartnerId === NEW_UMBRELLA && (
                  <input
                    type="text"
                    value={newUmbrellaName}
                    onChange={(e) => setNewUmbrellaName(e.target.value)}
                    placeholder="e.g. Multnomah County Library"
                    style={{ ...inputStyle, marginTop: 8 }}
                    disabled={busy}
                    autoFocus
                  />
                )}
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>
                  The venue links to this partner instead of creating a new one. Roster
                  emails go to the umbrella's contacts.
                </div>
              </div>
            )}
          </div>}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>
          <button type="button" onClick={onClose} disabled={busy}
            style={{ padding: "9px 16px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: busy ? "wait" : "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy}
            style={{ padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Adding…" : "Add location"}
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
