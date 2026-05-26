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
                'instructor_id, overall_status, current_step, checkr_status, stripe_payouts_enabled, background_check_source'
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
      // from "Send invite" to "Resend".
      const { data: fresh } = await supabase
        .from('contractor_onboarding_status')
        .select('instructor_id, overall_status, current_step, checkr_status, stripe_payouts_enabled, background_check_source')
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
    </div>
  );
}

function InstructorRow({ row, expanded, onToggle, onSendInvite, inviteBusy, inviteResult, onUploadBg }) {
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
  const inviteState =
    !row.is_active || isMinor || ['complete', 'declined', 'abandoned', 'pending_background_check', 'pending_stripe', 'payouts_disabled'].includes(status)
      ? null
      : status === 'not_invited' || !row.status
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

      {expanded && <InstructorDetail row={row} age={age} onUploadBg={onUploadBg} />}
    </div>
  );
}

function InstructorDetail({ row, age, onUploadBg }) {
  const sitePrefs = row.site_preferences?.districts ?? [];
  const dayDefaults = row.availability?.day_defaults ?? {};
  const activeDays = DAY_INITIALS.filter(([k]) => dayDefaults[k]).map(([, label]) => label);
  const cprExpired =
    row.first_aid_cpr_expires_at &&
    new Date(`${row.first_aid_cpr_expires_at}T00:00:00`) < new Date(new Date().toDateString());
  const checkr = row.status?.checkr_status;
  const bgSource = row.status?.background_check_source;

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: `1px solid ${RULE}`,
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
    </div>
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
    if (!lastName.trim()) return 'Last name is required.';
    const e = email.trim();
    if (!e) return 'Email is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'That email address does not look valid.';
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
