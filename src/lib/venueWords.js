// What this provider calls the places they run programs in.
//
// WHY THIS EXISTS. Operators who go to schools say "site" or "school site" — the ICP
// vocabulary guide rules out "location", "venue" and "branch" for them. Operators who
// own a studio or gym genuinely do have a "location".
//
// KEYED ON venue_model, NOT venue_answer. This matters and I got it wrong first time:
//   * organizations.venue_model ('own_venue' | 'partner_venues') is the single source
//     of truth for the venue TYPE — see the 20260706 migration and the header of
//     SchoolsLocations.jsx, which uses it to choose which component even renders
//     (LocationsList for own_venue, SchoolsList for partner_venues).
//   * organizations.venue_answer ('goes_to_sites' | 'own_space' | 'both') is the
//     ONBOARDING question. It can DISAGREE with venue_model: Riverbend on staging has
//     venue_answer='goes_to_sites' but venue_model='own_venue'.
// Keying the noun off venue_answer would therefore have labelled the own-venue page
// "site" for Riverbend while it rendered the own-venue component. Follow venue_model,
// so the word always matches the surface the operator is actually looking at.
//
// The logic was already right in QuickProgramBuilder and hardcoded there inline, in
// several places, while the venue directory said "location" unconditionally — so the
// same provider could be offered "Add a site" on one screen and "Add a location" on
// another, for the same action. One function so those cannot drift again.
//
// QuickProgramBuilder is NOT converted to these helpers, on purpose. It reads
// `profile.venue_answer` — the operator's live, possibly-unsaved onboarding answer —
// which is correct there, because the label has to react before the row is saved. Its
// two call sites also disagree about 'both' (one excludes it, one includes it), so
// routing them through one helper would silently change what a 'both' org sees. That
// is a decision for Jessica, not a refactor to slip in.
//
// NOT IN SCOPE HERE, deliberately: the nav item and the page title both read
// "Locations" for every venue model. That is Jessica's explicit 2026-08-05 decision
// (AdminLayout.jsx and SchoolsLocations.jsx both carry the note) — it replaced a
// conditional label that had sent a provider hunting for the district field under a
// word he did not associate with places. Changing it is her call.

const OWN_VENUE = 'own_venue';

// Does this provider run programs at places they do not own? Everything that is not
// explicitly own_venue counts, including a null venue_model (not yet set), because
// going to school sites is the ICP and the platform is built for it.
export function goesToSites(org) {
  return org?.venue_model !== OWN_VENUE;
}

// Singular noun, lowercase, for mid-sentence use: "Add a ___".
export function venueWord(org) {
  return goesToSites(org) ? 'site' : 'location';
}

// Plural, lowercase: "No ___ yet".
export function venueWordPlural(org) {
  return goesToSites(org) ? 'sites' : 'locations';
}

// Capitalised singular, for a field label or the start of a sentence:
// "Site name *", "Location name *". Its own function rather than capitalising at each
// call site, so nobody reaches for CSS text-transform and breaks a word that needs
// different casing elsewhere.
export function VenueWord(org) {
  return goesToSites(org) ? 'Site' : 'Location';
}

// Count phrase with correct pluralisation: "1 site", "22 sites".
export function venueCount(org, n) {
  return `${n} ${n === 1 ? venueWord(org) : venueWordPlural(org)}`;
}

// "Add a site" / "Add a location" — the button and the modal heading share one string,
// so a provider who clicks the button lands on a heading that repeats it back.
export function addVenueLabel(org) {
  return `Add a ${venueWord(org)}`;
}
