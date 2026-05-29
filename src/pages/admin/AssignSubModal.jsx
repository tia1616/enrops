// AssignSubModal — admin assigns a single-day substitute for a camp or
// afterschool session. Calls create-assignment-substitution which UPSERTs
// the row and sends the sub an Ennie-voiced offer email.
//
// Resent state: when the operator re-opens the modal for a day that already
// has a sub assigned + emailed, the submit button shows "Resend offer to X".
// The transition keys off assignment_substitutions.email_sent_at — the only
// column the edge fn ever writes on the offer-send path. Per the
// feedback_ui_state_artifacts rule.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const CORAL = '#b53737';
const OK_GREEN = '#3a7c3a';

function fmtDate(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function shortName(i) {
  if (!i) return '—';
  return i.preferred_name || `${i.first_name ?? ''} ${i.last_name ?? ''}`.trim() || 'Unknown';
}

const STATUS_LABEL = {
  pending: 'Offered, waiting',
  confirmed: 'Accepted',
  declined: 'Declined',
  taught: 'Taught',
  missed: 'Missed',
};

export default function AssignSubModal({
  parentAssignment,           // { id, instructor_id, role }
  parentType,                 // 'camp' | 'program'
  sessionInfo,                // { curriculum_name, location_name, starts_on, ends_on, week_num } for camp; or { curriculum, school_name, first_session_date } for program
  defaultDate,                // YYYY-MM-DD; pre-fills the date input when admin clicked a specific day-tile
  organizationId,
  instructors,                // full instructor list for the org
  onClose,
  onSubmitted,                // (substitutionId) => void
}) {
  const [date, setDate] = useState(defaultDate ?? '');
  const [subInstructorId, setSubInstructorId] = useState('');
  const [subTier, setSubTier] = useState(parentAssignment?.role ?? 'lead');
  const [notes, setNotes] = useState('');
  const [existingSubs, setExistingSubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');

  const minDate = parentType === 'camp' ? sessionInfo?.starts_on : sessionInfo?.first_session_date;
  const maxDate = parentType === 'camp' ? sessionInfo?.ends_on   : null;

  // Eligible subs = everyone in the org except the parent's regular instructor.
  const eligible = useMemo(() => {
    return (instructors ?? [])
      .filter((i) => i.id !== parentAssignment?.instructor_id)
      .sort((a, b) => shortName(a).localeCompare(shortName(b)));
  }, [instructors, parentAssignment?.instructor_id]);

  // Load existing subs for this parent assignment so we can show the day
  // list + flip the submit-button label to "Resend" when applicable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!parentAssignment?.id) { setLoading(false); return; }
      const { data, error } = await supabase
        .from('assignment_substitutions')
        .select('id, date, sub_instructor_id, sub_tier, status, email_sent_at, declined_at')
        .eq('parent_assignment_id', parentAssignment.id)
        .eq('parent_assignment_type', parentType)
        .order('date', { ascending: true });
      if (cancelled) return;
      if (error) { setErr(error.message); setLoading(false); return; }
      setExistingSubs(data ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [parentAssignment?.id, parentType]);

  // Is the (date, sub) combo a resend? Keyed off email_sent_at on the
  // matching existing row.
  const existingForDate = existingSubs.find((s) => s.date === date);
  const isResend = !!(
    existingForDate &&
    existingForDate.sub_instructor_id === subInstructorId &&
    existingForDate.email_sent_at
  );
  // Is this swapping a different sub onto a day that already had one?
  const isSwap = !!(
    existingForDate &&
    existingForDate.sub_instructor_id !== subInstructorId &&
    subInstructorId
  );

  const chosenSub = eligible.find((i) => i.id === subInstructorId);
  const submitLabel = !subInstructorId || !date
    ? 'Send offer'
    : isResend
      ? `Resend offer to ${shortName(chosenSub)}`
      : isSwap
        ? `Swap to ${shortName(chosenSub)}`
        : `Send offer to ${shortName(chosenSub)}`;

  async function submit() {
    setErr(''); setOkMsg(''); setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-assignment-substitution`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            parent_assignment_id: parentAssignment.id,
            parent_assignment_type: parentType,
            date,
            sub_instructor_id: subInstructorId,
            sub_tier: subTier,
            notes: notes.trim() || undefined,
          }),
        },
      );
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.detail || data.error || 'Could not send the offer.');
        setBusy(false);
        return;
      }
      setOkMsg(`Offer sent to ${data.recipient}.`);
      onSubmitted?.(data.substitution_id);
      // Re-load the existing list so the day appears with email_sent_at set.
      const { data: refreshed } = await supabase
        .from('assignment_substitutions')
        .select('id, date, sub_instructor_id, sub_tier, status, email_sent_at, declined_at')
        .eq('parent_assignment_id', parentAssignment.id)
        .eq('parent_assignment_type', parentType)
        .order('date', { ascending: true });
      setExistingSubs(refreshed ?? []);
      setBusy(false);
    } catch (e) {
      setErr(e.message || 'Could not send the offer.');
      setBusy(false);
    }
  }

  const sessionTitle = parentType === 'camp'
    ? `${sessionInfo?.curriculum_name ?? 'Camp'} · ${sessionInfo?.location_name ?? ''}${sessionInfo?.week_num ? ` · Week ${sessionInfo.week_num}` : ''}`
    : `${sessionInfo?.curriculum ?? 'Program'} · ${sessionInfo?.school_name ?? ''}`;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 10, width: '100%', maxWidth: 520, maxHeight: '90vh',
        overflow: 'auto', boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
      }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>
            Assign a sub
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK }}>{sessionTitle}</div>
        </div>

        <div style={{ padding: '14px 20px' }}>
          {loading ? (
            <div style={{ fontSize: 14, color: MUTED, padding: '12px 0' }}>Loading existing subs…</div>
          ) : existingSubs.length > 0 && (
            <div style={{ marginBottom: 16, padding: 12, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                Already covered
              </div>
              {existingSubs.map((s) => {
                const subInst = (instructors ?? []).find((i) => i.id === s.sub_instructor_id);
                return (
                  <div key={s.id} style={{ fontSize: 13, color: INK, padding: '4px 0' }}>
                    <strong>{fmtDate(s.date)}</strong> — {shortName(subInst)} · {s.sub_tier} · <span style={{ color: s.status === 'declined' ? CORAL : (s.status === 'confirmed' || s.status === 'taught' ? OK_GREEN : MUTED) }}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  </div>
                );
              })}
            </div>
          )}

          <Field label="Date">
            <div style={{ ...inputStyle, background: CREAM, color: INK, display: "flex", alignItems: "center" }}>
              {date ? fmtDate(date) : <span style={{ color: MUTED }}>Open the modal from a day tile to set the date.</span>}
            </div>
          </Field>

          <Field label="Sub instructor">
            <select
              value={subInstructorId}
              onChange={(e) => setSubInstructorId(e.target.value)}
              style={inputStyle}
            >
              <option value="">— Pick a sub —</option>
              {eligible.map((i) => (
                <option key={i.id} value={i.id}>{shortName(i)}{i.email ? ` · ${i.email}` : ''}</option>
              ))}
            </select>
          </Field>

          <Field label="Role for this day">
            <select value={subTier} onChange={(e) => setSubTier(e.target.value)} style={inputStyle}>
              <option value="lead">Lead</option>
              <option value="developing">Developing</option>
            </select>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Defaults to the regular instructor's role. Adjust if the sub is filling a different slot.
            </div>
          </Field>

          <Field label="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="e.g. parking is tight today; check in at the front office first"
              style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            />
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Included in the offer email and visible on the day in their portal.
            </div>
          </Field>

          {err && (
            <div style={{ marginTop: 10, padding: 10, background: '#fdecec', border: `1px solid ${CORAL}`, borderRadius: 6, color: CORAL, fontSize: 13 }}>
              {err}
            </div>
          )}
          {okMsg && (
            <div style={{ marginTop: 10, padding: 10, background: '#ecf6ec', border: `1px solid ${OK_GREEN}`, borderRadius: 6, color: OK_GREEN, fontSize: 13 }}>
              {okMsg}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: `1px solid ${RULE}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} disabled={busy} style={btnSecondary}>Close</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !date || !subInstructorId}
            style={{ ...btnPrimary, opacity: (busy || !date || !subInstructorId) ? 0.5 : 1 }}
          >
            {busy ? 'Sending…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  background: '#fff',
  color: INK,
  boxSizing: 'border-box',
};

const btnPrimary = {
  background: PURPLE,
  color: '#fff',
  border: `1px solid ${PURPLE}`,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  cursor: 'pointer',
};

const btnSecondary = {
  background: 'transparent',
  color: MUTED,
  border: `1px solid ${RULE}`,
  padding: '8px 14px',
  fontSize: 13,
  borderRadius: 6,
  cursor: 'pointer',
};
