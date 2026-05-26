// src/pages/admin/Payroll.jsx
// /admin/payroll — weekly view of instructor session_delivery_confirmations.
//
// Default window: last 30 days of confirmed_at. Grouped by camp, then by
// instructor. Per (camp, instructor) row shows:
//   - Days marked (e.g. "5 / 5"), with the list of dates
//   - Base pay (sum of pay_amount_cents across confirmations)
//   - Week completion bonus (sum of pay_adjustment_cents)
//   - Distance bonus from the camp_assignments row (paid once per camp)
//   - Grand total
//   - pay_status (worst case across confirmations: withheld > adjusted > pending > approved)
//
// Read-only this version. Status flips (approve / withhold / mark paid)
// + per-row adjustments come in a follow-up.
//
// Multi-tenant: reads `org` from outlet context. No hardcoded tenant IDs.
// RLS on session_delivery_confirmations already restricts admin reads to
// rows in the user's org.

import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

const PURPLE = '#1C004F';
const VIOLET = '#8C88FF';
const CREAM = '#FBFBFB';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const OK = '#3a7c3a';
const AMBER = '#b67e00';
const RED = '#b53737';

const STATUS_COLOR = {
  pending: AMBER,
  approved: OK,
  adjusted: VIOLET,
  withheld: RED,
};

