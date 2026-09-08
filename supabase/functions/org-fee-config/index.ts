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
import { SCHOLARSHIP_FUND_OFF } from '../_shared/scholarshipFund.ts';

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

    // The scholarship-fund ask on StepPay. Served here rather than read
    // directly by the browser for the SAME reason the fee columns are: the anon
    // org view is a deliberately narrow allowlist, and widening it is the
    // riskier change. org_scholarship_fund grants anon nothing at all.
    //
    // Looked up by id after the org resolves below, so an unknown or inactive
    // slug can never surface another provider's ask.
    const { data, error } = await admin
      .from('organizations')
      // stripe_charges_enabled rides along so the registration form can tell a
      // family up front that this provider can't take payment yet, instead of
      // letting them fill everything in and hit a wall at the Pay step. Not
      // sensitive (it's a yes/no about whether the provider is open for money).
      .select('id, name, fee_pass_through, platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, platform_fee_floor_cents, sibling_discount_pct, stripe_charges_enabled')
      .eq('slug', slug)
      .eq('status', 'active')
      .single();

    if (error || !data) {
      // Unknown/inactive slug: return absorb defaults so the UI just shows the
      // base price (never throws the registration flow). scholarship_fund is
      // OFF here deliberately - the fee default is "show the plain price", but
      // the fund default has to be "ask nobody for money", which is a stricter
      // kind of safe.
      return json({ fee_pass_through: false, platform_fee_card_pct: 0, platform_fee_ach_pct: 0, platform_fee_cap_cents: 0, platform_fee_floor_cents: null, scholarship_fund: SCHOLARSHIP_FUND_OFF });
    }

    // LEFT JOIN by hand, not `!inner`: an org with no row here has simply never
    // been offered the feature, and must still get its fee config back.
    const { data: fundRow, error: fundErr } = await admin
      .from('org_scholarship_fund')
      .select('enabled, headline, blurb, tax_note, preset_amounts_cents, min_cents, max_cents, cover_fee_default, cover_fee_pct')
      .eq('organization_id', data.id)
      .maybeSingle();
    // A failed lookup is NOT "no fund" - it is "we do not know". Both land on
    // OFF, but the error is logged because a fund silently switching itself off
    // for every family is a thing an operator would otherwise never hear about.
    if (fundErr) {
      console.error(`[org-fee-config] scholarship fund lookup failed for ${slug}:`, fundErr.message);
    }
    const scholarshipFund = (!fundErr && fundRow?.enabled)
      ? {
          enabled: true,
          headline: fundRow.headline,
          blurb: fundRow.blurb,
          tax_note: fundRow.tax_note,
          // Presets are display-only; the AUTHORITATIVE bounds are min/max, which
          // create-checkout re-reads from this same row. Sorted so a provider who
          // types them out of order still gets an ascending row of tiles.
          preset_amounts_cents: (fundRow.preset_amounts_cents || [])
            .map((n: unknown) => Number(n))
            .filter((n: number) => Number.isInteger(n) && n > 0)
            .sort((a: number, b: number) => a - b),
          min_cents: Number(fundRow.min_cents),
          max_cents: Number(fundRow.max_cents),
          cover_fee_default: !!fundRow.cover_fee_default,
          cover_fee_pct: Number(fundRow.cover_fee_pct) || 0,
          org_name: data.name || '',
        }
      : SCHOLARSHIP_FUND_OFF;

    // Return BOTH method rates so the family-facing "Platform fee" line matches
    // whichever method the family selects on StepPay (card vs bank transfer).
    return json({
      fee_pass_through: !!data.fee_pass_through,
      platform_fee_card_pct: Number(data.platform_fee_card_pct) || 0,
      platform_fee_ach_pct: Number(data.platform_fee_ach_pct) || 0,
      platform_fee_cap_cents: Number(data.platform_fee_cap_cents) || 0,
      // Min fee per transaction; null = no floor. Sent so StepPay's displayed fee
      // matches the server-charged fee (computePlatformFee applies the same floor).
      platform_fee_floor_cents: data.platform_fee_floor_cents == null ? null : Number(data.platform_fee_floor_cents),
      // Sibling discount % so the review screen matches the server-authoritative
      // charge (create-registration reads the same org config). null = off.
      sibling_discount_pct: data.sibling_discount_pct == null ? null : Number(data.sibling_discount_pct),
      // Can this provider actually take money? Used to stop a family before they
      // fill the whole form. The AUTHORITATIVE block lives in create-checkout —
      // this is only so the UI can say so early and kindly.
      stripe_charges_enabled: !!data.stripe_charges_enabled,
      // The checkout scholarship ask. `enabled:false` means StepPay renders
      // nothing at all - not a disabled control, not an empty box.
      scholarship_fund: scholarshipFund,
    });
  } catch (err) {
    console.error('org-fee-config error:', err);
    // Fail safe to absorb display, and to asking nobody for a donation.
    return json({ fee_pass_through: false, platform_fee_card_pct: 0, platform_fee_ach_pct: 0, platform_fee_cap_cents: 0, scholarship_fund: SCHOLARSHIP_FUND_OFF });
  }
});
