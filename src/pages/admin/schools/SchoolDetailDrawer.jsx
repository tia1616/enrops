// SchoolDetailDrawer — the single place to manage everything about one school.
//
// A "school" is one partner + its venue(s). This drawer composes the SAME
// editors used on the classic tabs, so no field or capability is lost — it's a
// re-composition, not a rewrite:
//   • Venue & logistics → VenueEditor (full program_locations field set)
//   • Contacts          → ContactsList (reused from PartnerListSection)
//   • Relationship      → PartnerEditor (reused from PartnerListSection)
//   • District & calendar → summary + link to the Calendars tab
//   • Programs here     → read-only activity (programs + camps at the venue)
//
// A normal 1:1 school shows its one venue expanded (one place to edit). An
// umbrella (Parks & Rec / district) lists its venues, each editable, plus an
// "Add another venue" path pre-linked to the umbrella partner.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../lib/supabase";
import Chevron from "../../../components/Chevron.jsx";
import VenueEditor from "./VenueEditor.jsx";
import { PartnerEditor, ContactsList } from "../contacts/PartnerListSection.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CREAM = "#FBFBFB";
const OK = "#3a7c3a";

const PARTNER_TYPE_LABELS = {
  public_school: "Public school",
  private_school: "Private school",
  charter_school: "Charter school",
  school_district: "School district",
  parks_rec: "Parks & Rec",
  community_org: "Community org",
  church: "Church",
};

