// What this provider calls the places they run programs in.
//
// WHY THIS EXISTS. Operators who go to schools say "site" or "school site" — the ICP
// vocabulary guide rules out "location", "venue" and "branch" for them. Operators who
// own a studio or gym genuinely do have a "location". The platform already models the
// difference: organizations.venue_answer is 'goes_to_sites' | 'own_space' | 'both'
// (or null before onboarding answers it).
//
// The logic was already correct in QuickProgramBuilder and hardcoded there inline, in
// several places, while the venue directory said "location" unconditionally. So the
// same provider could be offered "Add a site" on one screen and "Add a location" on
// another, for the same action. One function so those cannot drift again.
//
// NOT IN SCOPE HERE, deliberately: the nav item and the page title both read
// "Locations" for every venue model. That is Jessica's explicit 2026-08-05 decision
// (AdminLayout.jsx and SchoolsLocations.jsx both carry the note) — it replaced a
// conditional label that had sent a provider hunting for the district field under a
// word he did not associate with places. Changing it is her call, not a cleanup.

// QuickProgramBuilder is NOT converted to these helpers yet, on purpose. It reads
// `profile.venue_answer` (the operator's live, possibly-unsaved onboarding answer)
// rather than `org`, which is correct there — and its two call sites disagree about
// 'both': line ~1603 uses `=== 'goes_to_sites'` (so a 'both' org reads "Location *")
// while line ~1696 includes 'both' (so the same org reads "Add a site"). Routing both
// through goesToSites() would silently change what a 'both' org sees. That is a
// deliberate decision for Jessica, not a refactor to slip in. These helpers accept any
// object with a `venue_answer` field, so `venueWord(profile)` will work when she rules
// on it.

const GOES_TO_SITES = 'goes_to_sites';
const BOTH = 'both';

// Does this provider travel to venues they do not own? 'both' counts, matching the
// existing QuickProgramBuilder test exactly. A null venue_answer (onboarding not
// answered yet) falls through to "site", because going to school sites is the ICP and
// the platform is built for it.
export function goesToSites(org) {
  const a = org?.venue_answer ?? null;
  if (a === null) return true;
  return a === GOES_TO_SITES || a === BOTH;
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
// "Site name *", "Location name *". Kept as its own function rather than
// capitalising at each call site, so nobody reaches for CSS text-transform and
// breaks it for a word that is capitalised differently later.
export function VenueWord(org) {
  return goesToSites(org) ? 'Site' : 'Location';
}

// Count phrase with correct pluralisation: "1 site", "22 sites".
export function venueCount(org, n) {
  return `${n} ${n === 1 ? venueWord(org) : venueWordPlural(org)}`;
}

// "Add a site" / "Add a location" — the button and modal heading share one string so a
// provider who clicks the button lands on a heading that repeats it back.
export function addVenueLabel(org) {
  return `Add a ${venueWord(org)}`;
}
