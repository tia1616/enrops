import React, { useState } from 'react';
import { formatMoney, INSTALLMENT_MIN_CENTS } from '../../../lib/pricing.js';

const DISMISSAL_LABELS = {
  released_to_authorized_adult: 'Released to an authorized adult',
  walks_or_bikes_home: 'Walks or bikes home',
  bus: 'Bus',
  aftercare: 'Aftercare',
  other: 'Other',
};
const nm = (c) => `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim();

export default function StepReview({
  cart,
  pricing,
  installmentSchedule,
  onPromoApply,
  onPromoClear,
  onTogglePaymentPlan,
  onAddAnotherChild,
}) {
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

  const fmtDate = (iso) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });

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
                      {l.school_name} &middot; {l.day_of_week}s &middot; {l.start_time}
                    </p>
                    <p className="mt-1 text-xs text-j2s-ink/50">
                      Child {l.child_index + 1}
                      {student?.first_name && `: ${student.first_name} ${student.last_name}`}
                    </p>
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
                  <p className="mt-1">Dismissal: {DISMISSAL_LABELS[c.student.dismissal_method] || c.student.dismissal_method}</p>
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
              <p className="mt-1 text-sm text-j2s-ink/70">
                Pay {formatMoney(installmentSchedule[0].amount_cents)} today and
                we'll automatically charge your card{' '}
                {formatMoney(installmentSchedule[1].amount_cents)} on{' '}
                {fmtDate(installmentSchedule[1].due_date)} and{' '}
                {formatMoney(installmentSchedule[2].amount_cents)} on{' '}
                {fmtDate(installmentSchedule[2].due_date)}.
              </p>
              {cart.payment_plan && (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg bg-j2s-purple-soft/50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                      Today
                    </p>
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(installmentSchedule[0].amount_cents)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-j2s-purple-soft/50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                      {fmtDate(installmentSchedule[1].due_date)}
                    </p>
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(installmentSchedule[1].amount_cents)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-j2s-purple-soft/50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-j2s-purple-dark">
                      {fmtDate(installmentSchedule[2].due_date)}
                    </p>
                    <p className="font-titan text-lg text-j2s-ink">
                      {formatMoney(installmentSchedule[2].amount_cents)}
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
        </div>
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="flex items-center justify-between">
            <span className="font-titan text-xl">Total</span>
            <span className="font-titan text-3xl text-j2s-orange">
              {formatMoney(pricing.total_cents)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
