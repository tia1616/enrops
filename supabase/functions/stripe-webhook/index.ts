// stripe-webhook v21 — PATCH 14 (2026-07-28)
// v21: charge.refunded — Arielle's v4 section 3. Catches refunds an operator
//      issues in their OWN Stripe dashboard, which were previously invisible:
//      the registration stayed 'paid' and Enrops kept a platform fee on a
//      program the family no longer had. Records the refund, fires the
//      session-prorated application-fee refund, advances payment_status, and
//      logs the operator's reason for reporting only. See handleChargeRefunded.
//
//      CONFIG, NOT CODE (same shape as the v20 note below): charge.refunded
//      must be added to BOTH webhook destinations — the platform one for
//      destination orgs, and the Connected-accounts one for direct orgs, whose
//      charges live on the connected account. Subscribing to only one silently
//      covers only half the operators.
//
// stripe-webhook v20 — PATCH 13 (2026-07-27)
// v20: Stripe direct charges (migration Phase 2).
//      A direct charge is created ON the connected account, so ALL of its
//      events — including checkout.session.completed — are CONNECTED-ACCOUNT
//      events. Two consequences:
//        1. CONFIG, NOT CODE: the "Connected accounts" webhook destination must
//           subscribe to checkout.session.completed (and the async_payment_*
//           events). It was created for account.updated only. If it doesn't,
//           a direct org's families are charged and their registrations are
//           NEVER marked paid — no confirmation email, no installment rows,
//           and nothing in this function ever runs to tell us. Verified by a
//           real staging charge, not by reading the dashboard.
//        2. Any Stripe API call made while handling such an event must be
//           scoped with {stripeAccount: event.account}. event.account is set
//           only for connected-account events, so destination orgs (J2S) keep
//           the platform-scoped call unchanged.
//      No DB writes changed: registration/installment rows are ours and are
//      keyed the same way regardless of charge model.
//
// v19 — PATCH 12 (2026-05-29)
// v19: Enrops-as-platform path for instructor pay.
//      - account.updated: if the connected-account ID doesn't match an
//        operator (organizations.stripe_account_id), try matching it to an
//        instructor under the Enrops platform (contractor_onboarding_status.
//        stripe_connect_account_id WHERE org.instructor_pay_model =
//        'enrops_platform'). Runs the same status / gate-check logic the
//        instructor webhook uses for legacy_own_platform.
//      - transfer.reversed: route to shared handler (covers payouts created
//        via stripe.transfers.create with stripeAccount=operator_acct).
//      Together these make new tenants (default 'enrops_platform') run a
//      self-serve flow with no separate instructor-pay Stripe platform —
//      Enrops's main Stripe IS the platform. J2S stays on the legacy
//      route via stripe-connect-instructor-webhook.
//
// v18: Operator-side Stripe Connect events.
//      Adds handlers for account.updated and account.application.deauthorized.
//      Updates organizations.stripe_charges_enabled / stripe_payouts_enabled /
//      stripe_account_status based on Stripe's account state. Idempotency via
//      organizations.stripe_last_account_event_id (mirrors instructor-side
//      pattern in stripe-connect-instructor-webhook).
//
//      IMPORTANT: This webhook endpoint must be configured in the Stripe
//      Connect platform settings to "listen to events on connected accounts"
//      in addition to platform events. Otherwise Connect events never arrive.
//
// v17: Bug A fix — per-child installment attribution.
//      Reads schedule from checkout_schedules table (keyed by session_id) and
//      inserts N×3 installment rows (one per registration × charge), allowing
//      proper per-child cancellation/refund handling. Falls back to old behavior
//      if schedule_source != 'checkout_schedules' (legacy session compatibility).
// v16: Confirmation email now includes end_time, arrival/dismissal instructions.
//      Fixed support email to info@journeytosteam.com. Email-safe table layout.
// v15: Auto-create parent auth account after payment + send magic-link email.
//      Multi-tenant operator alert emails.
// v14: Fixed payment_method_id storage bug.
// v13: Installments support.
// v12: Fixed confirmation email copy.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress, renderSignatureBlock, OrgBrand } from '../_shared/orgBrand.ts';
import { buildIcs, googleCalendarUrl, toBase64, calendarEventsFromRegistrations } from '../_shared/calendarInvite.ts';
import { applyStripeAccountStatus } from '../_shared/stripeAccountStatus.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';
import { handleTransferReversed as sharedHandleTransferReversed } from '../_shared/handleTransferReversed.ts';
import { logEnrollmentEvent, ENROLLMENT_ACTIONS } from '../_shared/logEnrollmentEvent.ts';
import { findAuthUserByEmail } from '../_shared/findAuthUserByEmail.ts';
import { computeMarginRefund } from '../_shared/refundFeeSplit.ts';
import { loadProration } from '../_shared/refundFeeProration.ts';
import { readChargeFeeFacts, FEE_REFUND_SOURCE_KEY, FEE_REFUND_REGISTRATION_KEY } from '../_shared/chargeFeeFacts.ts';
import { allocateRefundAcrossRegistrations } from '../_shared/refundAllocation.ts';
import {
  settlementForCheckoutCompleted,
  SETTLEMENT_ON_ASYNC_SUCCESS,
  SETTLEMENT_ON_ASYNC_FAILURE,
} from '../_shared/achSettlement.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Primary secret: the "Enrops registration webhook" destination
// (Your account scope) — handles checkout.session.completed.
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
// Secondary secret: the "Connected accounts" scope destination — handles
// account.updated and account.application.deauthorized for Express
// connected accounts. Optional; if unset, only the primary secret is tried.
const STRIPE_WEBHOOK_SECRET_CONNECT = Deno.env.get('STRIPE_WEBHOOK_SECRET_CONNECT') || null;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// All FROM/reply-to/alert addresses now come from loadOrgBrand(), which
// cascades tenant -> Enrops -> hardcoded Enrops defaults. No more J2S-baked
// global constant.
const PLATFORM_ALERT_DEFAULT = 'alerts@enrops.com';
// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so the account-ready email's dashboard/login links point at staging, not prod.
// Defaults to prod (this webhook fires on real payments).
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

interface PerLineEntry {
  installment_number: number;
  registration_id: string;
  amount_cents: number;
  due_date: string;
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (primaryErr) {
    // Try the secondary "Connected accounts" destination secret if configured.
    // Stripe sends Connect events from a separate destination with its own
    // signing secret; one of the two secrets will verify any given event.
    if (STRIPE_WEBHOOK_SECRET_CONNECT) {
      try {
        event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET_CONNECT);
      } catch (secondaryErr) {
        console.error('Webhook signature failed against both secrets:', {
          primary: (primaryErr as Error).message,
          secondary: (secondaryErr as Error).message,
        });
        return new Response(`Invalid signature: ${(secondaryErr as Error).message}`, { status: 400 });
      }
    } else {
      console.error('Webhook signature failed:', (primaryErr as Error).message);
      return new Response(`Invalid signature: ${(primaryErr as Error).message}`, { status: 400 });
    }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata || {};
      const regIds = (meta.registration_ids || '').split(',').filter(Boolean);
      const parentEmail = session.customer_email || meta.parent_email;
      const parentName = meta.parent_name || '';
      const useInstallments = meta.use_installments === 'true';

      if (!regIds.length) {
        console.warn('Webhook: no registration_ids in metadata');
        return new Response('ok', { status: 200 });
      }

      // Look up org and load full brand context (FROM, colors, logo, alert email).
      const { data: regForOrg } = await admin.from('registrations').select('organization_id').eq('id', regIds[0]).single();
      const orgId = regForOrg?.organization_id;
      const brand = await loadOrgBrand(admin, orgId);
      const alertEmail = brand.alert_email;

      // Card settles instantly (session.payment_status === 'paid'). ACH/bank
      // transfer finishes Checkout but settles asynchronously — payment_status
      // is 'unpaid' here, resolved later by checkout.session.async_payment_
      // succeeded/failed. Per product decision: hold the seat optimistically
      // (confirmed) and reconcile if the ACH later fails. The ach_payment_state
      // marker distinguishes an ACH-in-flight 'unpaid' from a plain unpaid.
      const settlement = settlementForCheckoutCompleted(session.payment_status);
      const isPaid = settlement.fundsSettled;
      // This is THE write that turns a payment into an enrolment. It was
      // unchecked, and on 2026-07-27 that hid a real failure: a CHECK
      // constraint (photo_release_required_when_confirmed) rejected the row for
      // any family who declined the now-optional photo release, so they were
      // charged and left pending/unpaid with nothing surfacing it. The
      // constraint is gone (20260727f), but an unchecked write on the money
      // path is the actual defect - anything else that ever rejects this row
      // must be loud, not silent.
      const { error: confirmErr } = await admin.from('registrations').update({
        status: 'confirmed',
        payment_status: settlement.payment_status,
        ach_payment_state: settlement.ach_payment_state,
        stripe_payment_intent_id: session.payment_intent as string,
        // Where this charge actually lives. event.account is set exactly when
        // the event came from a connected account (a direct charge) and null
        // for a platform/destination charge — so this is the authoritative
        // record, better than create-checkout's write, which only knew what it
        // intended. Refunds read this instead of the org's current charge model.
        stripe_charge_account_id: (event.account as string | null) ?? null,
      }).in('id', regIds);

      if (confirmErr) {
        // The family HAS paid. Do not swallow this: alert loudly with
        // everything a human needs to fix it by hand, and keep going so the
        // rest of the handler (installments, promo, emails) still runs.
        console.error('[stripe-webhook] FAILED to confirm paid registrations:', confirmErr);
        await sendOperatorAlert({
          brand,
          to: alertEmail,
          subject: 'PAID but NOT confirmed — manual fix needed',
          body: [
            `A family completed payment but their registration could not be marked confirmed.`,
            `They have been charged. Their spot is NOT recorded.`,
            ``,
            `Registration IDs: ${regIds.join(', ')}`,
            `Stripe session: ${session.id}`,
            `Payment intent: ${session.payment_intent}`,
            `Database error: ${confirmErr.message}`,
            ``,
            `Fix the underlying cause, then set these registrations to confirmed/paid manually.`,
          ].join('\n'),
        });
      }

