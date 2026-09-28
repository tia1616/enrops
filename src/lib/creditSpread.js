// How a family's account credit is spread across the lines of a cart, on the
// CLIENT - so the Review step and the Pay step quote the same figure, and both
// quote the figure create-checkout will actually charge.
//
// WHY THIS IS SHARED RATHER THAN INLINE. It began inline in StepPay, and the
// step BEFORE it went on showing a total with no credit in it at all: a family
// holding $240 looking at a $10 class was quoted $10.10 on Review and charged
// $0.00. Two screens in one flow disagreeing about what someone owes is worse
// than either being wrong on its own, because the family cannot tell which to
// believe. One implementation, both callers.
//
// IT MIRRORS THE SERVER, and the mirroring is the whole contract:
// create-checkout fills greedily in `registration_ids` order, and
// create-registration pushes those ids in cart order - the same order
// pricing.lines is built in. src/lib/creditQuoteParity.test.mjs pins that the
// two agree, at a fee config where the split actually changes the answer.

/**
 * Per-line amounts after credit, in the order given.
 *
 * @param {number[]} grossLineAmounts  per-registration prices, in cents, in CART order
 * @param {number}   creditCents       the family's spendable balance, in cents
 * @returns {{ lineAmounts: number[], creditApplied: number }}
 */
export function spreadCreditAcrossLines(grossLineAmounts, creditCents) {
  const gross = (grossLineAmounts || []).map((a) => Math.max(0, Math.floor(Number(a) || 0)));
  const total = gross.reduce((s, a) => s + a, 0);
  // Never more than the cart costs, and never negative - a bad balance quotes
  // full price rather than throwing in the middle of a checkout.
  const available = Number.isFinite(creditCents) && creditCents > 0
    ? Math.min(Math.floor(creditCents), total)
    : 0;

  let left = available;
  const lineAmounts = gross.map((a) => {
    const take = Math.min(a, left);
    left -= take;
    return a - take;
  });
  return { lineAmounts, creditApplied: available };
}
