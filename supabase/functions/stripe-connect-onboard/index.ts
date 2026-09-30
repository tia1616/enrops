// stripe-connect-onboard — Express onboarding for the OPERATOR side of
// Stripe Connect. Mirrors create-stripe-connect-account (which is the
// instructor side on a different Stripe account).
//
// Operator clicks "Connect Stripe" on Finances tab; frontend POSTs to this
// edge function; we:
//   1. Verify caller is an org owner/admin via org_members.
//   2. If the org has no stripe_account_id yet, create an Express account
//      via stripe.accounts.create. Persist the acct_ID on organizations
//      (service_role bypasses the trigger that locks this column).
//   3. Always create a fresh Account Link (refresh_url / return_url) — they
//      expire fast and Stripe wants a new one each time the user clicks
//      "Continue setup".
//   4. Return { onboarding_url } for the frontend to redirect to.
//
// Idempotency: a second call when stripe_account_id is already populated
// just returns a new Account Link against the existing account. This is
// how the UI handles "tab closed, restart onboarding."
//
// MOVE MODE ({ start_move: true }, PLATFORM ADMINS ONLY). Mints a SECOND
// account for an org that already has a working one and parks it in
// organizations.stripe_pending_account_id. Live routing is untouched: the
// org keeps charging to stripe_account_id, on the same stripe_charge_model,
// with the same stripe_account_status, until the switch promotes the new
// account - which is a separate, deliberate step that first asks Stripe
// whether the new account can actually take a charge.
//
// It exists because the normal path above never mints for an org that
// already has an account, so the only way to move one was to disconnect it
// first - which sets stripe_charge_model='direct' against an unverified
// account, and buildChargeRouting fails closed on that, blacking out
// checkout for as long as Stripe takes to verify. Fine for an org with
// nothing on sale; not fine for J2S, which is the org that has to move
// (its fee-payer is application_express and Stripe will not change that on
// an existing account).
//
// Move mode is idempotent the same way: called again while an account is
// already parked, it returns a fresh Account Link for that one rather than
// minting a third.
//
// EXPECT WEBHOOK NOISE while a parked account verifies. stripe-webhook finds
// an org by stripe_account_id, which a pending account is not, so its
// account.updated events fall through to the instructor path and are logged as
// "account.updated for unknown account <id> - ignoring". That is harmless and
// deliberate: it writes nothing and alerts nobody. The switch does not learn
// readiness from a webhook - it asks Stripe directly at the moment it is asked
// to promote, because that is the only answer that is true right then.
//
// Env: STRIPE_SECRET_KEY (operator-Connect platform key — the ORIGINAL
// Enrops Stripe account, not the instructor one).
// Does NOT use STRIPE_CONNECT_CLIENT_ID (that was for the v1 OAuth design,
// dropped in v2 spec — Express doesn't need it).

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
  origin?: string;
  /**
   * PLATFORM-ADMIN ONLY. Start a MOVE: mint a second Stripe account for an org
   * that already has a working one, and park it in
   * organizations.stripe_pending_account_id while it verifies. Live routing is
   * NOT touched - stripe_account_id and stripe_charge_model are left exactly as
   * they are, so every charge keeps going where it went yesterday.
   *
   * This is the only way to get a second account onto an org. Without it the
   * normal path below never mints for an org that already has one, so item 12
   * (J2S off application_express, which cannot be changed on an existing
   * account) had no route that did not black out checkout while Stripe verified.
   */
  start_move?: boolean;
}

interface OrgRow {
  id: string;
  name: string | null;
  slug: string | null;
  website: string | null;
  email: string | null;
  stripe_account_id: string | null;
  stripe_pending_account_id: string | null;
  stripe_account_status: string | null;
  stripe_business_type: string | null;
  stripe_country: string | null;
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
    const callerEmail = userData.user.email || null;

