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

    // .limit(1) on BOTH branches plus a real error check - same fix as
    // stripe-oauth-start, same reason. A bare .maybeSingle() resolves with an
    // ERROR when several rows match, and the org-less branch below can match
    // several: only OWNER membership is capped at one per user
    // (20260724a_owner_org_unique_index). Someone who owns one org and
    // administers another matched twice, got an error rather than a row, and -
    // because the error was thrown away - was told `forbidden`. The result was a
    // dead "open Stripe dashboard" button with nothing in the logs to separate it
    // from a genuine permission denial. Still fails closed either way.
    if (targetOrgId) {
      const { data: cm, error: cmErr } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .eq('organization_id', targetOrgId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .limit(1)
        .maybeSingle();
      if (cmErr) {
        console.error('[connect-login-link] membership check failed for org', targetOrgId, cmErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!cm) return FORBIDDEN;
    } else {
      const { data: cm, error: cmErr } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .order('accepted_at', { ascending: true })
        .order('organization_id', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cmErr) {
        console.error('[connect-login-link] membership lookup failed:', cmErr);
        return json({ error: 'lookup_failed' }, 500);
      }
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

    // ── which dashboard does this account even have? ──────────────────────
    // createLoginLink mints an EXPRESS dashboard link and works ONLY for
    // accounts whose controller.stripe_dashboard.type is 'express'. The
    // controller-based accounts Phase 1 mints have type 'full': the operator
    // owns a real Stripe account and signs in with their own credentials.
    // Calling createLoginLink on one fails with "Cannot create an edit link for
    // the account ..., which does not have access to the Express Dashboard"
    // (verified against a real controller account 2026-07-27), which is a 502
    // and a dead button on the operator's own money screen.
    //
    // Read the type from Stripe rather than inferring it from
    // stripe_charge_model: the account is the authority on its own dashboard,
    // and orphan-adopted accounts can be Express while the org row says
    // otherwise.
    // A CLASSIC STANDARD ACCOUNT HAS NO `controller` OBJECT AT ALL. That is the
    // shape stripe-oauth-callback connects, and it made the old guard
    // (`if (dashboardType && dashboardType !== 'express')`) fall straight through
    // to createLoginLink, which cannot mint a link for it - a 502 and a dead
    // button on the operator's own money screen. Absent controller must be read
    // as "not Express", not as "assume Express".
    //
    // Distinguish "Stripe told us the type" from "we could not ask". Only the
    // second case keeps the old optimistic behaviour: a transient retrieve
    // failure on a genuine Express account should still try for the link it
    // needs, because sending an Express operator to dashboard.stripe.com is a
    // dead end - they have no full-dashboard credentials to sign in with.
    let dashboardType: string | null = null;
    let acctType: string | null = null;
    let retrieved = false;
    try {
      const acct = await stripe.accounts.retrieve(accountId);
      retrieved = true;
      const a = acct as unknown as {
        controller?: { stripe_dashboard?: { type?: string } };
        type?: string;
      };
      dashboardType = a.controller?.stripe_dashboard?.type ?? null;
      acctType = a.type ?? null;
    } catch (err) {
      console.warn('[connect-login-link] account retrieve failed, will still try a login link:', err);
    }

    // Express is the ONLY shape createLoginLink works for, so require it
    // positively rather than excluding the shapes we happen to have thought of.
    const isExpress = dashboardType === 'express';
    if (retrieved && !isExpress) {
      // Standard (OAuth-connected) or a 'full'/'none' controller account: the
      // operator signs in with their own Stripe credentials, and there is no
      // link for us to mint.
      console.log(
        `[connect-login-link] ${accountId} is not an Express account ` +
        `(type=${acctType ?? 'none'} dashboard=${dashboardType ?? 'none'}); ` +
        `sending the operator to Stripe's own sign-in`,
      );
      return json({
        url: 'https://dashboard.stripe.com/',
        dashboard_type: dashboardType ?? (acctType === 'standard' ? 'standard' : 'unknown'),
      });
    }

    // ── mint a fresh login link (Express accounts only) ───────────────────
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

    return json({ url: link.url, dashboard_type: 'express' });
  } catch (err) {
    console.error('[connect-login-link] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
