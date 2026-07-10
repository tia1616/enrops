import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { useOnboardingConfig } from '../OnboardingConfigContext.jsx';
import WizardLayout, { PrimaryButton, ScreenError } from '../WizardLayout.jsx';

// Screen 2 — Background Check.
//
// Provider-neutral (2026-07-09): the check is run through whatever provider the
// org configured in Settings -> Background checks (provider name, link, and
// instructions live on organizations.background_check_config). This screen just
// tells the contractor how to complete it and lets them continue; the gate
// check holds them at pending_background_check until an admin marks the check
// clear (via Instructors -> Upload prior BG check, which sets
// checkr_status='clear' + background_check_source='admin_uploaded'). When an
// automated provider is wired later, this screen becomes the embedded flow.
//
// This screen only renders when the org has background checks turned on — the
// step is removed from the wizard entirely when disabled (see WizardHost /
// effectiveStepOrder), so there's no "off" branch to handle here.
//
// States:
//   1. First visit: show the provider instructions + Continue. Continue marks
//      checkr_submitted via update-onboarding-step so the wizard doesn't
//      keep landing them here.
//   2. Return visit (checkr_submitted already set): show the status note +
//      Continue to resume from where they left off.

const STATUS_LABEL = {
  pending: 'pending',
  clear: 'clear',
  consider: 'consider',
};

export default function Screen2BackgroundCheck({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const { backgroundCheck } = useOnboardingConfig();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const alreadySubmitted = Boolean(onboarding?.steps_completed?.[STEP_KEYS.CHECKR_SUBMITTED]);
  const checkrStatus = onboarding?.checkr_status;

  // Provider copy from Settings -> Background checks. All optional; we fall back
  // to neutral guidance when a field is unset.
  const providerName = (backgroundCheck?.provider_name || '').trim();
  const providerUrl = (backgroundCheck?.provider_url || '').trim();
  const instructions = (backgroundCheck?.instructions || '').trim();

  async function acknowledgeAndContinue() {
    if (busy) return;
    setBusy(true);
    setSubmitError('');
    try {
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
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen2] acknowledge failed', err);
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
        <PrimaryButton type="button" onClick={onAdvance}>
          Continue →
        </PrimaryButton>
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
      subtitle="A background check is required before you can be assigned to work with children."
    >
      {instructions ? (
        <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800">{instructions}</p>
      ) : (
        <p className="text-sm leading-relaxed text-neutral-800">
          {providerName
            ? `Complete your background check with ${providerName} using the link below. If you have any trouble, contact your program.`
            : 'Your program will send you the details to complete your background check. If you have any questions, reach out to them directly.'}
        </p>
      )}

      {providerUrl && (
        <a
          href={providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
        >
          {providerName ? `Start your check with ${providerName}` : 'Start your background check'} →
        </a>
      )}

      <p className="mt-3 text-xs leading-relaxed text-neutral-500">
        You can continue with the rest of your onboarding now — your background check will be reviewed in parallel.
      </p>

      <ScreenError>{submitError}</ScreenError>

      <PrimaryButton type="button" onClick={acknowledgeAndContinue} disabled={busy}>
        {busy ? 'Saving…' : 'Continue →'}
      </PrimaryButton>
    </WizardLayout>
  );
}