      // Count a promo redemption once, when funds actually settle (chunk 6).
      // The redemption ledger is the source of truth for usage limits; the
      // unique (promo_code_id, redemption_key=payment_intent) makes a webhook
      // retry a no-op, and used_count is bumped only when the ledger row is new.
      if (isPaid) {
        try {
          const { data: regRows } = await admin
            .from('registrations')
            .select('promo_code_used, parent_id')
            .in('id', regIds);
          const code = (regRows || []).find((r) => r.promo_code_used)?.promo_code_used;
          if (code && orgId) {
            const parentId = (regRows || []).find((r) => r.parent_id)?.parent_id ?? null;
            const { data: codeRow } = await admin
              .from('promo_codes').select('id')
              .eq('organization_id', orgId).eq('code', code).maybeSingle();
            if (codeRow) {
              const { error: insErr } = await admin.from('promo_redemptions').insert({
                organization_id: orgId,
                promo_code_id: codeRow.id,
                parent_id: parentId,
                redemption_key: session.payment_intent as string,
              });
              if (!insErr) {
                await admin.rpc('increment_promo_used_count', { p_code_id: codeRow.id });
              } else if (!/duplicate key|unique/i.test(insErr.message || '')) {
                console.warn('promo_redemptions insert failed:', insErr.message);
              }
            }
          }
        } catch (e) {
          console.warn('promo redemption counting failed (non-fatal):', (e as Error).message);
        }
      }

      // intelligence: log payment_completed (one per registration; fail-safe, never blocks).
      // dedupe on the Stripe event id so a webhook retry can't double-count.
      // Only when funds are actually in — ACH-pending logs this on async clear.
      if (isPaid) {
        for (const regId of regIds) {
          await logEnrollmentEvent(admin, {
            actionType: ENROLLMENT_ACTIONS.PAYMENT_COMPLETED,
            organizationId: orgId,
            registrationId: regId,
            metadata: { amount_total_cents: session.amount_total ?? null, use_installments: useInstallments },
            dedupeKey: `payment_completed:${event.id}:${regId}`,
          });
        }
      }

      if (isPaid && useInstallments) {
        try {
          // Phase 2: a DIRECT charge's PaymentIntent lives on the connected
          // account, not the platform, so an unscoped retrieve 404s. Stripe puts
          // the account on the EVENT (event.account), which is present exactly
          // when the event came from a connected account — so this is self-
          // scoping and needs no org lookup. For a destination org event.account
          // is null and this is the unchanged platform-scoped call.
          // undefined, never {} — stripe-node treats an empty options object as
          // a stray argument and throws "Unknown arguments".
          const piScope = event.account ? { stripeAccount: event.account as string } : undefined;
          const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent as string, piScope);

          const customerId = (session.customer as string) || (paymentIntent.customer as string);
          const paymentMethodId = paymentIntent.payment_method as string;

          if (!customerId || !paymentMethodId) {
            console.error('Installments: missing customer or payment_method', { customer: customerId, payment_method: paymentMethodId });
            await sendOperatorAlert({
              brand,
              to: alertEmail,
              subject: 'Installments queueing failed — manual review needed',
              body: `Session ${session.id} completed with use_installments=true but could not queue installments 2 and 3. customer_id=${customerId} payment_method_id=${paymentMethodId}. Registration IDs: ${regIds.join(', ')}. Charge 1 succeeded; please manually create installment rows or contact parent.`,
            });
          } else {
            // v17: Determine schedule source
            const useNewSchedule = meta.schedule_source === 'checkout_schedules';

            if (useNewSchedule) {
              // === v17 PATH: Read N×3 schedule from checkout_schedules table ===
              const { data: scheduleRow, error: schedErr } = await admin
                .from('checkout_schedules')
                .select('*')
                .eq('stripe_session_id', session.id)
                .single();

              if (schedErr || !scheduleRow) {
                console.error('checkout_schedules lookup failed:', schedErr);
                await sendOperatorAlert({
                  brand,
                  to: alertEmail,
                  subject: 'Schedule lookup failed — manual review needed',
                  body: `Session ${session.id}: webhook fired but checkout_schedules row missing or unreadable. Charge 1 succeeded but installments 2 and 3 could not be queued. Error: ${schedErr?.message || 'no row'}.`,
                });
              } else {
                const perLine = (scheduleRow.schedule?.per_line || []) as PerLineEntry[];

                // Insert ONE row per per_line entry. Charge 1 entries → status='paid'
                // (just charged via Stripe Checkout). Charges 2 and 3 → status='pending'.
                const installmentRows = perLine.map((entry) => {
                  const isPaid = entry.installment_number === 1;
                  return {
                    registration_id: entry.registration_id,
                    installment_number: entry.installment_number,
                    amount_cents: entry.amount_cents,
                    due_date: entry.due_date,
                    status: isPaid ? 'paid' : 'pending',
                    stripe_customer_id: customerId,
                    stripe_payment_method_id: paymentMethodId,
                    organization_id: orgId,
                    // For paid (charge 1) rows, link to the actual paymentIntent.
                    // Multiple rows share one PI because charge 1 is one Stripe charge
                    // split across N children in our DB.
                    stripe_payment_intent_id: isPaid ? (session.payment_intent as string) : null,
                    paid_at: isPaid ? new Date().toISOString() : null,
                    // Which Stripe account this plan lives on: null = platform
                    // (destination), the connected account id = direct. Stamped
                    // on the PENDING rows too, because that is where the saved
                    // Customer and card live — process-installments must charge
                    // 2 and 3 against the same account, and refunds of charge 1
                    // must be scoped there as well.
                    stripe_charge_account_id: (event.account as string | null) ?? null,
                  };
                });

                const { error: insertError } = await admin.from('installments').insert(installmentRows);

                if (insertError) {
                  console.error('Failed to insert N×3 installment rows:', insertError);
                  await sendOperatorAlert({
                    brand,
                    to: alertEmail,
                    subject: 'N×3 installment row insert failed — manual review needed',
                    body: `Session ${session.id}: ${installmentRows.length} installment rows could not be inserted. Error: ${insertError.message}. Charge 1 succeeded. Customer ${customerId}, payment method ${paymentMethodId}. Registration IDs: ${regIds.join(', ')}.`,
                  });
                } else {
                  console.log(`v17: Inserted ${installmentRows.length} installment rows for session ${session.id} (${perLine.length} per_line entries)`);
                  // Mark schedule as consumed
                  await admin
                    .from('checkout_schedules')
                    .update({ consumed_at: new Date().toISOString() })
                    .eq('stripe_session_id', session.id);
                }
              }
            } else {
              // === LEGACY PATH (pre-v17 sessions): hardcoded 2-row insert ===
              // Kept for backwards compat with sessions created before v17 deploy.
              const inst2RegId = meta.installment_2_registration_id || regIds[0];
              const inst3RegId = meta.installment_3_registration_id || regIds[0];

              const installmentRows = [
                { registration_id: inst2RegId, installment_number: 2, amount_cents: parseInt(meta.installment_2_amount_cents, 10), due_date: meta.installment_2_due_date, status: 'pending', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId, organization_id: orgId, stripe_charge_account_id: (event.account as string | null) ?? null },
                { registration_id: inst3RegId, installment_number: 3, amount_cents: parseInt(meta.installment_3_amount_cents, 10), due_date: meta.installment_3_due_date, status: 'pending', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId, organization_id: orgId, stripe_charge_account_id: (event.account as string | null) ?? null },
              ];

              const { error: insertError } = await admin.from('installments').insert(installmentRows);

              if (insertError) {
                console.error('Failed to insert installment rows (legacy path):', insertError);
                await sendOperatorAlert({
                  brand,
                  to: alertEmail,
                  subject: 'Installment row insert failed (legacy) — manual review needed',
                  body: `Session ${session.id}: legacy 2-row installment insert failed. Error: ${insertError.message}. Charge 1 succeeded.`,
                });
              } else {
                console.log(`Legacy installments queued: 2 pending rows for session ${session.id}`);
                await admin.from('installments').insert({
                  registration_id: regIds[0], installment_number: 1,
                  amount_cents: session.amount_total || 0,
                  due_date: new Date().toISOString().slice(0, 10),
                  status: 'paid', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId,
                  stripe_payment_intent_id: session.payment_intent as string,
                  paid_at: new Date().toISOString(), organization_id: orgId,
                  stripe_charge_account_id: (event.account as string | null) ?? null,
                });
              }
            }
          }
        } catch (instErr) {
          console.error('Installments processing error:', instErr);
          await sendOperatorAlert({
            brand,
            to: alertEmail,
            subject: 'Installments error — manual review needed',
            body: `Session ${session.id} encountered an error while processing installments: ${(instErr as Error).message}. Charge 1 likely succeeded. Registration IDs: ${regIds.join(', ')}.`,
          });
        }
      }

      // Confirmation email (unchanged from v16)
      const { data: regs } = await admin.from('registrations').select(
        `id, amount_cents, programs(id, curriculum, day_of_week, start_time, end_time, first_session_date, term, program_locations(name, address, arrival_instructions, dismissal_instructions)), students(first_name, last_name)`,
      ).in('id', regIds);

      // Tenant slug for portal URLs in the confirmation email. Never default
      // to a tenant literal — if orgId resolves to an org without a slug,
      // throw so the payment-processing pipeline alerts; better to fail loud
      // than silently send wrong-tenant URLs to a paying parent.
      let orgSlug = '';
      if (orgId) {
        const { data: orgSlugData } = await admin.from('organizations').select('slug').eq('id', orgId).single();
        orgSlug = orgSlugData?.slug ?? '';
      }
      if (!orgSlug) {
        throw new Error(`stripe-webhook: cannot resolve org.slug for orgId=${orgId ?? 'null'}; refusing to send confirmation email with a guessed tenant URL`);
      }

      if (parentEmail && regs?.length) {
        // For installments, derive aggregated charge breakdown for the email
        let installmentInfo = null;
        if (useInstallments) {
          const useNewSchedule = meta.schedule_source === 'checkout_schedules';
          if (useNewSchedule) {
            const { data: scheduleRow } = await admin
              .from('checkout_schedules')
              .select('schedule')
              .eq('stripe_session_id', session.id)
              .single();
            const aggregated = scheduleRow?.schedule?.aggregated || [];
            const c2 = aggregated.find((a: any) => a.installment_number === 2);
            const c3 = aggregated.find((a: any) => a.installment_number === 3);
            installmentInfo = {
              paidToday: session.amount_total || 0,
              installment2Amount: c2?.amount_cents || 0,
              installment2Date: c2?.due_date || '',
              installment3Amount: c3?.amount_cents || 0,
              installment3Date: c3?.due_date || '',
            };
          } else {
            installmentInfo = {
              paidToday: session.amount_total || 0,
              installment2Amount: parseInt(meta.installment_2_amount_cents || '0', 10),
              installment2Date: meta.installment_2_due_date || '',
              installment3Amount: parseInt(meta.installment_3_amount_cents || '0', 10),
              installment3Date: meta.installment_3_due_date || '',
            };
          }
        }

        await sendConfirmationEmail({
          admin, brand,
          to: parentEmail, parentName, registrations: regs,
          totalCents: session.amount_total || 0, sessionId: session.id, useInstallments,
          installmentInfo,
        });

        // Trigger lifecycle-automations-cron in event mode for each newly-
        // confirmed registration. If the program starts within the next 7
        // days, the cron fires Welcome immediately so late registrants don't
        // wait until the daily run. Idempotency UNIQUE constraint prevents
        // double-sends when the daily cron later includes this registration.
        // Non-blocking — failures are logged but don't break the webhook.
        try {
          const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
          if (SUPABASE_ANON_KEY) {
            await Promise.allSettled(
              regs.map((r: { id: string }) =>
                fetch(`${SUPABASE_URL}/functions/v1/lifecycle-automations-cron`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                  },
                  body: JSON.stringify({ registration_id: r.id }),
                })
              )
            );
          }
        } catch (eventErr) {
          console.error('[stripe-webhook] lifecycle event-mode POST failed:', eventErr);
        }
      }

      // Auto-create parent account
      if (parentEmail) {
        try {
          await autoCreateParentAccount(admin, brand, parentEmail, parentName, orgSlug, alertEmail);
        } catch (accountErr) {
          console.error('Auto-create parent account failed:', accountErr);
        }
      }
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      // ACH/bank transfer cleared (3-5 days after checkout). Flip the
      // optimistically-confirmed registrations to paid and log the money-in.
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata || {};
      const regIds = (meta.registration_ids || '').split(',').filter(Boolean);
      if (!regIds.length) return new Response('ok', { status: 200 });
      const { data: regForOrg } = await admin.from('registrations').select('organization_id').eq('id', regIds[0]).single();
      const orgId = regForOrg?.organization_id;
      await admin.from('registrations').update({
        ...SETTLEMENT_ON_ASYNC_SUCCESS,
        stripe_payment_intent_id: session.payment_intent as string,
      }).in('id', regIds);
      for (const regId of regIds) {
        await logEnrollmentEvent(admin, {
          actionType: ENROLLMENT_ACTIONS.PAYMENT_COMPLETED,
          organizationId: orgId,
          registrationId: regId,
          metadata: { amount_total_cents: session.amount_total ?? null, payment_method: 'us_bank_account' },
          dedupeKey: `payment_completed:${event.id}:${regId}`,
        });
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      // ACH/bank transfer bounced (e.g. NSF). The seat was held optimistically;
      // mark the payment failed and alert the operator to follow up. We leave
      // status='confirmed' / payment_status='unpaid' so the operator decides
      // whether to chase payment or release the seat.
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata || {};
      const regIds = (meta.registration_ids || '').split(',').filter(Boolean);
      if (!regIds.length) return new Response('ok', { status: 200 });
      const { data: regForOrg } = await admin.from('registrations').select('organization_id').eq('id', regIds[0]).single();
      const brand = await loadOrgBrand(admin, regForOrg?.organization_id);
      await admin.from('registrations').update({ ...SETTLEMENT_ON_ASYNC_FAILURE }).in('id', regIds);
      await sendOperatorAlert({
        brand,
        to: brand.alert_email,
        subject: 'Bank transfer (ACH) failed — follow up needed',
        body: `A family's bank transfer did not clear (e.g. insufficient funds). The seat is still held (confirmed) but unpaid. Registration IDs: ${regIds.join(', ')}. Parent: ${meta.parent_name || ''} ${session.customer_email || meta.parent_email || ''}. Contact the family to arrange payment, or release the seat.`,
      });
      // intelligence: log the failure half of the funnel (fail-safe; metadata is IDs/facts only, no PII)
      for (const regId of regIds) {
        await logEnrollmentEvent(admin, {
          actionType: ENROLLMENT_ACTIONS.PAYMENT_FAILED,
          organizationId: regForOrg?.organization_id,
          registrationId: regId,
          metadata: { payment_method: 'us_bank_account', reason: 'ach_not_cleared', amount_total_cents: session.amount_total ?? null },
          dedupeKey: `payment_failed:${event.id}:${regId}`,
        });
      }
    } else if (event.type === 'account.updated') {
      await handleAccountUpdated(admin, event);
    } else if (event.type === 'account.application.deauthorized') {
      await handleAccountDeauthorized(admin, event);
    } else if (event.type === 'charge.refunded') {
      // Arielle's v4 section 3. See handleChargeRefunded.
      await handleChargeRefunded(admin, event);
    } else if (event.type === 'transfer.reversed') {
      // Fires when a Stripe transfer to a connected account is reversed.
      // For Enrops-platform-routed instructor payouts (operator's stripeAccount
      // header), this is the only signal we get; flip the payout row to failed
      // and unwind. If no instructor_payouts row matches the transfer ID, the
      // helper 200s — it's a transfer from outside our system (e.g. the
      // transfer_data leg on a Receivables charge).
      return await sharedHandleTransferReversed(admin, event, '[transfer.reversed enrops]');
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('stripe-webhook processing error:', err);
    return new Response(`Error: ${(err as Error).message}`, { status: 500 });
  }
});

