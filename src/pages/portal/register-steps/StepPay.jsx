import React, { useState } from 'react';
import { formatMoney } from '../../../lib/pricing.js';
import { feeOnCents, installmentFeeShares } from '../../../lib/platformFee.js';
import { formatStartDate } from '../../../lib/programSchedule.js';
import {
  coverFeeCents,
  giftWithinBounds,
  formatGift,
  parseGiftInput,
} from '../../../lib/scholarshipFund.js';

export default function StepPay({
  pricing,
  submitting,
  onCheckout,
  paymentPlan,
  installmentSchedule,
  org,
  cancellationPolicy,
  scholarshipFund,
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

  // --- Scholarship fund -----------------------------------------------------
  // Shown only when the provider turned it on AND this cart can actually carry
  // a gift. Both exclusions are enforced again in create-checkout, because a
  // rule that only lives in a component is not a rule:
  //   - PAYMENT PLANS: a gift is not financed across three dated charges.
  //   - $0 CARTS: a fully-covered registration creates no Stripe session, so
  //     there is nothing for the gift to ride on. It is also, plainly, not the
  //     family to ask.
  const fund = scholarshipFund?.enabled ? scholarshipFund : null;
  const canAskForGift = !!fund && !useInstallments && displayAmount > 0;
  const [giftCents, setGiftCents] = useState(0);
  const [customGift, setCustomGift] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [coverFee, setCoverFee] = useState(fund?.cover_fee_default ?? false);

  // A custom amount that is typed but out of bounds must block the button and
  // say so, rather than letting them reach Stripe and bounce off a 400.
  const giftInvalid = canAskForGift && giftCents > 0 && !giftWithinBounds(giftCents, fund);
  // VALIDITY GATES THE MONEY, not just the button. Computing the charge from
  // `giftCents > 0` alone made the headline total quote a gift the form had
  // already refused: typing 50c showed "+ $0.51 scholarship fund donation" and
  // a total of $302.50 next to the message "The smallest donation is $1." and a
  // dead Pay button. One question, one boolean - a visibility condition is not
  // a truth condition.
  const giftCounts = canAskForGift && giftCents > 0 && !giftInvalid;
  const giftCover = giftCounts ? coverFeeCents(giftCents, coverFee, fund) : 0;
  const giftCharged = giftCounts ? giftCents + giftCover : 0;
  const payDisabled = submitting || giftInvalid;

  function chooseGift(cents) {
    // Tapping the SELECTED tile clears it - the only way back to "no thanks"
    // once a tile is picked, and people do expect a second tap to undo.
    //
    // "Selected" must mean the same thing here as it does on screen, which is
    // `giftCents === cents && !customOpen`. Testing prev === cents alone made a
    // tile that renders unselected behave as if it were: type 25 into the
    // custom box, then click the $25 tile, and instead of selecting it the
    // handler toggled the gift to zero. The family saw the total drop back and
    // paid nothing to the fund believing they had given $25.
    setGiftCents((prev) => (prev === cents && !customOpen ? 0 : cents));
    setCustomOpen(false);
    setCustomGift('');
  }

  function onCustomGiftChange(raw) {
    setCustomGift(raw);
    const parsed = parseGiftInput(raw);
    // null means "not a usable amount yet" (mid-typing, or junk). Treat it as no
    // gift rather than freezing the last valid number, so clearing the box
    // clears the charge.
    setGiftCents(parsed ?? 0);
  }

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
          {/* The gift is part of what the card is charged, so it is part of the
              headline figure. Showing tuition here and surprising them with a
              larger number on Stripe is the one thing this screen must not do. */}
          {formatMoney(chargedToday + giftCharged)}
        </p>
        {feeToday > 0 && (
          <p className="mt-2 text-sm text-white/90">
            {/* Standard fee first, then the discount as its own subtraction, so
                the breakdown always sums to the amount charged above. */}
            {formatMoney(displayAmount)} + {formatMoney(standardFeeToday)} enrops service fee
          </p>
        )}
        {giftCharged > 0 && (
          <p className="mt-1 text-sm text-white/90">
            {/* Named as its own addition for the same reason the fee line is:
                every part of the headline figure has to be accounted for. */}
            + {formatMoney(giftCharged)} scholarship fund donation
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

      {/* Scholarship fund. Placed AFTER the payment-method choice and BEFORE
          the policy, so it reads as an optional extra at the end of the order
          rather than as part of the price. Nothing is preselected: a gift the
          family did not deliberately choose is not a gift. */}
      {canAskForGift && (
        <div className="mt-6 rounded-2xl border-2 border-j2s-purple/20 bg-white p-5 shadow-card">
          <p className="text-base font-bold text-j2s-ink">{fund.headline}</p>
          <p className="mt-1 text-sm leading-relaxed text-j2s-ink/70">{fund.blurb}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {fund.preset_amounts_cents.map((cents) => (
              <button
                key={cents}
                type="button"
                aria-pressed={giftCents === cents && !customOpen}
                onClick={() => chooseGift(cents)}
                className={`rounded-xl border-2 px-4 py-2 text-sm font-bold transition ${
                  giftCents === cents && !customOpen
                    ? 'border-j2s-purple bg-j2s-purple-soft/60 text-j2s-purple-dark'
                    : 'border-j2s-purple/15 bg-white text-j2s-ink hover:border-j2s-purple/40'
                }`}
              >
                {formatGift(cents)}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={customOpen}
              onClick={() => {
                // Opening the custom box clears any tile, so the two controls
                // can never both look chosen while only one is charged.
                setCustomOpen((open) => {
                  if (open) { setCustomGift(''); setGiftCents(0); return false; }
                  setGiftCents(0);
                  return true;
                });
              }}
              className={`rounded-xl border-2 px-4 py-2 text-sm font-bold transition ${
                customOpen
                  ? 'border-j2s-purple bg-j2s-purple-soft/60 text-j2s-purple-dark'
                  : 'border-j2s-purple/15 bg-white text-j2s-ink hover:border-j2s-purple/40'
              }`}
            >
              Another amount
            </button>
          </div>

          {customOpen && (
            <div className="mt-3">
              <label htmlFor="custom-gift" className="sr-only">Donation amount in dollars</label>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-j2s-ink/60">$</span>
                <input
                  id="custom-gift"
                  type="text"
                  inputMode="decimal"
                  value={customGift}
                  onChange={(e) => onCustomGiftChange(e.target.value)}
                  placeholder="25"
                  className="w-32 rounded-xl border-2 border-j2s-purple/20 px-3 py-2 text-base focus:border-j2s-purple focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* OUTSIDE the custom-amount block, deliberately. This message used to
              live inside it, so an out-of-bounds amount arriving any other way -
              a preset the bounds refuse, a stale cached config - disabled the
              Pay button with nothing on screen to explain it. Whenever the
              amount is refused, the reason is visible; the message names the
              bound that broke, because "enter a valid amount" leaves them
              guessing which end. */}
          {giftInvalid && (
            <p className="mt-2 text-sm font-bold text-j2s-orange-dark">
              {giftCents < fund.min_cents
                ? `The smallest donation is ${formatGift(fund.min_cents)}.`
                : `The largest donation here is ${formatGift(fund.max_cents)}. For more than that, please get in touch.`}
            </p>
          )}

          {giftCounts && fund.cover_fee_pct > 0 && (
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-j2s-purple-soft/30 p-3">
              <input
                type="checkbox"
                checked={coverFee}
                onChange={(e) => setCoverFee(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#6B4EFF]"
              />
              <span className="text-sm text-j2s-ink/80">
                Add {formatMoney(coverFeeCents(giftCents, true, fund))} so the full{' '}
                {formatGift(giftCents)} reaches the fund
              </span>
            </label>
          )}

          {giftCounts && (
            <p className="mt-3 text-sm font-bold text-j2s-purple-dark">
              {/* Both numbers, always: the one they chose and the one they pay.
                  With the box ticked those differ, and only saying one of them
                  is how a receipt ends up surprising someone. */}
              {formatGift(giftCents)} to the fund
              {giftCover > 0 && <> &middot; {formatMoney(giftCharged)} added to your total</>}
            </p>
          )}

          {/* The tax note comes from the PROVIDER's config, never from a string
              here. It defaults to the not-deductible wording because most
              enrichment providers are LLCs (tenant 1 included, which is why its
              own website says the same), but a provider that really is a
              501(c)(3) must be able to say so - telling a nonprofit's donors
              their gift is not deductible would be false and would cost them
              money. Blank hides the line rather than printing an empty one. */}
          {fund.tax_note && (
            <p className="mt-3 text-xs text-j2s-ink/50">{fund.tax_note}</p>
          )}
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
        onClick={() =>
          onCheckout(effectiveMethod, {
            // Only the gift and the checkbox cross the wire. The fee cover and
            // the charged total are recomputed server-side from the org's own
            // config, so a tampered client can change what it ASKS for but not
            // what the arithmetic does with it.
            donation_cents: giftCharged > 0 ? giftCents : 0,
            donation_cover_fee: giftCharged > 0 ? coverFee : false,
          })
        }
        disabled={payDisabled}
        className={`mt-8 w-full rounded-xl px-6 py-5 text-lg font-bold text-white shadow-pop transition ${
          submitting
            ? 'cursor-wait bg-j2s-purple'
            : giftInvalid
              ? 'cursor-not-allowed bg-j2s-purple/40'
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
