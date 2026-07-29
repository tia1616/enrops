// stripe-oauth-callback — where Stripe sends the operator's browser after they
// pick the account they want to connect.
//
// THIS ENDPOINT IS PUBLIC AND RUNS SERVICE-ROLE. It is a browser redirect from
// Stripe, so there is no Supabase JWT to authenticate and no session to trust. It
// therefore trusts EXACTLY TWO things and nothing else:
//   1. the `state` row, which stripe-oauth-start minted after checking that the
//      caller was an owner/admin of that org, and
//   2. the `code`, which only Stripe can issue.
// Every other value on the request - including any origin or org id someone might
// append to the URL - is ignored. This is the "public + service-role endpoint
// trusting client data" shape that has bitten this codebase before, so the org is
// resolved from the state row and never from the request.
//
// SINGLE USE. The state is CLAIMED atomically before anything else happens
// (UPDATE ... WHERE consumed_at IS NULL, and check the row count). A second
// delivery of the same state finds nothing to claim and stops. If a later step
// fails, the state stays burnt and the operator starts again - a wasted token is
// cheap, binding a Stripe account to the wrong org is not.
//
// verify_jwt MUST be false for this function (Stripe's redirect carries no JWT).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { mapOperatorAccountStatus } from '../_shared/operatorAccountStatus.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/** Bounce the operator back to Finances with a result they can read. */
function back(origin: string, params: Record<string, string>): Response {
  const qs = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}/admin/finances?${qs}` },
  });
}

serve(async (req: Request) => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fallback only for the case where we cannot resolve the state row at all and
  // therefore have no recorded return origin. Per-environment: a hardcoded
  // enrops.com here would bounce a STAGING operator onto production the moment
  // anything went wrong.
  const FALLBACK_ORIGIN = (Deno.env.get('PUBLIC_SITE_URL') || 'https://enrops.com').replace(/\/$/, '');

  try {
    const url = new URL(req.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');
    const oauthErrorDesc = url.searchParams.get('error_description');

    if (!state) {
      console.warn('[oauth-callback] no state on the request');
      return back(FALLBACK_ORIGIN, { stripe: 'error', reason: 'missing_state' });
    }

    // ── claim the state, atomically and exactly once ──────────────────────
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from('stripe_oauth_states')
      .update({ consumed_at: nowIso })
      .eq('state', state)
      .is('consumed_at', null)
      .gt('expires_at', nowIso)
      .select('state, organization_id, created_by_user_id, return_origin')
      .maybeSingle();

    if (claimErr) {
      console.error('[oauth-callback] state claim failed:', claimErr);
      return back(FALLBACK_ORIGIN, { stripe: 'error', reason: 'state_unreadable' });
    }
    if (!claimed) {
      // Already used, expired, or never existed. All three are the same story to
      // the operator: start again.
      console.warn('[oauth-callback] state not claimable (used, expired, or unknown)');
      return back(FALLBACK_ORIGIN, { stripe: 'error', reason: 'link_expired' });
    }

    const row = claimed as {
      state: string;
      organization_id: string;
      created_by_user_id: string | null;
      return_origin: string;
    };
    const origin = row.return_origin || FALLBACK_ORIGIN;

    // ── the operator said no ──────────────────────────────────────────────
    // Stripe sends error=access_denied when they hit Cancel. That is a normal
    // outcome, not a failure, and it must not look like one.
    if (oauthError) {
      console.log(`[oauth-callback] operator declined: ${oauthError} ${oauthErrorDesc ?? ''}`);
      return back(origin, { stripe: 'cancelled' });
    }

    if (!code) {
      console.warn('[oauth-callback] no code and no error on the request');
      return back(origin, { stripe: 'error', reason: 'missing_code' });
    }

    // ── exchange the code for the connected account ───────────────────────
    let connectedAccountId: string;
    try {
      const tokenResp = await stripe.oauth.token({
        grant_type: 'authorization_code',
        code,
      });
      const acctId = (tokenResp as unknown as { stripe_user_id?: string }).stripe_user_id;
      if (!acctId) throw new Error('token response carried no stripe_user_id');
      // Validate the shape before this value is ever interpolated into a query
      // filter below. Stripe account ids are acct_ + alphanumerics; anything
      // else does not get to become part of a WHERE clause.
      if (!/^acct_[A-Za-z0-9]+$/.test(acctId)) {
        throw new Error(`unexpected account id shape: ${acctId}`);
      }
      connectedAccountId = acctId;
    } catch (err) {
      const e = err as { message?: string; raw?: { message?: string; error_description?: string } };
      const msg = e.raw?.error_description ?? e.raw?.message ?? e.message ?? 'unknown';
      console.error('[oauth-callback] token exchange failed:', msg);
      return back(origin, { stripe: 'error', reason: 'exchange_failed' });
    }

    // ── refuse an account already serving a different org ─────────────────
    // Two orgs sharing one Stripe account would make every refund, payout and
    // 1099 ambiguous, and our per-charge account scoping assumes one owner.
    // FAIL CLOSED. The error is checked, not just the data: .maybeSingle()
    // returns an ERROR rather than a row when more than one matches, so if two
    // orgs somehow already shared this account, ignoring the error would leave
    // `existing` null and wave a third org straight through the one guard that
    // exists to prevent it. Same for any transient failure - a check we could
    // not complete is not a check that passed.
    // (The database also enforces this now; see 20260729b. This stays as the
    // path that produces a readable outcome instead of a raw 23505.)
    const { data: existing, error: existingErr } = await admin
      .from('organizations')
      .select('id')
      .eq('stripe_account_id', connectedAccountId)
      .neq('id', row.organization_id)
      .maybeSingle();
    if (existingErr) {
      console.error(
        `[oauth-callback] could not verify whether ${connectedAccountId} is already in use; refusing to attach it:`,
        existingErr.message,
      );
      return back(origin, { stripe: 'error', reason: 'account_in_use' });
    }
    if (existing) {
      console.error(
        `[oauth-callback] account ${connectedAccountId} is already on org ${(existing as { id: string }).id}; refusing to attach it to ${row.organization_id}`,
      );
      return back(origin, { stripe: 'error', reason: 'account_in_use' });
    }

    // ── read the account back rather than assuming what we connected ──────
    let account: Stripe.Account | null = null;
    try {
      account = await stripe.accounts.retrieve(connectedAccountId);
    } catch (err) {
      console.error('[oauth-callback] accounts.retrieve failed:', err);
      // We have a real connection but cannot describe it. Recording the account
      // id without its state would leave the org looking connected while
      // stripe_charges_enabled stayed false, which reads as a broken checkout to
      // every family. Better to fail the whole thing and let them retry.
      return back(origin, { stripe: 'error', reason: 'account_unreadable' });
    }

    const mapped = mapOperatorAccountStatus(account);

    // ── who pays Stripe's processing fee on a direct charge? ──────────────
    // Stripe: "On a direct charge, the connected account pays Stripe's processing
    // fees by default", and for Standard accounts specifically the fees collector
    // IS the connected account. But 'direct' is what makes create-checkout put
    // the charge on their account with a margin-only application fee, so we set
    // it only when the account itself says so - never from the fact that we used
    // OAuth.
    //
    // Accounts v1 exposes controller.fees.payer; a classic Standard account has
    // no controller object at all, which per Stripe's documented default also
    // means the connected account pays. Anything else, we do not claim to know.
    const ctrl = (account as unknown as {
      controller?: { fees?: { payer?: string } };
      type?: string;
    });
    const feesPayer = ctrl.controller?.fees?.payer ?? null;
    const acctType = ctrl.type ?? null;
    const operatorBearsStripeFees =
      feesPayer === 'account' || (feesPayer === null && acctType === 'standard');

    console.log(
      `[oauth-callback] connected ${connectedAccountId} for org ${row.organization_id}: ` +
      `type=${acctType ?? 'none'} fees.payer=${feesPayer ?? 'none'} ` +
      `charges=${mapped.chargesEnabled} payouts=${mapped.payoutsEnabled} status=${mapped.status} ` +
      // Say what is actually written. The column is set on BOTH branches - a log
      // claiming it was left alone would send the next person debugging a
      // destination-routed operator looking anywhere but here.
      `-> charge_model=${operatorBearsStripeFees ? 'direct' : 'destination (unconfirmed fee model)'}`,
    );

    // ── write it ──────────────────────────────────────────────────────────
    // service_role bypasses guard_organizations_locked_columns, which otherwise
    // blocks stripe_account_id changes (verified in 20260703_lock_stripe_fee_payer_in_org_guard.sql).
    // stripe_charge_model is set EXPLICITLY either way, never left to whatever
    // happened to be on the row. An org that previously connected, disconnected,
    // and is now reconnecting could be carrying a stale 'direct' from its old
    // account - inheriting that for a NEW account whose fee arrangement we could
    // not confirm would route real charges on an assumption.
    const update: Record<string, unknown> = {
      stripe_account_id: connectedAccountId,
      stripe_charges_enabled: mapped.chargesEnabled,
      stripe_payouts_enabled: mapped.payoutsEnabled,
      stripe_account_status: mapped.status,
      stripe_charge_model: operatorBearsStripeFees ? 'direct' : 'destination',
    };

    // The "is this org already connected?" rule lives in stripe-oauth-start, but
    // an invariant enforced only at the START of a flow is not enforced at all:
    // two admins can each open a connect flow, and whichever callback lands
    // second would quietly overwrite the first account. So the same rule is
    // enforced HERE too, as a condition on the write itself - write only if the
    // org is still unconnected, already holds this exact account (a retry), or
    // was deliberately disconnected.
    const { data: written, error: updErr } = await admin
      .from('organizations')
      .update(update)
      .eq('id', row.organization_id)
      .or(
        `stripe_account_id.is.null,stripe_account_id.eq.${connectedAccountId},stripe_account_status.eq.disconnected`,
      )
      .select('id')
      .maybeSingle();
    if (updErr) {
      // 23505 here is the unique index from 20260729b firing: another org
      // claimed this exact Stripe account between our check above and this
      // write. That is the race the index exists to close, and it deserves the
      // truthful reason rather than a generic failure.
      if ((updErr as { code?: string }).code === '23505') {
        console.error(
          `[oauth-callback] ${connectedAccountId} was claimed by another org between the check and the write; refusing to attach it to ${row.organization_id}`,
        );
        return back(origin, { stripe: 'error', reason: 'account_in_use' });
      }
      console.error('[oauth-callback] org update failed:', updErr);
      return back(origin, { stripe: 'error', reason: 'persist_failed' });
    }
    if (!written) {
      console.error(
        `[oauth-callback] org ${row.organization_id} already had a different Stripe account by the time this callback landed; refusing to overwrite it with ${connectedAccountId}`,
      );
      return back(origin, { stripe: 'error', reason: 'already_connected' });
    }

    // Record which account was picked, for support and audit. Non-fatal, but the
    // error is checked properly: a PostgREST builder resolves with { error }
    // rather than rejecting, so a rejection handler here would never fire.
    const { error: annotateErr } = await admin
      .from('stripe_oauth_states')
      .update({ connected_account_id: connectedAccountId })
      .eq('state', row.state);
    if (annotateErr) console.warn('[oauth-callback] state annotate failed:', annotateErr.message);

    if (!operatorBearsStripeFees) {
      // Connected, but the account did not confirm the operator bears Stripe's
      // fees. Set to 'destination' rather than 'direct': money still reaches
      // them, and routing a charge on a guess is how it ends up in the wrong
      // balance. Flagged for a human to decide.
      console.error(
        `[oauth-callback] NEEDS REVIEW: org ${row.organization_id} (connect started by user ${row.created_by_user_id ?? 'unknown'}) ` +
        `connected ${connectedAccountId}, but the account did not confirm the operator bears Stripe fees ` +
        `(type=${acctType}, fees.payer=${feesPayer}). Charge model set to 'destination', NOT 'direct'.`,
      );
      return back(origin, { stripe: 'connected', review: 'fee_model' });
    }

    return back(origin, { stripe: 'connected' });
  } catch (err) {
    console.error('[oauth-callback] fatal:', err);
    return back(FALLBACK_ORIGIN, { stripe: 'error', reason: 'internal' });
  }
});
