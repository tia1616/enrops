import React, { useState } from 'react';
import { formatMoney, INSTALLMENT_MIN_CENTS } from '../../../lib/pricing.js';
// THE PRICE ON THIS SCREEN MUST BE THE PRICE THEY PAY. Money layer section 4:
// the listing, the detail page and the CART all show the all-in card total.
// Until 2026-09-18 this screen showed the bare programme price and the fee
// appeared for the first time one click later, on the Pay step - which is the
// exact shape the doc argues against: Baymard attributes 48% of cart
// abandonment to unexpected costs, and StubHub measured shoppers 45% less
// likely to complete when fees arrived at the final step.
//
// CARD, not bank. Card is the listed price; paying by bank is shown as a
// discount on the Pay step once a method has actually been chosen. Framing it
// the other way round would be a card SURCHARGE, which is restricted by card
// network rules and by state law.
import { cartFeeOnLines, cartInstallmentFeeShares } from '../../../lib/platformFee.js';
import { programScheduleSummary, formatStartDate, formatDayLabel } from '../../../lib/programSchedule.js';
import { dismissalSummary } from '../../../lib/dismissal.js';
import { gradeFitProblem } from '../../../lib/grades.js';
// The cart -> program join, shared with StepStudent so the form and the last screen
// before the card cannot disagree about which class a warning is about. It lived
// here as a local function first, which is exactly how the two screens drifted.
import { programForLine } from '../../../lib/cartPrograms.js';

