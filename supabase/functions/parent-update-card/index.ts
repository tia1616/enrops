// parent-update-card — a family whose payment plan stalled on a dead card gets a
// Stripe-hosted page to put a new one on file.
//
// THE GAP THIS CLOSES. When an instalment declines, process-installments marks
// the rows paused_card_failed and emails the parent. That email has nowhere to
// send them: there is no card-update surface anywhere in enrops, so every single
// failure needs Jessica to contact the family and collect the money by hand. Two
// families hit it in two days (1 and 2 October 2026), and the workaround was a
// Stripe invoice raised on the PLATFORM account, which collects into the enrops
// balance instead of the operator's and leaves the plan showing unpaid.
//
// WHAT THIS HALF DOES, AND WHAT IT DELIBERATELY DOES NOT. It mints a Stripe
// Checkout Session in `setup` mode and hands back the URL. The card the family
// enters is attached to their existing Stripe Customer and NOTHING ELSE HAPPENS:
// no row is written, no charge is made, nothing is un-paused. Promoting that new
// card onto the paused instalments is the webhook half, and until it exists this
// function is inert by construction - the safe side to ship first.
//
// ROUTING IS NOT OPTIONAL HERE. A destination org's families are Customers on the
// PLATFORM; a direct org's families are Customers on that operator's own account.
// A setup session created against the wrong account cannot see the Customer at
// all. So the account scope comes from buildChargeRouting, the same single
// spelling every charge path uses, rather than a second copy of the rule.
//
// It is called with amount 0 on purpose: this is not a charge, so there is no
// amount, and the only two things read off the result are `requestOptions` (which
// account to talk to) and `blocked` (whether this operator can take money at
// all). The fee it computes for a zero amount is never used. Asking a family to
// save a card to an account that cannot charge would be collecting a card for a
// payment that can never happen.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { buildChargeRouting, ConnectOrgConfig } from '../_shared/connectChargeParams.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

interface RequestBody {
  registration_id?: string;
  origin?: string;
}

/**
 * The statuses a card update can actually rescue.
 *
 * DENY-LIST SHAPED, for the 20260810g reason: 'paid' and 'refunded' are finished
 * and must never be resurrected by a new card. Everything else on a plan is
 * still collectable. Listing what we RESCUE rather than what we skip would have
 * quietly ignored 'failed' the first time somebody added a status.
 */
