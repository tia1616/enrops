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
const BRIGHT = '#5847C9';   // indigo - primary actions (Figma)
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

// Why an instructor is already working that date (RPC working_reason).
const WORKING_LABEL = {
  teaching: 'already teaching an after-school class that day',
  camp: 'already at a camp that day',
  subbing: 'already subbing that day',
};

// Three display groups, best first:
//   SUGGEST - availability matches this day & time and they're free (the picks)
//   OTHER   - free, but not an exact match (no survey / wrong time / wrong day)
//   OUT     - marked this day off, or already working
const SUGGEST = 0, OTHER = 1, OUT = 2;
const GROUP_META = {
  [SUGGEST]: { label: 'Available — matches this day & time', color: '#3a7c3a' },
  [OTHER]:   { label: 'Other instructors',                        color: '#6b6b6b' },
  [OUT]:     { label: 'Marked off or already working',            color: '#b53737' },
};

// Map one instructor's availability signal to a group + a fine sort rank +
// the note to show under their name. av is undefined until the date loads.
function classify(av) {
  if (!av) return { group: OTHER, rank: 1, note: null };            // no signal yet
  if (av.is_working) {
    return { group: OUT, rank: 6, note: WORKING_LABEL[av.working_reason] ?? 'already working that day' };
  }
  if (av.is_date_off) {
    return { group: OUT, rank: 5, note: 'marked this day off' };
  }
  switch (av.day_time_match) {
    case 'match': return { group: SUGGEST, rank: 0, note: null };
    case 'time':  return { group: OTHER, rank: 2, note: 'not available at this class time' };
    case 'day':   return { group: OTHER, rank: 3, note: 'usually off that day' };
    default:      return { group: OTHER, rank: 1, note: 'no availability on file' };   // 'none'
  }
}