// ── charge.refunded — Arielle's v4 section 3 ────────────────────────────────
//
// THE GAP THIS CLOSES. Operators on direct charges have a FULL Stripe dashboard
// (controller.stripe_dashboard.type='full'), so they can refund a family without
// ever opening Enrops. v4 calls this "Standard's biggest gap" and section 7 calls
// it "the scenario most likely to be missed". Before this handler, such a refund
// was completely invisible to us: the registration still read paid, the roster
// still counted the child, and Enrops kept a platform fee on a program the family
// no longer has. Stripe is explicit that the fee does NOT come back on its own —
// "Application fees aren't automatically refunded when issuing a refund. Your
// platform must explicitly refund the application fee."
//
// v4: "Treat Stripe's charge.refunded webhook as the source of truth, not a
// button-click inside Enrops" and "automatically fire the proportional
// application_fee refund from Section 2, regardless of whether the refund was
// started in Enrops or directly in Stripe."
//
// SAME MATHS AS THE IN-APP PATH, deliberately: both call readChargeFeeFacts +
// computeMarginRefund + loadProration. Two implementations would be two answers
// to "how much of our fee comes back", and the whole point of section 3 is that
// the answer does not depend on where the operator clicked.
//
// NO REVIEW STEP, BY DESIGN. v4: "Do not build a 'legit vs. not legit' review
// screen anywhere — the formula in Section 2 is the only gate needed." The
// operator's reason is recorded for reporting and never gates anything.
//
// IDEMPOTENT THREE WAYS, because Stripe retries and charge.refunded fires again
// on every subsequent partial refund of the same charge:
//   1. refunds (stripe_refund_id, registration_id) is UNIQUE (20260728a) — a
//      refund already recorded is skipped, which also means refunds WE issued
//      from refund-registration are never double-handled here.
//   2. the application-fee refund carries a stable idempotency key derived from
//      the Stripe refund id.
//   3. computeMarginRefund is capped by the fee already refunded, read live off
//      the ApplicationFee, so even a lost idempotency key cannot over-refund.
//
// SCOPE. event.account is set only for connected-account events, i.e. direct
// charges. Destination charges (J2S and every pre-existing org) arrive
// platform-scoped with event.account undefined, and their refunds are read and
// recorded exactly the same way — the only difference is which account the
// charge is read from, which readChargeFeeFacts handles.
async function handleChargeRefunded(admin: SupabaseClient, event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  // Connected-account event => the charge lives on that account (direct model).
  const chargeAccountId = (event as unknown as { account?: string }).account ?? null;
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null;

  if (!piId) {
    console.log('[charge.refunded] no payment_intent on the charge; nothing to map');
    return;
  }

  // ── which registrations did this charge pay for? ──────────────────────────
  // Installments first (the primary source, same order as refund-registration),
  // falling back to single-pay registrations.
  const { data: instRows } = await admin
    .from('installments')
    .select('registration_id, amount_cents, status')
    .eq('stripe_payment_intent_id', piId);
  const allInst = ((instRows ?? []) as Array<{ registration_id: string; amount_cents: number; status: string }>);
  // Only PAID rows contributed money to this charge, and only they should get a
  // share of the refund — same rule as refund-registration, which builds its PI
  // slots from status='paid'. A failed or paused installment that kept its
  // payment_intent_id would otherwise dilute the split and under-attribute the
  // refund to the registration that actually paid.
  // Fall back to every row on the PI if none are marked paid: mis-attributing a
  // refund is bad, but silently not recording it at all is worse.
  const paidInst = allInst.filter((r) => r.status === 'paid');
  const instForSplit = paidInst.length > 0 ? paidInst : allInst;
  if (paidInst.length === 0 && allInst.length > 0) {
    console.warn(`[charge.refunded] no paid installments on ${piId}; attributing across all ${allInst.length} rows`);
  }
  let slices = instForSplit.map((r) => ({
    registrationId: r.registration_id,
    baseCents: r.amount_cents || 0,
  }));

  if (slices.length === 0) {
    const { data: regRows } = await admin
      .from('registrations')
      .select('id, amount_cents')
      .eq('stripe_payment_intent_id', piId);
    slices = ((regRows ?? []) as Array<{ id: string; amount_cents: number | null }>).map((r) => ({
      registrationId: r.id,
      baseCents: r.amount_cents || 0,
    }));
  }

  if (slices.length === 0) {
    // A charge from outside our registration flow (or one we never recorded).
    // Not an error — 200 and move on.
    console.log(`[charge.refunded] no registrations found for ${piId}; ignoring`);
    return;
  }

  // ── which refunds on this charge have we not recorded yet? ────────────────
  // charge.refunds on the event payload is a truncated list. Re-list from the
  // API so a charge with many partial refunds cannot silently drop the oldest.
  let refundObjects: Stripe.Refund[] = [];
  try {
    const listed = await stripe.refunds.list(
      { charge: charge.id, limit: 100 },
      chargeAccountId ? { stripeAccount: chargeAccountId } : undefined,
    );
    refundObjects = listed.data ?? [];
  } catch (listErr) {
    console.error('[charge.refunded] could not list refunds, falling back to the event payload:', listErr);
    refundObjects = (charge.refunds?.data ?? []) as Stripe.Refund[];
  }
  // A refund is only MONEY once Stripe says 'succeeded'. The other two states
  // both matter but must not be treated as final:
  //   pending — recorded so it is visible, but no fee refund and no
  //     payment_status change until it settles. get_revenue_summary and
  //     get_revenue_activity both filter status='succeeded', so a pending row
  //     stays out of the operator's numbers until it is real.
  //   failed  — an earlier pending row must be marked failed, or a refund that
  //     bounced at the bank would sit in our records looking successful.
  const relevant = refundObjects.filter(
    (r) => r.status === 'succeeded' || r.status === 'pending' || r.status === 'failed',
  );
  if (relevant.length === 0) return;

  // Refunds that FAILED: settle any row we already wrote for them, then drop
  // them from the main loop — there is nothing to attribute or refund.
  const failedIds = relevant.filter((r) => r.status === 'failed').map((r) => r.id);
  if (failedIds.length > 0) {
    const { error: failErr } = await admin
      .from('refunds')
      .update({ status: 'failed', failure_reason: 'Stripe reports this refund failed', succeeded_at: null })
      .in('stripe_refund_id', failedIds)
      .neq('status', 'failed');
    if (failErr) console.error('[charge.refunded] could not mark failed refunds:', failErr);
  }

  const succeeded = relevant.filter((r) => r.status !== 'failed');
  if (succeeded.length === 0) return;

  // "Known" means FULLY handled, not merely recorded. Recording the refund and
  // returning our fee are two writes against two systems and cannot be one
  // transaction: if the row lands and the fee refund then fails, a retry that
  // treated the row alone as proof would skip forever and the operator would
  // never be paid back — silently, which is the worst version of it.
  // platform_fee_refunded_cents IS NOT NULL is the completion marker, and the
  // fee refund carries a stable idempotency key so re-running it is safe.
  const { data: knownRows } = await admin
    .from('refunds')
    .select('stripe_refund_id, registration_id, platform_fee_refunded_cents')
    .in('stripe_refund_id', succeeded.map((r) => r.id));
  const known = new Set(
    ((knownRows ?? []) as Array<{ stripe_refund_id: string; registration_id: string; platform_fee_refunded_cents: number | null }>)
      .filter((r) => r.platform_fee_refunded_cents !== null)
      .map((r) => `${r.stripe_refund_id}:${r.registration_id}`),
  );

  for (const refund of succeeded) {
    // ── is this OUR refund? ────────────────────────────────────────────────
    // refund-registration stamps the refunds row id onto the Stripe refund's
    // metadata when it creates it. That is the ONLY signal available at this
    // instant: it writes refunds.stripe_refund_id only AFTER the refund exists
    // in Stripe and after its own applicationFees.createRefund round-trip, so a
    // charge.refunded delivered inside that window finds no row by refund id.
    //
    // Matching on the row id instead closes a real double-spend: without it the
    // webhook treats an in-app partial refund as external and issues a SECOND
    // application-fee refund (a 50% refund would return 100% of the margin),
    // and then refund-registration's own write trips the (stripe_refund_id,
    // registration_id) unique index and leaves its row stuck at 'pending'.
    //
    // The in-app path owns these end to end — it reports a fee-refund failure
    // straight back to the operator — so this path only heals the row id and
    // never touches money.
    const ownRowId = (refund.metadata ?? {}).enrops_refund_id;
    if (ownRowId) {
      const { data: ownRow } = await admin
        .from('refunds')
        .select('id, stripe_refund_id')
        .eq('id', ownRowId)
        .maybeSingle();
      const own = ownRow as { id: string; stripe_refund_id: string | null } | null;
      if (own) {
        if (!own.stripe_refund_id) {
          // Writing the same value refund-registration is about to write is
          // idempotent; doing it here means an in-app call that died between
          // creating the refund and recording its id still leaves a linked row.
          const { error: healErr } = await admin
            .from('refunds')
            .update({ stripe_refund_id: refund.id })
            .eq('id', own.id)
            .is('stripe_refund_id', null);
          if (healErr && (healErr as { code?: string }).code !== '23505') {
            console.error('[charge.refunded] could not link the in-app refund row:', healErr);
          }
        }
        continue; // Enrops-initiated. refund-registration owns the fee refund.
      }
      console.warn(`[charge.refunded] ${refund.id} claims refunds row ${ownRowId}, which does not exist; treating as external`);
    }

    const allocation = allocateRefundAcrossRegistrations(refund.amount ?? 0, slices);
    const unrecorded = allocation.filter((a) => !known.has(`${refund.id}:${a.registrationId}`));
    if (unrecorded.length === 0) continue; // already handled — Enrops-initiated, or a replay

    console.log(
      `[charge.refunded] recording ${refund.id} (${refund.amount}c) against ${unrecorded.length} registration(s)`,
    );

    // The operator's stated reason, for reporting only. v4: "Log the operator's
    // stated refund reason for reporting only, when available. It should never
    // block or delay processing."
    const statedReason = [refund.reason, (refund.metadata ?? {}).reason]
      .filter(Boolean).join(' / ').slice(0, 500) || null;

    for (const slice of unrecorded) {
      await recordExternalRefund(admin, {
        registrationId: slice.registrationId,
        amountCents: slice.amountCents,
        paymentIntentId: piId,
        stripeRefundId: refund.id,
        chargeAccountId,
        reason: statedReason,
        // Stripe's own timestamp for the refund, NOT "when this webhook ran".
        // get_revenue_summary and get_revenue_activity both bucket refunds by
        // succeeded_at, so a retry delivered days later — or a replay — would
        // otherwise drop the money into the wrong reporting period.
        succeededAt: refund.created
          ? new Date(refund.created * 1000).toISOString()
          : new Date().toISOString(),
        // Only a 'succeeded' refund is money. A pending one is recorded so it
        // is visible, but returns no fee and moves no payment_status until it
        // settles — see the status filter above.
        settled: refund.status === 'succeeded',
      });
    }
  }
}

