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
// Stripe flags per refund call — these have to be set explicitly, because
// Stripe's defaults are wrong for both models:
//
//   DESTINATION org (J2S + every pre-existing org):
//     refund_application_fee: false      // see below — always, on both models
//     reverse_transfer: true             // pull money back from the connected account
//     ...created on the PLATFORM (no Stripe-Account header).
//
//   DIRECT charge (Phase 2, controller-based accounts):
//     created ON the connected account (Stripe-Account header).
//     refund_application_fee: false      // see below — always, on both models
//     reverse_transfer                   // OMITTED — no transfer exists to reverse
//
// refund_application_fee is FALSE on both models and the fee refund is issued
// explicitly via applicationFees.createRefund, because Arielle's v4 section 2
// prorates our fee to SESSIONS REMAINING and Stripe's boolean cannot express
// that — it prorates to the charge. Stripe documents this exact alternative:
// "provide a refund_application_fee value of false and refund the application
// fee separately". The ApplicationFee is a platform object on both models, so
// that second call is platform-scoped even for a direct charge.
//
// Which of the two applies is decided PER PAYMENT INTENT from the
// stripe_charge_account_id recorded when that charge was made (null = platform),
// never from the org's CURRENT stripe_charge_model. An operator moving to direct
// charges gets a brand-new connected account, so their older PaymentIntents stay
// on the platform forever; scoping by the current model would break every
// historical refund.
//
// How much of our fee comes back, on both models:
//   base      = the part of the application fee that is actually ours to give
//               back (_shared/refundFeeSplit.ts — the whole fee on a direct
//               charge, fee minus Stripe's real fee on a destination charge)
//   x share   = this registration's share of the charge being refunded
//   x % left  = sessions remaining / total sessions
//               (_shared/refundFeeProration.ts — Arielle's v4 section 2)
// Nothing here can reduce what the FAMILY gets back. v4 section 2: "Never
// reduce it to cover Stripe's or Enrops' fees — card network rules prohibit
// shorting the cardholder."
//
// This function is only ONE of the two entry points. An operator with a full
// Stripe dashboard can refund there instead, and v4 section 3 requires that to
// come out the same — stripe-webhook's charge.refunded handler reuses the same
// two shared modules for exactly that reason.
//
// Idempotency: each refunds row gets a fresh ID; the Stripe call uses the
// row ID as the idempotency key so re-running this fn for the same Stripe
// refund attempt is safe (won't double-debit operator).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { logEnrollmentEvent, ENROLLMENT_ACTIONS } from '../_shared/logEnrollmentEvent.ts';
import { computeMarginRefund } from '../_shared/refundFeeSplit.ts';
import { loadProration } from '../_shared/refundFeeProration.ts';
import { readChargeFeeFacts } from '../_shared/chargeFeeFacts.ts';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import { isEmailAllowed } from '../_shared/emailGuard.ts';
import { sendRefundReceipt } from '../_shared/refundReceipt.ts';
import { maybeSendOperatorGrowthAsk } from '../_shared/operatorGrowthAsks.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

interface Body {
  registration_id?: string;
  amount_cents?: number;
  reason?: string;
  cancel_registration?: boolean;
  /** true = return eligibility only, refund nothing. */
  preview?: boolean;
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
  /** Stripe account this charge was created on. null = the platform. */
  stripe_charge_account_id: string | null;
}

interface InstallmentRow {
  id: string;
  installment_number: number;
  amount_cents: number;
  status: string;
  stripe_payment_intent_id: string | null;
  paid_at: string | null;
  /** Stripe account this installment's PI was created on. null = the platform. */
  stripe_charge_account_id: string | null;
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

    // preview: compute and return eligibility, refund nothing. Same auth, same
    // maths, no side effects — so the drawer can show a ceiling it knows the
    // server will honour instead of deriving its own.
    const preview = body.preview === true;

    if (!registrationId) return json({ error: 'missing_registration_id' }, 400);
    if (!preview && (!Number.isFinite(amountCents) || amountCents <= 0)) {
      return json({ error: 'invalid_amount' }, 400);
    }

    // ── load registration ─────────────────────────────────────────────────
    const { data: regData, error: regErr } = await supabase
      .from('registrations')
      .select('id, organization_id, status, payment_status, stripe_payment_intent_id, amount_cents, student_id, parent_id, program_id, camp_session_id, stripe_charge_account_id')
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

