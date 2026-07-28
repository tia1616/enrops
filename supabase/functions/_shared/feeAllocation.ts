// feeAllocation — the platform fee is capped PER REGISTRATION, not per charge.
//
// WHY THIS EXISTS. computePlatformFee applies the org's floor and cap to
// whatever amount it is handed. Handed an installment, it caps that
// installment. With a $7.99 cap that means a family who splits a $500 program
// into three payments pays 3 x $5.00 = $15.00, while the same family paying up
// front pays the capped $7.99. The payment plan is chosen by the families least
// able to absorb an extra $7, so charging them nearly double for it is exactly
// backwards. Jessica, 2026-07-27: "$7.99 per reg".
//
// So the fee is computed ONCE against the registration total and then split
// across the installments. Below the cap nothing changes at all: 3% of $240 is
// $7.20 whether you take 3% of the whole or 3% of each third.
//
// Pay-in-full is untouched — one charge already means one cap.

/**
 * Split a registration-level fee across installments.
 *
 * Allocated in proportion to each installment's amount so a lopsided schedule
 * (charge 1 larger than 2 and 3) carries a proportionate share, with every
 * leftover cent pushed onto the FIRST installment. Front-loading the remainder
 * is deliberate: charge 1 happens at checkout where the family sees the exact
 * total before consenting, whereas 2 and 3 are off-session and should never
 * come out a cent higher than what was displayed at signup.
 *
 * Returns an array the same length as `amounts` that sums EXACTLY to
 * totalFeeCents (never more, never less) so the fee the family was quoted is
 * the fee actually collected.
 */
export function allocateFeeAcrossInstallments(
  totalFeeCents: number,
  amounts: number[],
): number[] {
  if (!amounts.length) return [];
  if (!(totalFeeCents > 0)) return amounts.map(() => 0);

  const sum = amounts.reduce((s, a) => s + Math.max(0, a), 0);
  // Degenerate schedule (all zeros): put the whole fee on the first slot rather
  // than dividing by zero or silently dropping it.
  if (sum <= 0) return amounts.map((_, i) => (i === 0 ? totalFeeCents : 0));

  const shares = amounts.map((a) =>
    Math.floor((totalFeeCents * Math.max(0, a)) / sum),
  );
  const allocated = shares.reduce((s, v) => s + v, 0);
  shares[0] += totalFeeCents - allocated; // remainder onto charge 1

  return shares;
}