/**
 * Record ONE registration's share of a refund that was issued outside Enrops,
 * and return the unearned part of our fee.
 *
 * Fail-soft per registration on purpose: with a multi-child cart, one child's
 * bookkeeping failing must not stop the others being recorded. Anything that
 * goes wrong is logged loudly, because it is money.
 */
async function recordExternalRefund(
  admin: SupabaseClient,
  input: {
    registrationId: string;
    amountCents: number;
    paymentIntentId: string;
    stripeRefundId: string;
    chargeAccountId: string | null;
    reason: string | null;
    succeededAt: string;
    settled: boolean;
  },
) {
  const { data: regData } = await admin
    .from('registrations')
    .select('id, organization_id, program_id, camp_session_id, parent_id, student_id, payment_status')
    .eq('id', input.registrationId)
    .maybeSingle();
  const reg = regData as {
    id: string; organization_id: string; program_id: string | null; camp_session_id: string | null;
    parent_id: string | null; student_id: string | null; payment_status: string | null;
  } | null;
  if (!reg) {
    console.error(`[charge.refunded] registration ${input.registrationId} vanished; skipping`);
    return;
  }

  const { data: orgRow } = await admin
    .from('organizations')
    .select('stripe_fee_payer, stripe_account_id')
    .eq('id', reg.organization_id)
    .maybeSingle();
  const org = orgRow as { stripe_fee_payer?: string; stripe_account_id?: string | null } | null;

  // SAME-ORG GUARD. This handler runs with the service role, so RLS is not
  // protecting anything here — the only thing tying this charge to this
  // registration is a payment_intent id we looked up. For a connected-account
  // event, assert that the registration's org really owns the account the
  // charge lived on before moving any money. Refusing costs us a log line;
  // guessing wrong refunds one operator's fee out of another's balance.
  if (input.chargeAccountId && org?.stripe_account_id !== input.chargeAccountId) {
    console.error(
      `[charge.refunded] REFUSING ${input.stripeRefundId}: registration ${reg.id} belongs to org ` +
      `${reg.organization_id} (account ${org?.stripe_account_id ?? 'none'}), but the charge lived on ` +
      `${input.chargeAccountId}. Not recording and not refunding any fee.`,
    );
    return;
  }

  // Insert first, so the UNIQUE (stripe_refund_id, registration_id) is what
  // decides whether this is a replay — not a read we did earlier that could
  // have raced another delivery of the same event.
  const { data: rowData, error: insErr } = await admin
    .from('refunds')
    .insert({
      registration_id: reg.id,
      organization_id: reg.organization_id,
      stripe_payment_intent_id: input.paymentIntentId,
      stripe_refund_id: input.stripeRefundId,
      amount_cents: input.amountCents,
      reason: input.reason,
      // NULL = nobody in Enrops did this; it came from the operator's own
      // Stripe dashboard. That is the flag reporting uses to tell the two
      // origins apart.
      refunded_by_user_id: null,
      status: input.settled ? 'succeeded' : 'pending',
      succeeded_at: input.settled ? input.succeededAt : null,
    })
    .select('id')
    .single();

  let refundRowId: string;
  // Null unless we adopt a row somebody else created; see the enrollment event.
  let refundedByUserId: string | null = null;
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') {
      // Already recorded, but we only get here when the fee was NOT settled
      // (see the `known` filter). Adopt the existing row and finish the job
      // rather than returning — this is the retry that repairs a half-done
      // refund. Deliberately does NOT re-record or re-refund the family.
      const { data: existing } = await admin
        .from('refunds')
        .select('id, refunded_by_user_id')
        .eq('stripe_refund_id', input.stripeRefundId)
        .eq('registration_id', reg.id)
        .maybeSingle();
      const existingRow = existing as { id: string; refunded_by_user_id: string | null } | null;
      const found = existingRow?.id;
      refundedByUserId = existingRow?.refunded_by_user_id ?? null;
      if (!found) {
        console.error(`[charge.refunded] 23505 but no row found for ${input.stripeRefundId}/${reg.id}`);
        return;
      }
      console.log(`[charge.refunded] resuming a half-finished refund ${input.stripeRefundId} for ${reg.id}`);
      refundRowId = found;
      // A row first written while the refund was pending must be promoted the
      // moment Stripe settles it, or it stays invisible to get_revenue_summary
      // (which filters status='succeeded') forever.
      if (input.settled) {
        await admin
          .from('refunds')
          .update({ status: 'succeeded', succeeded_at: input.succeededAt, failure_reason: null })
          .eq('id', found)
          .neq('status', 'succeeded');
      }
    } else {
      console.error('[charge.refunded] failed to record the refund row:', insErr);
      return;
    }
  } else {
    refundRowId = (rowData as { id: string }).id;
  }

  // Not settled yet: the row exists and is visible, but nothing else may
  // happen. Returning our fee — or moving payment_status — for a refund that
  // can still bounce at the bank would leave the fee paid out and the family
  // marked refunded with no way back. platform_fee_refunded_cents stays NULL,
  // which is exactly what makes the next delivery pick this up and finish it.
  if (!input.settled) {
    console.log(`[charge.refunded] ${input.stripeRefundId} is still pending; recorded, no fee refund yet`);
    return;
  }

  // ── fire the prorated application-fee refund (v4 section 2 + 3) ───────────
  let feeRefunded = 0;
  try {
    const proration = await loadProration(admin, {
      organization_id: reg.organization_id,
      program_id: reg.program_id,
      camp_session_id: reg.camp_session_id,
    });
    const facts = await readChargeFeeFacts(stripe, input.paymentIntentId, input.chargeAccountId);

    // Legacy own-platform destination orgs (stripe_fee_payer != 'tenant') carry
    // no uplift and no third party to make whole, so they get no fee refund —
    // same guard as refund-registration, so the two paths cannot diverge.
    const feeRefundApplies = input.chargeAccountId !== null || org?.stripe_fee_payer === 'tenant';

    const owed = feeRefundApplies
      ? computeMarginRefund({
          applicationFeeCents: facts.applicationFeeCents,
          stripeFeeCents: facts.stripeFeeCents,
          chargeAmountCents: facts.chargeAmountCents,
          refundAmountCents: input.amountCents,
          alreadyRefundedFeeCents: facts.alreadyRefundedFeeCents,
          remainingFraction: proration.fraction,
        })
      : 0;

    // ALREADY DONE? Ask Stripe, don't infer. A fee refund we issued carries the
    // Stripe refund id and registration it covered, so a retry can see its own
    // earlier work directly. This is what makes the resume path safe: without
    // it, a retry either skips forever (operator never paid) or re-refunds
    // (paid twice), and an idempotency key cannot break the tie because the
    // recomputed amount legitimately shifts as other refunds land on the same
    // charge.
    const existingFeeRefund = facts.feeRefunds.find(
      (fr) =>
        fr.metadata[FEE_REFUND_SOURCE_KEY] === input.stripeRefundId &&
        fr.metadata[FEE_REFUND_REGISTRATION_KEY] === reg.id,
    );

    if (existingFeeRefund) {
      feeRefunded = existingFeeRefund.amount;
      console.log(
        `[charge.refunded] fee for ${input.stripeRefundId}/${reg.id} was already returned (${feeRefunded}c); recording only`,
      );
    } else if (owed > 0 && facts.applicationFeeId) {
      // Platform-scoped even for a direct charge: the ApplicationFee belongs to
      // the platform on both charge models. The idempotency key still guards
      // two deliveries racing within the same instant; the metadata check above
      // is what guards a retry minutes or hours later.
      try {
        const feeRefund = await stripe.applicationFees.createRefund(
          facts.applicationFeeId,
          {
            amount: owed,
            metadata: {
              [FEE_REFUND_SOURCE_KEY]: input.stripeRefundId,
              [FEE_REFUND_REGISTRATION_KEY]: reg.id,
            },
          },
          { idempotencyKey: `appfee_ext_${input.stripeRefundId}_${reg.id}` },
        );
        feeRefunded = feeRefund.amount ?? owed;
      } catch (keyErr) {
        // An idempotency-key conflict is PROOF that a call with this exact key
        // already went through - only the amount has since drifted, because
        // other refunds landed on the same charge in between. That can only
        // happen for a fee refund issued before we started tagging them.
        // Without this branch the row stays unsettled and retries forever.
        // Untagged refunds cannot occur going forward (prod has none, and every
        // new one is tagged at creation), so this is a terminator, not a path.
        const code = (keyErr as { raw?: { type?: string; code?: string } }).raw;
        const isKeyConflict = code?.type === 'idempotency_error' || code?.code === 'idempotency_key_in_use';
        if (!isKeyConflict) throw keyErr;
        // The fee WAS returned - but by how much, we cannot know: the amount has
        // drifted since, and the original call carries no tag to read it off.
        // Deliberately do NOT write a guess into a money column. Leave the row
        // unsettled and loudly flagged so a human reconciles it. Nothing is
        // stuck: the handler still returns 200, so Stripe does not retry, and
        // no money is at risk - only this one record is incomplete.
        // Unreachable for anything created after tagging shipped, and prod has
        // no pre-tagging refunds at all.
        throw new Error(
          `the platform fee was already returned by an untagged earlier call, so its exact amount ` +
          `could not be attributed to this refund. Reconcile ${facts.applicationFeeId} by hand.`,
        );
      }
    }

    await admin.from('refunds')
      .update({ platform_fee_refunded_cents: feeRefunded })
      .eq('id', refundRowId);
  } catch (feeErr) {
    // The family already has their money — Stripe did that before telling us.
    // What may not have happened is returning our fee. Never swallow it: this
    // is money owed to the operator and it is invisible unless we say so.
    const m = feeErr as { raw?: { message?: string }; message?: string };
    const msg = m.raw?.message ?? m.message ?? 'unknown';
    console.error(
      `[charge.refunded] recorded ${input.stripeRefundId} but the platform-fee refund FAILED for registration ${reg.id}: ${msg}`,
    );
    await admin.from('refunds')
      .update({ failure_reason: `refund recorded from Stripe, but returning the platform fee failed: ${msg}` })
      .eq('id', refundRowId);
  }

  // ── advance payment_status, same rule as refund-registration ──────────────
  try {
    const { data: paidRows } = await admin
      .from('refunds')
      .select('amount_cents')
      .eq('registration_id', reg.id)
      .eq('status', 'succeeded');
    const totalRefunded = ((paidRows ?? []) as Array<{ amount_cents: number }>)
      .reduce((s, r) => s + (r.amount_cents || 0), 0);

    const { data: instPaid } = await admin
      .from('installments')
      .select('amount_cents, stripe_payment_intent_id, stripe_charge_account_id')
      .eq('registration_id', reg.id)
      .eq('status', 'paid');
    const instRowsPaid = ((instPaid ?? []) as Array<{
      amount_cents: number; stripe_payment_intent_id: string | null; stripe_charge_account_id: string | null;
    }>);
    const instTotal = instRowsPaid.reduce((s, r) => s + (r.amount_cents || 0), 0);
    const { data: regAmt } = await admin
      .from('registrations').select('amount_cents').eq('id', reg.id).maybeSingle();
    const basePaid = instTotal > 0 ? instTotal : ((regAmt as { amount_cents?: number } | null)?.amount_cents ?? 0);

    // COMPARE LIKE WITH LIKE. refunds.amount_cents is what the card was actually
    // credited — base PLUS any platform fee passed through to the family —
    // whereas installments/registrations.amount_cents is the BASE price only.
    // Comparing the two directly marks a registration fully 'refunded' as soon
    // as the base is covered, while the family is still owed the fee portion,
    // and disagrees with refund-registration, which raises its ceiling to the
    // real charged amount for exactly this reason.
    //
    // Absorb orgs charged base only, so the ceiling is unchanged for them; the
    // reads are cheap and only happen on a refund.
    const piScopes = new Map<string, string | null>();
    for (const r of instRowsPaid) {
      if (r.stripe_payment_intent_id) piScopes.set(r.stripe_payment_intent_id, r.stripe_charge_account_id ?? null);
    }
    if (piScopes.size === 0) piScopes.set(input.paymentIntentId, input.chargeAccountId);

    let chargedPaid = 0;
    for (const [pi, acct] of piScopes) {
      try {
        const facts = await readChargeFeeFacts(stripe, pi, acct);
        // This registration's share of that charge, split by the base amounts
        // that made it up — a PI can cover a multi-child cart.
        const { data: sharers } = await admin
          .from('installments').select('amount_cents').eq('stripe_payment_intent_id', pi);
        let baseOnPi = ((sharers ?? []) as Array<{ amount_cents: number }>)
          .reduce((s, r) => s + (r.amount_cents || 0), 0);
        if (baseOnPi <= 0) {
          const { data: regSharers } = await admin
            .from('registrations').select('amount_cents').eq('stripe_payment_intent_id', pi);
          baseOnPi = ((regSharers ?? []) as Array<{ amount_cents: number | null }>)
            .reduce((s, r) => s + (r.amount_cents || 0), 0);
        }
        const mine = instRowsPaid
          .filter((r) => r.stripe_payment_intent_id === pi)
          .reduce((s, r) => s + (r.amount_cents || 0), 0)
          || basePaid;
        chargedPaid += baseOnPi > 0 ? Math.round((facts.chargeAmountCents * mine) / baseOnPi) : mine;
      } catch (ceilErr) {
        console.error(`[charge.refunded] could not read the charged total for ${pi}; using base`, ceilErr);
        chargedPaid = 0; // fall back below rather than under-count
        break;
      }
    }
    // Never LOWER the ceiling: if the maths disagrees, keep the base.
    const totalPaid = Math.max(basePaid, chargedPaid);

    const newStatus = totalPaid > 0 && totalRefunded >= totalPaid ? 'refunded'
      : totalRefunded > 0 ? 'partial'
      : null;
    if (newStatus && newStatus !== reg.payment_status) {
      await admin.from('registrations').update({ payment_status: newStatus }).eq('id', reg.id);
    }
  } catch (statusErr) {
    console.error('[charge.refunded] payment_status update failed (non-fatal):', statusErr);
  }

  // Same churn signal the in-app path logs, so reporting does not depend on
  // where the refund was started.
  await logEnrollmentEvent(admin, {
    organizationId: reg.organization_id,
    parentId: reg.parent_id,
    studentId: reg.student_id,
    programId: reg.program_id,
    campSessionId: reg.camp_session_id,
    registrationId: reg.id,
    actionType: ENROLLMENT_ACTIONS.REFUNDED,
    metadata: {
      amount_refunded_cents: input.amountCents,
      platform_fee_refunded_cents: feeRefunded,
      // Read the origin off the row rather than asserting it. This function
      // also runs on the adopt path, which can be repairing a row somebody
      // created in Enrops; hardcoding the label would quietly file those under
      // "operator refunded in Stripe" and make any origin reporting wrong for
      // exactly the failure cases.
      origin: refundedByUserId ? 'enrops' : 'stripe_dashboard',
    },
    dedupeKey: `refunded:${input.stripeRefundId}:${reg.id}`,
  });
}

