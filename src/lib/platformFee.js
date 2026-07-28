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
  // A cap of 0 or null means "no cap", matching how the server treats it.
  const capRaw = Number(cfg.platform_fee_cap_cents);
  const cap = capRaw > 0 ? capRaw : Infinity;

  return Math.min(Math.max(Math.round(cents * rate), floor), cap);
}

/** What the family actually pays: the price plus the fee, in cents. */
export function totalWithFee(cents, cfg, opts = {}) {
  return cents + feeOnCents(cents, cfg, opts);
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
