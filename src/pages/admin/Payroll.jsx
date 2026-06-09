// src/pages/admin/Payroll.jsx
// /admin/payroll — instructor pay management.
//
// Read-only summary view replaced by an action-driven workflow:
//   - Groups by (effective_instructor, camp_session) for camp rows and
//     (effective_instructor, program) for afterschool rows. Both kinds
//     come from v_effective_pay_lines and interleave by date.
//   - Per-row actions: Approve / Withhold / Re-approve / Pay via Stripe /
//     Mark paid manually.
//   - Expand-on-click shows per-day breakdown with per-row controls.
//   - Covered-day rows display "Covered by [sub] — $0" without paying twice.
//   - "Show paid" toggle reveals settled groups (default hidden).
//
// Multi-tenant: org from outlet context. All actions gated to owner/admin.
//
// Resolver-aware from day 1. When assignment_substitutions table ships
// (FA26 work in parallel), the view starts surfacing sub-routed pay lines;
// this page renders them with a 'sub' badge and pays the sub instead of
// the regular instructor for those days.

import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';   // indigo - primary actions (Figma)
const VIOLET = '#8C88FF';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const OK = '#3a7c3a';
const AMBER = '#b67e00';
const RED = '#b53737';
const CREAM = '#FBFBFB';

const STATUS_COLOR = {
  pending: AMBER,
  approved: OK,
  adjusted: VIOLET,
  withheld: RED,
  paid: '#7a7a7a',
  mixed: AMBER,
};

const STATUS_LABEL = {
  pending: 'Pending',
  approved: 'Approved',
  adjusted: 'Adjusted',
  withheld: 'Withheld',
  paid: 'Paid',
  mixed: 'Mixed',
};

function dollars(cents) {
  if (cents == null) return '—';
  if (cents % 100 === 0) return `$${(cents / 100).toLocaleString()}`;
  return `$${(cents / 100).toFixed(2)}`;
}

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

function thirtyDaysAgoISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function Payroll() {
  const { org, orgMember } = useOutletContext() ?? {};
  const canManage = orgMember?.role === 'owner' || orgMember?.role === 'admin';

  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');
  const [savedToast, setSavedToast] = useState(null);
  const [sinceDate, setSinceDate] = useState(thirtyDaysAgoISO());
  const [showPaid, setShowPaid] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [expanded, setExpanded] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const [payingGroup, setPayingGroup] = useState(null);
  const [markingGroup, setMarkingGroup] = useState(null);
  const [withholdingRow, setWithholdingRow] = useState(null); // { groupKey, confirmation_id, isGroup?: bool }
  const [adjustTarget, setAdjustTarget] = useState(null); // { mode:'line'|'bonus', ... } — manual adjust / bonus
  const [payRoute, setPayRoute] = useState(null); // org's pay model — gates whether "Pay via Stripe" shows

  // Only show "Pay via Stripe" when the tenant actually has a LIVE Stripe payout
  // rail. Today that's legacy_own_platform (their own Connect). enrops_platform
  // is "coming soon" (blocked) and manual/not-connected tenants have no rail, so
  // they get manual-only ("Mark paid manually"). Expand this when enrops_platform
  // ships. Defaults to false until loaded so we never show a dead Pay button.
  const canStripePayout = payRoute?.instructor_pay_model === 'legacy_own_platform';

  function toggleExpand(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function bumpRefresh() {
    setRefreshToken((t) => t + 1);
  }

  function toast(msg) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(null), 2000);
  }

  // Load the org's pay model so we know whether to offer "Pay via Stripe".
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('organizations')
        .select('instructor_pay_model, stripe_account_status, stripe_charges_enabled')
        .eq('id', org.id)
        .maybeSingle();
      if (!cancelled) setPayRoute(data ?? null);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // ── load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setGroups(null);
      setError('');
      try {
        const { data: lines, error: lErr } = await supabase
          .from('v_effective_pay_lines')
          .select('*')
          .eq('organization_id', org.id)
          .gte('session_date', sinceDate)
          .order('session_date', { ascending: false });
        if (lErr) throw lErr;
        if (cancelled) return;

        const rows = lines ?? [];
        if (rows.length === 0) { setGroups([]); return; }

        const instructorIds = [...new Set([
          ...rows.map((r) => r.effective_instructor_id),
          ...rows.map((r) => r.original_instructor_id),
        ].filter(Boolean))];
        const sessionIds = [...new Set(rows.map((r) => r.camp_session_id).filter(Boolean))];
        const programIds = [...new Set(rows.map((r) => r.program_id).filter(Boolean))];

        const [instR, sessR, progR, onbR] = await Promise.all([
          supabase.from('instructors')
            .select('id, first_name, last_name, preferred_name, contractor_tier')
            .in('id', instructorIds),
          sessionIds.length === 0
            ? Promise.resolve({ data: [] })
            : supabase.from('camp_sessions')
              .select('id, curriculum_name, starts_on, ends_on, location_name, week_num')
              .in('id', sessionIds),
          programIds.length === 0
            ? Promise.resolve({ data: [] })
            : supabase.from('programs')
              .select('id, curriculum, day_of_week, first_session_date, session_count, program_location_id')
              .in('id', programIds),
          supabase.from('contractor_onboarding_status')
            .select('instructor_id, stripe_payouts_enabled, stripe_connect_account_id')
            .in('instructor_id', instructorIds),
        ]);
        if (cancelled) return;

        const locationIds = [...new Set((progR.data ?? []).map((p) => p.program_location_id).filter(Boolean))];
        const locR = locationIds.length === 0
          ? { data: [] }
          : await supabase.from('program_locations').select('id, name').in('id', locationIds);
        if (cancelled) return;

        const instById = new Map((instR.data ?? []).map((i) => [i.id, i]));
        const sessById = new Map((sessR.data ?? []).map((s) => [s.id, s]));
        const progById = new Map((progR.data ?? []).map((p) => [p.id, p]));
        const locById  = new Map((locR.data  ?? []).map((l) => [l.id, l]));
        const onbByInst = new Map((onbR.data ?? []).map((o) => [o.instructor_id, o]));

        // Group by (effective_instructor, kind, target_id) — kind dispatches
        // camp_session_id vs program_id. A confirmation row has exactly one
        // of the two set (DB enforces this on session_delivery_confirmations).
        const groupMap = new Map();
        for (const row of rows) {
          const kind = row.camp_session_id ? 'camp' : 'program';
          const targetId = kind === 'camp' ? row.camp_session_id : row.program_id;
          if (!targetId) continue;
          const key = `${row.effective_instructor_id}|${kind}:${targetId}`;
          if (!groupMap.has(key)) {
            const inst = instById.get(row.effective_instructor_id);
            const onb = onbByInst.get(row.effective_instructor_id);
            const origInst = instById.get(row.original_instructor_id);
            const sess = kind === 'camp'    ? sessById.get(targetId) : null;
            const prog = kind === 'program' ? progById.get(targetId) : null;
            const school = prog ? locById.get(prog.program_location_id) : null;
            groupMap.set(key, {
              key,
              kind,
              effective_instructor_id: row.effective_instructor_id,
              camp_session_id: kind === 'camp'    ? targetId : null,
              program_id:      kind === 'program' ? targetId : null,
              instructor: inst,
              originalInstructor: origInst,
              session: sess,
              program: prog,
              school,
              stripePayoutsEnabled: onb?.stripe_payouts_enabled === true,
              stripeDestination: onb?.stripe_connect_account_id || null,
              source: row.source,
              rows: [],
            });
          }
          groupMap.get(key).rows.push(row);
        }

        // Decorate each group with totals + status.
        const decorated = [...groupMap.values()].map((g) => {
          g.rows.sort((a, b) => (a.session_date ?? '').localeCompare(b.session_date ?? ''));

          // Base sum (rows that aren't withheld and have pay_amount_cents).
          const totalPayable = g.rows
            .filter((r) => r.pay_status !== 'withheld' && r.pay_amount_cents != null)
            .reduce((s, r) => s + (r.pay_amount_cents ?? 0) + (r.pay_adjustment_cents ?? 0), 0);

          // Distance bonus (regular only, not yet paid).
          const sampleForBonus = g.rows.find((r) => r.source === 'regular');
          const distanceBonusCents = (sampleForBonus && sampleForBonus.distance_bonus_paid_at === null)
            ? (sampleForBonus.distance_bonus_cents_if_regular ?? 0)
            : 0;
          const distanceBonusPaid = sampleForBonus?.distance_bonus_paid_at != null;

          // Aggregate status.
          const statuses = [...new Set(g.rows.map((r) => r.pay_status))];
          const groupStatus = statuses.length === 1 ? statuses[0] : 'mixed';

          // Eligibility for the Pay action.
          const eligibleRows = g.rows.filter((r) =>
            r.pay_status === 'approved' &&
            r.instructor_payout_id == null &&
            r.confirmed_by != null && r.confirmed_by !== 'pending' &&
            r.pay_amount_cents != null
          );

          // Counts per status for the aggregate display.
          const counts = g.rows.reduce((acc, r) => {
            acc[r.pay_status] = (acc[r.pay_status] || 0) + 1;
            return acc;
          }, {});

          return {
            ...g,
            totalPayable,
            distanceBonusCents,
            distanceBonusPaid,
            groupStatus,
            eligibleRows,
            counts,
            // Total IF paid now (base + bonus when applicable)
            payableTotalNow: totalPayable + (g.source === 'regular' ? distanceBonusCents : 0),
          };
        });

        // showPaid filter: hide groups whose ALL rows are paid (default).
        const filtered = showPaid
          ? decorated
          : decorated.filter((g) => g.rows.some((r) => r.pay_status !== 'paid'));

        // Sort: most-recent session desc, then instructor name. For camps
        // we sort by starts_on; for programs by first_session_date. Newest
        // rows from either kind interleave correctly.
        filtered.sort((a, b) => {
          const aDate = a.kind === 'camp' ? (a.session?.starts_on ?? '') : (a.program?.first_session_date ?? '');
          const bDate = b.kind === 'camp' ? (b.session?.starts_on ?? '') : (b.program?.first_session_date ?? '');
          if (aDate !== bDate) return bDate.localeCompare(aDate);
          return shortName(a.instructor).localeCompare(shortName(b.instructor));
        });

        if (!cancelled) setGroups(filtered);
      } catch (err) {
        console.error('[Payroll] load failed', err);
        if (!cancelled) {
          setError(err.message ?? 'Could not load payroll.');
          setGroups([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, sinceDate, showPaid, refreshToken]);

  const noPayConfig = useMemo(() => {
    if (!groups || groups.length === 0) return false;
    return groups.every((g) => g.rows.every((r) => r.pay_amount_cents == null));
  }, [groups]);

  // ── row-level actions ──────────────────────────────────────────────────
  async function approveRow(confirmationId) {
    if (!canManage) return;
    setBusy(true);
    const { error: err } = await supabase
      .from('session_delivery_confirmations')
      .update({ pay_status: 'approved' })
      .eq('id', confirmationId);
    setBusy(false);
    if (err) { setError(err.message); return; }
    toast('Approved');
    bumpRefresh();
  }

  async function reapproveRow(confirmationId) {
    return approveRow(confirmationId);
  }

  async function submitWithhold(confirmationIds, reason) {
    if (!canManage) return;
    setBusy(true);
    const update = { pay_status: 'withheld' };
    if (reason) update.pay_adjustment_reason = reason;
    const { error: err } = await supabase
      .from('session_delivery_confirmations')
      .update(update)
      .in('id', confirmationIds);
    setBusy(false);
    if (err) { setError(err.message); return; }
    toast(`Withheld ${confirmationIds.length} day${confirmationIds.length === 1 ? '' : 's'}`);
    setWithholdingRow(null);
    bumpRefresh();
  }

  // Manual adjust / bonus. Non-destructive: the original computed amount
  // (pay_amount_cents) is preserved; the change is recorded as a tracked
  // pay_adjustment_cents + reason + who/when (admin_override_*). Both the
  // group total and the Stripe payout already sum pay_adjustment_cents.
  async function submitAdjust(target, { amountCents, reason }) {
    if (!canManage || !target) return;
    if (!reason || !reason.trim()) { setError('A reason is required for any pay adjustment.'); return; }
    setBusy(true);
    setError('');
    try {
      const { data: au } = await supabase.auth.getUser();
      const uid = au?.user?.id ?? null;
      const nowIso = new Date().toISOString();
      const audit = { admin_override: true, admin_override_by: uid, admin_override_at: nowIso };

      if (target.mode === 'line') {
        // amountCents = the NEW total for this day (override UX). Keep the
        // computed base and store the difference as the adjustment, so the
        // original is never lost. If there was no computed base, set it.
        if (amountCents < 0) { setError('Amount can’t be negative.'); setBusy(false); return; }
        const update = target.baseNull
          ? { pay_amount_cents: amountCents, pay_adjustment_cents: 0 }
          : { pay_adjustment_cents: amountCents - target.baseCents };
        update.pay_status = 'adjusted';
        update.pay_adjustment_reason = reason.trim();
        Object.assign(update, audit);
        const { error: err } = await supabase
          .from('session_delivery_confirmations').update(update).eq('id', target.confirmationId);
        if (err) throw err;
      } else {
        // Week bonus: attach to a payable line on this group (sum if one
        // already carries an adjustment). Reason is prefixed "Bonus:".
        const row = target.group.rows.find((r) => r.pay_status !== 'paid') ?? target.group.rows[0];
        if (!row) throw new Error('No pay line to attach the bonus to.');
        const newAdj = (row.pay_adjustment_cents ?? 0) + amountCents;
        if ((row.pay_amount_cents ?? 0) + newAdj < 0) { setError('That deduction is larger than the pay.'); setBusy(false); return; }
        const prev = row.pay_adjustment_reason ? `${row.pay_adjustment_reason} | ` : '';
        const { error: err } = await supabase
          .from('session_delivery_confirmations')
          .update({
            pay_adjustment_cents: newAdj,
            pay_status: row.pay_status === 'paid' ? row.pay_status : 'adjusted',
            pay_adjustment_reason: `${prev}Bonus: ${reason.trim()}`,
            ...audit,
          })
          .eq('id', row.confirmation_id);
        if (err) throw err;
      }
      setAdjustTarget(null);
      toast(target.mode === 'bonus' ? 'Bonus added' : 'Pay adjusted');
      bumpRefresh();
    } catch (e) {
      setError(e.message ?? 'Could not save the adjustment.');
    } finally {
      setBusy(false);
    }
  }

  async function approveGroup(group) {
    if (!canManage) return;
    const ids = group.rows
      .filter((r) => r.pay_status === 'pending' || r.pay_status === 'adjusted')
      .map((r) => r.confirmation_id);
    if (ids.length === 0) return;
    setBusy(true);
    const { error: err } = await supabase
      .from('session_delivery_confirmations')
      .update({ pay_status: 'approved' })
      .in('id', ids);
    setBusy(false);
    if (err) { setError(err.message); return; }
    toast(`Approved ${ids.length} day${ids.length === 1 ? '' : 's'}`);
    bumpRefresh();
  }

  // ── render ─────────────────────────────────────────────────────────────
  return (
    <div>
      <PayRoutesCard org={org} />
      <Toolbar
        sinceDate={sinceDate}
        setSinceDate={setSinceDate}
        showPaid={showPaid}
        setShowPaid={setShowPaid}
      />

      {error && <Banner tone="err">{error}</Banner>}
      {savedToast && <Banner tone="ok">{savedToast}</Banner>}
      {noPayConfig && (
        <Banner tone="warn">
          None of these days have a pay amount set. Check your organization's pay
          configuration (Settings → Pay rates) and confirm that
          confirm-session-taught is computing per-session pay.
        </Banner>
      )}

      {groups === null ? (
        <div style={{ color: MUTED, padding: 24 }}>Loading payroll…</div>
      ) : groups.length === 0 ? (
        <EmptyState showPaid={showPaid} sinceDate={sinceDate} />
      ) : (
        <div>
          {groups.map((g) => (
            <GroupRow
              key={g.key}
              group={g}
              expanded={expanded.has(g.key)}
              onToggle={() => toggleExpand(g.key)}
              onApproveGroup={() => approveGroup(g)}
              onWithholdGroup={() => setWithholdingRow({ groupKey: g.key, confirmation_ids: g.rows.filter((r) => r.pay_status !== 'paid').map((r) => r.confirmation_id), isGroup: true })}
              onPay={() => setPayingGroup(g)}
              onMarkPaid={() => setMarkingGroup(g)}
              onApproveRow={approveRow}
              onWithholdRow={(cid) => setWithholdingRow({ groupKey: g.key, confirmation_ids: [cid], isGroup: false })}
              onReapproveRow={reapproveRow}
              onAdjustRow={(r) => setAdjustTarget({
                mode: 'line',
                confirmationId: r.confirmation_id,
                baseCents: r.pay_amount_cents ?? 0,
                baseNull: r.pay_amount_cents == null,
                adjCents: r.pay_adjustment_cents ?? 0,
                label: fmtDate(r.session_date),
              })}
              onAddBonus={() => setAdjustTarget({ mode: 'bonus', group: g, label: shortName(g.instructor) })}
              canStripePayout={canStripePayout}
              canManage={canManage}
              busy={busy}
            />
          ))}
        </div>
      )}

      {payingGroup && (
        <PayDrawer
          group={payingGroup}
          onClose={() => setPayingGroup(null)}
          onPaid={() => { setPayingGroup(null); bumpRefresh(); toast('Paid'); }}
        />
      )}
      {markingGroup && (
        <MarkPaidDrawer
          group={markingGroup}
          onClose={() => setMarkingGroup(null)}
          onMarked={() => { setMarkingGroup(null); bumpRefresh(); toast('Marked paid'); }}
        />
      )}
      {withholdingRow && (
        <WithholdDialog
          payload={withholdingRow}
          onCancel={() => setWithholdingRow(null)}
          onConfirm={(reason) => submitWithhold(withholdingRow.confirmation_ids, reason)}
          busy={busy}
        />
      )}
      {adjustTarget && (
        <AdjustDialog
          target={adjustTarget}
          onCancel={() => setAdjustTarget(null)}
          onConfirm={(payload) => submitAdjust(adjustTarget, payload)}
          busy={busy}
        />
      )}
    </div>
  );
}

// ───────────────────────────── sub-components ──────────────────────────────

// PayRoutesCard
//
// Plain-English explainer of the three ways an operator can pay instructors
// through (or alongside) Enrops. For v1, only Option 1 (manual / calculator)
// is live for new tenants. J2S is on Option 3 (their own Stripe Connect
// platform setup, pre-dating Enrops). Option 2 (Enrops routes the money from
// the tenant's connected account directly to the instructor's bank) is
// drafted in code but gated behind a safety net in pay-instructor — operators
// who want it can signal interest via the mailto, and we'll turn it on per-
// tenant once we've tested it live.
//
// Card is collapsible so it doesn't dominate the page once read. State is
// session-only — re-reads each load. (Local-storage persistence is a nice-
// to-have we can add when it starts to grate.)
function PayRoutesCard({ org }) {
  const [open, setOpen] = useState(false);
  const orgName = org?.name || 'your organization';
  const orgSlug = org?.slug || '';

  // Pre-filled mailto for operators who want the v2 routes turned on.
  function mailtoForOption(optionLabel) {
    const subject = `Enrops: ${optionLabel}`;
    const body =
      `Org: ${orgName}${orgSlug ? ` (${orgSlug})` : ''}\n\n` +
      `I want to use this option for paying my instructors. Please let me know what's needed to turn it on.`;
    return `mailto:hello@enrops.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        padding: '14px 18px',
        marginBottom: 16,
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          gap: 12,
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <div>
          <div style={{ fontWeight: 700, color: PURPLE, fontSize: 15 }}>
            How you can pay your instructors
          </div>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
            Three ways — only some are live right now. {open ? 'Hide' : 'Show'} the details.
          </div>
        </div>
        <div style={{ color: VIOLET, fontSize: 18, lineHeight: 1, userSelect: 'none' }}>
          {open ? '▴' : '▾'}
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
          <PayRouteRow
            number={1}
            title="You pay them outside Enrops"
            body={
              <>
                You already use <strong>Gusto, ADP, your bank, checks, Venmo,</strong> or
                something else to pay people. Keep doing that. Enrops shows you exactly
                what each instructor is owed, and you mark each line "paid" once you've
                paid them — so your records stay clean and you don't double-pay.
              </>
            }
            status="available"
            statusLabel="Available now"
          />
          <PayRouteRow
            number={2}
            title="Enrops moves the money for you"
            body={
              <>
                You click <strong>Pay</strong> next to an instructor and Enrops sends the
                money straight from your Stripe balance (where parent payments land) to
                your instructor's bank. No second system, no extra Stripe setup on your
                side. Your instructor signs up for a quick Stripe payout account (name,
                SSN, bank) the first time they're paid this way.
              </>
            }
            status="coming"
            statusLabel="Coming soon"
            cta={{ label: 'Tell us you want this', href: mailtoForOption('I want option 2 — Enrops routes the pay') }}
          />
          <PayRouteRow
            number={3}
            title="You already have a Stripe Connect setup of your own"
            body={
              <>
                Your Stripe account is set up to pay contractors directly — you've added
                Connect, your instructors are onboarded under your platform, the rails
                are already there. Enrops plugs into that and pushes Pay clicks through
                your existing setup. This needs a one-time technical handoff.
              </>
            }
            status="request"
            statusLabel="Available by request"
            cta={{ label: 'Tell us you want this', href: mailtoForOption('I want option 3 — plug into my existing Stripe Connect') }}
          />
          <div style={{ color: MUTED, fontSize: 12, lineHeight: 1.5, paddingTop: 4 }}>
            Not sure which fits? Email{' '}
            <a href="mailto:hello@enrops.com" style={{ color: VIOLET, fontWeight: 600 }}>
              hello@enrops.com
            </a>{' '}
            and we'll walk through it with you.
          </div>
        </div>
      )}
    </div>
  );
}

function PayRouteRow({ number, title, body, status, statusLabel, cta }) {
  const badgeBg =
    status === 'available' ? 'rgba(58,124,58,0.12)' :
    status === 'coming' ? 'rgba(140,136,255,0.15)' :
    'rgba(182,126,0,0.12)';
  const badgeFg =
    status === 'available' ? OK :
    status === 'coming' ? VIOLET :
    AMBER;
  return (
    <div
      style={{
        background: CREAM,
        border: `1px solid ${RULE}`,
        borderRadius: 8,
        padding: '12px 14px',
        display: 'grid',
        gridTemplateColumns: '28px 1fr',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: BRIGHT,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: 13,
        }}
      >
        {number}
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, color: INK, fontSize: 14 }}>{title}</div>
          <span
            style={{
              background: badgeBg,
              color: badgeFg,
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {statusLabel}
          </span>
        </div>
        <div style={{ color: INK, fontSize: 13, lineHeight: 1.55, marginTop: 6 }}>
          {body}
        </div>
        {cta && (
          <a
            href={cta.href}
            style={{
              display: 'inline-block',
              marginTop: 10,
              padding: '6px 12px',
              border: `1px solid ${VIOLET}`,
              borderRadius: 6,
              color: VIOLET,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {cta.label} →
          </a>
        )}
      </div>
    </div>
  );
}

function Toolbar({ sinceDate, setSinceDate, showPaid, setShowPaid }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: MUTED }}>
        From:
        <input
          type="date"
          value={sinceDate}
          onChange={(e) => setSinceDate(e.target.value)}
          style={{ padding: '5px 8px', border: `1px solid ${RULE}`, borderRadius: 5, fontSize: 13, fontFamily: 'inherit' }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: INK, cursor: 'pointer' }}>
        <input type="checkbox" checked={showPaid} onChange={(e) => setShowPaid(e.target.checked)} />
        Show paid
      </label>
    </div>
  );
}

function Banner({ tone = 'info', children }) {
  const bg = tone === 'err' ? 'rgba(181,55,55,0.08)' : tone === 'warn' ? 'rgba(182,126,0,0.10)' : tone === 'ok' ? 'rgba(58,124,58,0.10)' : 'rgba(140,136,255,0.10)';
  const border = tone === 'err' ? 'rgba(181,55,55,0.30)' : tone === 'warn' ? 'rgba(182,126,0,0.30)' : tone === 'ok' ? 'rgba(58,124,58,0.30)' : 'rgba(140,136,255,0.30)';
  const color = tone === 'err' ? RED : tone === 'warn' ? AMBER : tone === 'ok' ? OK : VIOLET;
  return (
    <div style={{
      background: bg, border: `1px solid ${border}`, color, padding: '10px 14px',
      borderRadius: 6, marginBottom: 12, fontSize: 14,
    }}>
      {children}
    </div>
  );
}

function EmptyState({ showPaid, sinceDate }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${RULE}`, borderRadius: 12, padding: 32, textAlign: 'center', color: MUTED, fontSize: 14 }}>
      No payroll lines since {sinceDate}.
      <div style={{ fontSize: 12, marginTop: 8 }}>
        {showPaid
          ? 'Try widening the date range.'
          : 'Toggle "Show paid" to see settled payouts, or widen the date range.'}
      </div>
    </div>
  );
}