async function autoCreateParentAccount(
  admin: SupabaseClient,
  brand: OrgBrand,
  email: string,
  name: string,
  orgSlug: string,
  alertEmail: string,
) {
  // Paginate through ALL auth users. A bare listUsers() returns only the first
  // page (default 50), so past that the existence check reads FALSE for parents
  // who do have an account -- we then attempt createUser on every checkout and
  // rely on it throwing "already been registered" to reach the right branch.
  // Same fix, same shape, as invite-parents.
  const existing = await findAuthUserByEmail(admin, email);

  if (existing) {
    console.log(`Auth user already exists for ${email}, sending dashboard link email`);
    // DELIBERATELY does not link parents.auth_id here. The address is whatever
    // was typed into guest checkout and nobody has proven control of it, so
    // linking on it would hand a family's records to the real owner of a
    // mistyped address. The link happens in claim_parent_record() (20260727b)
    // when they sign in, which is the moment that proof exists -- and the email
    // below is exactly what carries them there.
    await sendAccountReadyEmail(admin, brand, email, name, orgSlug, false);
    return;
  }

  const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name },
  });

  if (createErr) {
    if (createErr.message?.includes('already been registered')) {
      console.log(`Auth user already registered for ${email} (race condition), sending dashboard link`);
      await sendAccountReadyEmail(admin, brand, email, name, orgSlug, false);
      return;
    }
    console.error(`Failed to create auth user for ${email}:`, createErr);
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Auto-create account failed for ${email}`,
      body: `Could not create auth user for ${email} after successful payment. Error: ${createErr.message}. The parent can still create an account manually at ${PUBLIC_SITE_URL}/${orgSlug}/login.`,
    });
    return;
  }

  console.log(`Auth user created for ${email}: ${newUser?.user?.id}`);
  await sendAccountReadyEmail(admin, brand, email, name, orgSlug, true);
}

async function sendAccountReadyEmail(admin: SupabaseClient, brand: OrgBrand, email: string, name: string, orgSlug: string, isNew: boolean) {
  const firstName = name ? name.split(' ')[0] : 'there';
  const dashboardUrl = `${PUBLIC_SITE_URL}/${orgSlug}/dashboard`;
  const loginUrl = `${PUBLIC_SITE_URL}/${orgSlug}/login`;
  const loginDisplay = loginUrl.replace(/^https?:\/\//, '');

  let signInUrl = loginUrl;
  try {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: dashboardUrl },
    });
    if (linkData?.properties?.action_link) {
      signInUrl = linkData.properties.action_link;
      console.log(`Magic link generated for ${email}`);
    } else {
      console.warn('generateLink returned no action_link:', linkErr?.message);
    }
  } catch (err) {
    console.warn('generateLink failed, falling back to login URL:', (err as Error).message);
  }

  const subject = isNew
    ? `Your parent account is ready — ${brand.org_name}`
    : `See your child's program details — ${brand.org_name}`;

  const logoBlock = brand.logo_url
    ? `<img src="${brand.logo_url}" alt="${escapeHtml(brand.org_name)}" style="max-height:40px;display:block;margin:0 auto 12px;" />`
    : `<div style="color:${brand.accent_color};font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(brand.org_name)}</div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Your Account</title></head><body style="margin:0;padding:0;background:${brand.page_bg_color};font-family:${brand.font_family};"><div style="max-width:600px;margin:0 auto;background:#fff;"><div style="background:linear-gradient(135deg,${brand.primary_color},${brand.secondary_color});padding:40px 30px;text-align:center;">${logoBlock}<h1 style="color:#fff;margin:12px 0 0;font-family:'Titan One',Georgia,serif;font-size:28px;">${isNew ? 'Your account is ready!' : 'View your programs'}</h1></div><div style="padding:32px 30px;"><p style="margin:0 0 16px;font-size:16px;color:#1A1530;">Hi ${escapeHtml(firstName)},</p><p style="margin:0 0 24px;font-size:16px;color:#1A1530;line-height:1.6;">${isNew ? 'We created a parent account for you automatically when you registered. Tap the button below to see your child\'s program schedule and arrival details.' : 'Tap the button below to view your children\'s program details and schedules.'}</p><div style="text-align:center;margin:32px 0;"><a href="${signInUrl}" style="display:inline-block;background:${brand.primary_color};color:#fff;text-decoration:none;padding:16px 40px;border-radius:8px;font-size:16px;font-weight:700;">View my dashboard</a></div><p style="margin:0 0 8px;font-size:14px;color:#6b6880;">This link expires in 24 hours. After that, you can always sign in at <a href="${loginUrl}" style="color:${brand.primary_color};">${loginDisplay}</a> using the magic link option.</p><p style="margin:24px 0 0;font-size:14px;color:#6b6880;">Questions? Reach us at <a href="mailto:${brand.reply_to}" style="color:${brand.primary_color};">${brand.reply_to}</a></p></div><div style="background:#1A1530;padding:20px 30px;text-align:center;color:#fff;opacity:0.6;font-size:12px;">${escapeHtml(brand.org_name)} &middot; Powered by Enrops &middot; ${new Date().getFullYear()}</div></div></body></html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: formatFromAddress(brand), to: email, subject, html,
        reply_to: brand.reply_to,
        tags: [{ name: 'type', value: isNew ? 'account_created' : 'account_reminder' }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Account email send failed:', resp.status, errText);
    } else {
      console.log(`Account ${isNew ? 'created' : 'reminder'} email sent to ${email}`);
    }
  } catch (err) {
    console.error('Account email error:', err);
  }
}

async function sendOperatorAlert({ brand, to, subject, body }: { brand: OrgBrand; to: string; subject: string; body: string }) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: formatFromAddress(brand), to,
        subject: `[Enrops Alert] ${subject}`, text: body,
        tags: [{ name: 'type', value: 'operator_alert' }],
      }),
    });
  } catch (err) {
    console.error('Operator alert send failed:', err);
  }
}

async function sendConfirmationEmail({
  admin, brand, to, parentName, registrations, totalCents, sessionId, useInstallments, installmentInfo,
}: {
  admin: SupabaseClient;
  brand: OrgBrand;
  to: string; parentName: string; registrations: any[]; totalCents: number; sessionId: string; useInstallments: boolean;
  installmentInfo: { paidToday: number; installment2Amount: number; installment2Date: string; installment3Amount: number; installment3Date: string; } | null;
}) {
  // Check the org's thank-you automation toggle + override. The automations row
  // is created lazily — operators who never visited the Automations tab have no
  // row and get the default behavior (send the email, use template defaults
  // baked here). Toggling enabled=false explicitly suppresses the send.
  const { data: thankYouAutomation } = await admin
    .from('automations')
    .select(`
      enabled, subject_override, body_override,
      template:automation_templates!inner ( key, default_subject, default_body )
    `)
    .eq('organization_id', brand.org_id)
    .eq('template.key', 'thank_you')
    .maybeSingle() as { data: { enabled: boolean; subject_override: string | null; body_override: string | null; template: { default_subject: string; default_body: string } } | null };

  if (thankYouAutomation && thankYouAutomation.enabled === false) {
    console.log(`[stripe-webhook] thank_you disabled for org ${brand.org_id} — skipping confirmation email`);
    return;
  }

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const fmtDate = (iso: string) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const greeting = parentName ? `Hi ${parentName.split(' ')[0]}` : 'Hi there';

  const hasAnyArrival = registrations.some((r) => r.programs?.program_locations?.arrival_instructions || r.programs?.program_locations?.dismissal_instructions);

  const regRows = registrations.map((r) => {
    const p = r.programs;
    const s = r.students;
    const loc = p?.program_locations;
    const locationName = loc?.name || '';
    const programName = p?.curriculum || 'Program';
    const timeDisplay = p?.start_time
      ? (p?.end_time ? `${p.start_time}&ndash;${p.end_time}` : p.start_time)
      : '';
    const firstDate = p?.first_session_date ? fmtDate(p.first_session_date) : 'Date TBD';

    const hasArrival = !!(loc?.arrival_instructions || loc?.dismissal_instructions);
    const arrivalRow = hasArrival
      ? (() => {
          const parts: string[] = [];
          if (loc.arrival_instructions) parts.push(`<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${brand.primary_color};margin-bottom:4px;">Arrival</div><div style="font-size:13px;color:#1A1530;line-height:1.6;">${loc.arrival_instructions}</div>`);
          if (loc.dismissal_instructions) parts.push(`<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${brand.primary_color};margin:${loc.arrival_instructions ? '12px 0 4px' : '0 0 4px'};">Dismissal</div><div style="font-size:13px;color:#1A1530;line-height:1.6;">${loc.dismissal_instructions}</div>`);
          return `<tr><td colspan="2" style="padding:0 16px 16px;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="padding:10px 12px;background:#F9F8FE;border-radius:8px;border-left:3px solid ${brand.primary_color};font-family:${brand.font_family};">${parts.join('')}</td></tr></table></td></tr>`;
        })()
      : '';

    return `<tr>
        <td style="padding:16px 16px ${hasArrival ? '8px' : '16px'};border-bottom:${hasArrival ? 'none' : '1px solid #EDE9FE'};font-family:${brand.font_family};">
          <div style="font-size:16px;font-weight:700;color:#1A1530;">${programName}</div>
          <div style="font-size:14px;color:#6b6880;margin-top:4px;">${s?.first_name || ''} ${s?.last_name || ''} &middot; ${locationName}</div>
          <div style="font-size:14px;color:#6b6880;margin-top:4px;">${p?.day_of_week || ''}s &middot; ${timeDisplay}</div>
          <div style="font-size:13px;color:${brand.primary_color};margin-top:8px;font-weight:600;">First session: ${firstDate}</div>
        </td>
        <td style="padding:16px;text-align:right;vertical-align:top;border-bottom:${hasArrival ? 'none' : '1px solid #EDE9FE'};font-family:${brand.font_family};font-weight:700;color:#1A1530;">
          ${fmt(r.amount_cents)}
        </td>
      </tr>${hasArrival ? `${arrivalRow}<tr><td colspan="2" style="border-bottom:1px solid #EDE9FE;"></td></tr>` : ''}`;
  }).join('');

  const totalsBlock = useInstallments && installmentInfo
    ? `<tr><td colspan="2" style="padding:20px 16px;background:#F5F3FF;"><div style="font-family:${brand.font_family};font-size:15px;font-weight:700;color:${brand.secondary_color};margin-bottom:12px;">Your payment plan</div><table cellpadding="0" cellspacing="0" style="width:100%;font-family:${brand.font_family};font-size:14px;color:#1A1530;"><tr><td style="padding:6px 0;">Today (paid)</td><td style="padding:6px 0;text-align:right;font-weight:700;">${fmt(installmentInfo.paidToday)}</td></tr><tr><td style="padding:6px 0;">Installment 2 &middot; ${fmtDate(installmentInfo.installment2Date)}</td><td style="padding:6px 0;text-align:right;">${fmt(installmentInfo.installment2Amount)}</td></tr><tr><td style="padding:6px 0;">Installment 3 &middot; ${fmtDate(installmentInfo.installment3Date)}</td><td style="padding:6px 0;text-align:right;">${fmt(installmentInfo.installment3Amount)}</td></tr><tr><td style="padding:8px 0 0;border-top:1px solid #DDD8FA;font-weight:700;">Total</td><td style="padding:8px 0 0;border-top:1px solid #DDD8FA;text-align:right;font-weight:700;">${fmt(installmentInfo.paidToday + installmentInfo.installment2Amount + installmentInfo.installment3Amount)}</td></tr></table><div style="font-family:${brand.font_family};font-size:12px;color:#6b6880;margin-top:10px;">Your card on file will be charged automatically on each date. We'll email you before each charge.</div></td></tr>`
    : `<tr><td style="padding:20px 16px;font-family:${brand.font_family};font-size:18px;font-weight:700;color:#1A1530;">Total paid</td><td style="padding:20px 16px;text-align:right;font-family:'Titan One',Georgia,serif;font-size:24px;color:${brand.accent_color};">${fmt(totalCents)}</td></tr>`;

  // Build the auto-generated summary block — operators who customize the body
  // get this slotted in via the {{registration_summary_block}} token. Wraps
  // the registration table + totals/payment plan in a single <table>.
  const summaryBlock = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:24px;font-family:${brand.font_family};">
        ${regRows}
        ${totalsBlock}
      </table>`;

  // White-background email shell — logo on top, no platform-color gradient.
  // Matches the lifecycle-automations-cron shell so tenants get a consistent
  // look across every email Enrops sends on their behalf.
  const logoBlock = brand.logo_url
    ? `<img src="${brand.logo_url}" alt="${escapeHtml(brand.org_name)}" style="max-height:56px;display:block;margin:0 auto;" />`
    : `<div style="color:${brand.primary_color};font-size:18px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;text-align:center;">${escapeHtml(brand.org_name)}</div>`;

  const senderShortName = (brand.sender_name?.split(' @ ')[0]?.trim()) || brand.org_name;
  const childFirstName = registrations[0]?.students?.first_name || 'your child';

  // ── Calendar invite ──────────────────────────────────────────────────────
  // Build a real, closure-aware .ics from each program's derived session dates
  // (never hardcoded — derive_program_session_dates honors location/district
  // closures) plus the program's stored class time. Attach the .ics (works in
  // Apple/Google/Outlook) and offer per-program Google Calendar quick-add links.
  // Fully tenant-neutral: names come from the org's own rows. If nothing can be
  // derived (e.g. undated program), the block and attachment are simply omitted.
  let calendarBlock = '';
  const calendarAttachments: { filename: string; content: string }[] = [];
  try {
    const events = await calendarEventsFromRegistrations(
      registrations,
      brand.org_name,
      async (pid: string) => {
        const { data } = await admin.rpc('derive_program_session_dates', { p_program_id: pid });
        return (data as string[] | null) ?? [];
      },
    );
    const ics = buildIcs(events, { uidSeed: sessionId, nowIso: new Date().toISOString() });
    if (ics) {
      calendarAttachments.push({ filename: 'your-classes.ics', content: toBase64(ics) });
      const totalSessions = events.reduce((n, e) => n + e.sessionDates.length, 0);
      const googleButtons = events
        .map((e) => {
          const url = googleCalendarUrl(e);
          if (!url) return '';
          // Escape the & param separators for HTML (values are already
          // percent-encoded by googleCalendarUrl, so only the raw & need it).
          const safeUrl = url.replace(/&/g, '&amp;');
          return `<a href="${safeUrl}" style="display:inline-block;margin:4px 8px 4px 0;padding:8px 14px;background:${brand.primary_color};color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;">${escapeHtml(e.programName)} in Google Calendar</a>`;
        })
        .join('');
      calendarBlock = `<div style="background:#F5F3FF;border-radius:12px;padding:20px;margin:0 0 24px;font-family:${brand.font_family};">
  <div style="font-weight:700;color:${brand.secondary_color};margin-bottom:6px;">Add to your calendar</div>
  <p style="margin:0 0 12px;font-size:14px;color:#1A1530;line-height:1.6;">The attached file (<strong>your-classes.ics</strong>) adds all ${totalSessions} session${totalSessions === 1 ? '' : 's'} in one tap. It works with Apple Calendar, Google Calendar, and Outlook.</p>
  ${googleButtons ? `<p style="margin:0 0 8px;font-size:13px;color:#6b6880;">Prefer Google Calendar? Add your first session:</p><div>${googleButtons}</div>` : ''}
