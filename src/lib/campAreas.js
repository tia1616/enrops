// Where a camp is, for a family who reached it without picking a school.
//
// Camps are deliberately not school-bound, so on the registration page nothing
// above a camp card says where it runs. J2S sells winter camps in Vancouver,
// Camas, Beaverton, Hillsboro and Happy Valley from one list, and a family read
// "Marshall Community Center" with no idea which city that is (Jessica,
// 2026-10-19: the camps page "doesn't say where the camps are").
//
// Two answers, used by BOTH registration layouts so they cannot drift:
//   - groupCampsByArea: the list split under one heading per city (`area`)
//   - campWhereLabel:   the line on each card - the venue, then its address

// The heading for camps whose venue has no city set. Only ever shown when some
// OTHER camp does have one - otherwise these camps would sit, unlabelled, under
// the last city's heading and read as being in that city.
export const NO_AREA_HEADING = 'Other locations';

// camps: programs carrying program_locations.area. Order WITHIN a city is kept
// exactly as given (the caller has already sorted by start date). Cities are
// alphabetical, the no-city group last. When no camp has a city at all, there
// is one group with no heading, so a provider who never set areas sees the
// list exactly as before.
export function groupCampsByArea(camps) {
  const list = camps ?? [];
  const byArea = new Map();
  const noArea = [];
  for (const p of list) {
    const area = (p?.program_locations?.area ?? '').trim();
    if (!area) { noArea.push(p); continue; }
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(p);
  }
  if (byArea.size === 0) return list.length ? [{ key: 'all', heading: null, items: list }] : [];
  const groups = [...byArea.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((area) => ({ key: `area:${area}`, heading: area, items: byArea.get(area) }));
  if (noArea.length) groups.push({ key: 'area:none', heading: NO_AREA_HEADING, items: noArea });
  return groups;
}

// "Marshall Community Center, 1009 E McLoughlin Blvd, Vancouver, WA 98663".
// Either half alone when the other is missing; null when neither is set, so the
// card renders no empty line.
export function campWhereLabel(program) {
  const loc = program?.program_locations;
  const name = (loc?.name ?? '').trim();
  const address = (loc?.address ?? '').trim();
  const parts = [name, address].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
