// /admin/schools — the unified Partners surface. A "partner" is one thing to the
// operator (a school / Parks & Rec / church / community org) even though the
// schema keeps partners + program_locations as two tables joined by partner_id.
// SchoolsList renders them as one list (partner + its venues); Calendars stays
// its own tab. The old per-table "Partners (classic)" + "Locations (classic)"
// tabs were retired 2026-06-23 once the J2S data reconciliation made the unified
// list clean — bulk "Find missing addresses" was ported into SchoolsList.

import { useSearchParams } from 'react-router-dom';
import SchoolsList from './schools/SchoolsList';
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
  { key: 'schools',   label: 'Partners',  help: 'Every partner you work with — schools, Parks & Rec, churches, community orgs — with its venue(s), contacts, calendar, and what runs there. One place per partner.' },
  { key: 'calendars', label: 'Calendars', help: "District academic calendars — no-school days that flow into every program's session dates." },
];

export default function SchoolsLocations() {
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

      {tab === 'calendars' ? <CalendarsList /> : <SchoolsList />}
    </div>
  );
}
