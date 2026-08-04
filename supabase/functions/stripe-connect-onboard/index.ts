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
// Env: STRIPE_SECRET_KEY (operator-Connect platform key — the ORIGINAL
// Enrops Stripe account, not the instructor one).
// Does NOT use STRIPE_CONNECT_CLIENT_ID (that was for the v1 OAuth design,
// dropped in v2 spec — Express doesn't need it).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { logPlatformEvent, FEATURE, ACTION } from '../_shared/logPlatformEvent.ts';
import { decideChargeModel } from '../_shared/chargeModelDecision.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

interface RequestBody {
  org_id?: string;
  origin?: string;
}

interface OrgRow {
  id: string;
  name: string | null;
  slug: string | null;
  website: string | null;
  email: string | null;
  stripe_account_id: string | null;
  stripe_account_status: string | null;
  stripe_business_type: string | null;
  stripe_country: string | null;
  stripe_charge_model: string | null;
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
    if (!cm) return FORBIDDEN;
    callerRole = (cm as { role: string }).role;

    // ── load org ──────────────────────────────────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      // stripe_charge_model is read below to decide whether minting an account
      // may re-declare this org's money model. Every column read as org.x must
      // appear here: PostgREST returns an object WITHOUT the key rather than
      // throwing, so a missing one reads undefined and whatever depends on it
      // silently disappears.
      .select('id, name, slug, website, email, stripe_account_id, stripe_account_status, stripe_business_type, stripe_country, stripe_charge_model')
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
    let accountId =
      org.stripe_account_status === 'disconnected' ? null : org.stripe_account_id;
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
        const candidates = search.data.filter((a: Stripe.Account) => {
          const dr = a.requirements?.disabled_reason || '';
          return !dr.startsWith('rejected.');
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
    if (justCreated || org.stripe_account_id !== accountId) {
      // ── may this mint re-declare the org's money model? ──────────────────
      // Only an account WE just minted is known to be controller-based. The
      // orphan-recovery branch above adopts a pre-existing Stripe account, which
      // may well be a legacy Express one — marking that 'direct' would route its
      // charges the wrong way and make the operator pay a Stripe fee we are also
      // still recovering via the uplift. Those keep whatever they had.
      //
      // AND minting is not licence to re-declare the model either. An org that
      // has already taken money has live charges and payment plans depending on
      // its current model; process-installments FAILS CLOSED on any plan that
      // predates a switch to 'direct', marking those rows paused_card_failed.
      // Observed for real on staging 2026-08-04: this button flipped an org with
      // 10 paid registrations from destination to direct in one click. The same
      // shared rule the OAuth callback uses decides it here, so the answer
      // cannot depend on which button the operator pressed.
      let chargeModelPatch: Record<string, unknown> = {};
      if (justCreated) {
        const { data: priorMoney, error: priorMoneyErr } = await supabase
          .from('registrations')
          .select('id')
          .eq('organization_id', org.id)
          .not('stripe_payment_intent_id', 'is', null)
          .limit(1);
        if (priorMoneyErr) {
          console.warn(
            `[connect-onboard] could not read charge history for org ${org.id}:`,
            priorMoneyErr.message,
          );
        }
        const decision = decideChargeModel({
          existingModel: org.stripe_charge_model ?? null,
          // The org row was loaded successfully above, or we would have returned.
          existingModelUnreadable: false,
          hasTakenMoney: ((priorMoney as { id: string }[] | null)?.length ?? 0) > 0,
          historyUnreadable: Boolean(priorMoneyErr),
          // We mint with controller.fees.payer='account', so a minted account
          // genuinely is direct-capable. That is what makes this the INFERENCE
          // for a new org and irrelevant for an established one.
          operatorBearsStripeFees: true,
        });
        if (decision.chargeModel !== null) {
          chargeModelPatch = { stripe_charge_model: decision.chargeModel };
        }
        if (decision.preserved) {
          console.error(
            `[connect-onboard] NEEDS REVIEW: org ${org.id} minted ${accountId} but KEPT ` +
            `charge_model='${decision.chargeModel}' (${decision.source}). A minted account is ` +
            `direct-capable, so this org is now on a new account it does not route charges through ` +
            `directly. Confirm that is intended.`,
          );
        }
      }

      const { error: updErr } = await supabase
        .from('organizations')
        .update({
          stripe_account_id: accountId,
          stripe_account_status: 'onboarding',
          ...chargeModelPatch,
        })
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
      metadata: { reconnect: org.stripe_account_status === 'disconnected', caller_role: callerRole },
    });

    return json({
      onboarding_url: link.url,
      account_id: accountId,
      account_controller: assignedController,
      caller_role: callerRole,
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
