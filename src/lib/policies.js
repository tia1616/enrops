// Which legal documents a given organization has actually published.
//
// `org_policies` holds one row per (organization_id, policy_type). Most tenants
// have published NONE — as of 2026-07-18 only `enrops` (the platform's own docs)
// and `j2s` have any rows at all. So every public surface that links to a
// provider's Privacy Policy or Terms must ask first, or it links to a page that
// cannot render.
//
// The platform's own docs live under the `enrops` org and apply to every user of
// every provider, so they are linked separately (see PLATFORM_LEGAL_LINKS).

import { supabase } from './supabase.js';

/**
 * Policy types a provider has published.
 * @param {string} organizationId
 * @returns {Promise<Set<string>>} e.g. Set { 'privacy', 'terms' } — empty if none.
 */
export async function fetchPublishedPolicyTypes(organizationId) {
  if (!organizationId) return new Set();
  const { data, error } = await supabase
    .from('org_policies')
    .select('policy_type')
    .eq('organization_id', organizationId);
  // Fail closed: on error we show no provider legal links rather than linking to
  // a page we can't confirm exists. The Enrops platform links (below) still render,
  // so the footer is never left without a route to the terms that govern the account.
  if (error || !data) return new Set();
  return new Set(data.map((r) => r.policy_type));
}

/**
 * Enrops PLATFORM legal docs. These govern every account regardless of which
 * provider the family registered with, so they render in every portal footer
 * alongside the "Powered by Enrops" badge — never as a substitute for a
 * provider's own policy.
 */
export const PLATFORM_LEGAL_LINKS = [
  { to: '/privacy', label: 'Enrops Privacy' },
  { to: '/terms', label: 'Enrops Terms' },
];
