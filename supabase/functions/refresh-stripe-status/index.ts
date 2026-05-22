// refresh-stripe-status — Function 16 (chunk 2).
//
// Instructor-facing manual refresh. The wizard's "Check current status"
// button on Screen 7 calls this when the contractor wants to know if
// Stripe finished verification. Hits the Stripe API, applies the same
// status logic as the webhook (Function 3), runs the gate check, and
// returns the current state so the UI can re-render.
//
// This is a user-controlled safety valve, not a polling mechanism. The
// webhook is the primary signal; this lets contractors check without
// having to wait for the next event.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';
import { applyStripeAccountStatus } from '../_shared/stripeAccountStatus.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';

// New J2S Stripe account that pays instructors. See create-stripe-connect-
// account for the env-var split rationale.
const stripe = new Stripe(Deno.env.get('STRIPE_INSTRUCTOR_PLATFORM_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    const supabase = adminClient();

    const { data: row, error: fetchErr } = await supabase
      .from('contractor_onboarding_status')
      .select('stripe_connect_account_id, overall_status')
      .eq('instructor_id', me.id)
      .maybeSingle();
    if (fetchErr) {
      console.error('onboarding fetch failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const accountId = row?.stripe_connect_account_id as string | null;
    if (!accountId) {
      return json({ error: 'no_stripe_account' }, 400);
    }

    let account: Stripe.Account;
    try {
      account = await stripe.accounts.retrieve(accountId);
    } catch (err) {
      console.error('stripe.accounts.retrieve failed:', err);
      return json({ error: 'stripe_unreachable' }, 502);
    }

    const result = await applyStripeAccountStatus(supabase, accountId, {
      payouts_enabled: account.payouts_enabled === true,
      details_submitted: account.details_submitted === true,
      charges_enabled: account.charges_enabled === true,
    });
    if (!result) {
      return json({ error: 'apply_failed' }, 500);
    }

    const gate = await runGateCheck(supabase, me.id);

    return json({
      stripe_connect_status: result.next_status,
      stripe_payouts_enabled: result.payouts_enabled,
      overall_status: gate?.overall_status ?? row?.overall_status ?? null,
    });
  } catch (err) {
    console.error('refresh-stripe-status fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
