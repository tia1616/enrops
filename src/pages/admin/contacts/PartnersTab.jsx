// PartnersTab — entry point for partner data. Shows the org's partner +
// contact counts and an "Import partners & contacts" button that opens
// the multi-step import flow.
//
// Future scope: full partner list/edit lives here too. For now the focus
// is bulk ingest; existing rows can already be edited via Supabase Studio
// or via the EmailRosterModal's partner picker on Rosters.

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import ImportContactsModal from './ImportContactsModal';
import AddPartnerModal from './AddPartnerModal';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';

export default function PartnersTab({ org }) {
  const [counts, setCounts] = useState({ partners: null, contacts: null });
  const [byType, setByType] = useState([]);
  const [importing, setImporting] = useState(false);
  const [addingOne, setAddingOne] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const [{ count: partnerCount }, { count: contactCount }, { data: typeRows }] = await Promise.all([
        supabase.from('partners').select('id', { count: 'exact', head: true }).eq('organization_id', org.id).eq('inactive', false),
        supabase.from('partner_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id),
        supabase.from('partners').select('partner_type').eq('organization_id', org.id).eq('inactive', false),
      ]);
      if (cancelled) return;
      setCounts({ partners: partnerCount ?? 0, contacts: contactCount ?? 0 });
      // Aggregate by type
      const map = new Map();
      for (const r of typeRows ?? []) {
        const k = r.partner_type ?? 'unspecified';
        map.set(k, (map.get(k) ?? 0) + 1);
      }
      const arr = Array.from(map.entries()).map(([type, n]) => ({ type, n }));
      arr.sort((a, b) => b.n - a.n);
      setByType(arr);
    })();
    return () => { cancelled = true; };
  }, [org?.id, refreshKey]);

  return (
    <div>
      <div style={{
        display: 'flex', gap: 16, alignItems: 'flex-start',
        background: '#fff', border: `1px solid ${RULE}`, borderRadius: 10,
        padding: 18, marginBottom: 18, flexWrap: 'wrap',
      }}>
        <Stat label="Partners" value={counts.partners} />
        <Stat label="Contacts" value={counts.contacts} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>By type</div>
          {byType.length === 0 ? (
            <div style={{ color: MUTED, fontSize: 13 }}>No partners yet.</div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {byType.map((row) => (
                <span key={row.type} style={{ fontSize: 11, padding: '3px 8px', background: `${PURPLE}10`, color: PURPLE, borderRadius: 99, fontWeight: 600 }}>
                  {row.type.replace(/_/g, ' ')} · {row.n}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignSelf: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setAddingOne(true)}
            style={{
              padding: '10px 14px', background: 'transparent', color: PURPLE, border: `1px solid ${PURPLE}`,
              borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            + Add partner
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            style={{
              padding: '10px 16px', background: PURPLE, color: '#fff', border: 'none',
              borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Import partners & contacts →
          </button>
        </div>
      </div>

      <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
        Bring in your existing partner list (schools, parks &amp; rec, community orgs) and
        their logistics contacts. Upload a CSV/XLSX from Drive or paste freeform text
        (e.g. an email thread) — we'll extract structured rows for you to review before saving.
      </div>

      {importing && (
        <ImportContactsModal
          orgId={org.id}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {addingOne && (
        <AddPartnerModal
          orgId={org.id}
          onClose={() => setAddingOne(false)}
          onSaved={() => {
            setAddingOne(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: INK, lineHeight: 1.1, marginTop: 2 }}>
        {value === null ? '—' : value.toLocaleString()}
      </div>
    </div>
  );
}
