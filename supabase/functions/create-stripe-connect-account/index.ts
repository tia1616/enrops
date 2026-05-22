// create-stripe-connect-account — Function 10 (chunk 2).
//
// Instructor-facing. Creates a Stripe Connect Express account if the
// instructor doesn't have one yet, then returns a fresh Account Link the
// wizard redirects to. Calling again returns a fresh link against the
// existing account (handles "refresh expired link" + retry).
//
// Body (optional): { origin: "https://..." } — the wizard's base URL.
// Used to build return_url + refresh_url. Defaults to https://enrops.com
// when not provided so prod still works if the client forgets to send it.
//
// Env vars required: STRIPE_SECRET_KEY.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

interface RequestBody {
  origin?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      // Body is optional; default origin to enrops.com.
    }
    const origin = sanitizeOrigin(body.origin) || 'https://enrops.com';
    const slug = me.org_slug;

    const supabase = adminClient();

    // Look up existing stripe_connect_account_id on the onboarding row.
    const { data: existing, error: fetchErr } = await supabase
      .from('contractor_onboarding_status')
      .select('stripe_connect_account_id')
      .eq('instructor_id', me.id)
      .maybeSingle();
    if (fetchErr) {
      console.error('onboarding fetch failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    let accountId = existing?.stripe_connect_account_id as string | null;

    // Create a new Express account if needed.
    if (!accountId) {
      let account;
      try {
        account = await stripe.accounts.create({
          type: 'express',
          email: me.email,
          capabilities: { transfers: { requested: true } },
          metadata: {
            instructor_id: me.id,
            organization_id: me.organization_id,
          },
        });
      } catch (err) {
        console.error('stripe.accounts.create failed:', err);
        return json({ error: 'stripe_account_create_failed' }, 502);
      }
      accountId = account.id;

      // Persist the account ID. Use update or insert depending on whether
      // the onboarding row exists yet.
      if (existing) {
        const { error: updErr } = await supabase
          .from('contractor_onboarding_status')
          .update({
            stripe_connect_account_id: accountId,
            stripe_connect_status: 'onboarding_in_progress',
            updated_at: new Date().toISOString(),
          })
          .eq('instructor_id', me.id);
        if (updErr) {
          console.error('stripe account id store failed:', updErr);
          return json({ error: 'update_failed' }, 500);
        }
      } else {
        const { error: insErr } = await supabase
          .from('contractor_onboarding_status')
          .insert({
            instructor_id: me.id,
            organization_id: me.organization_id,
            stripe_connect_account_id: accountId,
            stripe_connect_status: 'onboarding_in_progress',
            overall_status: 'in_progress',
          });
        if (insErr) {
          console.error('stripe account id insert failed:', insErr);
          return json({ error: 'insert_failed' }, 500);
        }
      }
    }

    // Always create a fresh account link — old links expire fast.
    const returnUrl = `${origin}/${slug}/onboarding?return=true`;
    const refreshUrl = `${origin}/${slug}/onboarding?refresh=true`;

    let link;
    try {
      link = await stripe.accountLinks.create({
        account: accountId!,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
    } catch (err) {
      console.error('stripe.accountLinks.create failed:', err);
      return json({ error: 'stripe_link_create_failed' }, 502);
    }

    return json({ onboarding_url: link.url });
  } catch (err) {
    console.error('create-stripe-connect-account fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function sanitizeOrigin(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  // Only accept https:// or http:// (for local dev). Reject anything else
  // (data: URIs, javascript:, etc.) so the return URL can't be hijacked.
  if (!/^https?:\/\/[^\s/]+$/i.test(t)) return null;
  return t.replace(/\/$/, '');
}
