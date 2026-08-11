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
// TWO BUGS FIXED HERE, 2026-08-11. Both came from the old shape: a return visit
// took an EARLY RETURN that rendered only a status line, so it could neither
// show the link again nor tell the truth about what had happened.
//
//   1. The provider link disappeared forever. Pressing Continue is the ONLY
//      thing that sets checkr_submitted, and nothing requires opening the link
//      first — so anyone who pressed Continue without starting their check could
//      never find the link again inside the wizard.
//
//   2. It claimed "submitted" with no evidence. The old copy read
//      "Background check submitted ✓ — Status: {x}", where x fell back to the
//      RAW column value for anything outside a 3-entry label map. Prod today has
//      a real instructor at checkr_status='not_started', which rendered as
//      "Background check submitted ✓ — Status: not_started" — the same sentence
//      asserting both.
//
// So the rule now: we only say a check was submitted when we have POSITIVE
// evidence for it (see SUBMITTED_STATUS below). Pressing Continue is not
// evidence — it is the contractor parking the step, which is deliberately
// allowed because the check runs in parallel. Anything we don't recognise is
// treated as not-started, which fails SAFE: worst case we re-offer a link to
// someone who already did it, instead of telling someone they are done when
// they aren't.
//
// Unchanged on purpose: none of this touches the completion gate. That is
// server-side and still holds an instructor at pending_background_check until an
// admin marks the check clear, so a contractor pressing Continue has never been
// able to reach a roster early. This screen is display only.

// The statuses that constitute real evidence about the check, and the honest
// thing to say about each.
//
// Deliberately NOT a total map, and the fallback copy is deliberately worded to
// be true for EVERYTHING outside it. The writable values are wider than they
// look: create-checkr-candidate writes 'not_started' and 'pending',
// admin-upload-background-check and checkr-webhook write 'clear' — but
// checkr-webhook ALSO writes whatever status Checkr hands it verbatim
// (index.ts:146), which can be 'suspended', 'dispute' and others. The old code
// printed those raw at the contractor.
//
// So the fallback must not assert what the contractor did. "We haven't received
// a result yet" is true for null, for 'not_started', and for any unrecognised
// value, while still justifying showing the link. Claiming "you haven't started"
// would just be a different false statement for a suspended check.
//
// Verified against prod 2026-08-11: 'clear' x23, 'not_started' x1.
const SUBMITTED_STATUS = {
  clear: {
    title: 'Your background check is complete.',
    body: 'Nothing else to do here.',
  },
  pending: {
    title: 'Your background check has been submitted.',
    body: "We're waiting on the result. You don't need to do anything else — we'll let you know if we need more from you.",
  },
  consider: {
    title: 'Your background check is being reviewed.',
    body: 'Your program is going over the result and will be in touch. You can carry on with the rest of your onboarding.',
  },
};

export default function Screen2BackgroundCheck({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const { backgroundCheck } = useOnboardingConfig();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Did they already press Continue on this step? Controls whether Continue
  // needs to WRITE the step again, and whether we show the status block.
  const alreadyAcknowledged = Boolean(onboarding?.steps_completed?.[STEP_KEYS.CHECKR_SUBMITTED]);

  // The honest read of where the check actually stands. `status` is null
  // whenever we have no positive evidence — see SUBMITTED_STATUS.
  const status = SUBMITTED_STATUS[onboarding?.checkr_status] ?? null;
  // Named for what it actually means: no RESULT we can speak to. Not the same as
  // "they never started" — see the note on SUBMITTED_STATUS.
  const noResultYet = !status;

  // Provider copy from Settings -> Background checks. All optional; we fall back
  // to neutral guidance when a field is unset.
  const providerName = (backgroundCheck?.provider_name || '').trim();
  const providerUrl = (backgroundCheck?.provider_url || '').trim();
  const instructions = (backgroundCheck?.instructions || '').trim();

  async function acknowledgeAndContinue() {
    if (busy) return;
    // Nothing to write on a return visit — the step is already marked, so just
    // move on rather than firing a redundant round-trip that can only fail.
    if (alreadyAcknowledged) {
      onAdvance();
      return;
    }
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

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.CHECKR_SUBMITTED}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Background check"
      subtitle={
        status
          ? undefined
          : 'A background check is required before you can be assigned to work with children.'
      }
    >
      {/* Where the check actually stands. Only shown when we have real evidence
          of it — never inferred from the contractor having pressed Continue. */}
      {status && (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4">
          <p className="text-sm font-semibold text-neutral-900">{status.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-700">{status.body}</p>
        </div>
      )}

      {/* Not started — including the return visit that used to hide this block
          entirely. The instructions and the link are exactly what someone who
          skipped past this step comes back for. */}
      {/* Gap-based spacing, not per-element margins: this block now stacks up to
          four children whose visibility varies independently, and stacked mt-*
          utilities leave two paragraphs touching in the return-visit case. */}
      {noResultYet && (
        <div className="flex flex-col items-start gap-3">
          {alreadyAcknowledged && (
            <p className="text-sm font-semibold text-neutral-900">
              We haven&apos;t received a result for your background check yet.
              {providerUrl
                ? " If you haven't started it, you can pick it up below."
                : ' Your Program Manager will email you the link.'}
            </p>
          )}

          {instructions ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800">{instructions}</p>
          ) : (
            <p className="text-sm leading-relaxed text-neutral-800">
              {/* The pointer at the link is conditional on the link EXISTING.
                  provider_name and provider_url are independent optional config
                  fields, so an org can name its provider without giving a
                  self-serve URL — and the old copy then said "using the link
                  below" with no link below it. Pre-existing; fixed here because
                  it is the same class of untrue sentence this change is about. */}
              {providerName
                ? (providerUrl
                    ? `Complete your background check with ${providerName} using the link below. If you have any trouble, contact your Program Manager.`
                    : `Your background check is run through ${providerName}. Your Program Manager will email you the link to get started.`)
                : 'Your Program Manager will email you the link to start your background check.'}
            </p>
          )}

          {providerUrl && (
            <a
              href={providerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
            >
              {alreadyAcknowledged
                ? (providerName ? `Go to ${providerName}` : 'Go to your background check')
                : (providerName ? `Start your check with ${providerName}` : 'Start your background check')} →
            </a>
          )}

          {/* Two separate facts, and only one of them depends on there being a
              link. The new-tab half described a button that is not rendered when
              the org configured no provider_url — the same untrue-pointer bug as
              the "link below" copy above, which I reintroduced here while fixing
              it there. The parallel-review half is true either way, and it is the
              one that actually matters: it is why nobody is stuck on this step. */}
          <p className="text-xs leading-relaxed text-neutral-500">
            {providerUrl && "This opens in a new tab, so you won't lose your place. "}
            You can carry on with the rest of your onboarding now — your background check is
            reviewed separately.
          </p>
        </div>
      )}

      <ScreenError>{submitError}</ScreenError>

      <PrimaryButton type="button" onClick={acknowledgeAndContinue} disabled={busy}>
        {busy ? 'Saving…' : 'Continue →'}
      </PrimaryButton>
    </WizardLayout>
  );
}