const RESCUABLE = ['pending', 'failed', 'paused_card_failed'];

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
      // Required below; an unparseable body is the same as an empty one.
    }
    const registrationId = typeof body.registration_id === 'string' ? body.registration_id.trim() : '';
    if (!registrationId) {
      return json({
        error: 'registration_id_required',
        message: 'We could not tell which payment plan to update. Reload the page and try again.',
      }, 400);
    }

    // ── the caller must OWN this registration ─────────────────────────────
    //
    // Matched through parents.auth_id, which is how a signed-in family maps to
    // their records. Deliberately NOT matched on email: a second guardian can
    // share an email address with the first, and parents rows are per
    // organisation, so an email match would hand one family's plan to another
    // person who happens to share an inbox. The auth id is the only thing that
    // identifies a person.
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select(`
        id,
        organization_id,
        parents:parent_id ( id, auth_id ),
        organizations:organization_id (
          stripe_account_id,
          stripe_charges_enabled,
          stripe_charge_model,
          name,
          slug
        )
      `)
      .eq('id', registrationId)
      .maybeSingle();
    if (regErr) {
      console.error('[parent-update-card] registration lookup failed:', regErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!reg) return json({ error: 'not_found' }, 404);

    const parentAuthId = (reg.parents as { auth_id?: string | null } | null)?.auth_id ?? null;
    if (!parentAuthId || parentAuthId !== callerAuthId) {
      // Same answer whether the registration is missing or simply not theirs.
      // Telling a signed-in stranger that a registration EXISTS is a fact they
      // have no business learning.
      return json({ error: 'not_found' }, 404);
    }

    // ── which rows would a new card rescue, and whose customer is it? ─────
    const { data: rows, error: rowsErr } = await supabase
      .from('installments')
      .select('id, status, stripe_customer_id, installment_number, amount_cents, due_date')
      .eq('registration_id', registrationId)
      .in('status', RESCUABLE)
      .order('installment_number');
    if (rowsErr) {
      console.error('[parent-update-card] installment lookup failed:', rowsErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const stalled = (rows ?? []).filter((r) => r.status === 'paused_card_failed' || r.status === 'failed');
    if (stalled.length === 0) {
      // Nothing is stuck. Inviting a card update here would ask a family to
      // re-enter card details for a problem they do not have.
      return json({
        error: 'nothing_to_fix',
        message: 'There is nothing outstanding on this payment plan right now.',
      }, 409);
    }

    // Every row on a plan carries the same Stripe Customer, because the customer
    // is created once at checkout. Read it from the stalled rows rather than
    // assuming, and refuse if they disagree - a plan whose rows point at two
    // customers is a data problem, not something to guess our way through.
    const customerIds = [...new Set(stalled.map((r) => r.stripe_customer_id).filter(Boolean))];
    if (customerIds.length !== 1) {
      console.error('[parent-update-card] expected exactly one customer for registration', registrationId, customerIds);
      return json({ error: 'ambiguous_customer' }, 409);
    }
    const customerId = customerIds[0] as string;

    // ── which Stripe account owns that customer? ──────────────────────────
    const orgConfig = (reg.organizations ?? null) as ConnectOrgConfig | null;
    const orgId = reg.organization_id as string | null;
    const routing = buildChargeRouting(0, 'card', orgConfig, orgId);
    if (routing.blocked) {
      console.warn(`[parent-update-card] BLOCKED: ${routing.blocked}`);
      return json({
        error: 'operator_cannot_charge',
        message: 'This provider is not set up to take payments right now, so there is nothing to save a card against. Please contact them directly.',
      }, 409);
    }
    const acct = routing.requestOptions;

    const origin = sanitizeOrigin(body.origin) || 'https://enrops.com';

    // THE PORTAL IS TENANT-SCOPED: the parent dashboard is /{slug}/dashboard,
    // not /dashboard. Sending a family to the unslugged path drops them on a
    // route that does not exist, immediately after they have handed over card
    // details - the worst possible moment to show somebody a dead page. Caught
    // by reading App.jsx rather than by assuming, because Stripe will happily
    // redirect to a 404 and report nothing wrong.
    //
    // Refusing when the slug is missing rather than guessing: a tenant with no
    // slug has no portal URL at all, and a half-built return trip is worse than
    // an honest refusal before the family starts.
    const slug = (reg.organizations as { slug?: string | null } | null)?.slug ?? '';
    if (!slug) {
      console.error('[parent-update-card] org has no slug, cannot build a return URL:', orgId);
      return json({ error: 'org_not_reachable' }, 409);
    }
    const backTo = `${origin}/${slug}/dashboard`;

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customerId,
        payment_method_types: ['card'],
        success_url: `${backTo}?card=updated`,
        cancel_url: `${backTo}?card=cancelled`,
        // EVERYTHING THE WEBHOOK HALF NEEDS, carried on the SetupIntent rather
        // than the session: the session object is not what arrives on
        // setup_intent.succeeded, and a value only present on the session is a
        // value the webhook cannot read. organization_id is here so a direct
        // org's event, which arrives from the connected account, can be tied
        // back without a second lookup.
        setup_intent_data: {
          metadata: {
            enrops_purpose: 'card_update',
            enrops_registration_id: registrationId,
            enrops_customer_id: customerId,
            enrops_org_id: orgId ?? '',
          },
        },
      }, acct);
    } catch (err) {
      console.error('[parent-update-card] checkout.sessions.create failed:', err);
      return json({
        error: 'stripe_session_failed',
        message: 'We could not open the card form just now. Please try again in a moment.',
      }, 502);
    }

    console.log('[parent-update-card] setup session created', {
      registration_id: registrationId,
      customer: customerId,
      direct: routing.direct,
      stalled_rows: stalled.length,
    });

    return json({
      url: session.url,
      // What the family is fixing, so the page asking them can say it out loud
      // instead of sending them to Stripe with no idea what for.
      stalled_total_cents: stalled.reduce((n, r) => n + (r.amount_cents ?? 0), 0),
      stalled_count: stalled.length,
    });
  } catch (err) {
    console.error('[parent-update-card] fatal:', err);
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
