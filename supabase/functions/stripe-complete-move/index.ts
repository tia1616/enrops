// stripe-complete-move — the SWITCH half of prepare-then-switch.
//
// stripe-connect-onboard's move mode parks a newly minted account in
// organizations.stripe_pending_account_id while Stripe verifies it, and never
// touches live routing. This function is the deliberate second step: it promotes
// that parked account to the one the money goes to.
//
// WHY IT IS A SEPARATE FUNCTION. It shares nothing with onboarding but the
// authorization gate. Onboarding mints accounts and hands back Account Links;
// this reads one account back from Stripe, refuses on four separate grounds, and
// rewrites the org's routing in a single conditional update. Folding it into the
// other function would put "create an account" and "change where the money goes"
// behind one entry point, which is exactly the shape the whole build exists to
// take apart.
//
// IT REFUSES MORE OFTEN THAN IT SUCCEEDS, on purpose:
//   1. caller is not an Enrops platform admin
//   2. the org has no parked account, so there is no move to complete
//   3. Stripe says the parked account cannot take a charge yet
//   4. the parked account is not on the fee-payer model a move exists to reach
//   5. the org has in-flight instalments that recorded no routing
//
// (5) IS THE ONE THAT PROTECTS REAL FAMILIES. process-installments routes each
// charge by the account the PLAN recorded, not the org's current model - so
// in-flight plans keep charging to the old account after a switch, which is the
// whole point of 20260929b. But a plan that recorded NEITHER
// stripe_charge_account_id NOR stripe_transfer_destination_id predates those
// columns, and process-installments deliberately FAILS CLOSED on it: the row is
// set to paused_card_failed and an operator alert goes out. Promoting an org
// with rows in that state would therefore stop real payment plans mid-term and
// send an alert per group. On prod that is 178 rows across 144 families running
// to April 2027. So we check first and refuse, naming the number.
//
// Env: STRIPE_SECRET_KEY (the operator-Connect platform key, same as
// stripe-connect-onboard).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { logPlatformEvent, FEATURE, ACTION } from '../_shared/logPlatformEvent.ts';

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
  stripe_pending_account_id: string | null;
  stripe_charge_model: string | null;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

/**
 * Instalment rows that would be BLOCKED by process-installments if the org's
 * routing changed under them: still chargeable, and carrying neither routing
 * fact.
 *
 * The status filter is a DENY-list, matching 20260810g: 'paid' and 'refunded'
 * are finished and will never be charged again, so their routing is history.
 * Everything else - 'pending', 'failed', 'paused_card_failed',
 * 'paused_program_cancelled' - is resurrectable and therefore still at risk. An
 * ALLOW-list of ('pending') here would have quietly ignored every paused row,
 * which is the bug 20260810f had and 20260810g exists to correct.
 */
