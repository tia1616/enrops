import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { STEP_KEYS, effectiveStepOrder, stepIndex } from '../../lib/onboardingSteps.js';
import { OnboardingConfigContext } from './OnboardingConfigContext.jsx';
import Screen1Welcome from './screens/Screen1Welcome.jsx';
import Screen2BackgroundCheck from './screens/Screen2BackgroundCheck.jsx';
import Screen3ORS from './screens/Screen3ORS.jsx';
import Screen4Agreement from './screens/Screen4Agreement.jsx';
import Screen5Policies from './screens/Screen5Policies.jsx';
import Screen6Additional from './screens/Screen6Additional.jsx';
import Screen7Stripe from './screens/Screen7Stripe.jsx';
import Screen8EmergencyAndPrefs from './screens/Screen8EmergencyAndPrefs.jsx';
import ScreenTraining from './screens/ScreenTraining.jsx';
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

// Resolve which step the wizard should mount on. The DB's current_step is
// an INTEGER (1..8); STEP_ORDER is an array of step-key STRINGS. Naively
// checking STEP_ORDER.includes(currentStep) when currentStep is an integer
// always returns false, which used to drop a returning contractor back to
// Screen 1 every time the page reloaded (notably after the Stripe redirect).
// Resume rule: first step that isn't marked complete in steps_completed.
// If everything's done, return the last step — the terminal-status guard
// in render will route to CompletionScreen anyway. `order` is the effective
// step order for this org (a disabled background check drops that step).
function resolveInitialStep(initialStep, onboarding, order) {
  // 1. Explicit URL param wins (already a string).
  if (typeof initialStep === 'string' && order.includes(initialStep)) {
    return initialStep;
  }
  // 2. First step not present in steps_completed.
  const stepsCompleted = onboarding?.steps_completed || {};
  const firstIncomplete = order.find((key) => !stepsCompleted[key]);
  if (firstIncomplete) return firstIncomplete;
  // 3. Everything done — fall through; render guard handles it.
  return order[order.length - 1];
}

export default function WizardHost({ slug, instructor, onboarding: initialOnboarding, initialStep, backgroundCheck, trainingEnabled = false, trainingVideos = [], onDismiss }) {
  const navigate = useNavigate();
  const [onboarding, setOnboarding] = useState(initialOnboarding);

  // Effective step order for this org. Background checks and training videos are
  // each optional per-org steps — when off (or, for training, enabled-but-empty),
  // the step is removed from navigation, progress, and (server-side, in
  // gateCheck) the completion gate. trainingEnabled already folds in the
  // "has a required video" check (see OnboardingRouter).
  const bgcEnabled = backgroundCheck?.enabled !== false;
  const stepOrder = useMemo(() => effectiveStepOrder({ bgcEnabled, trainingEnabled }), [bgcEnabled, trainingEnabled]);

  const [currentStep, setCurrentStep] = useState(() =>
    resolveInitialStep(initialStep, onboarding, stepOrder)
  );

  // Local back-nav: just shows the prior screen without writing to the DB.
  // If the contractor edits and submits on the prior screen, that submit
  // path overwrites; if they don't, they can advance again without any
  // state churn. Disabled on Screen 1 (no prior) and on terminal-status
  // completion (currentStep is null).
  const onBack = useCallback(() => {
    if (!currentStep) return;
    const idx = stepIndex(currentStep, stepOrder);
    if (idx <= 0) return;
    setCurrentStep(stepOrder[idx - 1]);
  }, [currentStep, stepOrder]);

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

    if (fresh.current_step && stepOrder.includes(fresh.current_step)) {
      setCurrentStep(fresh.current_step);
    } else {
      const idx = stepIndex(currentStep, stepOrder);
      const next = stepOrder[idx + 1];
      if (next) setCurrentStep(next);
    }
  }, [instructor.id, navigate, slug, currentStep, stepOrder]);

  const configValue = useMemo(
    () => ({ stepOrder, bgcEnabled, backgroundCheck: backgroundCheck ?? { enabled: bgcEnabled }, trainingEnabled, trainingVideos }),
    [stepOrder, bgcEnabled, backgroundCheck, trainingEnabled, trainingVideos],
  );

  if (!currentStep || TERMINAL_STATUSES.has(onboarding?.overall_status)) {
    // onAdvance does the re-fetch + re-evaluation work the refresh button
    // needs, so we pass it as onRefresh. Pending variants of CompletionScreen
    // call onRefresh; the complete variant uses onDismiss / Link instead.
    return (
      <OnboardingConfigContext.Provider value={configValue}>
        <CompletionScreen
          slug={slug}
          onboarding={onboarding}
          onDismiss={onDismiss}
          onRefresh={onAdvance}
        />
      </OnboardingConfigContext.Provider>
    );
  }

  // Only expose onBack when there's a prior step to go to.
  const canGoBack = stepIndex(currentStep, stepOrder) > 0;
  const common = { slug, instructor, onboarding, onAdvance, onBack: canGoBack ? onBack : undefined };
  const screen = (() => {
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
      case STEP_KEYS.TRAINING_COMPLETED:
        return <ScreenTraining {...common} />;
      case STEP_KEYS.STRIPE_SUBMITTED:
        return <Screen7Stripe {...common} />;
      case STEP_KEYS.EMERGENCY_AND_PREFS:
        return <Screen8EmergencyAndPrefs {...common} />;
      default:
        // Unknown step — fall back to the first screen.
        return <Screen1Welcome {...common} />;
    }
  })();

  return (
    <OnboardingConfigContext.Provider value={configValue}>
      {screen}
    </OnboardingConfigContext.Provider>
  );
}
