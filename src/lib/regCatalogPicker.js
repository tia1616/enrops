// The public registration catalog's district -> school picker, as a pure function.
//
// WHY THIS IS A MODULE AND NOT INLINE IN portal/Home.jsx. It shipped to prod on
// 2026-08-14 with ZERO test coverage, because the logic lived inside the page
// component and nothing could import it. Everything it does was proven by
// driving a browser, which is strong evidence about that day and no evidence at
// all about the next person to touch it. Jessica: "should have done this before
// shipping."
//
// Everything here is deliberately data-in / data-out: no React, no Supabase, no
// DOM. The component decides how to draw the result; this decides what the
// result IS.

// Catch-all bucket for venues with no public district (private/charter schools,
// libraries, parks and rec, community sites). Keeps them on the reg page instead
// of hidden, and stops each one rendering as its own one-school "district".
// On prod today this holds exactly one live venue: J2S's Multnomah County
// Library - Capitol Hill, which correctly has no school district.
export const OTHER_DISTRICT = 'Other schools & sites';

const byName = (a, b) => a.name.localeCompare(b.name);

// Distinct locations among the open programs, in the shape the school select
// needs.
//
// KEYED ON LOCATION ID, NOT NAME. Two real locations can share a name: staging
// riverbend has two rows both called "Ainsworth Elementary School", one in PPS
// and one with no district. Keying on the name collapses them into a single
// option that filters by name and so shows BOTH locations' classes, and under
// grouping the same label can appear beneath two different district headings
// with no way to tell them apart.
//
// `districtNames` is id -> name, from the districts_public view. A district
// whose name is missing from that map falls into OTHER_DISTRICT. That is the
// signalled failure mode of the read, not a normal case - see
// 20260814k_districts_public_view.sql.
export function buildLocationOptions(openPrograms, districtNames = {}) {
  const seen = new Set();
  const out = [];
  for (const p of openPrograms || []) {
    const id = p?.program_location_id;
    const name = p?.program_locations?.name;
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const districtId = p.program_locations?.district_id;
    out.push({ id, name, district: (districtId && districtNames[districtId]) || OTHER_DISTRICT });
  }
  return out;
}

// Named districts alphabetically; the undistricted bucket always LAST, so it
// reads as a remainder rather than competing with real district names.
export function groupByDistrict(locOptions) {
  const groups = new Map();
  for (const loc of locOptions) {
    if (!groups.has(loc.district)) groups.set(loc.district, []);
    groups.get(loc.district).push(loc);
  }
  for (const list of groups.values()) list.sort(byName);

  const named = [...groups.keys()].filter((d) => d !== OTHER_DISTRICT).sort((a, b) => a.localeCompare(b));
  const groupNames = groups.has(OTHER_DISTRICT) ? [...named, OTHER_DISTRICT] : named;
  return { groups, groupNames, namedCount: named.length };
}

// The whole view model the catalog renders from.
//
// `selection` is { district, school } - the district NAME and the location ID
// the family has picked, both '' when they have picked nothing.
export function buildCatalogPicker(openPrograms, districtNames, selection = {}) {
  const all = openPrograms || [];
  const locOptions = buildLocationOptions(all, districtNames);
  const { groups, groupNames, namedCount } = groupByDistrict(locOptions);

  // Nothing to choose between = do not ask. A single-site provider is gate-free.
  const hasMultiLoc = locOptions.length >= 2;

  // A district STEP only when it groups something. With one district or none it
  // is a dropdown with a single answer, so the page shows the school select
  // alone - the school gate still applies.
  const useGroups = namedCount >= 2;

  // An unknown school id is treated as NOTHING PICKED, deliberately.
  //
  // It means the selection did not come from this catalog: the commonest source
  // is the page keeping state across a change of provider (this component does
  // not remount when the :slug route param changes), and the next is a
  // hand-edited value. Honouring it would make schoolChosen true and filter the
  // list to zero, so a provider with a full catalog would render "No classes at
  // that school right now." Falling back to the picker is both truthful and
  // recoverable. Home.jsx ALSO clears the picker when it loads a new provider;
  // this is the second line of that defence, not a replacement for it.
  const school = locOptions.some((l) => l.id === selection.school) ? selection.school : '';

  // Same treatment for a district that is not on offer.
  const district = groups.has(selection.district) ? selection.district : '';

  const schoolChoices = useGroups
    ? (groups.get(district) || [])
    : [...locOptions].sort(byName);

  // THE GATE: no school chosen means no classes, so the first screen can never
  // lead with a price from a district the family is not in.
  const schoolChosen = !hasMultiLoc || !!school;
  const visiblePrograms = !hasMultiLoc
    ? all
    : (school ? all.filter((p) => p.program_location_id === school) : []);

  return {
    locOptions,
    groups,
    groupNames,
    hasMultiLoc,
    useGroups,
    // Echoed back so the component renders the SANITISED selection rather than
    // the raw one - a select whose value is not among its options renders blank
    // and disagrees with the list beneath it.
    district,
    school,
    schoolChoices,
    schoolChosen,
    visiblePrograms,
  };
}
