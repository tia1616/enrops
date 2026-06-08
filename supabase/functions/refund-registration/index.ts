// refund-registration — operator-initiated refund of a registration.
//
// Operator types an amount on the Rosters refund drawer; this function
// figures out which PaymentIntent(s) to refund against, calls Stripe with
// the Connect destination-charge flags, and records each refund attempt in
// the refunds table.
//
// Auth: org owner/admin via org_members (role IN owner, admin).
//
// Body: {
//   registration_id: uuid,
//   amount_cents: integer (> 0),
//   reason?: string,                // internal note; not emailed to parent
//   cancel_registration?: boolean,  // also flip status to 'cancelled' + pause future installments
// }
//
// PI walk:
//   1. Collect all paid PaymentIntents for this registration:
//      - installments rows where status='paid', oldest -> newest by installment_number
//      - if none, fall back to registrations.stripe_payment_intent_id
//   2. For each PI, compute refundable = pi_amount_for_this_reg - already_refunded_against_pi_for_this_reg.
//   3. Walk newest-first, refunding from each until amount_cents is consumed.
//   4. If we run out before consuming amount_cents, return 400 'amount_exceeds_eligible'.
//
// Stripe flags per refund call:
//   refund_application_fee: false   // Enrops keeps its fee
//   reverse_transfer: true          // pull money back from the connected account
// These have to be set explicitly — Stripe defaults are the opposite for
// destination charges.
//
// Idempotency: each refunds row gets a fresh ID; the Stripe call uses the
// row ID as the idempotency key so re-running this fn for the same Stripe
// refund attempt is safe (won't double-debit operator).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { logEnrollmentEvent, ENROLLMENT_ACTIONS } from '../_shared/logEnrollmentEvent.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

interface Body {
  registration_id?: string;
  amount_cents?: number;
  reason?: string;
  cancel_registration?: boolean;
}

interface RegistrationRow {
  id: string;
  organization_id: string;
  status: string;
  payment_status: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number | null;
  student_id: string | null;
  parent_id: string | null;
  program_id: string | null;
  camp_session_id: string | null;
}

interface InstallmentRow {
  id: string;
  installment_number: number;
  amount_cents: number;
  status: string;
  stripe_payment_intent_id: string | null;
  paid_at: string | null;
}

interface RefundedAgg {
  payment_intent_id: string;
  total: number;
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
    const registrationId = (body.registration_id || '').trim();
    const amountCents = Number(body.amount_cents);
    const reason = (body.reason || '').toString().slice(0, 500) || null;
    const cancelRegistration = body.cancel_registration === true;

