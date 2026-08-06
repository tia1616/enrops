// /admin/schools — the places a tenant runs classes. Two shapes, chosen by
// organizations.venue_model (single source of truth — see the 20260706 migration):
//
//   'partner_venues' (default, e.g. J2S) — the tenant runs programs INSIDE other
//       people's places. Partner-first: SchoolsList renders each partner + its
//       venue(s); a venue with no partner is an orphan to link.
//
//   'own_venue' (e.g. Shoreview Chess, Mrs. Richelle) — the tenant runs at its
//       OWN location(s). No external partner; a partner-less venue is NORMAL.
//       LocationsList renders the venues directly.
//
// The Calendars tab (closure / no-class days that flow into session dates) stays
// in BOTH shapes. Only the first tab's help copy and the rendered list swap.
//
// NAMING (Jessica, 2026-08-05): both shapes are titled "Locations". Operators
// don't distinguish "the partner" from "the place" — a lean provider's partner is
// 1:1 with a school — and two names for one surface sent a provider hunting for
// the district field. The partner-first STRUCTURE below is unchanged; only the
// label is. `partners`/`partner_id` remain the schema terms.

import { useSearchParams, useOutletContext } from 'react-router-dom';
import SchoolsList from './schools/SchoolsList';
import LocationsList from './LocationsList';
import CalendarsList from './CalendarsList';

const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const BRIGHT = '#5847C9';   // indigo - active tabs/actions (Figma)

// Tab definitions per venue_model. `key` stays 'schools' for the first tab in
// both shapes so existing ?tab=schools deep links keep working — only the label,
// help copy, and rendered list change.
const OWN_VENUE_TABS = [
  { key: 'schools',   label: 'Locations',
    help: 'The places you run your classes — your center, studios, or online. Add each one’s address, room, and arrival details once and they flow into every roster and reminder.' },
  { key: 'calendars', label: 'School calendar',
    help: 'Closure and no-class days that flow into every program’s session dates.' },
];

const PARTNER_TABS = [
  { key: 'schools',   label: 'Locations',
    help: 'Every place you run classes — schools, Parks & Rec, churches, community orgs — with its address, contacts, district, and what runs there. Set each one’s district so its class dates skip no-school days.' },
  { key: 'calendars', label: 'School calendar',
    help: 'District academic calendars — no-school days that flow into every program’s session dates.' },
];

export default function SchoolsLocations() {
  const { org } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();

  const ownVenue = org?.venue_model === 'own_venue';
  // Lean ops reach School calendar as its own Programs peer tab, so drop the
  // inner calendars tab here — one door, not two. Full nav (J2S) keeps it under
  // Locations as before.
  const isLean = org?.instructor_pay_model === 'enrops_platform';
  const baseTabs = ownVenue ? OWN_VENUE_TABS : PARTNER_TABS;
  const TABS = isLean ? baseTabs.filter((t) => t.key !== 'calendars') : baseTabs;
  const title = 'Locations'; // both venue models — see NAMING note at top

  const tab = params.get('tab') || 'schools';
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  function selectTab(key) { setParams({ tab: key }, { replace: true }); }

  return (
    <div>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          {title}
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 13.5, lineHeight: 1.5 }}>
          {active.help}
        </p>
      </header>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 18 }}>
        {TABS.map((t) => {
          const isActive = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: 'none',
                borderBottom: isActive ? `2px solid ${BRIGHT}` : '2px solid transparent',
                color: isActive ? BRIGHT : MUTED,
                fontWeight: isActive ? 700 : 500,
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
                position: 'relative',
                top: 1,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'calendars'
        ? <CalendarsList />
        : (ownVenue ? <LocationsList embedded /> : <SchoolsList />)}
    </div>
  );
}
