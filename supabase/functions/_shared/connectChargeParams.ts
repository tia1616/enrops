// connectChargeParams — builds the Stripe Connect overlay (application fee,
// transfer destination, statement descriptor suffix) for a charge against a
// connected account.
//
// Shared between create-checkout (Checkout Session: nested under
// payment_intent_data) and process-installments (PaymentIntent.create: at
// the top level). Both callers spread the returned object into their params.
//
// Fallback behavior: if the org is not connected (no stripe_account_id) or
// the connection is restricted (charges_enabled=false), returns {} and the
// caller proceeds with a direct-charge to the platform account. A WARN is
// logged for the half-configured case so a human notices.

import { computePlatformFee, PaymentMethodType, PlatformFeeConfig } from './computePlatformFee.ts';
import { buildStatementDescriptorSuffix } from './statementDescriptor.ts';

export interface ConnectOrgConfig extends PlatformFeeConfig {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  statement_descriptor_suffix: string | null;
  name: string | null;
}

export interface ConnectChargeParams {
  application_fee_amount?: number;
  transfer_data?: { destination: string };
  statement_descriptor_suffix?: string;
}

export function buildConnectChargeParams(
  amountCents: number,
  paymentMethod: PaymentMethodType,
  org: ConnectOrgConfig | null,
  orgIdForLog: string | null,
): ConnectChargeParams {
  if (!org || !org.stripe_account_id) {
    return {};
  }

  if (!org.stripe_charges_enabled) {
    console.warn(
      `[connect] Org ${orgIdForLog ?? '(unknown)'} has stripe_account_id=${org.stripe_account_id} ` +
      `but stripe_charges_enabled=false. Falling back to direct charge — funds will land in ` +
      `the platform account instead of the operator's connected account.`,
    );
    return {};
  }

  const params: ConnectChargeParams = {
    application_fee_amount: computePlatformFee(amountCents, paymentMethod, org),
    transfer_data: { destination: org.stripe_account_id },
  };

  const suffix = buildStatementDescriptorSuffix(org.statement_descriptor_suffix, org.name);
  if (suffix) {
    params.statement_descriptor_suffix = suffix;
  }

  return params;
}
