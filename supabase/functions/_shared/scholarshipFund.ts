// scholarshipFund — the ONE place the gift arithmetic and the bounds live.
//
// Two callers have to agree to the cent or the family is shown one number and
// charged another: the browser (StepPay, via org-fee-config) and create-checkout.
// They agree because both compute from the SAME org_scholarship_fund row —
// `cover_fee_pct` — rather than each re-deriving a processing fee.
//
// WHY NOT estimateStripeFee: that helper models a WHOLE charge, percentage plus
// the flat 30¢ Stripe takes once per successful charge. A gift added to a cart
// that is already being charged does not add a second 30¢, so using it here
// would over-collect on every donation — most visibly on a $5 one, where a 30¢
// phantom is 6% of the gift.
//
// WHY NOT computePlatformFee: that is the enrops margin, and Jessica's decision
// (2026-09-08) is that enrops takes NO margin on a gift. Keeping the two apart
// is what makes that decision enforceable rather than aspirational.

export interface ScholarshipFundConfig {
  enabled: boolean;
  headline: string;
  blurb: string;
  tax_note: string;
  preset_amounts_cents: number[];
  min_cents: number;
  max_cents: number;
  cover_fee_default: boolean;
  cover_fee_pct: number;
}

// What the browser is told when we cannot confirm the config. Fail CLOSED: an
// ask that appears because a lookup errored is money solicited on a guess.
export const SCHOLARSHIP_FUND_OFF: ScholarshipFundConfig = {
  enabled: false,
  headline: '',
  blurb: '',
  tax_note: '',
  preset_amounts_cents: [],
  min_cents: 0,
  max_cents: 0,
  cover_fee_default: false,
  cover_fee_pct: 0,
};

// The extra the donor adds so processing does not come out of the gift.
// Rounded, never negative, and zero whenever the donor declined the box.
export function coverFeeCents(
  giftCents: number,
  coverFee: boolean,
  cfg: Pick<ScholarshipFundConfig, 'cover_fee_pct'>,
): number {
  if (!coverFee) return 0;
  if (!Number.isFinite(giftCents) || giftCents <= 0) return 0;
  const pct = Number(cfg.cover_fee_pct);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.max(0, Math.round(giftCents * pct));
}

export interface GiftValidation {
  ok: boolean;
  /** Operator-safe reason, for logs. Never shown to a family verbatim. */
  reason?: string;
  giftCents: number;
  coveredFeeCents: number;
  chargedCents: number;
}

// Server-authoritative validation of a client-supplied gift amount.
//
// The gift is the ONE number in this flow that cannot be reloaded from a
// server row before the charge — a family invents it at checkout. So it is
// bounded by config the operator set, and everything derived from it
// (the fee cover, the charged total) is computed HERE from that config, never
// accepted from the browser.
export function validateGift(
  rawGiftCents: unknown,
  coverFee: boolean,
  cfg: ScholarshipFundConfig | null,
): GiftValidation {
  // Zero-valued result shared by "no gift" and every refusal. Spread FIRST and
  // override after: spreading it last would put its own `ok: true` back over a
  // refusal's `ok: false` and turn every rejection into a silent accept.
  const zero = { giftCents: 0, coveredFeeCents: 0, chargedCents: 0 };
  const refuse = (reason: string): GiftValidation => ({ ...zero, ok: false, reason });

  // No gift asked for is the overwhelmingly common case and is not an error.
  if (rawGiftCents === null || rawGiftCents === undefined || rawGiftCents === 0) {
    return { ...zero, ok: true };
  }

  const gift = Number(rawGiftCents);
  if (!Number.isFinite(gift) || !Number.isInteger(gift) || gift <= 0) {
    return refuse('gift is not a positive whole number of cents');
  }
  if (!cfg || !cfg.enabled) {
    // A gift arrived for a provider who has the fund switched off. Refuse it
    // rather than quietly charging for something they never turned on.
    return refuse('scholarship fund is not enabled for this org');
  }
  if (gift < cfg.min_cents || gift > cfg.max_cents) {
    return refuse(`gift ${gift} outside [${cfg.min_cents}, ${cfg.max_cents}]`);
  }

  const covered = coverFeeCents(gift, coverFee, cfg);
  return { ok: true, giftCents: gift, coveredFeeCents: covered, chargedCents: gift + covered };
}

// The Stripe Checkout line for the gift. Deliberately ONE line carrying gift +
// fee cover together, not two.
//
// A separate "processing fee" line on a card charge reads as a surcharge, which
// card-network rules and CT/ME/MA law restrict — the same reason
// passThroughFee.ts is careful about its own naming. Folded into the gift it is
// what it actually is: the donor choosing to give slightly more so the fund
// receives the round number they picked.
export function scholarshipLineItem(
  v: GiftValidation,
  orgName: string | null,
): { price_data: { currency: string; product_data: { name: string; description: string }; unit_amount: number }; quantity: number } | null {
  if (!v.ok || v.chargedCents <= 0) return null;
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  return {
    price_data: {
      currency: 'usd',
      product_data: {
        name: 'Scholarship fund donation',
        description: v.coveredFeeCents > 0
          ? `${fmt(v.giftCents)} to the fund, plus ${fmt(v.coveredFeeCents)} so processing does not come out of your gift`
          : `${fmt(v.giftCents)} to ${orgName || 'the'} scholarship fund`,
      },
      unit_amount: v.chargedCents,
    },
    quantity: 1,
  };
}