    // ── refund policy: who is made whole on a refund ──────────────────────
    // When the provider bears Stripe's processing fee (stripe_fee_payer='tenant',
    // Enrops-platform), the application fee was sized up to recover Stripe's fee
    // (see _shared/connectChargeParams). On a refund we therefore ALSO refund the
    // application fee so the PROVIDER is made whole — Enrops absorbs its 1% margin
    // + the Stripe-fee recovery rather than charging a provider on a refunded
    // registration. Verified in Stripe test mode 2026-06-29: refund_application_fee
    // false → provider out the full app fee; true → provider net $0.
    // Legacy own-platform orgs (J2S, stripe_fee_payer='platform' or unset) keep the
    // prior behavior (false) — their app fee is internal, so this is unchanged.
    const { data: orgFeeRow } = await supabase
      .from('organizations')
      .select('stripe_fee_payer')
      .eq('id', reg.organization_id)
      .maybeSingle();
    const orgFee = orgFeeRow as { stripe_fee_payer?: string } | null;

    // ── Phase 2: which account the refund is created on ───────────────────
    // DIRECT orgs: the charge lives on the connected account, so per Stripe's
    // direct-charges docs the refund is created "using your platform's secret
    // key while authenticated as the connected account". Two further
    // consequences, both load-bearing:
    //   - reverse_transfer is meaningless and INVALID here: there is no transfer
    //     to reverse (the funds never left the operator's account). Sending it
    //     would fail the refund outright.
    //   - refund_application_fee must be true. Stripe: "Application fees aren't
    //     automatically refunded ... Your platform must explicitly refund the
    //     application fee or the connected account ... loses that amount."
    //     Under direct charges the application fee is clean margin (no Stripe-fee
    //     uplift), so refunding it in full is exactly "Enrops earns nothing on a
    //     cancelled registration" — no arithmetic needed.
    // DESTINATION orgs (J2S and every pre-existing org): completely unchanged —
    // same reverse_transfer:true, same stripe_fee_payer-driven flag, same
    // platform-scoped call.
    // Scope is decided PER PAYMENT INTENT, from stripe_charge_account_id
    // recorded when that charge was made — NOT from the org's current
    // stripe_charge_model. An operator who moves to direct charges gets a brand
    // new connected account (controller.fees.payer can never be changed on an
    // existing one), so their pre-move PaymentIntents stay on the platform
    // forever. Deciding by the current model would scope those refunds to an
    // account where the pi_... does not exist, and every historical refund would
    // fail. null = platform, which is correct for every row that predates this.
    const refundScopeFor = (chargeAccountId: string | null): { stripeAccount: string } | undefined =>
      chargeAccountId ? { stripeAccount: chargeAccountId } : undefined;
    // ── how much of the application fee goes back ─────────────────────────
    //
    // DIRECT charge: the fee is clean margin (Stripe took its cut from the
    // operator's own balance, never from ours), so the whole thing goes back
    // via refund_application_fee:true. Nothing to apportion.
    //
    // DESTINATION charge: the application fee is deliberately LARGER than the
    // margin — it is margin + estimateStripeFee whenever the provider bears
    // Stripe's fee. Those two halves must be treated differently on a refund,
    // which a boolean cannot express:
    //   - the MARGIN half goes back. Enrops earned no margin on a cancelled
    //     registration.
    //   - the STRIPE-FEE half does NOT, because Stripe keeps its processing fee
    //     on a refund. Handing it back means Enrops pays Stripe out of pocket
    //     every time an operator refunds someone.
    // So refund_application_fee is FALSE and the margin is refunded explicitly
    // via applicationFees.createRefund — the split Jessica decided on
    // 2026-07-25, superseding "Enrops absorbs it". See _shared/refundFeeSplit.ts.
    //
    // Outcome on a fully refunded charge: family whole, provider bears Stripe's
    // real fee, Enrops nets zero. Nobody profits from a cancellation and nobody
    // quietly subsidises it.
    //
    // Legacy own-platform orgs (stripe_fee_payer != 'tenant') never carried an
    // uplift, so there is nothing to hold back and nothing to refund separately
    // — they keep refund_application_fee:false exactly as before.
    const providerBearsStripeFee = orgFee?.stripe_fee_payer === 'tenant';

