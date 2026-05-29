// ImportContactsModal — multi-step bulk import of partners + contacts.
//
// Steps:
//   1. source   — pick "Upload file" or "Paste text"
//   2. extracting — sends payload to import-partners-extract; waits for
//                   structured rows back from Claude
//   3. review   — show extracted partners + contacts, with new/match badges
//                 and per-row checkboxes; let operator edit obvious mistakes
//                 (rename a partner, change a role) before write
//   4. writing  — sends accepted rows to import-partners-write
//   5. done     — success summary
//
// Multi-tenant: all writes go through edge fns that validate org membership.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const OK = '#3a7c3a';
const AMBER = '#b67e00';
const RED = '#b53737';

const PARTNER_TYPES = [
  { v: '', label: '—' },
  { v: 'public_school', label: 'Public school' },
  { v: 'private_school', label: 'Private school' },
  { v: 'charter_school', label: 'Charter school' },
  { v: 'school_district', label: 'School district' },
  { v: 'parks_rec', label: 'Parks & Rec' },
  { v: 'community_org', label: 'Community org' },
  { v: 'church', label: 'Church' },
];

const ROLES = [
  { v: 'operational', label: 'Operational (site logistics)' },
  { v: 'marketing', label: 'Marketing (flyer distribution)' },
  { v: 'invoicing', label: 'Invoicing (billing)' },
  { v: 'approval_gatekeeper', label: 'Approval gatekeeper' },
];

export default function ImportContactsModal({ orgId, onClose, onImported }) {
  const [step, setStep] = useState('source'); // source | extracting | review | writing | done
  const [mode, setMode] = useState('file'); // file | text
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [extracted, setExtracted] = useState([]); // partners array
  const [existingByName, setExistingByName] = useState(new Map());
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  // Pre-load existing partners to compute match badges client-side.
  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data } = await supabase
        .from('partners')
        .select('id, partner_name')
        .eq('organization_id', orgId);
      const m = new Map();
      for (const p of data ?? []) m.set(normName(p.partner_name), { id: p.id, name: p.partner_name });
      setExistingByName(m);
    })();
  }, [orgId]);

  async function startExtract() {
    setError('');
    if (mode === 'file' && !file) { setError('Pick a file first.'); return; }
    if (mode === 'text' && !text.trim()) { setError('Paste some text first.'); return; }

    setStep('extracting');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');

      let payload, source, filename;
      if (mode === 'text') {
        source = 'text';
        payload = text.slice(0, 60000);
      } else {
        filename = file.name;
        const ext = (file.name.split('.').pop() ?? '').toLowerCase();
        if (ext === 'csv' || ext === 'txt') {
          source = 'csv';
          payload = await file.text();
        } else if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
          source = 'xlsx';
          payload = await fileToBase64(file);
        } else {
          throw new Error(`Unsupported file type: .${ext}. Use CSV or XLSX.`);
        }
      }

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-partners-extract`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ source, payload, filename }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Extract failed (${resp.status}).`);
        setStep('source');
        return;
      }
      const partners = (json.partners ?? []).map((p) => ({
        ...p,
        _selected: true,
        contacts: (p.contacts ?? []).map((c) => ({ ...c, _selected: true })),
      }));
      if (partners.length === 0) {
        setError("We couldn't find any partner organisations or contacts in that input.");
        setStep('source');
        return;
      }
      setExtracted(partners);
      setStep('review');
    } catch (e) {
      console.error('[ImportContactsModal] extract failed', e);
      setError(e.message ?? 'Extract failed.');
      setStep('source');
    }
  }

  async function commitImport() {
    setError('');
    setStep('writing');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');

      const partnersPayload = [];
      for (const p of extracted) {
        if (!p._selected) continue;
        const match = existingByName.get(normName(p.partner_name));
        partnersPayload.push({
          partner_name: p.partner_name,
          partner_type: p.partner_type,
          location_area: p.location_area,
          locations_managed: p.locations_managed,
          marketing_notes: p.marketing_notes,
          invoicing_notes: p.invoicing_notes,
          planning_notes: p.planning_notes,
          implementation_notes: p.implementation_notes,
          other_notes: p.other_notes,
          action: match ? 'merge' : 'create',
          match_partner_id: match?.id ?? null,
          contacts: (p.contacts ?? []).map((c) => ({
            ...c,
            action: c._selected ? 'create' : 'skip',
          })),
        });
      }

      if (partnersPayload.length === 0) {
        setError('No rows selected.');
        setStep('review');
        return;
      }

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-partners-write`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ organization_id: orgId, partners: partnersPayload }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Import failed (${resp.status}).`);
        setStep('review');
        return;
      }
      setResult(json);
      setStep('done');
    } catch (e) {
      console.error('[ImportContactsModal] write failed', e);
      setError(e.message ?? 'Import failed.');
      setStep('review');
    }
  }

  const selectedCount = useMemo(() => {
    let p = 0, c = 0;
    for (const partner of extracted) {
      if (!partner._selected) continue;
      p++;
      for (const ct of partner.contacts ?? []) if (ct._selected) c++;
    }
    return { p, c };
  }, [extracted]);

  function updatePartner(idx, patch) {
    setExtracted((cur) => cur.map((p, i) => i === idx ? { ...p, ...patch } : p));
  }
  function updateContact(pIdx, cIdx, patch) {
    setExtracted((cur) => cur.map((p, i) => {
      if (i !== pIdx) return p;
      return { ...p, contacts: p.contacts.map((c, j) => j === cIdx ? { ...c, ...patch } : c) };
    }));
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
          background: '#fff', borderRadius: 12, maxWidth: 880, width: '100%',
          padding: 24, maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>
              Import partners &amp; contacts
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>
              {step === 'source' && 'Upload a list or paste freeform text. We extract structured rows for you to review.'}
              {step === 'extracting' && 'Working through the file…'}
              {step === 'review' && 'Review what we found, edit anything that looks off, then save.'}
              {step === 'writing' && 'Saving to your contacts…'}
              {step === 'done' && 'Done.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {step === 'source' && (
          <SourceStep
            mode={mode} setMode={setMode}
            file={file} setFile={setFile}
            text={text} setText={setText}
            onCancel={onClose}
            onNext={startExtract}
          />
        )}

        {step === 'extracting' && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MUTED, fontSize: 14 }}>
            Reading and extracting structured data… This usually takes 10–30 seconds.
          </div>
        )}

        {step === 'review' && (
          <ReviewStep
            partners={extracted}
            existingByName={existingByName}
            selectedCount={selectedCount}
            updatePartner={updatePartner}
            updateContact={updateContact}
            onBack={() => setStep('source')}
            onCommit={commitImport}
          />
        )}

        {step === 'writing' && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MUTED, fontSize: 14 }}>
            Saving…
          </div>
        )}

        {step === 'done' && result && (
          <DoneStep result={result} onClose={() => { onImported && onImported(); }} />
        )}
      </div>
    </div>
  );
}

