// stripe-oauth-disconnect — let an operator detach the Stripe account connected
// to their org, so they can connect a different one.
//
// THE GAP THIS CLOSES. stripe-oauth-start refuses any org that already holds an
// account unless its status is 'disconnected', and nothing in the product could
// ever SET that status except Stripe's own account.application.deauthorized
// webhook — i.e. the operator had to go find the revoke button inside Stripe's
// dashboard. An operator who connected the wrong account was stuck, and so is
// every org sitting on a half-finished 'onboarding' account.
//
// WHAT STRIPE ACTUALLY SUPPORTS (docs.stripe.com/connect/oauth-reference):
//   POST https://connect.stripe.com/oauth/deauthorize  {client_id, stripe_user_id}
//   "After revocation, the account can't be accessed by your platform in the
//    Dashboard or through the API."
//   Errors include `no_deauth_on_controlled_account` — an account the PLATFORM
//   controls cannot be deauthorized at all (Stripe points at the reject API
//   instead, which we deliberately do not call: rejecting somebody's Stripe
//   account is not what "disconnect from enrops" means).
// So the two connect paths on the Payments screen behave differently here:
// an OAuth-attached account is revoked at Stripe; an account we minted for them
// via accounts.create stays open and theirs, and we only stop using it.
//
// WHY THIS BLOCKS ON UNPAID INSTALLMENTS. Losing API access to the account is
// not cosmetic — it is the same access refund-registration uses to refund a
// direct charge ({stripeAccount: registrations.stripe_charge_account_id}) and
// process-installments uses to charge the next instalment. Disconnecting with
// money still owed would strand rows nobody can collect OR refund, so those orgs
// are refused with the count and the amount. Jessica's call, 2026-07-30.
//
// SCOPE: stripe_charge_model='direct' only. That is a CONFIG branch, not a
// tenant branch — both connect paths a new tenant can take write 'direct'. A
// destination-charge org is a different money story (its charges keep succeeding
// into the platform balance when the account goes away, see buildChargeRouting)
// and is out of scope here.
//
// verify_jwt stays TRUE: this is an authenticated operator action, unlike the
// OAuth callback.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { classifyDeauthorizeError } from '../_shared/stripeDeauthorize.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const CLIENT_ID = Deno.env.get('STRIPE_CONNECT_CLIENT_ID') || '';

// Instalment states that still represent money owed to the operator.
//   pending             - process-installments will attempt it on its next run.
//   failed              - card declined; still owed, still retried.
//   paused_card_failed  - parked after a failure (this is also where a blocked
//                         direct charge lands), still owed.
// 'paid' and 'refunded' are settled. 'paused_program_cancelled' will never be
// charged, so it is not money in flight and must not block a disconnect.
const UNPAID_STATUSES = ['pending', 'failed', 'paused_card_failed'];

interface RequestBody {
  org_id?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    if (!CLIENT_ID) {
      console.error('[oauth-disconnect] STRIPE_CONNECT_CLIENT_ID is not set');
      return json({ error: 'platform_misconfigured' }, 500);
    }

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