    // ── v4 section 2: our fee comes back prorated to sessions REMAINING ────
    // "Set Enrops' fee refund = application_fee x % remaining." Resolved once
    // per call, from the registration's own schedule. loadProration never
    // throws and falls back to 1 (refund our whole margin) when the schedule
    // cannot be resolved, so a missing calendar can never make Enrops keep a
    // fee it has not justified.
    const proration = await loadProration(supabase, {
      organization_id: reg.organization_id,
      program_id: reg.program_id,
      camp_session_id: reg.camp_session_id,
    });
    if (proration.source === 'unknown') {
      console.warn(
        `[refund] no schedule resolved for registration ${registrationId}; refunding the full margin (fraction 1)`,
      );
    }

    // ── refund_application_fee is now ALWAYS false, on BOTH charge models ──
    // Stripe's boolean cannot express v4's proration. Its own docs: "If the
    // refund results in the entire charge being refunded, the entire
    // application fee is refunded. Otherwise, a proportional amount of the
    // application fee is refunded" - proportional to the CHARGE, not to
    // sessions remaining. And on a destination charge it would also hand back
    // the Stripe-fee uplift that Stripe never returns to us.
    // So both models take the documented alternative: "provide a
    // refund_application_fee value of false and refund the application fee
    // separately" (docs.stripe.com/connect/direct-charges).
    //
    // CHANGED FOR DIRECT ORGS: this was true (whole fee, automatic). It is now
    // false + an explicit prorated fee refund. Same money on a full pre-start
    // refund; less of our fee returned once sessions have been delivered.

    // ── collect paid PIs for this registration ────────────────────────────
    // Pattern: installments table is the primary source. If no installments
    // rows exist (single-pay registration), fall back to registrations.
    const { data: instData } = await supabase
      .from('installments')
      .select('id, installment_number, amount_cents, status, stripe_payment_intent_id, paid_at, stripe_charge_account_id')
      .eq('registration_id', registrationId);
    const installments = (instData as InstallmentRow[] | null) ?? [];
    const paidInstallments = installments.filter(
      (i) => i.status === 'paid' && i.stripe_payment_intent_id,
    );

    // Build PI list: each entry = (pi_id, amount_for_this_reg, sort_key).
    // chargeAccountId travels with the slot: each PaymentIntent is refunded on
    // the account it was actually created on.
    type PiSlot = { pi: string; amount: number; sortKey: number; chargeAccountId: string | null };
    const piSlots: PiSlot[] = [];

    if (paidInstallments.length > 0) {
      for (const inst of paidInstallments) {
        piSlots.push({
          pi: inst.stripe_payment_intent_id!,
          amount: inst.amount_cents,
          sortKey: inst.installment_number, // newest installment first
          chargeAccountId: inst.stripe_charge_account_id ?? null,
        });
      }
    } else if (reg.payment_status === 'paid' && reg.stripe_payment_intent_id) {
      piSlots.push({
        pi: reg.stripe_payment_intent_id,
        amount: reg.amount_cents ?? 0,
        sortKey: 1,
        chargeAccountId: reg.stripe_charge_account_id ?? null,
      });
    }

    if (piSlots.length === 0) {
      return json({ error: 'nothing_paid' }, 400);
    }

    // ── raise each slot's ceiling to what the FAMILY ACTUALLY PAID ────────
    //
    // amount_cents is the BASE price. When the operator passes the platform fee
    // to families, the card was charged base + fee, and the eligibility ceiling
    // was silently the base — so a family who paid $276.74 could only ever be
    // refunded $274.00. Arielle's checklist §2 forbids exactly that: "Parent's
    // refund amount = whatever the operator's own stated cancellation policy
    // promises. Never reduce it to cover Stripe's or Enrops' fees — card
    // network rules prohibit shorting the cardholder."
    //
    // The charge is the authoritative record of what was taken, so the ceiling
    // is read from Stripe rather than recomputed from today's fee config (which
    // may have changed since). A PaymentIntent can cover several registrations
    // (a multi-child cart, or an aggregated installment charge), so this
    // registration gets its PROPORTIONAL share of the real charge, split by the
    // base amounts that made it up.
    //
    // Absorb orgs (fee_pass_through=false — including J2S on prod) charged base
    // only, so the share equals amount_cents and nothing changes for them.
    for (const slot of piSlots) {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          slot.pi,
          undefined,
          slot.chargeAccountId ? { stripeAccount: slot.chargeAccountId } : undefined,
        );
        const chargedTotal = pi.amount ?? 0;
        if (chargedTotal <= 0) continue;

