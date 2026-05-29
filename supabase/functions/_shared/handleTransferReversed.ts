// Shared handler for Stripe transfer.reversed events. Used by:
//   - stripe-connect-instructor-webhook (legacy_own_platform path — J2S's
//     own Stripe Connect platform fires the event there).
//   - stripe-webhook                     (enrops_platform path — Enrops's
//     main Stripe Connect platform fires the event there, scoped to
//     connected accounts via STRIPE_WEBHOOK_SECRET_CONNECT).
//
// Logic identical across paths: look up the payout row by stripe_transfer_id,
// flip status to failed, unwind the linked confirmations (back to approved +
// clear payout link) and the distance bonus marker. Then alert the operator.
//
// If we can't find a payout row, the transfer was made outside this system
// (manual Stripe-dashboard transfer, the receivables-side transfer_data
// destination, etc.) — return ok so Stripe doesn't retry forever.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'alerts@enrops.com';

interface PayoutRow {
  id: string;
  organization_id: string;
  instructor_id: string;
  session_confirmation_ids: string[];
  includes_distance_bonus: boolean;
  status: string;
  amount_cents: number;
}

export async function handleTransferReversed(
  admin: SupabaseClient,
  event: Stripe.Event,
  logTag = '[transfer.reversed]',
): Promise<Response> {
  const transfer = event.data.object as Stripe.Transfer;
  const transferId = transfer.id;

  const { data: payoutData, error: payoutErr } = await admin
    .from('instructor_payouts')
    .select('id, organization_id, instructor_id, session_confirmation_ids, includes_distance_bonus, status, amount_cents')
    .eq('stripe_transfer_id', transferId)
    .maybeSingle();
  if (payoutErr) {
    console.error(`${logTag} payout lookup failed:`, payoutErr);
    return new Response('lookup failed', { status: 500 });
  }
  const payout = payoutData as PayoutRow | null;

  if (!payout) {
    // Transfer from outside our system (a transfer_data leg on a Receivables
    // charge, a manual Stripe-dashboard transfer, etc). 200 so Stripe stops
    // retrying.
    console.warn(`${logTag} no payout row for transfer ${transferId} — ignoring`);
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
    console.error(`${logTag} payout update failed:`, updErr);
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
      console.warn(`${logTag} confirmations unwind failed (non-fatal):`, confErr);
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
      console.warn(`${logTag} camp_assignments unwind failed (non-fatal):`, caErr);
    }
  }

  // Alert operator (best-effort).
  await sendPayoutReversalAlert(admin, payout, logTag).catch(
    (err) => console.warn(`${logTag} alert send failed:`, err),
  );

  console.log(`${logTag} unwound payout ${payout.id} for transfer ${transferId}`);
  return new Response('ok', { status: 200 });
}

async function sendPayoutReversalAlert(
  admin: SupabaseClient,
  payout: PayoutRow,
  logTag: string,
): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn(`${logTag} RESEND_API_KEY not set — skipping reversal alert`);
    return;
  }
  const [{ data: instructor }, { data: org }] = await Promise.all([
    admin.from('instructors').select('first_name, last_name, email').eq('id', payout.instructor_id).maybeSingle(),
    admin.from('organizations').select('alert_email, name').eq('id', payout.organization_id).maybeSingle(),
  ]);
  const alertEmail = (org as { alert_email?: string } | null)?.alert_email;
  if (!alertEmail) return;
  const name =
    `${(instructor as { first_name?: string } | null)?.first_name ?? ''} ${(instructor as { last_name?: string } | null)?.last_name ?? ''}`.trim() ||
    'an instructor';
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
