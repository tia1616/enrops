import { createContext, useContext } from 'react';
import { STEP_ORDER } from '../../lib/onboardingSteps.js';

// Per-org onboarding config, provided by WizardHost and consumed by
// WizardLayout (for the effective step order / progress) and Screen2 (for the
// background-check provider copy). Falls back to sensible defaults so a screen
// rendered outside the provider (e.g. in isolation) still works.
const DEFAULTS = {
  stepOrder: STEP_ORDER,
  bgcEnabled: true,
  // { enabled, provider_name, provider_url, instructions } — the instructor-
  // facing subset of organizations.background_check_config.
  backgroundCheck: { enabled: true },
  // { <document_key>: boolean } — the instructor-facing resolution of
  // organizations.instructor_document_config, via
  // public_org_directory.instructor_documents_public. Read through
  // isDocumentEnabled, never directly: an ABSENT key means ON, so the empty
  // default below correctly means "every document is required".
  documentConfig: {},
  // Whether the training step is live for this org (enabled AND at least one
  // active required video). When false, the step is dropped everywhere.
  trainingEnabled: false,
  // The active required training videos the instructor must complete, in order:
  // [{ id, title, has_quiz, duration_seconds }]. Empty when trainingEnabled is false.
  trainingVideos: [],
};

export const OnboardingConfigContext = createContext(DEFAULTS);

export function useOnboardingConfig() {
  return useContext(OnboardingConfigContext) ?? DEFAULTS;
}
