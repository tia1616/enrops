// admin-confirm-session — an org admin/owner confirms a session-delivery day on
// an instructor's behalf and makes it payable.
//
// WHY: instructors self-confirm their own days ("Mark taught" →
// confirm-session-delivery). Auto-confirm was removed 2026-07-11, so a day an
// instructor forgets to confirm stays pending forever and is never payable.
// This function is the admin escape hatch: from the Payroll screen an admin
// clicks "Confirm & pay" on an unconfirmed day and we settle it exactly the way
// a self-confirm would — same per-tenant rate, same substitution routing — but
// stamped confirmed_by='admin' + admin_override audit so it's clear a human
// admin (not the instructor, not the old auto job) made the call.
//
// Pay parity is the whole point: the amount an admin confirm writes MUST equal
// what the instructor's own confirm would have written for the same day. Both
// paths resolve pay from tenant_pay_rates via _shared/payRates.ts. Substitution
// routing mirrors the old Job B: if a confirmed/taught sub covered THIS day, we
// price the day at the SUB's tier (the pay-line view already routes the payee to
// the sub), so the sub — not the absent regular — is paid the right amount.
//
// Auth: caller must be owner/admin on the confirmation's organization
// (org_members, accepted). This is NOT an instructor endpoint.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { resolvePayAmount } from '../_shared/payRates.ts';

type Role = 'lead' | 'developing';

interface Body {
  confirmation_id?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── auth: verify caller JWT ───────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // ── input ─────────────────────────────────────────────────────────────
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const confirmationId = body.confirmation_id?.trim();
    if (!confirmationId) return json({ error: 'confirmation_id_required' }, 400);

