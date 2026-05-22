import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, ScreenError } from '../WizardLayout.jsx';

// Screen 7 — Stripe Connect (PLACEHOLDER STUB).
//
// Function 10 (create-stripe-connect-account) is deferred until Arielle finishes
// the Stripe Connect setup on the J2S Stripe account. Per Jessica's 2026-05-22
// decision, this screen is a stub that marks steps_completed.stripe_submitted
// and advances the wizard so end-to-end testing of Screen 8 + completion can
// happen without waiting on Arielle.
//
// TO RE-WIRE FOR REAL STRIPE: replace handleContinue with the call to
// create-stripe-connect-account, then on its onboarding_url response, redirect
// (window.location.href = onboarding_url). Move the steps_completed.stripe_
// submitted marker to the ?return=true callback path. See chunk 3 spec
// "Screen 7: Payment Setup (Stripe Connect Express)" for the full real flow.

export default function Screen7StripeStub({ slug, instructor, onboarding, onAdvance }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');

  async function handleContinue() {
    if (busy) return;
    setBusy(true);
    setSubmitError('');
    try {
      const { error } = await invokeOnboardingFn(
        'update-onboarding-step',
        { step_name: STEP_KEYS.STRIPE_SUBMITTED, step_data: { stub: true } },
        { navigate }
      );
      if (error) {
        setSubmitError(error.message || 'Something went wrong. Please try again.');
        setBusy(false);
        return;
      }
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen7] stub advance failed', err);
      setSubmitError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.STRIPE_SUBMITTED}
      stepsCompleted={onboarding?.steps_completed}
      title="Payment setup"
      subtitle="You'll be redirected to Stripe to verify your identity, provide tax information, and connect your bank account. Stripe handles all sensitive financial information — enrops never sees your SSN or bank details."
    >
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Placeholder — Stripe Connect not yet live</p>
        <p className="mt-1 text-xs leading-relaxed">
          Payment setup will be enabled when Stripe Connect is configured. For now this
          button just advances the wizard so the rest of onboarding can be tested.
        </p>
      </div>

      <ScreenError>{submitError}</ScreenError>

      <PrimaryButton type="button" onClick={handleContinue} disabled={busy}>
        {busy ? 'Saving…' : 'Continue (placeholder) →'}
      </PrimaryButton>
    </WizardLayout>
  );
}
