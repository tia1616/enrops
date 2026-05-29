// pay-instructor — operator settles instructor pay for one (effective
// instructor, camp_session) bucket. Two payment paths × two architectures:
//
//   via_stripe=true   → call stripe.transfers.create. WHICH platform key +
//                       WHICH balance the transfer comes from depends on
//                       org.instructor_pay_model:
//
//     'legacy_own_platform' (J2S): operator owns their own Stripe Connect
//       platform; STRIPE_INSTRUCTOR_PLATFORM_KEY points there. Transfer
//       leaves the operator's platform-balance to the instructor's Express
//       account (also under that platform). No stripeAccount header.
//
//     'enrops_platform' (default): Enrops is the Connect platform.
//       Operator is a connected account under Enrops; instructor is also a
//       connected account under Enrops. Transfer is created with the
//       stripeAccount header set to the operator's Enrops-connected account
//       — money moves from operator's available balance (post-fee, from
//       parent payments) to instructor's balance. STRIPE_SECRET_KEY.
//
//   via_stripe=false  → no Stripe call; just record what the operator paid
//                       outside Enrops (Gusto / dashboard / Venmo / check /
//                       etc). Required: manual_payment_note. Pay-model
//                       agnostic.
//
// Auth: caller is org owner/admin for the EFFECTIVE instructor's org.
// Multi-tenant gate: org.instructor_pay_enabled MUST be true (locked via
// trigger so only platform admin can flip it).
//
// Idempotency: a UNIQUE PARTIAL INDEX on
// (instructor_id, camp_session_id) WHERE status IN ('pending','succeeded')
// prevents the double-pay race. Concurrent clicks → second INSERT fails
// with 23505 → we return 409 cleanly. Stripe-side idempotency key is
// `payout_${payoutId}` so retries against either platform stay safe.
//
// Resolver-aware: we read from v_effective_pay_lines, which already
// resolves sub vs regular and exposes effective_instructor_id, effective_
// tier, source. Distance bonus is paid ONLY when source='regular' AND
// distance_bonus_paid_at IS NULL AND there's at least one eligible row
// (subs don't earn distance bonus).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

type InstructorPayModel = 'legacy_own_platform' | 'enrops_platform';

