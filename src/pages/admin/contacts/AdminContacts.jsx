// /admin/contacts — admin Contacts page.
//
// Partners + Parents tabs (both still placeholders). The Instructors tab
// used to live here too but was promoted to a top-level /admin/instructors
// route in May 2026 — operators think of contractors as a first-class
// thing, not a Contacts sub-tab. Anyone deep-linking to
// /admin/contacts?tab=instructors gets bounced to the new home.

import { useEffect } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import PartnersTab from './PartnersTab';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';

const TABS = [
  { key: 'partners', label: 'Partners' },
  { key: 'parents', label: 'Parents', soon: true },
];

export default function AdminContacts() {
  const { org } = useOutletContext() ?? {};
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'partners';

  // Bounce stale ?tab=instructors deep links to the new top-level page.
  useEffect(() => {
    if (params.get('tab') === 'instructors') {
      navigate('/admin/instructors', { replace: true });
    }
  }, [params, navigate]);

  function selectTab(key) {
    setParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          Contacts
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 14 }}>
          Partners and parents connected to {org?.name ?? 'your org'}.{' '}
          Looking for instructors?{' '}
          <Link to="/admin/instructors" style={{ color: PURPLE, textDecoration: 'underline' }}>
            They moved to their own page.
          </Link>
        </p>
      </header>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 18 }}>
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => !t.soon && selectTab(t.key)}
              disabled={t.soon}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: 'none',
                borderBottom: active ? `2px solid ${PURPLE}` : '2px solid transparent',
                color: active ? PURPLE : t.soon ? '#bbb' : MUTED,
                fontWeight: active ? 700 : 500,
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: t.soon ? 'not-allowed' : 'pointer',
                position: 'relative',
                top: 1,
              }}
            >
              {t.label}
              {t.soon && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 9,
                    color: '#bbb',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  soon
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'partners' && <PartnersTab org={org} />}
      {tab === 'parents' && (
        <div style={{ color: MUTED, fontSize: 13 }}>This tab is coming soon.</div>
      )}
    </div>
  );
}
