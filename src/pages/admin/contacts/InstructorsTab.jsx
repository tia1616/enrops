// Instructors tab for /admin/contacts. Lists everyone in the admin's org
// with the full picture: display name (preferred_name fallback to legal
// first_name), legal name, email, phone, contractor tier, onboarding
// status, date of birth (with age + minor flag), shirt size, site
// preferences, availability, CPR cert (expiry + link), emergency contacts.
//
// Each row is collapsed to a one-liner; click to expand and see everything.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { avatarUrl, isValidAvatarKey } from '../../../lib/avatars';
import { phoneIsValid, looksLikeName, emailIsValid } from '../../../lib/validation';

const PURPLE = '#1C004F';
const VIOLET = '#8C88FF';
const CREAM = '#FBFBFB';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const OK = '#3a7c3a';
const RED = '#b53737';
const AMBER = '#b67e00';

const STATUS_COLOR = {
  complete: OK,
  in_progress: PURPLE,
  pending_background_check: AMBER,
  pending_stripe: AMBER,
  payouts_disabled: RED,
  declined: RED,
  abandoned: MUTED,
  invited: MUTED,
  not_invited: MUTED,
};

const DAY_INITIALS = [
  ['monday', 'M'],
  ['tuesday', 'T'],
  ['wednesday', 'W'],
  ['thursday', 'Th'],
  ['friday', 'F'],
  ['saturday', 'Sa'],
  ['sunday', 'Su'],
];

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

