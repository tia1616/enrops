// advertisedPrice — the price to put in front of a family, formatted.
//
// Money layer (17 Sept 2026) section 3 and 4: everything enrops generates -
// share links, link previews, embeds, QR flyers, marketing emails, texts and
// social copy - pulls the ALL-IN price automatically. Required by law in seven
// states, and the reason is simpler than the law: the price a family sees
// first has to be the price they pay.
//
// CARD, NOT BANK. Card is the listed price everywhere; paying by bank is
// presented as a discount at the payment step, once a method has been chosen.
// Quoting the bank price in an advert and charging the card one is the shape
// that gets called a surcharge.
//
// WHOLE DOLLARS STAY WHOLE. Marketing prices have always rendered as "$240",
// and an operator who absorbs the fee must keep byte-identical copy - their
// families are not being charged anything new, so their emails should not
// change. Cents appear only when the fee actually puts them there.

import { computePlatformFee, PaymentMethodType } from './computePlatformFee.ts';
import { PlatformFeeConfig } from './computePlatformFee.ts';

export interface AdvertisedFeeConfig extends PlatformFeeConfig {
  /** false = the operator absorbs the fee, so the advertised price is the base. */
  fee_pass_through?: boolean | null;
}

/**
 * What a family pays for one registration at this price.
 *
 * PER REGISTRATION LINE, which is what every caller here has: a programme
 * price, an early-bird price, a camp price. A bundle of several registrations
 * carries several fees and cannot be priced by passing its total through this
 * - see _shared/cartFee.ts for that.
 */
export function advertisedPriceCents(
  baseCents: number,
  org: AdvertisedFeeConfig | null | undefined,
  paymentMethod: PaymentMethodType = 'card',
): number {
  if (!Number.isFinite(baseCents) || baseCents <= 0) return 0;
  if (!org || !org.fee_pass_through) return baseCents;
  return baseCents + computePlatformFee(baseCents, paymentMethod, org);
}

/**
 * The same number as a string, in the format marketing has always used.
 *
 * Returns '' for a missing or non-positive price, because every caller's
 * existing behaviour on a null price is to render an empty token and let the
 * copy omit the line. A "$0" in a marketing email is worse than no price.
 */
export function advertisedPriceLabel(
  baseCents: number | null | undefined,
  org: AdvertisedFeeConfig | null | undefined,
  paymentMethod: PaymentMethodType = 'card',
): string {
  if (baseCents == null || !Number.isFinite(Number(baseCents)) || Number(baseCents) <= 0) return '';
  const cents = advertisedPriceCents(Number(baseCents), org, paymentMethod);
  if (cents <= 0) return '';
  return cents % 100 === 0
    ? `$${(cents / 100).toFixed(0)}`
    : `$${(cents / 100).toFixed(2)}`;
}

/**
 * An advertised saving, compared LIKE FOR LIKE.
 *
 * Both sides all-in, or both bare. Comparing an all-in regular price against a
 * bare early-bird price inflates the saving by the fee; comparing the other
 * way shrinks it. The listing page made exactly this mistake with its VIP
 * badge before it was caught, which is why this is a function rather than a
 * subtraction at four call sites.
 *
 * Returns '' when there is no saving to claim.
 */
export function advertisedSavingLabel(
  regularCents: number | null | undefined,
  discountedCents: number | null | undefined,
  org: AdvertisedFeeConfig | null | undefined,
  paymentMethod: PaymentMethodType = 'card',
): string {
  if (regularCents == null || discountedCents == null) return '';
  const regular = advertisedPriceCents(Number(regularCents), org, paymentMethod);
  const discounted = advertisedPriceCents(Number(discountedCents), org, paymentMethod);
  const saving = regular - discounted;
  if (!(saving > 0)) return '';
  return saving % 100 === 0
    ? `$${(saving / 100).toFixed(0)}`
    : `$${(saving / 100).toFixed(2)}`;
}
