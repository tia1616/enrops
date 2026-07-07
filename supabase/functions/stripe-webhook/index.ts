// stripe-webhook v19 — PATCH 12 (2026-05-29)
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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress, renderSignatureBlock, OrgBrand } from '../_shared/orgBrand.ts';
import { applyStripeAccountStatus } from '../_shared/stripeAccountStatus.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';
import { handleTransferReversed as sharedHandleTransferReversed } from '../_shared/handleTransferReversed.ts';
import { logEnrollmentEvent, ENROLLMENT_ACTIONS } from '../_shared/logEnrollmentEvent.ts';
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
      await admin.from('registrations').update({
        status: 'confirmed',
        payment_status: settlement.payment_status,
        ach_payment_state: settlement.ach_payment_state,
        stripe_payment_intent_id: session.payment_intent as string,
      }).in('id', regIds);

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
          const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent as string);

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
                { registration_id: inst2RegId, installment_number: 2, amount_cents: parseInt(meta.installment_2_amount_cents, 10), due_date: meta.installment_2_due_date, status: 'pending', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId, organization_id: orgId },
                { registration_id: inst3RegId, installment_number: 3, amount_cents: parseInt(meta.installment_3_amount_cents, 10), due_date: meta.installment_3_due_date, status: 'pending', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId, organization_id: orgId },
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
        `id, amount_cents, programs(curriculum, day_of_week, start_time, end_time, first_session_date, term, program_locations(name, address, arrival_instructions, dismissal_instructions)), students(first_name, last_name)`,
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

async function autoCreateParentAccount(
  admin: ReturnType<typeof createClient>,
  brand: OrgBrand,
  email: string,
  name: string,
  orgSlug: string,
  alertEmail: string,
) {
  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const alreadyExists = existingUsers?.users?.some(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );

  if (alreadyExists) {
    console.log(`Auth user already exists for ${email}, sending dashboard link email`);
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
      body: `Could not create auth user for ${email} after successful payment. Error: ${createErr.message}. The parent can still create an account manually at enrops.com/${orgSlug}/login.`,
    });
    return;
  }

  console.log(`Auth user created for ${email}: ${newUser?.user?.id}`);
  await sendAccountReadyEmail(admin, brand, email, name, orgSlug, true);
}