export default function AssignSubModal({
  parentAssignment,           // { id, instructor_id, role }
  parentType,                 // 'camp' | 'program'
  sessionInfo,                // { curriculum_name, location_name, starts_on, ends_on, week_num } for camp; or { curriculum, school_name, first_session_date } for program
  defaultDate,                // YYYY-MM-DD; pre-fills the date input when admin clicked a specific day-tile
  availableDates,             // optional string[] of valid class dates — renders a date picker (afterschool, which has no day-tiles)
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
  // Availability signals for the chosen date, keyed by instructor id. Only
  // flagged instructors appear here; anyone absent is free that day. Loaded
  // from the sub_availability_on_date RPC whenever the date changes.
  const [availability, setAvailability] = useState({});
  const [availLoading, setAvailLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);   // "show everyone" override

  const minDate = parentType === 'camp' ? sessionInfo?.starts_on : sessionInfo?.first_session_date;
  const maxDate = parentType === 'camp' ? sessionInfo?.ends_on   : null;

  // Eligible subs = everyone in the org except the parent's regular instructor.
  const eligible = useMemo(() => {
    return (instructors ?? [])
      .filter((i) => i.id !== parentAssignment?.instructor_id)
      .sort((a, b) => shortName(a).localeCompare(shortName(b)));
  }, [instructors, parentAssignment?.instructor_id]);

  // Rank by availability match: exact day+time matches first, then other free
  // instructors, then marked-off / already-working; alpha within each rank.
  // Availability is empty until a date is chosen, so this is a plain alpha list
  // up front (everyone lands in OTHER with no note).
  const ranked = useMemo(() => {
    return eligible
      .map((i) => {
        const av = availability[i.id];
        const c = classify(av);
        return { instr: i, av, ...c, outOfArea: !!av?.out_of_area };
      })
      .sort((a, b) => a.rank - b.rank || shortName(a.instr).localeCompare(shortName(b.instr)));
  }, [eligible, availability]);

  const grouped = useMemo(() => {
    const g = { [SUGGEST]: [], [OTHER]: [], [OUT]: [] };
    ranked.forEach((r) => g[r.group].push(r));
    return g;
  }, [ranked]);

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

  // Load availability signals for the chosen date. Ranks free instructors up
  // and flags conflicts; never hard-hides (sub pools are small). Re-runs on
  // every date change so a swap to a different day re-checks.
  useEffect(() => {
    let cancelled = false;
    if (!date || !organizationId || !parentAssignment?.id) {
      setAvailability({}); setShowAll(false); setAvailLoading(false); return;
    }
    (async () => {
      setAvailLoading(true);
      const { data, error } = await supabase.rpc('sub_availability_on_date', {
        p_org: organizationId,
        p_date: date,
        p_parent_type: parentType,
        p_parent_assignment_id: parentAssignment.id,
      });
      if (cancelled) return;
      if (error) {
        // Availability is an assist, not a gate: on failure fall back to the
        // flat list rather than blocking the assignment.
        setAvailability({});
        setAvailLoading(false);
        return;
      }
      const map = {};
      for (const row of data ?? []) {
        map[row.instructor_id] = {
          is_working: row.is_working,
          working_reason: row.working_reason,
          is_date_off: row.is_date_off,
          day_time_match: row.day_time_match,
          out_of_area: row.out_of_area,
        };
      }
      setAvailability(map);
      setShowAll(false);   // collapse non-matches again for the new date
      setAvailLoading(false);
    })();
    return () => { cancelled = true; };
  }, [date, organizationId, parentType, parentAssignment?.id]);

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
        background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520, maxHeight: '90vh',
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
            {availableDates ? (
              availableDates.length > 0 ? (
                <select value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle}>
                  <option value="">— Pick a class date —</option>
                  {availableDates.map((d) => (
                    <option key={d} value={d}>{fmtDate(d)}</option>
                  ))}
                </select>
              ) : (
                <div style={{ ...inputStyle, background: CREAM, color: MUTED, display: "flex", alignItems: "center" }}>
                  No class dates found for this term.
                </div>
              )
            ) : (
              <div style={{ ...inputStyle, background: CREAM, color: INK, display: "flex", alignItems: "center" }}>
                {date ? fmtDate(date) : <span style={{ color: MUTED }}>Open the modal from a day tile to set the date.</span>}
              </div>
            )}
          </Field>

          <Field label="Sub instructor">
            {!date ? (
              <div style={{ fontSize: 12, color: MUTED }}>
                Pick a date above to see who's available that day.
              </div>
            ) : (
            <>
            {availLoading && (
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Checking availability…</div>
            )}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, overflow: 'hidden' }}>
              {ranked.length === 0 ? (
                <div style={{ padding: 12, fontSize: 13, color: MUTED }}>No other instructors in this org.</div>
              ) : (() => {
                const suggested = grouped[SUGGEST];
                const hidden = [...grouped[OTHER], ...grouped[OUT]];
                const selectedHidden = hidden.some((r) => r.instr.id === subInstructorId);
                const noMatches = !!date && !availLoading && suggested.length === 0;
                const expanded = showAll || selectedHidden || noMatches;
                const renderRow = (row) => (
                  <SubRow
                    key={row.instr.id}
                    row={row}
                    selected={row.instr.id === subInstructorId}
                    onSelect={() => setSubInstructorId(row.instr.id)}
                  />
                );
                return (
                  <>
                    {date && suggested.length > 0 && (
                      <GroupHeader meta={GROUP_META[SUGGEST]} count={suggested.length} first />
                    )}
                    {suggested.map(renderRow)}

                    {noMatches && (
                      <div style={{ padding: '8px 10px', fontSize: 12, color: MUTED, background: CREAM, borderTop: `1px solid ${RULE}` }}>
                        No one matches this day &amp; time — showing everyone.
                      </div>
                    )}

                    {date && hidden.length > 0 && !expanded && (
                      <button type="button" onClick={() => setShowAll(true)} style={toggleRowStyle}>
                        Show everyone ({hidden.length})
                      </button>
                    )}

                    {expanded && [OTHER, OUT].map((group) => {
                      const rows = grouped[group];
                      if (rows.length === 0) return null;
                      return (
                        <div key={group}>
                          {date && <GroupHeader meta={GROUP_META[group]} count={rows.length} />}
                          {rows.map(renderRow)}
                        </div>
                      );
                    })}

                    {date && hidden.length > 0 && showAll && !selectedHidden && !noMatches && (
                      <button type="button" onClick={() => setShowAll(false)} style={toggleRowStyle}>
                        Show fewer
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
            </>
            )}
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

function GroupHeader({ meta, count, first }) {
  return (
    <div style={{
      padding: '6px 10px', background: CREAM,
      borderTop: first ? 'none' : `1px solid ${RULE}`,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
      color: meta.color,
    }}>
      {meta.label} ({count})
    </div>
  );
}

// One clickable candidate row: radio dot + name + the availability note.
function SubRow({ row, selected, onSelect }) {
  const { instr, note, outOfArea, group } = row;
  const noteColor = group === OUT ? CORAL : MUTED;
  return (
    <div
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer',
        borderTop: `1px solid ${RULE}`,
        background: selected ? '#f2f0ff' : '#fff',
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${selected ? BRIGHT : RULE}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {selected && <span style={{ width: 6, height: 6, borderRadius: '50%', background: BRIGHT }} />}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: INK, fontWeight: selected ? 700 : 500 }}>
          {shortName(instr)}
        </div>
        {note ? (
          <div style={{ fontSize: 11, color: noteColor }}>
            {note}{outOfArea ? ' · outside their districts' : ''}
          </div>
        ) : outOfArea ? (
          <div style={{ fontSize: 11, color: '#9a6a00' }}>outside their districts</div>
        ) : instr.email ? (
          <div style={{ fontSize: 11, color: MUTED }}>{instr.email}</div>
        ) : null}
      </div>
    </div>
  );
}

const toggleRowStyle = {
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  background: '#fff',
  border: 'none',
  borderTop: `1px solid ${RULE}`,
  color: BRIGHT,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

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
  background: BRIGHT,
  color: '#fff',
  border: `1px solid ${BRIGHT}`,
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
