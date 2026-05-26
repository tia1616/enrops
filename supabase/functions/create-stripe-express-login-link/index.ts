// create-stripe-express-login-link — instructor deep-link into their
// Stripe Express dashboard. One Stripe API call returns a temporary URL
// (~5 minute TTL) that signs the contractor into their own Express
// dashboard where they can view payouts, manage bank info, update
// personal details, and download tax docs (1099-NEC).
//
// Auth: instructor JWT via resolveInstructor.
// Body: none required.
// Returns: { url: "https://connect.stripe.com/express/..." }
//
// Failure modes:
//   - 401/403 if not a valid instructor.
//   - 409 'no_stripe_account' if the instructor hasn't completed (or
//     started) Stripe Connect onboarding yet — they should be sent
//     back through the wizard's Stripe step instead.
//   - 502 'stripe_link_create_failed' on Stripe API failure (with the
//     raw error message surfaced so the portal can render something
//     useful).

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
      return json({ error: 'no_stripe_account' }, 409);
    }

    let link;
    try {
      link = await stripe.accounts.createLoginLink(accountId);
    } catch (err) {
      const stripeErr = err as { message?: string; raw?: { message?: string; code?: string } };
      const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
      const errCode = stripeErr.raw?.code ?? 'unknown';
      console.error('createLoginLink failed:', errCode, errMsg, err);
      return json({
        error: 'stripe_link_create_failed',
        stripe_code: errCode,
        stripe_message: errMsg,
      }, 502);
    }

    return json({ url: link.url });
  } catch (err) {
    console.error('create-stripe-express-login-link fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
