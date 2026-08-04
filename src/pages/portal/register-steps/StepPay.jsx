import React, { useState } from 'react';
import { formatMoney } from '../../../lib/pricing.js';
import { feeOnCents, installmentFeeShares } from '../../../lib/platformFee.js';
import { formatStartDate } from '../../../lib/programSchedule.js';

export default function StepPay({
  pricing,
  submitting,
  onCheckout,
  paymentPlan,
  installmentSchedule,
  org,
  cancellationPolicy,
}) {
  // The policy is authored as markdown and rendered properly on its own page.
  // Here it is an inline preview inside a checkout step, so the few markers a
  // provider is likely to use are stripped rather than shown raw - a family
  // reading "## Refunds" and "**14 days**" reads it as broken, not as policy.
  const cancellationText = (cancellationPolicy || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
  // Display amount reflects the choice made on the Review step:
  // - If paymentPlan checkbox was clicked AND we have a valid schedule, show first-charge amount
  // - Otherwise show full total
  const useInstallments = !!(paymentPlan && installmentSchedule);
  const displayAmount = useInstallments
    ? installmentSchedule[0].amount_cents
    : pricing.total_cents;

  // The family picks card vs bank transfer HERE, before we redirect, so the
  // backend can build a single-method Stripe session with the fee computed for
  // exactly that method (card and ACH carry different fees). Installments are
  // card-only, so the selector is hidden and card is forced in that case.
  const [method, setMethod] = useState('card');
  const effectiveMethod = useInstallments ? 'card' : method;
  const isBank = effectiveMethod === 'us_bank_account';

  // Pass-through: when the operator passes the platform fee to families, the
  // family pays the price PLUS the fee. Mirror the backend (computePlatformFee:
  // round(amount * rate), capped) so this pre-redirect total matches exactly
  // what Stripe charges — using the SAME method the family selected. org fee
  // config comes from the org-fee-config edge fn (the anon org view intentionally
  // excludes fee columns). Absorb orgs add 0.
  // Same helper the class card uses, so the figure a family saw before they
  // started is the figure they're asked to pay. See src/lib/platformFee.js —
  // it mirrors the server's computePlatformFee clamp exactly.
  const feeOn = (cents) => feeOnCents(cents, org, { isBank });

  // ACH is presented as a DISCOUNT off the standard price, never as a cheaper
  // fee for a different payment method.
  //
  // The distinction is legal, not cosmetic. Charging more because someone used a
  // card is a surcharge, which is restricted by card-network rules and by state
  // law. Offering a discount for paying another way is expressly permitted — and
  // it is the same money either way. So the CARD fee is the standard fee, always
  // shown as such, and choosing bank shows what it saves you.
  const standardFeeOn = (cents) => feeOnCents(cents, org, { isBank: false });
  const charged = (cents) => cents + feeOn(cents);

  // Payment plans: the fee is capped per REGISTRATION, so it is computed once
  // against the whole total and split across the three charges — never
  // recomputed per installment, which would collect the cap up to three times.
  // Same allocation the server uses, so these figures are the figures Stripe
  // charges. Installments are card-only, hence no isBank here.
  const planShares = useInstallments
    ? installmentFeeShares(installmentSchedule.map((i) => i.amount_cents), org)
    : [];
  const planStandardShares = planShares; // card-only; standard === effective
  const feeForIndex = (i) => (useInstallments ? planShares[i] : 0);
  const chargedForIndex = (i) => installmentSchedule[i].amount_cents + feeForIndex(i);

  const feeToday = useInstallments ? feeForIndex(0) : feeOn(displayAmount);
  const chargedToday = useInstallments ? chargedForIndex(0) : charged(displayAmount);
  // The standard (card) fee, and what paying by bank takes off it. Never
  // negative: if a config ever made ACH the dearer method, we show no discount
  // rather than inventing a card penalty.
  const standardFeeToday = useInstallments ? planStandardShares[0] : standardFeeOn(displayAmount);
  const bankDiscountToday = Math.max(0, standardFeeToday - feeToday);
  const grandTotal = useInstallments
    ? installmentSchedule.reduce((s, i, idx) => s + i.amount_cents + feeForIndex(idx), 0)
    : chargedToday;

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
            {/* Standard fee first, then the discount as its own subtraction, so
                the breakdown always sums to the amount charged above. */}
            {formatMoney(displayAmount)} + {formatMoney(standardFeeToday)} enrops service fee
          </p>
        )}
        {bankDiscountToday > 0 && (
          <p className="mt-1 text-sm font-bold text-white">
            &minus; {formatMoney(bankDiscountToday)} bank payment discount
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
                {formatMoney(chargedForIndex(0))}
              </p>
            </div>
            <div className="rounded-lg bg-j2s-purple-soft/40 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                {formatStartDate(installmentSchedule[1].due_date)}
              </p>
              <p className="font-titan text-lg text-j2s-ink">
                {formatMoney(chargedForIndex(1))}
              </p>
            </div>
            <div className="rounded-lg bg-j2s-purple-soft/40 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                {formatStartDate(installmentSchedule[2].due_date)}
              </p>
              <p className="font-titan text-lg text-j2s-ink">
                {formatMoney(chargedForIndex(2))}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-j2s-ink/60">
            Your card on file will be charged automatically on each date.
            {feeToday > 0 && ' Each charge includes the enrops service fee.'}
          </p>
        </div>
      )}

      {/* Payment method chooser — bank transfer is card's cheaper cousin for
          large tuition, so we surface it up front. Hidden for installments
          (card-on-file only). */}
      {!useInstallments && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-bold uppercase tracking-widest text-j2s-purple-dark">
            How would you like to pay?
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMethod('card')}
              className={`flex items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition ${
                !isBank
                  ? 'border-j2s-purple bg-j2s-purple-soft/40'
                  : 'border-j2s-purple/15 bg-white hover:border-j2s-purple/40'
              }`}
            >
              <span className="text-2xl">💳</span>
              <span>
                <span className="block font-bold text-j2s-ink">Credit or debit card</span>
                <span className="block text-xs text-j2s-ink/60">Instant — spot confirmed right away</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMethod('us_bank_account')}
              className={`flex items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition ${
                isBank
                  ? 'border-j2s-purple bg-j2s-purple-soft/40'
                  : 'border-j2s-purple/15 bg-white hover:border-j2s-purple/40'
              }`}
            >
              <span className="text-2xl">🏦</span>
              <span>
                <span className="block font-bold text-j2s-ink">Bank transfer (ACH)</span>
                <span className="block text-xs text-j2s-ink/60">1–3 business days — spot held meanwhile</span>
                {/* Stated as a saving on THIS option, not as a penalty on the
                    card option. Computed from the same figures as the total, so
                    it can never promise a discount that doesn't materialise. */}
                {standardFeeOn(displayAmount) - feeOnCents(displayAmount, org, { isBank: true }) > 0 && (
                  <span className="mt-1 block text-xs font-bold text-j2s-purple">
                    Save {formatMoney(standardFeeOn(displayAmount) - feeOnCents(displayAmount, org, { isBank: true }))}
                  </span>
                )}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* v4 section 6: the provider's cancellation and refund policy, shown
          BEFORE money is taken rather than buried in a Terms page. Omitted
          entirely when the provider has not published one - showing a made-up
          policy would be far worse than showing none. */}
      {cancellationText && (
        <div className="mt-8 rounded-2xl border border-j2s-purple/15 bg-white p-5">
          <p className="mb-2 text-sm font-bold uppercase tracking-widest text-j2s-purple-dark">
            Cancellation and refunds
          </p>
          <div
            className="max-h-44 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-j2s-ink/80"
            tabIndex={0}
          >
            {cancellationText}
          </div>
          <a
            href={`/${org?.slug}/cancellation`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm font-bold text-j2s-purple underline"
          >
            Read the full policy
          </a>
        </div>
      )}

      <div className="mt-8 space-y-3 rounded-2xl bg-j2s-purple-soft/30 p-6">
        <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
          <span className="text-j2s-purple">🔒</span>
          Payment processed securely by Stripe. We never see your{' '}
          {isBank ? 'bank details' : 'card details'}.
        </p>
        {isBank && (
          <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
            <span className="text-j2s-purple">🏦</span>
            Bank transfers take 1–3 business days to clear — your spot is held the
            whole time.
          </p>
        )}
        <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
          <span className="text-j2s-purple">📧</span>
          Confirmation and receipt will arrive by email within a few minutes.
        </p>
        <p className="flex items-start gap-2 text-sm text-j2s-ink/80">
          <span className="text-j2s-purple">✨</span>
          {/* "re-enrollment next term" assumes a school-year term. Wrong for a
              one-off workshop, and provider vocabulary either way. */}
          After payment, we&rsquo;ll set up your account so signing up again is one click.
        </p>
      </div>

      <button
        onClick={() => onCheckout(effectiveMethod)}
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