    // Parse body
    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      // Body is optional; we'll derive org_id from caller's membership if missing.
    }
    const origin = sanitizeOrigin(body.origin) || 'https://enrops.com';

    // ── the caller must NAME the org ──────────────────────────────────────
    // This is a MUTATING endpoint: on an org with no account - or one in the
    // 'disconnected' state, which takes the reconnect branch below - it calls
    // stripe.accounts.create and writes the new acct_ID onto the row. So an
    // implicit target is not acceptable, for the same reason it is not
    // acceptable in stripe-oauth-disconnect.
    //
    // This is not theoretical. On 2026-07-30 a verification call with no body
    // resolved to an org nobody had named, minted a brand new Stripe account
    // and overwrote that org's stripe_account_id - destroying the record of the
    // account it had been connected to. The orphan account had to be deleted at
    // Stripe and the row restored by hand.
    //
    // Safe to require: the only caller is startOnboarding() in Finances.jsx,
    // which always sends org_id. Typed explicitly so a non-string cannot be
    // truthy, get stringified into the filter, and fail as a malformed UUID
    // several steps later instead of being refused here.
    const targetOrgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    if (!targetOrgId) {
      return json({
        error: 'org_id_required',
        message: 'We couldn\'t tell which business to set up. Reload the page and try again.',
      }, 400);
    }
    let callerRole: string | null = null;

    // ── is this a MOVE, and is the caller allowed to run one? ─────────────
    //
    // Resolved BEFORE the membership check below, because a move is a platform
    // operation on someone else's business. Enrops platform admins are not
    // members of their tenants' orgs - Jessica is an owner of J2S by accident
    // of history, not by rule - so requiring org membership here would make
    // move mode unreachable for every tenant except that one. The bypass is
    // deliberately narrow: it applies ONLY when start_move is set, and ONLY to
    // a platform admin. Ordinary onboarding still demands org owner/admin.
    const wantsMove = body.start_move === true;
    let isPlatformAdmin = false;
    if (wantsMove) {
      const { data: pa, error: paErr } = await supabase
        .from('platform_admins')
        .select('auth_user_id')
        .eq('auth_user_id', callerAuthId)
        .limit(1)
        .maybeSingle();
      if (paErr) {
        // Fail CLOSED, and say which check failed. A discarded error here would
        // make a database blip look like a permission denial - the same bug the
        // membership check below carries a comment about.
        console.error('[connect-onboard] platform_admins check failed for', callerAuthId, paErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      isPlatformAdmin = !!pa;
      if (!isPlatformAdmin) return FORBIDDEN;
    }

    // A bare .maybeSingle() RESOLVES WITH AN ERROR when more than one row
    // matches, and the error was being discarded - so a transient database
    // failure was indistinguishable from a real permission denial. Scoping to
    // one org means at most one row can match, but .limit(1) costs nothing and
    // keeps this identical in shape to stripe-oauth-start and
    // stripe-oauth-disconnect. Still fails closed either way.
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
      console.error('[connect-onboard] membership check failed for org', targetOrgId, cmErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    // A platform admin running a move needs no org membership (above). Everyone
    // else does, including a platform admin doing ordinary onboarding.
    if (!cm && !(wantsMove && isPlatformAdmin)) return FORBIDDEN;
    callerRole = cm ? (cm as { role: string }).role : 'platform_admin';

    // ── load org ──────────────────────────────────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      // stripe_pending_account_id is a DEPLOY-ORDER CONTRACT: 20260930b must be
      // applied to a database BEFORE this function is deployed against it, or
      // every call here fails on a column PostgREST cannot find - including the
      // ordinary org-admin onboarding that has nothing to do with moves.
      .select('id, name, slug, website, email, stripe_account_id, stripe_pending_account_id, stripe_account_status, stripe_business_type, stripe_country')
      .eq('id', targetOrgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[connect-onboard] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgData as OrgRow | null;
    if (!org) return json({ error: 'org_not_found' }, 404);

    // Reconnect-after-disconnect: if the org is in 'disconnected' state, the
    // existing stripe_account_id refers to a deauthed account that Stripe
    // won't let us mint Account Links against. Treat as a fresh onboard:
    // clear the dead ID and create a new Express account below. Audit trail
    // for the old account stays in Stripe's dashboard.
    // ── MOVE MODE: mint a SECOND account without disturbing the live one ──
    //
    // Deliberately not a separate function. Everything below - orphan recovery,
    // account creation, the Account Link, the failure handling - is identical
    // for a move; the ONLY difference is which column the account id lands in
    // and that stripe_charge_model is left alone. A parallel implementation
    // would be a second spelling of the same rules, and they would drift.
    //
    // PLATFORM ADMIN ONLY - already settled above, where the caller was either
    // confirmed as one or refused. An org admin must never be able to point
    // their own org at a second Stripe account: stripe_pending_account_id is
    // one switch away from being the payout destination, which is why 20260930b
    // locks it to platform admins in the database too. That check is the front
    // door; the trigger is the lock.
    let isMove = false;
    if (wantsMove) {
      // A move needs something to move AWAY from. Without a live account this
      // is just ordinary onboarding, and doing it in move mode would park the
      // org's FIRST account in the pending column where nothing charges to it.
      if (!org.stripe_account_id || org.stripe_account_status === 'disconnected') {
        return json({
          error: 'nothing_to_move_from',
          message: 'This business has no connected Stripe account to move away from. Set it up the normal way instead.',
        }, 409);
      }
      isMove = true;
    }

    // In move mode the account under construction is the PENDING one, so the
    // recovery and creation below operate on that column's value. Live routing
    // is read-only from here on: stripe_account_id, stripe_charge_model and
    // stripe_account_status are never written on this path.
    let accountId = isMove
      ? org.stripe_pending_account_id
      : (org.stripe_account_status === 'disconnected' ? null : org.stripe_account_id);
    let justCreated = false;

    // ── recover orphan if no account_id but Stripe already has one ────────
    // (covers the "previous call created Stripe account but DB write failed"
    // race; same pattern as the instructor-side onboarding fn.)
    if (!accountId) {
      try {
        const search = await stripe.accounts.search({
          query: `metadata['enrops_org_id']:'${org.id}'`,
          limit: 5,
        });
        // Filter out rejected/closed accounts so a stale one from a reset
        // doesn't get auto-recovered. Stripe sets disabled_reason to
        // 'rejected.*' on platform-rejected accounts; we skip those.
        //
        // AND the two accounts a move creates, because this search keys on
        // enrops_org_id and BOTH of an org's accounts carry it:
        //
        //   - in move mode, the org's LIVE account matches this query. Without
        //     excluding it, the very first start_move would "recover" the live
        //     account as the pending one, and the move would quietly become a
        //     no-op that looks like it worked.
        //   - in normal mode, an account parked for a move matches too. An org
        //     with a move in flight that then disconnects would see two
        //     candidates and get the 409 below - a dead end on the Payments
        //     screen caused by a move nobody on that screen knows about.
        //
        // enrops_account_role is stamped at creation (below) for exactly this.
        // Accounts minted before it existed have no role and read as live,
        // which is what they are.
        const candidates = search.data.filter((a: Stripe.Account) => {
          const dr = a.requirements?.disabled_reason || '';
          if (dr.startsWith('rejected.')) return false;
          const role = (a.metadata as Record<string, string> | null)?.enrops_account_role ?? 'live';
          return isMove
            ? a.id !== org.stripe_account_id && role === 'pending'
            : role !== 'pending';
        });
        if (candidates.length === 1) {
          accountId = candidates[0].id;
          console.warn('[connect-onboard] recovered orphan stripe account', {
            org_id: org.id,
            account_id: accountId,
          });
        } else if (candidates.length > 1) {
          const ids = candidates.map((a: Stripe.Account) => a.id);
          console.error('[connect-onboard] multiple stripe accounts for org', org.id, ids);
          // Reachable by an operator, not just by us: clicking "I don't use
          // Stripe yet" mints an account on the first click, so a couple of
          // exploratory clicks leave two carrying this org's metadata. Without a
          // `message` the Payments screen renders the bare code
          // "multiple_stripe_accounts" - a raw error string on a money screen.
          return json({
            error: 'multiple_stripe_accounts',
            account_ids: ids,
            message: 'There\'s more than one Stripe account set up for this business, so we\'ve stopped rather than guess which one to use. Contact us and we\'ll sort it out with you.',
          }, 409);
        }
      } catch (err) {
        // Search index has a delay; non-fatal. Fall through to create.
        console.warn('[connect-onboard] stripe.accounts.search failed (non-fatal):', err);
      }
    }

    // ── create the Express account if still none ──────────────────────────
    if (!accountId) {
      // One-click Connect: business_type is NOT required at Express account
      // creation. Stripe's hosted onboarding collects it (it lands in
      // requirements.currently_due when omitted). We prefill it ONLY when the
      // org already has it saved (e.g. a legacy org that filled the old form)
      // so Stripe confirms rather than re-asks; otherwise Stripe collects it.
      // country defaults to the platform country (US) and is confirmed during
      // onboarding. See docs.stripe.com/api/accounts/create (both optional).
      try {
        const accountParams: Stripe.AccountCreateParams = {
          // CONTROLLER, NOT `type` — and these three values can NEVER be changed
          // on an account once it exists, so they are the whole ballgame.
          //
          // Stripe's API reference: "The `type` parameter is deprecated. Use
          // `controller` instead to configure dashboard access, fee payer, loss
          // liability, and requirement collection." The two cannot both be sent.
          //
          // These are set EXPLICITLY rather than left to Stripe's defaults (which
          // happen to match) so the intent is auditable and a future default
          // change can't silently alter who pays what.
          //
          //   fees.payer = 'account'      the OPERATOR pays Stripe's 2.9% + 30c
          //                               directly. This is what makes the uplift
          //                               unnecessary instead of load-bearing.
          //   losses.payments = 'stripe'  the operator, not Enrops, carries
          //                               disputes and negative balances. Under
          //                               the old Express + destination setup
          //                               Stripe debited OUR balance for every
          //                               dispute plus the ~$15 fee, "with or
          //                               without on_behalf_of".
          //   stripe_dashboard = 'full'   the operator gets a real Stripe
          //                               dashboard. Load-bearing for Arielle's
          //                               spec, which assumes they can refund
          //                               from inside Stripe directly (and which
          //                               is why we owe a charge.refunded
          //                               handler in Phase 3).
          //   requirement_collection      Stripe collects KYC, same hosted
          //     = 'stripe'                onboarding we already hand them.
          controller: {
            fees: { payer: 'account' },
            losses: { payments: 'stripe' },
            stripe_dashboard: { type: 'full' },
            requirement_collection: 'stripe',
          },
          country: org.stripe_country || 'US',
          ...(org.stripe_business_type
            ? { business_type: org.stripe_business_type as Stripe.AccountCreateParams.BusinessType }
            : {}),
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_profile: {
            ...(org.website ? { url: org.website } : {}),
            // 8299 = Schools/Educational Services - Other. Operator can change
            // during Stripe onboarding if they're a different category.
            // Reasonable default for Enrops's vertical (youth enrichment).
            mcc: '8299',
            product_description: org.name
              ? `Youth enrichment programs and camps operated by ${org.name}`
              : 'Youth enrichment programs and camps',
          },
          metadata: {
            enrops_org_id: org.id,
            enrops_org_slug: org.slug || '',
            // Which of the org's accounts this is. Read back by the orphan
            // search above, and cleared to 'live' when the switch promotes it.
            // Stamped on BOTH paths so the value is never absent-means-guess.
            enrops_account_role: isMove ? 'pending' : 'live',
          },
        };
        if (org.email || callerEmail) {
          accountParams.email = org.email || callerEmail || undefined;
        }
        // Only attach company.name for company-type accounts; Stripe rejects
        // it on individual/non_profit accounts.
        if (org.stripe_business_type === 'company' && org.name) {
          accountParams.company = { name: org.name };
        }

        const account = await stripe.accounts.create(accountParams);
        accountId = account.id;
        justCreated = true;
        // Read back what Stripe ACTUALLY assigned rather than assuming our
        // request was honoured. These values are immutable once the account
        // exists, so the first one we create is the only cheap chance to catch
        // a mismatch between what we asked for and what we got.
        console.log('[connect-onboard] created account controller:', JSON.stringify({
          id: account.id,
          type: (account as unknown as { type?: string }).type ?? null,
          controller: (account as unknown as { controller?: unknown }).controller ?? null,
        }));
      } catch (err) {
        const stripeErr = err as {
          message?: string;
          raw?: { message?: string; code?: string; type?: string };
        };
        const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
        const errCode = stripeErr.raw?.code ?? stripeErr.raw?.type ?? 'unknown';
        console.error('[connect-onboard] stripe.accounts.create failed:', errCode, errMsg);
        return json({
          error: 'stripe_account_create_failed',
          stripe_code: errCode,
          stripe_message: errMsg,
        }, 502);
      }
    }

    // ── persist accountId on the org row ──────────────────────────────────
    // Trigger guard_organizations_locked_columns blocks org admins from
    // changing stripe_account_id; service_role (this fn) bypasses.
    const previouslyStored = isMove ? org.stripe_pending_account_id : org.stripe_account_id;
    if (justCreated || previouslyStored !== accountId) {
      // A MOVE writes ONE column. Not stripe_account_id, not
      // stripe_charge_model, and NOT stripe_account_status: that column
      // describes the account currently taking the money, and setting it to
      // 'onboarding' would tell the operator's own Payments screen that their
      // WORKING account is mid-setup - while it carries on charging perfectly
      // well. The new account's readiness is read from Stripe by the switch,
      // which is the only thing that needs to know it.
      const moveUpdate = { stripe_pending_account_id: accountId };
      const normalUpdate = {
        stripe_account_id: accountId,
        stripe_account_status: 'onboarding',
        // Only an account WE just minted is known to be controller-based.
        // The orphan-recovery branch above adopts a pre-existing Stripe
        // account, which may well be a legacy Express one — marking that
        // 'direct' would route its charges the wrong way and make the
        // operator pay a Stripe fee we are also still recovering via the
        // uplift. Leave those on the 'destination' default.
        ...(justCreated ? { stripe_charge_model: 'direct' } : {}),
      };

      const { error: updErr } = await supabase
        .from('organizations')
        .update(isMove ? moveUpdate : normalUpdate)
        .eq('id', org.id);
      if (updErr) {
        // If we just minted a Stripe account and can't persist it, delete it
        // so the next retry's search doesn't find an orphan to "recover".
        if (justCreated && accountId) {
          try {
            await stripe.accounts.del(accountId);
            console.warn('[connect-onboard] deleted orphan stripe account', accountId);
          } catch (delErr) {
            console.error('[connect-onboard] orphan delete failed', accountId, delErr);
          }
        }
        console.error('[connect-onboard] org update failed:', updErr);
        return json({ error: 'persist_failed' }, 500);
      }
    }

    // ── create a fresh Account Link ───────────────────────────────────────
    // return_url: where Stripe sends the operator after completing (or
    // pausing) onboarding. The Finances tab re-queries org state on mount.
    // refresh_url: where Stripe sends the operator if the link expired
    // (Account Links have short TTLs); the page calls this fn again to mint
    // a new link.
    const slug = org.slug || '';
    const returnUrl = `${origin}/admin/finances?stripe=return`;
    const refreshUrl = `${origin}/admin/finances?stripe=refresh`;
    void slug; // reserved for future per-tenant routes if we adopt them

    // What did Stripe ACTUALLY assign? controller.fees.payer / losses.payments /
    // stripe_dashboard.type are immutable once the account exists, so knowing
    // them is the difference between "we think the operator pays Stripe" and
    // "we know". Returned so the admin surface can show the truth rather than
    // infer it from our own column. Never fatal - a failed read must not block
    // handing back the onboarding URL.
    let assignedController: unknown = null;
    try {
      const acct = await stripe.accounts.retrieve(accountId!);
      assignedController = (acct as unknown as { controller?: unknown }).controller ?? null;
      console.log('[connect-onboard] stripe-assigned controller:', JSON.stringify({
        id: acct.id,
        type: (acct as unknown as { type?: string }).type ?? null,
        controller: assignedController,
      }));
    } catch (err) {
      console.warn('[connect-onboard] accounts.retrieve failed (non-fatal):', err);
    }

    let link;
    try {
      link = await stripe.accountLinks.create({
        account: accountId!,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
    } catch (err) {
      console.error('[connect-onboard] stripe.accountLinks.create failed:', err);
      return json({ error: 'stripe_link_create_failed' }, 502);
    }

    // ONBOARDING FUNNEL — the operator has been handed Stripe's hosted URL, i.e.
    // they STARTED the Stripe step (the WOW moment, and the drop-off Arielle
    // called out). Pairs with the existing stripe_connected signal to measure
    // started-vs-finished. Deliberately NOT deduped: a repeat click is a real
    // friction signal (count DISTINCT organization_id for unique operators).
    // Fail-safe: telemetry can never block handing back the onboarding URL.
    await logPlatformEvent(supabase, {
      feature: FEATURE.ONBOARDING,
      action: ACTION.STRIPE_CONNECT_STARTED,
      outcome: 'success',
      organizationId: org.id,
      actorUserId: callerAuthId,
      // `move` keeps the funnel honest. Without it a platform admin starting a
      // move would count as an operator starting onboarding, and the
      // started-vs-finished number Arielle reads would drift by exactly the
      // moves we run - which are the ones that never "finish" that way.
      metadata: {
        reconnect: org.stripe_account_status === 'disconnected',
        caller_role: callerRole,
        move: isMove,
      },
    });

    return json({
      onboarding_url: link.url,
      account_id: accountId,
      account_controller: assignedController,
      caller_role: callerRole,
      // Named differently on purpose: on a move, account_id above is the NEW
      // account, which is not yet taking anything. Saying which account is
      // still live stops a caller reading account_id as "where the money goes".
      ...(isMove
        ? { move: true, pending_account_id: accountId, still_charging_to: org.stripe_account_id }
        : {}),
    });
  } catch (err) {
    console.error('[connect-onboard] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function sanitizeOrigin(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (!/^https?:\/\/[^\s/]+$/i.test(t)) return null;
  return t.replace(/\/$/, '');
}
