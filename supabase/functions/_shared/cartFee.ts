// cartFee — the enrops service fee is charged PER REGISTRATION LINE, and a
// cart is the sum of its lines. Never one fee on the cart total.
//
// WHY THIS EXISTS, AND WHY IT REVERSES A DELIBERATE DECISION.
//
// Until now the fee was computed once against the cart total, and that was a
// considered choice, written down in three places. The reasoning was sound as
// far as it went: `process-installments` has to agree with `create-checkout`
// about what charge 1 costs, and capping the cart in both was the simplest way
// to make them agree.
//
// The money layer (17 Sept 2026) section 4 settles it the other way, twice:
//
//   "$1.99 minimum, $14.99 card maximum, $9.99 bank maximum, applied to the
//    line, not the cart."
//   "No cart-level maximum. Six children at $228 shows $6.84 six times, not
//    $41.04 once."
//
// It matters in both directions and the floor is the uglier one. A cart-level
// ceiling means a family registering six children pays ONE ceiling instead of
// six fees, so enrops earns almost nothing on the largest carts. A cart-level
// FLOOR means three small add-ons collect one $1.99 instead of three - and the
// same rule, read the other way, would charge a single $10 drop-in the same
// $1.99 whether it is bought alone or in a basket of five. A fee that changes
// depending on what else is in the basket cannot be explained to a parent in
// one sentence, which is the test section 6 sets for the bundle rules.
//
// THE AGREEMENT PROBLEM DOES NOT COME BACK. It gets simpler. Each registration
// now carries its own fee, split across its OWN installments, so charge 1 and
// charges 2/3 agree by construction instead of by a shared cart calculation
// that both sides had to reproduce. There is no cross-registration allocation
// left to keep in step.
//
// NOTHING CHANGES FOR AN ORG WHOSE CLAMPS DO NOT BIND. With no floor and no
// real ceiling - which is every org on the old 1% pricing, J2S and The Ukulele
// Project included - the sum of the line fees equals the fee on the total to
// within the rounding of a cent per line. The behaviour only diverges where a
// floor or ceiling actually applies, which is exactly where the doc says the
// old answer was wrong.

import { computePlatformFee, PaymentMethodType, PlatformFeeConfig } from './computePlatformFee.ts';
import { allocateFeeAcrossInstallments } from './feeAllocation.ts';

/** One registration in a cart, at the amount the SERVER holds for it. */
export interface CartLine {
  registrationId: string;
  amountCents: number;
}

/**
 * The fee each line carries, in the order given.
 *
 * Every line is clamped on its own, which is the whole point: the floor and
 * the ceiling are properties of a registration, not of a basket.
 */
export function feePerLine(
  lines: CartLine[],
  paymentMethod: PaymentMethodType,
  org: PlatformFeeConfig,
): number[] {
  return lines.map((l) => computePlatformFee(l.amountCents, paymentMethod, org));
}

/**
 * What the cart owes in total: the sum of the line fees.
 *
 * Deliberately NOT `computePlatformFee(sumOfLines, ...)`. That is the defect
 * this module exists to remove, and the two are indistinguishable on any cart
 * of one line, which is how it survived this long.
 */
export function cartFeeCents(
  lines: CartLine[],
  paymentMethod: PaymentMethodType,
  org: PlatformFeeConfig,
): number {
  return feePerLine(lines, paymentMethod, org).reduce((s, f) => s + f, 0);
}

/** One scheduled charge: which registration it belongs to, and for how much. */
export interface ScheduleRow {
  /** Caller's own identifier for this row, returned as the map key. */
  id: string;
  registrationId: string;
  installmentNumber: number;
  amountCents: number;
}

/**
 * Split each registration's fee across that registration's own installments.
 *
 * Returns a map from the caller's row id to the fee that row carries. The
 * shares for one registration sum EXACTLY to that registration's fee, so a
 * family is never quoted one number and charged another.
 *
 * ORDERING IS BY INSTALLMENT NUMBER, WITHIN A REGISTRATION. The leftover cent
 * goes onto the earliest installment, because that is the one the family sees
 * and consents to on screen; charges 2 and 3 are off-session and must never
 * come out higher than what was displayed at signup. That rule is
 * feeAllocation's, and it is inherited rather than restated here.
 *
 * A row whose registration has no fee gets 0, never undefined - a caller
 * reading a missing key as 0 and a caller treating it as an error would
 * disagree about money, so there is nothing to disagree about.
 */
export function allocateCartFeeByLine(
  rows: ScheduleRow[],
  paymentMethod: PaymentMethodType,
  org: PlatformFeeConfig,
): Map<string, number> {
  const byRegistration = new Map<string, ScheduleRow[]>();
  for (const row of rows) {
    const existing = byRegistration.get(row.registrationId);
    if (existing) existing.push(row);
    else byRegistration.set(row.registrationId, [row]);
  }

  const shares = new Map<string, number>();
  for (const regRows of byRegistration.values()) {
    // Sorted on a COPY. Callers hand us their own array and several of them
    // iterate it again afterwards in their own order; re-ordering it under
    // them would move which charge the leftover cent lands on.
    const ordered = regRows.slice().sort(
      (a, b) => a.installmentNumber - b.installmentNumber || a.id.localeCompare(b.id),
    );
    const registrationTotal = ordered.reduce((s, r) => s + Math.max(0, r.amountCents), 0);
    const registrationFee = computePlatformFee(registrationTotal, paymentMethod, org);
    const allocated = allocateFeeAcrossInstallments(
      registrationFee,
      ordered.map((r) => r.amountCents),
    );
    ordered.forEach((r, i) => shares.set(r.id, allocated[i]));
  }

  return shares;
}
