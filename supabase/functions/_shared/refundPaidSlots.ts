// Which Stripe payments a refund may draw on for ONE registration.
//
// The installments table is the record of what was collected. The
// registration's own stripe_payment_intent_id is only consulted when the
// registration has NO installment rows at all (a single-pay registration).
//
// A plan leg whose rows are all still pending has paid NOTHING. Its
// registrations.stripe_payment_intent_id is the CHECKOUT's charge, which on a
// year bundle is the FIRST leg's instalment, shared by every leg, and its
// payment_status reads 'paid' without anything being collected. Falling back to
// it made that sibling's payment this leg's refund ceiling: on 2026-10-21
// withdrawing a WI27 leg (Jan instalment still pending) refunded the $240 the
// family had paid for FA26, the class they are still in.

export interface PaidSlotInstallment {
  installment_number: number;
  amount_cents: number;
  status: string;
  stripe_payment_intent_id: string | null;
  stripe_charge_account_id?: string | null;
}

export interface PaidSlotRegistration {
  payment_status: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number | null;
  stripe_charge_account_id?: string | null;
}

export interface PaidSlot {
  pi: string;
  amount: number;
  sortKey: number;
  chargeAccountId: string | null;
}

export function paidPaymentSlots(
  installments: PaidSlotInstallment[],
  reg: PaidSlotRegistration,
): PaidSlot[] {
  const paid = installments.filter((i) => i.status === 'paid' && i.stripe_payment_intent_id);
  if (paid.length > 0) {
    return paid.map((inst) => ({
      pi: inst.stripe_payment_intent_id!,
      amount: inst.amount_cents,
      sortKey: inst.installment_number, // newest installment first
      chargeAccountId: inst.stripe_charge_account_id ?? null,
    }));
  }
  if (installments.length === 0 && reg.payment_status === 'paid' && reg.stripe_payment_intent_id) {
    return [{
      pi: reg.stripe_payment_intent_id,
      amount: reg.amount_cents ?? 0,
      sortKey: 1,
      chargeAccountId: reg.stripe_charge_account_id ?? null,
    }];
  }
  return [];
}
