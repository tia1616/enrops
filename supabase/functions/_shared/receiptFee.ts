// receiptFee — the enrops service fee a family actually paid, for their receipt.
//
// Money layer (17 Sept 2026) section 4: the receipt shows "Program price,
// enrops service fee, bank payment discount if used, total paid".
//
// DERIVED FROM WHAT WAS CHARGED, NOT RECOMPUTED FROM CONFIG. A receipt is a
// record of what happened, not a fresh calculation of what should have
// happened. Recomputing from the org's rates could print a fee different from
// the one the family was charged - if the config changed between checkout and
// the webhook, or if the rail is misread - and that is the one thing a receipt
// may never do. Deriving it also needs no config lookup and no card-vs-bank
// branch: whatever rail they used, this is the figure they paid.
//
// It has the useful property of making the receipt ADD UP by construction,
// which is the actual defect this closes. Before it, a pass-through family saw
// line items that summed to less than "Total paid" with nothing explaining the
// difference, and the first assumption a parent makes about that is an
// overcharge.

export interface ReceiptFeeInput {
  /** Stripe's session.amount_total - everything the family was charged. */
  amountTotalCents: number;
  /** The registration rows on this session, summed. */
  registrationSubtotalCents: number;
  /** Any scholarship gift, including a fee the family chose to cover on it. */
  giftTotalCents?: number;
}

export interface ReceiptFeeResult {
  /** Cents to show as the enrops service fee. 0 means show no row. */
  feeCents: number;
  /**
   * Set when the numbers cannot be explained as a fee. The caller logs it;
   * the receipt shows no fee row rather than a nonsense one.
   */
  anomaly: string | null;
}

/**
 * What to put on the receipt's service-fee line.
 *
 * THE ASSUMPTION, STATED SO IT CAN BE CHECKED: a checkout session contains the
 * registration rows, the pass-through fee line, and the gift. Nothing else. If
 * a future release adds another Stripe line item to this session, it lands in
 * this residual and would be labelled a service fee - so anything added there
 * must be subtracted here too. `anomaly` exists so that day is noisy rather
 * than silent.
 */
export function receiptFeeCents(input: ReceiptFeeInput): ReceiptFeeResult {
  const total = Number(input.amountTotalCents);
  const regs = Number(input.registrationSubtotalCents);
  const gift = Number(input.giftTotalCents ?? 0);

  // Any of these arriving unusable means we do not know what was charged, and
  // a receipt that guesses is worse than one that stays quiet.
  if (!Number.isFinite(total) || !Number.isFinite(regs) || !Number.isFinite(gift)) {
    return { feeCents: 0, anomaly: 'non-numeric amounts' };
  }

  const residual = total - regs - gift;

  // NEGATIVE means the total is SMALLER than its own line items. No fee can
  // explain that, so it is never a fee - it is a discount, a partial capture,
  // or a bug. Show nothing and say so.
  if (residual < 0) {
    return {
      feeCents: 0,
      anomaly: `negative residual: total ${total} - regs ${regs} - gift ${gift} = ${residual}`,
    };
  }

  // An absorb org: the family paid exactly their line items. Correct and
  // unremarkable, so no anomaly and no row.
  if (residual === 0) return { feeCents: 0, anomaly: null };

  // A fee larger than the registrations it is charged on is not impossible -
  // the $1.99 minimum on a $1 line exceeds it - so this cannot be an error.
  // But an order of magnitude out is worth saying out loud while still showing
  // the number, because the receipt has to add up either way and the family is
  // owed the arithmetic they can see.
  const anomaly = regs > 0 && residual > regs
    ? `residual ${residual} exceeds the registrations it is charged on (${regs}) - check for an unaccounted line item`
    : null;

  return { feeCents: residual, anomaly };
}
