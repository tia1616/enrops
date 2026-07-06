// /admin/schools — the places a tenant runs classes. Two shapes, chosen by
// organizations.venue_model (single source of truth — see the 20260706 migration):
//
//   'partner_venues' (default, e.g. J2S) — the tenant runs programs INSIDE other
//       people's places. Partner-first: SchoolsList renders each partner + its
//       venue(s); a venue with no partner is an orphan to link. Title "Partners".
//
//   'own_venue' (e.g. Shoreview Chess, Mrs. Richelle) — the tenant runs at its
//       OWN location(s). No external partner; a partner-less venue is NORMAL.
//       LocationsList renders the venues directly. Title "Locations".
//
// The Calendars tab (closure / no-class days that flow into session dates) stays
// in BOTH shapes. Only the first tab (Partners vs Locations) and the title swap.

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
  { key: 'calendars', label: 'Calendars',
    help: 'Closure and no-class days that flow into every program’s session dates.' },
];

const PARTNER_TABS = [
  { key: 'schools',   label: 'Partners',
    help: 'Every partner you work with — schools, Parks & Rec, churches, community orgs — with its venue(s), contacts, calendar, and what runs there. One place per partner.' },
  { key: 'calendars', label: 'Calendars',
    help: 'District academic calendars — no-school days that flow into every program’s session dates.' },
];

export default function SchoolsLocations() {
  const { org } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();

  const ownVenue = org?.venue_model === 'own_venue';
  const TABS = ownVenue ? OWN_VENUE_TABS : PARTNER_TABS;
  const title = ownVenue ? 'Locations' : 'Partners';

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
