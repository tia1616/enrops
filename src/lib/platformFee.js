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
