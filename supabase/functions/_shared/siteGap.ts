// Same-day clash test for one instructor's two classes, with travel time between
// DIFFERENT sites (organizations.min_minutes_between_sites, 20261113a).
//
//   - Same site: plain overlap. Touching times (2:00-3:25 then 3:25-4:25) are
//     fine - one building, the pairing operators run on purpose.
//   - Different site, or a side with no site (we cannot prove one building):
//     each side is widened by gapMin, so 1:35-2:35 at one school and 2:35 at
//     another clash when gapMin > 0.
//
// Times are minutes since midnight and must already be readable; the caller
// fails closed on an unreadable time before calling this. The board applies the
// same rule as an OVERRIDABLE block via src/lib/scheduleConflicts.js
// tooCloseBetweenSites() - keep the two in step.
export function clashesWithSiteGap(
  a: { start: number; end: number; locationId: string | null },
  b: { start: number; end: number; locationId: string | null },
  gapMin: number,
): boolean {
  const sameSite = a.locationId != null && a.locationId === b.locationId;
  const gap = sameSite ? 0 : Math.max(0, gapMin);
  return a.start < b.end + gap && b.start < a.end + gap;
}
