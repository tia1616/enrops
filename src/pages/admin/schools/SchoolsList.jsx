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
import { useOutletContext, useSearchParams } from "react-router-dom";
import { supabase } from "../../../lib/supabase";
import Chevron from "../../../components/Chevron.jsx";
import NeedsLinkingSection from "../contacts/NeedsLinkingSection.jsx";
import ImportContactsModal from "../contacts/ImportContactsModal.jsx";
import FindMissingAddressesModal from "../FindMissingAddressesModal.jsx";
import AddSchoolModal from "./AddSchoolModal.jsx";
import SchoolDetailDrawer from "./SchoolDetailDrawer.jsx";
import SiteDetailDrawer from "./SiteDetailDrawer.jsx";

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

// Time-saved estimate per partner set up in Enrops vs. by hand (the old two-tab
// add + address lookup + typing logistics + linking contacts/calendar across
// tools). Kept conservative so the pill stays credible (copy-honesty rule).
// Bump to 60 for the fuller "an hour each" framing.
const MINUTES_SAVED_PER_PARTNER = 20;

export default function SchoolsList() {
  const { org } = useOutletContext() ?? {};
  const [partners, setPartners] = useState(null);
  const [locations, setLocations] = useState([]);
  const [loadError, setLoadError] = useState("");
  // SEPARATE from loadError on purpose. `load()` clears loadError at its start, and
  // `onCreated` runs `await loadDistricts(); await load();` in that order - so a
  // districts failure written into loadError would be wiped by the very next line.
  const [districtLoadError, setDistrictLoadError] = useState("");
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
  const [findingAddresses, setFindingAddresses] = useState(false);
  const [selectedPartner, setSelectedPartner] = useState(null);
  // A site with NO partner (a studio). Every provider gets this one list now
  // (Jessica 2026-11-19); for a self-serve provider (venue_model own_venue) a
  // partner-less site is normal and renders as its own card. For partner-first
  // orgs (J2S, Jeff) it is still an orphan to link, so they keep the
  // NeedsLinkingSection exactly as before. No org's venue_model data changes.
  const [selectedSiteId, setSelectedSiteId] = useState(null);
  const showSiteCards = org?.venue_model === "own_venue";
  const [searchParams, setSearchParams] = useSearchParams();
  const [refreshKey, setRefreshKey] = useState(0);

  async function loadDistricts() {
    if (!org?.id) return [];
    // district_type so VenueEditor's picker can exclude independent_school rows.
    // UNFILTERED here: its match-before-create needs every row (lib/districts.js).
    const { data, error: dErr } = await supabase.from("districts").select("id, name, district_type").eq("organization_id", org.id).order("name");
    // Surfaced, not swallowed - same reasoning as LocationsList.fetchDistricts.
    // An empty list here is indistinguishable from "this org has no districts", and
    // selecting district_type means an environment missing 20260817a fails the whole
    // statement (found by /code-review 2026-08-17).
    if (dErr) {
      console.error("Loading districts failed:", dErr);
      setDistrictLoadError(`Couldn't load your districts: ${dErr.message ?? "unknown error"}. The district picker may be incomplete, so refresh before changing one.`);
      return [];
    }
    setDistrictLoadError("");
    setDistricts(data ?? []);
    return data ?? [];
  }

  async function load() {
    if (!org?.id) return;
    setLoadError("");
    const [{ data: partnerRows, error: pErr }, { data: locRows, error: lErr }] = await Promise.all([
      supabase.from("partners")
        .select("id, partner_name, partner_type, location_area, locations_managed, marketing_notes, invoicing_notes, planning_notes, implementation_notes, other_notes, inactive")
        .eq("organization_id", org.id).order("partner_name"),
      supabase.from("program_locations")
        // `district` (legacy free-text) comes back alongside district_id because a
        // location can carry EITHER. J2S staging has 50 locations with free-text
        // districts and matching free-text calendars, so their dates DO skip
        // no-school days — telling them otherwise would be a false alarm.
        .select("id, name, address, area, district_id, district, partner_id, archived")
        .eq("organization_id", org.id).order("name"),
    ]);
    if (pErr || lErr) {
      // Surface the failure instead of spinning "Loading…" forever (rule E).
      console.error("[SchoolsList] load failed:", pErr ?? lErr);
      setLoadError(`Couldn't load locations: ${(pErr ?? lErr).message}. Refresh to try again.`);
      setPartners([]);
      return;
    }
    setPartners(partnerRows ?? []);
    setLocations(locRows ?? []);

    // Contact counts per partner. Scope by org (RLS-backed) and aggregate
    // client-side — NOT `.in(partnerIds)`, which would blow the PostgREST URL
    // length cap (~500 UUIDs) for a large tenant (scale guardrail #9).
    const cMap = new Map();
    const { data: contactRows } = await supabase
      .from("partner_contacts").select("partner_id").eq("organization_id", org.id);
    for (const c of contactRows ?? []) {
      if (c.partner_id) cMap.set(c.partner_id, (cMap.get(c.partner_id) ?? 0) + 1);
    }
    setContactCounts(cMap);

    // Which districts have at least one calendar on file.
    const { data: calRows } = await supabase.from("district_calendars").select("district_id").eq("organization_id", org.id);
    setCalendarDistrictIds(new Set((calRows ?? []).map((r) => r.district_id).filter(Boolean)));

    // Activity per venue (programs + camps), aggregated from two org-wide reads.
    // Scoped by org only (no `.in(locIds)`) so the query never grows an
    // unbounded URL for a large tenant (scale guardrail #9); extra rows for
    // venues not shown just sit unused in the map.
    const locIds = (locRows ?? []).map((l) => l.id);
    const aMap = new Map();
    if (locIds.length) {
      const [{ data: progRows }, { data: campRows }] = await Promise.all([
        supabase.from("programs").select("program_location_id").eq("organization_id", org.id),
        supabase.from("camp_sessions").select("location_id").eq("organization_id", org.id),
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
      // "No district AT ALL" — neither the structured link nor the legacy
      // free-text name. Only these are safe to tell an operator their dates
      // won't skip no-school days: a free-text district still resolves closures
      // through the legacy calendar match, so it is NOT broken. Deliberately
      // separate from `distId`, which is a grouping key, not a truth claim.
      //
      // `venues.length > 0` is load-bearing, not defensive: a CONTACT-ONLY row
      // (a district office you talk to but run nothing at) has no venues, so it
      // trivially has no district — but it also has no class dates, so claiming
      // its dates won't skip no-school days is false. On staging J2S that is 60
      // of 102 rows against 8 genuinely districtless ones, so counting them
      // would have inflated the warning ~8x. `needsSetupCount` below already
      // excludes contact-only for the same reason.
      const hasNoDistrictAtAll =
        venues.length > 0
        && !distId
        && !venues.some((v) => v.district && String(v.district).trim());
      let programs = 0, camps = 0;
      for (const v of venues) {
        const a = activityByLoc.get(v.id);
        if (a) { programs += a.programs; camps += a.camps; }
      }
      return {
        partner: p, venues, distId,
        districtName: distId ? districtName.get(distId) : null,
        hasAddress, hasContact, hasCalendar, hasNoDistrictAtAll, programs, camps,
        isUmbrella: venues.length > 1,
        isContactOnly: venues.length === 0,
      };
    });
  }, [partners, venuesByPartner, contactCounts, calendarDistrictIds, activityByLoc, districtName]);

  // Partner-less sites as their own cards (self-serve providers only; see
  // showSiteCards). Archived sites stay hidden, as the old flat list did not
  // show them either.
  const sites = useMemo(() => {
    if (!showSiteCards) return [];
    return locations
      .filter((l) => !l.partner_id && !l.archived)
      .map((l) => {
        const a = activityByLoc.get(l.id) ?? { programs: 0, camps: 0 };
        return {
          kind: "site",
          site: l,
          partner: null,
          venues: [l],
          distId: l.district_id ?? null,
          districtName: l.district_id ? districtName.get(l.district_id) : null,
          hasAddress: !!(l.address && String(l.address).trim()),
          hasCalendar: !!l.district_id && calendarDistrictIds.has(l.district_id),
          hasNoDistrictAtAll: !l.district_id && !(l.district && String(l.district).trim()),
          programs: a.programs,
          camps: a.camps,
        };
      });
  }, [showSiteCards, locations, activityByLoc, districtName, calendarDistrictIds]);

  // Deep link: /admin/schools?edit=<location id> opens that location's drawer
  // (the import's "Edit details" links). The flat list used to handle this; a
  // partner site opens its school drawer, a partner-less site its site drawer.
  useEffect(() => {
    const editId = searchParams.get("edit");
    if (!editId || partners === null || locations.length === 0) return;
    const loc = locations.find((l) => l.id === editId);
    // NOT FOUND YET is not "not found". The import's done screen navigates here
    // the same moment it starts the reload that brings its new rows in, so the
    // first pass sees the OLD list. Keep the param until the location arrives;
    // stripping it on a miss made every "Edit details" link for a just-imported
    // school do nothing (independent review 2026-11-19).
    if (!loc) return;
    if (loc.partner_id) {
      const p = (partners ?? []).find((x) => x.id === loc.partner_id);
      if (!p) return; // its partner row hasn't arrived yet either
      setSelectedPartner(p);
    } else {
      setSelectedSiteId(loc.id);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("edit");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, partners, locations]);

  async function openPartnerById(partnerId) {
    const { data: fresh } = await supabase.from("partners")
      .select("id, partner_name, partner_type, location_area, locations_managed, marketing_notes, invoicing_notes, planning_notes, implementation_notes, other_notes, inactive")
      .eq("id", partnerId).single();
    setSelectedSiteId(null);
    setSelectedPartner(fresh ?? null);
  }

  // Studio cards count too, on what a studio CAN be missing: an address, or a
  // calendar for the district it chose. No contact chip (contacts are a partner's).
  const needsSetupCount = useMemo(
    () => schools.filter((s) => !s.isContactOnly && (!s.hasAddress || !s.hasContact || !s.hasCalendar)).length
      + sites.filter((s) => !s.hasAddress || (s.distId && !s.hasCalendar)).length,
    [schools, sites],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...schools, ...sites].filter((s) => {
      if (!showInactive && s.partner?.inactive) return false;
      if (!q) return true;
      const hay = [
        s.partner?.partner_name, typeLabel(s.partner?.partner_type), s.partner?.location_area,
        s.districtName, ...s.venues.map((v) => `${v.name} ${v.address ?? ""} ${v.area ?? ""}`),
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    }).sort((a, b) => (a.partner?.partner_name ?? a.site?.name ?? "").localeCompare(b.partner?.partner_name ?? b.site?.name ?? ""));
  }, [schools, sites, query, showInactive, refreshKey]);

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
  const placesEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  // Archived sites are hidden from the cards, so they don't count here either.
  const missingAddressCount = locations.filter((l) => !l.archived && (!l.address || !String(l.address).trim())).length;
  const minsSaved = schools.length * MINUTES_SAVED_PER_PARTNER;
  const savedLabel = minsSaved >= 60 ? `~${Math.round(minsSaved / 60)}h` : `~${minsSaved}m`;

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: MUTED }}>
          {/* "Locations" is the operator-facing name for a row here. The venue
              count is only shown when it DIFFERS (contact-only rows, or an
              umbrella with several venues) — for the common 1:1 case "22
              locations · 22 venues" read as two different things. */}
          {partners === null ? "Loading…" : [
            `${schools.length + sites.length} location${schools.length + sites.length === 1 ? "" : "s"}`,
            ...(totalVenues !== schools.length ? [`${totalVenues} venue${totalVenues === 1 ? "" : "s"}`] : []),
            `${districts.length} district${districts.length === 1 ? "" : "s"}`,
          ].join(" · ")}
        </div>
        {partners !== null && schools.length > 0 && (
          <span
            title={`Setting up a location by hand — entering details, looking up the address, and linking contacts + calendar across your tools — runs about ${MINUTES_SAVED_PER_PARTNER} min each. Enrops does it in a couple of clicks.`}
            style={{ fontSize: 12, fontWeight: 600, color: OK, background: `${OK}14`, padding: "4px 10px", borderRadius: 99 }}
          >
            {savedLabel} saved vs. by hand
          </span>
        )}
        <div style={{ flex: 1 }} />
        {placesEnabled && missingAddressCount > 0 && (
          <button type="button" onClick={() => setFindingAddresses(true)}
            title="Look up addresses for every venue that doesn't have one yet"
            style={{ padding: "9px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
            ✨ Find missing addresses ({missingAddressCount})
          </button>
        )}
        <button type="button" onClick={() => setImporting(true)}
          title="Bulk-upload a list of locations (schools, Parks & Rec, etc.) + contacts from a spreadsheet"
          style={{ padding: "9px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          Import locations
        </button>
        <button type="button" onClick={() => setAdding(true)}
          style={{ padding: "9px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          + Add a location
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <input type="text" placeholder="Search locations, districts, areas…" value={query} onChange={(e) => setQuery(e.target.value)}
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

      {(loadError || districtLoadError) && (
        <div style={{ background: "#fbeaea", border: "1px solid #D9694F", borderRadius: 8, padding: "10px 14px", color: "#7a2a2a", fontSize: 13, marginBottom: 14 }}>
          {loadError || districtLoadError}
        </div>
      )}

      {/* Inline, self-emptying cleanup for orphan venues - partner-first orgs
          only. For a self-serve provider a partner-less site is a studio and
          already has its own card below, so nagging about it would be wrong. */}
      {!showSiteCards && <NeedsLinkingSection org={org} onChanged={refresh} />}

      {partners === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}

      {partners !== null && filtered.length === 0 && (
        <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 12, padding: 36, textAlign: "center", color: MUTED, fontSize: 14 }}>
          {query ? "No locations match that search." : (
            <>No locations yet. Click <strong>+ Add a location</strong> to set up your first one.</>
          )}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 18 }}>
          {g.label && (
            <div style={{ margin: "4px 2px 8px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
                {g.label}
              </div>
              {/* A location with no district has no school calendar, so its class
                  dates never skip no-school days — and nothing else on this page
                  says so. Counted, not asserted over the whole bucket: this
                  bucket is keyed on district_id, so it also holds locations that
                  DO have a legacy free-text district (50 of J2S's on staging),
                  whose dates resolve closures fine. Claiming those are broken
                  would be the false alarm this warning exists to prevent. */}
              {(() => {
                if (g.key !== NO_DISTRICT) return null;
                const n = g.items.filter((s) => s.hasNoDistrictAtAll).length;
                if (n === 0) return null;
                return (
                  <div style={{ fontSize: 12, color: "#8a6d1f", marginTop: 4, lineHeight: 1.5, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                    {n === 1
                      ? "1 of these has no district set, so its class dates won’t skip no-school days. Open it and set a district to fix that."
                      : `${n} of these have no district set, so their class dates won’t skip no-school days. Open one and set a district to fix that.`}
                  </div>
                );
              })()}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {g.items.map((s) => s.kind === "site" ? (
              <SiteCard key={`site-${s.site.id}`} item={s} onOpen={() => setSelectedSiteId(s.site.id)} />
            ) : (
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
          districtsWarning={districtLoadError}
          onClose={() => setAdding(false)}
          onDistrictsChanged={loadDistricts}
          onCreated={async ({ partnerId, locationId }) => {
            setAdding(false);
            await loadDistricts();
            await load();
            // No partner = a studio (the "at a school" box was unticked): open
            // its site drawer instead of a school drawer that has nothing to show.
            if (!partnerId) {
              setSelectedSiteId(locationId);
              refresh();
              return;
            }
            // partners state may be stale; refetch to grab the brand-new partner.
            await openPartnerById(partnerId);
            refresh();
          }}
        />
      )}

      {selectedSiteId && (
        <SiteDetailDrawer
          org={org} locationId={selectedSiteId} districts={districts} partners={(partners ?? [])}
          districtsWarning={districtLoadError}
          onClose={() => setSelectedSiteId(null)}
          onDistrictsChanged={loadDistricts}
          onChanged={refresh}
          onBecamePartner={(pid) => { openPartnerById(pid); refresh(); }}
        />
      )}

      {importing && (
        <ImportContactsModal
          orgId={org.id}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); loadDistricts(); refresh(); }}
        />
      )}

      {findingAddresses && (
        <FindMissingAddressesModal
          orgId={org.id}
          locations={locations}
          onClose={() => setFindingAddresses(false)}
          onSaved={() => { setFindingAddresses(false); refresh(); }}
        />
      )}

      {selectedPartner && (
        <SchoolDetailDrawer
          org={org} partner={selectedPartner} districts={districts} partners={(partners ?? [])}
          districtsWarning={districtLoadError}
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

// A site with no school partner (a studio, the provider's own space). Same card
// shape as SchoolCard so the list reads as one list, minus what a studio has no
// use for: no partner type, no contacts chip (contacts belong to a partner).
function SiteCard({ item, onOpen }) {
  const { site, hasAddress, hasCalendar, programs, camps } = item;
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>{site.name}</span>
          <div style={{ fontSize: 13, color: site.address ? MUTED : AMBER, marginTop: 4 }}>
            {site.address || "No address yet"}
          </div>
          {/* On the card itself, so it survives "Group by district" being off
              (the group header is the only other place that says it). */}
          {item.hasNoDistrictAtAll && (
            <div style={{ fontSize: 12, color: "#8a6d1f", marginTop: 4 }}>
              No district, so class dates won&apos;t skip no-school days.
            </div>
          )}
        </div>
        <button type="button" onClick={onOpen}
          style={{ flexShrink: 0, padding: "6px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          Open
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        <ReadyChip ok={hasAddress} okLabel="Address" addLabel="Add address" onAdd={onOpen} />
        {site.district_id && <ReadyChip ok={hasCalendar} okLabel="Calendar" addLabel="Add calendar" onAdd={onOpen} />}
        <span style={{ flex: 1 }} />
        <ActivityLabel programs={programs} camps={camps} />
      </div>
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
  if (none) return <span style={{ fontSize: 12, color: "#9a9a9a" }}>{compact ? "—" : "Nothing scheduled"}</span>;
  const bits = [];
  if (programs) bits.push(`${programs} program${programs === 1 ? "" : "s"}`);
  if (camps) bits.push(`${camps} camp${camps === 1 ? "" : "s"}`);
  // Counts are all-time (not term-filtered) — keep the label honest (rule D).
  return <span style={{ fontSize: 12, color: MUTED }}>{bits.join(" · ")}{compact ? "" : " scheduled here"}</span>;
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