</div>`;
    }
  } catch (calErr) {
    console.error('[stripe-webhook] calendar invite build failed:', calErr);
  }

  // Render the body — operator's override takes precedence over the template
  // default. {{registration_summary_block}} resolves to the auto-table here
  // (stripe-webhook is the only path that emits this token).
  const overrideBody = thankYouAutomation?.body_override
    || thankYouAutomation?.template?.default_body
    || null;
  const overrideSubject = thankYouAutomation?.subject_override
    || thankYouAutomation?.template?.default_subject
    || null;

  let innerBody: string;
  if (overrideBody) {
    innerBody = overrideBody
      .replace(/\{\{first_name\}\}/g, escapeHtml(parentName ? parentName.split(' ')[0] : 'there'))
      .replace(/\{\{child_first_name\}\}/g, escapeHtml(childFirstName))
      .replace(/\{\{org_name\}\}/g, escapeHtml(brand.org_name))
      .replace(/\{\{sender_name\}\}/g, escapeHtml(senderShortName))
      .replace(/\{\{registration_summary_block\}\}/g, summaryBlock);
  } else {
    // No template available yet (org never visited Automations tab AND we
    // couldn't load the default from automation_templates). Fall back to the
    // legacy hardcoded structure so existing tenants keep getting confirmation
    // emails. Same white-shell wrapping as above.
    const arrivalNote = hasAnyArrival
      ? "<li>Arrival and dismissal details are listed above for each program</li>"
      : "<li>We'll share arrival and dismissal details before the first session</li>";
    innerBody = `<p>${escapeHtml(greeting)},</p>
