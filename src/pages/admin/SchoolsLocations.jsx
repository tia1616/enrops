// /admin/schools — combined surface for the schools/partners/locations concept.
//
// Today these are two tables in the schema (partners + program_locations) joined
// by partner_id, but to an operator a school is ONE thing. This page surfaces
// them under tabs so there's a single "where my schools live" home in the nav.
//
// Post-Italy: the partners↔locations unification (see
// project_enrops_partners_locations_link) collapses these into one table; the
// tabs go away then and the page becomes a single list. Same URL, same nav slot.

import { useSearchParams, useOutletContext } from 'react-router-dom';
import SchoolsList from './schools/SchoolsList';
import PartnersTab from './contacts/PartnersTab';
import LocationsList from './LocationsList';
import CalendarsList from './CalendarsList';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';   // indigo - active tabs/actions (Figma)
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';

// The unified Partners surface (a partner = a school / Parks & Rec / church /
// community org, with its venue(s)). "Partner" is the schema-accurate,
// multi-tenant-safe umbrella term — not every tenant runs at schools. The old
// per-table Partners + Locations tabs stay as a labeled "classic" fallback
// during the transition — retired once the J2S data reconciliation (Workstream
// 2) lets the unified list cleanly replace them. Calendars stays its own tab.
const TABS = [
  { key: 'schools',   label: 'Partners',            help: 'Every partner you work with — schools, Parks & Rec, churches, community orgs — with its venue(s), contacts, calendar, and what runs there. One place per partner.' },
  { key: 'partners',  label: 'Partners (classic)',  help: 'The schools, districts, and orgs you partner with — and your contacts there.' },
  { key: 'locations', label: 'Locations (classic)', help: 'Where programs actually run — venues with addresses, room numbers, and arrival info.' },
  { key: 'calendars', label: 'Calendars',           help: "District academic calendars — no-school days that flow into every program's session dates." },
];

export default function SchoolsLocations() {
  const { org } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'schools';
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  function selectTab(key) { setParams({ tab: key }, { replace: true }); }

  return (
    <div>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          Partners
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

      {tab === 'schools'   && <SchoolsList />}
      {tab === 'partners'  && <PartnersTab org={org} />}
      {tab === 'locations' && <LocationsList />}
      {tab === 'calendars' && <CalendarsList />}
    </div>
  );
}
