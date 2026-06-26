// achSettlement — pure helpers that decide a registration's payment fields
// from a Stripe Checkout settlement event. Extracted from stripe-webhook so the
// card-vs-ACH branching is unit-testable (the webhook itself is full of I/O).
//
// Background: card payments settle synchronously — checkout.session.completed
// arrives with payment_status='paid'. Bank transfer (ACH) settles
// asynchronously — checkout.session.completed arrives with payment_status
// 'unpaid' (or 'no_payment_required' edge), and a later
// checkout.session.async_payment_succeeded / async_payment_failed event
// resolves it. Per product decision we hold the seat optimistically either way.
//
// payment_status stays within the registrations CHECK (unpaid/paid/refunded/
// partial); ach_payment_state is the additive marker (processing/failed/null).

export interface RegistrationPaymentFields {
  payment_status: 'paid' | 'unpaid';
  ach_payment_state: 'processing' | 'failed' | null;
  // True only when the money is actually present. Gates the "money-in" side
  // effects in the webhook: payment_completed logging + installment queueing.
  fundsSettled: boolean;
}

// checkout.session.completed: card → paid now; anything else (ACH in flight) →
// confirmed-but-unpaid with a 'processing' marker, resolved by a later async event.
export function settlementForCheckoutCompleted(
  sessionPaymentStatus: string | null | undefined,
): RegistrationPaymentFields {
  const isPaid = sessionPaymentStatus === 'paid';
  return {
    payment_status: isPaid ? 'paid' : 'unpaid',
    ach_payment_state: isPaid ? null : 'processing',
    fundsSettled: isPaid,
  };
}

// checkout.session.async_payment_succeeded: the ACH cleared.
export const SETTLEMENT_ON_ASYNC_SUCCESS = {
  payment_status: 'paid' as const,
  ach_payment_state: null as 'processing' | 'failed' | null,
};

// checkout.session.async_payment_failed: the ACH bounced. Leave payment_status
// 'unpaid' and the seat confirmed; just flag it so the operator follows up.
export const SETTLEMENT_ON_ASYNC_FAILURE = {
  ach_payment_state: 'failed' as const,
};
