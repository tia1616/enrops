// Server-side mirror of src/lib/entitlements.js — the plan gate for edge functions.
//
// WHY THIS EXISTS: the Comms tier gate shipped as UI only. Routes were guarded in
// App.jsx and tabs hidden in FamilyCommsTabs, but nothing on the server knew about
// plans at all (`grep -rn platform_plan supabase/functions/` returned nothing). An
// operator blocked from /admin/family-comms/marketing could open devtools on a page
// that already holds an authenticated supabase client and call
// supabase.functions.invoke('marketing-draft-campaign', ...) directly. Hiding a
// route is not a gate when the API is the product.
//
// assertRole.ts states the rule this skipped: "Tiers mirror the DB helper functions
// ... so the three enforcement layers agree." This is the plan equivalent.
//
// SCOPE, stated precisely: this is a TIER bypass, not a tenant bypass. assertRole
// still proves the caller is an admin of the org they name, so nobody reaches
// another org's families either way. What this stops is an org buying the paid
// surface for free by calling past the UI.
//
// KEEP IN SYNC with src/lib/entitlements.js. The two are deliberately separate
// files (browser ESM vs Deno TS, no shared build step); the values below are the
// contract. If FULL_ACCESS_PLANS changes there, change it here in the same commit.

import { json } from './instructor.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

/** Mirrors FULL_ACCESS_PLANS in src/lib/entitlements.js. */
const FULL_ACCESS_PLANS = new Set(['founding', 'enterprise']);

export type CommsLevel = 'full' | 'registration_only';

/** Mirrors entitlementsFor(org).comms. Pure — takes the two columns it needs. */
export function commsLevelFor(
  org: { instructor_pay_model?: string | null; platform_plan?: string | null } | null,
): CommsLevel {
  // Non-lean orgs (J2S / legacy_own_platform) have always had the whole surface.
  if (org?.instructor_pay_model !== 'enrops_platform') return 'full';
  return FULL_ACCESS_PLANS.has(org?.platform_plan ?? '') ? 'full' : 'registration_only';
}

/**
 * Assert this org is entitled to the full Comms surface (campaigns, templates).
 * Returns a 403 Response the caller should return as-is, or null to proceed.
 *
 * Reads the org with the service-role client the function already holds, so it
 * cannot be spoofed by anything in the request body — the plan comes from the row,
 * never from the caller. Fails CLOSED: a lookup error refuses rather than assumes.
 */
export async function assertCommsFull(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Response | null> {
  const { data, error } = await supabase
    .from('organizations')
    .select('instructor_pay_model, platform_plan')
    .eq('id', orgId)
    .maybeSingle();

  if (error) {
    console.error('assertCommsFull lookup failed:', error);
    return json({ error: 'lookup_failed' }, 500);
  }
  if (!data) return json({ error: 'forbidden' }, 403);

  if (commsLevelFor(data) !== 'full') {
    console.log(`[entitlements] org ${orgId} is registration_only — campaign surface refused`);
    return json(
      {
        error: 'plan_required',
        message: 'Campaigns are not included in this plan.',
      },
      403,
    );
  }
  return null;
}
