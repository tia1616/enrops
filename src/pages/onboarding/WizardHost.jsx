import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { STEP_KEYS, STEP_ORDER, stepIndex } from '../../lib/onboardingSteps.js';
import Screen1Welcome from './screens/Screen1Welcome.jsx';
import Screen2BackgroundCheck from './screens/Screen2BackgroundCheck.jsx';
import Screen3ORS from './screens/Screen3ORS.jsx';
import Screen4Agreement from './screens/Screen4Agreement.jsx';
import Screen5Policies from './screens/Screen5Policies.jsx';
import Screen6Additional from './screens/Screen6Additional.jsx';
import Screen7Stripe from './screens/Screen7Stripe.jsx';
import Screen8EmergencyAndPrefs from './screens/Screen8EmergencyAndPrefs.jsx';
import CompletionScreen from './CompletionScreen.jsx';

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

export default function WizardHost({ slug, instructor, onboarding: initialOnboarding, initialStep, onDismiss }) {
  const navigate = useNavigate();
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [currentStep, setCurrentStep] = useState(() => {
    if (initialStep && STEP_ORDER.includes(initialStep)) return initialStep;
    return onboarding?.current_step && STEP_ORDER.includes(onboarding.current_step)
      ? onboarding.current_step
      : STEP_KEYS.WELCOME;
  });

  // Local back-nav: just shows the prior screen without writing to the DB.
  // If the contractor edits and submits on the prior screen, that submit
  // path overwrites; if they don't, they can advance again without any
  // state churn. Disabled on Screen 1 (no prior) and on terminal-status
  // completion (currentStep is null).
  const onBack = useCallback(() => {
    if (!currentStep) return;
    const idx = stepIndex(currentStep);
    if (idx <= 0) return;
    setCurrentStep(STEP_ORDER[idx - 1]);
  }, [currentStep]);

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
    return <CompletionScreen slug={slug} onboarding={onboarding} onDismiss={onDismiss} />;
  }

  // Only expose onBack when there's a prior step to go to.
  const canGoBack = stepIndex(currentStep) > 0;
  const common = { slug, instructor, onboarding, onAdvance, onBack: canGoBack ? onBack : undefined };
  switch (currentStep) {
    case STEP_KEYS.WELCOME:
      return <Screen1Welcome {...common} />;
    case STEP_KEYS.CHECKR_SUBMITTED:
      return <Screen2BackgroundCheck {...common} />;
    case STEP_KEYS.ORS_CERTIFICATION:
      return <Screen3ORS {...common} />;
    case STEP_KEYS.AGREEMENT_SIGNED:
      return <Screen4Agreement {...common} />;
    case STEP_KEYS.POLICIES_ACKNOWLEDGED:
      return <Screen5Policies {...common} />;
    case STEP_KEYS.ADDITIONAL_ACKS:
      return <Screen6Additional {...common} />;
    case STEP_KEYS.STRIPE_SUBMITTED:
      return <Screen7Stripe {...common} />;
    case STEP_KEYS.EMERGENCY_AND_PREFS:
      return <Screen8EmergencyAndPrefs {...common} />;
    default:
      // Unknown step — fall back to the first screen.
      return <Screen1Welcome {...common} />;
  }
}