async function sendAccountReadyEmail(admin: ReturnType<typeof createClient>, brand: OrgBrand, email: string, name: string, orgSlug: string, isNew: boolean) {
  const firstName = name ? name.split(' ')[0] : 'there';
  const dashboardUrl = `https://enrops.com/${orgSlug}/dashboard`;
  const loginUrl = `https://enrops.com/${orgSlug}/login`;

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

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Your Account</title></head><body style="margin:0;padding:0;background:${brand.page_bg_color};font-family:'Nunito Sans',Arial,sans-serif;"><div style="max-width:600px;margin:0 auto;background:#fff;"><div style="background:linear-gradient(135deg,${brand.primary_color},${brand.secondary_color});padding:40px 30px;text-align:center;">${logoBlock}<h1 style="color:#fff;margin:12px 0 0;font-family:'Titan One',Georgia,serif;font-size:28px;">${isNew ? 'Your account is ready!' : 'View your programs'}</h1></div><div style="padding:32px 30px;"><p style="margin:0 0 16px;font-size:16px;color:#1A1530;">Hi ${escapeHtml(firstName)},</p><p style="margin:0 0 24px;font-size:16px;color:#1A1530;line-height:1.6;">${isNew ? 'We created a parent account for you automatically when you registered. Tap the button below to see your child\'s program schedule and arrival details.' : 'Tap the button below to view your children\'s program details and schedules.'}</p><div style="text-align:center;margin:32px 0;"><a href="${signInUrl}" style="display:inline-block;background:${brand.primary_color};color:#fff;text-decoration:none;padding:16px 40px;border-radius:8px;font-size:16px;font-weight:700;">View my dashboard</a></div><p style="margin:0 0 8px;font-size:14px;color:#6b6880;">This link expires in 24 hours. After that, you can always sign in at <a href="${loginUrl}" style="color:${brand.primary_color};">enrops.com/${orgSlug}/login</a> using the magic link option.</p><p style="margin:24px 0 0;font-size:14px;color:#6b6880;">Questions? Reach us at <a href="mailto:${brand.reply_to}" style="color:${brand.primary_color};">${brand.reply_to}</a></p></div><div style="background:#1A1530;padding:20px 30px;text-align:center;color:#fff;opacity:0.6;font-size:12px;">${escapeHtml(brand.org_name)} &middot; Powered by Enrops &middot; ${new Date().getFullYear()}</div></div></body></html>`;

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
  admin: ReturnType<typeof createClient>;
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
          return `<tr><td colspan="2" style="padding:0 16px 16px;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="padding:10px 12px;background:#F9F8FE;border-radius:8px;border-left:3px solid ${brand.primary_color};font-family:'Nunito Sans',sans-serif;">${parts.join('')}</td></tr></table></td></tr>`;
        })()
      : '';

    return `<tr>
        <td style="padding:16px 16px ${hasArrival ? '8px' : '16px'};border-bottom:${hasArrival ? 'none' : '1px solid #EDE9FE'};font-family:'Nunito Sans',sans-serif;">
          <div style="font-size:16px;font-weight:700;color:#1A1530;">${programName}</div>
          <div style="font-size:14px;color:#6b6880;margin-top:4px;">${s?.first_name || ''} ${s?.last_name || ''} &middot; ${locationName}</div>
          <div style="font-size:14px;color:#6b6880;margin-top:4px;">${p?.day_of_week || ''}s &middot; ${timeDisplay}</div>
          <div style="font-size:13px;color:${brand.primary_color};margin-top:8px;font-weight:600;">First session: ${firstDate}</div>
        </td>
        <td style="padding:16px;text-align:right;vertical-align:top;border-bottom:${hasArrival ? 'none' : '1px solid #EDE9FE'};font-family:'Nunito Sans',sans-serif;font-weight:700;color:#1A1530;">
          ${fmt(r.amount_cents)}
        </td>
      </tr>${hasArrival ? `${arrivalRow}<tr><td colspan="2" style="border-bottom:1px solid #EDE9FE;"></td></tr>` : ''}`;
  }).join('');

  const totalsBlock = useInstallments && installmentInfo
    ? `<tr><td colspan="2" style="padding:20px 16px;background:#F5F3FF;"><div style="font-family:'Nunito Sans',sans-serif;font-size:15px;font-weight:700;color:${brand.secondary_color};margin-bottom:12px;">Your payment plan</div><table cellpadding="0" cellspacing="0" style="width:100%;font-family:'Nunito Sans',sans-serif;font-size:14px;color:#1A1530;"><tr><td style="padding:6px 0;">Today (paid)</td><td style="padding:6px 0;text-align:right;font-weight:700;">${fmt(installmentInfo.paidToday)}</td></tr><tr><td style="padding:6px 0;">Installment 2 &middot; ${fmtDate(installmentInfo.installment2Date)}</td><td style="padding:6px 0;text-align:right;">${fmt(installmentInfo.installment2Amount)}</td></tr><tr><td style="padding:6px 0;">Installment 3 &middot; ${fmtDate(installmentInfo.installment3Date)}</td><td style="padding:6px 0;text-align:right;">${fmt(installmentInfo.installment3Amount)}</td></tr><tr><td style="padding:8px 0 0;border-top:1px solid #DDD8FA;font-weight:700;">Total</td><td style="padding:8px 0 0;border-top:1px solid #DDD8FA;text-align:right;font-weight:700;">${fmt(installmentInfo.paidToday + installmentInfo.installment2Amount + installmentInfo.installment3Amount)}</td></tr></table><div style="font-family:'Nunito Sans',sans-serif;font-size:12px;color:#6b6880;margin-top:10px;">Your card on file will be charged automatically on each date. We'll email you before each charge.</div></td></tr>`
    : `<tr><td style="padding:20px 16px;font-family:'Nunito Sans',sans-serif;font-size:18px;font-weight:700;color:#1A1530;">Total paid</td><td style="padding:20px 16px;text-align:right;font-family:'Titan One',Georgia,serif;font-size:24px;color:${brand.accent_color};">${fmt(totalCents)}</td></tr>`;

  // Build the auto-generated summary block — operators who customize the body
  // get this slotted in via the {{registration_summary_block}} token. Wraps
  // the registration table + totals/payment plan in a single <table>.
  const summaryBlock = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:24px;font-family:'Nunito Sans',sans-serif;">
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
<body style="margin:0;padding:0;background:#fbfaf6;font-family:'Nunito Sans',Arial,sans-serif;color-scheme:light only;supported-color-schemes:light;">
<div style="max-width:600px;margin:0 auto;background:#fff;">
<div style="padding:32px 30px 8px;text-align:center;">${logoBlock}</div>
<div style="padding:16px 30px 32px;color:#1A1530;font-size:16px;line-height:1.6;">
${innerBody}
${renderSignatureBlock(brand)}
</div>
<div style="padding:18px 30px;text-align:center;color:#888;font-size:11px;border-top:1px solid #eee;">
${escapeHtml(brand.org_name)} · Powered by Enrops · ${new Date().getFullYear()}
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
    .trim();

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
  admin: ReturnType<typeof createClient>,
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

  // Map Stripe state to our enum. 5 buckets:
  //   active        — charges + payouts both enabled
  //   restricted    — submitted details but Stripe has disabled with a reason
  //   onboarding    — submitted details, still verifying (no disabled_reason)
  //                   OR hasn't completed onboarding form yet
  //   disconnected  — operator disconnected (handled by deauthorize, not here)
  //   not_connected — never connected (handled at insert time, not here)
  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;
  const disabledReason = account.requirements?.disabled_reason || null;
  const wasActive = org.stripe_account_status === 'active';

  let nextStatus: 'active' | 'restricted' | 'onboarding';
  if (chargesEnabled && payoutsEnabled) {
    nextStatus = 'active';
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
  admin: ReturnType<typeof createClient>,
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
  admin: ReturnType<typeof createClient>,
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
  admin: ReturnType<typeof createClient>,
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
