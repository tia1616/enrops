// create-stripe-operator-login-link — operator deep-link into their Stripe
// Express dashboard. Parallel to create-stripe-express-login-link, but for
// the OPERATOR side of Connect (parents -> org) rather than the INSTRUCTOR
// side (org -> instructor). Different Stripe account, different table.
//
// One Stripe API call returns a temporary URL (~5 minute TTL) that signs
// the operator into their own Express dashboard where they can view
// payouts, manage bank info, update business details, and download tax
// docs.
//
// Auth: caller must be an org owner/admin in org_members.
// Body (optional): { org_id } — if multiple orgs (rare today), specify
// which one. Otherwise inferred from membership.
// Returns: { url: "https://connect.stripe.com/express/..." }
//
// Failure modes:
//   - 401 if no/invalid auth.
//   - 403 if caller is not owner/admin.
//   - 409 'no_stripe_account' if the org hasn't onboarded yet — send the
//     user to /admin/finances to click "Connect Stripe" first.
//   - 502 'stripe_link_create_failed' on Stripe API failure.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

interface RequestBody {
  org_id?: string;
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

    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      // optional body
    }

    let targetOrgId = body.org_id || null;

    if (targetOrgId) {
      const { data: cm } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .eq('organization_id', targetOrgId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (!cm) return FORBIDDEN;
    } else {
      const { data: cm } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (!cm) return FORBIDDEN;
      targetOrgId = (cm as { organization_id: string }).organization_id;
    }

    // ── load account id ───────────────────────────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('stripe_account_id, stripe_charges_enabled')
      .eq('id', targetOrgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[connect-login-link] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgData as {
      stripe_account_id: string | null;
      stripe_charges_enabled: boolean | null;
    } | null;
    const accountId = org?.stripe_account_id || null;
    if (!accountId) {
      return json({ error: 'no_stripe_account' }, 409);
    }

    // ── mint a fresh login link ───────────────────────────────────────────
    let link;
    try {
      link = await stripe.accounts.createLoginLink(accountId);
    } catch (err) {
      const stripeErr = err as { message?: string; raw?: { message?: string; code?: string } };
      const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
      const errCode = stripeErr.raw?.code ?? 'unknown';
      console.error('[connect-login-link] createLoginLink failed:', errCode, errMsg);
      return json({
        error: 'stripe_link_create_failed',
        stripe_code: errCode,
        stripe_message: errMsg,
      }, 502);
    }

    return json({ url: link.url });
  } catch (err) {
    console.error('[connect-login-link] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
