// Which instructor onboarding documents a provider actually uses.
//
// SERVER MIRROR of src/lib/instructorDocuments.js (isDocumentEnabled and
// friends). The browser half decides what the wizard SHOWS; this half decides
// what the completion gate REQUIRES. If only the browser half existed, a
// provider could turn a whole screen off, the wizard would skip it, and
// gateCheck would keep waiting forever for a step key nobody can now write —
// onboarding would never reach 'complete'. Change one, change the other.
//
// Deliberately NOT importing the .js file: edge functions run on Deno and pull
// their deps over the network, and reaching into src/ would couple the deployed
// function to the frontend bundle's module graph. The duplicated list is small,
// frozen (the keys are a contract read by name by three wizard screens), and
// covered by a test on the browser side.
//
// ABSENT MEANS ON. Only an explicit `false` turns a document off, so a document
// a provider has not written yet still blocks onboarding rather than being
// silently treated as "not used". Absence is not a decision.
//
// WITH ONE EXCEPTION: contractor_status is opt-in and needs an explicit `true`.
// It is new and optional, so an absent value means "never offered" rather than
// "not yet written" — and defaulting it on would block every existing provider's
// instructors on a document nobody has been asked to write. The full argument is
// in the browser half; this comment exists so a reader of only this file does not
// "fix" the asymmetry back out.

export type DocumentStep = 'agreement' | 'policies' | 'additional';

export const DOCUMENTS_BY_STEP: Record<DocumentStep, string[]> = {
  // Signed, not acknowledged. submit-agreement requires it and onboarding cannot
  // complete without it, so it is never toggleable — see ALWAYS_ON below.
  agreement: ['contractor_agreement'],
  policies: ['pay_schedule', 'attendance_policy', 'code_of_conduct'],
  additional: [
    'contractor_status',
    'mandatory_reporter_ack',
    'photo_video_release',
    'vehicle_driving_ack',
  ],
};

const ALWAYS_ON = new Set(['contractor_agreement']);

const DEFAULT_OFF = new Set(['contractor_status']);

export type DocumentConfig = Record<string, unknown> | null | undefined;

export function isDocumentEnabled(config: DocumentConfig, key: string): boolean {
  if (ALWAYS_ON.has(key)) return true;
  // Strict === true, matching the browser half: a stray truthy value in the
  // JSONB must not switch on a legal acknowledgment nobody chose.
  if (DEFAULT_OFF.has(key)) return config?.[key] === true;
  return config?.[key] !== false;
}

/**
 * Does this screen still have at least one document on?
 *
 * When false the screen is skipped in the wizard, so its step key can never be
 * written — the gate must stop requiring it or onboarding stalls at 100%.
 */
export function stepHasEnabledDocuments(config: DocumentConfig, step: DocumentStep): boolean {
  return DOCUMENTS_BY_STEP[step].some((k) => isDocumentEnabled(config, k));
}
