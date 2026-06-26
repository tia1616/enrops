// Pure mirror of the Revenue-Activity money formula implemented in the
// get_revenue_summary SQL RPC (supabase/migrations/20260625_revenue_get_revenue_summary_rpc.sql).
// Kept here as a tested, documented twin of the SQL so the formula's intent is
// pinned. If you change the SQL, change this (and its tests) to match.
//
// Refund-robust: counts GROSS stripe captured (payment_status in paid/partial/
// refunded), then subtracts succeeded refunds — so a paid-then-refunded reg nets
// to zero instead of being double-removed. NOT filtered on status='confirmed'
// (a paid-then-cancelled stripe reg still collected money).

export interface RegistrationRow {
  payment_method: string | null;   // 'stripe' | 'stripe_installments' | 'comp' | null
  payment_status: string;          // 'paid' | 'unpaid' | 'partial' | 'refunded'
  amount_cents: number | null;
}
export interface InstallmentRow {
  status: string;                  // 'paid' | 'pending'
  amount_cents: number | null;
}
export interface RefundRow {
  status: string;                  // 'succeeded' | 'failed' | 'pending'
  amount_cents: number | null;
}

const CAPTURED_STATUSES = ['paid', 'partial', 'refunded'];

/** Σ pay-in-full GROSS captured: payment_method='stripe' (NOT stripe_installments,
 *  NOT comp, NOT external/null) where money was captured. */
export function payInFullCents(regs: RegistrationRow[]): number {
  return regs
    .filter((r) => r.payment_method === 'stripe' && CAPTURED_STATUSES.includes(r.payment_status))
    .reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
}

/** Σ installment payments actually collected (installments table is the collection
 *  truth for plans — pay-in-full excludes stripe_installments, so no double count). */
export function installmentsPaidCents(insts: InstallmentRow[]): number {
  return insts.filter((i) => i.status === 'paid').reduce((sum, i) => sum + (i.amount_cents ?? 0), 0);
}

/** Σ succeeded refunds. */
export function refundedCents(refunds: RefundRow[]): number {
  return refunds.filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
}

/** Collected through Enrops = pay-in-full gross + installments paid − succeeded refunds. */
export function collectedCents(
  regs: RegistrationRow[],
  insts: InstallmentRow[],
  refunds: RefundRow[],
): number {
  return payInFullCents(regs) + installmentsPaidCents(insts) - refundedCents(refunds);
}

/** Registrations tracked outside Enrops (roster-imported; payment_method null). */
export function externalCount(regs: RegistrationRow[]): number {
  return regs.filter((r) => r.payment_method == null).length;
}