    // ── resolve the org, and prove the caller may act for it ──────────────
    // Same shape as stripe-oauth-start, deliberately: the permission to detach
    // an account must not be looser than the permission to attach one. .limit(1)
    // on both branches, and a lookup ERROR is distinguished from "no match" so a
    // transient database failure never reads as a permission denial. Both fail
    // closed.
    let targetOrgId: string | null = body.org_id || null;
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
        console.error('[oauth-disconnect] membership check failed for org', targetOrgId, cmErr);
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
        console.error('[oauth-disconnect] membership lookup failed:', cmErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!cm) return FORBIDDEN;
      targetOrgId = (cm as { organization_id: string }).organization_id;
    }

    // ── what are we actually disconnecting? ───────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, stripe_account_id, stripe_account_status, stripe_charge_model')
      .eq('id', targetOrgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[oauth-disconnect] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgData as {
      id: string;
      name: string | null;
      stripe_account_id: string | null;
      stripe_account_status: string | null;
      stripe_charge_model: string | null;
    } | null;
    if (!org) return json({ error: 'org_not_found' }, 404);

    if (!org.stripe_account_id) {
      return json({
        error: 'not_connected',
        message: 'There is no Stripe account connected to this business.',
      }, 409);
    }
    if (org.stripe_account_status === 'disconnected') {
      // Already where the caller is trying to get to. Report it as done rather
      // than as a failure - a second click, or a click that raced the
      // account.application.deauthorized webhook, has nothing left to do.
      return json({
        disconnected: true,
        already: true,
        deauthorized: false,
        message: 'That Stripe account is already disconnected.',
      });
    }
    if (org.stripe_charge_model !== 'direct') {
      // See the SCOPE note in the header. Refusing is the honest answer; the
      // alternative is silently doing something with different money behaviour
      // than the button promised.
      console.warn(
        `[oauth-disconnect] refusing org ${org.id}: stripe_charge_model=${org.stripe_charge_model ?? 'null'}`,
      );
      return json({
        error: 'unsupported_charge_model',
        message: 'This account is set up in a way we can\'t disconnect from here. Contact us and we\'ll sort it out with you.',
      }, 409);
    }

    const accountId = org.stripe_account_id;

    // ── guard: money still owed ───────────────────────────────────────────
    // Counted for the ORG, not filtered by stripe_charge_account_id. After a
    // disconnect, buildChargeRouting blocks EVERY charge for a direct org (no
    // stripe_charges_enabled), so every unpaid row is stranded regardless of
    // which account its column happens to name.
    const { data: unpaidRows, error: unpaidErr } = await supabase
      .from('installments')
      .select('id, amount_cents, status, due_date')
      .eq('organization_id', org.id)
      .in('status', UNPAID_STATUSES);
    if (unpaidErr) {
      // FAIL CLOSED. An unreadable instalment table is not evidence that there
      // is no money in flight, and this is the one check standing between a
      // click and uncollectable payment plans.
      console.error('[oauth-disconnect] unpaid instalment check failed:', unpaidErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const unpaid = (unpaidRows ?? []) as { amount_cents: number | null }[];
    if (unpaid.length > 0) {
      const cents = unpaid.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
      console.log(
        `[oauth-disconnect] blocked org ${org.id}: ${unpaid.length} unpaid instalment row(s), ${cents} cents`,
      );
      return json({
        error: 'unpaid_installments',
        pending_count: unpaid.length,
        pending_cents: cents,
        // Singular and plural are BOTH written out rather than patched with a
        // trailing "(s)" - this lands on an operator's money screen. Every
        // agreeing word switches together: is/are, payment/payments, it/them,
        // that has/those have.
        message: unpaid.length === 1
          ? `There is still 1 scheduled payment worth $${(cents / 100).toFixed(2)} to collect on this Stripe account. ` +
            `Disconnecting now would leave it impossible to charge or refund. ` +
            `Once that has gone through you can disconnect.`
          : `There are still ${unpaid.length} scheduled payments worth $${(cents / 100).toFixed(2)} to collect on this Stripe account. ` +
            `Disconnecting now would leave them impossible to charge or refund. ` +
            `Once those have gone through you can disconnect.`,
      }, 409);
    }

    // ── revoke at Stripe ──────────────────────────────────────────────────
    // Done BEFORE our own write, on purpose. If Stripe revokes and our write
    // fails, the account.application.deauthorized webhook flips the same row to
    // the same state, so the row converges. The other order has no such
    // backstop: our row would read 'disconnected' while the grant was still
    // live, and every charge would keep being refused by a guard that says the
    // account is gone.
    let deauthorized = false;
    let controlledAccount = false;
    try {
      await stripe.oauth.deauthorize({
        client_id: CLIENT_ID,
        stripe_user_id: accountId,
      });
      deauthorized = true;
    } catch (err) {
      const e = err as { message?: string; raw?: { error?: string; error_description?: string; message?: string } };
      const code = e.raw?.error ?? 'unknown';
      const desc = e.raw?.error_description ?? e.raw?.message ?? e.message ?? 'unknown';

      // Three-way, and the classification lives in _shared/stripeDeauthorize.ts
      // with tests - a bare `invalid_client` (our client_id or key mode being
      // wrong) MUST NOT be read as "already disconnected", or a bad key rotation
      // would mark orgs disconnected while enrops still held live access.
      switch (classifyDeauthorizeError(code, desc)) {
        case 'controlled_account':
          // An account WE created (accounts.create). No OAuth grant exists to
          // revoke, nothing is left dangling, and the account stays open and
          // theirs. Unlink on our side and tell the truth about it.
          console.log(`[oauth-disconnect] ${accountId} is a controlled account; unlinking locally only`);
          controlledAccount = true;
          break;
        case 'already_gone':
          // The operator most likely revoked us from Stripe's own dashboard
          // already. Better to unlink than to strand our row 'active' against
          // an account we can no longer reach.
          console.warn(`[oauth-disconnect] ${accountId} not connected at Stripe (${code}: ${desc}); unlinking locally`);
          controlledAccount = true;
          break;
        default:
          console.error(`[oauth-disconnect] deauthorize failed for ${accountId}: ${code}: ${desc}`);
          return json({
            error: 'deauthorize_failed',
            stripe_code: code,
            message: 'Stripe couldn\'t disconnect that account just now, so nothing changed. Please try again.',
          }, 502);
      }
    }

    // ── write it ──────────────────────────────────────────────────────────
    // Mirrors handleAccountDeauthorized in stripe-webhook exactly, so the two
    // routes to this state cannot disagree. stripe_account_id is deliberately
    // KEPT: it is the audit record of what was connected, it is what makes the
    // UI say "disconnected" instead of reverting to a never-connected screen,
    // and both stripe-oauth-start and stripe-oauth-callback already treat
    // status='disconnected' as re-connectable.
    //
    // stripe_last_account_event_id is deliberately NOT touched - it belongs to
    // the webhook's replay guard, and borrowing it here would make the webhook
    // skip a later, genuine event.
    const { error: updErr } = await supabase
      .from('organizations')
      .update({
        stripe_charges_enabled: false,
        stripe_payouts_enabled: false,
        stripe_account_status: 'disconnected',
      })
      .eq('id', org.id);
    if (updErr) {
      console.error(`[oauth-disconnect] org ${org.id} update failed after revoking ${accountId}:`, updErr);
      // Say what is TRUE: access is already gone at Stripe. Telling them
      // "nothing changed" would contradict what they can see in their own
      // Stripe connected-apps list.
      return json({
        error: 'persist_failed',
        message: 'We disconnected the account at Stripe but couldn\'t save it on our side. Reload the page — if it still shows as connected, tell us.',
      }, 500);
    }

    console.log(
      `[oauth-disconnect] org ${org.id} (${org.name ?? 'unnamed'}) disconnected ${accountId} ` +
      `by user ${callerAuthId} (deauthorized=${deauthorized}, controlled=${controlledAccount})`,
    );

    return json({
      disconnected: true,
      deauthorized,
      // true = the Stripe account stays open and theirs; we only stopped using
      // it. The UI says something different in that case, so it must be told.
      account_stays_open: controlledAccount,
      account_id: accountId,
    });
  } catch (err) {
    console.error('[oauth-disconnect] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
