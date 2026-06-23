// SchoolsList — the unified Schools surface (Workstream 1 of the Schools &
// Partners redesign). One list where a "school" = a partner + its venue(s):
//
//   • a normal 1:1 school renders as a single collapsed card;
//   • an umbrella (Parks & Rec, a district that runs many sites) renders as a
//     parent card that expands to its venues (Square / Jackrabbit pattern);
//   • a contact-only partner (district office you talk to but don't run
//     programs at yet) is first-class, with an "Add a venue" path;
//   • orphan venues (no partner) surface in the inline, self-emptying
//     NeedsLinkingSection so cleanup happens in the flow of work.
//
// Each card shows readiness (address · contact · calendar) and activity
// (programs/camps) at a glance — the question an operator running programs at
// venues they don't own actually asks: "is this relationship set up, and is it
// active?" Editing opens the SchoolDetailDrawer (one place per school) which
// reuses the existing field-complete editors, so nothing is lost in the merge.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase";
import Chevron from "../../../components/Chevron.jsx";
import NeedsLinkingSection from "../contacts/NeedsLinkingSection.jsx";
import ImportContactsModal from "../contacts/ImportContactsModal.jsx";
import AddSchoolModal from "./AddSchoolModal.jsx";
import SchoolDetailDrawer from "./SchoolDetailDrawer.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CREAM = "#FBFBFB";
const OK = "#3a7c3a";
const AMBER = "#b67e00";

const PARTNER_TYPE_LABELS = {
  public_school: "Public school",
  private_school: "Private school",
  charter_school: "Charter school",
  school_district: "School district",
  parks_rec: "Parks & Rec",
  community_org: "Community org",
  church: "Church",
};
function typeLabel(t) { return PARTNER_TYPE_LABELS[t] ?? (t ? t.replace(/_/g, " ") : null); }

const NO_DISTRICT = "__none__";