// ─── Step components ────────────────────────────────────────────────────────

function SourceStep({ mode, setMode, file, setFile, text, setText, onCancel, onNext }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 14 }}>
        <TabBtn active={mode === 'file'} onClick={() => setMode('file')} label="Upload file" />
        <TabBtn active={mode === 'text'} onClick={() => setMode('text')} label="Paste text" />
      </div>

      {mode === 'file' && (
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: INK, lineHeight: 1.5 }}>
            Drop in a <strong>CSV</strong> or <strong>XLSX</strong> exported from Drive,
            Sheets, or your own master list. Headers can be in any format — we'll figure out which column is which.
          </p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13, marginBottom: 10 }}
          />
          {file && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              Selected: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)
            </div>
          )}
        </div>
      )}

      {mode === 'text' && (
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: INK, lineHeight: 1.5 }}>
            Paste an email thread, a copied Drive doc, or any messy text that
            mentions schools / partners + their contacts. We'll do our best to
            pull out the structured data.
          </p>
          <textarea
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste freeform text here…"
            style={{ width: '100%', padding: 10, fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }}
          />
          <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{text.length.toLocaleString()} characters</div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
        >Cancel</button>
        <button
          type="button"
          onClick={onNext}
          style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
        >Extract →</button>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 14px', background: 'transparent', border: 'none',
        borderBottom: active ? `2px solid ${PURPLE}` : '2px solid transparent',
        color: active ? PURPLE : MUTED, fontSize: 13, fontWeight: 600,
        fontFamily: 'inherit', cursor: 'pointer', marginBottom: -1,
      }}
    >{label}</button>
  );
}

