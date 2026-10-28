// Which installment rows process-installments may charge together as ONE
// PaymentIntent.
//
// A group is ONE PLAN: one org, one Stripe customer, one installment number, and
// one CHECKOUT. The checkout is the part that was missing until 2026-10-28.
// create-checkout dedupes the Stripe Customer platform-wide by email, so a parent
// who checks out twice (a year bundle in September, a single class a week later)
// has both plans under the same cus_... and the same installment numbers. Keyed
// without the checkout, the charger treated them as one cart: on 2026-10-27 the
// Chiriac family's Minecraft payment 2 (due that day, $91.33) pulled their
// bundle's payment 2 (due 2027-01-05, $231.67) forward into a single $323 charge.
//
// Earliest-date grouping (v5) is still right WITHIN a checkout - a two-child cart
// with different start dates was promised one charge per installment. It was
// never right ACROSS checkouts, where the family agreed to two separate schedules.
//
// The checkout comes from registrations.stripe_checkout_session_id, stamped by
// create-checkout on every line of the cart in one update when the session is
// created. A row whose registration has none (manual rows, or carts from before
// the column existed 2026-07-27) keys on its own registration instead: it never merges
// with anything, so the worst case is two charges where one would have done,
// each for the right amount on the right day. Never the reverse.

export interface GroupableInstallmentRow {
  organization_id: string;
  stripe_customer_id: string;
  installment_number: number;
  registration_id: string;
  registrations?: { stripe_checkout_session_id: string | null } | null;
}

/** The embed process-installments adds to its installment selects. */
export const INSTALLMENT_GROUP_SELECT = '*, registrations(stripe_checkout_session_id)';

export function installmentPlanKey(r: GroupableInstallmentRow): string {
  const session = r.registrations?.stripe_checkout_session_id;
  return session ? `checkout:${session}` : `registration:${r.registration_id}`;
}

export function installmentGroupKey(r: GroupableInstallmentRow): string {
  return `${r.organization_id}__${r.stripe_customer_id}__${r.installment_number}__${installmentPlanKey(r)}`;
}
