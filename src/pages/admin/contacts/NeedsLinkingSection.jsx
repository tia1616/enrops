// NeedsLinkingSection — the self-emptying "Needs linking" surface.
//
// A venue (program_locations row) with no partner_id is an orphan: rosters,
// flyer contacts, and the unified card can't resolve who to email. This
// section lists every orphan, proposes the best partner match (pre-selecting
// confident ones), and lets the operator confirm or correct each — or attach
// the venue to an umbrella partner (a Parks & Rec / Community Ed that runs
// many sites), or create a brand-new school partner from the venue.
//
// It renders NOTHING when there are no orphans. After the one-time backfill +
// the importer's auto-create, this should sit empty — but it stays in place to
// catch any future orphan (a manual DB edit, an odd import) instead of letting
// it rot silently the way the May 2026 import's 50 orphans did.
//
// Writes:
//  - attach to existing partner → client-side update of program_locations
//    .partner_id (RLS admin-guarded; the same-org trigger validates).
//  - create new partner from venue → import-partners-write with
//    link_existing_location_id so it links THIS venue instead of making a
//    duplicate.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase.js';
import { proposeMatches, bestConfident } from './venueMatch.js';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const OK = '#3a7c3a';
const AMBER = '#b67e00';
const CORAL = '#D9694F';

const PARTNER_TYPES = [
  { v: 'public_school', label: 'Public school' },
  { v: 'private_school', label: 'Private school' },
  { v: 'charter_school', label: 'Charter school' },
  { v: 'parks_rec', label: 'Parks & Rec' },
  { v: 'community_org', label: 'Community org' },
  { v: 'church', label: 'Church' },
];

const CREATE_NEW = '__create_new__';

