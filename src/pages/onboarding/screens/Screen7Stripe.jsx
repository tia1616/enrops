import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, ScreenError, SecondaryButton } from '../WizardLayout.jsx';

// Screen 7 — Stripe Connect (real).
//
// Three entry paths controlled by query params:
//   ?return=true   → contractor just came back from Stripe successfully.
//                    Mark step + show success state.
//   ?refresh=true  → Stripe says the link expired. Get a fresh one and
//                    redirect again.
//   (none)         → first visit OR they bailed before finishing. Show the
//                    Start button. If they already have a Stripe account,
//                    Function 10 reuses it and returns a fresh link.
//
// We never call the Stripe JS SDK from the browser — Function 10 is the
// authorized path to talk to the Stripe API.

export default function Screen7Stripe({ slug, instructor, onboarding, onAdvance }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | refreshing-status

  const returnFlag = searchParams.get('return') === 'true';
  const refreshFlag = searchParams.get('refresh') === 'true';
  const stripeStatus = onboarding?.stripe_connect_status;
  const payoutsEnabled = onboarding?.stripe_payouts_enabled === true;
  const alreadyMarked = Boolean(onboarding?.steps_completed?.[STEP_KEYS.STRIPE_SUBMITTED]);

  // Auto-mark the step when Stripe sends them back with ?return=true.
  useEffect(() => {
    if (!returnFlag || alreadyMarked || busy) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const { error } = await invokeOnboardingFn(
          'update-onboarding-step',
          { step_name: STEP_KEYS.STRIPE_SUBMITTED, step_data: {} },
          { navigate }
        );
        if (cancelled) return;
        if (error) {
          setSubmitError(error.message || 'Something went wrong saving your progress.');
          setBusy(false);
          return;
        }
        // Clear ?return=true so a refresh doesn't re-mark.
        setSearchParams({}, { replace: true });
        onAdvance();
      } catch (err) {
        if (isHandledRedirect(err)) return;
        if (!cancelled) {
          setSubmitError('Something went wrong saving your progress.');
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnFlag, alreadyMarked]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?refresh=true → ask Function 10 for a fresh link immediately.
  useEffect(() => {
    if (!refreshFlag) return;
    redirectToStripe({ refresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshFlag]);

  async function redirectToStripe({ refresh = false } = {}) {
    if (busy) return;
    setBusy(true);
    setSubmitError('');
    try {
      const { data, error } = await invokeOnboardingFn(
        'create-stripe-connect-account',
        { origin: window.location.origin },
        { navigate }
      );
      if (error || !data?.onboarding_url) {
        setSubmitError(
          (error && error.message) ||
            "Couldn't start Stripe setup. Please try again in a minute."
        );
        setBusy(false);
        return;
      }
      // Same tab — Stripe brings them back via return_url / refresh_url.
      window.location.href = data.onboarding_url;
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen7] create-stripe-connect-account failed', err);
      setSubmitError("Couldn't start Stripe setup. Please try again.");
      setBusy(false);
    }
  }

  async function refreshStatus() {
    if (phase === 'refreshing-status') return;
    setPhase('refreshing-status');
    setSubmitError('');
    try {
      const { data, error, status } = await invokeOnboardingFn(
        'refresh-stripe-status',
        {},
        { navigate }
      );
      if (error) {
        if (status === 502) {
          setSubmitError("Couldn't reach Stripe right now. Try again in a few minutes.");
        } else if (status === 400) {
          setSubmitError("You haven't started Stripe setup yet. Click the button above.");
        } else {
          setSubmitError(error.message || "Couldn't refresh status.");
        }
        setPhase('idle');
        return;
      }
      // Re-fetch onboarding so the screen re-renders with the new state.
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      setSubmitError("Couldn't refresh status.");
      setPhase('idle');
    }
  }

  // payouts_disabled regression state — different copy + CTA.
  if (stripeStatus === 'payouts_disabled') {
    return (
      <WizardLayout
        slug={slug}
        currentStep={STEP_KEYS.STRIPE_SUBMITTED}
        stepsCompleted={onboarding?.steps_completed}
        title="Payment setup"
        subtitle="Stripe needs to re-verify your account. Click below to update your info."
      >
        <ScreenError>{submitError}</ScreenError>
        <PrimaryButton type="button" onClick={() => redirectToStripe()} disabled={busy}>
          {busy ? 'Loading…' : 'Update on Stripe →'}
        </PrimaryButton>
      </WizardLayout>
    );
  }

  // pending_verification — show status + manual refresh button.
  if (stripeStatus === 'pending_verification') {
    return (
      <WizardLayout
        slug={slug}
        currentStep={STEP_KEYS.STRIPE_SUBMITTED}
        stepsCompleted={onboarding?.steps_completed}
        title="Payment setup"
        subtitle="Payment setup in progress. Stripe may need additional info."
      >
        <a
          href="https://dashboard.stripe.com/express"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-sm font-semibold text-neutral-900 hover:underline"
        >
          Open Stripe Express dashboard ↗
        </a>
        <ScreenError>{submitError}</ScreenError>
        <PrimaryButton
          type="button"
          onClick={refreshStatus}
          disabled={phase === 'refreshing-status'}
        >
          {phase === 'refreshing-status' ? 'Checking…' : 'Check current status'}
        </PrimaryButton>
        {payoutsEnabled && (
          <p className="mt-3 text-sm text-green-700">
            Stripe is ready — continuing in a moment.
          </p>
        )}
      </WizardLayout>
    );
  }

  // First visit OR they came back without ?return=true (e.g., closed the tab
  // before Stripe redirected them). If alreadyMarked, show the success state.
  if (alreadyMarked && !returnFlag) {
    return (
      <WizardLayout
        slug={slug}
        currentStep={STEP_KEYS.STRIPE_SUBMITTED}
        stepsCompleted={onboarding?.steps_completed}
        title="Payment setup"
      >
        <p className="text-sm text-neutral-700">Payment setup submitted ✓</p>
        <PrimaryButton type="button" onClick={onAdvance}>
          Continue →
        </PrimaryButton>
      </WizardLayout>
    );
  }

  // Plain first visit or refreshFlag still resolving.
  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.STRIPE_SUBMITTED}
      stepsCompleted={onboarding?.steps_completed}
      title="Payment setup"
      subtitle="You'll be redirected to Stripe to verify your identity, provide tax information, and connect your bank account. Stripe handles all sensitive financial information — enrops never sees your SSN or bank details."
    >
      <ScreenError>{submitError}</ScreenError>
      <PrimaryButton type="button" onClick={() => redirectToStripe()} disabled={busy}>
        {busy ? 'Loading…' : 'Set up payment →'}
      </PrimaryButton>
    </WizardLayout>
  );
}
