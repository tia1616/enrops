// The one rule for turning a class's registration counts into the two things the
// programs page shows: the headline enrolled number, and the quiet line under it.
//
// Extracted 2026-08-27 when the waiting count was added, because that count made
// the rule worth stating out loud: THREE of these four numbers are not seats, and
// exactly one pair of them is. Inline in the component it was four ifs nobody
// could test; here the invariant is pinned.
//
// The counts come from ProgramsCalendar's loader:
//   paid    - registration is paid for
//   unpaid  - confirmed but on installments (a real seat, e.g. a year-long bundle)
//   pending - checkout started and never finished
//   waiting - on the waiting list, no seat at all
//
// A tolerant shape on purpose: a class nobody has touched has no entry in the map,
// and a waiting count that failed to load leaves that one key absent while the
// others are fine. Neither may render "NaN".

const n = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Seats actually committed.
 *
 * PAID + INSTALLMENTS, and nothing else. Pending is a checkout that has not
 * happened; waiting is a family with no place. Adding either here would inflate
 * the fill bar, flip a class to "full" early, and - via the same number - tell an
 * operator a class is closed when a seat is genuinely free.
 */
export function enrolledSeats(enr) {
  return n(enr?.paid) + n(enr?.unpaid);
}

/**
 * The quiet line under the count: "12 paid · 2 on installments · +1 pending · 6 waiting".
 *
 * Each part appears only when it is non-zero, so a full and settled class shows
 * just "14 paid" rather than three zeroes. Order is deliberate: the two that ARE
 * seats first, then the two that are not, with waiting last because it is the
 * only one describing people who are not in the class at all.
 */
export function enrollmentBreakdown(enr) {
  const parts = [];
  if (n(enr?.paid) > 0) parts.push(`${n(enr.paid)} paid`);
  if (n(enr?.unpaid) > 0) parts.push(`${n(enr.unpaid)} on installments`);
  if (n(enr?.pending) > 0) parts.push(`+${n(enr.pending)} pending`);
  if (n(enr?.waiting) > 0) parts.push(`${n(enr.waiting)} waiting`);
  return parts.join(" · ");
}
