// src/lib/instructorPayStatus.js
//
// How an instructor's own pay screen describes the state of their money.
//
// WHY THIS IS A MODULE AND NOT THREE HELPERS AT THE BOTTOM OF InstructorPortal.jsx.
// It used to be, and it carried a bug that told every paid instructor, on every
// provider, that their money was still "Processing" -- forever:
//
//   friendlyPayStatus() switched on four statuses (pending / approved / adjusted /
//   withheld) and let `default:` catch everything else. The database CHECK allows
//   FIVE (pg_constraint session_delivery_confirmations_pay_status_check), and the
//   fifth is 'paid'. So the moment pay-instructor stamped a session paid, the label
//   fell through to the catch-all and read "Processing", with no later event able to
//   change it. On prod that was 234 of the 247 confirmation rows -- i.e. the normal
//   end state of every session anyone has ever been paid for. Found 2026-09-11 when
//   an instructor chased Jessica for money that had settled a month earlier.
//
// THE RULE THIS FILE EXISTS TO HOLD: a status the database can store must have a
// word here. Not a default. `default` is what hid the bug for the life of payouts,
// because an unknown status is indistinguishable from a deliberately-worded one.
// friendlyPayStatus() therefore returns `null` for anything it does not know, and
// the caller renders the raw value -- ugly on purpose, and visible, which is the
// whole point. Same shape as STATUS_LABEL/STATUS_COLOR in src/pages/admin/Payroll.jsx
// (`STATUS_LABEL[x] ?? x`), which already got this right on the operator side.
//
// THE TWIN: src/pages/admin/Payroll.jsx describes the SAME five statuses to the
// operator, in its own words ("Pending" / "Paid"), because the audiences differ --
// an operator reads a ledger, an instructor asks "where is my money". The WORDS are
// allowed to diverge. The SET must not. If a sixth status is ever added to the CHECK
// constraint, both places need it, and instructorPayStatus.test.mjs fails until this
// one has it.

// Every value the CHECK constraint allows. Verified against prod pg_constraint
// 2026-09-15: pending, approved, adjusted, withheld, paid.
export const PAY_STATUSES = ['pending', 'approved', 'adjusted', 'withheld', 'paid'];

// Synthetic, never stored: a group whose days do not all agree AND where at least
// one has been paid. See groupPayStatus.
export const PART_PAID = 'part_paid';

// Least-advanced first. Used ONLY to headline a group in which nothing has been
// paid yet, so that a held or still-processing day is never hidden behind a more
// advanced sibling. This is the original precedence order from the function this
// replaced, preserved deliberately: for groups with no paid day, the old behaviour
// was already right and this change must not alter it.
const LEAST_ADVANCED_FIRST = ['withheld', 'adjusted', 'pending', 'approved'];

/**
 * One badge for a group of days (a camp week, or an after-school class).
 *
 * The rule is the operator page's rule -- all-agree yields that status, otherwise
 * the group is mixed -- with one refinement the operator page does not need: an
 * instructor's question is "has my money arrived", so a mixed group splits on
 * whether ANY of it has been paid.
 *
 * Every branch must be TRUE in the state that selects it (recurring finding xii):
 *   all five days paid              -> 'paid'        "Paid"        true
 *   four paid, one withheld         -> 'part_paid'   "Part paid"   true
 *   pending + approved, none paid   -> 'pending'     "Processing"  true
 * The middle case is the one the old code got wrong in the dangerous direction: it
 * returned 'withheld' and told an instructor that a week they had been paid $320 for
 * was "Held -- contact admin".
 */
export function groupPayStatus(statuses) {
  const distinct = [...new Set((statuses ?? []).filter(Boolean))];

  // No rows, or every row null. Unreachable from PayView (a group exists because it
  // has confirmations) but this is the fail-safe direction: never claim paid.
  if (distinct.length === 0) return 'pending';

  if (distinct.length === 1) return distinct[0];
  if (distinct.includes('paid')) return PART_PAID;

  for (const s of LEAST_ADVANCED_FIRST) {
    if (distinct.includes(s)) return s;
  }
  // Several statuses, none of them recognised. Surface the raw value rather than
  // inventing one; friendlyPayStatus will refuse to word it and the caller shows it.
  return distinct[0];
}

const LABELS = {
  pending: { label: 'Processing', tone: 'wait' },
  adjusted: { label: 'Adjusted', tone: 'info' },
  approved: { label: 'Approved for payout', tone: 'good' },
  paid: { label: 'Paid', tone: 'paid' },
  [PART_PAID]: { label: 'Part paid', tone: 'info' },
  withheld: { label: 'Held — contact admin', tone: 'bad' },
};

/**
 * Instructor-facing wording for one status, or NULL if this module has never been
 * told about it. Null is the contract: the caller renders the raw value, so a status
 * added to the database without being added here is visible instead of silently
 * wearing some other status's word. Colour is returned as a `tone` key rather than a
 * hex value so the palette stays in the page that owns it.
 */
export function friendlyPayStatus(status) {
  return LABELS[status] ?? null;
}

/**
 * Every tone this module can hand back. The page owning the palette must have a
 * colour for each, and instructorPayStatus.test.mjs holds the two together.
 *
 * Exported because a tone with no colour fails SILENTLY and invisibly: the badge
 * renders `color: undefined` and `background: "undefined1F"`, which is not valid
 * CSS, so nothing throws and nothing logs -- an unstyled badge is the only sign.
 * That is a second pair of maps that must agree, which is the exact shape of the
 * bug this file was written to fix, so it gets a gate rather than a convention.
 */
export const PAY_TONES = [...new Set(Object.values(LABELS).map((l) => l.tone))];

/**
 * Which total a row's money belongs under. The four buckets are disjoint and cover
 * every status, so the buckets always sum to the headline total.
 *
 * Anything unrecognised lands in 'processing', not 'paid': if this module is ever
 * out of date, the failure is an instructor told their money is still coming when it
 * has arrived (they ask, and are told good news) rather than told it has arrived
 * when it has not (they stop chasing money they are owed).
 */
export function payStage(status) {
  if (status === 'paid') return 'paid';
  if (status === 'approved') return 'approved';
  if (status === 'withheld') return 'held';
  return 'processing';
}

/**
 * Which total the distance bonus belongs under.
 *
 * The bonus has its OWN truth -- `distance_bonus_paid_at` on camp_assignments /
 * program_assignments, stamped by pay-instructor and cleared again by
 * handleTransferReversed when a transfer is reversed. It must NOT be inferred from
 * the day rows: a camp's bonus rides one payout while its days are paid separately,
 * so the two genuinely disagree in normal operation (recurring finding xiv -- a
 * number that appears in two places must be computed in one).
 *
 * Unpaid, on a group that is entirely withheld, is 'held' -- that money is not
 * coming. Unpaid otherwise is 'processing'.
 */
export function distanceBonusStage(paidAt, groupStatus) {
  if (paidAt) return 'paid';
  if (groupStatus === 'withheld') return 'held';
  return 'processing';
}

export function emptyStages() {
  return { processing: 0, approved: 0, paid: 0, held: 0 };
}