function ReviewStep({ partners, existingByName, selectedCount, updatePartner, updateContact, onBack, onCommit }) {
  const newPartners = partners.filter((p) => !existingByName.has(normName(p.partner_name))).length;
  const matchedPartners = partners.length - newPartners;
  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          Found <strong>{partners.length}</strong> partner{partners.length === 1 ? '' : 's'} ({newPartners} new, {matchedPartners} match existing){' '}
          with <strong>{partners.reduce((s, p) => s + (p.contacts?.length ?? 0), 0)}</strong> contacts total.
          Uncheck anything you don't want to bring in. Matched partners merge — existing data is kept; new contacts add.
        </div>
        <div style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap' }}>
          Selected: {selectedCount.p}P / {selectedCount.c}C
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        {partners.map((p, pIdx) => {
          const match = existingByName.get(normName(p.partner_name));
          return (
            <PartnerCard
              key={pIdx}
              p={p}
              match={match}
              onChange={(patch) => updatePartner(pIdx, patch)}
              onContactChange={(cIdx, patch) => updateContact(pIdx, cIdx, patch)}
            />
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
        >← Back</button>
        <button
          type="button"
          onClick={onCommit}
          disabled={selectedCount.p === 0 && selectedCount.c === 0}
          style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', opacity: (selectedCount.p === 0 && selectedCount.c === 0) ? 0.5 : 1 }}
        >Save {selectedCount.p} partner{selectedCount.p === 1 ? '' : 's'} / {selectedCount.c} contact{selectedCount.c === 1 ? '' : 's'}</button>
      </div>
    </div>
  );
}

function PartnerCard({ p, match, onChange, onContactChange }) {
  const isMatch = !!match;
  return (
    <div style={{
      background: '#fff', border: `1px solid ${isMatch ? AMBER + '55' : OK + '55'}`,
      borderLeft: `4px solid ${isMatch ? AMBER : OK}`,
      borderRadius: 8, padding: 14, opacity: p._selected ? 1 : 0.55,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          checked={!!p._selected}
          onChange={(e) => onChange({ _selected: e.target.checked })}
          style={{ marginTop: 6 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={p.partner_name ?? ''}
              onChange={(e) => onChange({ partner_name: e.target.value })}
              style={{ flex: '1 1 240px', fontSize: 14, fontWeight: 600, color: INK, padding: '4px 8px', border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit' }}
            />
            <span style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 99, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
              background: isMatch ? `${AMBER}1A` : `${OK}1A`, color: isMatch ? AMBER : OK,
            }}>
              {isMatch ? 'merge into existing' : 'new partner'}
            </span>
          </div>
          {isMatch && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Existing: <strong>{match.name}</strong> · new contacts will be added under it.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Field label="Type">
              <select
                value={p.partner_type ?? ''}
                onChange={(e) => onChange({ partner_type: e.target.value || null })}
                style={{ padding: '4px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit' }}
              >
                {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Area">
              <input
                type="text"
                value={p.location_area ?? ''}
                onChange={(e) => onChange({ location_area: e.target.value || null })}
                placeholder="e.g. Denver"
                style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', width: 130 }}
              />
            </Field>
          </div>

          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(p.contacts ?? []).map((c, cIdx) => (
              <ContactRow key={cIdx} c={c} onChange={(patch) => onContactChange(cIdx, patch)} />
            ))}
            {(!p.contacts || p.contacts.length === 0) && (
              <div style={{ fontSize: 12, color: MUTED, fontStyle: 'italic' }}>No contacts extracted for this partner.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactRow({ c, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 8px', background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6,
      opacity: c._selected ? 1 : 0.5,
    }}>
      <input
        type="checkbox"
        checked={!!c._selected}
        onChange={(e) => onChange({ _selected: e.target.checked })}
      />
      <input
        type="text"
        value={c.contact_name ?? ''}
        onChange={(e) => onChange({ contact_name: e.target.value })}
        placeholder="Name"
        style={{ flex: '1 1 120px', minWidth: 0, padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      />
      <input
        type="email"
        value={c.contact_email ?? ''}
        onChange={(e) => onChange({ contact_email: e.target.value })}
        placeholder="email@…"
        style={{ flex: '1 1 180px', minWidth: 0, padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      />
      <input
        type="text"
        value={c.contact_phone ?? ''}
        onChange={(e) => onChange({ contact_phone: e.target.value })}
        placeholder="phone"
        style={{ flex: '0 0 110px', padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      />
      <select
        value={c.contact_role ?? 'operational'}
        onChange={(e) => onChange({ contact_role: e.target.value })}
        style={{ flex: '0 0 150px', padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      >
        {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
      </select>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}

function DoneStep({ result, onClose }) {
  return (
    <div>
      <div style={{ background: `${OK}1A`, border: `1px solid ${OK}55`, padding: 14, borderRadius: 8, fontSize: 14, color: INK, lineHeight: 1.6 }}>
        <strong style={{ color: OK }}>Saved.</strong><br />
        <strong>{result.partners_created}</strong> new partner{result.partners_created === 1 ? '' : 's'},{' '}
        <strong>{result.partners_merged}</strong> merged into existing,{' '}
        <strong>{result.contacts_created}</strong> new contact{result.contacts_created === 1 ? '' : 's'}.{' '}
        {result.contacts_skipped > 0 && <span style={{ color: MUTED }}>{result.contacts_skipped} skipped (duplicates or unselected).</span>}
      </div>
      {Array.isArray(result.errors) && result.errors.length > 0 && (
        <div style={{ marginTop: 10, background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13 }}>
          <strong>{result.errors.length} row{result.errors.length === 1 ? '' : 's'} had problems:</strong>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {result.errors.slice(0, 10).map((e, i) => <li key={i}>{e.partner}: {e.reason}</li>)}
            {result.errors.length > 10 && <li>…and {result.errors.length - 10} more</li>}
          </ul>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
        >Done</button>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normName(s) {
  return (s ?? '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      // strip data URL prefix
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
