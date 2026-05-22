import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { STEP_KEYS, STEP_ORDER, stepIndex } from '../../lib/onboardingSteps.js';
import Screen1Welcome from './screens/Screen1Welcome.jsx';
import Screen3ORS from './screens/Screen3ORS.jsx';
import Screen8EmergencyAndPrefs from './screens/Screen8EmergencyAndPrefs.jsx';
import CompletionScreen from './CompletionScreen.jsx';
import WizardLayout, { PrimaryButton } from './WizardLayout.jsx';

// Dispatches to the right screen based on currentStep and re-fetches
// contractor_onboarding_status after every advance so the wizard sees any
// gate-check side effects the edge functions wrote (e.g. overall_status
// flipping to pending_background_check when Screen 8 completes).
//
// Terminal statuses (complete, pending_background_check, pending_stripe,
// payouts_disabled) short-circuit to the completion screen variants.

const TERMINAL_STATUSES = new Set([
  'complete',
  'pending_background_check',
  'pending_stripe',
  'payouts_disabled',
]);

export default function WizardHost({ slug, instructor, onboarding: initialOnboarding, initialStep }) {
  const navigate = useNavigate();
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [currentStep, setCurrentStep] = useState(() => {
    if (initialStep && STEP_ORDER.includes(initialStep)) return initialStep;
    return onboarding?.current_step && STEP_ORDER.includes(onboarding.current_step)
      ? onboarding.current_step
      : STEP_KEYS.WELCOME;
  });

  const onAdvance = useCallback(async () => {
    // After any screen submits, re-read the onboarding row so we pick up
    // gate-check side effects (the edge function may have moved current_step
    // forward, or flipped overall_status to one of the terminal values).
    const { data: fresh } = await supabase
      .from('contractor_onboarding_status')
      .select(
        'overall_status, current_step, steps_completed, checkr_status, stripe_connect_status, stripe_payouts_enabled'
      )
      .eq('instructor_id', instructor.id)
      .single();
    if (!fresh) return;
    setOnboarding(fresh);

    if (TERMINAL_STATUSES.has(fresh.overall_status)) {
      // Render the completion variant — currentStep no longer matters.
      setCurrentStep(null);
      return;
    }
    if (fresh.overall_status === 'declined') {
      navigate(`/${slug}/onboarding/declined`, { replace: true });
      return;
    }
    if (fresh.overall_status === 'abandoned') {
      navigate(`/${slug}/onboarding/abandoned`, { replace: true });
      return;
    }

    if (fresh.current_step && STEP_ORDER.includes(fresh.current_step)) {
      setCurrentStep(fresh.current_step);
    } else {
      const idx = stepIndex(currentStep);
      const next = STEP_ORDER[idx + 1];
      if (next) setCurrentStep(next);
    }
  }, [instructor.id, navigate, slug, currentStep]);

  if (!currentStep || TERMINAL_STATUSES.has(onboarding?.overall_status)) {
    return <CompletionScreen slug={slug} onboarding={onboarding} />;
  }

  const common = { slug, instructor, onboarding, onAdvance };
  switch (currentStep) {
    case STEP_KEYS.WELCOME:
      return <Screen1Welcome {...common} />;
    case STEP_KEYS.ORS_CERTIFICATION:
      return <Screen3ORS {...common} />;
    case STEP_KEYS.EMERGENCY_AND_PREFS:
      return <Screen8EmergencyAndPrefs {...common} />;
    case STEP_KEYS.CHECKR_SUBMITTED:
    case STEP_KEYS.AGREEMENT_SIGNED:
    case STEP_KEYS.POLICIES_ACKNOWLEDGED:
    case STEP_KEYS.ADDITIONAL_ACKS:
    case STEP_KEYS.STRIPE_SUBMITTED:
      return <ComingSoonStep step={currentStep} {...common} />;
    default:
      return <ComingSoonStep step={currentStep} {...common} />;
  }
}

// Temporary placeholder for screens not yet built (waves 4 + 5). Lets the
// wizard run end-to-end so Screen 1 → 3 → 8 → completion can be tested while
// 2/4/5/6/7 are still being built.
function ComingSoonStep({ step, slug, instructor, onboarding, onAdvance }) {
  return (
    <WizardLayout
      slug={slug}
      currentStep={step}
      stepsCompleted={onboarding?.steps_completed}
      title="Screen coming soon"
      subtitle={`This step (${step}) is being built. Click below to skip it for now.`}
    >
      <p className="text-sm text-neutral-600">
        Hi {instructor.first_name || 'there'} — Phase B-3 finishes this screen in
        the next commit wave.
      </p>
      <PrimaryButton type="button" onClick={onAdvance}>
        Skip for now →
      </PrimaryButton>
    </WizardLayout>
  );
}