// Was the fifth copy of this map. Now src/lib/dismissal.js. Review shows the
// same summary the roster will, provider name included, so what the parent
// confirms is exactly what staff later read.
const nm = (c) => `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim();

export default function StepReview({
  cart,
  pricing,
  installmentSchedule,
  // The per-registration splits behind that schedule, so the plan preview can
  // price each child's fee on its own line the way the charge will.
  installmentSplits,
  onPromoApply,
  onPromoClear,
  onTogglePaymentPlan,
  onAddAnotherChild,
  // Named in the grade-gate sentence. Defaulted rather than required so this
  // screen still renders if it is ever mounted without an org loaded - the
  // message falls back to a generic phrasing instead of printing a blank.
  orgName = '',
  // Fee config from org-fee-config, already resolved. Defaulted to an empty
  // object so an org still loading shows the plain price rather than a blank
  // or a NaN - the fee helpers return 0 for a config they cannot read, which
  // is the same thing an absorb org shows.
  org = {},
}) {
  // The fee, per registration line, exactly as the Pay step and the server
  // will compute it - same helper, same per-line rule, so the two screens
  // cannot disagree about what this cart costs.
  const cartLineAmounts = (pricing?.lines || []).map((l) => l.amount_cents);
  const reviewFeeCents = cartFeeOnLines(cartLineAmounts, org, { isBank: false });
  const bankSavingCents = Math.max(
    0,
    reviewFeeCents - cartFeeOnLines(cartLineAmounts, org, { isBank: true }),
  );

  // Per-charge fee for the payment-plan preview, split per registration across
  // that registration's own charges. line_index keys it: no registration exists
  // yet at this point in the flow, and the fee only needs to know which amounts
  // belong together.
  const planFeeShares = installmentSplits
    ? cartInstallmentFeeShares(
      installmentSplits.flatMap(({ line_index, splits }) =>
        splits
          .map((amount_cents, i) => ({
            registration_id: `line-${line_index}`,
            installment_number: i + 1,
            amount_cents,
          }))
          .filter((r) => r.amount_cents > 0)),
      org,
    )
    : [];
  // The plan preview reads by index; a missing share is 0, never undefined,
  // so a schedule this screen cannot price still renders the bare amounts
  // rather than "$NaN".
  const planChargeCents = (i) =>
    (installmentSchedule?.[i]?.amount_cents ?? 0) + (planFeeShares[i] || 0);

  const [promoField, setPromoField] = useState(cart.promo?.code || '');
  const [validating, setValidating] = useState(false);

  async function applyPromo() {
    if (!promoField.trim()) return;
    setValidating(true);
    await onPromoApply(promoField.trim().toUpperCase());
    setValidating(false);
  }

  // Installments only available if (a) we have a valid schedule from Register.jsx,
  // and (b) the total is above the minimum threshold.
  const canUseInstallments =
    !!installmentSchedule && pricing.total_cents >= INSTALLMENT_MIN_CENTS;

  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        Review your registration
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        Make sure everything looks right before we send you to payment.
      </p>

      {/* Order lines */}
      <div className="mt-8 overflow-hidden rounded-2xl border border-j2s-purple/10 bg-white shadow-card">
        <div className="border-b border-j2s-purple/10 bg-j2s-purple-soft/40 px-6 py-4">
          <h2 className="font-titan text-lg text-j2s-ink">Your cart</h2>
        </div>
        <div className="divide-y divide-j2s-purple/10">
          {pricing.lines.map((l, i) => {
            const child = cart.children[l.child_index];
            const student = child?.student;
            const scheduleStr = programScheduleSummary(l);
            return (
              <div key={i} className="px-6 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-j2s-ink">{l.program_name}</p>
                      {l.is_vip && (
                        <span className="rounded-full bg-j2s-orange/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-j2s-orange-dark">
                          {l.term_label ? `VIP · ${l.term_label}` : 'VIP'}
                        </span>
                      )}
                      {l.is_legacy && (
                        <span className="rounded-full bg-j2s-purple/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-j2s-purple">
                          Early-bird
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-j2s-ink/70">
                      {[l.school_name, formatDayLabel(l), l.start_time]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {/* Same start date and length the family saw on the catalog
                        card, restated at the last screen before they pay, so the
                        dates they decided on are the dates they're confirming. */}
                    {scheduleStr && (
                      <p className="mt-1 text-sm text-j2s-ink/70">{scheduleStr}</p>
                    )}
                    <p className="mt-1 text-xs text-j2s-ink/50">
                      Child {l.child_index + 1}
                      {student?.first_name && `: ${student.first_name} ${student.last_name}`}
                    </p>
                    {/* THE LAST SCREEN BEFORE THE CARD, which is the whole point.
                        The 25 Aug parent saw the class, filled the form and paid,
                        and only afterwards worked out her son was below the range.
                        Repeating it here is not redundancy - the student step is
                        several screens back, and this is the last moment the
                        information can still change her mind for free.

                        Sits on the LINE, so in a cart with two children it is
                        already attached to the right child and the right class
                        without naming either. */}
                    {(() => {
                      const problem = gradeFitProblem(programForLine(child, l), student?.grade, orgName);
                      return problem ? (
                        <p role="alert" className="mt-2 rounded-lg border-2 border-j2s-orange-dark/30 bg-j2s-orange-dark/5 px-3 py-2 text-sm text-j2s-orange-dark">
                          {problem.message}
                        </p>
                      ) : null;
                    })()}
                    {l.sibling_discount_cents > 0 && (
                      <p className="mt-1 text-xs font-semibold text-j2s-purple">
                        Sibling discount: -{formatMoney(l.sibling_discount_cents)}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    {l.sibling_discount_cents > 0 && (
                      <p className="text-xs text-j2s-ink/50 line-through">
                        {formatMoney(l.base_cents)}
                      </p>
                    )}
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(l.subtotal_cents)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pickup & release confirmation — only shown when the org collects these
          questions and the parent entered something. Deduped per child. */}
      {(() => {
        const seen = new Set();
        const kids = [];
        for (const l of pricing.lines) {
          if (!seen.has(l.child_index)) { seen.add(l.child_index); kids.push(cart.children[l.child_index]); }
        }
        const g2 = cart.parent.guardian2 || {};
        const hasG2 = (g2.first_name || '').trim().length > 0;
        const kidHasExtra = (c) =>
          c?.student?.dismissal_method || (c?.authorized_pickup || []).length > 0 || (c?.do_not_release || []).length > 0;
        if (!hasG2 && !kids.some(kidHasExtra)) return null;
        return (
          <div className="mt-6 rounded-2xl border border-j2s-purple/10 bg-white p-6 shadow-card">
            <h2 className="font-titan text-lg text-j2s-ink">Pickup &amp; release</h2>
            {hasG2 && (
              <p className="mt-2 text-sm text-j2s-ink/80">
                <span className="font-semibold">Second guardian:</span> {nm(g2)}
                {g2.phone && ` · ${g2.phone}`}
              </p>
            )}
            {kids.filter(kidHasExtra).map((c, i) => (
              <div key={i} className="mt-3 border-t border-j2s-purple/10 pt-3 text-sm text-j2s-ink/80">
                <p className="font-semibold text-j2s-ink">{nm(c.student) || `Child ${i + 1}`}</p>
                {c.student?.dismissal_method && (
                  <p className="mt-1">Dismissal: {dismissalSummary(c.student)}</p>
                )}
                {(c.authorized_pickup || []).filter((p) => (p.first_name || '').trim()).length > 0 && (
                  <p className="mt-1">
                    Can be picked up by: {c.authorized_pickup.filter((p) => (p.first_name || '').trim()).map(nm).join('; ')}
                  </p>
                )}
                {(c.do_not_release || []).filter((p) => (p.first_name || '').trim()).length > 0 && (
                  <p className="mt-1 text-j2s-orange-dark">
                    Do not release to: {c.do_not_release.filter((p) => (p.first_name || '').trim()).map(nm).join('; ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Add another child */}
      <button
        onClick={onAddAnotherChild}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-j2s-purple/30 bg-j2s-purple-soft/30 px-6 py-4 font-semibold text-j2s-purple transition hover:border-j2s-purple hover:bg-j2s-purple-soft"
      >
        + Register another child for a program
      </button>

      {/* Promo code */}
      <div className="mt-6 rounded-2xl border border-j2s-purple/10 bg-white p-6 shadow-card">
        <h2 className="font-titan text-lg text-j2s-ink">Promo code</h2>
        <p className="mt-1 text-sm text-j2s-ink/60">
          Have a code? Enter it here.
        </p>
        {cart.promo ? (
          <div className="mt-3 flex items-center justify-between rounded-xl bg-j2s-purple-soft/50 px-4 py-3">
            <div>
              <p className="font-bold text-j2s-purple-dark">
                {cart.promo.code} applied
              </p>
              <p className="text-sm text-j2s-ink/60">
                -{formatMoney(pricing.promo_discount_cents)}
              </p>
            </div>
            <button
              onClick={() => {
                setPromoField('');
                onPromoClear();
              }}
              className="text-sm font-semibold text-j2s-purple hover:underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <input
              className="input-field"
              placeholder="Enter code"
              value={promoField}
              onChange={(e) => setPromoField(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyPromo()}
            />
            <button
              onClick={applyPromo}
              disabled={validating || !promoField.trim()}
              className="btn-j2s-secondary flex-shrink-0"
            >
              {validating ? 'Checking…' : 'Apply'}
            </button>
          </div>
        )}
        {cart.promo_error && (
          <p className="error-text mt-2">{cart.promo_error}</p>
        )}
      </div>

      {/* Payment plan */}
      {canUseInstallments && (
        <div className="mt-6 rounded-2xl border border-j2s-purple/10 bg-white p-6 shadow-card">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={cart.payment_plan}
              onChange={onTogglePaymentPlan}
              className="mt-1 h-5 w-5 rounded border-2 border-j2s-purple/30 text-j2s-purple focus:ring-j2s-purple"
            />
            <div>
              <p className="font-bold text-j2s-ink">Pay in 3 installments</p>
              {/* Each charge shown INCLUDING its share of the fee, because
                  that is the figure that will appear on the card statement.
                  A plan costs the same fee as paying in full; it is split
                  across the charges, never collected three times. */}
              <p className="mt-1 text-sm text-j2s-ink/70">
                Pay {formatMoney(planChargeCents(0))} today and
                we'll automatically charge your card{' '}
                {formatMoney(planChargeCents(1))} on{' '}
                {formatStartDate(installmentSchedule[1].due_date)} and{' '}
                {formatMoney(planChargeCents(2))} on{' '}
                {formatStartDate(installmentSchedule[2].due_date)}.
              </p>
              {cart.payment_plan && (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg bg-j2s-purple-soft/50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                      Today
                    </p>
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(planChargeCents(0))}
                    </p>
                  </div>
                  <div className="rounded-lg bg-j2s-purple-soft/50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                      {formatStartDate(installmentSchedule[1].due_date)}
                    </p>
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(planChargeCents(1))}
                    </p>
                  </div>
                  <div className="rounded-lg bg-j2s-purple-soft/50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                      {formatStartDate(installmentSchedule[2].due_date)}
                    </p>
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(planChargeCents(2))}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </label>
        </div>
      )}

      {/* Totals */}
      <div className="mt-6 rounded-2xl bg-j2s-ink p-6 text-white shadow-card">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-white/70">Subtotal</span>
            <span>{formatMoney(pricing.subtotal_cents)}</span>
          </div>
          {pricing.sibling_total_cents > 0 && (
            <div className="flex justify-between">
              <span className="text-white/70">Sibling discount</span>
              <span className="text-j2s-orange">
                -{formatMoney(pricing.sibling_total_cents)}
              </span>
            </div>
          )}
          {pricing.promo_discount_cents > 0 && (
            <div className="flex justify-between">
              <span className="text-white/70">Promo ({cart.promo?.code})</span>
              <span className="text-j2s-orange">
                -{formatMoney(pricing.promo_discount_cents)}
              </span>
            </div>
          )}
          {/* Itemised rather than folded silently into the total. The doc's own
              receipt spec lists the fee as its own line, and a Subtotal sitting
              above a larger Total with nothing to explain the gap reads as a
              mistake. Renders only when there is a fee: an operator who absorbs
              it - J2S today - sees exactly the screen they see now. */}
          {reviewFeeCents > 0 && (
            <div className="flex justify-between">
              <span className="text-white/70">enrops service fee</span>
              <span>{formatMoney(reviewFeeCents)}</span>
            </div>
          )}
        </div>
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="flex items-center justify-between">
            <span className="font-titan text-xl">Total</span>
            <span className="font-titan text-3xl text-j2s-orange">
              {formatMoney(pricing.total_cents + reviewFeeCents)}
            </span>
          </div>
          {/* Only when bank ACTUALLY saves something. Every org on the old 1%
              terms has the same rate on both rails, so promising a saving
              there would be a promise the next screen does not keep - and the
              amount is named rather than implied, for the same reason. */}
          {bankSavingCents > 0 && (
            <p className="mt-2 text-xs text-white/60">
              Pay by bank on the next step and save {formatMoney(bankSavingCents)}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
