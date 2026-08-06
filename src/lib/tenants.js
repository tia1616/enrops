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

// === v1 multi-tenant shims ===========================================
// Today Enrops has exactly one tenant (J2S). Several places in the app
// need to know "which tenant does this parent belong to?" but we don't
// yet have a parent->tenant lookup table (registrations live under each
// tenant's own surfaces and there's no global mapping).
//
// These helpers return the single-tenant defaults so callers don't have
// to hardcode 'j2s' inline. When tenant #2 onboards, the bodies here
// switch to real DB lookups (probably `select organization_id from
// registrations where parent_auth_user_id = $1` or similar) and every
// caller picks up the new behavior for free.

/**
 * The default tenant slug for v1 routing decisions (parent landing,
 * registration entry, etc.). Returns the only configured tenant today.
 */
export function defaultTenantSlug() {
  const keys = Object.keys(TENANTS);
  return keys[0] ?? null;
}

/**
 * Parent-portal landing path for a signed-in user. v1: always the
 * default tenant's /<slug> URL. v2+: query parent->tenant mapping by
 * userId.
 */
// eslint-disable-next-line no-unused-vars
export function parentLandingPath(userId) {
  const slug = defaultTenantSlug();
  return slug ? `/${slug}` : '/';
}