function GroupRow({
  group, expanded, onToggle,
  onApproveGroup, onWithholdGroup, onPay, onMarkPaid,
  onApproveRow, onWithholdRow, onReapproveRow,
  onAdjustRow, onAddBonus,
  canStripePayout,
  canManage, busy,
}) {
  const g = group;
  const sourceBadge = g.source === 'sub'
    ? <Badge color={VIOLET}>Sub</Badge>
    : null;

  const statusBadge = (
    <span style={{
      background: 'transparent', color: STATUS_COLOR[g.groupStatus] ?? AMBER,
      border: `1px solid ${STATUS_COLOR[g.groupStatus] ?? AMBER}`,
      borderRadius: 12, padding: '2px 10px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      {STATUS_LABEL[g.groupStatus] ?? g.groupStatus}
    </span>
  );

  const hasEligible = g.eligibleRows.length > 0;
  const hasPending = g.counts.pending > 0 || g.counts.adjusted > 0;

  return (
    <div style={{ background: '#fff', border: `1px solid ${RULE}`, borderRadius: 12, marginBottom: 12 }}>
      <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          style={{
            width: 24, height: 24, border: 'none', background: 'transparent',
            color: PURPLE, fontSize: 14, cursor: 'pointer', padding: 0,
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div style={{ flex: '1 1 240px', minWidth: 240 }}>
          <div style={{ fontWeight: 700, color: INK, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            {shortName(g.instructor)} {sourceBadge}
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {g.kind === 'camp' ? (
              <>
                {g.session?.curriculum_name ?? 'Camp'} · {g.session?.location_name ?? ''}
                {g.session?.starts_on && <> · {fmtDate(g.session.starts_on)}</>}
              </>
            ) : (
              <>
                {g.program?.curriculum ?? 'Program'} · {g.school?.name ?? ''}
                {g.program?.session_count && <> · {g.rows.length} of {g.program.session_count} sessions</>}
              </>
            )}
          </div>
          {g.source === 'sub' && g.originalInstructor && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2, fontStyle: 'italic' }}>
              Subbing for {shortName(g.originalInstructor)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 700, color: INK, fontSize: 16 }}>{dollars(g.payableTotalNow)}</div>
            <div style={{ fontSize: 11, color: MUTED }}>
              {g.rows.length} day{g.rows.length === 1 ? '' : 's'}
              {g.distanceBonusCents > 0 && ` · +${dollars(g.distanceBonusCents)} bonus`}
              {g.distanceBonusPaid && ` · bonus paid`}
            </div>
          </div>
          {statusBadge}
        </div>
      </div>

      {canManage && (
        <div style={{ borderTop: `1px solid ${RULE}`, padding: 10, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', background: CREAM }}>
          {hasPending && (
            <ActionButton onClick={onApproveGroup} disabled={busy} tone="primary">Approve all</ActionButton>
          )}
          {hasEligible && canStripePayout && (
            <ActionButton onClick={onPay} disabled={busy} tone="primary">Pay via Stripe</ActionButton>
          )}
          {hasEligible && (
            <ActionButton onClick={onMarkPaid} disabled={busy} tone="secondary">Mark paid manually</ActionButton>
          )}
          {(hasPending || hasEligible) && (
            <ActionButton onClick={onAddBonus} disabled={busy} tone="secondary">+ Add bonus</ActionButton>
          )}
          {(hasPending || hasEligible) && (
            <ActionButton onClick={onWithholdGroup} disabled={busy} tone="danger">Withhold all</ActionButton>
          )}
        </div>
      )}

      {expanded && (
        <DayBreakdown
          rows={g.rows}
          originalInstructor={g.originalInstructor}
          onApproveRow={onApproveRow}
          onWithholdRow={onWithholdRow}
          onReapproveRow={onReapproveRow}
          onAdjustRow={onAdjustRow}
          canManage={canManage}
          busy={busy}
          groupSource={g.source}
        />
      )}
    </div>
  );
}

function DayBreakdown({ rows, originalInstructor, onApproveRow, onWithholdRow, onReapproveRow, onAdjustRow, canManage, busy, groupSource }) {
  return (
    <div style={{ borderTop: `1px solid ${RULE}`, padding: 12, background: '#fafafa' }}>
      {rows.map((r) => {
        const isCovered = r.source === 'sub' && groupSource === 'regular';
        // covered: this view's group is REGULAR but the row's source is SUB.
        // (Today subs don't appear under regular's group because sub rows are
        //  routed to the sub's group. This branch is forward-looking for
        //  when the schema model evolves to show both.)
        return (
          <div key={r.confirmation_id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0',
            borderBottom: `1px dashed ${RULE}`, fontSize: 13,
          }}>
            <div style={{ flex: '0 0 110px', color: INK }}>{fmtDate(r.session_date)}</div>
            <div style={{ flex: '0 0 90px', color: MUTED, textTransform: 'capitalize' }}>{r.session_type}</div>
            <div style={{ flex: '1 1 auto', color: isCovered ? MUTED : INK, fontStyle: isCovered ? 'italic' : 'normal' }}>
              {isCovered
                ? `Covered by sub — $0`
                : dollars((r.pay_amount_cents ?? 0) + (r.pay_adjustment_cents ?? 0))}
            </div>
            <div style={{ flex: '0 0 90px' }}>
              <span style={{ color: STATUS_COLOR[r.pay_status] ?? AMBER, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                {STATUS_LABEL[r.pay_status] ?? r.pay_status}
              </span>
            </div>
            {canManage && r.pay_status !== 'paid' && (
              <div style={{ display: 'flex', gap: 6 }}>
                {onAdjustRow && !isCovered && (
                  <MicroButton onClick={() => onAdjustRow(r)} disabled={busy} tone="adjust">
                    {(r.pay_adjustment_cents ?? 0) !== 0 ? 'Edit $' : 'Adjust'}
                  </MicroButton>
                )}
                {(r.pay_status === 'pending' || r.pay_status === 'adjusted') && (
                  <MicroButton onClick={() => onApproveRow(r.confirmation_id)} disabled={busy}>Approve</MicroButton>
                )}
                {r.pay_status === 'approved' && r.instructor_payout_id == null && (
                  <MicroButton onClick={() => onWithholdRow(r.confirmation_id)} disabled={busy} tone="danger">Withhold</MicroButton>
                )}
                {r.pay_status === 'withheld' && (
                  <MicroButton onClick={() => onReapproveRow(r.confirmation_id)} disabled={busy}>Re-approve</MicroButton>
                )}
              </div>
            )}
          </div>
        );
      })}
      {rows[0]?.pay_adjustment_reason && (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED, fontStyle: 'italic' }}>
          Note: {rows[0].pay_adjustment_reason}
        </div>
      )}
    </div>
  );
}

function ActionButton({ onClick, disabled, tone = 'primary', children }) {
  const colors = {
    primary:   { bg: BRIGHT,     fg: '#fff', border: BRIGHT },
    secondary: { bg: '#fff',     fg: BRIGHT, border: BRIGHT },
    danger:    { bg: '#fff',     fg: RED,    border: RED },
  };
  const c = colors[tone] ?? colors.primary;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
        padding: '6px 12px', borderRadius: 5, fontSize: 13, fontWeight: 600,
        fontFamily: 'inherit', cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function MicroButton({ onClick, disabled, tone, children }) {
  const color = tone === 'danger' ? RED : tone === 'adjust' ? VIOLET : PURPLE;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent', color, border: `1px solid ${color}`,
        padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
        fontFamily: 'inherit', cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Badge({ color, children }) {
  return (
    <span style={{
      background: 'transparent', color, border: `1px solid ${color}`,
      borderRadius: 10, padding: '1px 8px', fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      {children}
    </span>
  );
}

// ───────────────────────── Withhold dialog ────────────────────────────────

function WithholdDialog({ payload, onCancel, onConfirm, busy }) {
  const [reason, setReason] = useState('');
  return (
    <DrawerShell title={payload.isGroup ? 'Withhold all' : 'Withhold day'} onClose={onCancel}>
      <p style={{ margin: '0 0 12px', color: INK, fontSize: 14 }}>
        {payload.isGroup
          ? `Withhold ${payload.confirmation_ids.length} day${payload.confirmation_ids.length === 1 ? '' : 's'} from pay. The instructor will not be paid for these unless you re-approve later.`
          : 'Withhold this day from pay. The instructor will not be paid for it unless you re-approve later.'}
      </p>
      <label style={{ display: 'block', fontSize: 13, color: MUTED, marginBottom: 6 }}>
        Reason (optional, internal note)
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder="e.g., No-show, quality issue, instructor request…"
        style={{ width: '100%', padding: 8, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <ActionButton tone="secondary" onClick={onCancel} disabled={busy}>Cancel</ActionButton>
        <ActionButton tone="danger" onClick={() => onConfirm(reason.trim() || null)} disabled={busy}>
          {busy ? 'Withholding…' : 'Withhold'}
        </ActionButton>
      </div>
    </DrawerShell>
  );
}

// Adjust / bonus dialog. `mode` is 'line' (override one day's total) or
// 'bonus' (add a week-level amount). Override UX (type the new total) but
// stored non-destructively as a tracked adjustment; reason is required.
function AdjustDialog({ target, onCancel, onConfirm, busy }) {
  const isBonus = target.mode === 'bonus';
  const initial = isBonus ? '' : (((target.baseCents ?? 0) + (target.adjCents ?? 0)) / 100).toFixed(2);
  const [amount, setAmount] = useState(initial);
  const [reason, setReason] = useState('');
  const parsed = parseFloat(String(amount).replace(/[^0-9.\-]/g, ''));
  const cents = Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
  const amountOk = Number.isFinite(cents) && (isBonus ? cents !== 0 : cents >= 0);
  const valid = amountOk && reason.trim().length > 0;
  return (
    <DrawerShell title={isBonus ? `Add bonus — ${target.label}` : `Correct pay — ${target.label}`} onClose={onCancel}>
      <p style={{ margin: '0 0 12px', color: INK, fontSize: 14 }}>
        {isBonus
          ? 'Add a one-off amount to this instructor’s pay for the week. It’s recorded with your note and added to the Stripe payout.'
          : 'Set the correct total for this day. The original calculated amount is kept; your change is tracked with your note.'}
      </p>
      <label style={{ display: 'block', fontSize: 13, color: MUTED, marginBottom: 6 }}>
        {isBonus ? 'Bonus amount (use a minus sign to deduct)' : 'New amount for this day'}
      </label>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder={isBonus ? '$50.00' : '$0.00'}
        style={{ width: '100%', padding: 8, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', fontSize: 14 }}
      />
      <label style={{ display: 'block', fontSize: 13, color: MUTED, margin: '14px 0 6px' }}>
        Reason (required)
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder={isBonus ? 'e.g., End-of-camp bonus, picked up an extra session…' : 'e.g., Covered an extra hour, rate correction…'}
        style={{ width: '100%', padding: 8, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <ActionButton tone="secondary" onClick={onCancel} disabled={busy}>Cancel</ActionButton>
        <ActionButton tone="primary" onClick={() => onConfirm({ amountCents: cents, reason: reason.trim() })} disabled={!valid || busy}>
          {busy ? 'Saving…' : (isBonus ? 'Add bonus' : 'Save')}
        </ActionButton>
      </div>
    </DrawerShell>
  );
}

// ───────────────────────── Pay drawer (Stripe path) ────────────────────────

// Map pay-instructor's error payload to a user-facing { headline, hint } pair.
// The function returns three fields:
//   - error          (the wrapping code, e.g. 'stripe_transfer_failed')
//   - stripe_code    (the Stripe-side code, e.g. 'balance_insufficient')
//   - stripe_message (Stripe's raw human-ish message)
// or for some errors:
//   - error + detail (our own narrative)
//
// We want operators to see WHY the pay didn't go through and WHAT to do
// about it — not just the wrapping code. This helper is the single source
// of that translation so PayDrawer and MarkPaidDrawer stay consistent.
function formatPayError(data, status) {
  const errCode = data?.error ?? `Server returned ${status ?? '?'}`;
  const stripeCode = data?.stripe_code ?? null;
  const stripeMsg = data?.stripe_message ?? null;
  const detail = data?.detail ?? data?.message ?? null;

  // Wrapping-code → human meaning. For 'stripe_transfer_failed' we dig
  // into stripe_code for the specific Stripe rejection.
  if (errCode === 'stripe_transfer_failed') {
    if (stripeCode === 'balance_insufficient') {
      return {
        headline: 'Not enough available balance in your Stripe account.',
        hint:
          'Stripe may be auto-paying your balance out to your bank before it can be used for instructor pay. Open your Stripe dashboard → Settings → Payouts and switch the schedule to Manual so funds accumulate. The balance settles ~2 days after each parent payment.',
      };
    }
    if (stripeCode === 'insufficient_capabilities_for_transfer') {
      return {
        headline: 'This instructor\'s Stripe Express account isn\'t fully set up to receive transfers.',
        hint:
          'They need to finish Stripe Express onboarding — add their address, SSN last 4, bank account, and accept the Stripe Connect terms. They can do it from their instructor portal (Pay tab → "Open your Stripe Express").',
      };
    }
    return {
      headline: stripeMsg || 'Stripe rejected the transfer.',
      hint: stripeCode ? `Stripe error code: ${stripeCode}.` : null,
    };
  }

  if (errCode === 'instructor_stripe_not_configured') {
    return {
      headline: 'This instructor hasn\'t started Stripe Express onboarding yet.',
      hint: 'Have them complete the wizard in the instructor portal, then try Pay again. Or use "Mark paid manually" if you\'re paying them outside Enrops.',
    };
  }
  if (errCode === 'instructor_stripe_not_ready') {
    return {
      headline: 'Stripe is still verifying this instructor\'s account.',
      hint: detail || 'Try again in a few minutes, or use "Mark paid manually."',
    };
  }
  if (errCode === 'pay_route_not_yet_supported') {
    return {
      headline: 'Stripe-routed instructor pay isn\'t enabled for your organization yet.',
      hint: detail || 'For now, use "Mark paid manually" to record what you paid through your existing system.',
    };
  }
  if (errCode === 'operator_stripe_not_connected') {
    return {
      headline: 'Your organization\'s Stripe account isn\'t connected.',
      hint: 'Go to Receivables in the admin portal and finish Stripe Connect onboarding before paying instructors.',
    };
  }
  if (errCode === 'payout_already_in_flight') {
    return {
      headline: 'A payout for this instructor + camp is already in progress.',
      hint: detail || 'Refresh the page and check the current status before retrying.',
    };
  }
  if (errCode === 'nothing_to_pay') {
    return {
      headline: 'No approved + unpaid days to pay right now.',
      hint: detail || null,
    };
  }
  if (errCode === 'instructor_pay_not_enabled') {
    return {
      headline: 'Instructor pay via Enrops isn\'t enabled for this organization.',
      hint: data?.message || 'Contact Enrops support.',
    };
  }
  if (errCode === 'forbidden') {
    return {
      headline: 'You don\'t have permission to pay instructors here.',
      hint: 'Only org owners and admins can pay. Talk to your account owner.',
    };
  }

  // Unknown / generic — surface whatever we have.
  return {
    headline: detail || stripeMsg || errCode,
    hint: stripeCode ? `Code: ${stripeCode}.` : null,
  };
}

// Compact card showing the formatPayError result inside a drawer.
function PayErrorCard({ payload }) {
  if (!payload) return null;
  return (
    <div
      style={{
        background: 'rgba(181,55,55,0.06)',
        border: '1px solid rgba(181,55,55,0.30)',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: 12,
      }}
    >
      <div style={{ color: RED, fontWeight: 700, fontSize: 13, marginBottom: payload.hint ? 4 : 0 }}>
        {payload.headline}
      </div>
      {payload.hint && (
        <div style={{ color: INK, fontSize: 12, lineHeight: 1.5 }}>{payload.hint}</div>
      )}
    </div>
  );
}

function PayDrawer({ group, onClose, onPaid }) {
  const [busy, setBusy] = useState(false);
  // err can be either a string (generic / network failure) or an object
  // { headline, hint } from formatPayError when the server gave us a
  // structured error to translate.
  const [err, setErr] = useState(null);
  const eligibleAmount = group.eligibleRows.reduce(
    (s, r) => s + (r.pay_amount_cents ?? 0) + (r.pay_adjustment_cents ?? 0), 0,
  );
  const total = eligibleAmount + (group.source === 'regular' && !group.distanceBonusPaid ? group.distanceBonusCents : 0);

  const stripeReady = group.stripePayoutsEnabled && group.stripeDestination;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/pay-instructor`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            effective_instructor_id: group.effective_instructor_id,
            ...(group.kind === 'camp'
              ? { camp_session_id: group.camp_session_id }
              : { program_id: group.program_id }),
            via_stripe: true,
          }),
        },
      );
      const data = await resp.json();
      if (!resp.ok) {
        setErr(formatPayError(data, resp.status));
        setBusy(false);
        return;
      }
      onPaid();
    } catch (e) {
      setErr({ headline: e.message || 'Could not send payment.', hint: null });
      setBusy(false);
    }
  }

  return (
    <DrawerShell title={`Pay ${shortName(group.instructor)}`} onClose={onClose}>
      <div style={{ marginBottom: 10, fontSize: 14, color: INK }}>
        {group.kind === 'camp' ? (
          <>
            <strong>{group.session?.curriculum_name ?? 'Camp'}</strong>
            {group.session?.location_name && <> · {group.session.location_name}</>}
          </>
        ) : (
          <>
            <strong>{group.program?.curriculum ?? 'Program'}</strong>
            {group.school?.name && <> · {group.school.name}</>}
          </>
        )}
      </div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
          <span>Eligible days</span><span>{group.eligibleRows.length}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
          <span>Base pay</span><span>{dollars(eligibleAmount)}</span>
        </div>
        {group.source === 'regular' && group.distanceBonusCents > 0 && !group.distanceBonusPaid && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
            <span>Distance bonus</span><span>+{dollars(group.distanceBonusCents)}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: `1px solid ${RULE}`, fontWeight: 700, fontSize: 15 }}>
          <span>Total</span><span>{dollars(total)}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 14 }}>
        Sending to <span style={{ fontFamily: 'monospace' }}>{group.stripeDestination ?? '—'}</span>
        <br />
        Stripe payouts ready:{' '}
        <span style={{ color: stripeReady ? OK : RED, fontWeight: 600 }}>
          {stripeReady ? '✓ Yes' : '✗ Not yet'}
        </span>
      </div>
      {!stripeReady && (
        <Banner tone="warn">
          This instructor's Stripe Express account isn't fully ready. Have them
          complete onboarding via the instructor portal, or use "Mark paid manually."
        </Banner>
      )}
      <PayErrorCard payload={err} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <ActionButton tone="secondary" onClick={onClose} disabled={busy}>Cancel</ActionButton>
        <ActionButton tone="primary" onClick={submit} disabled={busy || !stripeReady || total === 0}>
          {busy ? 'Sending…' : `Send ${dollars(total)}`}
        </ActionButton>
      </div>
    </DrawerShell>
  );
}

// ───────────────────────── Mark paid manually drawer ──────────────────────

function MarkPaidDrawer({ group, onClose, onMarked }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const eligibleAmount = group.eligibleRows.reduce(
    (s, r) => s + (r.pay_amount_cents ?? 0) + (r.pay_adjustment_cents ?? 0), 0,
  );
  const total = eligibleAmount + (group.source === 'regular' && !group.distanceBonusPaid ? group.distanceBonusCents : 0);

  async function submit() {
    if (note.trim().length === 0) {
      setErr({ headline: 'Note is required — record how you paid (transfer ID, method, etc.)', hint: null });
      return;
    }
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/pay-instructor`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            effective_instructor_id: group.effective_instructor_id,
            ...(group.kind === 'camp'
              ? { camp_session_id: group.camp_session_id }
              : { program_id: group.program_id }),
            via_stripe: false,
            manual_payment_note: note.trim(),
          }),
        },
      );
      const data = await resp.json();
      if (!resp.ok) {
        setErr(formatPayError(data, resp.status));
        setBusy(false);
        return;
      }
      onMarked();
    } catch (e) {
      setErr({ headline: e.message || 'Could not record payment.', hint: null });
      setBusy(false);
    }
  }

  return (
    <DrawerShell title={`Mark paid — ${shortName(group.instructor)}`} onClose={onClose}>
      <p style={{ margin: '0 0 12px', color: INK, fontSize: 14, lineHeight: 1.5 }}>
        Record that you paid this instructor outside Enrops (your own Stripe dashboard,
        Gusto, Venmo, check, etc). No Stripe transfer happens; the days are just
        marked as settled for record-keeping.
      </p>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 12, marginBottom: 14, fontSize: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Marking as paid:</span>
          <strong>{dollars(total)}</strong>
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
          {group.eligibleRows.length} day{group.eligibleRows.length === 1 ? '' : 's'}
          {group.source === 'regular' && group.distanceBonusCents > 0 && !group.distanceBonusPaid && ' + distance bonus'}
        </div>
      </div>
      <label style={{ display: 'block', fontSize: 13, color: MUTED, marginBottom: 6 }}>
        How did you pay them? (required)
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder='e.g., "Stripe dashboard transfer tr_1Abc…", "Gusto run May 30", "Check #1234"'
        style={{ width: '100%', padding: 8, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
      />
      <div style={{ marginTop: err ? 12 : 0 }}><PayErrorCard payload={err} /></div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <ActionButton tone="secondary" onClick={onClose} disabled={busy}>Cancel</ActionButton>
        <ActionButton tone="primary" onClick={submit} disabled={busy || total === 0}>
          {busy ? 'Recording…' : `Mark ${dollars(total)} paid`}
        </ActionButton>
      </div>
    </DrawerShell>
  );
}

// ───────────────────────── Drawer shell ────────────────────────────────────

function DrawerShell({ title, onClose, children }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(28,0,79,0.45)',
        display: 'flex', justifyContent: 'flex-end', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460, background: '#fff', height: '100%',
          padding: 24, boxShadow: '-4px 0 24px rgba(0,0,0,0.2)', overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ margin: 0, color: PURPLE, fontSize: 18, fontWeight: 700 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 22, cursor: 'pointer', padding: 4 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}
