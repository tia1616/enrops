import React from 'react';
import { formatMoney } from '../../../lib/pricing.js';

export default function StepPay({
  pricing,
  submitting,
  onCheckout,
  paymentPlan,
  installmentSchedule,
  org,
}) {
  // Display amount reflects the choice made on the Review step:
  // - If paymentPlan checkbox was clicked AND we have a valid schedule, show first-charge amount
  // - Otherwise show full total
  const useInstallments = !!(paymentPlan && installmentSchedule);
  const displayAmount = useInstallments
    ? installmentSchedule[0].amount_cents
    : pricing.total_cents;

  // Pass-through: when the operator passes the platform fee to families, the
  // family pays the price PLUS the fee. Mirror the backend (computePlatformFee:
  // round(amount * rate), capped) so this pre-redirect total matches exactly
  // what Stripe charges. org fee config comes from the org-fee-config edge fn
  // (the anon org view intentionally excludes fee columns). Absorb orgs add 0.
  const passThrough = !!org?.fee_pass_through;
  const feeRate = Number(org?.platform_fee_card_pct) || 0;
  const feeCap = Number(org?.platform_fee_cap_cents) || Infinity;
  const feeOn = (cents) => (passThrough ? Math.min(Math.round(cents * feeRate), feeCap) : 0);
  const charged = (cents) => cents + feeOn(cents);

  const feeToday = feeOn(displayAmount);
  const chargedToday = charged(displayAmount);
  const grandTotal = useInstallments
    ? installmentSchedule.reduce((s, i) => s + charged(i.amount_cents), 0)
    : chargedToday;
  const feePctLabel = `${+(feeRate * 100).toFixed(2)}%`;

  const fmtDate = (iso) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });

  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        Ready to pay
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        We'll send you over to Stripe to complete your payment. Your spot is held
        from here.
      </p>

      <div className="mt-8 rounded-2xl border-2 border-j2s-purple bg-gradient-to-br from-j2s-purple to-j2s-purple-dark p-8 text-center text-white shadow-pop">
        <p className="text-sm font-bold uppercase tracking-widest text-white/80">
          {useInstallments ? 'Charged today' : 'Total due today'}
        </p>
        <p className="mt-2 font-titan text-6xl">
          {formatMoney(chargedToday)}
        </p>
        {feeToday > 0 && (
          <p className="mt-2 text-sm text-white/90">
            {formatMoney(displayAmount)} + {formatMoney(feeToday)} platform fee ({feePctLabel})
          </p>
        )}
        <p className="mt-3 text-white/80">
          {pricing.lines.length}{' '}
          {pricing.lines.length === 1 ? 'registration' : 'registrations'}
          {useInstallments && (
            <> &middot; Total {formatMoney(grandTotal)} over 3 payments</>
          )}
        </p>
      </div>

      {/* Recap of the schedule the parent picked on Review */}
      {useInstallments && (
        <div className="mt-6 rounded-2xl border border-j2s-purple/10 bg-white p-5 shadow-card">
          <p className="text-sm font-bold uppercase tracking-widest text-j2s-purple-dark">
            Your payment plan
          </p>
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg bg-j2s-purple-soft/40 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">Today</p>
              <p className="font-titan text-lg text-j2s-ink">
                {formatMoney(charged(installmentSchedule[0].amount_cents))}
              </p>
            </div>
            <div className="rounded-lg bg-j2s-purple-soft/40 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                {fmtDate(installmentSchedule[1].due_date)}
              </p>
              <p className="font-titan text-lg text-j2s-ink">
                {formatMoney(charged(installmentSchedule[1].amount_cents))}
              </p>
            </div>
            <div className="rounded-lg bg-j2s-purple-soft/40 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                {fmtDate(installmentSchedule[2].due_date)}
              </p>
              <p className="font-titan text-lg text-j2s-ink">
                {formatMoney(charged(installmentSchedule[2].amount_cents))}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-j2s-ink/60">
            Your card on file will be charged automatically on each date.
            {feeToday > 0 && ` Each charge includes the ${feePctLabel} platform fee.`}
          </p>
        </div>
      )}

      <div className="mt-8 space-y-3 rounded-2xl bg-j2s-purple-soft/30 p-6">
        <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
          <span className="text-j2s-purple">🔒</span>
          Payment processed securely by Stripe. We never see your card details.
        </p>
        {!useInstallments && (
          <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
            <span className="text-j2s-purple">🏦</span>
            Pay by card or bank transfer. Bank transfers take 1–3 business days to
            clear — your spot is held the whole time.
          </p>
        )}
        <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
          <span className="text-j2s-purple">📧</span>
          Confirmation and receipt will arrive by email within a few minutes.
        </p>
        <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
          <span className="text-j2s-purple">✨</span>
          After payment, we'll set up your account so re-enrollment next term is
          one click.
        </p>
      </div>

      <button
        onClick={onCheckout}
        disabled={submitting}
        className={`mt-8 w-full rounded-xl px-6 py-5 text-lg font-bold text-white shadow-pop transition ${
          submitting
            ? 'cursor-wait bg-j2s-purple'
            : 'bg-j2s-orange hover:bg-j2s-orange-dark active:translate-y-px'
        }`}
      >
        {submitting ? (
          <span className="inline-flex items-center gap-3">
            <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Connecting to secure checkout…
          </span>
        ) : (
          'Continue to secure payment →'
        )}
      </button>
    </div>
  );
}
