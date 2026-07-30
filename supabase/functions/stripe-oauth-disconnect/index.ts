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

// Instalment states that are PROVABLY not money in flight:
//   paid                     - settled.
//   refunded                 - settled the other way.
//   paused_program_cancelled - will never be charged at all.
// Everything else blocks: 'pending' (process-installments attempts it on the
// next run), 'failed' (declined, still owed, still retried),
// 'paused_card_failed' (parked after a failure, and where a blocked direct
// charge lands) - AND anything we do not recognise.
//
// Expressed as a DENY-list on purpose. An allow-list of the three unpaid states
// would silently stop blocking the moment a fourth is added to
// installments_status_check, exactly the way stripe_account_status quietly grew
// a 'verifying' value. `status` is also NULLABLE (default 'pending'), and
// PostgREST `in.(...)` does not match NULL - so a null-status row would have
// slipped straight past an allow-list. A row whose state we cannot classify is
// not evidence that there is no money owed.
const SETTLED_STATUSES = ['paid', 'refunded', 'paused_program_cancelled'];

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

    // ── the caller must NAME the org ──────────────────────────────────────
    // stripe-oauth-start resolves a missing org_id by picking the caller's first
    // owner/admin membership, and that is fine there: the worst case is minting
    // a connect URL for the wrong org, which the operator then sees and can
    // abandon. THIS endpoint irreversibly revokes a live payment connection, so
    // an implicit target is not acceptable - a request whose body was dropped on
    // a retry, or a future client that forgets the field, would silently
    // disconnect whichever org happened to sort first for a caller who
    // administers more than one. Name it or be refused.
    //
    // Typed explicitly: a non-string (an object, an array) would otherwise be
    // truthy, get stringified into the filter, and fail as a malformed UUID
    // several steps later instead of being rejected here.
    const targetOrgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    if (!targetOrgId) {
      return json({
        error: 'org_id_required',
        message: 'We couldn\'t tell which business to disconnect. Reload the page and try again.',
      }, 400);
    }

    // Prove the caller may act for it. Same shape as stripe-oauth-start,
    // deliberately: the permission to detach an account must not be looser than
    // the permission to attach one. A lookup ERROR is distinguished from "no
    // match" so a transient database failure never reads as a permission
    // denial, and both outcomes fail closed.
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
      //
      // Its own outcome, NOT 'already_revoked'. The row records the status but
      // not how it got there: an org unlinked via the controlled-account path
      // was never revoked at Stripe and enrops still HAS access to it. Reusing
      // 'already_revoked' made the screen assert "enrops has no access to it",
      // which is the opposite of the truth in exactly that case. This outcome
      // claims only what is true of all of them - we are not using the account.
      return json({
        disconnected: true,
        already: true,
        outcome: 'already_disconnected',
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
    // count:'exact' is load-bearing, not decoration. PostgREST caps a result set
    // at 1000 rows, so counting and summing the RETURNED rows silently
    // understated both figures past that point - proven on staging 2026-07-30
    // with 1,100 rows worth $1,100.00, which this endpoint reported as
    // "1000 scheduled payments worth $1000.00". The block still fired, so
    // nothing slipped through; the money number just lied. `count` comes from
    // PostgREST's Content-Range and is exact regardless of how many rows came
    // back. Server-side sum() is not available on this project (PGRST123, "Use
    // of aggregate functions is not allowed"), so when the fetch IS truncated
    // the total is reported as a floor rather than as a fact.
    const { data: unpaidRows, error: unpaidErr, count } = await supabase
      .from('installments')
      .select('amount_cents', { count: 'exact' })
      .eq('organization_id', org.id)
      .or(`status.is.null,status.not.in.(${SETTLED_STATUSES.join(',')})`);
    if (unpaidErr) {
      // FAIL CLOSED. An unreadable instalment table is not evidence that there
      // is no money in flight, and this is the one check standing between a
      // click and uncollectable payment plans.
      console.error('[oauth-disconnect] unpaid instalment check failed:', unpaidErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const unpaid = (unpaidRows ?? []) as { amount_cents: number | null }[];
    // The GATE reads the exact count, never the fetched-row length: a hypothetical
    // future cap of 0 returned rows must not read as "no money owed".
    const unpaidCount = count ?? unpaid.length;
    if (unpaidCount > 0) {
      const cents = unpaid.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
      // True when PostgREST handed back fewer rows than exist, so `cents` is a
      // floor rather than the total.
      const centsIsPartial = unpaidCount > unpaid.length;
      const dollars = (cents / 100).toFixed(2);
      console.log(
        `[oauth-disconnect] blocked org ${org.id}: ${unpaidCount} unpaid instalment row(s), ` +
        `${cents} cents from ${unpaid.length} fetched row(s)${centsIsPartial ? ' (PARTIAL SUM)' : ''}`,
      );
      // Singular and plural are BOTH written out rather than patched with a
      // trailing "(s)" - this lands on an operator's money screen. Every agreeing
      // word switches together: is/are, payment/payments, it/them, that has/those
      // have. The third branch exists because a partial sum must not be stated as
      // a fact; "at least" is true, "worth $X" would not be.
      //
      // Deliberately says "to collect" and NOT "to collect on this Stripe
      // account". The count is org-wide, so an org that connected account A, took
      // a payment plan, disconnected and connected account B would be told the
      // outstanding A-money sits on B - sending them to the wrong Stripe dashboard
      // to look for payments that are not there. Blocking on those rows is still
      // right (a direct org cannot charge anything while disconnected); only the
      // attribution was wrong.
      const message = unpaidCount === 1
        ? `There is still 1 scheduled payment worth $${dollars} to collect. ` +
          `Disconnecting now would leave it impossible to charge or refund. ` +
          `Once that has gone through you can disconnect.`
        : centsIsPartial
          ? `There are still ${unpaidCount} scheduled payments to collect, worth at least $${dollars}. ` +
            `Disconnecting now would leave them impossible to charge or refund. ` +
            `Once those have gone through you can disconnect.`
          : `There are still ${unpaidCount} scheduled payments worth $${dollars} to collect. ` +
            `Disconnecting now would leave them impossible to charge or refund. ` +
            `Once those have gone through you can disconnect.`;
      return json({
        error: 'unpaid_installments',
        pending_count: unpaidCount,
        pending_cents: cents,
        // So support can tell a floor from a total without re-deriving it.
        pending_cents_is_partial: centsIsPartial,
        message,
      }, 409);
    }

    // ── revoke at Stripe ──────────────────────────────────────────────────
    // Done BEFORE our own write, on purpose. If Stripe revokes and our write
    // fails, the account.application.deauthorized webhook flips the same row to
    // the same state, so the row converges. The other order has no such
    // backstop: our row would read 'disconnected' while the grant was still
    // live, and every charge would keep being refused by a guard that says the
    // account is gone.
    // THREE distinct outcomes, kept distinct. An earlier version collapsed the
    // last two into one boolean, which meant the response could not tell support
    // "Stripe would not revoke because the account is one we created" from "the
    // grant was already gone", and it made the persist_failed message below
    // claim we had revoked something when we had not touched Stripe at all.
    //   revoked          - we called deauthorize and Stripe accepted it.
    //   controlled       - no grant to revoke; the account is one we created.
    //   already_revoked  - Stripe says there is no grant; most likely the
    //                      operator revoked us from their own dashboard.
    let outcome: 'revoked' | 'controlled' | 'already_revoked';
    try {
      await stripe.oauth.deauthorize({
        client_id: CLIENT_ID,
        stripe_user_id: accountId,
      });
      outcome = 'revoked';
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
          outcome = 'controlled';
          break;
        case 'already_gone':
          // The operator most likely revoked us from Stripe's own dashboard
          // already. Better to unlink than to strand our row 'active' against
          // an account we can no longer reach.
          console.warn(`[oauth-disconnect] ${accountId} not connected at Stripe (${code}: ${desc}); unlinking locally`);
          outcome = 'already_revoked';
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
      console.error(`[oauth-disconnect] org ${org.id} update failed (outcome=${outcome}) for ${accountId}:`, updErr);
      // TRUE per branch. When we really did revoke, saying "nothing changed"
      // would contradict what they can see in their own Stripe connected-apps
      // list. When we never touched Stripe (controlled / already_revoked),
      // claiming we disconnected it there would be a plain invention.
      return json({
        error: 'persist_failed',
        message: outcome === 'revoked'
          ? 'We disconnected the account at Stripe but couldn\'t save it on our side. Reload the page — if it still shows as connected, tell us.'
          : 'We couldn\'t save the change on our side, so nothing has changed. Please try again.',
      }, 500);
    }

    console.log(
      `[oauth-disconnect] org ${org.id} (${org.name ?? 'unnamed'}) disconnected ${accountId} ` +
      `by user ${callerAuthId} (outcome=${outcome})`,
    );

    return json({
      disconnected: true,
      // Named rather than boolean-encoded, so support can tell the three apart.
      outcome,
      account_id: accountId,
    });
  } catch (err) {
    console.error('[oauth-disconnect] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
