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
  /** The org's current value. Blank/unrecognised is treated as the default. */
  existingModel: string | null;
  /**
   * True when the org's CURRENT model could not be read at all.
   *
   * This is deliberately SEPARATE from historyUnreadable. Collapsing the two
   * into one "something failed" flag is what made the first version of this
   * function claim to preserve while actually defaulting a direct org to
   * destination: with the org row unread, existingModel is null, and null
   * coerces to 'destination'. "Preserve" is only possible if we know what to
   * preserve.
   */
  existingModelUnreadable: boolean;
  /**
   * Has this org ever taken money? Evidence must be a payment intent, never a
   * status or a payment_method label - `payment_method='stripe'` silently missed
   * half of production when the refund-rate function trusted it.
   */
  hasTakenMoney: boolean;
  /** True when the "has this org taken money?" question could not be answered. */
  historyUnreadable: boolean;
  /** What the connected Stripe account itself says about who pays Stripe's fee. */
  operatorBearsStripeFees: boolean;
}

export interface ChargeModelDecision {
  /**
   * What to write, or NULL meaning "write nothing - leave the column alone".
   *
   * Null is the only honest answer when the model must be preserved but its
   * current value is unknown. The caller MUST omit the column from its update in
   * that case; substituting a default here would be the exact silent rewrite
   * this function exists to prevent.
   */
  chargeModel: ChargeModel | null;
  /** What the account alone would have implied. Kept for logging and review. */
  inferredModel: ChargeModel;
  /** True when the inference was deliberately not applied. */
  preserved: boolean;
  /** Human-readable reason, for the connect log. */
  source: string;
}

/**
 * Normalise anything off the row into a model we recognise.
 *
 * KNOWN LIMITATION, deliberately not engineered around. This collapses every
 * unrecognised value to 'destination', which is safe only while
 * organizations_stripe_charge_model_check (20260727c) permits exactly
 * 'destination' and 'direct'. If a THIRD model is ever added to that constraint,
 * this function will silently rewrite an org running the new model back to
 * destination on its next connect - the very failure the preserve branch exists
 * to prevent. Whoever adds a third value must update this function in the same
 * change. There is no value today that can reach the fallback from a DB read,
 * so the alternative (preserving unknown strings verbatim) would be machinery
 * for a case that cannot currently occur.
 */
function coerce(model: string | null): ChargeModel {
  // Deliberately exact-match, not a case-insensitive compare: buildChargeRouting
  // treats anything that is not exactly 'direct' as destination, and this
  // function must not disagree with it. A row reading 'DIRECT' is a data problem
  // to be found, not one to be silently accepted here as direct.
  return model === 'direct' ? 'direct' : DEFAULT_CHARGE_MODEL;
}

export function decideChargeModel(inputs: ChargeModelInputs): ChargeModelDecision {
  const inferredModel: ChargeModel = inputs.operatorBearsStripeFees ? 'direct' : 'destination';

  // Why preservation is required, if it is. Unreadable history counts: if we
  // could not answer "has this org taken money?", `hasTakenMoney` carries no
  // information and must not select the inference branch merely by being false.
  const reason = inputs.historyUnreadable
    ? "could not read this org's charge history"
    : inputs.hasTakenMoney
    ? 'org has already taken money'
    : null;

  if (reason === null) {
    return {
      chargeModel: inferredModel,
      inferredModel,
      preserved: false,
      source: inputs.operatorBearsStripeFees
        ? 'inferred direct'
        : 'inferred destination (unconfirmed fee model)',
    };
  }

  // Preservation is required. It is only POSSIBLE if we know the current value.
  // When we do not, the column is left alone rather than defaulted - defaulting
  // here would rewrite a direct org to destination while reporting success.
  if (inputs.existingModelUnreadable) {
    return {
      chargeModel: null,
      inferredModel,
      preserved: true,
      source: `left unchanged (${reason}, and its current model could not be read)`,
    };
  }

  const existing = coerce(inputs.existingModel);
  return {
    chargeModel: existing,
    inferredModel,
    preserved: true,
    source: `preserved ${existing} (${reason})`,
  };
}
