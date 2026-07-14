// Step name constants for the contractor onboarding wizard.
//
// These keys must match exactly the values the edge functions write into
// `contractor_onboarding_status.steps_completed` JSONB. A typo here silently
// breaks the gate check that decides when overall_status flips to 'complete'.
// Import from this file everywhere the wizard names a step.

export const STEP_KEYS = {
  WELCOME: 'welcome',
  CHECKR_SUBMITTED: 'checkr_submitted',
  ORS_CERTIFICATION: 'ors_certification',
  AGREEMENT_SIGNED: 'agreement_signed',
  POLICIES_ACKNOWLEDGED: 'policies_acknowledged',
  ADDITIONAL_ACKS: 'additional_acks',
  TRAINING_COMPLETED: 'training_completed',
  STRIPE_SUBMITTED: 'stripe_submitted',
  EMERGENCY_AND_PREFS: 'emergency_and_prefs',
};

export const STEP_ORDER = [
  STEP_KEYS.WELCOME,
  STEP_KEYS.CHECKR_SUBMITTED,
  STEP_KEYS.ORS_CERTIFICATION,
  STEP_KEYS.AGREEMENT_SIGNED,
  STEP_KEYS.POLICIES_ACKNOWLEDGED,
  STEP_KEYS.ADDITIONAL_ACKS,
  STEP_KEYS.TRAINING_COMPLETED,
  STEP_KEYS.STRIPE_SUBMITTED,
  STEP_KEYS.EMERGENCY_AND_PREFS,
];

export const STEP_LABELS = {
  [STEP_KEYS.WELCOME]: 'Welcome',
  [STEP_KEYS.CHECKR_SUBMITTED]: 'Background check',
  [STEP_KEYS.ORS_CERTIFICATION]: 'Business eligibility',
  [STEP_KEYS.AGREEMENT_SIGNED]: 'Contractor agreement',
  [STEP_KEYS.POLICIES_ACKNOWLEDGED]: 'Policies',
  [STEP_KEYS.ADDITIONAL_ACKS]: 'Additional acknowledgments',
  [STEP_KEYS.TRAINING_COMPLETED]: 'Training',
  [STEP_KEYS.STRIPE_SUBMITTED]: 'Payment setup',
  [STEP_KEYS.EMERGENCY_AND_PREFS]: 'Emergency contact and preferences',
};

// Some steps are only present when a per-org toggle is on. The background check
// (organizations.background_check_config.enabled) and training videos
// (organizations.training_config.enabled AND at least one active required video)
// are both optional. effectiveStepOrder returns the canonical order with any
// disabled steps removed, so navigation, progress, and the completion gate all
// agree on the same list. `trainingEnabled` must already fold in the "has a
// required video" check (an enabled-but-empty library drops the step, matching
// the server gate). Pass this order into stepIndex/stepNumber below.
export function effectiveStepOrder({ bgcEnabled = true, trainingEnabled = false } = {}) {
  return STEP_ORDER.filter((key) => {
    if (key === STEP_KEYS.CHECKR_SUBMITTED) return bgcEnabled;
    if (key === STEP_KEYS.TRAINING_COMPLETED) return trainingEnabled;
    return true;
  });
}

export function stepIndex(stepKey, order = STEP_ORDER) {
  return order.indexOf(stepKey);
}

export function stepNumber(stepKey, order = STEP_ORDER) {
  const i = stepIndex(stepKey, order);
  return i < 0 ? null : i + 1;
}

// Current contractor agreement version. Matches the seeded row in
// legal_documents. We send the version; the edge function looks up canonical
// body text by version and snapshots it server-side.
export const CONTRACTOR_AGREEMENT_VERSION = 'v2.0_2026-06-15';
