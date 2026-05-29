// create-stripe-express-login-link — instructor's button to "open Stripe."
//
// One endpoint, two URLs depending on where the instructor is:
//
//   - account fully onboarded (details_submitted + payouts_enabled)
//     → Stripe Express dashboard login link (~5min TTL). Returns:
//       { url, kind: 'dashboard' }
//
//   - account exists but isn't finished (still missing address / SSN /
//     bank / TOS / etc.)
//     → Stripe-hosted onboarding link to complete the form. Returns:
//       { url, kind: 'onboarding' }
//
// The frontend just redirects the user to `url`; it doesn't have to think
// about state. Stripe lands them on the right screen either way.
//
// Auth: instructor JWT via resolveInstructor.
// Body: none required.
//
// Failure modes:
//   - 401/403 if not a valid instructor.
//   - 409 'no_stripe_account' if the instructor hasn't started Stripe
//     Connect onboarding yet — they should go through the contractor
//     wizard's Stripe step first.
//   - 502 'stripe_link_create_failed' on any Stripe API failure (raw error
//     surfaced so the portal can render something useful).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

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
    const { data: onboarding, error: fetchErr } = await supabase
      .from('contractor_onboarding_status')
      .select('stripe_connect_account_id')
      .eq('instructor_id', me.id)
      .maybeSingle();
    if (fetchErr) {
      console.error('onboarding lookup failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const accountId = onboarding?.stripe_connect_account_id as string | null;
    if (!accountId) {
      // No Stripe account on file — they need to start the wizard first.
      // The contractor portal should route them back to the Stripe step.
      return json({ error: 'no_stripe_account' }, 409);
    }

    // Check whether the account is actually ready for the dashboard, or
    // still mid-onboarding. We trust Stripe's state, not our cached DB
    // columns — those can drift (see task #23).
    let acct: Stripe.Account;
    try {
      acct = await stripe.accounts.retrieve(accountId);
    } catch (err) {
      const stripeErr = err as { message?: string; raw?: { message?: string; code?: string } };
      const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
      const errCode = stripeErr.raw?.code ?? 'unknown';
      console.error('account retrieve failed:', errCode, errMsg, err);
      return json({
        error: 'stripe_link_create_failed',
        stripe_code: errCode,
        stripe_message: errMsg,
      }, 502);
    }

    // "Fully onboarded" = Stripe has every field it needs AND has actually
    // approved payouts. Both are required: details_submitted alone can
    // still leave the account pending verification, and Stripe's dashboard
    // refuses login links for verification-pending accounts.
    const isReady = acct.details_submitted === true && acct.payouts_enabled === true;

    try {
      if (isReady) {
        const link = await stripe.accounts.createLoginLink(accountId);
        return json({ url: link.url, kind: 'dashboard' });
      } else {
        // Same return_url/refresh_url the wizard uses, so post-completion
        // the instructor lands back in their portal.
        const link = await stripe.accountLinks.create({
          account: accountId,
          type: 'account_onboarding',
          return_url: `https://enrops.com/${me.org_slug}/instructor?return=true`,
          refresh_url: `https://enrops.com/${me.org_slug}/instructor?refresh=true`,
        });
        return json({ url: link.url, kind: 'onboarding' });
      }
    } catch (err) {
      const stripeErr = err as { message?: string; raw?: { message?: string; code?: string } };
      const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
      const errCode = stripeErr.raw?.code ?? 'unknown';
      console.error('stripe link create failed:', errCode, errMsg, err);
      return json({
        error: 'stripe_link_create_failed',
        stripe_code: errCode,
        stripe_message: errMsg,
      }, 502);
    }
  } catch (err) {
    console.error('create-stripe-express-login-link fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