    if (!registrationId) return json({ error: 'missing_registration_id' }, 400);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return json({ error: 'invalid_amount' }, 400);
    }

    // ── load registration ─────────────────────────────────────────────────
    const { data: regData, error: regErr } = await supabase
      .from('registrations')
      .select('id, organization_id, status, payment_status, stripe_payment_intent_id, amount_cents, student_id, parent_id, program_id, camp_session_id')
      .eq('id', registrationId)
      .maybeSingle();
    if (regErr) {
      console.error('[refund] reg lookup failed:', regErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const reg = regData as RegistrationRow | null;
    if (!reg) return json({ error: 'registration_not_found' }, 404);

    // ── authorize caller is owner/admin of that org ───────────────────────
    const { data: cmData } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', reg.organization_id)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cmData) return FORBIDDEN;

    // ── collect paid PIs for this registration ────────────────────────────
    // Pattern: installments table is the primary source. If no installments
    // rows exist (single-pay registration), fall back to registrations.
    const { data: instData } = await supabase
      .from('installments')
      .select('id, installment_number, amount_cents, status, stripe_payment_intent_id, paid_at')
      .eq('registration_id', registrationId);
    const installments = (instData as InstallmentRow[] | null) ?? [];
    const paidInstallments = installments.filter(
      (i) => i.status === 'paid' && i.stripe_payment_intent_id,
    );

    // Build PI list: each entry = (pi_id, amount_for_this_reg, sort_key).
    type PiSlot = { pi: string; amount: number; sortKey: number };
    const piSlots: PiSlot[] = [];

    if (paidInstallments.length > 0) {
      for (const inst of paidInstallments) {
        piSlots.push({
          pi: inst.stripe_payment_intent_id!,
          amount: inst.amount_cents,
          sortKey: inst.installment_number, // newest installment first
        });
      }
    } else if (reg.payment_status === 'paid' && reg.stripe_payment_intent_id) {
      piSlots.push({
        pi: reg.stripe_payment_intent_id,
        amount: reg.amount_cents ?? 0,
        sortKey: 1,
      });
    }

    if (piSlots.length === 0) {
      return json({ error: 'nothing_paid' }, 400);
    }

    // ── compute already-refunded per PI for this registration ─────────────
    const { data: refundedData } = await supabase
      .from('refunds')
      .select('stripe_payment_intent_id, amount_cents')
      .eq('registration_id', registrationId)
      .eq('status', 'succeeded');
    const refundedAgg: Record<string, number> = {};
    for (const row of ((refundedData as RefundedAgg[] | null) ?? [])) {
      const r = row as unknown as { stripe_payment_intent_id: string; amount_cents: number };
      refundedAgg[r.stripe_payment_intent_id] = (refundedAgg[r.stripe_payment_intent_id] || 0) + r.amount_cents;
    }

    // ── eligibility check ─────────────────────────────────────────────────
    const totalPaid = piSlots.reduce((s, p) => s + p.amount, 0);
    const totalRefunded = Object.values(refundedAgg).reduce((s, v) => s + v, 0);
    const eligible = totalPaid - totalRefunded;
    if (amountCents > eligible) {
      return json({
        error: 'amount_exceeds_eligible',
        eligible_cents: eligible,
        total_paid_cents: totalPaid,
        total_refunded_cents: totalRefunded,
      }, 400);
    }

    // ── walk PIs newest-first, refunding from each ────────────────────────
    piSlots.sort((a, b) => b.sortKey - a.sortKey);
    const refundsCreated: Array<{
      refund_row_id: string;
      stripe_refund_id: string | null;
      amount_cents: number;
      payment_intent_id: string;
      status: string;
    }> = [];
    let remaining = amountCents;

    for (const slot of piSlots) {
      if (remaining <= 0) break;
      const alreadyOnPi = refundedAgg[slot.pi] || 0;
      const availableOnPi = slot.amount - alreadyOnPi;
      if (availableOnPi <= 0) continue;
      const refundThisPi = Math.min(remaining, availableOnPi);

      // Insert pending row first so we have an ID for idempotency
      const { data: rowData, error: insErr } = await supabase
        .from('refunds')
        .insert({
          registration_id: registrationId,
          organization_id: reg.organization_id,
          stripe_payment_intent_id: slot.pi,
          amount_cents: refundThisPi,
          reason,
          refunded_by_user_id: callerAuthId,
          cancelled_registration: cancelRegistration,
          status: 'pending',
        })
        .select('id')
        .single();
      if (insErr || !rowData) {
        console.error('[refund] failed to insert refunds row:', insErr);
        return json({
          error: 'refund_row_insert_failed',
          partial: refundsCreated.length > 0 ? refundsCreated : undefined,
        }, 500);
      }
      const refundRowId = (rowData as { id: string }).id;

      try {
        const stripeRefund = await stripe.refunds.create(
          {
            payment_intent: slot.pi,
            amount: refundThisPi,
            // Enrops keeps its application fee on refunds — this is the spec'd
            // behavior and matches Stripe's default for destination charges
            // (this flag would only matter if it were true).
            refund_application_fee: false,
            // Pull the refunded share back from the operator's connected
            // account. Without this, refund comes out of platform balance only.
            reverse_transfer: true,
            reason: 'requested_by_customer',
            metadata: {
              enrops_refund_id: refundRowId,
              enrops_registration_id: registrationId,
              enrops_org_id: reg.organization_id,
              ...(reason ? { enrops_reason: reason.slice(0, 200) } : {}),
            },
          },
          { idempotencyKey: `refund_${refundRowId}` },
        );

        const succeededAt = new Date().toISOString();
        const { error: updErr } = await supabase
          .from('refunds')
          .update({
            stripe_refund_id: stripeRefund.id,
            status: 'succeeded',
            succeeded_at: succeededAt,
          })
          .eq('id', refundRowId);
        if (updErr) {
          console.error('[refund] succeeded but row update failed:', updErr);
        }

        refundsCreated.push({
          refund_row_id: refundRowId,
          stripe_refund_id: stripeRefund.id,
          amount_cents: refundThisPi,
          payment_intent_id: slot.pi,
          status: 'succeeded',
        });
        remaining -= refundThisPi;
      } catch (err) {
        const stripeErr = err as { message?: string; raw?: { message?: string; code?: string } };
        const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
        const errCode = stripeErr.raw?.code ?? 'unknown';
        console.error('[refund] stripe.refunds.create failed:', errCode, errMsg);
        await supabase
          .from('refunds')
          .update({ status: 'failed', failure_reason: `${errCode}: ${errMsg}` })
          .eq('id', refundRowId);
        return json({
          error: 'stripe_refund_failed',
          stripe_code: errCode,
          stripe_message: errMsg,
          partial: refundsCreated.length > 0 ? refundsCreated : undefined,
        }, 502);
      }
    }

    if (remaining > 0) {
      // Shouldn't happen — we pre-checked eligibility. But guard anyway.
      console.error(`[refund] inconsistency: ${remaining} cents remaining after walking all PIs`);
    }

    // ── advance registrations.payment_status ──────────────────────────────
    // After this refund pass, compute the new total refunded against this
    // registration. If we've now refunded the entire eligible amount, the
    // registration is 'refunded'. Otherwise 'partial'. (Eligible = totalPaid
    // pre-this-call; we just consumed (amountCents - remaining) of it.)
    const newTotalRefunded = totalRefunded + (amountCents - remaining);
    const newPaymentStatus =
      newTotalRefunded >= totalPaid ? 'refunded' :
      newTotalRefunded > 0          ? 'partial'  :
      reg.payment_status;
    if (newPaymentStatus && newPaymentStatus !== reg.payment_status) {
      const { error: psErr } = await supabase
        .from('registrations')
        .update({ payment_status: newPaymentStatus })
        .eq('id', registrationId);
      if (psErr) {
        console.warn('[refund] payment_status update failed (non-fatal):', psErr);
      }
    }

    // ── optionally cancel the registration ────────────────────────────────
    if (cancelRegistration) {
      const nowIso = new Date().toISOString();
      const { error: cancErr } = await supabase
        .from('registrations')
        .update({
          status: 'cancelled',
          cancelled_at: nowIso,
        })
        .eq('id', registrationId);
      if (cancErr) {
        console.error('[refund] registration cancel failed:', cancErr);
        // Refunds already went through; surface a soft error so operator
        // knows to retry the cancel manually.
        return json({
          error: 'cancel_failed_after_refund',
          refunds: refundsCreated,
          cancel_error: cancErr.message,
        }, 500);
      }

      // Pause any pending future installments. Use the existing
      // 'paused_program_cancelled' status (defined in the installments CHECK
      // constraint) so process-installments leaves them alone.
      const { error: pauseErr } = await supabase
        .from('installments')
        .update({ status: 'paused_program_cancelled', last_attempt_at: nowIso })
        .eq('registration_id', registrationId)
        .eq('status', 'pending');
      if (pauseErr) {
        console.warn('[refund] pause pending installments failed (non-fatal):', pauseErr);
      }
    }

    // ── intelligence layer (fail-safe; never blocks the refund) ───────────
    // A refund — and especially a withdrawal — is a real churn signal worth
    // capturing. logEnrollmentEvent swallows its own errors.
    const refundedThisCall = refundsCreated.reduce((s, r) => s + r.amount_cents, 0);
    const eventBase = {
      organizationId: reg.organization_id,
      parentId: reg.parent_id,
      studentId: reg.student_id,
      programId: reg.program_id,
      campSessionId: reg.camp_session_id,
      registrationId: registrationId,
    };
    await logEnrollmentEvent(supabase, {
      ...eventBase,
      actionType: ENROLLMENT_ACTIONS.REFUNDED,
      metadata: {
        amount_refunded_cents: refundedThisCall,
        total_refunded_cents: newTotalRefunded,
        total_paid_cents: totalPaid,
        partial: newTotalRefunded < totalPaid,
        withdrew: cancelRegistration,
      },
      dedupeKey: `refunded:${refundsCreated.map((r) => r.refund_row_id).join('_')}`,
    });
    if (cancelRegistration) {
      await logEnrollmentEvent(supabase, {
        ...eventBase,
        actionType: ENROLLMENT_ACTIONS.CANCELLED,
        metadata: { via: 'refund' },
        dedupeKey: `cancelled:${registrationId}`,
      });
    }

    return json({
      success: true,
      refunds: refundsCreated,
      total_refunded_cents: refundedThisCall,
      cancelled: cancelRegistration,
    });
  } catch (err) {
    console.error('[refund] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
