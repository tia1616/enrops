// Tenant slug → brand config. J2S is the first tenant. Pattern extends for future operators.

export const TENANTS = {
  j2s: {
    slug: 'j2s',
    name: 'Journey to STEAM',
    shortName: 'J2S',
    tagline: 'Future-Ready Skills. Right After School.',
    heroDek:
      "Hands-on coding, LEGO, game design, and robotics at 30+ Portland-area schools. Small groups, expert instructors, and a kid who can't wait for next week.",
    colors: {
      primary: '#674EE8',
      primaryDark: '#4430AC',
      primarySoft: '#EDE9FE',
      accent: '#F8A638',
      accentDark: '#E85B37',
      ink: '#1A1530',
    },
    displayFont: '"Titan One"',
    bodyFont: '"Nunito Sans"',
    supportEmail: 'support@journeytosteam.com',
    supportPhone: '(971) 258-2178',
    waiverFamily: 'j2s', // to match against waivers.name
  },
};

// REMOVED 2026-08-06: DISTRICT_NAMES + districtFullName().
//
// It mapped ten Portland-area district codes to full names, and the public
// registration page was its only consumer. Two things made it wrong to keep:
//
//   1. District names now live in the org-scoped `districts` table, entered by
//      each provider and PICKED per location - so the correct name is already in
//      the database for every tenant, not just the ten codes J2S happened to use.
//   2. Jessica, 2026-08-06: "let him name his districts. parents know the acronym
//      their kid is in." A translation table silently OVERRIDES a provider's own
//      wording - it would have turned Jeff's chosen "PPS" into "Portland Public
//      Schools" without asking him.
//
// The registration page now renders `districts.name` verbatim. If a per-tenant
// display override is ever wanted, it belongs on the districts row, not in code.
export function getTenant(slug) {
  return TENANTS[slug] || null;
}

// REMOVED 2026-08-26: defaultTenantSlug() + parentLandingPath().
//
// These were the "v1 multi-tenant shims", written when Enrops had exactly one
// tenant. Both returned the FIRST KEY OF THE MAP ABOVE, which is J2S, and the
// header comment they carried said a parent->tenant lookup did not exist yet.
// That stopped being true when registration was built, and the shims quietly
// became a hardcoded tenant sitting in the routing path of an 8-org platform.
//
// What they were doing, measured on prod the day they were removed:
//
//   * parentLandingPath() sent EVERY signed-in parent to `/<j2s>` — and to the
//     public catalogue at that, not the family dashboard. 192 parents resolve to
//     a registration; 79 of them belong to a provider that is not J2S. Those 79
//     were being shown another company's storefront.
//   * AdminOverview and AdminLayout used defaultTenantSlug() as the fallback for
//     an org that had not loaded, so an admin of any other provider got links
//     into J2S. Both callers already had a correct tenant-neutral branch that
//     the fallback made unreachable.
//
// The replacements are not new machinery. A parent's provider is resolved from
// their own newest registration (Landing.jsx); an instructor's from their own
// instructor record, which the tenant-less /instructor route already did. Two
// earlier removals took the same shape and left the same note — see
// onboardingFetch.js and Schedule.jsx, both 2026-08-12.
//
// If something ever genuinely needs "the default tenant", it does not exist:
// ask what that code is really trying to name and resolve it from the row in
// front of it.
//
// STILL HARDCODED, DELIBERATELY: the TENANTS map above. It holds J2S's name,
// tagline, colours, fonts and support contacts, and getTenant() returns null for
// every other provider. Unpicking it touches the parent dashboard and every
// brand consumer at once, so it is parked as its own pass rather than bolted
// onto this one. It is on the board under "Parked, deliberately".
