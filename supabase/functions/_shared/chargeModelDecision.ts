// chargeModelDecision — the ONE rule for what organizations.stripe_charge_model
// becomes when a Stripe account is connected to an org.
//
// WHY THIS IS A SEPARATE, PURE FILE. The rule decides where real money is
// routed, and it has a branch that only fires for an org that already has live
// charges - which is precisely the branch that cannot be exercised by connecting
// a fresh test account. Inline in the callback it was reachable only through a
// browser OAuth round trip against Stripe. Here the whole matrix is testable.
//
// THE RULE, and the failure it exists to prevent:
//
//   A first connect INFERS the model from the account. That is correct: a brand
//   new operator's fee arrangement is a fact about the account they just
//   attached, and Stripe is the authority on it.
//
//   A REPOINT preserves the model. stripe_charge_model is not a description of
//   the account; it describes the charges and payment plans already in flight.
//   An established destination org whose operator connects a Standard account
//   would otherwise be inferred into 'direct', and process-installments FAILS
//   CLOSED on any plan that predates the switch (its `orgIsDirect &&
//   !recordedAcct` branch): those rows are marked paused_card_failed and the
//   operator is emailed. That PAUSES real families' payment plans. It does not
//   merely re-route them.
//
// FAILS CLOSED. If the caller could not read the org's charge history it must
// say so, and the answer is to preserve rather than infer. An unprovable "this
// org is new" is not the same as "this org is new".

export type ChargeModel = 'destination' | 'direct';

/**
 * `destination` is the conservative answer AND the column default (20260727c).
 * Anything unknown resolves here, never to 'direct' - routing a live charge onto
 * a connected account we are guessing about is the expensive direction to be
 * wrong in.
 */
export const DEFAULT_CHARGE_MODEL: ChargeModel = 'destination';

export interface ChargeModelInputs {
  /** The org's current value. Null/blank/unrecognised is treated as the default. */
  existingModel: string | null;
  /**
   * Has this org ever taken money? Evidence must be a payment intent, never a
   * status or a payment_method label - `payment_method='stripe'` silently missed
   * half of production when the refund-rate function trusted it.
   */
  hasTakenMoney: boolean;
  /** True when the caller could NOT establish the two facts above. */
  historyUnreadable: boolean;
  /** What the connected Stripe account itself says about who pays Stripe's fee. */
  operatorBearsStripeFees: boolean;
}

export interface ChargeModelDecision {
  /** What to write. Always a valid model, never null. */
  chargeModel: ChargeModel;
  /** What the account alone would have implied. Kept for logging and review. */
  inferredModel: ChargeModel;
  /** True when the org's existing model was kept instead of the inference. */
  preserved: boolean;
  /** Human-readable reason, for the connect log. */
  source: string;
}

/** Normalise anything off the row into a model we recognise. */
function coerce(model: string | null): ChargeModel {
  // Deliberately exact-match, not a case-insensitive compare: buildChargeRouting
  // treats anything that is not exactly 'direct' as destination, and this
  // function must not disagree with it. A row reading 'DIRECT' is a data problem
  // to be found, not one to be silently accepted here as direct.
  return model === 'direct' ? 'direct' : DEFAULT_CHARGE_MODEL;
}

export function decideChargeModel(inputs: ChargeModelInputs): ChargeModelDecision {
  const inferredModel: ChargeModel = inputs.operatorBearsStripeFees ? 'direct' : 'destination';
  const existing = coerce(inputs.existingModel);

  // Order matters: unreadable history is checked FIRST. If we could not read,
  // `hasTakenMoney` carries no information and must not be allowed to select the
  // inference branch by being false.
  if (inputs.historyUnreadable) {
    return {
      chargeModel: existing,
      inferredModel,
      preserved: true,
      source: `preserved ${existing} (could not read this org's charge history)`,
    };
  }

  if (inputs.hasTakenMoney) {
    return {
      chargeModel: existing,
      inferredModel,
      preserved: true,
      source: `preserved ${existing} (org has already taken money)`,
    };
  }

  return {
    chargeModel: inferredModel,
    inferredModel,
    preserved: false,
    source: inputs.operatorBearsStripeFees
      ? 'inferred direct'
      : 'inferred destination (unconfirmed fee model)',
  };
}
