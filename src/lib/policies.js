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
    .eq('organization_id', organizationId)
    // Only live policies get a footer link. A row can now exist as a hidden
    // draft (published = false); linking to it would dead-end on the public page.
    .eq('published', true);
  // Fail closed: on error we show no provider legal links rather than linking to
  // a page we can't confirm exists. The Enrops platform links (below) still render,
  // so the footer is never left without a route to the terms that govern the account.
  if (error || !data) return new Set();
  return new Set(data.map((r) => r.policy_type));
}

/**
 * Enrops PLATFORM legal docs. These govern every account regardless of which
 * provider the family registered with, so they render in every portal footer
 * under the Platform heading — never as a substitute for a provider's own
 * policy. (They used to sit alongside a "Powered by Enrops" badge; that badge
 * was retired for the single attribution line in PlatformFooterLine.jsx.)
 */
export const PLATFORM_LEGAL_LINKS = [
  { to: '/privacy', label: 'Enrops Privacy' },
  { to: '/terms', label: 'Enrops Terms' },
  // Requested by the Meta-pixel work: the cookie disclosure is what documents
  // the advertising pixel, and until now nothing in the app linked to it.
  // Verified before adding — App.jsx:132 serves /cookies, and the enrops org's
  // cookies policy is published with real content in prod. A link to an
  // unpublished policy would render an empty page, which is the failure this
  // is meant to fix, not repeat.
  //
  // NOT added: "Do Not Sell or Share My Personal Information". That needs a
  // consent module that does not exist yet; it ships with the control it opens.
  { to: '/cookies', label: 'Enrops Cookies' },
  // CCPA/CPRA requires a clear, always-available way to stop the sharing that
  // the advertising pixel performs. Our published Cookie Disclosure and Privacy
  // Policy both promise "the link on our site" - this is it, and it must not be
  // removed while a pixel is configured.
  { to: '/do-not-sell', label: 'Do Not Sell or Share' },
];
