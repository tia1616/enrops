// passThroughFee — when an operator opts to pass the platform fee to families
// (organizations.fee_pass_through = true), the family pays the base price PLUS
// the platform fee as a separate, visible line. The application_fee_amount is
// unchanged (the same computePlatformFee value) — the only difference is whether
// the family is charged that fee on top.
//
// Reusing computePlatformFee guarantees the line the family pays === the fee the
// platform keeps, so the operator nets their full base price (minus Stripe's own
// processing fee, which the connected account always pays). The fee follows the
// org's configured rate / floor / cap per payment method, so the card and ACH
// lines can differ.

import { computePlatformFee, PaymentMethodType, PlatformFeeConfig } from './computePlatformFee.ts';

export type PassThroughConfig = PlatformFeeConfig & {
  fee_pass_through?: boolean | null;
};

// ONE REGISTRATION'S base, never a cart total. The fee is charged per
// registration line (money layer section 4), so handing either of the two
// functions below a cart sum collects one ceiling on a basket of six children
// and one $1.99 floor on a basket of three drop-ins. A caller holding more than
// one registration uses _shared/cartFee.ts to get the number, then
// passThroughLineItemForAmount to render it - which is what create-checkout
// does, and why nothing in production calls passThroughLineItem today. Kept
// because the wording assertions in passThroughFee.test.ts are the only guard
// on the family-facing copy below, and they need a line item to read.

// Cents to ADD to what the family pays for ONE registration. 0 when the
// operator absorbs the fee.
export function passThroughFeeCents(
  baseCents: number,
  paymentMethod: PaymentMethodType,
  org: PassThroughConfig,
): number {
  if (!org.fee_pass_through) return 0;
  return computePlatformFee(baseCents, paymentMethod, org);
}

export interface StripeLineItem {
  price_data: {
    currency: string;
    product_data: { name: string; description: string };
    unit_amount: number;
  };
  quantity: number;
}

// Stripe Checkout line item for the passed-through fee, or null when the
// operator absorbs it (so the caller simply doesn't add a line).
export function passThroughLineItem(
  baseCents: number,
  paymentMethod: PaymentMethodType,
  org: PassThroughConfig,
): StripeLineItem | null {
  const fee = passThroughFeeCents(baseCents, paymentMethod, org);
  if (fee <= 0) return null;
  return passThroughLineItemForAmount(fee)!;
}

// Same line, for a fee amount the caller already worked out. Used by the
// installments path, where the fee is capped across the whole registration and
// then split, so it cannot be re-derived from this charge's amount alone.
// Kept here, next to passThroughLineItem, so the family-facing wording and the
// legal note below live in exactly ONE place.
export function passThroughLineItemForAmount(feeCents: number): StripeLineItem | null {
  const fee = Math.round(feeCents);
  if (fee <= 0) return null;
  return {
    price_data: {
      currency: 'usd',
      product_data: {
        name: 'enrops service fee',
        // No hardcoded percentage: the effective rate varies once the floor/cap
        // apply, so a flat "X%" would be misleading. The exact charged amount is
        // the unit_amount below.
        //
        // Named "enrops service fee", never "processing fee". This is enrops's
        // own charge, taken as a Stripe Connect application fee — NOT a markup
        // on the card transaction. The distinction is legal, not cosmetic:
        // surcharging a card cost to the customer is prohibited in CT, ME and MA
        // and constrained in CA, and the word "processing" is what makes a
        // reader file a platform fee under "card surcharge". Attributing it to
        // enrops by name is the same approach Eventbrite uses.
        //
        // Rewritten 2026-07-27 (Jessica picked this wording). The old line read
        // "enrops's service fee for running the platform. Not a card processing
        // surcharge." — it repeated the line title, described the product in our
        // words rather than a parent's, and denied a term most families have
        // never heard, which only plants it. "not a bank charge" does the same
        // legal work in words a parent reads once. Keep the two jobs if this is
        // ever edited again: say what the money buys, and separate it from both
        // the provider and the card networks.
        //
        // Shortened 2026-07-28 (Jessica: "need to simplify that copy"). Two
        // changes. It no longer repeats "enrops's fee" — the line item is
        // already titled "enrops service fee", and the comment above warns
        // against exactly that repetition. And it drops "and secure payments":
        // Stripe's processing fee is separate and comes out of the OPERATOR's
        // side, so this fee does not buy the family payment processing and
        // saying so oversold it.
        description: "Covers your online registration. Not a bank charge.",
      },
      unit_amount: fee,
    },
    quantity: 1,
  };
}
