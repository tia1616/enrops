// sync-operator-stripe-status — operator-side Stripe Connect status refresh.
//
// WHY THIS EXISTS (alpha-risk fallback):
// The only writer of organizations.stripe_account_status is stripe-webhook's
// handleAccountUpdated, which fires ONLY on the classic v1 `account.updated`
// event. If Stripe mints a v2 Connect account for a new operator (the Enrops
// Dev sandbox already does this), it emits `v2.core.account.*` events that our
// v1 handler never sees — so the operator can finish Stripe onboarding but
// never get flipped to 'active', and registrations never open.
//
// This function is the deterministic fallback: it retrieves the account
// directly via the v1 Accounts API (`accounts.retrieve`, which returns
// charges_enabled / payouts_enabled regardless of how the account was created
// or which event shape Stripe emits) and applies the SAME status mapping the
// webhook uses. The Finances page calls it on return from onboarding, so an
// operator is never left stuck on 'onboarding' even if no webhook ever lands.
//
// Mirrors the proven instructor-side refresh-stripe-status, but for operators:
//   - operator-Connect platform key (STRIPE_SECRET_KEY, same as the webhook's
//     operator path and stripe-connect-onboard)
//   - organizations table (not contractor_onboarding_status)
//   - owner/admin auth (mirrors stripe-connect-onboard)
//
// SAFETY: read-only against Stripe. Writes ONLY the same status columns the
// webhook writes (minus stripe_last_account_event_id — there is no event).
// No alert emails: this is a poll, not an event, so regression alerts stay the
// webhook's job and we don't double-send.

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

interface OrgRow {
  id: string;
  name: string | null;
  stripe_account_id: string | null;
  stripe_account_status: string | null;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── auth: caller must be org owner/admin ──────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // Parse body (optional; org_id derived from membership if omitted).
    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      // no body — fall through to membership lookup
    }

    // Resolve target org. If body.org_id is supplied, verify the caller has
    // owner/admin on THAT org. Otherwise find the caller's org by membership.
    let targetOrgId: string | null = body.org_id || null;
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

    // ── load org ──────────────────────────────────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, stripe_account_id, stripe_account_status')
      .eq('id', targetOrgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[sync-operator-stripe-status] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgData as OrgRow | null;
    if (!org) return json({ error: 'org_not_found' }, 404);

    const accountId = org.stripe_account_id;
    if (!accountId) return json({ error: 'no_stripe_account' }, 400);

    // Don't resurrect a deliberately disconnected org. Deauthorization is the
    // webhook's job (account.application.deauthorized); a status poll must not
    // flip 'disconnected' back to 'onboarding'/'active'. Return current state.
    if (org.stripe_account_status === 'disconnected') {
      return json({ stripe_account_status: 'disconnected', changed: false });
    }

    // ── retrieve the account (v1 Accounts API; shape-agnostic) ────────────
    let account: Stripe.Account;
    try {
      account = await stripe.accounts.retrieve(accountId);
    } catch (err) {
      console.error('[sync-operator-stripe-status] stripe.accounts.retrieve failed:', err);
      return json({ error: 'stripe_unreachable' }, 502);
    }

    // ── map Stripe state to our enum — IDENTICAL to handleAccountUpdated ───
    // (stripe-webhook/index.ts). Keep these two in lockstep.
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    const disabledReason = account.requirements?.disabled_reason || null;

    let nextStatus: 'active' | 'restricted' | 'onboarding';
    if (chargesEnabled && payoutsEnabled) {
      nextStatus = 'active';
    } else if (detailsSubmitted && !chargesEnabled && disabledReason) {
      nextStatus = 'restricted';
    } else {
      nextStatus = 'onboarding';
    }

    const changed =
      org.stripe_account_status !== nextStatus;

    // Write the same status columns the webhook writes. We deliberately do NOT
    // touch stripe_last_account_event_id — there is no event here, and leaving
    // it lets a later real webhook event still process (its idempotency check
    // compares event.id, which we never set).
    const { error: updErr } = await supabase
      .from('organizations')
      .update({
        stripe_charges_enabled: chargesEnabled,
        stripe_payouts_enabled: payoutsEnabled,
        stripe_account_status: nextStatus,
      })
      .eq('id', org.id);
    if (updErr) {
      console.error('[sync-operator-stripe-status] org update failed:', updErr);
      return json({ error: 'persist_failed' }, 500);
    }

    console.log(
      `[sync-operator-stripe-status] org ${org.id} -> ${nextStatus} ` +
      `(charges=${chargesEnabled}, payouts=${payoutsEnabled}, details=${detailsSubmitted}, ` +
      `disabled=${disabledReason ?? 'none'}, changed=${changed})`,
    );

    return json({
      stripe_account_status: nextStatus,
      stripe_charges_enabled: chargesEnabled,
      stripe_payouts_enabled: payoutsEnabled,
      changed,
    });
  } catch (err) {
    console.error('[sync-operator-stripe-status] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