        // Which base amounts made up this PI? Rows sharing the PI across ALL
        // registrations, not just this one.
        const { data: sharers } = await supabase
          .from('installments')
          .select('amount_cents')
          .eq('stripe_payment_intent_id', slot.pi);
        const sharerRows = ((sharers ?? []) as unknown) as Array<{ amount_cents: number }>;
        let baseOnPi = sharerRows.reduce((s, r) => s + (r.amount_cents || 0), 0);

        if (baseOnPi <= 0) {
          // Single-pay: the PI's base is the sum of every registration that
          // shared this checkout, not just this one.
          const { data: regSharers } = await supabase
            .from('registrations')
            .select('amount_cents')
            .eq('stripe_payment_intent_id', slot.pi);
          const regRows = ((regSharers ?? []) as unknown) as Array<{ amount_cents: number | null }>;
          baseOnPi = regRows.reduce((s, r) => s + (r.amount_cents || 0), 0);
        }
        if (baseOnPi <= 0) continue;

        // Never LOWER a ceiling: if the maths ever disagrees, keep the base.
        const share = Math.round((chargedTotal * slot.amount) / baseOnPi);
        if (share > slot.amount) slot.amount = share;
      } catch (ceilErr) {
        // Non-fatal: fall back to the base amount, which is the pre-existing
        // behaviour. It can under-refund a pass-through family, so it is worth
        // seeing in the logs, but it must not block a refund entirely.
        console.error('[refund] could not read the charged total for', slot.pi, ceilErr);
      }
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

    // PREVIEW: return the numbers and refund nothing. The drawer used to
    // recompute this from installments/registrations itself, which meant the
    // ceiling existed in two places and they drifted — the UI inherited the
    // same fee shortfall as the server. Now there is ONE implementation and the
    // UI displays what the server will actually allow.
    if (preview) {
      return json({
        preview: true,
        eligible_cents: eligible,
        total_paid_cents: totalPaid,
        total_refunded_cents: totalRefunded,
        // v4 section 2 / section 8: the drawer and the refund receipt both need
        // to say WHY our fee refund is the size it is. DB-only, so preview stays
        // a cheap call - the Stripe read that turns this into cents happens on
        // the real refund.
        sessions_total: proration.sessionDates.length || null,
        sessions_remaining: proration.sessionDates.filter((d) => d >= proration.asOf).length || 0,
        platform_fee_remaining_fraction: proration.fraction,
        schedule_source: proration.source,
      });
    }

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

      // ── read the REAL numbers off the charge, never recompute them ───────
      // A provider's rates can change between the charge and the refund; the
      // charge is the authoritative record of what was actually taken. Only
      // needed on the destination path, where the margin has to be separated
      // from the Stripe-fee uplift.
      let marginRefundCents = 0;
      let applicationFeeId: string | null = null;
      // Both charge models now take this path. The only org shape that skips it
      // is a legacy own-platform destination org (stripe_fee_payer != 'tenant'),
      // whose application fee is internal bookkeeping between Enrops and itself
      // — there is no uplift to hold back and no third party to make whole, so
      // it keeps its pre-existing no-fee-refund behaviour. No org on staging or
      // prod is in that shape today (all are 'tenant'), so this is a guard
      // against a config regression, not a live branch.
      const feeRefundApplies = slot.chargeAccountId !== null || providerBearsStripeFee;
      if (feeRefundApplies) {
        try {
          const facts = await readChargeFeeFacts(stripe, slot.pi, slot.chargeAccountId);
          applicationFeeId = facts.applicationFeeId;

          marginRefundCents = computeMarginRefund({
            applicationFeeCents: facts.applicationFeeCents,
            // 0 on a direct charge: Stripe billed the OPERATOR, not us.
            stripeFeeCents: facts.stripeFeeCents,
            chargeAmountCents: facts.chargeAmountCents,
            refundAmountCents: refundThisPi,
            alreadyRefundedFeeCents: facts.alreadyRefundedFeeCents,
            // v4 section 2.
            remainingFraction: proration.fraction,
          });
        } catch (feeErr) {
          // Refuse rather than guess: refunding the family without returning
          // the operator's margin, or returning the wrong amount, are both
          // worse than making a human look. Nothing has been refunded yet.
          console.error('[refund] could not read charge fee details:', feeErr);
          await supabase.from('refunds')
            .update({ status: 'failed', failure_reason: 'could not read the charge fee details from Stripe' })
            .eq('id', refundRowId);
          return json({
            error: 'fee_lookup_failed',
            partial: refundsCreated.length > 0 ? refundsCreated : undefined,
          }, 502);
        }
      }

      try {
        const stripeRefund = await stripe.refunds.create(
          {
            payment_intent: slot.pi,
            amount: refundThisPi,
            // Always false on both models — the prorated fee refund is issued
            // explicitly below. See the block above refundScopeFor.
            refund_application_fee: false,
            // Destination charges only: pull the refunded share back from the
            // operator's connected account, or the refund comes out of the
            // platform balance alone. A DIRECT charge has no transfer to
            // reverse — sending this would fail the call — so it is omitted.
            ...(slot.chargeAccountId ? {} : { reverse_transfer: true }),
            reason: 'requested_by_customer',
            metadata: {
              enrops_refund_id: refundRowId,
              enrops_registration_id: registrationId,
              enrops_org_id: reg.organization_id,
              ...(reason ? { enrops_reason: reason.slice(0, 200) } : {}),
            },
          },
          // undefined for a platform charge, so spreading it here leaves the
          // unchanged platform-scoped call.
          { idempotencyKey: `refund_${refundRowId}`, ...refundScopeFor(slot.chargeAccountId) },
        );

        // ── return the unearned part of the application fee ────────────────
        // BOTH charge models. Separate call because Stripe's
        // refund_application_fee boolean is all-or-nothing and prorates to the
        // CHARGE, not to sessions remaining — and on a destination charge it
        // would also push back the Stripe-fee uplift Stripe never returns.
        // Platform-scoped with NO Stripe-Account header even for a direct
        // charge: the ApplicationFee belongs to the platform on both models.
        // Its own idempotency key, so a retry of this function cannot double-
        // refund the fee even though the charge refund above already succeeded.
        let marginRefundApplied = 0;
        if (marginRefundCents > 0 && applicationFeeId) {
          try {
            const feeRefund = await stripe.applicationFees.createRefund(
              applicationFeeId,
              { amount: marginRefundCents },
              { idempotencyKey: `appfee_${refundRowId}` },
            );
            marginRefundApplied = feeRefund.amount ?? marginRefundCents;
          } catch (feeRefundErr) {
            // The family HAS been refunded. The operator has NOT had the margin
            // returned. Never swallow this — it is money owed to the operator,
            // and it is invisible unless we say so.
            const m = (feeRefundErr as { raw?: { message?: string }; message?: string });
            const msg = m.raw?.message ?? m.message ?? 'unknown';
            console.error('[refund] charge refunded but application-fee refund FAILED:', msg);
            await supabase.from('refunds')
              .update({
                stripe_refund_id: stripeRefund.id,
                status: 'succeeded',
                succeeded_at: new Date().toISOString(),
                failure_reason: `family refunded, but returning the provider's ${marginRefundCents}c margin failed: ${msg}`,
              })
              .eq('id', refundRowId);
            return json({
              error: 'margin_refund_failed',
              detail: 'The family was refunded, but the provider has not been credited back the platform margin. This needs a manual application-fee refund in Stripe.',
              stripe_refund_id: stripeRefund.id,
              application_fee_id: applicationFeeId,
              margin_owed_cents: marginRefundCents,
              refunds: refundsCreated,
            }, 502);
          }
        }

        const succeededAt = new Date().toISOString();
        const { error: updErr } = await supabase
          .from('refunds')
          .update({
            stripe_refund_id: stripeRefund.id,
            status: 'succeeded',
            succeeded_at: succeededAt,
            platform_fee_refunded_cents: marginRefundApplied,
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

    // ── tell the family (v4 section 8) ───────────────────────────────────
    // Sent AFTER the money has moved and after the records are settled, so the
    // email can never describe a refund that did not happen. Fail-safe: a
    // bounced receipt must not turn a successful refund into an error, so the
    // outcome is reported in the response rather than thrown.
    // The webhook deliberately does NOT also send for these: it recognises
    // Enrops-initiated refunds by metadata and skips them entirely, so the
    // family gets exactly one receipt.
    let receipt: { sent: boolean; reason?: string } = { sent: false, reason: 'not attempted' };
    try {
      const { data: parentRow } = await supabase
        .from('parents')
        .select('email, first_name, last_name')
        .eq('id', reg.parent_id)
        .maybeSingle();
      const parent = parentRow as { email?: string; first_name?: string; last_name?: string } | null;

      if (parent?.email) {
        const brand = await loadOrgBrand(supabase, reg.organization_id);
        const { data: studentRow } = await supabase
          .from('students').select('first_name').eq('id', reg.student_id).maybeSingle();

        let programName: string | null = null;
        if (reg.program_id) {
          const { data: p } = await supabase
            .from('programs').select('curriculum').eq('id', reg.program_id).maybeSingle();
          programName = (p as { curriculum?: string } | null)?.curriculum ?? null;
        } else if (reg.camp_session_id) {
          const { data: c } = await supabase
            .from('camp_sessions').select('curriculum_name').eq('id', reg.camp_session_id).maybeSingle();
          programName = (c as { curriculum_name?: string } | null)?.curriculum_name ?? null;
        }

        // The enrops fee the FAMILY paid is the gap between what the card was
        // charged and the base price. Derived this way it is correct on both
        // charge models: on direct the fee IS the application fee, but on a
        // destination charge the application fee also carries the Stripe-fee
        // uplift, which the family never paid and must never be told about.
        // Null when it cannot be derived, which makes the receipt stay silent
        // about the fee rather than guess.
        const baseTotal = paidInstallments.length > 0
          ? paidInstallments.reduce((s, i) => s + (i.amount_cents || 0), 0)
          : (reg.amount_cents ?? 0);
        const familyFeeOnCharge = totalPaid > baseTotal ? totalPaid - baseTotal : null;

        receipt = await sendRefundReceipt({
          to: parent.email,
          from: formatFromAddress(brand),
          replyTo: brand.reply_to,
          resendApiKey: RESEND_API_KEY,
          isAllowed: isEmailAllowed,
          origin: 'enrops',
          parentName: `${parent.first_name ?? ''} ${parent.last_name ?? ''}`.trim(),
          childName: (studentRow as { first_name?: string } | null)?.first_name ?? null,
          programName,
          orgName: brand.org_name,
          refundedCents: refundedThisCall,
          chargedCents: totalPaid,
          familyFeeCents: familyFeeOnCharge,
          withdrawn: cancelRegistration,
          accentColor: brand.accent_color,
        });
        if (!receipt.sent) {
          console.warn(`[refund] receipt not sent to ${parent.email}: ${receipt.reason}`);
        }
      } else {
        receipt = { sent: false, reason: 'no parent email on file' };
      }
    } catch (receiptErr) {
      console.error('[refund] receipt failed (refund itself is fine):', receiptErr);
      receipt = { sent: false, reason: (receiptErr as Error).message };
    }

    // ── v4 section 8 items 3-4: the growth asks, at most once per operator ──
    // Off by default and skipped entirely for an operator flagged under section
    // 4. Runs last and swallows its own errors: nothing about a marketing ask
    // may affect a refund that has already moved money.
    await maybeSendOperatorGrowthAsk(supabase, {
      organizationId: reg.organization_id,
      resendApiKey: RESEND_API_KEY,
      isAllowed: isEmailAllowed,
    });

    return json({
      success: true,
      refunds: refundsCreated,
      total_refunded_cents: refundedThisCall,
      cancelled: cancelRegistration,
      // Surfaced so the drawer can say "refunded, but we could not email them"
      // instead of implying the family was told.
      receipt_sent: receipt.sent,
      receipt_reason: receipt.sent ? undefined : receipt.reason,
    });
  } catch (err) {
    console.error('[refund] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
