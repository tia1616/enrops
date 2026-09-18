// The enrops service fee, as families see it.
//
// This mirrors the server's computePlatformFee EXACTLY:
//     clamp(round(amount * rate), floor, cap)
// applied only when the operator passes the fee on, a rate is set, and the
// amount is positive. Any drift between this and the server shows up as a
// number on screen that doesn't match the number Stripe charges, which is the
// single fastest way to lose a family's trust at the last step.
//
// It exists as a shared helper because the same figure now appears in two
// places - on the class card before anyone commits to anything, and again at
// the Pay step - and a money calculation written twice eventually becomes two
// different calculations.
//
// Config comes from the org-fee-config edge function, never from the public org
// view, which deliberately excludes the fee columns.

/**
 * Fee in cents for a given amount.
 * @param {number} cents      amount being charged, in cents
 * @param {object} cfg        org fee config from org-fee-config
 * @param {object} [opts]
 * @param {boolean} [opts.isBank]  true for ACH, which has its own rate
 */
export function feeOnCents(cents, cfg, opts = {}) {
  if (!cfg) return 0;
  const passThrough = !!cfg.fee_pass_through;
  if (!passThrough) return 0;

  const rate = opts.isBank
    ? Number(cfg.platform_fee_ach_pct) || 0
    : Number(cfg.platform_fee_card_pct) || 0;
  if (!(rate > 0) || !(cents > 0)) return 0;

  const floor = Number(cfg.platform_fee_floor_cents) || 0;
  // TWO CEILINGS, ONE PER RAIL, mirroring _shared/computePlatformFee.ts.
  // platform_fee_cap_cents is the card ceiling and the default;
  // platform_fee_ach_cap_cents overrides it for bank, and null there means
  // "no bank-specific ceiling" - which is every org today.
  //
  // These numbers arrive ALREADY RESOLVED from org-fee-config: if the org's
  // negotiated terms have an end date and it has passed, that function has
  // substituted the platform defaults before sending. The expiry rule lives in
  // _shared/feeConfig.ts and deliberately has no second copy here - a family
  // must never be quoted from a different reading of the calendar than the one
  // that charges their card.
  const rawCap = opts.isBank && cfg.platform_fee_ach_cap_cents != null
    ? cfg.platform_fee_ach_cap_cents
    : cfg.platform_fee_cap_cents;
  const capRaw = Number(rawCap);
  const cap = capRaw > 0 ? capRaw : Infinity;

  return Math.min(Math.max(Math.round(cents * rate), floor), cap);
}

/** What the family actually pays: the price plus the fee, in cents. */
export function totalWithFee(cents, cfg, opts = {}) {
  return cents + feeOnCents(cents, cfg, opts);
}

/**
 * The fee a whole cart owes: each line clamped on its own, then summed.
 *
 * Money layer section 4: "applied to the line, not the cart" and "No
 * cart-level maximum. Six children at $228 shows $6.84 six times, not $41.04
 * once." Passing a cart TOTAL to feeOnCents instead collects one ceiling on
 * the basket, and - the uglier half - one $1.99 floor on three small add-ons.
 *
 * Mirrors supabase/functions/_shared/cartFee.ts (cartFeeCents). If the two
 * ever disagree, a family is quoted one number here and charged another by
 * Stripe. cartFeeTwinParity.test.ts runs both over the same matrix.
 *
 * @param {number[]} lineAmounts  per-registration amounts in cents
 */
export function cartFeeOnLines(lineAmounts, cfg, opts = {}) {
  if (!Array.isArray(lineAmounts)) return 0;
  return lineAmounts.reduce((s, a) => s + feeOnCents(Number(a) || 0, cfg, opts), 0);
}

/** What a whole cart actually costs the family: every line plus its own fee. */
export function cartTotalWithFee(lineAmounts, cfg, opts = {}) {
  const base = (lineAmounts || []).reduce((s, a) => s + (Number(a) || 0), 0);
  return base + cartFeeOnLines(lineAmounts, cfg, opts);
}

/**
 * Per-installment fee shares for a payment plan.
 *
 * The fee is capped per REGISTRATION, not per charge, so it is computed once
 * against the whole total and then split. Computing it per installment would
 * let a $500 program collect the $7.99 cap three times, and the payment plan
 * is chosen by the families least able to absorb that.
 *
 * Mirrors supabase/functions/_shared/feeAllocation.ts exactly, including
 * pushing the leftover cent onto charge 1: the family consents to charge 1 on
 * screen, so it is the only one allowed to be a cent higher than a clean third.
 * If this and the server ever disagree, the family sees one number here and a
 * different one on their statement.
 *
 * @param {number[]} amounts  installment amounts in cents, in order
 * @param {object}   cfg      org fee config from org-fee-config
 * @param {object}   [opts]
 * @returns {number[]} fee per installment, summing exactly to the total fee
 */
export function installmentFeeShares(amounts, cfg, opts = {}) {
  if (!Array.isArray(amounts) || !amounts.length) return [];
  const total = amounts.reduce((s, a) => s + Math.max(0, Number(a) || 0), 0);
  const totalFee = feeOnCents(total, cfg, opts);
  if (!(totalFee > 0)) return amounts.map(() => 0);
  if (total <= 0) return amounts.map((_, i) => (i === 0 ? totalFee : 0));

  const shares = amounts.map((a) =>
    Math.floor((totalFee * Math.max(0, Number(a) || 0)) / total),
  );
  shares[0] += totalFee - shares.reduce((s, v) => s + v, 0);
  return shares;
}

/**
 * Per-installment fee shares for a CART on a payment plan.
 *
 * One registration's fee, split across that registration's own charges, for
 * every registration in the cart. Returns the total carried by each
 * installment NUMBER, in ascending order, which is what the Pay step shows:
 * "charge 1 is $X".
 *
 * Why not installmentFeeShares on the cart's aggregated schedule: that clamps
 * the basket. Two children at $240 each owe $7.20 apiece, and on the aggregated
 * shape the ceiling would land on their combined $480.
 *
 * Mirrors supabase/functions/_shared/cartFee.ts (allocateCartFeeByLine).
 *
 * @param {{registration_id: string, installment_number: number, amount_cents: number}[]} perLine
 * @returns {number[]} fee per installment number, ascending
 */
export function cartInstallmentFeeShares(perLine, cfg, opts = {}) {
  if (!Array.isArray(perLine) || !perLine.length) return [];

  const byRegistration = new Map();
  for (const row of perLine) {
    const key = row.registration_id;
    if (!byRegistration.has(key)) byRegistration.set(key, []);
    byRegistration.get(key).push(row);
  }

  const totalByInstallment = new Map();
  for (const rows of byRegistration.values()) {
    // Sorted on a copy: the caller's array is its own render order.
    const ordered = rows.slice().sort((a, b) => a.installment_number - b.installment_number);
    const shares = installmentFeeShares(ordered.map((r) => r.amount_cents), cfg, opts);
    ordered.forEach((r, i) => {
      totalByInstallment.set(
        r.installment_number,
        (totalByInstallment.get(r.installment_number) || 0) + shares[i],
      );
    });
  }

  return [...totalByInstallment.keys()]
    .sort((a, b) => a - b)
    .map((n) => totalByInstallment.get(n));
}
