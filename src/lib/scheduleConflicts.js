// Pure same-day scheduling logic for the after-school board.
//
// One instructor, two classes the same weekday. The rule (2026-08-18, and the DB
// trigger check_program_assignment_conflict mirrors the time test; since
// 20261027a, when both classes have session dates the trigger and the board's
// coincidence() also require a shared date):
//   - a real TIME OVERLAP is a hard conflict;
//   - an unreadable time on EITHER side is a conflict too (fail closed -- we won't
//     guess whether "2:30" is morning or afternoon; the caller passes null then);
//   - anything else is allowed here, and a gap under warnMin is a "tight"
//     turnaround worth a warning. The board ALSO applies the provider's
//     min_minutes_between_sites (20261113a) to different-school pairs as an
//     OVERRIDABLE block, using `gap` and `sameSchool` from this result; that
//     policy lives in the board, not in this truth table.
//
// Times are minutes-since-midnight, or null when unknown. Extracted so the truth
// table can be unit-tested; the board calls this per same-day class.

// The provider's cross-school minimum (organizations.min_minutes_between_sites,
// 20261113a), applied to one classifyOther() result. True only for a pair that is
// readable, does NOT overlap (an overlap is already the hard conflict), is at a
// different site - or the class being placed has no site, so we cannot prove it
// is one building - and is closer than minGap. 0 turns the rule off.
// match-afterschool's wouldConflict applies the same rule as a hard block; keep
// the two in step (supabase/functions/_shared/siteGap.ts).
export function tooCloseBetweenSites(cls, targetLoc, minGap) {
  if (!(minGap > 0)) return false;
  if (cls.conflict || cls.gap == null) return false;
  const differentSite = !cls.sameSchool || targetLoc == null;
  return differentSite && cls.gap < minGap;
}

export function classifyOther(target, other, warnMin) {
  const unknown =
    target.start == null || target.end == null ||
    other.start == null || other.end == null;
  const sameSchool = (other.loc ?? null) === (target.loc ?? null);
  const overlaps = !unknown && target.start < other.end && other.start < target.end;
  // Minutes between the two, whichever runs first. Only meaningful when both are
  // readable and they don't overlap (>= 0 there); null otherwise.
  const gap = unknown
    ? null
    : (other.start >= target.end ? other.start - target.end : target.start - other.end);
  const tight = !unknown && !overlaps && gap < warnMin;
  return { unknown, sameSchool, overlaps, gap, tight, conflict: unknown || overlaps };
}
