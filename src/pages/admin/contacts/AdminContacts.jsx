// /admin/contacts — admin Contacts page.
// Tab bar at the top; Instructors tab is the only one wired for now
// (Partners + Parents are placeholders).

import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import InstructorsTab from './InstructorsTab.jsx';

const PLUM = '#691D39';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';

const TABS = [
  { key: 'instructors', label: 'Instructors' },
  { key: 'partners', label: 'Partners', soon: true },
  { key: 'parents', label: 'Parents', soon: true },
];

export default function AdminContacts() {
  const { org } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'instructors';

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
          People connected to {org?.name ?? 'your org'}.
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
                borderBottom: active ? `2px solid ${PLUM}` : '2px solid transparent',
                color: active ? PLUM : t.soon ? '#bbb' : MUTED,
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

      {tab === 'instructors' && <InstructorsTab org={org} />}
      {tab !== 'instructors' && (
        <div style={{ color: MUTED, fontSize: 13 }}>This tab is coming soon.</div>
      )}
    </div>
  );
}