function fmtDate(d) {
  if (!d) return null;
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function InstructorsTab({ org }) {
  const [rows, setRows] = useState(null); // null = loading
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState('');
  const [inviteBusyId, setInviteBusyId] = useState(null);
  const [inviteResult, setInviteResult] = useState({}); // { instructor_id: { type: 'ok'|'err', message } }
  const [bgUploadOpen, setBgUploadOpen] = useState(false);
  const [bgUploadInstructorId, setBgUploadInstructorId] = useState(null); // pre-selected when opened from a row
  const [addOpen, setAddOpen] = useState(false);
  const [removeRow, setRemoveRow] = useState(null);
  const [editingNameId, setEditingNameId] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: instructors, error: instErr } = await supabase
          .from('instructors')
          .select(
            `id, first_name, last_name, preferred_name, email, phone, is_active,
             contractor_tier, date_of_birth, shirt_size, photo_url,
             site_preferences, availability,
             first_aid_cpr_url, first_aid_cpr_expires_at`
          )
          .eq('organization_id', org.id)
          .order('last_name', { ascending: true, nullsFirst: false });
        if (instErr) throw instErr;
        if (cancelled) return;

        const ids = (instructors ?? []).map((i) => i.id);
        let statusMap = {};
        let contactsByInstructor = {};

        if (ids.length > 0) {
          const [{ data: statusRows }, { data: contactRows }] = await Promise.all([
            supabase
              .from('contractor_onboarding_status')
              .select(
                'instructor_id, overall_status, current_step, checkr_status, stripe_payouts_enabled, background_check_source, invited_at'
              )
              .in('instructor_id', ids),
            supabase
              .from('contractor_emergency_contacts')
              .select('instructor_id, contact_name, relationship, phone, is_primary')
              .in('instructor_id', ids)
              .order('is_primary', { ascending: false }),
          ]);
          for (const r of statusRows ?? []) statusMap[r.instructor_id] = r;
          for (const c of contactRows ?? []) {
            (contactsByInstructor[c.instructor_id] ??= []).push(c);
          }
        }

        if (!cancelled) {
          setRows(
            (instructors ?? []).map((i) => ({
              ...i,
              status: statusMap[i.id] ?? null,
              emergency_contacts: contactsByInstructor[i.id] ?? [],
            }))
          );
        }
      } catch (err) {
        console.error('[admin/contacts/instructors] load failed', err);
        if (!cancelled) setError(err.message ?? 'Failed to load instructors.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org?.id]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && !r.is_active) return false;
      if (!q) return true;
      const blob = [
        r.first_name,
        r.last_name,
        r.preferred_name,
        r.email,
        r.phone,
        r.contractor_tier,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [rows, search, showInactive]);

  function toggleExpand(id) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveName(instructorId, { first_name, last_name, preferred_name }) {
    const payload = {
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      preferred_name: preferred_name.trim() || null,
    };
    const { error: updErr } = await supabase
      .from('instructors')
      .update(payload)
      .eq('id', instructorId);
    if (updErr) throw updErr;
    setRows((rs) => (rs ?? []).map((r) => (r.id === instructorId ? { ...r, ...payload } : r)));
    setEditingNameId(null);
  }

  async function sendInvite(instructorId) {
    if (inviteBusyId) return;
    setInviteBusyId(instructorId);
    setInviteResult((s) => ({ ...s, [instructorId]: null }));
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('contractor-invite', {
        body: { instructor_id: instructorId },
      });
      if (fnErr || data?.error) {
        setInviteResult((s) => ({
          ...s,
          [instructorId]: { type: 'err', message: data?.error || fnErr?.message || 'Failed to send invite.' },
        }));
        return;
      }
      // Refresh this instructor's onboarding status so the button label flips
      // from "Send invite" to "Resend" — contractor-invite stamps invited_at.
      const { data: fresh } = await supabase
        .from('contractor_onboarding_status')
        .select('instructor_id, overall_status, current_step, checkr_status, stripe_payouts_enabled, background_check_source, invited_at')
        .eq('instructor_id', instructorId)
        .maybeSingle();
      if (fresh) {
        setRows((rs) => (rs ?? []).map((r) => (r.id === instructorId ? { ...r, status: fresh } : r)));
      }
      setInviteResult((s) => ({
        ...s,
        [instructorId]: { type: 'ok', message: 'Invite sent ✓' },
      }));
    } catch (err) {
      console.error('[admin/contacts] send invite failed', err);
      setInviteResult((s) => ({
        ...s,
        [instructorId]: { type: 'err', message: 'Something went wrong sending the invite.' },
      }));
    } finally {
      setInviteBusyId(null);
    }
  }

  if (error) {
    return (
      <div style={{ background: `${RED}1A`, color: RED, padding: 12, borderRadius: 6, fontSize: 13 }}>
        {error}
      </div>
    );
  }
  if (rows === null) {
    return <div style={{ color: MUTED, fontSize: 13 }}>Loading instructors…</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, phone"
          style={{
            flex: '1 1 220px',
            padding: '8px 12px',
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: 'inherit',
            background: '#fff',
            color: INK,
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: MUTED, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          style={{
            padding: '7px 12px',
            background: PURPLE,
            color: '#fff',
            border: `1px solid ${PURPLE}`,
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          + Add instructor
        </button>
        <button
          type="button"
          onClick={() => { setBgUploadInstructorId(null); setBgUploadOpen(true); }}
          style={{
            padding: '7px 12px',
            background: '#fff',
            color: PURPLE,
            border: `1px solid ${PURPLE}`,
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Upload prior BG check
        </button>
      </div>

      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
        {filtered.length} instructor{filtered.length === 1 ? '' : 's'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.length === 0 && (
          <div style={{ color: MUTED, fontSize: 13, padding: 14, background: '#fff', border: `1px solid ${RULE}`, borderRadius: 8 }}>
            No instructors match that search.
          </div>
        )}
        {filtered.map((r) => (
          <InstructorRow
            key={r.id}
            row={r}
            expanded={expanded.has(r.id)}
            onToggle={() => toggleExpand(r.id)}
            onSendInvite={() => sendInvite(r.id)}
            inviteBusy={inviteBusyId === r.id}
            inviteResult={inviteResult[r.id]}
            onUploadBg={() => { setBgUploadInstructorId(r.id); setBgUploadOpen(true); }}
            onRemove={() => setRemoveRow(r)}
            isEditingName={editingNameId === r.id}
            onStartEditName={() => { setExpanded((s) => new Set(s).add(r.id)); setEditingNameId(r.id); }}
            onCancelEditName={() => setEditingNameId(null)}
            onSaveName={(vals) => saveName(r.id, vals)}
          />
        ))}
      </div>

      {bgUploadOpen && (
        <BackgroundCheckUploadModal
          instructors={rows}
          initialInstructorId={bgUploadInstructorId}
          onClose={() => { setBgUploadOpen(false); setBgUploadInstructorId(null); }}
          onUploaded={(updatedRow) => {
            // Reflect the new status on the row immediately.
            if (updatedRow?.instructor_id) {
              setRows((rs) => (rs ?? []).map((r) => (r.id === updatedRow.instructor_id ? { ...r, status: updatedRow } : r)));
            }
          }}
        />
      )}

      {addOpen && (
        <AddInstructorModal
          org={org}
          onClose={() => setAddOpen(false)}
          onAdded={(newRow) => {
            // Prepend new instructor to the list with empty status + contacts
            // so it shows up immediately. The Send-invite call (if user picks
            // it) will refresh status afterwards.
            setRows((rs) => [
              { ...newRow, status: null, emergency_contacts: [] },
              ...(rs ?? []),
            ]);
          }}
        />
      )}

      {removeRow && (
        <RemoveInstructorModal
          row={removeRow}
          onClose={() => setRemoveRow(null)}
          onRemoved={(id, mode) => {
            if (mode === 'hard') {
              setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
            } else {
              // soft: flip is_active to false on the row so the UI dims it.
              // The 'Show inactive' toggle controls visibility.
              setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, is_active: false } : r)));
            }
          }}
        />
      )}
    </div>
  );
}

function InstructorRow({ row, expanded, onToggle, onSendInvite, inviteBusy, inviteResult, onUploadBg, onRemove, isEditingName, onStartEditName, onCancelEditName, onSaveName }) {
  const displayName =
    row.preferred_name?.trim() ||
    `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
    row.email;
  const legalName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  const hasPreferred = Boolean(row.preferred_name?.trim());
  const status = row.status?.overall_status ?? 'not_invited';
  const statusColor = STATUS_COLOR[status] ?? MUTED;
  const age = ageFromDob(row.date_of_birth);
  const isMinor = age !== null && age < 18;

  // Invite button visible for adults who haven't completed onboarding and
  // aren't in a terminal state. Hidden for minors (they don't go through
  // the wizard) and for complete/declined/abandoned/pending_* statuses.
  //
  // First-vs-Resend keys off contractor_onboarding_status.invited_at, the
  // ONLY column contractor-invite writes that nothing else writes. Don't
  // use auth_user_id (the magic-link self-signin path also creates that)
  // and don't use overall_status (admin BGC upload promotes it without
  // inviting). See feedback memory: UI state from artifacts, not status.
  const everInvited = Boolean(row.status?.invited_at);
  const inviteState =
    !row.is_active || isMinor || ['complete', 'declined', 'abandoned', 'pending_background_check', 'pending_stripe', 'payouts_disabled'].includes(status)
      ? null
      : !everInvited
      ? 'first'
      : 'resend';

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${RULE}`,
        borderLeft: `3px solid ${statusColor}`,
        borderRadius: 8,
        padding: '10px 14px',
        opacity: row.is_active ? 1 : 0.55,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        title={expanded ? 'Click to collapse' : 'Click to see full details'}
        style={{
          display: 'flex',
          width: '100%',
          gap: 12,
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <PhotoThumb url={row.photo_url} name={displayName} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK, lineHeight: 1.3, textDecoration: 'underline', textDecorationColor: RULE, textDecorationThickness: 1, textUnderlineOffset: 3 }}>
            {displayName}
            {hasPreferred && legalName && (
              <span style={{ color: MUTED, marginLeft: 6, fontSize: 12, fontWeight: 400 }}>
                ({legalName})
              </span>
            )}
            {isMinor && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#fff',
                  background: VIOLET,
                  padding: '1px 6px',
                  borderRadius: 4,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                Minor
              </span>
            )}
          </div>
          <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
            {row.email}
            {row.phone && <> · {row.phone}</>}
            {row.contractor_tier && <> · {row.contractor_tier}</>}
            {!row.is_active && <> · inactive</>}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: statusColor,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            whiteSpace: 'nowrap',
          }}
        >
          {status.replace(/_/g, ' ')}
        </span>
        <span style={{ color: PURPLE, fontSize: 14, fontWeight: 700 }}>{expanded ? '▾' : '▸'}</span>
      </button>

      {inviteState && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${RULE}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={onSendInvite}
            disabled={inviteBusy}
            style={{
              padding: '6px 12px',
              background: inviteState === 'first' ? PURPLE : 'transparent',
              color: inviteState === 'first' ? '#fff' : PURPLE,
              border: `1px solid ${PURPLE}`,
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: inviteBusy ? 'wait' : 'pointer',
              opacity: inviteBusy ? 0.6 : 1,
            }}
          >
            {inviteBusy
              ? 'Sending…'
              : inviteState === 'first'
              ? 'Send onboarding invite'
              : 'Resend invite'}
          </button>
          {inviteResult && (
            <span
              style={{
                fontSize: 12,
                color: inviteResult.type === 'ok' ? OK : RED,
              }}
            >
              {inviteResult.message}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <InstructorDetail
          row={row}
          age={age}
          onUploadBg={onUploadBg}
          onRemove={onRemove}
          isEditingName={isEditingName}
          onStartEditName={onStartEditName}
          onCancelEditName={onCancelEditName}
          onSaveName={onSaveName}
        />
      )}
    </div>
  );
}

