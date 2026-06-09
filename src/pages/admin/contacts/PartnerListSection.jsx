// PartnerListSection — searchable list of partners under the Partners tab.
// Each row click-to-expand reveals inline editing for the partner's fields
// + its contacts. RLS on partners + partner_contacts is org-scoped via
// check_org_access(organization_id), so direct supabase writes from an
// authenticated admin work without an intermediate edge function.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';   // indigo - primary actions (Figma)
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
  { v: 'operational', label: 'Operational' },
  { v: 'marketing', label: 'Marketing' },
  { v: 'invoicing', label: 'Invoicing' },
  { v: 'approval_gatekeeper', label: 'Approval gatekeeper' },
];

export default function PartnerListSection({ org, refreshKey, onChanged }) {
  const [partners, setPartners] = useState(null);
  const [contactCounts, setContactCounts] = useState(new Map());
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    if (!org?.id) return;
    setError('');
    const { data, error } = await supabase
      .from('partners')
      .select('id, partner_name, partner_type, location_area, locations_managed, marketing_notes, invoicing_notes, planning_notes, implementation_notes, other_notes, inactive, inactive_reason, updated_at')
      .eq('organization_id', org.id)
      .order('partner_name', { ascending: true });
    if (error) { setError(error.message); return; }

    // Per-partner contact counts (single round-trip).
    const ids = (data ?? []).map((p) => p.id);
    const counts = new Map();
    if (ids.length > 0) {
      const { data: contactRows } = await supabase
        .from('partner_contacts')
        .select('partner_id')
        .in('partner_id', ids);
      for (const c of contactRows ?? []) {
        counts.set(c.partner_id, (counts.get(c.partner_id) ?? 0) + 1);
      }
    }
    setContactCounts(counts);
    setPartners(data ?? []);
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org?.id, refreshKey]);

  const filtered = useMemo(() => {
    if (!partners) return [];
    const q = query.trim().toLowerCase();
    return partners.filter((p) => {
      if (!showInactive && p.inactive) return false;
      if (!q) return true;
      const hay = `${p.partner_name ?? ''} ${p.partner_type ?? ''} ${p.location_area ?? ''} ${p.locations_managed ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [partners, query, showInactive]);

  const inactiveCount = (partners ?? []).filter((p) => p.inactive).length;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search partners…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: '1 1 280px', maxWidth: 360, padding: '8px 12px', fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: 'inherit', boxSizing: 'border-box' }}
        />
        {inactiveCount > 0 && (
          <label style={{ fontSize: 12, color: MUTED, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive ({inactiveCount})
          </label>
        )}
      </div>

      {error && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {partners === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}

      {partners !== null && filtered.length === 0 && (
        <div style={{ color: MUTED, fontSize: 13, padding: 16, textAlign: 'center', background: '#fff', border: `1px solid ${RULE}`, borderRadius: 8 }}>
          {query ? 'No partners match that search.' : 'No partners yet — use Add partner or Import to get started.'}
        </div>
      )}

      {partners !== null && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((p) => (
            <PartnerRow
              key={p.id}
              partner={p}
              contactCount={contactCounts.get(p.id) ?? 0}
              expanded={expandedId === p.id}
              onToggle={() => setExpandedId((cur) => cur === p.id ? null : p.id)}
              onPartnerChanged={async () => { await load(); if (onChanged) onChanged(); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Partner row (collapsed view + expanded editor) ─────────────────────────

function PartnerRow({ partner, contactCount, expanded, onToggle, onPartnerChanged }) {
  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${RULE}`,
        borderLeft: partner.inactive ? `3px solid ${AMBER}` : `3px solid ${OK}`,
        borderRadius: 8,
        padding: '10px 14px',
        opacity: partner.inactive ? 0.7 : 1,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
          width: '100%', background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span style={{ color: PURPLE, fontSize: 12, fontWeight: 700 }}>{expanded ? '▾' : '▸'}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
              {partner.partner_name}
              {partner.inactive && (
                <span style={{ fontSize: 10, color: AMBER, marginLeft: 6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  inactive
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {partner.partner_type ? partner.partner_type.replace(/_/g, ' ') : 'unspecified'}
              {partner.location_area && ` · ${partner.location_area}`}
              {' · '}
              {contactCount} contact{contactCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}` }}>
          <PartnerEditor partner={partner} onChanged={onPartnerChanged} />
          <ContactsList partnerId={partner.id} organizationId={partner.organization_id ?? null} onChanged={onPartnerChanged} />
        </div>
      )}
    </div>
  );
}

// ─── Inline editor for the partner's own fields ─────────────────────────────

function PartnerEditor({ partner, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    partner_name: partner.partner_name ?? '',
    partner_type: partner.partner_type ?? '',
    location_area: partner.location_area ?? '',
    locations_managed: partner.locations_managed ?? '',
    marketing_notes: partner.marketing_notes ?? '',
    invoicing_notes: partner.invoicing_notes ?? '',
    planning_notes: partner.planning_notes ?? '',
    implementation_notes: partner.implementation_notes ?? '',
    other_notes: partner.other_notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function reset() {
    setForm({
      partner_name: partner.partner_name ?? '',
      partner_type: partner.partner_type ?? '',
      location_area: partner.location_area ?? '',
      locations_managed: partner.locations_managed ?? '',
      marketing_notes: partner.marketing_notes ?? '',
      invoicing_notes: partner.invoicing_notes ?? '',
      planning_notes: partner.planning_notes ?? '',
      implementation_notes: partner.implementation_notes ?? '',
      other_notes: partner.other_notes ?? '',
    });
    setErr('');
  }

  async function save() {
    if (busy) return;
    setErr('');
    if (!form.partner_name.trim()) { setErr('Partner name is required.'); return; }
    setBusy(true);
    try {
      const update = {
        partner_name: form.partner_name.trim(),
        partner_type: form.partner_type || null,
        location_area: emptyOrNull(form.location_area),
        locations_managed: emptyOrNull(form.locations_managed),
        marketing_notes: emptyOrNull(form.marketing_notes),
        invoicing_notes: emptyOrNull(form.invoicing_notes),
        planning_notes: emptyOrNull(form.planning_notes),
        implementation_notes: emptyOrNull(form.implementation_notes),
        other_notes: emptyOrNull(form.other_notes),
      };
      const { error } = await supabase.from('partners').update(update).eq('id', partner.id);
      if (error) throw error;
      setEditing(false);
      if (onChanged) await onChanged();
    } catch (e) {
      console.error('[PartnerEditor] save failed', e);
      setErr(e.message ?? "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleInactive() {
    if (busy) return;
    const goingInactive = !partner.inactive;
    if (goingInactive && !confirm(`Mark "${partner.partner_name}" inactive? It will be hidden from default views and excluded from new roster sends. You can reactivate later.`)) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('partners')
        .update({ inactive: goingInactive, inactive_reason: goingInactive ? 'archived from contacts' : null })
        .eq('id', partner.id);
      if (error) throw error;
      if (onChanged) await onChanged();
    } catch (e) {
      console.error('[PartnerEditor] toggleInactive failed', e);
      setErr(e.message ?? "Couldn't update.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 10, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: INK, lineHeight: 1.6, flex: 1, minWidth: 0 }}>
            {partner.locations_managed && <div><strong>Locations:</strong> {partner.locations_managed}</div>}
            {partner.marketing_notes && <div><strong>Marketing:</strong> {partner.marketing_notes}</div>}
            {partner.invoicing_notes && <div><strong>Invoicing:</strong> {partner.invoicing_notes}</div>}
            {partner.planning_notes && <div><strong>Planning:</strong> {partner.planning_notes}</div>}
            {partner.implementation_notes && <div><strong>Implementation:</strong> {partner.implementation_notes}</div>}
            {partner.other_notes && <div><strong>Other:</strong> {partner.other_notes}</div>}
            {!partner.locations_managed && !partner.marketing_notes && !partner.invoicing_notes && !partner.planning_notes && !partner.implementation_notes && !partner.other_notes && (
              <span style={{ color: MUTED, fontStyle: 'italic' }}>No notes on file.</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              style={btnGhostStyle()}
            >Edit partner</button>
            <button
              type="button"
              onClick={toggleInactive}
              disabled={busy}
              style={btnGhostStyle(partner.inactive ? OK : AMBER)}
              title={partner.inactive ? 'Reactivate this partner' : 'Mark inactive (hides from default views)'}
            >{partner.inactive ? 'Reactivate' : 'Mark inactive'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 12, marginBottom: 10 }}>
      {err && <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={{ gridColumn: '1 / span 2' }}>
          <Lbl>Name</Lbl>
          <input type="text" value={form.partner_name} onChange={(e) => setForm((f) => ({ ...f, partner_name: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label>
          <Lbl>Type</Lbl>
          <select value={form.partner_type} onChange={(e) => setForm((f) => ({ ...f, partner_type: e.target.value }))} style={inputStyle} disabled={busy}>
            {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Area</Lbl>
          <input type="text" value={form.location_area} onChange={(e) => setForm((f) => ({ ...f, location_area: e.target.value }))} placeholder="e.g. Denver" style={inputStyle} disabled={busy} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Locations this partner manages</Lbl>
          <input type="text" value={form.locations_managed} onChange={(e) => setForm((f) => ({ ...f, locations_managed: e.target.value }))} placeholder="comma-separated" style={inputStyle} disabled={busy} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Marketing notes</Lbl>
          <input type="text" value={form.marketing_notes} onChange={(e) => setForm((f) => ({ ...f, marketing_notes: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Invoicing notes</Lbl>
          <input type="text" value={form.invoicing_notes} onChange={(e) => setForm((f) => ({ ...f, invoicing_notes: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Planning notes</Lbl>
          <input type="text" value={form.planning_notes} onChange={(e) => setForm((f) => ({ ...f, planning_notes: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Implementation notes</Lbl>
          <input type="text" value={form.implementation_notes} onChange={(e) => setForm((f) => ({ ...f, implementation_notes: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Other notes</Lbl>
          <input type="text" value={form.other_notes} onChange={(e) => setForm((f) => ({ ...f, other_notes: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" onClick={() => { reset(); setEditing(false); }} disabled={busy} style={btnGhostStyle()}>Cancel</button>
        <button type="button" onClick={save} disabled={busy} style={btnPrimaryStyle(busy)}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// ─── Contacts list under a partner ──────────────────────────────────────────

function ContactsList({ partnerId, organizationId, onChanged }) {
  const [contacts, setContacts] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    const { data, error } = await supabase
      .from('partner_contacts')
      .select('id, organization_id, contact_name, contact_email, contact_phone, contact_role, role_description, is_org_inbox, locations_scope, marketing_notes, last_verified')
      .eq('partner_id', partnerId)
      .order('contact_role', { ascending: true });
    if (error) { setErr(error.message); return; }
    setContacts(data ?? []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [partnerId]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6 }}>Contacts</div>
        <button
          type="button"
          onClick={() => { setAdding((v) => !v); setEditingId(null); }}
          style={btnGhostStyle()}
        >{adding ? 'Cancel new' : '+ Add contact'}</button>
      </div>

      {err && <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {adding && (
        <ContactEditForm
          contact={{ partner_id: partnerId, organization_id: organizationId, contact_role: 'operational', is_org_inbox: false }}
          onCancel={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await load(); if (onChanged) await onChanged(); }}
        />
      )}

      {contacts === null && <div style={{ color: MUTED, fontSize: 12 }}>Loading…</div>}
      {contacts !== null && contacts.length === 0 && !adding && (
        <div style={{ color: MUTED, fontSize: 12, fontStyle: 'italic' }}>No contacts on file for this partner.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {(contacts ?? []).map((c) => (
          editingId === c.id ? (
            <ContactEditForm
              key={c.id}
              contact={c}
              onCancel={() => setEditingId(null)}
              onSaved={async () => { setEditingId(null); await load(); if (onChanged) await onChanged(); }}
              onDelete={async () => {
                if (!confirm(`Remove ${c.contact_name || c.contact_email}?`)) return;
                const { error } = await supabase.from('partner_contacts').delete().eq('id', c.id);
                if (error) { setErr(error.message); return; }
                setEditingId(null);
                await load();
                if (onChanged) await onChanged();
              }}
            />
          ) : (
            <ContactDisplayRow key={c.id} contact={c} onEdit={() => setEditingId(c.id)} />
          )
        ))}
      </div>
    </div>
  );
}

function ContactDisplayRow({ contact, onEdit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: '#fff', border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 12, color: INK }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>
          {contact.contact_name || <em style={{ fontWeight: 400, color: MUTED }}>(no name)</em>}
          <span style={{ fontSize: 10, color: MUTED, marginLeft: 6, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {(contact.contact_role || '').replace(/_/g, ' ')}
          </span>
          {contact.is_org_inbox && (
            <span style={{ fontSize: 10, color: AMBER, marginLeft: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>shared inbox</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 1 }}>
          {contact.contact_email}
          {contact.contact_phone && ` · ${contact.contact_phone}`}
        </div>
        {contact.role_description && <div style={{ fontSize: 11, color: MUTED, marginTop: 1, fontStyle: 'italic' }}>{contact.role_description}</div>}
      </div>
      <button type="button" onClick={onEdit} style={btnGhostStyle()}>Edit</button>
    </div>
  );
}

function ContactEditForm({ contact, onCancel, onSaved, onDelete }) {
  const isNew = !contact.id;
  const [form, setForm] = useState({
    contact_name: contact.contact_name ?? '',
    contact_email: contact.contact_email ?? '',
    contact_phone: contact.contact_phone ?? '',
    contact_role: contact.contact_role ?? 'operational',
    role_description: contact.role_description ?? '',
    is_org_inbox: !!contact.is_org_inbox,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (busy) return;
    setErr('');
    const email = form.contact_email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErr('A valid email is required.');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        contact_name: emptyOrNull(form.contact_name),
        contact_email: email,
        contact_phone: emptyOrNull(form.contact_phone),
        contact_role: form.contact_role,
        role_description: emptyOrNull(form.role_description),
        is_org_inbox: !!form.is_org_inbox,
      };
      if (isNew) {
        const { error } = await supabase
          .from('partner_contacts')
          .insert({ ...payload, partner_id: contact.partner_id, organization_id: contact.organization_id, source: 'manual' });
        if (error) throw error;
      } else {
        const { error } = await supabase.from('partner_contacts').update(payload).eq('id', contact.id);
        if (error) throw error;
      }
      if (onSaved) await onSaved();
    } catch (e) {
      console.error('[ContactEditForm] save failed', e);
      setErr(e.message ?? "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderLeft: `3px solid ${PURPLE}`, borderRadius: 6, padding: 10 }}>
      {err && <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label>
          <Lbl>Name</Lbl>
          <input type="text" value={form.contact_name} onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label>
          <Lbl>Email *</Lbl>
          <input type="email" value={form.contact_email} onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label>
          <Lbl>Phone</Lbl>
          <input type="text" value={form.contact_phone} onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))} style={inputStyle} disabled={busy} />
        </label>
        <label>
          <Lbl>Role</Lbl>
          <select value={form.contact_role} onChange={(e) => setForm((f) => ({ ...f, contact_role: e.target.value }))} style={inputStyle} disabled={busy}>
            {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <Lbl>Role description (optional)</Lbl>
          <input type="text" value={form.role_description} onChange={(e) => setForm((f) => ({ ...f, role_description: e.target.value }))} placeholder="e.g. Handles afterschool signups + day-of issues" style={inputStyle} disabled={busy} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK, gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={form.is_org_inbox} onChange={(e) => setForm((f) => ({ ...f, is_org_inbox: e.target.checked }))} disabled={busy} />
          This is a shared inbox (info@, ops@, etc.) — not a person
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <div>
          {!isNew && onDelete && (
            <button type="button" onClick={onDelete} disabled={busy} style={btnGhostStyle(RED)}>Remove contact</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={btnGhostStyle()}>Cancel</button>
          <button type="button" onClick={save} disabled={busy} style={btnPrimaryStyle(busy)}>{busy ? 'Saving…' : (isNew ? 'Add contact' : 'Save')}</button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function emptyOrNull(s) {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

const inputStyle = {
  width: '100%', padding: '6px 10px', fontSize: 12, border: `1px solid ${RULE}`,
  borderRadius: 5, fontFamily: 'inherit', background: '#fff', color: INK, boxSizing: 'border-box',
};

function Lbl({ children }) {
  return <span style={{ fontSize: 10, fontWeight: 600, color: MUTED, display: 'block', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.4 }}>{children}</span>;
}

function btnGhostStyle(color) {
  const c = color || PURPLE;
  return { padding: '5px 10px', background: 'transparent', color: c, border: `1px solid ${c}`, borderRadius: 5, fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' };
}
function btnPrimaryStyle(busy) {
  return { padding: '6px 14px', background: BRIGHT, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 };
}