<p>Thanks for signing up! Here's everything you need to know for your child's program.</p>
${summaryBlock}
<div style="background:#EDE9FE;border-radius:12px;padding:20px;margin-bottom:24px;">
  <div style="font-weight:700;color:${brand.secondary_color};margin-bottom:8px;">What happens next?</div>
  <ul style="margin:0;padding-left:20px;color:#1A1530;font-size:14px;line-height:1.8;">
    <li>We'll send a reminder email before the first session</li>
    ${arrivalNote}
    <li>Check your inbox for a separate email with access to your parent dashboard</li>
  </ul>
</div>
<p>Questions? Reach us at <a href="mailto:${brand.reply_to}" style="color:${brand.primary_color};">${brand.reply_to}</a></p>`;
  }

  // color-scheme meta tags prevent Gmail/Apple Mail from auto-inverting the
  // white background in dark mode. Matches the lifecycle-cron shell.
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>Registration Confirmation</title></head>
<body style="margin:0;padding:0;background:#fbfaf6;font-family:${brand.font_family};color-scheme:light only;supported-color-schemes:light;">
<div style="max-width:600px;margin:0 auto;background:#fff;">
<div style="padding:32px 30px 8px;text-align:center;">${logoBlock}</div>
<div style="padding:16px 30px 32px;color:#1A1530;font-size:16px;line-height:1.6;">
${innerBody}
${calendarBlock}
${renderSignatureBlock(brand)}
</div>
<div style="padding:18px 30px;text-align:center;color:#888;font-size:11px;border-top:1px solid #eee;">
${escapeHtml(brand.org_name)} · ${new Date().getFullYear()}<br />
<a href="https://getenrops.com" style="color:#8C88FF;text-decoration:none;font-weight:700;">Powered by enrops</a> &mdash; start your own program free at <a href="https://getenrops.com" style="color:#8C88FF;text-decoration:none;">getenrops.com</a>
</div>
</div>
</body></html>`;

  // Plain-text MIME fallback for accessibility tools + Outlook configs that
  // prefer text/plain. Resend handles multipart packaging when both `html`
  // and `text` are present.
  const plainText = innerBody
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => `${text} (${href})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    + (calendarAttachments.length ? "\n\nAdd to your calendar: the attached file (your-classes.ics) adds all your sessions in one tap (Apple Calendar, Google Calendar, and Outlook)." : "")
    + `\n\n${brand.org_name} · ${new Date().getFullYear()}\nPowered by enrops — start your own program free at https://getenrops.com`;

  // Subject — operator override (with {{tokens}} resolved) wins; else fall
  // back to the legacy installments-aware subject for backward compatibility.
  const renderedSubject = overrideSubject
    ? overrideSubject
        .replace(/\{\{first_name\}\}/g, parentName ? parentName.split(' ')[0] : 'there')
        .replace(/\{\{child_first_name\}\}/g, childFirstName)
        .replace(/\{\{org_name\}\}/g, brand.org_name)
        .replace(/\{\{sender_name\}\}/g, senderShortName)
    : useInstallments
      ? `You're registered! Your payment plan is set — ${brand.org_name}`
      : `You're registered! — ${brand.org_name}`;

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: formatFromAddress(brand), to,
      reply_to: brand.reply_to,
      subject: renderedSubject,
      html,
      text: plainText,
      ...(calendarAttachments.length ? { attachments: calendarAttachments } : {}),
      tags: [
        { name: 'type', value: useInstallments ? 'registration_confirmation_installments' : 'registration_confirmation' },
        { name: 'session', value: sessionId },
      ],
    }),
  });

  if (!resendResp.ok) {
    const body = await resendResp.text();
    console.error('Resend send failed:', resendResp.status, body);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// v18 — operator-side Stripe Connect event handlers
// ───────────────────────────────────────────────────────────────────────────

interface OrgConnectRow {
  id: string;
  name: string | null;
  alert_email: string | null;
  stripe_account_status: string | null;
  stripe_last_account_event_id: string | null;
}

async function handleAccountUpdated(
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  const account = event.data.object as Stripe.Account;
  const accountId = account.id;

  // Find the org. No match = either an instructor connected account under the
  // enrops_platform path, or an event for a different system entirely.
  const { data } = await admin
    .from('organizations')
    .select('id, name, alert_email, stripe_account_status, stripe_last_account_event_id')
    .eq('stripe_account_id', accountId)
    .maybeSingle();
  const org = data as OrgConnectRow | null;

  if (!org) {
    // Fall through to instructor-account routing.
    await handleInstructorAccountUpdated(admin, event, account, accountId);
    return;
  }

  // Idempotency.
  if (org.stripe_last_account_event_id === event.id) {
    console.log(`[stripe-webhook] account.updated event ${event.id} already processed for org ${org.id}`);
    return;
  }

  // Map Stripe state to our enum. 6 buckets:
  //   active        — charges + payouts both enabled
  //   verifying     — everything submitted, Stripe is REVIEWING, nothing is
  //                   required from the operator
  //   restricted    — Stripe disabled the account for a reason the operator
  //                   must actually act on
  //   onboarding    — hasn't completed the onboarding form yet
  //   disconnected  — operator disconnected (handled by deauthorize, not here)
  //   not_connected — never connected (handled at insert time, not here)
  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;
  const disabledReason = account.requirements?.disabled_reason || null;
  const wasActive = org.stripe_account_status === 'active';

  // Not every disabled_reason is the operator's problem. These two mean the
  // opposite of "we need something from you" — the form is done,
  // requirements.currently_due is empty, and Stripe is just reviewing (usually
  // for well under a minute). Collapsing them into 'restricted' made the
  // Finances screen tell an operator who had done everything correctly to go
  // supply information Stripe wasn't asking for. Observed live 2026-07-27.
  const PENDING_REVIEW_REASONS = ['requirements.pending_verification', 'under_review'];
  const isPendingReview = disabledReason !== null && PENDING_REVIEW_REASONS.includes(disabledReason);

  let nextStatus: 'active' | 'restricted' | 'verifying' | 'onboarding';
  if (chargesEnabled && payoutsEnabled) {
    nextStatus = 'active';
  } else if (detailsSubmitted && isPendingReview) {
    nextStatus = 'verifying';
  } else if (detailsSubmitted && !chargesEnabled && disabledReason) {
    nextStatus = 'restricted';
  } else {
    nextStatus = 'onboarding';
  }

  const regressed = wasActive && nextStatus !== 'active';

  const { error: updErr } = await admin
    .from('organizations')
    .update({
      stripe_charges_enabled: chargesEnabled,
      stripe_payouts_enabled: payoutsEnabled,
      stripe_account_status: nextStatus,
      stripe_last_account_event_id: event.id,
    })
    .eq('id', org.id);

  if (updErr) {
    console.error(`[stripe-webhook] failed to update org ${org.id}:`, updErr);
    return;
  }

  console.log(
    `[stripe-webhook] account.updated: org ${org.id} -> ${nextStatus} ` +
    `(charges=${chargesEnabled}, payouts=${payoutsEnabled}, details=${detailsSubmitted}, disabled=${disabledReason ?? 'none'})`,
  );

  if (regressed && org.alert_email) {
    const brand = await loadOrgBrand(admin, org.id);
    await sendOperatorAlert({
      brand,
      to: org.alert_email,
      subject: `Stripe paused payments for ${org.name || 'your organization'}`,
      body:
        `Stripe has paused your ability to receive payments. New state: ${nextStatus}.\n\n` +
        (disabledReason ? `Reason from Stripe: ${disabledReason}\n\n` : '') +
        `Open the Finances tab in your Enrops admin portal to continue verification, ` +
        `or contact Stripe support directly. Until this is resolved, new parent payments ` +
        `will land in Enrops's platform account rather than yours.`,
    }).catch((err) => console.warn('regression alert send failed:', err));
  }
}

async function handleAccountDeauthorized(
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  // For account.application.deauthorized, the deauthorized account ID is on
  // event.account (top-level), NOT in event.data.object.
  const accountId = (event.account as string | null) ?? null;
  if (!accountId) {
    console.warn(`[stripe-webhook] account.application.deauthorized has no event.account`);
    return;
  }

  const { data } = await admin
    .from('organizations')
    .select('id, name, alert_email, stripe_last_account_event_id')
    .eq('stripe_account_id', accountId)
    .maybeSingle();
  const org = data as Pick<OrgConnectRow, 'id' | 'name' | 'alert_email' | 'stripe_last_account_event_id'> | null;

  if (!org) {
    console.warn(`[stripe-webhook] deauthorize for unknown account ${accountId}`);
    return;
  }

  if (org.stripe_last_account_event_id === event.id) {
    return;
  }

  // Note: we deliberately do NOT clear stripe_account_id. Keep it for audit
  // and so the operator's UI shows "disconnected" rather than reverting to
  // the never-connected onboarding flow. Reconnecting will issue a fresh
  // acct_ID anyway (Stripe doesn't reuse deauthorized accounts).
  const { error: updErr } = await admin
    .from('organizations')
    .update({
      stripe_charges_enabled: false,
      stripe_payouts_enabled: false,
      stripe_account_status: 'disconnected',
      stripe_last_account_event_id: event.id,
    })
    .eq('id', org.id);

  if (updErr) {
    console.error(`[stripe-webhook] failed to flip org ${org.id} to disconnected:`, updErr);
    return;
  }

  console.log(`[stripe-webhook] org ${org.id} (${org.name}) disconnected Stripe Connect`);

  if (org.alert_email) {
    const brand = await loadOrgBrand(admin, org.id);
    await sendOperatorAlert({
      brand,
      to: org.alert_email,
      subject: `Stripe Connect disconnected for ${org.name || 'your organization'}`,
      body:
        `Stripe Connect has been disconnected for your organization.\n\n` +
        `New parent payments will no longer route to your bank — they will land in ` +
        `Enrops's platform account until you reconnect. Open the Finances tab in your ` +
        `Enrops admin portal to reconnect.`,
    }).catch((err) => console.warn('deauth alert send failed:', err));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// v19 — instructor connected accounts under the Enrops platform
// ───────────────────────────────────────────────────────────────────────────
//
// When an org is on instructor_pay_model='enrops_platform', its instructors'
// Express accounts live under Enrops's main Stripe Connect platform — the
// same platform that hosts operators' Receivables connected accounts. So
// account.updated events for these instructors arrive HERE, not in the
// legacy stripe-connect-instructor-webhook (which is wired to J2S's own
// platform).
//
// We gate on org.instructor_pay_model = 'enrops_platform' so a misrouted
// legacy event (e.g. somebody added the J2S-platform webhook to this
// endpoint by mistake) can't accidentally rewrite the wrong row.

async function handleInstructorAccountUpdated(
  admin: SupabaseClient,
  event: Stripe.Event,
  account: Stripe.Account,
  accountId: string,
): Promise<void> {
  // Idempotency + routing lookup in one shot.
  const { data: existing, error: fetchErr } = await admin
    .from('contractor_onboarding_status')
    .select('instructor_id, organization_id, stripe_last_webhook_event_id, stripe_payouts_enabled')
    .eq('stripe_connect_account_id', accountId)
    .maybeSingle();
  if (fetchErr) {
    console.error(`[stripe-webhook] instructor account lookup failed for ${accountId}:`, fetchErr);
    return;
  }
  if (!existing) {
    // Truly unknown account — neither an operator nor an instructor of ours.
    // Could be a different environment or a leftover account. 200 anyway.
    console.warn(`[stripe-webhook] account.updated for unknown account ${accountId} — ignoring`);
    return;
  }

  // Gate: only act on instructor accounts whose org is on the enrops_platform
  // route. Legacy_own_platform instructor events should arrive at the J2S-
  // platform-scoped stripe-connect-instructor-webhook instead.
  const { data: orgRow } = await admin
    .from('organizations')
    .select('instructor_pay_model')
    .eq('id', (existing as { organization_id: string }).organization_id)
    .maybeSingle();
  const model = (orgRow as { instructor_pay_model?: string } | null)?.instructor_pay_model;
  if (model !== 'enrops_platform') {
    console.warn(
      `[stripe-webhook] instructor account.updated for ${accountId} but org is on '${model}' — ignoring (event should arrive at the legacy webhook)`,
    );
    return;
  }

  if ((existing as { stripe_last_webhook_event_id: string | null }).stripe_last_webhook_event_id === event.id) {
    // Already processed.
    return;
  }

  const result = await applyStripeAccountStatus(admin, accountId, {
    payouts_enabled: account.payouts_enabled === true,
    details_submitted: account.details_submitted === true,
    charges_enabled: account.charges_enabled === true,
  });
  if (!result) {
    console.error(`[stripe-webhook] applyStripeAccountStatus returned null for ${accountId}`);
    return;
  }

  await runGateCheck(admin, (existing as { instructor_id: string }).instructor_id);

  const { error: markErr } = await admin
    .from('contractor_onboarding_status')
    .update({
      stripe_last_webhook_event_id: event.id,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_connect_account_id', accountId);
  if (markErr) {
    console.error(`[stripe-webhook] instructor event-id mark failed for ${accountId}:`, markErr);
    // Non-fatal — the data update already succeeded; the next retry will
    // detect no-change and mark again.
  }

  if (result.regressed) {
    await sendInstructorRegressionAlert(
      admin,
      (existing as { instructor_id: string }).instructor_id,
      (existing as { organization_id: string }).organization_id,
    ).catch((err) => console.warn('[stripe-webhook] instructor regression alert failed:', err));
  }
}

async function sendInstructorRegressionAlert(
  admin: SupabaseClient,
  instructorId: string,
  orgId: string,
): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn('[stripe-webhook] RESEND_API_KEY not set — skipping instructor regression alert');
    return;
  }

  const [{ data: instructor }, brand] = await Promise.all([
    admin
      .from('instructors')
      .select('first_name, last_name, email')
      .eq('id', instructorId)
      .maybeSingle(),
    loadOrgBrand(admin, orgId),
  ]);

  if (!brand.alert_email) {
    console.warn(`[stripe-webhook] no alert_email for org ${orgId} — skipping instructor regression alert`);
    return;
  }

  const i = instructor as { first_name?: string; last_name?: string; email?: string } | null;
  const name = `${i?.first_name ?? ''} ${i?.last_name ?? ''}`.trim() || i?.email || 'A contractor';
  const subject = `[${brand.org_name}] Stripe payouts disabled — ${name}`;
  const text =
    `${name}'s Stripe Connect payouts have been disabled by Stripe.\n\n` +
    `This usually means their verification information has expired. The contractor needs to re-verify in Stripe before the next payroll run.\n\n` +
    `Contractor email: ${i?.email ?? '(unknown)'}\n\n— enrops`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: formatFromAddress(brand),
      to: brand.alert_email,
      reply_to: brand.reply_to,
      subject,
      text,
      tags: [{ name: 'type', value: 'instructor_stripe_regression' }],
    }),
  });
}

// HTML-escape utility for templated content. Avoid injecting unescaped
// user data (parent names, org names) into the email HTML.
function escapeHtml(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
