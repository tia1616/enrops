// Pure same-day scheduling logic for the after-school board.
//
// One instructor, two classes the same weekday. The rule (2026-08-18, and the DB
// trigger check_program_assignment_conflict mirrors it exactly):
//   - a real TIME OVERLAP is a hard conflict;
//   - an unreadable time on EITHER side is a conflict too (fail closed -- we won't
//     guess whether "2:30" is morning or afternoon; the caller passes null then);
//   - anything else is allowed, and a gap under warnMin is a "tight" turnaround
//     worth a warning but never a block.
//
// Times are minutes-since-midnight, or null when unknown. Extracted so the truth
// table can be unit-tested; the board calls this per same-day class.

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
