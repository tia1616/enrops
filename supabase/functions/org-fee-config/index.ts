// org-fee-config — returns ONLY the fee-display fields an anonymous registration
// flow needs to show the pass-through "Platform fee" line before redirecting to
// Stripe. Deliberately narrow: never returns stripe_account_id, secrets, or any
// other org column.
//
// Why an edge fn (not the public_org_directory view): the RBAC hardening
// (2026-06-25) restricts the anon view to safe columns and excludes
// platform_fee_*/fee_pass_through. The sanctioned way to surface fee config to a
// non-member/anon context is a service-role edge fn that returns a controlled,
// minimal payload — which is exactly this. The fee % is already shown to the
// family at Stripe checkout, so it is not sensitive.
//
// verify_jwt = false (set in config.toml): the parent registration flow is anon.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { slug } = await req.json();
    if (!slug || typeof slug !== 'string') return json({ error: 'Missing slug' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await admin
      .from('organizations')
      .select('fee_pass_through, platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, sibling_discount_pct')
      .eq('slug', slug)
      .eq('status', 'active')
      .single();

    if (error || !data) {
      // Unknown/inactive slug: return absorb defaults so the UI just shows the
      // base price (never throws the registration flow).
      return json({ fee_pass_through: false, platform_fee_card_pct: 0, platform_fee_ach_pct: 0, platform_fee_cap_cents: 0 });
    }

    // Return BOTH method rates so the family-facing "Platform fee" line matches
    // whichever method the family selects on StepPay (card vs bank transfer).
    return json({
      fee_pass_through: !!data.fee_pass_through,
      platform_fee_card_pct: Number(data.platform_fee_card_pct) || 0,
      platform_fee_ach_pct: Number(data.platform_fee_ach_pct) || 0,
      platform_fee_cap_cents: Number(data.platform_fee_cap_cents) || 0,
      // Sibling discount % so the review screen matches the server-authoritative
      // charge (create-registration reads the same org config). null = off.
      sibling_discount_pct: data.sibling_discount_pct == null ? null : Number(data.sibling_discount_pct),
    });
  } catch (err) {
    console.error('org-fee-config error:', err);
    // Fail safe to absorb display.
    return json({ fee_pass_through: false, platform_fee_card_pct: 0, platform_fee_ach_pct: 0, platform_fee_cap_cents: 0 });
  }
});