export default function SchoolsList() {
  const { org } = useOutletContext() ?? {};
  const [partners, setPartners] = useState(null);
  const [locations, setLocations] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [contactCounts, setContactCounts] = useState(new Map());     // partner_id -> n
  const [calendarDistrictIds, setCalendarDistrictIds] = useState(new Set());
  const [activityByLoc, setActivityByLoc] = useState(new Map());     // loc_id -> {programs, camps}
  const [query, setQuery] = useState("");
  const [groupByDistrict, setGroupByDistrict] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [expanded, setExpanded] = useState(new Set());               // umbrella partner ids expanded
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function loadDistricts() {
    if (!org?.id) return [];
    const { data } = await supabase.from("districts").select("id, name").eq("organization_id", org.id).order("name");
    setDistricts(data ?? []);
    return data ?? [];
  }

  async function load() {
    if (!org?.id) return;
    const [{ data: partnerRows }, { data: locRows }] = await Promise.all([
      supabase.from("partners")
        .select("id, partner_name, partner_type, location_area, locations_managed, marketing_notes, invoicing_notes, planning_notes, implementation_notes, other_notes, inactive")
        .eq("organization_id", org.id).order("partner_name"),
      supabase.from("program_locations")
        .select("id, name, address, area, district_id, partner_id")
        .eq("organization_id", org.id).order("name"),
    ]);
    setPartners(partnerRows ?? []);
    setLocations(locRows ?? []);

    // Contact counts per partner.
    const pIds = (partnerRows ?? []).map((p) => p.id);
    const cMap = new Map();
    if (pIds.length) {
      const { data: contactRows } = await supabase.from("partner_contacts").select("partner_id").in("partner_id", pIds);
      for (const c of contactRows ?? []) cMap.set(c.partner_id, (cMap.get(c.partner_id) ?? 0) + 1);
    }
    setContactCounts(cMap);

    // Which districts have at least one calendar on file.
    const { data: calRows } = await supabase.from("district_calendars").select("district_id").eq("organization_id", org.id);
    setCalendarDistrictIds(new Set((calRows ?? []).map((r) => r.district_id).filter(Boolean)));

    // Activity per venue (programs + camps), aggregated from two org-wide reads.
    const locIds = (locRows ?? []).map((l) => l.id);
    const aMap = new Map();
    if (locIds.length) {
      const [{ data: progRows }, { data: campRows }] = await Promise.all([
        supabase.from("programs").select("program_location_id").eq("organization_id", org.id).in("program_location_id", locIds),
        supabase.from("camp_sessions").select("location_id").eq("organization_id", org.id).in("location_id", locIds),
      ]);
      for (const r of progRows ?? []) {
        if (!r.program_location_id) continue;
        const e = aMap.get(r.program_location_id) ?? { programs: 0, camps: 0 };
        e.programs += 1; aMap.set(r.program_location_id, e);
      }
      for (const r of campRows ?? []) {
        if (!r.location_id) continue;
        const e = aMap.get(r.location_id) ?? { programs: 0, camps: 0 };
        e.camps += 1; aMap.set(r.location_id, e);
      }
    }
    setActivityByLoc(aMap);
  }

  useEffect(() => { loadDistricts(); /* eslint-disable-next-line */ }, [org?.id]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [org?.id, refreshKey]);

  const districtName = useMemo(() => {
    const m = new Map();
    for (const d of districts) m.set(d.id, d.name);
    return m;
  }, [districts]);

  const venuesByPartner = useMemo(() => {
    const m = new Map();
    for (const l of locations) {
      if (!l.partner_id) continue;
      const arr = m.get(l.partner_id) ?? [];
      arr.push(l); m.set(l.partner_id, arr);
    }
    return m;
  }, [locations]);

  // Build the "school" objects = partner + its venues + readiness + activity.
  const schools = useMemo(() => {
    if (!partners) return [];
    return partners.map((p) => {
      const venues = venuesByPartner.get(p.id) ?? [];
      const distId = venues.find((v) => v.district_id)?.district_id ?? null;
      const hasAddress = venues.length > 0 && venues.every((v) => v.address && String(v.address).trim());
      const hasContact = (contactCounts.get(p.id) ?? 0) > 0;
      // Calendar readiness keys off the STRUCTURED district_id only. For J2S's
      // legacy free-text `district` calendars this under-reports (shows "Add
      // calendar" even when a legacy calendar exists) — accepted for now since
      // WS1 is validated on the clean Tenant 2 org; fix in WS2 when J2S's
      // partners/venues/districts are reconciled to district_id.
      const hasCalendar = !!distId && calendarDistrictIds.has(distId);
      let programs = 0, camps = 0;
      for (const v of venues) {
        const a = activityByLoc.get(v.id);
        if (a) { programs += a.programs; camps += a.camps; }
      }
      return {
        partner: p, venues, distId,
        districtName: distId ? districtName.get(distId) : null,
        hasAddress, hasContact, hasCalendar, programs, camps,
        isUmbrella: venues.length > 1,
        isContactOnly: venues.length === 0,
      };
    });
  }, [partners, venuesByPartner, contactCounts, calendarDistrictIds, activityByLoc, districtName]);

  const needsSetupCount = useMemo(
    () => schools.filter((s) => !s.isContactOnly && (!s.hasAddress || !s.hasContact || !s.hasCalendar)).length,
    [schools],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return schools.filter((s) => {
      if (!showInactive && s.partner.inactive) return false;
      if (!q) return true;
      const hay = [
        s.partner.partner_name, typeLabel(s.partner.partner_type), s.partner.location_area,
        s.districtName, ...s.venues.map((v) => `${v.name} ${v.address ?? ""} ${v.area ?? ""}`),
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [schools, query, showInactive, refreshKey]);

  const inactiveCount = schools.filter((s) => s.partner.inactive).length;

  // Group into district buckets (or one flat bucket when grouping is off).
  const groups = useMemo(() => {
    if (!groupByDistrict) return [{ key: "all", label: null, items: filtered }];
    const m = new Map();
    for (const s of filtered) {
      const key = s.distId ?? NO_DISTRICT;
      const arr = m.get(key) ?? []; arr.push(s); m.set(key, arr);
    }
    const out = [];
    for (const [key, items] of m.entries()) {
      out.push({ key, label: key === NO_DISTRICT ? "No district" : (districtName.get(key) ?? "District"), items });
    }
    out.sort((a, b) => {
      if (a.key === NO_DISTRICT) return 1;
      if (b.key === NO_DISTRICT) return -1;
      return (a.label ?? "").localeCompare(b.label ?? "");
    });
    return out;
  }, [filtered, groupByDistrict, districtName]);

  function toggleExpand(id) {
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const refresh = () => setRefreshKey((k) => k + 1);

  if (!org) return <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>;

  const totalVenues = locations.filter((l) => l.partner_id).length;

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: MUTED }}>
          {partners === null ? "Loading…" : `${schools.length} school${schools.length === 1 ? "" : "s"} · ${totalVenues} venue${totalVenues === 1 ? "" : "s"} · ${districts.length} district${districts.length === 1 ? "" : "s"}`}
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setImporting(true)}
          title="Bulk-upload a list of schools/partners + contacts from a spreadsheet"
          style={{ padding: "9px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          Import schools
        </button>
        <button type="button" onClick={() => setAdding(true)}
          style={{ padding: "9px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          + Add a school
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <input type="text" placeholder="Search schools, districts, areas…" value={query} onChange={(e) => setQuery(e.target.value)}
          style={{ flex: "1 1 260px", maxWidth: 360, padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" }} />
        <button type="button" onClick={() => setGroupByDistrict((v) => !v)}
          style={chip(groupByDistrict)}>
          Group by district{groupByDistrict ? " ✓" : ""}
        </button>
        {needsSetupCount > 0 && (
          <span style={{ fontSize: 12, color: AMBER, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: AMBER, display: "inline-block" }} />
            {needsSetupCount} need setup
          </span>
        )}
        {inactiveCount > 0 && (
          <label style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive ({inactiveCount})
          </label>
        )}
      </div>

      {/* Inline, self-emptying cleanup for orphan venues. */}
      <NeedsLinkingSection org={org} onChanged={refresh} />

      {partners === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}

      {partners !== null && filtered.length === 0 && (
        <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 12, padding: 36, textAlign: "center", color: MUTED, fontSize: 14 }}>
          {query ? "No schools match that search." : (
            <>No schools yet. Click <strong>+ Add a school</strong> to set up your first one.</>
          )}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 18 }}>
          {g.label && (
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, margin: "4px 2px 8px" }}>
              {g.label}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {g.items.map((s) => (
              <SchoolCard
                key={s.partner.id}
                school={s}
                expanded={expanded.has(s.partner.id)}
                onToggle={() => toggleExpand(s.partner.id)}
                onOpen={() => setSelectedPartner(s.partner)}
                activityByLoc={activityByLoc}
                calendarDistrictIds={calendarDistrictIds}
                districtName={districtName}
              />
            ))}
          </div>
        </div>
      ))}

      {adding && (
        <AddSchoolModal
          org={org} districts={districts} partners={(partners ?? [])}
          onClose={() => setAdding(false)}
          onDistrictsChanged={loadDistricts}
          onCreated={async ({ partnerId }) => {
            setAdding(false);
            await loadDistricts();
            await load();
            const p = (partners ?? []).find((x) => x.id === partnerId);
            // partners state may be stale; refetch to grab the brand-new partner.
            const { data: fresh } = await supabase.from("partners")
              .select("id, partner_name, partner_type, location_area, locations_managed, marketing_notes, invoicing_notes, planning_notes, implementation_notes, other_notes, inactive")
              .eq("id", partnerId).single();
            setSelectedPartner(fresh ?? p ?? null);
            refresh();
          }}
        />
      )}

      {importing && (
        <ImportContactsModal
          orgId={org.id}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); loadDistricts(); refresh(); }}
        />
      )}

      {selectedPartner && (
        <SchoolDetailDrawer
          org={org} partner={selectedPartner} districts={districts} partners={(partners ?? [])}
          onClose={() => setSelectedPartner(null)}
          onDistrictsChanged={loadDistricts}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function SchoolCard({ school, expanded, onToggle, onOpen, activityByLoc, calendarDistrictIds, districtName }) {
  const { partner, venues, hasAddress, hasContact, hasCalendar, programs, camps, isUmbrella, isContactOnly, districtName: dName } = school;
  const oneVenue = venues.length === 1 ? venues[0] : null;

  return (
    <div style={{
      background: "#fff", border: `1px solid ${RULE}`,
      borderLeft: partner.inactive ? `3px solid ${AMBER}` : `1px solid ${RULE}`,
      borderRadius: 12, padding: "14px 16px", opacity: partner.inactive ? 0.72 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {isUmbrella && (
              <button type="button" onClick={onToggle} aria-label="Expand venues"
                style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", display: "flex" }}>
                <Chevron open={expanded} color={BRIGHT} />
              </button>
            )}
            <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>{partner.partner_name}</span>
            {typeLabel(partner.partner_type) && (
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: `${PURPLE}10`, color: PURPLE, fontWeight: 600 }}>
                {typeLabel(partner.partner_type)}
              </span>
            )}
            {isUmbrella && (
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#efeef9", color: BRIGHT, fontWeight: 600 }}>
                umbrella · {venues.length} venues
              </span>
            )}
            {isContactOnly && (
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: `${AMBER}1A`, color: AMBER, fontWeight: 600 }}>
                contact only · no venue
              </span>
            )}
            {partner.inactive && (
              <span style={{ fontSize: 10, color: AMBER, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>inactive</span>
            )}
          </div>

          {oneVenue && (
            <div style={{ fontSize: 13, color: oneVenue.address ? MUTED : AMBER, marginTop: 4 }}>
              {oneVenue.address || "No address yet"}
            </div>
          )}
          {isContactOnly && (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>
              {partner.location_area ? `${partner.location_area} · ` : ""}A partner you work with that doesn't run programs at a venue yet.
            </div>
          )}
        </div>
        <button type="button" onClick={onOpen}
          style={{ flexShrink: 0, padding: "6px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          {isContactOnly ? "Set up" : "Open"}
        </button>
      </div>

      {/* Readiness + activity for normal & contact-only (umbrella shows per-venue when expanded). */}
      {!isUmbrella && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          {isContactOnly ? (
            <>
              <ReadyChip ok={hasContact} okLabel="Contact" addLabel="Add contact" onAdd={onOpen} />
              <button type="button" onClick={onOpen} style={addChip}>+ Add a venue</button>
            </>
          ) : (
            <>
              <ReadyChip ok={hasAddress} okLabel="Address" addLabel="Add address" onAdd={onOpen} />
              <ReadyChip ok={hasContact} okLabel="Contact" addLabel="Add contact" onAdd={onOpen} />
              <ReadyChip ok={hasCalendar} okLabel="Calendar" addLabel="Add calendar" onAdd={onOpen} />
            </>
          )}
          <span style={{ flex: 1 }} />
          <ActivityLabel programs={programs} camps={camps} />
        </div>
      )}

      {/* Umbrella: expand to venue children. */}
      {isUmbrella && expanded && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {venues.map((v) => {
            const a = activityByLoc.get(v.id) ?? { programs: 0, camps: 0 };
            const vHasCal = v.district_id && calendarDistrictIds.has(v.district_id);
            return (
              <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{v.name}</span>
                {v.area && <span style={{ fontSize: 12, color: MUTED }}>· {v.area}</span>}
                <span style={{ flex: 1 }} />
                {v.address
                  ? <span style={{ fontSize: 11, color: OK, display: "inline-flex", alignItems: "center", gap: 3 }}>✓ ready</span>
                  : <span style={{ fontSize: 11, color: AMBER }}>no address</span>}
                <ActivityLabel programs={a.programs} camps={a.camps} compact />
              </div>
            );
          })}
          <button type="button" onClick={onOpen} style={{ ...addChip, alignSelf: "flex-start" }}>+ Add another venue</button>
        </div>
      )}
    </div>
  );
}

function ReadyChip({ ok, okLabel, addLabel, onAdd }) {
  if (ok) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "3px 9px", borderRadius: 99, background: `${OK}15`, color: OK, fontWeight: 600 }}>
        ✓ {okLabel}
      </span>
    );
  }
  return (
    <button type="button" onClick={onAdd}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "3px 9px", borderRadius: 99, background: `${AMBER}1A`, color: AMBER, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
      + {addLabel}
    </button>
  );
}

function ActivityLabel({ programs, camps, compact }) {
  const none = programs === 0 && camps === 0;
  if (none) return <span style={{ fontSize: 12, color: "#9a9a9a" }}>{compact ? "—" : "No programs yet"}</span>;
  const bits = [];
  if (programs) bits.push(`${programs} program${programs === 1 ? "" : "s"}`);
  if (camps) bits.push(`${camps} camp${camps === 1 ? "" : "s"}`);
  return <span style={{ fontSize: 12, color: MUTED }}>{bits.join(" · ")}{compact ? "" : " this term"}</span>;
}

function chip(active) {
  return {
    padding: "7px 12px", fontSize: 12.5, borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
    background: active ? `${BRIGHT}12` : "transparent", color: active ? BRIGHT : MUTED,
    border: `1px solid ${active ? BRIGHT : RULE}`, fontWeight: active ? 600 : 500,
  };
}

const addChip = {
  fontSize: 12, padding: "3px 10px", borderRadius: 99, background: "transparent",
  color: BRIGHT, border: `1px dashed ${BRIGHT}`, cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
};