export default function SchoolDetailDrawer({ org, partner, districts = [], partners = [], onClose, onChanged, onDistrictsChanged }) {
  const navigate = useNavigate();
  const [venues, setVenues] = useState(null);   // null = loading
  const [activity, setActivity] = useState({ programs: 0, camps: 0 });
  const [calendarYears, setCalendarYears] = useState([]);
  const [addingVenue, setAddingVenue] = useState(false);
  const [openVenueId, setOpenVenueId] = useState(null);

  async function loadVenues() {
    const { data } = await supabase
      .from("program_locations")
      .select("id, name, address, area, room_number, district_id, district, partner_id, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, parent_arrival_instructions, parent_dismissal_instructions, food_drink_policy, notes")
      .eq("organization_id", org.id)
      .eq("partner_id", partner.id)
      .order("name", { ascending: true });
    const rows = data ?? [];
    setVenues(rows);
    // Single-venue school: open its editor by default (one place to edit).
    if (rows.length === 1) setOpenVenueId((cur) => cur ?? rows[0].id);
    return rows;
  }

  useEffect(() => {
    loadVenues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner.id, org.id]);

  // Activity (programs + camps) across this school's venues.
  useEffect(() => {
    if (!venues || venues.length === 0) { setActivity({ programs: 0, camps: 0 }); return; }
    let alive = true;
    const ids = venues.map((v) => v.id);
    (async () => {
      const [{ count: programs }, { count: camps }] = await Promise.all([
        supabase.from("programs").select("id", { count: "exact", head: true }).eq("organization_id", org.id).in("program_location_id", ids),
        supabase.from("camp_sessions").select("id", { count: "exact", head: true }).eq("organization_id", org.id).in("location_id", ids),
      ]);
      if (alive) setActivity({ programs: programs ?? 0, camps: camps ?? 0 });
    })();
    return () => { alive = false; };
  }, [venues]);

  // Calendar readiness: does this school's district have any calendar on file?
  const districtId = venues?.find((v) => v.district_id)?.district_id ?? null;
  useEffect(() => {
    if (!districtId) { setCalendarYears([]); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("district_calendars")
        .select("school_year")
        .eq("organization_id", org.id)
        .eq("district_id", districtId)
        .order("school_year", { ascending: false });
      if (alive) setCalendarYears((data ?? []).map((r) => r.school_year));
    })();
    return () => { alive = false; };
  }, [districtId, org.id]);

  const districtName = districts.find((d) => d.id === districtId)?.name ?? null;
  const typeLabel = PARTNER_TYPE_LABELS[partner.partner_type] ?? partner.partner_type;

  async function afterVenueSaved() {
    setAddingVenue(false);
    await loadVenues();
    if (onChanged) await onChanged();
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
        {/* Header */}
        <div style={{ padding: "20px 24px 14px", borderBottom: `1px solid ${RULE}`, position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: INK }}>{partner.partner_name}</h2>
                {typeLabel && (
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: `${PURPLE}10`, color: PURPLE, fontWeight: 600 }}>{typeLabel}</span>
                )}
                {venues && venues.length > 1 && (
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#eee", color: MUTED, fontWeight: 600 }}>
                    umbrella · {venues.length} venues
                  </span>
                )}
              </div>
              {districtName && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{districtName}</div>
              )}
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              style={{ background: "transparent", border: "none", color: MUTED, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
          </div>
          {venues && (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8 }}>
              {activity.programs > 0 || activity.camps > 0
                ? `${activity.programs} program${activity.programs === 1 ? "" : "s"} · ${activity.camps} camp${activity.camps === 1 ? "" : "s"} scheduled here`
                : "No programs or camps scheduled here yet"}
            </div>
          )}
        </div>

        <div style={{ padding: "18px 24px 40px", display: "flex", flexDirection: "column", gap: 22 }}>
          {/* Venue & logistics */}
          <Section title="Venue & logistics" hint="Address, room, arrival/dismissal, food policy and notes — these render into instructor offer, patch, and reminder emails.">
            {venues === null ? (
              <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
            ) : venues.length === 0 ? (
              addingVenue ? (
                <div style={editorWrap}>
                  <VenueEditor org={org} location={null} districts={districts} partners={partners}
                    lockedPartnerId={partner.id} onSaved={afterVenueSaved} onCancel={() => setAddingVenue(false)}
                    onDistrictsChanged={onDistrictsChanged} />
                </div>
              ) : (
                <div style={{ background: CREAM, border: `1px dashed ${RULE}`, borderRadius: 8, padding: 16, fontSize: 13, color: MUTED }}>
                  No venue yet — this is a contact-only partner (an umbrella or district office).{" "}
                  <button type="button" onClick={() => setAddingVenue(true)} style={linkBtn}>Add a venue</button> where programs run.
                </div>
              )
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {venues.map((v) => {
                  const open = openVenueId === v.id;
                  return (
                    <div key={v.id} style={{ border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
                      <button type="button" onClick={() => setOpenVenueId(open ? null : v.id)}
                        style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "10px 12px", background: open ? CREAM : "#fff", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        <Chevron open={open} color={BRIGHT} />
                        <span style={{ fontSize: 14, fontWeight: 600, color: INK, flex: 1, minWidth: 0 }}>{v.name}</span>
                        <span style={{ fontSize: 11.5, color: v.address ? MUTED : "#b67e00" }}>
                          {v.address ? (v.area || "venue") : "no address"}
                        </span>
                      </button>
                      {open && (
                        <div style={{ padding: "14px 14px 18px", borderTop: `1px solid ${RULE}` }}>
                          <VenueEditor org={org} location={v} districts={districts} partners={partners}
                            lockedPartnerId={partner.id} onSaved={afterVenueSaved}
                            onDistrictsChanged={onDistrictsChanged} />
                        </div>
                      )}
                    </div>
                  );
                })}
                {addingVenue ? (
                  <div style={editorWrap}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: PURPLE, marginBottom: 10 }}>New venue under {partner.partner_name}</div>
                    <VenueEditor org={org} location={null} districts={districts} partners={partners}
                      lockedPartnerId={partner.id} onSaved={afterVenueSaved} onCancel={() => setAddingVenue(false)}
                      onDistrictsChanged={onDistrictsChanged} />
                  </div>
                ) : (
                  <button type="button" onClick={() => setAddingVenue(true)} style={{ ...linkBtn, alignSelf: "flex-start", marginTop: 2 }}>
                    + Add another venue under this partner
                  </button>
                )}
              </div>
            )}
          </Section>

          {/* Contacts — reused, full CRUD + roles + shared-inbox flag */}
          <Section title="Contacts" hint="Who you email about rosters, flyers, and day-of logistics. Add as many as you need, with roles.">
            <ContactsList partnerId={partner.id} organizationId={org.id} onChanged={onChanged} />
          </Section>

          {/* Relationship & notes — reused PartnerEditor */}
          <Section title="Relationship & notes" hint="Partner type, area, and your marketing / invoicing / planning / implementation notes. Mark inactive to archive.">
            <PartnerEditor partner={{ ...partner, organization_id: org.id }} onChanged={onChanged} />
          </Section>

          {/* District & calendar */}
          <Section title="District & calendar" hint="The district sets the academic calendar that flows into every program's session dates here.">
            <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 14, fontSize: 13, color: INK, lineHeight: 1.6 }}>
              {districtName ? (
                <>
                  <div><strong>District:</strong> {districtName}</div>
                  <div style={{ marginTop: 4 }}>
                    <strong>Calendar:</strong>{" "}
                    {calendarYears.length > 0 ? (
                      <span style={{ color: OK }}>on file — {calendarYears.join(", ")}</span>
                    ) : (
                      <span style={{ color: "#b67e00" }}>none uploaded yet</span>
                    )}
                  </div>
                  <button type="button" onClick={() => navigate("/admin/schools?tab=calendars")} style={{ ...linkBtn, marginTop: 8 }}>
                    Manage calendars →
                  </button>
                </>
              ) : (
                <div style={{ color: MUTED }}>
                  No district set. Open a venue above and pick a district so its no-school
                  days flow into session dates automatically.
                </div>
              )}
            </div>
          </Section>

          {/* Programs here — read-only activity */}
          <Section title="Programs here" hint="What's running at this partner's venue(s). Schedule programs from the Programs area.">
            <div style={{ fontSize: 13, color: MUTED }}>
              {activity.programs === 0 && activity.camps === 0
                ? "Nothing scheduled here yet."
                : `${activity.programs} after-school program${activity.programs === 1 ? "" : "s"} and ${activity.camps} camp${activity.camps === 1 ? "" : "s"} reference this partner's venue(s).`}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.6 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: MUTED, marginTop: 3, marginBottom: 10, lineHeight: 1.5 }}>{hint}</div>}
      {!hint && <div style={{ height: 10 }} />}
      {children}
    </div>
  );
}

const editorWrap = { background: CREAM, border: `1px solid ${BRIGHT}`, borderRadius: 8, padding: 14 };
const linkBtn = { background: "transparent", border: "none", color: BRIGHT, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" };