function dollars(cents) {
  if (cents == null) return '—';
  if (cents % 100 === 0) return `$${(cents / 100).toLocaleString()}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// Cumulative "worst" pay_status across an instructor's confirmations for one
// camp. We want the operator to see the most-action-needed status first.
function worstStatus(statuses) {
  const order = ['withheld', 'adjusted', 'pending', 'approved'];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses[0] ?? 'pending';
}

// Last 30 days in YYYY-MM-DD.
function thirtyDaysAgoISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function Payroll() {
  const { org } = useOutletContext() ?? {};
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [sinceDate, setSinceDate] = useState(thirtyDaysAgoISO());

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setRows(null);
      setError('');
      try {
        // 1. Confirmations in window. RLS already org-scopes.
        const { data: confs, error: cErr } = await supabase
          .from('session_delivery_confirmations')
          .select(
            `id, instructor_id, camp_session_id, session_date, session_type,
             confirmed_by, confirmed_at, pay_status, pay_amount_cents,
             pay_adjustment_cents, pay_adjustment_reason`
          )
          .gte('session_date', sinceDate)
          .not('camp_session_id', 'is', null)
          .order('session_date', { ascending: false });
        if (cErr) throw cErr;
        if (cancelled) return;

        const confRows = confs ?? [];
        if (confRows.length === 0) {
          setRows([]);
          return;
        }

        const instructorIds = [...new Set(confRows.map((r) => r.instructor_id))];
        const sessionIds = [...new Set(confRows.map((r) => r.camp_session_id))];

        // 2. Instructors (names + role tier).
        const { data: instructors } = await supabase
          .from('instructors')
          .select('id, first_name, last_name, preferred_name, contractor_tier')
          .in('id', instructorIds);
        const instructorById = new Map((instructors ?? []).map((i) => [i.id, i]));

        // 3. Camp sessions (curriculum name, dates, location).
        const { data: sessions } = await supabase
          .from('camp_sessions')
          .select('id, curriculum_name, starts_on, ends_on, location_name, week_num, session_type')
          .in('id', sessionIds);
        const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));

        // 4. Camp assignments — pull role + distance_bonus_cents per
        //    (instructor, camp_session). The assignment row tells us
        //    'lead' vs 'developing' and the one-time distance bonus.
        const { data: assignments } = await supabase
          .from('camp_assignments')
          .select('instructor_id, camp_session_id, role, distance_bonus_cents')
          .in('instructor_id', instructorIds)
          .in('camp_session_id', sessionIds);
        const assignmentKey = (i, s) => `${i}|${s}`;
        const assignmentByKey = new Map(
          (assignments ?? []).map((a) => [assignmentKey(a.instructor_id, a.camp_session_id), a])
        );

        // 5. Group: { camp_session_id -> { session, perInstructor: Map(instructor_id -> {...}) } }
        const grouped = new Map();
        for (const c of confRows) {
          const sess = sessionById.get(c.camp_session_id);
          if (!sess) continue;
          if (!grouped.has(c.camp_session_id)) {
            grouped.set(c.camp_session_id, {
              session: sess,
              perInstructor: new Map(),
            });
          }
          const entry = grouped.get(c.camp_session_id);
          if (!entry.perInstructor.has(c.instructor_id)) {
            const inst = instructorById.get(c.instructor_id);
            const assn = assignmentByKey.get(assignmentKey(c.instructor_id, c.camp_session_id));
            entry.perInstructor.set(c.instructor_id, {
              instructor: inst,
              role: assn?.role ?? null,
              distance_bonus_cents: assn?.distance_bonus_cents ?? 0,
              confirmations: [],
            });
          }
          entry.perInstructor.get(c.instructor_id).confirmations.push(c);
        }

        // 6. Flatten to rendered rows, sorted: camp by starts_on desc.
        const out = [...grouped.values()]
          .sort((a, b) => (b.session.starts_on ?? '').localeCompare(a.session.starts_on ?? ''))
          .map((entry) => ({
            session: entry.session,
            instructors: [...entry.perInstructor.values()].sort((a, b) => {
              const an = `${a.instructor?.last_name ?? ''} ${a.instructor?.first_name ?? ''}`.trim();
              const bn = `${b.instructor?.last_name ?? ''} ${b.instructor?.first_name ?? ''}`.trim();
              return an.localeCompare(bn);
            }),
          }));

        if (!cancelled) setRows(out);
      } catch (err) {
        console.error('[Payroll] load failed', err);
        if (!cancelled) {
          setError(err.message ?? 'Could not load payroll data.');
          setRows([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, sinceDate]);

  const noPayConfig = useMemo(() => {
    // Heuristic for the "your tenant hasn't configured pay rates" banner.
    // If we have rows but NONE of them have pay_amount_cents set, that's the
    // most likely cause (the edge function leaves them null when rates are
    // missing). Clean signal for the operator to go set rates in Settings.
    if (!rows || rows.length === 0) return false;
    const allNull = rows.every((r) =>
      r.instructors.every((i) => i.confirmations.every((c) => c.pay_amount_cents == null))
    );
    return allNull;
  }, [rows]);

  return (
    <div>
      <header style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
            Payroll
          </h1>
          <p style={{ color: MUTED, marginTop: 6, fontSize: 14 }}>
            Sessions marked taught by your instructors, grouped by camp. Pay amounts come from your org&rsquo;s configured rates.
          </p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: MUTED }}>
          Since
          <input
            type="date"
            value={sinceDate}
            onChange={(e) => setSinceDate(e.target.value)}
            style={{
              padding: '6px 10px',
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'inherit',
              background: '#fff',
              color: INK,
            }}
          />
        </label>
      </header>

      {error && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {noPayConfig && (
        <div style={{ background: `${AMBER}1A`, border: `1px solid ${AMBER}55`, color: INK, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
          <strong>Pay rates not configured.</strong> Sessions are being marked taught, but pay isn&rsquo;t being computed because your org hasn&rsquo;t set hourly rates yet. (Settings → Pay rates, coming soon.)
        </div>
      )}

      {rows === null && (
        <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <div style={{ background: '#fff', border: `1px solid ${RULE}`, borderRadius: 8, padding: 28, color: MUTED, textAlign: 'center' }}>
          No sessions marked taught since {fmtDate(sinceDate)}. As instructors check in at their camps, rows will show up here.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map((g) => (
            <CampCard key={g.session.id} session={g.session} instructors={g.instructors} />
          ))}
        </div>
      )}
    </div>
  );
}

function CampCard({ session, instructors }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${RULE}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${RULE}`, background: CREAM }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
          {session.curriculum_name}
          {session.week_num && (
            <span style={{ color: MUTED, marginLeft: 8, fontSize: 13, fontWeight: 400 }}>
              · Week {session.week_num}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
          {fmtDate(session.starts_on)} – {fmtDate(session.ends_on)}
          {session.location_name && ` · ${session.location_name}`}
          {session.session_type && ` · ${session.session_type.replace('_', ' ')}`}
        </div>
      </div>

      <div>
        {instructors.map((entry, idx) => (
          <InstructorRow
            key={entry.instructor?.id ?? idx}
            entry={entry}
            isLast={idx === instructors.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function InstructorRow({ entry, isLast }) {
  const inst = entry.instructor;
  const displayName = inst
    ? (inst.preferred_name?.trim() || `${inst.first_name ?? ''} ${inst.last_name ?? ''}`.trim() || '—')
    : '—';

  const confs = entry.confirmations.slice().sort((a, b) => (a.session_date ?? '').localeCompare(b.session_date ?? ''));
  const baseTotal = confs.reduce((s, c) => s + (c.pay_amount_cents ?? 0), 0);
  const bonusTotal = confs.reduce((s, c) => s + (c.pay_adjustment_cents ?? 0), 0);
  const distanceBonus = entry.distance_bonus_cents ?? 0;
  const grandTotal = baseTotal + bonusTotal + distanceBonus;

  const status = worstStatus(confs.map((c) => c.pay_status));
  const statusColor = STATUS_COLOR[status] ?? MUTED;

  const hasAnyPay = confs.some((c) => c.pay_amount_cents != null);
  const totalToShow = hasAnyPay ? grandTotal : null;

  return (
    <div style={{ padding: '12px 18px', borderBottom: isLast ? 'none' : `1px solid ${RULE}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
            {displayName}
            {entry.role && (
              <span style={{ color: MUTED, marginLeft: 8, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {entry.role}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
            {confs.length} day{confs.length === 1 ? '' : 's'} marked taught:{' '}
            {confs.map((c, i) => (
              <span key={c.id}>
                {fmtDate(c.session_date)}
                {c.confirmed_by === 'admin' && (
                  <span style={{ color: MUTED, fontStyle: 'italic' }}> (by admin)</span>
                )}
                {i < confs.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
        </div>

        <div style={{ textAlign: 'right', minWidth: 160 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: hasAnyPay ? INK : MUTED }}>
            {dollars(totalToShow)}
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 3, lineHeight: 1.5 }}>
            {hasAnyPay ? (
              <>
                Base {dollars(baseTotal)}
                {bonusTotal > 0 && <> · Bonus {dollars(bonusTotal)}</>}
                {distanceBonus > 0 && <> · Distance {dollars(distanceBonus)}</>}
              </>
            ) : (
              <span style={{ fontStyle: 'italic' }}>pay not set</span>
            )}
          </div>
          <div
            style={{
              display: 'inline-block',
              marginTop: 6,
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: statusColor,
              background: `${statusColor}1F`,
              border: `1px solid ${statusColor}55`,
            }}
          >
            {status}
          </div>
        </div>
      </div>
    </div>
  );
}
