import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, ScreenError } from '../WizardLayout.jsx';

// Screen 2 — Background Check.
//
// Interim mode (2026-05-27): the Checkr integration isn't fully wired yet,
// so we don't trigger create-checkr-candidate from the wizard. Instead we
// show a message telling the contractor to look for the Checkr email
// (admin/Program Manager sends it manually via Checkr's dashboard). The
// contractor can continue past this step to fill out the rest of the
// paperwork; the gate check holds them at pending_background_check until
// admin marks BGC cleared (via /admin/contacts Upload prior BG check, which
// uses checkr_status='clear' + background_check_source='admin_uploaded').
//
// States:
//   1. First visit: show the explanatory message + Continue. Continue marks
//      checkr_submitted via update-onboarding-step so the wizard doesn't
//      keep landing them here.
//   2. Return visit (checkr_submitted already set): show the status note +
//      Continue to resume from where they left off.
//
// Admin-uploaded BG check: if checkr_status is already 'clear' and
// steps_completed.checkr_submitted is set, the wizard short-circuits through
// this screen because WizardHost resumes at the first incomplete step.

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
      subtitle="A background check is required for all contractors who work with children."
    >
      <p className="text-sm leading-relaxed text-neutral-800">
        Complete the Checkr invitation for the background check in your email. If you have not received it, please contact your Program Manager.
      </p>
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
