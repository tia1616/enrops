// SiteDetailDrawer: one place to manage a site that has NO school partner (a
// studio, the provider's own space). The partner-site twin is SchoolDetailDrawer.
//
// Exists because every provider now gets the one partner-first Locations list
// (Jessica 2026-11-19, "Yes, school cards"). Before that, a self-serve provider's
// partner-less sites were the normal case and lived on a separate flat list.
//
// It reuses VenueEditor for every field (no second editor), and offers the one
// thing a studio card can't do in place: "This is at a school or another
// organization's site", which turns it into a school-partner site through
// make_site_a_partner (one transaction) and hands over to SchoolDetailDrawer.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { makeSiteAPartner } from "../../../lib/saveSite.js";
import VenueEditor from "./VenueEditor.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CREAM = "#FBFBFB";
const RED = "#b53737";

const SITE_COLUMNS = "id, name, address, area, room_number, district_id, district, partner_id, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, parent_arrival_instructions, parent_dismissal_instructions, food_drink_policy, notes";

export default function SiteDetailDrawer({ org, locationId, districts = [], partners = [], onClose, onChanged, onDistrictsChanged, onBecamePartner, districtsWarning = "" }) {
  const [site, setSite] = useState(null);       // null = loading
  const [loadErr, setLoadErr] = useState("");
  const [converting, setConverting] = useState(false);
  const [convertErr, setConvertErr] = useState("");

  async function loadSite() {
    const { data, error } = await supabase
      .from("program_locations")
      .select(SITE_COLUMNS)
      .eq("organization_id", org.id)
      .eq("id", locationId)
      .single();
    if (error) { setLoadErr(`Couldn't load this location: ${error.message}`); return null; }
    setSite(data);
    return data;
  }

  useEffect(() => {
    loadSite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, org.id]);

  async function afterSaved(row) {
    // Linking it to an existing partner from the editor's dropdown makes it a
    // school site: hand over to the school drawer so contacts are one tap away.
    if (row?.partner_id && onBecamePartner) {
      if (onChanged) await onChanged();
      onBecamePartner(row.partner_id);
      return;
    }
    await loadSite();
    if (onChanged) await onChanged();
  }

  async function makePartner() {
    if (!site || converting) return;
    setConverting(true);
    setConvertErr("");
    try {
      const row = await makeSiteAPartner(supabase, site.id);
      if (onChanged) await onChanged();
      if (onBecamePartner) onBecamePartner(row.partner_id);
    } catch (e) {
      setConvertErr(e?.message ?? "Couldn't change that. Try again.");
      setConverting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(28,0,79,0.28)", display: "flex", justifyContent: "flex-end" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 600, height: "100%", background: "#fff", boxShadow: "-12px 0 40px rgba(0,0,0,0.18)", overflowY: "auto" }}
      >
        <div style={{ padding: "20px 24px 14px", borderBottom: `1px solid ${RULE}`, position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: INK }}>{site?.name ?? "Location"}</h2>
            <button type="button" onClick={onClose} aria-label="Close"
              style={{ background: "transparent", border: "none", color: MUTED, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
          </div>
        </div>

        <div style={{ padding: "18px 24px 40px", display: "flex", flexDirection: "column", gap: 22 }}>
          {loadErr && <div style={{ color: RED, fontSize: 13 }}>{loadErr}</div>}
          {!loadErr && site === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}

          {site && (
            <>
              <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                  This is at a school or another organization&apos;s site
                </div>
                <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
                  We&apos;ll add it as a school partner too, so you can send them rosters.
                </div>
                {convertErr && <div style={{ color: RED, fontSize: 12.5, marginTop: 8 }}>{convertErr}</div>}
                <button type="button" onClick={makePartner} disabled={converting}
                  style={{ marginTop: 10, padding: "8px 14px", background: "#fff", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: converting ? "wait" : "pointer", opacity: converting ? 0.6 : 1 }}>
                  {converting ? "Adding…" : "Add as a school partner"}
                </button>
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>
                  Location details
                </div>
                <VenueEditor
                  key={site.id}
                  org={org}
                  location={site}
                  districts={districts}
                  partners={partners}
                  onSaved={afterSaved}
                  onDistrictsChanged={onDistrictsChanged}
                  districtsWarning={districtsWarning}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
