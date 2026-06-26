// passThroughFee — when an operator opts to pass the platform fee to families
// (organizations.fee_pass_through = true), the family pays the base price PLUS
// the 1% platform fee as a separate, visible line. The application_fee_amount
// is unchanged (still 1% of base, via computePlatformFee/buildConnectChargeParams)
// — the only difference is whether the family is charged that 1% on top.
//
// Reusing computePlatformFee guarantees the line the family pays === the fee the
// platform keeps, so the operator nets their full base price (minus Stripe's own
// processing fee, which the connected account always pays). Method-agnostic:
// card and ACH are both 1%, so the amount is the same whichever the family picks.

import { computePlatformFee, PaymentMethodType, PlatformFeeConfig } from './computePlatformFee.ts';

export type PassThroughConfig = PlatformFeeConfig & {
  fee_pass_through?: boolean | null;
};

// Cents to ADD to what the family pays. 0 when the operator absorbs the fee.
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
  return {
    price_data: {
      currency: 'usd',
      product_data: {
        name: 'Platform fee',
        description: 'Supports the registration platform (1%).',
      },
      unit_amount: fee,
    },
    quantity: 1,
  };
}
