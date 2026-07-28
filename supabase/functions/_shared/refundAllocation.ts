// refundAllocation — split ONE Stripe refund across the registrations the
// charge actually paid for.
//
// WHY THIS EXISTS. Refunds started inside Enrops are already per-registration:
// refund-registration walks PaymentIntent slots and issues a separate Stripe
// refund for each one. Refunds started in the OPERATOR's own Stripe dashboard
// are not — Arielle's v4 section 3 — because the operator sees a charge, not our
// registrations, and a charge routinely covers a multi-child cart or an
// aggregated installment. So one refund id has to be attributed back across
// several registrations before it can be recorded or have our fee prorated.
//
// The split is by what each registration contributed to the charge. Largest
// remainder, so the parts sum to EXACTLY the refunded amount: a naive round()
// per slice loses or invents a cent, and a lost cent here means our records
// disagree with Stripe forever on a money table.

export interface RefundSlice {
  registrationId: string;
  /** What this registration contributed to the charge, in cents. */
  baseCents: number;
}

export interface AllocatedSlice {
  registrationId: string;
  amountCents: number;
}

/**
 * Allocate refundAmountCents across slices in proportion to baseCents.
 *
 * Returns [] for a non-positive refund or when nothing has a positive base
 * (callers must not invent an attribution they cannot justify). Slices that
 * round to 0 are dropped, so no zero-amount rows are written — refunds.amount_cents
 * carries CHECK (amount_cents > 0) and a 0 would fail the insert.
 */
export function allocateRefundAcrossRegistrations(
  refundAmountCents: number,
  slices: RefundSlice[],
): AllocatedSlice[] {
  if (!(refundAmountCents > 0)) return [];
  const usable = (slices || []).filter((s) => s && s.baseCents > 0);
  if (usable.length === 0) return [];

  const totalBase = usable.reduce((sum, s) => sum + s.baseCents, 0);
  if (!(totalBase > 0)) return [];

  // Single registration: hand it the whole amount rather than round-tripping
  // through the proportional maths, which can only introduce drift.
  if (usable.length === 1) {
    return [{ registrationId: usable[0].registrationId, amountCents: refundAmountCents }];
  }

  const exact = usable.map((s) => ({
    registrationId: s.registrationId,
    ideal: (refundAmountCents * s.baseCents) / totalBase,
  }));

  const floored = exact.map((e) => ({
    registrationId: e.registrationId,
    amountCents: Math.floor(e.ideal),
    remainder: e.ideal - Math.floor(e.ideal),
  }));

  // Hand the leftover cents to the largest remainders first.
  let leftover = refundAmountCents - floored.reduce((sum, f) => sum + f.amountCents, 0);
  const byRemainder = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < byRemainder.length && leftover > 0; i++) {
    byRemainder[i].amountCents += 1;
    leftover -= 1;
  }

  return floored
    .filter((f) => f.amountCents > 0)
    .map((f) => ({ registrationId: f.registrationId, amountCents: f.amountCents }));
}
