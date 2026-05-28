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

    // Resolve target org. If body.org_id is supplied, verify the caller has
    // owner/admin role on THAT org. Otherwise, find the caller's org by
    // membership (only one for most users).
    let targetOrgId: string | null = body.org_id || null;
    let callerRole: string | null = null;

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
      callerRole = (cm as { role: string }).role;
    } else {
      const { data: cm } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (!cm) return FORBIDDEN;
      const member = cm as { role: string; organization_id: string };
      targetOrgId = member.organization_id;
      callerRole = member.role;
    }

    // ── load org ──────────────────────────────────────────────────────────
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, slug, website, email, stripe_account_id, stripe_account_status, stripe_business_type, stripe_country')
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
          return json({ error: 'multiple_stripe_accounts', account_ids: ids }, 409);
        }
      } catch (err) {
        // Search index has a delay; non-fatal. Fall through to create.
        console.warn('[connect-onboard] stripe.accounts.search failed (non-fatal):', err);
      }
    }

    // ── create the Express account if still none ──────────────────────────
    if (!accountId) {
      // Tenant must have stripe_business_type set before we can create the
      // account — Stripe requires it at create-time for clean Express
      // onboarding. The Finances UI gates the "Connect Stripe" button on this
      // being set; this check is defense-in-depth.
      if (!org.stripe_business_type) {
        return json({
          error: 'missing_business_type',
          message: 'Business type must be set before connecting Stripe. Open Finances → Business setup.',
        }, 400);
      }

      try {
        const accountParams: Stripe.AccountCreateParams = {
          type: 'express',
          country: org.stripe_country || 'US',
          business_type: org.stripe_business_type as Stripe.AccountCreateParams.BusinessType,
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
      const { error: updErr } = await supabase
        .from('organizations')
        .update({
          stripe_account_id: accountId,
          stripe_account_status: 'onboarding',
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

    return json({
      onboarding_url: link.url,
      account_id: accountId,
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