    // ── load the confirmation row ─────────────────────────────────────────
    const { data: row, error: rowErr } = await supabase
      .from('session_delivery_confirmations')
      .select(
        'id, instructor_id, organization_id, camp_session_id, program_id, session_date, session_type, confirmed_by, admin_override, instructor_payout_id',
      )
      .eq('id', confirmationId)
      .maybeSingle();
    if (rowErr) {
      console.error('[admin-confirm-session] confirmation lookup failed:', rowErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!row) return json({ error: 'confirmation_not_found' }, 404);

    // ── auth scope: caller is owner/admin on THIS confirmation's org ──────
    const { data: cm } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', row.organization_id)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cm) return json({ error: 'forbidden' }, 403);

    // ── guards ────────────────────────────────────────────────────────────
    // Already settled by a payout — never touch a paid line.
    if (row.instructor_payout_id) {
      return json({ error: 'already_paid' }, 409);
    }
    // Already confirmed (self / auto / a prior admin confirm) — idempotent no-op.
    if (row.confirmed_by !== 'pending') {
      return json({ error: 'already_confirmed', confirmed_by: row.confirmed_by }, 409);
    }
    // Can't confirm a day that hasn't happened yet.
    const today = new Date().toISOString().slice(0, 10);
    if (row.session_date > today) {
      return json({ error: 'future_session', session_date: row.session_date }, 400);
    }
    if (!row.camp_session_id && !row.program_id) {
      console.warn('[admin-confirm-session] confirmation has neither camp_session_id nor program_id', {
        confirmation_id: confirmationId,
      });
      return json({ error: 'invalid_confirmation_no_parent' }, 400);
    }

    // ── resolve the effective tier (substitution-aware) ───────────────────
    // Default tier is the assigned instructor's per-engagement role. If a
    // confirmed/taught sub covered THIS assignment on THIS date, the day is
    // priced at the sub's tier (the pay-line view routes the payee to the sub).
    const kind: 'camp' | 'program' = row.camp_session_id ? 'camp' : 'program';

    let assignmentId: string | null = null;
    let assignmentStatus: string | null = null;
    let tier: Role | null = null;

    if (kind === 'camp') {
      const { data: assignment, error: aErr } = await supabase
        .from('camp_assignments')
        .select('id, role, status')
        .eq('camp_session_id', row.camp_session_id)
        .eq('instructor_id', row.instructor_id)
        .maybeSingle();
      if (aErr) {
        console.error('[admin-confirm-session] camp_assignments lookup failed:', aErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      assignmentId = assignment?.id ?? null;
      assignmentStatus = assignment?.status ?? null;
      tier = (assignment?.role as Role) ?? null;
    } else {
      const { data: assignment, error: aErr } = await supabase
        .from('program_assignments')
        .select('id, role, status')
        .eq('program_id', row.program_id!)
        .eq('instructor_id', row.instructor_id)
        .maybeSingle();
      if (aErr) {
        console.error('[admin-confirm-session] program_assignments lookup failed:', aErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      assignmentId = assignment?.id ?? null;
      assignmentStatus = assignment?.status ?? null;
      tier = (assignment?.role as Role) ?? null;
    }

    // No assignment → we can't determine the pay tier. Don't guess; the admin
    // should fix the assignment or withhold the day instead.
    if (!assignmentId || (tier !== 'lead' && tier !== 'developing')) {
      return json({ error: 'no_assignment_for_session' }, 400);
    }

    // Substitution override: price at the sub's tier when a sub covered the day.
    // (Same status filter as v_effective_pay_lines, which routes the payee to
    // the sub only for 'confirmed'/'taught' — so amount and payee stay in sync.)
    const { data: sub, error: subErr } = await supabase
      .from('assignment_substitutions')
      .select('sub_tier')
      .eq('parent_assignment_id', assignmentId)
      .eq('parent_assignment_type', kind)
      .eq('date', row.session_date)
      .in('status', ['confirmed', 'taught'])
      .maybeSingle();
    if (subErr) {
      console.error('[admin-confirm-session] substitution lookup failed:', subErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (sub && (sub.sub_tier === 'lead' || sub.sub_tier === 'developing')) {
      tier = sub.sub_tier as Role;
    }

    // Guard: don't confirm & pay a day whose regular assignment was withdrawn
    // or declined — the instructor is no longer on it. A sub who covered the
    // day is still paid (they taught it); the guard only applies when there's
    // no sub, so the payee would be the off-assignment regular. This is the
    // pay-safety check the old auto-confirm never had; the admin can fix the
    // assignment or leave the day unconfirmed instead.
    if (!sub && (assignmentStatus === 'withdrawn' || assignmentStatus === 'declined')) {
      return json({ error: 'assignment_not_active', status: assignmentStatus }, 409);
    }

    // ── per-tenant pay ────────────────────────────────────────────────────
    // null when the tenant hasn't configured this (role, session_type) cell —
    // we still confirm the day and the admin sets the amount on Payroll (same
    // graceful-null behavior as the self-confirm path).
    const payCents = await resolvePayAmount(supabase, row.organization_id, tier, row.session_type);

    // ── write (race-guarded) ──────────────────────────────────────────────
    // .eq('confirmed_by','pending') so a self-confirm that lands between our
    // read and write wins and we don't clobber it. 0 rows back = lost the race.
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from('session_delivery_confirmations')
      .update({
        confirmed_by: 'admin',
        confirmed_at: nowIso,
        pay_status: 'approved',
        pay_amount_cents: payCents,
        admin_override: true,
        admin_override_by: callerAuthId,
        admin_override_at: nowIso,
        admin_override_reason: 'Admin confirmed session on instructor behalf',
        updated_at: nowIso,
      })
      .eq('id', confirmationId)
      .eq('confirmed_by', 'pending')
      .select('id')
      .maybeSingle();

    if (updErr) {
      console.error('[admin-confirm-session] update failed:', updErr);
      return json({ error: 'update_failed' }, 500);
    }
    if (!updated) {
      // Someone confirmed it between our read and write.
      return json({ error: 'already_confirmed' }, 409);
    }

    return json({
      success: true,
      confirmation_id: confirmationId,
      pay_amount_cents: payCents,
      tier,
      session_type: row.session_type,
      was_sub: Boolean(sub),
    });
  } catch (err) {
    console.error('[admin-confirm-session] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