export default function NeedsLinkingSection({ org, onChanged }) {
  const [orphans, setOrphans] = useState(null); // null = loading
  const [partners, setPartners] = useState([]);
  const [sel, setSel] = useState({});       // loc_id -> partner_id | CREATE_NEW
  const [newType, setNewType] = useState({}); // loc_id -> partner_type (create mode)
  const [busyId, setBusyId] = useState(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    if (!org?.id) return;
    setError('');
    const [{ data: locs, error: lErr }, { data: parts, error: pErr }] = await Promise.all([
      supabase.from('program_locations')
        .select('id, name, area, district')
        .eq('organization_id', org.id).is('partner_id', null)
        .order('name', { ascending: true }),
      supabase.from('partners')
        .select('id, partner_name, partner_type, location_area')
        .eq('organization_id', org.id).eq('inactive', false)
        .order('partner_name', { ascending: true }),
    ]);
    if (lErr || pErr) { setError('Could not load venues.'); setOrphans([]); return; }
    setPartners(parts ?? []);
    setOrphans(locs ?? []);
    // Pre-select confident matches.
    const preset = {};
    for (const loc of locs ?? []) {
      const best = bestConfident(proposeMatches(loc, parts ?? []));
      if (best) preset[loc.id] = best.partner.id;
    }
    setSel((cur) => ({ ...preset, ...cur }));
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [org?.id]);

  // Per-venue candidate list, memoized.
  const candByLoc = useMemo(() => {
    const m = {};
    for (const loc of orphans ?? []) m[loc.id] = proposeMatches(loc, partners);
    return m;
  }, [orphans, partners]);

  const confidentIds = useMemo(() => {
    const ids = [];
    for (const loc of orphans ?? []) {
      const best = bestConfident(candByLoc[loc.id] ?? []);
      if (best && sel[loc.id] === best.partner.id) ids.push(loc.id);
    }
    return ids;
  }, [orphans, candByLoc, sel]);

  async function linkOne(loc) {
    const choice = sel[loc.id];
    if (!choice) { setError(`Pick a partner for ${loc.name} first.`); return; }
    setBusyId(loc.id);
    setError('');
    try {
      if (choice === CREATE_NEW) {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-partners-write`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({
              organization_id: org.id,
              partners: [{
                partner_name: loc.name,
                partner_type: newType[loc.id] || 'public_school',
                action: 'create',
                link_existing_location_id: loc.id,
                contacts: [],
              }],
            }),
          },
        );
        const j = await resp.json();
        if (!resp.ok || j?.errors?.length) {
          throw new Error(j?.error || j?.errors?.[0]?.reason || 'Create failed.');
        }
      } else {
        // Attach to existing partner: direct, RLS + same-org-trigger guarded.
        const { error: uErr } = await supabase
          .from('program_locations')
          .update({ partner_id: choice })
          .eq('id', loc.id)
          .is('partner_id', null);
        if (uErr) throw new Error(uErr.message);
      }
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setError(`${loc.name}: ${e.message ?? 'link failed'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function linkAllConfident() {
    setBatchBusy(true);
    setError('');
    try {
      // Sequential to keep error attribution clear and avoid trigger races.
      for (const id of confidentIds) {
        const partnerId = sel[id];
        const { error: uErr } = await supabase
          .from('program_locations')
          .update({ partner_id: partnerId })
          .eq('id', id)
          .is('partner_id', null);
        if (uErr) throw new Error(uErr.message);
      }
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setError(e.message ?? 'Batch link failed.');
    } finally {
      setBatchBusy(false);
    }
  }

  if (orphans === null) return null;          // loading: stay invisible
  if (orphans.length === 0) return null;      // self-empty: nothing to fix

  return (
    <div style={{
      background: '#fff', border: `1px solid ${CORAL}`, borderRadius: 12,
      padding: 18, marginBottom: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: PURPLE }}>
            Needs linking — {orphans.length} {orphans.length === 1 ? 'venue' : 'venues'}
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, maxWidth: 620, lineHeight: 1.5 }}>
            These venues aren't connected to a partner yet, so rosters and flyer
            contacts can't find them. Confirm the match we found, pick a different
            partner, or create a new one.
          </div>
        </div>
        {confidentIds.length > 0 && (
          <button onClick={linkAllConfident} disabled={batchBusy}
            style={{
              padding: '8px 14px', background: BRIGHT, color: '#fff', border: 'none',
              borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: batchBusy ? 'default' : 'pointer',
              opacity: batchBusy ? 0.6 : 1, fontFamily: 'inherit', flexShrink: 0,
            }}>
            {batchBusy ? 'Linking…' : `Link ${confidentIds.length} confident ${confidentIds.length === 1 ? 'match' : 'matches'}`}
          </button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, padding: '8px 12px', background: '#fbeaea', border: `1px solid ${CORAL}`, borderRadius: 6, color: '#7a2a2a', fontSize: 12.5 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {orphans.map((loc) => {
          const cands = candByLoc[loc.id] ?? [];
          const best = bestConfident(cands);
          const choice = sel[loc.id] ?? '';
          const isCreate = choice === CREATE_NEW;
          return (
            <div key={loc.id} style={{
              display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
              padding: '10px 12px', background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8,
            }}>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{loc.name}</div>
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 1 }}>
                  {[loc.area, loc.district].filter(Boolean).join(' · ') || 'no area on file'}
                </div>
              </div>

              <div style={{ flex: '2 1 320px', minWidth: 220 }}>
                <select
                  value={choice}
                  onChange={(e) => setSel((c) => ({ ...c, [loc.id]: e.target.value }))}
                  style={{
                    width: '100%', padding: '7px 10px', fontSize: 12.5, border: `1px solid ${RULE}`,
                    borderRadius: 6, fontFamily: 'inherit', background: '#fff', color: INK,
                  }}>
                  <option value="">— pick a partner —</option>
                  {best && (
                    <option value={best.partner.id}>
                      ✓ {best.partner.partner_name} (suggested{best.areaMatch ? ', area matches' : ''})
                    </option>
                  )}
                  {cands.filter((c) => !best || c.partner.id !== best.partner.id).map((c) => (
                    <option key={c.partner.id} value={c.partner.id}>
                      {c.tier === 'weak' ? '? ' : ''}{c.partner.partner_name}
                      {c.areaMatch ? ' (area matches)' : ''}
                    </option>
                  ))}
                  <option disabled>──────────</option>
                  {partners.filter((p) => !cands.some((c) => c.partner.id === p.id)).map((p) => (
                    <option key={p.id} value={p.id}>{p.partner_name}</option>
                  ))}
                  <option value={CREATE_NEW}>+ Create a new partner from this venue</option>
                </select>
                {isCreate && (
                  <select
                    value={newType[loc.id] || 'public_school'}
                    onChange={(e) => setNewType((c) => ({ ...c, [loc.id]: e.target.value }))}
                    style={{
                      width: '100%', marginTop: 6, padding: '6px 10px', fontSize: 12, border: `1px solid ${RULE}`,
                      borderRadius: 6, fontFamily: 'inherit', background: '#fff', color: INK,
                    }}>
                    {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                  </select>
                )}
              </div>

              <button
                onClick={() => linkOne(loc)}
                disabled={busyId === loc.id || !choice}
                style={{
                  flexShrink: 0, padding: '7px 14px',
                  background: choice ? BRIGHT : '#e7e5de', color: choice ? '#fff' : MUTED,
                  border: 'none', borderRadius: 7, fontSize: 12.5, fontWeight: 600,
                  cursor: busyId === loc.id || !choice ? 'default' : 'pointer',
                  opacity: busyId === loc.id ? 0.6 : 1, fontFamily: 'inherit',
                }}>
                {busyId === loc.id ? 'Linking…' : isCreate ? 'Create & link' : 'Link'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
