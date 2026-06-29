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
import { estimateStripeFee } from './estimateStripeFee.ts';
import { buildStatementDescriptorSuffix } from './statementDescriptor.ts';

export interface ConnectOrgConfig extends PlatformFeeConfig {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  statement_descriptor_suffix: string | null;
  name: string | null;
  fee_pass_through?: boolean | null;
  // Who bears Stripe's processing fee. 'tenant' (the default for Enrops-platform
  // orgs) adds an estimate of Stripe's fee to the application fee so it's deducted
  // from the provider's payout — like Square/Squarespace already do for them.
  // 'platform' (legacy own-platform orgs like J2S) and unset → no uplift.
  stripe_fee_payer?: string | null;
  // Platform relationship. 'enrops_platform' = Enrops is the Stripe platform and
  // this org is a connected account → set on_behalf_of so the family sees the
  // PROVIDER as merchant of record. 'legacy_own_platform' (J2S) = own merchant
  // already; leave untouched.
  instructor_pay_model?: string | null;
}

export interface ConnectChargeParams {
  application_fee_amount?: number;
  transfer_data?: { destination: string };
  statement_descriptor_suffix?: string;
  on_behalf_of?: string;
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

  // Application fee = Enrops margin (computePlatformFee, e.g. 1%) PLUS, when the
  // provider bears Stripe's processing fee (stripe_fee_payer='tenant'), an estimate
  // of that fee — so it's deducted from the provider's payout instead of silently
  // eaten by Enrops's platform balance on a destination charge.
  //
  // The Stripe-fee recovery is added ONLY here, never inside computePlatformFee:
  // that helper is shared with the family-facing pass-through line, which must stay
  // at the margin only. Capped at the charge amount (Stripe rejects an application
  // fee larger than the charge), and floored at 0 defensively.
  const margin = computePlatformFee(amountCents, paymentMethod, org);
  const stripeRecovery =
    org.stripe_fee_payer === 'tenant' ? estimateStripeFee(amountCents, paymentMethod) : 0;
  const applicationFee = Math.max(0, Math.min(margin + stripeRecovery, amountCents));

  const params: ConnectChargeParams = {
    application_fee_amount: applicationFee,
    transfer_data: { destination: org.stripe_account_id },
  };

  // on_behalf_of (Spec D §2): make the CONNECTED account the merchant of record
  // so the family sees the PROVIDER's name on their card statement — only when
  // Enrops is the platform (enrops_platform). Legacy own-platform orgs (J2S) are
  // already their own merchant; leave their charges untouched.
  //
  // NOTE: when on_behalf_of is set, the connected account's OWN statement
  // descriptor governs, so the platform statement_descriptor_suffix is redundant
  // (and Stripe may reject sending both). We deliberately send EITHER on_behalf_of
  // OR the suffix, never both — sidestepping the conflict the Spec D §2 caution
  // warns about.
  const useOnBehalfOf = org.instructor_pay_model === 'enrops_platform';

  if (useOnBehalfOf) {
    params.on_behalf_of = org.stripe_account_id;
  } else {
    const suffix = buildStatementDescriptorSuffix(org.statement_descriptor_suffix, org.name);
    if (suffix) {
      params.statement_descriptor_suffix = suffix;
    }
  }

  return params;
}