function InstructorDetail({ row, age, onUploadBg, onRemove, isEditingName, onStartEditName, onCancelEditName, onSaveName }) {
  const sitePrefs = row.site_preferences?.districts ?? [];
  const dayDefaults = row.availability?.day_defaults ?? {};
  const activeDays = DAY_INITIALS.filter(([k]) => dayDefaults[k]).map(([, label]) => label);
  const cprExpired =
    row.first_aid_cpr_expires_at &&
    new Date(`${row.first_aid_cpr_expires_at}T00:00:00`) < new Date(new Date().toDateString());
  const checkr = row.status?.checkr_status;
  const bgSource = row.status?.background_check_source;

  return (
    <div>
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${RULE}`,
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 10,
        }}
      >
        {!isEditingName && onStartEditName && (
          <button
            type="button"
            onClick={onStartEditName}
            style={{
              background: 'transparent',
              border: 'none',
              color: PURPLE,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            Edit name →
          </button>
        )}
      </div>
      {isEditingName && (
        <EditNameForm row={row} onCancel={onCancelEditName} onSave={onSaveName} />
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
          fontSize: 13,
        }}
      >
      <DetailItem label="Date of birth">
        {row.date_of_birth ? (
          <>
            {fmtDate(row.date_of_birth)}
            {age !== null && (
              <span style={{ color: MUTED, marginLeft: 6 }}>(age {age})</span>
            )}
          </>
        ) : (
          <Em>not set</Em>
        )}
      </DetailItem>
      <DetailItem label="Unisex shirt size">
        {row.shirt_size ?? <Em>not set</Em>}
      </DetailItem>
      <DetailItem label="Background check">
        {checkr ? (
          <>
            {checkr}
            {bgSource === 'admin_uploaded' && (
              <span style={{ color: MUTED, marginLeft: 6 }}>(admin uploaded)</span>
            )}
          </>
        ) : (
          <Em>not started</Em>
        )}
        {onUploadBg && (
          <button
            type="button"
            onClick={onUploadBg}
            style={{
              display: 'block',
              marginTop: 4,
              background: 'transparent',
              border: 'none',
              color: PURPLE,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            {checkr === 'clear' ? 'Replace BG report →' : 'Upload prior BG report →'}
          </button>
        )}
      </DetailItem>
      <DetailItem label="Stripe payouts">
        {row.status?.stripe_payouts_enabled ? 'enabled' : <Em>not enabled</Em>}
      </DetailItem>
      <DetailItem label="Districts">
        {sitePrefs.length > 0 ? sitePrefs.join(', ') : <Em>none selected</Em>}
      </DetailItem>
      <DetailItem label="Days available">
        {activeDays.length > 0 ? activeDays.join(', ') : <Em>none selected</Em>}
      </DetailItem>
      <DetailItem label="First Aid / CPR">
        {row.first_aid_cpr_url ? (
          <>
            on file
            {row.first_aid_cpr_expires_at && (
              <span style={{ color: cprExpired ? RED : MUTED, marginLeft: 6 }}>
                · expires {fmtDate(row.first_aid_cpr_expires_at)}
                {cprExpired && ' (expired)'}
              </span>
            )}
          </>
        ) : (
          <Em>not uploaded</Em>
        )}
      </DetailItem>
      <DetailItem label="Onboarding step">
        {row.status?.current_step ? `Step ${row.status.current_step} of 8` : <Em>not started</Em>}
      </DetailItem>

      {row.emergency_contacts.length > 0 && (
        <div style={{ gridColumn: '1 / -1', borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: MUTED,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            Emergency contacts
          </div>
          {row.emergency_contacts.map((c, i) => (
            <div key={i} style={{ fontSize: 13, color: INK, marginBottom: 4 }}>
              {c.is_primary && (
                <span
                  style={{
                    fontSize: 9,
                    color: PURPLE,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    marginRight: 6,
                  }}
                >
                  Primary
                </span>
              )}
              <strong>{c.contact_name}</strong> ({c.relationship}) · {c.phone}
            </div>
          ))}
        </div>
      )}

      {row.is_active && onRemove && (
        <div style={{ gridColumn: '1 / -1', borderTop: `1px solid ${RULE}`, paddingTop: 10, marginTop: 4 }}>
          <button
            type="button"
            onClick={onRemove}
            style={{
              background: 'transparent',
              border: 'none',
              color: RED,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            Remove this instructor →
          </button>
        </div>
      )}
      </div>
    </div>
  );
}

function EditNameForm({ row, onCancel, onSave }) {
  const [firstName, setFirstName] = useState(row.first_name ?? '');
  const [lastName, setLastName] = useState(row.last_name ?? '');
  const [preferred, setPreferred] = useState(row.preferred_name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const firstValid = looksLikeName(firstName);
  const lastValid = looksLikeName(lastName);
  const canSave = firstValid && lastValid && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ first_name: firstName, last_name: lastName, preferred_name: preferred });
    } catch (e2) {
      console.error('[admin/contacts] save name failed', e2);
      setErr(e2?.message ?? 'Could not save name.');
      setBusy(false);
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '6px 10px',
    border: `1px solid ${RULE}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    background: '#fff',
    color: INK,
  };
  const labelStyle = { fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, display: 'block' };

  return (
    <form
      onSubmit={submit}
      style={{
        background: CREAM,
        border: `1px solid ${RULE}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 10,
      }}
    >
      <div>
        <label style={labelStyle}>Legal first name</label>
        <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} style={inputStyle} autoFocus />
      </div>
      <div>
        <label style={labelStyle}>Legal last name</label>
        <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} style={inputStyle} />
      </div>
      <div>
        <label style={labelStyle}>Preferred name <span style={{ color: MUTED, fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
        <input type="text" value={preferred} onChange={(e) => setPreferred(e.target.value)} style={inputStyle} placeholder={row.first_name ?? ''} />
      </div>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
        <button
          type="submit"
          disabled={!canSave}
          style={{
            padding: '6px 14px',
            background: canSave ? PURPLE : '#bbb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: canSave ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Saving…' : 'Save name'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{
            padding: '6px 12px',
            background: 'transparent',
            color: MUTED,
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
        {!firstValid && firstName.length > 0 && <span style={{ color: RED, fontSize: 12 }}>First name looks invalid.</span>}
        {!lastValid && lastName.length > 0 && <span style={{ color: RED, fontSize: 12 }}>Last name looks invalid.</span>}
        {err && <span style={{ color: RED, fontSize: 12 }}>{err}</span>}
      </div>
    </form>
  );
}

function PhotoThumb({ url, name }) {
  // instructors.photo_url stores an avatar key (e.g. "bottts-1") since
  // portal v1, not a URL. Resolve via avatarUrl(). Falls back to initials
  // if the key is missing/invalid (instructor hasn't picked yet).
  const initials = (name ?? '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  if (isValidAvatarKey(url)) {
    return (
      <img
        src={avatarUrl(url)}
        alt=""
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: '#FBFBFB',
        color: PURPLE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function DetailItem({ label, children }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ color: INK }}>{children}</div>
    </div>
  );
}

function Em({ children }) {
  return <span style={{ color: MUTED, fontStyle: 'italic' }}>{children}</span>;
}

// Modal for the admin BG-check upload flow. Replaces the standalone
// /admin/contractors/background-check-upload page so the affordance lives
// inside the Instructors tab where it belongs IA-wise.
function BackgroundCheckUploadModal({ instructors, initialInstructorId, onClose, onUploaded }) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(initialInstructorId || '');
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [completedOn, setCompletedOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { type: 'ok'|'err', message }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return instructors;
    return instructors.filter((i) => {
      const blob = `${i.first_name ?? ''} ${i.last_name ?? ''} ${i.preferred_name ?? ''} ${i.email ?? ''}`.toLowerCase();
      return blob.includes(q);
    });
  }, [instructors, search]);

  const selected = instructors.find((i) => i.id === selectedId);

  function onFileChange(e) {
    const f = e.target.files?.[0];
    setFileError('');
    if (!f) { setFile(null); return; }
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setFileError('File must be a PDF.');
      setFile(null);
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setFileError('PDF must be 10MB or smaller.');
      setFile(null);
      return;
    }
    setFile(f);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !selected || !file || !completedOn) return;
    setBusy(true);
    setResult(null);
    try {
      const path = `${selected.id}/bg_check_uploaded_${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('contractor-documents')
        .upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (upErr) {
        setResult({ type: 'err', message: `Upload failed: ${upErr.message}` });
        setBusy(false);
        return;
      }

      const { data, error: fnErr } = await supabase.functions.invoke('admin-upload-background-check', {
        body: { instructor_id: selected.id, file_url: path, completed_on: completedOn },
      });
      if (fnErr || data?.error) {
        setResult({ type: 'err', message: data?.error || fnErr?.message || "Couldn't save the background check." });
        setBusy(false);
        return;
      }

      // Refresh this row's status so the badge flips immediately.
      const { data: fresh } = await supabase
        .from('contractor_onboarding_status')
        .select('instructor_id, checkr_status, overall_status, background_check_source')
        .eq('instructor_id', selected.id)
        .single();
      if (fresh && onUploaded) onUploaded(fresh);

      setResult({ type: 'ok', message: `Cleared ${selected.first_name} ${selected.last_name} ✓` });
      // Auto-close after a brief delay so user sees the success.
      setTimeout(() => { onClose && onClose(); }, 1200);
    } catch (err) {
      console.error('[BgUploadModal] failed', err);
      setResult({ type: 'err', message: 'Something went wrong. Please try again.' });
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        zIndex: 100,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          width: '100%',
          maxWidth: 520,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>Upload prior background check</h2>
            <p style={{ color: MUTED, fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
              Marks an instructor as cleared without going through Checkr — for contractors who already have a valid report on file.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, display: 'block', marginBottom: 4 }}>
            Instructor
          </label>
          {selected ? (
            <div style={{ padding: 10, background: CREAM, borderRadius: 6, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                <strong>{selected.first_name} {selected.last_name}</strong>
                <span style={{ color: MUTED, marginLeft: 8 }}>{selected.email}</span>
              </span>
              <button
                type="button"
                onClick={() => setSelectedId('')}
                style={{ background: 'transparent', border: 'none', color: PURPLE, fontSize: 11, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or email"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: `1px solid ${RULE}`,
                  borderRadius: 6,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  background: '#fff',
                  color: INK,
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${RULE}`, borderRadius: 6, marginTop: 6 }}>
                {filtered.length === 0 && (
                  <div style={{ padding: 10, color: MUTED, fontSize: 12 }}>No matches.</div>
                )}
                {filtered.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => setSelectedId(i.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${RULE}`,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 13,
                    }}
                  >
                    {i.first_name} {i.last_name}
                    <span style={{ color: MUTED, marginLeft: 6, fontSize: 11 }}>{i.email}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div style={{ marginTop: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, display: 'block', marginBottom: 4 }}>
              Report PDF
            </label>
            <input type="file" accept="application/pdf,.pdf" onChange={onFileChange} style={{ fontSize: 13 }} />
            {file && (
              <div style={{ color: MUTED, fontSize: 11, marginTop: 4 }}>
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </div>
            )}
            {fileError && <div style={{ color: RED, fontSize: 11, marginTop: 4 }}>{fileError}</div>}
          </div>

          <div style={{ marginTop: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, display: 'block', marginBottom: 4 }}>
              Date of original check
            </label>
            <input
              type="date"
              value={completedOn}
              onChange={(e) => setCompletedOn(e.target.value)}
              style={{
                padding: '8px 12px',
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                fontSize: 13,
                fontFamily: 'inherit',
                width: 180,
              }}
            />
          </div>

          {result && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                background: result.type === 'ok' ? `${OK}1A` : `${RED}1A`,
                color: result.type === 'ok' ? OK : RED,
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              {result.message}
            </div>
          )}

          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                color: MUTED,
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !selected || !file || !completedOn}
              style={{
                padding: '8px 16px',
                background: PURPLE,
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: busy ? 'wait' : 'pointer',
                opacity: busy || !selected || !file || !completedOn ? 0.5 : 1,
              }}
            >
              {busy ? 'Saving…' : 'Mark as cleared'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Modal for manually adding an instructor row. Two phases:
//   1. Form — collect first/last/email/phone/tier, insert row.
//   2. Confirm — after insert, ask "Send onboarding invite now?" with
//      Yes / Not now buttons. Yes fires contractor-invite then closes.
// Direct insert via supabase client; RLS policy org_admins_write_instructors
// gates this to owners + admins. No edge function needed.
function AddInstructorModal({ org, onClose, onAdded }) {
  const [phase, setPhase] = useState('form'); // 'form' | 'invite'
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [tier, setTier] = useState(''); // '' = not set, 'lead', 'developing'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdInstructor, setCreatedInstructor] = useState(null); // { id, first_name, last_name, email }
  const [inviteResult, setInviteResult] = useState(null); // { type, message }

  function validateForm() {
    if (!firstName.trim()) return 'First name is required.';
    if (!looksLikeName(firstName)) return "That doesn't look like a first name.";
    if (!lastName.trim()) return 'Last name is required.';
    if (!looksLikeName(lastName)) return "That doesn't look like a last name.";
    if (!email.trim()) return 'Email is required.';
    if (!emailIsValid(email)) return 'That email address does not look valid.';
    if (phone.trim() && !phoneIsValid(phone)) return 'That phone number does not look valid.';
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    const v = validateForm();
    if (v) { setError(v); return; }
    if (!org?.id) { setError('No organization context.'); return; }

    setBusy(true);
    try {
      const { data, error: insErr } = await supabase
        .from('instructors')
        .insert({
          organization_id: org.id,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim() || null,
          contractor_tier: tier || null,
          is_active: true,
        })
        .select('id, first_name, last_name, preferred_name, email, phone, is_active, contractor_tier, date_of_birth, shirt_size, photo_url, site_preferences, availability, first_aid_cpr_url, first_aid_cpr_expires_at')
        .single();

      if (insErr) {
        if (insErr.code === '23505') {
          // UNIQUE (organization_id, email)
          setError('An instructor with that email already exists in this org.');
        } else if (/permission denied|policy/i.test(insErr.message ?? '')) {
          setError('You do not have permission to add instructors.');
        } else {
          setError(insErr.message || 'Failed to add the instructor.');
        }
        setBusy(false);
        return;
      }

      if (onAdded) onAdded(data);
      setCreatedInstructor(data);
      setPhase('invite');
      setBusy(false);
    } catch (err) {
      console.error('[AddInstructorModal] insert failed', err);
      setError('Something went wrong adding the instructor.');
      setBusy(false);
    }
  }

  async function handleSendInvite() {
    if (!createdInstructor) return;
    setBusy(true);
    setInviteResult(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('contractor-invite', {
        body: { instructor_id: createdInstructor.id },
      });
      if (fnErr || data?.error) {
        setInviteResult({
          type: 'err',
          message: data?.error || fnErr?.message || 'Failed to send the invite.',
        });
        setBusy(false);
        return;
      }
      setInviteResult({ type: 'ok', message: 'Invite sent ✓' });
      setTimeout(() => { onClose && onClose(); }, 1200);
    } catch (err) {
      console.error('[AddInstructorModal] invite failed', err);
      setInviteResult({ type: 'err', message: 'Something went wrong sending the invite.' });
      setBusy(false);
    }
  }

  const displayName = createdInstructor
    ? `${createdInstructor.first_name} ${createdInstructor.last_name}`.trim()
    : '';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        zIndex: 100,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          width: '100%',
          maxWidth: 520,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
              {phase === 'form' ? 'Add instructor' : `${displayName} added`}
            </h2>
            <p style={{ color: MUTED, fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
              {phase === 'form'
                ? 'Creates the contractor record. You can send their onboarding invite right after, or do it later from the row.'
                : 'Send the onboarding invite now? You can always do it later from the instructor row.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {phase === 'form' && (
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="First name" required>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoFocus
                  style={inputStyle}
                />
              </Field>
              <Field label="Last name" required>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div style={{ marginTop: 12 }}>
              <Field label="Email" required>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Phone">
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(optional)"
                  style={inputStyle}
                />
              </Field>
              <Field label="Tier">
                <select
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Not set</option>
                  <option value="lead">Lead</option>
                  <option value="developing">Developing</option>
                </select>
              </Field>
            </div>

            {error && (
              <div
                style={{
                  marginTop: 14,
                  padding: 10,
                  background: `${RED}1A`,
                  color: RED,
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  padding: '8px 14px',
                  background: 'transparent',
                  color: MUTED,
                  border: `1px solid ${RULE}`,
                  borderRadius: 6,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                style={{
                  padding: '8px 16px',
                  background: PURPLE,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy ? 0.5 : 1,
                }}
              >
                {busy ? 'Adding…' : 'Add instructor'}
              </button>
            </div>
          </form>
        )}

        {phase === 'invite' && (
          <div>
            <div style={{ padding: 10, background: CREAM, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
              <strong>{displayName}</strong>
              <span style={{ color: MUTED, marginLeft: 8 }}>{createdInstructor?.email}</span>
            </div>

            {inviteResult && (
              <div
                style={{
                  marginBottom: 14,
                  padding: 10,
                  background: inviteResult.type === 'ok' ? `${OK}1A` : `${RED}1A`,
                  color: inviteResult.type === 'ok' ? OK : RED,
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                {inviteResult.message}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  padding: '8px 14px',
                  background: 'transparent',
                  color: MUTED,
                  border: `1px solid ${RULE}`,
                  borderRadius: 6,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Not now
              </button>
              <button
                type="button"
                onClick={handleSendInvite}
                disabled={busy || inviteResult?.type === 'ok'}
                style={{
                  padding: '8px 16px',
                  background: PURPLE,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy || inviteResult?.type === 'ok' ? 0.5 : 1,
                }}
              >
                {busy ? 'Sending…' : 'Send onboarding invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  background: '#fff',
  color: INK,
  boxSizing: 'border-box',
};

function Field({ label, required, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          display: 'block',
          marginBottom: 4,
        }}
      >
        {label}
        {required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
      </span>
      {children}
    </label>
  );
}

// Modal for removing an instructor. Decides automatically between two
// modes:
//   • soft (deactivate): is_active = false. Used whenever the instructor
//     has any real history with the org — signed legal docs, confirmed
//     camp assignments, or session deliveries. Preserves pay + compliance
//     trail. Reversible via the existing "Show inactive" toggle.
//   • hard (delete): full cascade delete of the row + light cleanup
//     tables (emergency_contacts, availability, prefs, onboarding_status).
//     Only available when ALL of the following are zero:
//       - contractor_acknowledgments
//       - contractor_agreements
//       - contractor_ors_certification
//       - camp_assignments
//       - session_delivery_confirmations
//     AND overall_status is null / 'not_invited' / 'invited' / 'in_progress'.
//     Auth user (auth.users) is NOT touched — they may be linked to a
//     parent record etc. The cascade is best-effort on the cleanup tables
//     (no-ops if rows don't exist) and required on the instructors row.
function RemoveInstructorModal({ row, onClose, onRemoved }) {
  const [counts, setCounts] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tables = [
          'camp_assignments',
          'contractor_agreements',
          'contractor_acknowledgments',
          'contractor_ors_certification',
          'session_delivery_confirmations',
        ];
        const results = await Promise.all(
          tables.map((t) =>
            supabase.from(t).select('*', { count: 'exact', head: true }).eq('instructor_id', row.id)
          )
        );
        if (cancelled) return;
        const c = {};
        tables.forEach((t, i) => { c[t] = results[i].count ?? 0; });
        setCounts(c);
      } catch (err) {
        if (!cancelled) setError('Could not check this instructor’s history. Try again.');
        console.error('[RemoveInstructorModal] count load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [row.id]);

  const onboardingProgress = row.status?.overall_status ?? null;
  const onboardingIsTerminalOrComplete =
    onboardingProgress &&
    !['not_invited', 'invited', 'in_progress'].includes(onboardingProgress);

  const hasAnyHistory =
    counts &&
    (
      counts.camp_assignments > 0 ||
      counts.contractor_agreements > 0 ||
      counts.contractor_acknowledgments > 0 ||
      counts.contractor_ors_certification > 0 ||
      counts.session_delivery_confirmations > 0 ||
      onboardingIsTerminalOrComplete
    );

  const mode = counts ? (hasAnyHistory ? 'soft' : 'hard') : null;

  async function handleConfirm() {
    if (busy || !mode) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'soft') {
        const { error: updErr } = await supabase
          .from('instructors')
          .update({ is_active: false })
          .eq('id', row.id);
        if (updErr) throw updErr;
        if (onRemoved) onRemoved(row.id, 'soft');
        onClose && onClose();
      } else {
        // Hard delete cascade. Order: light tables first (FK to
        // instructors), then the instructors row itself. Each delete is
        // best-effort — if the row doesn't exist for a given table, the
        // .eq() filter just no-ops with 0 rows affected.
        const cascadeTables = [
          'contractor_emergency_contacts',
          'contractor_onboarding_status',
          'instructor_availability',
          'instructor_location_preferences',
          'instructor_curriculum_preferences',
        ];
        for (const t of cascadeTables) {
          const { error: delErr } = await supabase.from(t).delete().eq('instructor_id', row.id);
          if (delErr) {
            console.warn(`[RemoveInstructorModal] cascade delete ${t} failed (non-fatal)`, delErr);
          }
        }
        const { error: rowErr } = await supabase.from('instructors').delete().eq('id', row.id);
        if (rowErr) throw rowErr;
        if (onRemoved) onRemoved(row.id, 'hard');
        onClose && onClose();
      }
    } catch (err) {
      console.error('[RemoveInstructorModal] remove failed', err);
      if (/permission denied|policy/i.test(err.message ?? '')) {
        setError('You do not have permission to remove instructors.');
      } else {
        setError(err.message || 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  const displayName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || row.email;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        zIndex: 100,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          width: '100%',
          maxWidth: 480,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
            Remove {displayName}?
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {counts === null && !error && (
          <div style={{ color: MUTED, fontSize: 13 }}>Checking their history…</div>
        )}

        {error && (
          <div
            style={{
              padding: 10,
              background: `${RED}1A`,
              color: RED,
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}

        {counts && mode === 'soft' && (
          <>
            <p style={{ fontSize: 13, color: INK, lineHeight: 1.5, marginTop: 0 }}>
              They&rsquo;ll be hidden from your active list. Their record stays so your pay and compliance trail is intact. You can reactivate them anytime from the <strong>Show inactive</strong> view.
            </p>
            <div style={{ background: CREAM, padding: 12, borderRadius: 6, fontSize: 12, color: INK, marginTop: 10 }}>
              <div style={{ fontWeight: 700, color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                What we&rsquo;re preserving
              </div>
              <HistoryLine n={counts.camp_assignments} label="camp assignment" />
              <HistoryLine n={counts.session_delivery_confirmations} label="session taught" />
              <HistoryLine n={counts.contractor_agreements} label="signed agreement" />
              <HistoryLine n={counts.contractor_acknowledgments} label="acknowledgment" />
              <HistoryLine n={counts.contractor_ors_certification} label="ORS certification" />
              {onboardingIsTerminalOrComplete && (
                <div style={{ marginBottom: 3 }}>
                  Onboarding status: <strong>{onboardingProgress.replace(/_/g, ' ')}</strong>
                </div>
              )}
            </div>
          </>
        )}

        {counts && mode === 'hard' && (
          <>
            <p style={{ fontSize: 13, color: INK, lineHeight: 1.5, marginTop: 0 }}>
              <strong>{displayName}</strong> has no history with you — no assignments, no signed docs, no completed onboarding.
            </p>
            <p style={{ fontSize: 13, color: RED, lineHeight: 1.5, marginTop: 8 }}>
              Their record will be deleted completely. <strong>This can&rsquo;t be undone.</strong>
            </p>
          </>
        )}

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: MUTED,
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || !mode}
            style={{
              padding: '8px 16px',
              background: mode === 'hard' ? RED : PURPLE,
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: busy ? 'wait' : 'pointer',
              opacity: busy || !mode ? 0.5 : 1,
            }}
          >
            {busy
              ? 'Removing…'
              : mode === 'hard'
              ? 'Delete permanently'
              : mode === 'soft'
              ? 'Deactivate'
              : 'Checking…'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryLine({ n, label }) {
  if (!n) return null;
  return (
    <div style={{ marginBottom: 3 }}>
      {n} {label}{n === 1 ? '' : 's'}
    </div>
  );
}
