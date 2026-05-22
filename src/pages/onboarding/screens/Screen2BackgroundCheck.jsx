import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, ScreenError } from '../WizardLayout.jsx';

// Screen 2 — Background Check. Two states:
//   1. First visit: button starts the Checkr flow. We POST create-checkr-
//      candidate, then mark the step via update-onboarding-step, then open
//      invitation_url in a new tab. The wizard advances to Screen 3 either
//      way — Checkr's report comes back asynchronously via the webhook.
//   2. Return visit (checkr_submitted already set, or checkr_status non-null):
//      show the current status + "Continue" so the contractor can pick up
//      where they left off without re-submitting.
//
// Admin-uploaded BG check (Feature A): if checkr_status is already 'clear'
// and steps_completed.checkr_submitted is set, the wizard short-circuits
// through this screen because OnboardingRouter / WizardHost re-reads
// onboarding state and the gate check advances current_step automatically.

const STATUS_LABEL = {
  pending: 'pending',
  clear: 'clear',
  consider: 'consider',
};

export default function Screen2BackgroundCheck({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const alreadySubmitted = Boolean(onboarding?.steps_completed?.[STEP_KEYS.CHECKR_SUBMITTED]);
  const checkrStatus = onboarding?.checkr_status;

  async function startCheckr() {
    if (busy) return;
    setBusy(true);
    setSubmitError('');
    try {
      const { data: createData, error: createErr } = await invokeOnboardingFn(
        'create-checkr-candidate',
        {},
        { navigate }
      );
      if (createErr) {
        setSubmitError(createErr.message || 'Something went wrong. Please try again.');
        setBusy(false);
        return;
      }

      const { error: markErr } = await invokeOnboardingFn(
        'update-onboarding-step',
        { step_name: STEP_KEYS.CHECKR_SUBMITTED, step_data: {} },
        { navigate }
      );
      if (markErr) {
        setSubmitError(markErr.message || 'Something went wrong marking the step.');
        setBusy(false);
        return;
      }

      // Open the Checkr hosted form in a new tab so the wizard stays mounted.
      if (createData?.invitation_url) {
        window.open(createData.invitation_url, '_blank', 'noopener,noreferrer');
      }

      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen2] start failed', err);
      setSubmitError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  if (alreadySubmitted) {
    const statusText = checkrStatus ? STATUS_LABEL[checkrStatus] || checkrStatus : 'pending';
    return (
      <WizardLayout
        slug={slug}
        currentStep={STEP_KEYS.CHECKR_SUBMITTED}
        stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
        title="Background check"
      >
        <p className="text-sm text-neutral-700">
          Background check submitted ✓ — Status: <span className="font-semibold">{statusText}</span>
        </p>
        <button
          type="button"
          onClick={onAdvance}
          className="mt-6 w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
        >
          Continue →
        </button>
      </WizardLayout>
    );
  }

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.CHECKR_SUBMITTED}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Background check"
      subtitle="J2S requires a background check for all contractors who work with children. You'll be redirected to our partner to complete a short form. This runs in the background while you continue."
    >
      <p className="text-xs leading-relaxed text-neutral-500">
        Checkr collects your DOB, SSN, address, and FCRA disclosure + consent in their hosted
        flow. enrops never sees this data.
      </p>

      <ScreenError>{submitError}</ScreenError>

      <PrimaryButton type="button" onClick={startCheckr} disabled={busy}>
        {busy ? 'Starting…' : 'Start background check →'}
      </PrimaryButton>
    </WizardLayout>
  );
}
