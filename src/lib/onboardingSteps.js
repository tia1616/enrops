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
  // Named for the document that now backs it, not for the per-state eligibility
  // step that was cancelled. One name for one thing: an instructor sees this in
  // the wizard progress and the provider sees the same words in Settings.
  [STEP_KEYS.ORS_CERTIFICATION]: 'Independent contractor status',
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
//
// The two document screens work the same way, one level down: each renders a
// fixed set of documents from organizations.instructor_document_config, and a
// provider can now switch individual documents off. A screen with none left must
// be dropped rather than rendered empty — an instructor staring at a page with
// no documents and a disabled Continue has no way forward. Callers pass the
// already-resolved booleans (see stepHasEnabledDocuments in
// lib/instructorDocuments.js) so the "which documents exist" rule has one home.
//
// BOTH DEFAULT TO TRUE. A caller that knows nothing about the config gets
// today's behaviour — every document required — rather than silently dropping
// two steps' worth of acknowledgments.
// STRIPE PAYMENT SETUP is the fourth optional step, and the one that was
// unconditional longest. Only a provider who actually pays instructors THROUGH
// Stripe needs it; everyone else pays by cheque, transfer or payroll software,
// and their instructor was still walked through handing Stripe an SSN and bank
// details for payouts that would never arrive.
//
// Driven by organizations.instructor_pay_enabled — an existing circuit breaker
// that is already true for the one provider using Stripe pay and false by column
// default for everyone else, and which pay-instructor already refuses to move
// money without. Deliberately NOT instructor_pay_model: that column already
// means three things and this build's spec says not to add a fourth.
//
// DEFAULTS TO TRUE so a caller that passes nothing behaves exactly as the wizard
// did before this change. The real value always arrives (public_org_directory),
// and gateCheck reads organizations directly, so the default is a
// belt-and-braces for isolated renders rather than a live path.
// CONTRACTOR STATUS is the fifth optional step, and it became optional by
// becoming a DOCUMENT (2026-08-21). Until then Screen3ORS was hardcoded into
// every provider's flow: always shown, backed by nothing a provider could see,
// edit or switch off. It is now the `contractor_status` document on its own
// screen, so it drops out by the same rule as policies and additional acks —
// nothing published and switched off means nothing to render.
//
// DEFAULTS TO TRUE, like the other document steps, so a caller that knows
// nothing about the config keeps the behaviour every instructor has had so far.
export function effectiveStepOrder({
  bgcEnabled = true,
  trainingEnabled = false,
  contractorStatusEnabled = true,
  policiesEnabled = true,
  additionalEnabled = true,
  stripePayEnabled = true,
} = {}) {
  return STEP_ORDER.filter((key) => {
    if (key === STEP_KEYS.CHECKR_SUBMITTED) return bgcEnabled;
    if (key === STEP_KEYS.TRAINING_COMPLETED) return trainingEnabled;
    if (key === STEP_KEYS.ORS_CERTIFICATION) return contractorStatusEnabled;
    if (key === STEP_KEYS.POLICIES_ACKNOWLEDGED) return policiesEnabled;
    if (key === STEP_KEYS.ADDITIONAL_ACKS) return additionalEnabled;
    if (key === STEP_KEYS.STRIPE_SUBMITTED) return stripePayEnabled;
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

// CONTRACTOR_AGREEMENT_VERSION was here, hardcoded to one provider's version
// string ('v2.0_2026-06-15'). Removed 2026-08-11.
//
// It pinned the fetch on Screen 4, named the stored PDF, and was the fallback
// sent to submit-agreement. That worked only while a single provider had any
// documents at all: for anyone else the fetch 404'd, and it kept 404ing even
// after they wrote their own agreement unless they named the version
// identically. The screen now asks for the org's most recently published
// agreement and carries that version through signing, so which version is
// current has ONE definition (newest row for the org+key, the rule
// get-legal-document already applied everywhere else) instead of two.
//
// Deliberately not replaced with a per-org constant or a default. There is
// nothing for a platform-wide value to be correct about here.
