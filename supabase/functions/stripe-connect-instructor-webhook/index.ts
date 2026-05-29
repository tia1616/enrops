// stripe-connect-instructor-webhook — Function 3 (chunk 2).
//
// Listens for Connect account.updated events from Stripe. Auth via Stripe's
// signature (verify_jwt: false; STRIPE_CONNECT_WEBHOOK_SECRET signing secret).
//
// Idempotency: contractor_onboarding_status.stripe_last_webhook_event_id is
// only updated AFTER the status update + gate check both succeed. If we
// crash mid-process, the next retry of the same event re-runs the logic.
//
// On regression (payouts went enabled → disabled), email the org's
// alert_email so a human knows the contractor needs to re-verify before
// next payroll export.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { applyStripeAccountStatus } from '../_shared/stripeAccountStatus.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';
import { handleTransferReversed as sharedHandleTransferReversed } from '../_shared/handleTransferReversed.ts';

// Instructor Connect platform = new J2S Stripe account. STRIPE_INSTRUCTOR_
// PLATFORM_KEY is the API key for that account; the webhook signature is
// verified against STRIPE_CONNECT_WEBHOOK_SECRET (also new-account scoped).
const stripe = new Stripe(Deno.env.get('STRIPE_INSTRUCTOR_PLATFORM_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Primary: the original "Instructor Payments" destination, scoped to
// "Events from: Your account" (J2S's own platform account events).
const CONNECT_WEBHOOK_SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET')!;
// Secondary: the "Connected accounts" scoped destination (instructor Express
// account events). Optional — if unset, only the primary secret is tried.
// Set this when Jessica adds the second destination on the J2S instructor
// Stripe platform so account.updated events from instructor Express accounts
// actually reach this handler.
const CONNECT_WEBHOOK_SECRET_CONNECTED =
  Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET_CONNECTED') || null;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'alerts@enrops.com';

serve(async (req: Request) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;

  // Try primary secret first, then secondary. Stripe sends Connect-scope
  // events from a separate destination with its own signing secret; one of
  // the two will verify any given event.
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      CONNECT_WEBHOOK_SECRET,
    );
  } catch (primaryErr) {
    if (CONNECT_WEBHOOK_SECRET_CONNECTED) {
      try {
        event = await stripe.webhooks.constructEventAsync(
          rawBody,
          signature,
          CONNECT_WEBHOOK_SECRET_CONNECTED,
        );
      } catch (secondaryErr) {
        console.error('connect webhook signature failed against both secrets:', {
          primary: (primaryErr as Error).message,
          secondary: (secondaryErr as Error).message,
        });
        return new Response('invalid signature', { status: 401 });
      }
    } else {
      console.error('connect webhook signature failed:', (primaryErr as Error).message);
      return new Response('invalid signature', { status: 401 });
    }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Branch by event type. account.updated handled below (original flow);
  // transfer.reversed delegated to shared helper (also used by the
  // enrops_platform path in stripe-webhook).
  if (event.type === 'transfer.reversed') {
    return await sharedHandleTransferReversed(admin, event, '[transfer.reversed legacy]');
  }

  // Anything other than account.updated → 200 no-op.
  if (event.type !== 'account.updated') {
    return new Response('ok', { status: 200 });
  }

  const account = event.data.object as Stripe.Account;
  const accountId = account.id;

  // Idempotency: have we already processed this event ID?
  const { data: existing, error: fetchErr } = await admin
    .from('contractor_onboarding_status')
    .select(
      'instructor_id, organization_id, stripe_last_webhook_event_id, stripe_payouts_enabled'
    )
    .eq('stripe_connect_account_id', accountId)
    .maybeSingle();
  if (fetchErr) {
    console.error('webhook row lookup failed:', fetchErr);
    return new Response('lookup failed', { status: 500 });
  }
  if (!existing) {
    // Unknown account — treat as not-our-concern (could be a stale account
    // or a different environment). 200 so Stripe doesn't retry forever.
    console.warn('webhook for unknown Stripe Connect account:', accountId);
    return new Response('ok', { status: 200 });
  }
  if (existing.stripe_last_webhook_event_id === event.id) {
    // Already processed this exact event.
    return new Response('ok', { status: 200 });
  }

  // Apply the status update.
  const result = await applyStripeAccountStatus(admin, accountId, {
    payouts_enabled: account.payouts_enabled === true,
    details_submitted: account.details_submitted === true,
    charges_enabled: account.charges_enabled === true,
  });

  if (!result) {
    console.error('applyStripeAccountStatus returned null for', accountId);
    return new Response('apply failed', { status: 500 });
  }

  // Gate check (may flip overall_status to complete / pending_stripe).
  await runGateCheck(admin, existing.instructor_id);

  // ONLY after both the status update and gate check succeed, record the
  // event ID so a future retry can re-process if we crashed before this.
  const { error: markErr } = await admin
    .from('contractor_onboarding_status')
    .update({
      stripe_last_webhook_event_id: event.id,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_connect_account_id', accountId);
  if (markErr) {
    console.error('webhook event-id mark failed:', markErr);
    // Don't return error — the data update already succeeded; on next retry
    // we'll detect the no-change and mark again.
  }

  // Send regression alert email (best-effort).
  if (result.regressed) {
    await sendRegressionAlert(admin, existing.instructor_id, existing.organization_id).catch(
      (err) => console.warn('regression alert email failed:', err),
    );
  }

  return new Response('ok', { status: 200 });
});

async function sendRegressionAlert(
  admin: ReturnType<typeof createClient>,
  instructorId: string,
  orgId: string,
) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping regression alert email');
    return;
  }

  const [{ data: instructor }, { data: org }] = await Promise.all([
    admin
      .from('instructors')
      .select('first_name, last_name, email')
      .eq('id', instructorId)
      .maybeSingle(),
    admin
      .from('organizations')
      .select('alert_email, name')
      .eq('id', orgId)
      .maybeSingle(),
  ]);

  const alertEmail = org?.alert_email;
  if (!alertEmail) {
    console.warn('no alert_email for org', orgId, '— skipping regression alert');
    return;
  }

  const name = `${instructor?.first_name ?? ''} ${instructor?.last_name ?? ''}`.trim() || instructor?.email || 'A contractor';
  const subject = `[${org?.name ?? 'enrops'}] Stripe payouts disabled — ${name}`;
  const text = `${name}'s Stripe Connect payouts have been disabled by Stripe.\n\nThis usually means their verification information has expired. The contractor needs to re-verify in Stripe before the next payroll export.\n\nContractor email: ${instructor?.email ?? '(unknown)'}\n\n— enrops`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: alertEmail,
      subject,
      text,
    }),
  });
}

// transfer.reversed handler now lives in _shared/handleTransferReversed.ts.
// Both this webhook (legacy_own_platform) and stripe-webhook (enrops_platform)
// import + call it.
