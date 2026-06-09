// FindMissingAddressesModal — bulk lookup of addresses for locations that
// don't have one yet, using Google Places. Operator clicks one button,
// reviews the suggestions, accepts the good ones, saves in batch.
//
// Quota: each lookup is a Places "findPlaceFromQuery" call. Google's Maps
// Platform $200/mo free credit covers ~12k of these — far more than any
// realistic alpha tenant will need.
//
// Activation: button on the Locations page header that opens this modal.
// Only shown when (a) VITE_GOOGLE_MAPS_API_KEY is set AND (b) at least one
// location is missing an address.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { loadGoogleMaps } from '../../components/PlacesAutocomplete';
import ElapsedTimer from '../../components/ElapsedTimer';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';   // indigo - primary actions (Figma)
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const OK = '#3a7c3a';
const AMBER = '#b67e00';
const RED = '#b53737';

// Cap how many locations we look up per click so a tenant with a thousand
// rows doesn't accidentally rack up time/quota. Bigger sets just take a
// second click.
const LOOKUP_BATCH_CAP = 100;

export default function FindMissingAddressesModal({ orgId, locations, onClose, onSaved }) {
  const missing = useMemo(
    () => (locations ?? []).filter((l) => !l.address || !String(l.address).trim()).slice(0, LOOKUP_BATCH_CAP),
    [locations],
  );
  const overCap = (locations ?? []).filter((l) => !l.address || !String(l.address).trim()).length > LOOKUP_BATCH_CAP;

  // phase: confirm | looking | review | saving | done | error
  const [phase, setPhase] = useState('confirm');
  const [progress, setProgress] = useState({ done: 0, total: missing.length });
  const [results, setResults] = useState([]); // [{location, suggested, status, selected}]
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedCount, setSavedCount] = useState(0);

  // Live elapsed timer during lookup (AI-wait UI rule — same component used
  // by curriculum extract + import + marketing draft).
  useEffect(() => {
    if (phase !== 'looking') { setElapsed(0); return; }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  async function startLookup() {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      setPhase('error');
      setSaveError('Google Maps is not configured.');
      return;
    }
    setPhase('looking');
    setProgress({ done: 0, total: missing.length });
    try {
      const google = await loadGoogleMaps(apiKey);
      // PlacesService requires an attached element; a throwaway div is fine.
      const host = document.createElement('div');
      const service = new google.maps.places.PlacesService(host);

      const out = [];
      for (let i = 0; i < missing.length; i++) {
        const loc = missing[i];
        // Bias query toward the existing district when we have one (avoids
        // matching "Ainsworth" in another state). Falls back to a plain
        // venue-name query.
        const queryParts = [loc.name];
        if (loc.district) queryParts.push(loc.district);
        const query = queryParts.join(' ');
        // eslint-disable-next-line no-await-in-loop
        const candidate = await lookupOne(service, google, query);
        out.push({
          location: loc,
          suggested: candidate, // { name, formatted_address } or null
          status: candidate ? 'found' : 'notfound',
          selected: !!candidate, // pre-check anything we found
        });
        setProgress({ done: i + 1, total: missing.length });
        setResults([...out]);
      }
      setPhase('review');
    } catch (err) {
      console.error('[FindMissingAddresses] lookup failed', err);
      setSaveError(err.message ?? String(err));
      setPhase('error');
    }
  }

  function lookupOne(service, google, query) {
    return new Promise((resolve) => {
      service.findPlaceFromQuery(
        {
          query,
          fields: ['name', 'formatted_address'],
        },
        (results, status) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && Array.isArray(results) && results.length > 0) {
            const r = results[0];
            resolve({ name: r.name ?? query, formatted_address: r.formatted_address ?? '' });
          } else {
            resolve(null);
          }
        },
      );
    });
  }

  function toggleRow(i) {
    setResults((cur) => cur.map((r, idx) => idx === i ? { ...r, selected: !r.selected } : r));
  }
  function selectAll(value) {
    setResults((cur) => cur.map((r) => r.status === 'found' ? { ...r, selected: value } : r));
  }

  async function commitAccepted() {
    const accepted = results.filter((r) => r.selected && r.suggested?.formatted_address);
    if (accepted.length === 0) {
      setSaveError('No rows selected.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setPhase('saving');
    let written = 0;
    try {
      for (const r of accepted) {
        // eslint-disable-next-line no-await-in-loop
        const { error } = await supabase
          .from('program_locations')
          .update({ address: r.suggested.formatted_address })
          .eq('id', r.location.id);
        if (error) throw error;
        written++;
      }
      setSavedCount(written);
      setPhase('done');
    } catch (err) {
      setSaveError(err.message ?? String(err));
      setPhase('review');
    } finally {
      setSaving(false);
    }
  }

  function done() {
    onSaved?.(savedCount);
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '4vh 16px', zIndex: 200, fontFamily: 'inherit',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, maxWidth: 920, width: '100%',
          padding: 24, maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>
              Find missing addresses
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>
              {phase === 'confirm' && `We found ${missing.length} location${missing.length === 1 ? '' : 's'} without an address. Want us to look them up?`}
              {phase === 'looking' && 'Looking up addresses on Google…'}
              {phase === 'review' && 'Review the suggestions. Uncheck anything wrong, then save.'}
              {phase === 'saving' && 'Saving…'}
              {phase === 'done' && 'All set.'}
              {phase === 'error' && 'Something went wrong.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {phase === 'confirm' && (
          <div>
            <div style={{ background: CREAM, border: `1px solid ${RULE}`, padding: 14, borderRadius: 8, fontSize: 13.5, color: INK, lineHeight: 1.55, marginBottom: 16 }}>
              We'll search Google for each location's name (and district when set) and bring back the best address match.
              Nothing saves until you review and accept. Takes about <strong>{Math.max(2, Math.ceil(missing.length / 4))}–{Math.ceil(missing.length / 2)} seconds</strong> for {missing.length} location{missing.length === 1 ? '' : 's'}.
              {overCap && (
                <div style={{ marginTop: 8, color: AMBER }}>
                  ⓘ You have more than {LOOKUP_BATCH_CAP} unlinked locations. We'll do the first {LOOKUP_BATCH_CAP} now — click again after to do the rest.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
              >Cancel</button>
              <button
                type="button"
                onClick={startLookup}
                disabled={missing.length === 0}
                style={{ padding: '8px 16px', background: BRIGHT, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              >✨ Find {missing.length} address{missing.length === 1 ? '' : 'es'} →</button>
            </div>
          </div>
        )}

        {phase === 'looking' && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
            <div style={{ fontSize: 22, marginBottom: 8 }}>📍</div>
            <div style={{ color: INK, fontSize: 14 }}>
              Looking up <strong>{progress.done}</strong> of <strong>{progress.total}</strong>…
            </div>
            <div style={{ marginTop: 14 }}>
              <ElapsedTimer seconds={elapsed} />
            </div>
          </div>
        )}

        {phase === 'review' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
              <div style={{ fontSize: 12.5, color: MUTED }}>
                {results.filter((r) => r.status === 'found').length} found · {results.filter((r) => r.status === 'notfound').length} no match · {results.filter((r) => r.selected).length} selected
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => selectAll(true)}
                  style={selectAllBtn}
                >Select all found</button>
                <button
                  type="button"
                  onClick={() => selectAll(false)}
                  style={selectAllBtn}
                >Deselect all</button>
              </div>
            </div>
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, overflow: 'hidden' }}>
              {results.map((r, i) => (
                <div
                  key={r.location.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '32px 1fr 1fr', alignItems: 'center',
                    padding: '10px 12px', gap: 12,
                    borderBottom: i < results.length - 1 ? `1px solid ${RULE}` : 'none',
                    background: r.status === 'notfound' ? '#fafafa' : '#fff',
                    opacity: r.status === 'notfound' ? 0.7 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!r.selected}
                    disabled={r.status !== 'found'}
                    onChange={() => toggleRow(i)}
                  />
                  <div style={{ fontSize: 13, color: INK, fontWeight: 600 }}>
                    {r.location.name}
                  </div>
                  <div style={{ fontSize: 12.5, color: r.status === 'found' ? INK : AMBER }}>
                    {r.status === 'found'
                      ? r.suggested.formatted_address
                      : '— no match found, you can add this one manually'}
                  </div>
                </div>
              ))}
            </div>
            {saveError && (
              <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginTop: 10 }}>
                {saveError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button
                type="button"
                onClick={onClose}
                style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
              >Cancel</button>
              <button
                type="button"
                onClick={commitAccepted}
                disabled={saving || results.filter((r) => r.selected).length === 0}
                style={{ padding: '8px 16px', background: BRIGHT, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: results.filter((r) => r.selected).length === 0 ? 0.5 : 1 }}
              >Save {results.filter((r) => r.selected).length} address{results.filter((r) => r.selected).length === 1 ? '' : 'es'}</button>
            </div>
          </div>
        )}

        {phase === 'saving' && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MUTED, fontSize: 14 }}>Saving…</div>
        )}

        {phase === 'done' && (
          <div>
            <div style={{ textAlign: 'center', padding: '8px 0 14px' }}>
              <div style={{ fontSize: 40, lineHeight: 1 }}>🎉</div>
              <h3 style={{ margin: '8px 0 2px', fontSize: 18, fontWeight: 800, color: PURPLE }}>Addresses saved.</h3>
              <p style={{ margin: 0, fontSize: 13, color: MUTED }}>
                {savedCount} location{savedCount === 1 ? '' : 's'} updated. Instructor and parent emails will now include the venue address.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                onClick={done}
                style={{ padding: '8px 16px', background: BRIGHT, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              >Done</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <div style={{ background: `${RED}1A`, color: RED, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
              {saveError ?? 'Something went wrong.'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onClose}
                style={{ padding: '8px 16px', background: BRIGHT, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              >Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const selectAllBtn = {
  padding: '4px 8px',
  fontSize: 11.5,
  background: 'transparent',
  border: `1px solid ${RULE}`,
  borderRadius: 5,
  color: PURPLE,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
