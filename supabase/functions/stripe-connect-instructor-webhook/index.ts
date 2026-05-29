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

// Instructor Connect platform = new J2S Stripe account. STRIPE_INSTRUCTOR_
// PLATFORM_KEY is the API key for that account; the webhook signature is
// verified against STRIPE_CONNECT_WEBHOOK_SECRET (also new-account scoped).
const stripe = new Stripe(Deno.env.get('STRIPE_INSTRUCTOR_PLATFORM_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CONNECT_WEBHOOK_SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'alerts@enrops.com';

serve(async (req: Request) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      CONNECT_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('connect webhook signature failed:', (err as Error).message);
    return new Response('invalid signature', { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Branch by event type. account.updated handled below (original flow);
  // transfer.reversed handled inline.
  if (event.type === 'transfer.reversed') {
    return await handleTransferReversed(admin, event);
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

// ────────────────────────────────────────────────────────────────────────
// transfer.reversed — operator reversed a payout in Stripe dashboard, or
// Stripe auto-reversed. Flip our payout row to failed and unwind the
// linked confirmations + distance bonus marker so the operator can
// re-pay (or withhold) cleanly.
// ────────────────────────────────────────────────────────────────────────

async function handleTransferReversed(
  admin: ReturnType<typeof createClient>,
  event: Stripe.Event,
): Promise<Response> {
  const transfer = event.data.object as Stripe.Transfer;
  const transferId = transfer.id;

  const { data: payoutData, error: payoutErr } = await admin
    .from('instructor_payouts')
    .select('id, organization_id, instructor_id, session_confirmation_ids, includes_distance_bonus, status, amount_cents')
    .eq('stripe_transfer_id', transferId)
    .maybeSingle();
  if (payoutErr) {
    console.error('[transfer.reversed] payout lookup failed:', payoutErr);
    return new Response('lookup failed', { status: 500 });
  }
  const payout = payoutData as {
    id: string;
    organization_id: string;
    instructor_id: string;
    session_confirmation_ids: string[];
    includes_distance_bonus: boolean;
    status: string;
    amount_cents: number;
  } | null;

  if (!payout) {
    // Could be a transfer from outside our system (manual Stripe dashboard
    // transfer, etc). 200 so Stripe doesn't retry.
    console.warn(`[transfer.reversed] no payout row for transfer ${transferId} — ignoring`);
    return new Response('ok', { status: 200 });
  }
  if (payout.status === 'failed') {
    // Already handled (idempotency).
    return new Response('ok', { status: 200 });
  }

  // Flip payout to failed.
  const reversalReason = (transfer.reversals?.data?.[0] as { reason?: string } | undefined)?.reason ?? 'unspecified';
  const { error: updErr } = await admin
    .from('instructor_payouts')
    .update({
      status: 'failed',
      failure_reason: `reversed: ${reversalReason}`,
    })
    .eq('id', payout.id);
  if (updErr) {
    console.error('[transfer.reversed] payout update failed:', updErr);
    return new Response('update failed', { status: 500 });
  }

  // Unwind confirmations: pay_status approved + clear payout link, so the
  // operator can either re-pay or withhold them.
  if (payout.session_confirmation_ids && payout.session_confirmation_ids.length > 0) {
    const { error: confErr } = await admin
      .from('session_delivery_confirmations')
      .update({
        pay_status: 'approved',
        instructor_payout_id: null,
      })
      .in('id', payout.session_confirmation_ids);
    if (confErr) {
      console.warn('[transfer.reversed] confirmations unwind failed (non-fatal):', confErr);
    }
  }

  // Unwind distance bonus marker if this payout settled it.
  if (payout.includes_distance_bonus) {
    const { error: caErr } = await admin
      .from('camp_assignments')
      .update({
        distance_bonus_paid_at: null,
        distance_bonus_payout_id: null,
      })
      .eq('distance_bonus_payout_id', payout.id);
    if (caErr) {
      console.warn('[transfer.reversed] camp_assignments unwind failed (non-fatal):', caErr);
    }
  }

  // Alert operator (best-effort).
  await sendPayoutReversalAlert(admin, payout).catch(
    (err) => console.warn('[transfer.reversed] alert send failed:', err),
  );

  console.log(`[transfer.reversed] unwound payout ${payout.id} for transfer ${transferId}`);
  return new Response('ok', { status: 200 });
}

async function sendPayoutReversalAlert(
  admin: ReturnType<typeof createClient>,
  payout: { id: string; organization_id: string; instructor_id: string; amount_cents: number },
) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping reversal alert');
    return;
  }
  const [{ data: instructor }, { data: org }] = await Promise.all([
    admin.from('instructors').select('first_name, last_name, email').eq('id', payout.instructor_id).maybeSingle(),
    admin.from('organizations').select('alert_email, name').eq('id', payout.organization_id).maybeSingle(),
  ]);
  const alertEmail = (org as { alert_email?: string } | null)?.alert_email;
  if (!alertEmail) return;
  const name = `${(instructor as { first_name?: string } | null)?.first_name ?? ''} ${(instructor as { last_name?: string } | null)?.last_name ?? ''}`.trim() || 'an instructor';
  const amount = `$${(payout.amount_cents / 100).toFixed(2)}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: alertEmail,
      subject: `[${(org as { name?: string } | null)?.name ?? 'Enrops'}] Instructor payout reversed — ${name}`,
      text:
        `A Stripe transfer for ${name} (${amount}) was reversed.\n\n` +
        `The related session_delivery_confirmations have been flipped back to "approved" so you can re-issue the payment (or withhold) from the Payroll page.\n\n` +
        `If this was unintended, you can re-pay from the Payroll page now. If you intended to reverse, the operator's records are now consistent.\n\n` +
        `Payout ID: ${payout.id}\n\n— enrops`,
    }),
  });
}