const FINISHED_STATUSES = ['paid', 'refunded'];

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
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
      // Body is required below; an unparseable one is the same as an empty one.
    }

    // The caller must NAME the org, for the same reason stripe-connect-onboard
    // demands it: this rewrites where an org's money goes, and on 2026-07-30 an
    // implicit target in that function minted an account against an org nobody
    // had named and destroyed the record of the one it had been connected to.
    const targetOrgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    if (!targetOrgId) {
      return json({
        error: 'org_id_required',
        message: 'Name the business whose move you want to complete.',
      }, 400);
    }

    // ── platform admin only ───────────────────────────────────────────────
    // No org-membership alternative, unlike ordinary onboarding. Changing where
    // a business's money lands is never the business's own button: 20260930b
    // locks both stripe_account_id and stripe_pending_account_id to platform
    // admins in the database, and this is the matching front door.
    const { data: pa, error: paErr } = await supabase
      .from('platform_admins')
      .select('auth_user_id')
      .eq('auth_user_id', callerAuthId)
      .limit(1)
      .maybeSingle();
    if (paErr) {
      // Fail CLOSED and say which check failed, so a database blip cannot read
      // as a permission denial.
      console.error('[complete-move] platform_admins check failed for', callerAuthId, paErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!pa) return FORBIDDEN;

    // ── load the org ──────────────────────────────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, stripe_account_id, stripe_pending_account_id, stripe_charge_model')
      .eq('id', targetOrgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[complete-move] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgData as OrgRow | null;
    if (!org) return json({ error: 'org_not_found' }, 404);

    const pendingId = org.stripe_pending_account_id;
    if (!pendingId) {
      return json({
        error: 'no_move_in_progress',
        message: 'There is no account waiting to take over for this business. Start a move first.',
      }, 409);
    }

    // ── ask STRIPE whether the parked account can actually take money ─────
    // Read at the moment of the switch rather than trusting anything we stored.
    // account.updated events for a parked account are not matched to any org
    // (stripe-webhook finds orgs by stripe_account_id), so there is no cached
    // answer here that could be stale - and a cached answer is exactly what we
    // must not act on when the next thing we do is move real money.
    let acct: Stripe.Account;
    try {
      acct = await stripe.accounts.retrieve(pendingId);
    } catch (err) {
      console.error('[complete-move] accounts.retrieve failed for', pendingId, err);
      return json({
        error: 'stripe_account_unreadable',
        message: 'We could not read the new account from Stripe, so nothing was changed. Try again; if it keeps failing the account may have been deleted at Stripe.',
      }, 502);
    }

    if (!acct.charges_enabled) {
      const due = acct.requirements?.currently_due ?? [];
      return json({
        error: 'not_ready',
        message: 'Stripe cannot take payments on the new account yet, so nothing was changed. The business still needs to finish their Stripe setup.',
        charges_enabled: false,
        payouts_enabled: !!acct.payouts_enabled,
        currently_due: due,
      }, 409);
    }

    // The fee-payer is the REASON a move exists: an account whose fees are paid
    // by the platform is the thing being moved away from, and Stripe will not
    // change that on an account that already exists. Promoting an account that
    // is not on the new model would complete a move that achieved nothing, and
    // would mark it stripe_charge_model='direct' while Stripe still bills the
    // platform - so the uplift and the routing would disagree about who pays.
    const feesPayer = acct.controller?.fees?.payer ?? null;
    if (feesPayer !== 'account') {
      return json({
        error: 'wrong_fee_model',
        message: 'The new account is not set up for the business to pay Stripe\'s fees, which is the reason for moving. Nothing was changed.',
        fees_payer: feesPayer,
      }, 409);
    }

    // ── would this switch strand any in-flight instalments? ───────────────
    // See the header. Counted, not assumed, and counted on the DEFECT
    // PREDICATE - rows that would actually be blocked - rather than on a proxy
    // like "does this org have any instalments".
    // NULL-SAFE, and that is not a detail. installments.status is NULLABLE
    // (default 'pending', no NOT NULL), and `status NOT IN ('paid','refunded')`
    // evaluates to NULL for a NULL status - so a bare NOT IN would quietly drop
    // those rows and report the switch as safe when it is not. A NULL status is
    // certainly not paid and not refunded, so it belongs in the at-risk set.
    const { count: strandedCount, error: strandedErr } = await supabase
      .from('installments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', org.id)
      .or(`status.is.null,status.not.in.(${FINISHED_STATUSES.join(',')})`)
      .is('stripe_charge_account_id', null)
      .is('stripe_transfer_destination_id', null);
    if (strandedErr) {
      // Fail CLOSED. Not knowing whether the switch would strand a payment plan
      // is not permission to find out on live families.
      console.error('[complete-move] stranded-instalment check failed:', strandedErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if ((strandedCount ?? 0) > 0) {
      return json({
        error: 'instalments_would_be_stranded',
        message: `${strandedCount} instalment row(s) for this business recorded no payment routing, so switching now would stop those payment plans and alert the operator. Backfill their routing first, then complete the move.`,
        stranded_rows: strandedCount,
      }, 409);
    }

    // ── promote ───────────────────────────────────────────────────────────
    // ONE conditional update. The .eq on stripe_pending_account_id is optimistic
    // concurrency: if another admin completed or restarted the move between the
    // read above and this write, this matches no row and we say so rather than
    // overwriting their result.
    const previousAccountId = org.stripe_account_id;
    const { data: written, error: updErr } = await supabase
      .from('organizations')
      .update({
        stripe_account_id: pendingId,
        stripe_pending_account_id: null,
        stripe_charge_model: 'direct',
        stripe_account_status: 'active',
        stripe_charges_enabled: true,
        stripe_payouts_enabled: !!acct.payouts_enabled,
      })
      .eq('id', org.id)
      .eq('stripe_pending_account_id', pendingId)
      .select('id')
      .maybeSingle();
    if (updErr) {
      console.error('[complete-move] promote failed:', updErr);
      return json({ error: 'promote_failed' }, 500);
    }
    if (!written) {
      return json({
        error: 'move_changed_underneath',
        message: 'This move changed while we were checking it, so nothing was written. Reload and look at the current state before trying again.',
      }, 409);
    }

    // ── tell Stripe which account this now is ─────────────────────────────
    // AFTER the promote, and never allowed to fail it. The database is the
    // authority on where money goes; this metadata only keeps Stripe's own
    // record readable by a human and by the orphan-recovery filter in
    // stripe-connect-onboard. Doing it first would risk a stamped account that
    // the database never promoted, which is the worse of the two half-states.
    //
    // Both accounts are restamped: the new one becomes 'live', the old one
    // 'retired'. Leaving the old one unstamped would leave TWO accounts reading
    // as live for one org.
    try {
      await stripe.accounts.update(pendingId, { metadata: { enrops_account_role: 'live' } });
    } catch (err) {
      console.warn('[complete-move] could not stamp new account live (non-fatal):', err);
    }
    if (previousAccountId) {
      try {
        await stripe.accounts.update(previousAccountId, { metadata: { enrops_account_role: 'retired' } });
      } catch (err) {
        console.warn('[complete-move] could not stamp old account retired (non-fatal):', err);
      }
    }

    console.log('[complete-move] promoted', {
      org_id: org.id,
      from: previousAccountId,
      to: pendingId,
      charge_model: 'direct',
    });

    await logPlatformEvent(supabase, {
      feature: FEATURE.ONBOARDING,
      action: ACTION.STRIPE_MOVE_COMPLETED,
      outcome: 'success',
      organizationId: org.id,
      actorUserId: callerAuthId,
      metadata: {
        from_account: previousAccountId,
        to_account: pendingId,
        previous_charge_model: org.stripe_charge_model,
      },
    });

    return json({
      completed: true,
      org_id: org.id,
      now_charging_to: pendingId,
      previous_account: previousAccountId,
      charge_model: 'direct',
      // The old account STAYS CONNECTED at Stripe on purpose: in-flight payment
      // plans recorded it and keep settling there (on prod, to April 2027).
      // Disconnecting it would strand them.
      note: 'The previous account stays connected so existing payment plans finish where they started.',
    });
  } catch (err) {
    console.error('[complete-move] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
