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
  // Which Stripe Connect charge type this org's payments use.
  //   'destination' (the default, and every org that existed before 2026-07-27):
  //     the charge is created on the PLATFORM and transferred out. Enrops is
  //     liable for Stripe's fee and disputes, so the fee is recovered via the
  //     uplift below. J2S is permanently here.
  //   'direct': the charge is created ON the connected account (Stripe-Account
  //     header). Stripe debits its own fee from that account natively and the
  //     operator owns disputes, so there is NO uplift - application_fee_amount
  //     is clean Enrops margin. Only controller-based accounts minted by
  //     Phase 1 are marked 'direct'.
  // Read via buildChargeRouting(), never by buildConnectChargeParams() - that
  // function is the destination-charge path and stays unaware of the split.
  stripe_charge_model?: string | null;
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
  // The uplift applies REGARDLESS of on_behalf_of. On a destination charge (which is
  // what every connected org uses here — transfer_data.destination below), Stripe
  // ALWAYS debits its processing fee from the PLATFORM (Enrops) balance, and
  // on_behalf_of does NOT change that — per Stripe's docs it only changes the
  // fee-calculation country, statement descriptor, and merchant of record. So both
  // legacy (J2S) and enrops_platform orgs need the uplift to pass Stripe's fee onto
  // the provider's payout; without it Enrops eats the fee. (A 2026-07-24 attempt to
  // drop the uplift for on_behalf_of orgs was a mistake — it would have made Enrops
  // lose ~$2 per charge. Verified against Stripe docs + a real staging charge.)
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

// --- Phase 2: direct vs destination routing ---------------------------------
//
// buildChargeRouting is the SINGLE entry point for every charge path
// (create-checkout, process-installments). It decides three things at once:
// which params go on the charge, which Stripe account the API call is made
// against, and whether the charge may proceed at all - because getting those
// three out of sync is how money lands in the wrong balance.
//
// DESTINATION orgs delegate to buildConnectChargeParams() UNCHANGED and get
// requestOptions:undefined - the platform-scoped call they have always made,
// with no second argument at all. That function is deliberately not modified by
// Phase 2, so a legacy org's charge is byte-for-byte what it was before. J2S is
// a destination org and always will be.
//
// DIRECT orgs get the Stripe-Account header and a margin-only application fee.
// Per Stripe's direct-charges docs: "if you make a charge of 10 USD with a
// 1.23 USD application fee ... 1.23 USD is transferred to your platform account.
// 8.18 USD (10 USD - 0.59 USD - 1.23 USD) is netted in the connected account" -
// the 0.59 is Stripe's fee coming off the CONNECTED account with no help from
// us. That is why the uplift is dropped here and only here.

export interface ChargeRouting {
  /** true when the charge is created on the connected account. */
  direct: boolean;
  /** Spread into the charge params (Checkout payment_intent_data / PaymentIntent.create). */
  params: ConnectChargeParams;
  /**
   * Pass as the Stripe request options argument: {stripeAccount} for direct,
   * and UNDEFINED - never {} - otherwise.
   *
   * This is not cosmetic. stripe-node identifies an options object by looking
   * for known keys (apiKey / idempotencyKey / stripeAccount ...). An EMPTY
   * object matches none of them, so it is treated as a stray extra argument and
   * the call dies with "Unknown arguments ([object Object])". Passing {} here
   * would have broken every destination charge - i.e. J2S - while type-checking
   * and unit-testing perfectly clean. Caught by a real staging call 2026-07-27.
   */
  requestOptions: { stripeAccount: string } | undefined;
  /**
   * Non-null when this charge MUST NOT proceed. Only ever set for 'direct' orgs:
   * a direct charge with no usable connected account has nowhere to go, and
   * falling through would create a plain platform charge - silently taking an
   * operator's revenue into the Enrops balance. Destination orgs keep their
   * existing fall-through behavior (blocked stays null) so nothing about the
   * legacy path changes.
   */
  blocked: string | null;
}

export function buildChargeRouting(
  amountCents: number,
  paymentMethod: PaymentMethodType,
  org: ConnectOrgConfig | null,
  orgIdForLog: string | null,
  /**
   * This charge's share of a fee that was capped across the WHOLE registration
   * (see _shared/feeAllocation.ts). Pass it only on the installments path;
   * omit it for pay-in-full, where one charge already means one cap.
   *
   * It replaces the MARGIN component only. On a destination charge the
   * Stripe-fee uplift stays per-charge, because Stripe really does take its fee
   * on each charge — capping that would just make Enrops eat the difference.
   */
  marginOverrideCents?: number,
): ChargeRouting {
  const isDirect = org?.stripe_charge_model === 'direct';

  if (!isDirect) {
    const params = buildConnectChargeParams(amountCents, paymentMethod, org, orgIdForLog);
    // Shift ONLY the margin, leaving the uplift buildConnectChargeParams
    // computed. With no override this block never runs, so J2S and every
    // pay-in-full charge are byte-for-byte unchanged.
    if (marginOverrideCents !== undefined && params.application_fee_amount !== undefined && org) {
      const baseMargin = computePlatformFee(amountCents, paymentMethod, org);
      const shifted = params.application_fee_amount + (marginOverrideCents - baseMargin);
      params.application_fee_amount = Math.max(0, Math.min(shifted, amountCents));
    }
    return { direct: false, params, requestOptions: undefined, blocked: null };
  }

  // --- direct charge ---
  // Fail closed. A direct org without a live connected account cannot be
  // charged at all; there is no safe fallback.
  if (!org!.stripe_account_id) {
    return {
      direct: true, params: {}, requestOptions: undefined,
      blocked: `org ${orgIdForLog ?? '(unknown)'} is stripe_charge_model=direct but has no stripe_account_id`,
    };
  }
  if (!org!.stripe_charges_enabled) {
    return {
      direct: true, params: {}, requestOptions: undefined,
      blocked: `org ${orgIdForLog ?? '(unknown)'} is stripe_charge_model=direct but stripe_charges_enabled=false`,
    };
  }

  // Margin only - NO estimateStripeFee uplift. The operator pays Stripe natively.
  const margin = marginOverrideCents !== undefined
    ? marginOverrideCents
    : computePlatformFee(amountCents, paymentMethod, org!);

  const params: ConnectChargeParams = {};
  // Stripe: "The value of application_fee_amount must be positive and less than
  // the amount of the charge." Omit the field entirely rather than send 0 or a
  // value that would fail the whole charge - a lost fee beats a declined family.
  const fee = Math.min(margin, amountCents - 1);
  if (fee > 0) params.application_fee_amount = fee;

  // Deliberately absent on a direct charge:
  //   transfer_data              - nothing to transfer; funds start on the account.
  //   on_behalf_of               - the connected account already IS the merchant.
  //   statement_descriptor_suffix - the connected account's own descriptor governs.
  return {
    direct: true,
    params,
    requestOptions: { stripeAccount: org!.stripe_account_id },
    blocked: null,
  };
}
