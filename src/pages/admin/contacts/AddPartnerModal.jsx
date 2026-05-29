// AddPartnerModal — one-screen form to manually add a single partner + its
// contacts. Submits via the same import-partners-write edge function as the
// bulk importer, so name-matching and email-dedupe behavior is identical.

import { useState } from 'react';
import { supabase } from '../../../lib/supabase';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const OK = '#3a7c3a';
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

const EMPTY_CONTACT = { contact_name: '', contact_email: '', contact_phone: '', contact_role: 'operational' };

export default function AddPartnerModal({ orgId, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [area, setArea] = useState('');
  const [contacts, setContacts] = useState([{ ...EMPTY_CONTACT }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function updateContact(i, patch) {
    setContacts((cur) => cur.map((c, j) => j === i ? { ...c, ...patch } : c));
  }
  function addContact() {
    setContacts((cur) => [...cur, { ...EMPTY_CONTACT }]);
  }
  function removeContact(i) {
    setContacts((cur) => cur.length > 1 ? cur.filter((_, j) => j !== i) : cur);
  }

  async function save() {
    setError('');
    const trimmed = name.trim();
    if (!trimmed) { setError('Partner name is required.'); return; }
    const validContacts = contacts
      .map((c) => ({
        contact_name: (c.contact_name ?? '').trim() || null,
        contact_email: (c.contact_email ?? '').trim().toLowerCase() || null,
        contact_phone: (c.contact_phone ?? '').trim() || null,
        contact_role: c.contact_role || 'operational',
      }))
      .filter((c) => c.contact_email);
    if (validContacts.some((c) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.contact_email))) {
      setError("One of the email addresses doesn't look right.");
      return;
    }

    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
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
            organization_id: orgId,
            partners: [{
              partner_name: trimmed,
              partner_type: type || null,
              location_area: area.trim() || null,
              action: 'create', // server will auto-merge if name matches existing
              contacts: validContacts,
            }],
          }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Couldn't save (${resp.status}).`);
        setBusy(false);
        return;
      }
      if (onSaved) onSaved(json);
    } catch (e) {
      console.error('[AddPartnerModal] save failed', e);
      setError(e.message ?? "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 16px', zIndex: 200, fontFamily: 'inherit',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, maxWidth: 620, width: '100%',
          padding: 24, maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>Add partner</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>
              One partner + its contacts. If the name already exists, new contacts get added under it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
          <label style={{ gridColumn: '1 / -1' }}>
            <Lbl>Partner name *</Lbl>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Roosevelt Elementary"
              style={inputStyle}
              disabled={busy}
            />
          </label>
          <label>
            <Lbl>Type</Lbl>
            <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle} disabled={busy}>
              {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </label>
          <label style={{ gridColumn: '2 / span 2' }}>
            <Lbl>Area (optional)</Lbl>
            <input
              type="text"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="e.g. Denver"
              style={inputStyle}
              disabled={busy}
            />
          </label>
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
          Contacts
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {contacts.map((c, i) => (
            <div key={i} style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label>
                  <Lbl>Name</Lbl>
                  <input
                    type="text"
                    value={c.contact_name}
                    onChange={(e) => updateContact(i, { contact_name: e.target.value })}
                    placeholder="e.g. Tia Test"
                    style={inputStyle}
                    disabled={busy}
                  />
                </label>
                <label>
                  <Lbl>Email *</Lbl>
                  <input
                    type="email"
                    value={c.contact_email}
                    onChange={(e) => updateContact(i, { contact_email: e.target.value })}
                    placeholder="email@…"
                    style={inputStyle}
                    disabled={busy}
                  />
                </label>
                <label>
                  <Lbl>Phone</Lbl>
                  <input
                    type="text"
                    value={c.contact_phone}
                    onChange={(e) => updateContact(i, { contact_phone: e.target.value })}
                    placeholder="(optional)"
                    style={inputStyle}
                    disabled={busy}
                  />
                </label>
                <label>
                  <Lbl>Role</Lbl>
                  <select
                    value={c.contact_role}
                    onChange={(e) => updateContact(i, { contact_role: e.target.value })}
                    style={inputStyle}
                    disabled={busy}
                  >
                    {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                  </select>
                </label>
              </div>
              {contacts.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeContact(i)}
                  disabled={busy}
                  style={{ marginTop: 6, background: 'transparent', border: 'none', color: MUTED, fontSize: 11, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                >Remove this contact</button>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addContact}
          disabled={busy}
          style={{
            background: 'transparent', color: PURPLE, border: `1px dashed ${PURPLE}`,
            padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer', marginBottom: 14,
          }}
        >+ Add another contact</button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer' }}
          >Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}
          >{busy ? 'Saving…' : 'Save partner'}</button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  border: `1px solid ${RULE}`,
  borderRadius: 5,
  fontFamily: 'inherit',
  background: '#fff',
  color: INK,
  boxSizing: 'border-box',
};

function Lbl({ children }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: MUTED, display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {children}
    </span>
  );
}