// Per-request Stripe client. The platform key we use depends on which
// architecture this org runs. See file header for the full rationale.
function getInstructorPlatformStripe(model: InstructorPayModel): Stripe {
  const key = model === 'legacy_own_platform'
    ? Deno.env.get('STRIPE_INSTRUCTOR_PLATFORM_KEY')
    : Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) {
    throw new Error(
      `missing Stripe key for instructor_pay_model='${model}' — set ${
        model === 'legacy_own_platform' ? 'STRIPE_INSTRUCTOR_PLATFORM_KEY' : 'STRIPE_SECRET_KEY'
      }`,
    );
  }
  return new Stripe(key, {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

interface Body {
  effective_instructor_id?: string;
  camp_session_id?: string;
  program_id?: string;
  via_stripe?: boolean;
  manual_payment_note?: string;
}

interface PayLineRow {
  confirmation_id: string;
  effective_instructor_id: string;
  effective_tier: string | null;
  source: 'regular' | 'sub';
  pay_amount_cents: number | null;
  pay_adjustment_cents: number | null;
  pay_status: string;
  instructor_payout_id: string | null;
  confirmed_by: string | null;
  camp_assignment_id: string | null;
  camp_assignment_status: string | null;
  program_assignment_id: string | null;
  program_assignment_status: string | null;
  distance_bonus_cents_if_regular: number | null;
  distance_bonus_paid_at: string | null;
  organization_id: string;
}

interface InstructorOnboardingRow {
  stripe_connect_account_id: string | null;
  stripe_payouts_enabled: boolean | null;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // ── input ─────────────────────────────────────────────────────────────
    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      return json({ error: 'invalid_body' }, 400);
    }
    const effectiveInstructorId = (body.effective_instructor_id || '').trim();
    const campSessionId = (body.camp_session_id || '').trim();
    const programId     = (body.program_id     || '').trim();
    const viaStripe = body.via_stripe !== false; // default true
    const manualNote = (body.manual_payment_note || '').toString().trim();

    if (!effectiveInstructorId) return json({ error: 'missing_effective_instructor_id' }, 400);
    // Exactly one target: camp_session_id (camp) XOR program_id (afterschool).
    if (!campSessionId && !programId) {
      return json({ error: 'missing_target', detail: 'Provide either camp_session_id or program_id.' }, 400);
    }
    if (campSessionId && programId) {
      return json({ error: 'ambiguous_target', detail: 'Provide camp_session_id OR program_id, not both.' }, 400);
    }
    const kind: 'camp' | 'program' = campSessionId ? 'camp' : 'program';
    if (!viaStripe && manualNote.length === 0) {
      return json({ error: 'manual_payment_note_required' }, 400);
    }

    // ── load effective instructor + their org ─────────────────────────────
    const { data: instructorData, error: instErr } = await supabase
      .from('instructors')
      .select('id, organization_id, first_name, last_name')
      .eq('id', effectiveInstructorId)
      .maybeSingle();
    if (instErr) {
      console.error('[pay-instructor] instructor lookup failed:', instErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const instructor = instructorData as { id: string; organization_id: string; first_name: string | null; last_name: string | null } | null;
    if (!instructor) return json({ error: 'instructor_not_found' }, 404);

    // ── auth scope: caller is owner/admin on this instructor's org ────────
    const { data: cm } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', instructor.organization_id)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cm) return FORBIDDEN;

    // ── circuit breaker + dispatch fields ─────────────────────────────────
    const { data: orgRow, error: orgErr } = await supabase
      .from('organizations')
      .select('instructor_pay_enabled, instructor_pay_model, stripe_account_id, alert_email, name')
      .eq('id', instructor.organization_id)
      .maybeSingle();
    if (orgErr || !orgRow) {
      console.error('[pay-instructor] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgRow as {
      instructor_pay_enabled: boolean;
      instructor_pay_model: InstructorPayModel | null;
      stripe_account_id: string | null;
      alert_email: string | null;
      name: string | null;
    };
    if (!org.instructor_pay_enabled) {
      return json({
        error: 'instructor_pay_not_enabled',
        message: 'Instructor pay via Enrops is not enabled for this organization. Contact support.',
      }, 403);
    }

    // Default to enrops_platform if column somehow null (NOT NULL DEFAULT in DB).
    const payModel: InstructorPayModel =
      org.instructor_pay_model === 'legacy_own_platform' ? 'legacy_own_platform' : 'enrops_platform';

    // Build the Stripe client lazily — only the via_stripe path needs it,
    // but resolve here so we surface platform misconfig before we touch the DB.
    let stripe: Stripe | null = null;
    try {
      stripe = getInstructorPlatformStripe(payModel);
    } catch (err) {
      console.error('[pay-instructor] stripe client init failed:', err);
      if (body.via_stripe !== false) {
        return json({ error: 'platform_misconfigured', detail: (err as Error).message }, 500);
      }
      // Manual path doesn't need Stripe — keep going with stripe=null.
    }

    // ── load eligible pay-lines via the resolver view ─────────────────────
    // The view exposes effective_instructor_id, source, pay_amount_cents,
    // pay_adjustment_cents, confirmed_by, camp_assignment_status, and
    // distance_bonus_cents_if_regular (NULL for sub rows by design).
    const payLinesBase = supabase
      .from('v_effective_pay_lines')
      .select(`
        confirmation_id, effective_instructor_id, effective_tier, source,
        pay_amount_cents, pay_adjustment_cents, pay_status,
        instructor_payout_id, confirmed_by,
        camp_assignment_id, camp_assignment_status,
        program_assignment_id, program_assignment_status,
        distance_bonus_cents_if_regular, distance_bonus_paid_at,
        organization_id
      `)
      .eq('effective_instructor_id', effectiveInstructorId);
    const { data: payLinesData, error: linesErr } = kind === 'camp'
      ? await payLinesBase.eq('camp_session_id', campSessionId)
      : await payLinesBase.eq('program_id', programId);
    if (linesErr) {
      console.error('[pay-instructor] pay lines fetch failed:', linesErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const allRows = (payLinesData as PayLineRow[] | null) ?? [];

    // Filter to eligible rows. The view's source filter is informational;
    // this is the safety filter that decides what actually gets paid.
    const eligible = allRows.filter((r) =>
      r.pay_status === 'approved' &&
      r.instructor_payout_id === null &&
      r.confirmed_by !== null &&
      r.confirmed_by !== 'pending' &&
      r.pay_amount_cents !== null &&
      r.pay_amount_cents >= 0 &&
      (r.camp_assignment_status === null || r.camp_assignment_status !== 'cancelled') &&
      r.organization_id === instructor.organization_id // defensive cross-org check
    );

    if (eligible.length === 0) {
      return json({
        error: 'nothing_to_pay',
        detail: kind === 'camp'
          ? 'No approved + un-paid pay lines for this instructor and camp.'
          : 'No approved + un-paid pay lines for this instructor and program.',
      }, 400);
    }

    // ── distance bonus eligibility ────────────────────────────────────────
    // Pay distance bonus when: source='regular' AND there's at least one
    // eligible row from this assignment (regular instructor actually taught
    // something) AND distance_bonus_paid_at IS NULL AND
    // distance_bonus_cents > 0.
    // Pick the bonus from any eligible row in the group (they all share the
    // same parent assignment and thus the same bonus value). The parent
    // assignment id we mark afterward depends on kind.
    const firstRegular = eligible.find((r) => r.source === 'regular');
    let distanceBonusCents = 0;
    let includesDistanceBonus = false;
    let campAssignmentIdForBonus: string | null = null;
    let programAssignmentIdForBonus: string | null = null;
    if (
      firstRegular &&
      firstRegular.distance_bonus_paid_at === null &&
      firstRegular.distance_bonus_cents_if_regular !== null &&
      firstRegular.distance_bonus_cents_if_regular > 0
    ) {
      distanceBonusCents = firstRegular.distance_bonus_cents_if_regular;
      includesDistanceBonus = true;
      campAssignmentIdForBonus    = firstRegular.camp_assignment_id;
      programAssignmentIdForBonus = firstRegular.program_assignment_id;
    }

    // ── sum ───────────────────────────────────────────────────────────────
    const baseSum = eligible.reduce(
      (s, r) => s + (r.pay_amount_cents ?? 0) + (r.pay_adjustment_cents ?? 0),
      0,
    );
    const totalCents = baseSum + distanceBonusCents;

    if (totalCents <= 0) {
      return json({ error: 'nothing_to_pay', detail: 'Total amount is zero.' }, 400);
    }

    // ── look up Stripe destination acct + payouts_enabled (only for via_stripe) ──
    let stripeDestinationAccountId = ''; // also recorded for manual rows for audit
    let payoutsEnabled = false;
    {
      const { data: onb } = await supabase
        .from('contractor_onboarding_status')
        .select('stripe_connect_account_id, stripe_payouts_enabled')
        .eq('instructor_id', effectiveInstructorId)
        .maybeSingle();
      const o = onb as InstructorOnboardingRow | null;
      stripeDestinationAccountId = o?.stripe_connect_account_id || '';
      payoutsEnabled = o?.stripe_payouts_enabled === true;
    }

    if (viaStripe) {
      if (!stripeDestinationAccountId) {
        return json({ error: 'instructor_stripe_not_configured' }, 409);
      }
      if (!payoutsEnabled) {
        return json({ error: 'instructor_stripe_not_ready', detail: 'Stripe payouts not yet enabled for this instructor.' }, 409);
      }
      // SAFETY NET (v1): the enrops_platform code path is drafted but not
      // yet tested end-to-end. Refuse via_stripe for this route until v2.
      // Only J2S (legacy_own_platform) actually exercises Stripe pay today;
      // every other tenant uses manual mode (via_stripe=false). If a future
      // me accidentally flips instructor_pay_enabled=true on a non-J2S tenant,
      // this stops a cold code path from firing against real money.
      if (payModel === 'enrops_platform') {
        return json({
          error: 'pay_route_not_yet_supported',
          detail: 'Stripe-routed instructor pay through Enrops\'s platform is on the v2 roadmap. Use manual mode for now: record what you paid through your existing pay system.',
        }, 501);
      }
      // enrops_platform path: money moves from the operator's Enrops-connected
      // account balance. If the operator hasn't connected (or their account
      // was disconnected), we have no source — surface a clear error instead
      // of a cryptic Stripe failure. (Unreachable while the safety net above
      // is in place; kept for when v2 removes it.)
      if (payModel === 'enrops_platform' && !org.stripe_account_id) {
        return json({
          error: 'operator_stripe_not_connected',
          detail: 'Connect your organization\'s Stripe account before paying instructors.',
        }, 409);
      }
    }

    // ── pre-insert payout row (status=pending) ────────────────────────────
    // Unique partial index on (instructor_id, camp_session_id) WHERE
    // status IN ('pending','succeeded') is the double-pay guard.
    const confirmationIds = eligible.map((r) => r.confirmation_id);
    const { data: rowData, error: insErr } = await supabase
      .from('instructor_payouts')
      .insert({
        organization_id: instructor.organization_id,
        instructor_id: effectiveInstructorId,
        camp_session_id: kind === 'camp'    ? campSessionId : null,
        program_id:      kind === 'program' ? programId     : null,
        stripe_destination_account_id: stripeDestinationAccountId || 'manual',
        amount_cents: totalCents,
        session_confirmation_ids: confirmationIds,
        includes_distance_bonus: includesDistanceBonus,
        via_stripe: viaStripe,
        manual_payment_note: viaStripe ? null : manualNote.slice(0, 1000),
        paid_by_user_id: callerAuthId,
        status: 'pending',
      })
      .select('id')
      .single();
    if (insErr || !rowData) {
      const code = (insErr as { code?: string } | null)?.code;
      if (code === '23505') {
        // Unique partial index hit — one guard for camp, parallel guard for program.
        return json({
          error: 'payout_already_in_flight',
          detail: kind === 'camp'
            ? 'A pending or succeeded payout already exists for this instructor on this camp. Refresh and try again.'
            : 'A pending or succeeded payout already exists for this instructor on this program. Refresh and try again.',
        }, 409);
      }
      console.error('[pay-instructor] payout row insert failed:', insErr);
      return json({ error: 'payout_row_insert_failed', detail: insErr?.message }, 500);
    }
    const payoutId = (rowData as { id: string }).id;

    const nowIso = new Date().toISOString();

    // ── branch on path ────────────────────────────────────────────────────
    if (viaStripe) {
      if (!stripe) {
        // Defensive — we returned earlier on init failure for the via_stripe
        // path, so this is unreachable. Keeps the type checker happy.
        return json({ error: 'platform_misconfigured' }, 500);
      }
      let transfer: Stripe.Transfer;
      try {
        const targetSuffix = kind === 'camp'
          ? `camp ${campSessionId.slice(0, 8)}`
          : `program ${programId.slice(0, 8)}`;
        const transferParams: Stripe.TransferCreateParams = {
          amount: totalCents,
          currency: 'usd',
          destination: stripeDestinationAccountId,
          transfer_group: `enrops_payout_${payoutId}`,
          description: `Instructor pay — ${instructor.first_name ?? ''} ${instructor.last_name ?? ''} — ${targetSuffix}`,
          metadata: {
            enrops_payout_id: payoutId,
            enrops_effective_instructor_id: effectiveInstructorId,
            enrops_camp_session_id: kind === 'camp'    ? campSessionId : '',
            enrops_program_id:      kind === 'program' ? programId     : '',
            enrops_org_id: instructor.organization_id,
            enrops_session_confirmation_count: String(confirmationIds.length),
            enrops_includes_distance_bonus: includesDistanceBonus ? 'true' : 'false',
            enrops_instructor_pay_model: payModel,
          },
        };
        // Dispatch on architecture:
        //   legacy_own_platform → no stripeAccount header. Transfer leaves
        //     the operator-owned platform's balance.
        //   enrops_platform → stripeAccount = operator's Enrops-connected
        //     account. Transfer is executed AS that account, so funds come
        //     out of that account's balance and land in the instructor's
        //     Express account (also under Enrops). Both legs stay tenant-
        //     scoped: J2S's Stripe can never touch another tenant's account.
        const requestOptions: Stripe.RequestOptions = {
          idempotencyKey: `payout_${payoutId}`,
        };
        if (payModel === 'enrops_platform') {
          requestOptions.stripeAccount = org.stripe_account_id!;
        }
        transfer = await stripe.transfers.create(transferParams, requestOptions);
      } catch (err) {
        const stripeErr = err as { message?: string; raw?: { message?: string; code?: string } };
        const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
        const errCode = stripeErr.raw?.code ?? 'unknown';
        console.error('[pay-instructor] stripe.transfers.create failed:', errCode, errMsg);
        await supabase
          .from('instructor_payouts')
          .update({ status: 'failed', failure_reason: `${errCode}: ${errMsg}` })
          .eq('id', payoutId);
        return json({
          error: 'stripe_transfer_failed',
          stripe_code: errCode,
          stripe_message: errMsg,
        }, 502);
      }

      // ── mark payout succeeded + flip confirmations ────────────────────
      // From here on, money has moved. DB failures get logged loudly but we
      // return success-ish (and leave the row for manual reconciliation).
      const { error: updErr } = await supabase
        .from('instructor_payouts')
        .update({
          stripe_transfer_id: transfer.id,
          status: 'succeeded',
          succeeded_at: nowIso,
        })
        .eq('id', payoutId);
      if (updErr) {
        console.error('[pay-instructor] CRITICAL: stripe succeeded but payout row update failed:', updErr);
        // Don't return error to client — money moved. Flag for manual fix.
      }
    } else {
      // Manual path: just record the payout as succeeded with the note.
      await supabase
        .from('instructor_payouts')
        .update({
          status: 'succeeded',
          succeeded_at: nowIso,
        })
        .eq('id', payoutId);
    }

    // ── flip confirmations + distance bonus marker ─────────────────────────
    const { error: confErr } = await supabase
      .from('session_delivery_confirmations')
      .update({
        pay_status: 'paid',
        instructor_payout_id: payoutId,
      })
      .in('id', confirmationIds);
    if (confErr) {
      console.warn('[pay-instructor] confirmations update failed (non-fatal):', confErr);
    }

    if (includesDistanceBonus && kind === 'camp' && campAssignmentIdForBonus) {
      const { error: caErr } = await supabase
        .from('camp_assignments')
        .update({
          distance_bonus_paid_at: nowIso,
          distance_bonus_payout_id: payoutId,
        })
        .eq('id', campAssignmentIdForBonus);
      if (caErr) {
        console.warn('[pay-instructor] camp_assignments update failed (non-fatal):', caErr);
      }
    }
    if (includesDistanceBonus && kind === 'program' && programAssignmentIdForBonus) {
      const { error: paErr } = await supabase
        .from('program_assignments')
        .update({
          distance_bonus_paid_at: nowIso,
          distance_bonus_payout_id: payoutId,
        })
        .eq('id', programAssignmentIdForBonus);
      if (paErr) {
        console.warn('[pay-instructor] program_assignments update failed (non-fatal):', paErr);
      }
    }

    return json({
      ok: true,
      payout_id: payoutId,
      amount_cents: totalCents,
      includes_distance_bonus: includesDistanceBonus,
      session_confirmation_count: confirmationIds.length,
      via_stripe: viaStripe,
    });
  } catch (err) {
    console.error('[pay-instructor] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
