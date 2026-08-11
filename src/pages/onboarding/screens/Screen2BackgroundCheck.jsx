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

// What we can honestly say about each value checkr_status can hold, and whether
// the self-serve link still makes sense in that state.
//
// The column is CLOSED, not open. Verified against the live CHECK constraint
// 2026-08-11: exactly not_started | pending | clear | consider | suspended.
// An earlier version of this comment claimed checkr-webhook wrote arbitrary
// Checkr statuses "verbatim" including 'dispute'; that was wrong. index.ts:142
// is `else if (status === 'consider' || status === 'suspended')` and :162 logs
// and ignores everything else, so only clear / consider / suspended are ever
// written there. I asserted that from a grep line without reading the block
// around it. The practical damage: framing the fallback as an unknown-value
// bucket is what left 'suspended' — the one real occupant — falling through it.
//
// `offerLink` is a SEPARATE axis from having a result, and conflating the two
// reproduced the exact bug this file exists to fix. 'pending' is written by
// create-checkr-candidate the moment the INVITATION is created (index.ts:154,
// :171) — it means invited-and-unfinished, not submitted. Treating it as a
// finished submission hid the link in the one state where someone most needs it.
//
// Prod today: 'clear' x23, 'not_started' x1.
const STATUS_VIEW = {
  clear: {
    title: 'Your background check is complete.',
    body: 'Nothing else to do here.',
    offerLink: false,
  },
  pending: {
    title: "Your background check isn't finished yet.",
    body: "You've been invited to complete it. Pick up where you left off whenever you're ready.",
    offerLink: true,
  },
  consider: {
    title: 'Your background check is being reviewed.',
    body: 'Your program is going over the result and will be in touch. You can carry on with the rest of your onboarding.',
    offerLink: false,
  },
  suspended: {
    title: 'Your background check needs attention.',
    body: 'Your program has been notified and will be in touch about the next step. Starting a new check yourself will not clear it.',
    offerLink: false,
  },
};
// not_started and NULL have no entry on purpose: there is no result to report,
// so the link stays on offer.

export default function Screen2BackgroundCheck({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const { backgroundCheck } = useOnboardingConfig();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Did they already press Continue on this step? Controls whether Continue
  // needs to WRITE the step again, and whether we show the status block.
  const alreadyAcknowledged = Boolean(onboarding?.steps_completed?.[STEP_KEYS.CHECKR_SUBMITTED]);

  // Two independent questions, deliberately not collapsed into one flag.
  // `status`     — is there a result we can honestly report?
  // `showHowTo`  — does offering the check still make sense in this state?
  // A 'pending' check has a status AND still wants the link; a 'suspended' one
  // has a status and must NOT re-offer it (a second check clears nothing).
  const status = STATUS_VIEW[onboarding?.checkr_status] ?? null;
  const showHowTo = status ? status.offerLink : true;

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
      {showHowTo && (
        <div className="flex flex-col items-start gap-3">
          {/* STATUS ONLY. This line used to also say what to do next, which put
              the same instruction on screen twice in a row - "Your Program
              Manager will email you the link." immediately above "...will email
              you the link to get started.", and with a link configured, "pick it
              up below" immediately above "using the link below". Neither was
              visible while reading the branches one at a time; both were obvious
              the moment the page actually rendered. This line reports where
              things stand; the paragraph under it does the instructing.
              Suppressed when `status` already rendered its own heading above. */}
          {alreadyAcknowledged && !status && (
            <p className="text-sm font-semibold text-neutral-900">
              We haven&apos;t received a result for your background check yet.
            </p>
          )}

          {instructions ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800">{instructions}</p>
          ) : (
            <p className="text-sm leading-relaxed text-neutral-800">
              {/* Two rules here, both learned the hard way.
                  1. The pointer at the link is conditional on the link EXISTING.
                     provider_name and provider_url are independent optional
                     fields, so an org can name its provider without giving a
                     self-serve URL, and the old copy still said "using the link
                     below" with nothing below it.
                  2. Do NOT promise a CHANNEL we don't control. These lines said
                     "your Program Manager will email you the link", but
                     contractor-invite only includes a background-check block when
                     provider_url is set (index.ts:245) — so in exactly the config
                     with no URL, nothing emails a link. Worse, background checks
                     default to ENABLED for an org that never opened the settings
                     page, so a brand-new provider's instructor would be told to
                     wait for a message nobody sends. Say a person will be in
                     touch, and always give them something to DO. */}
              {providerName
                ? (providerUrl
                    ? `Complete your background check with ${providerName} using the link below. If you have any trouble, contact your Program Manager.`
                    : `Your background check is run through ${providerName}. Your Program Manager will send you what you need to get started — reach out to them if you haven't heard.`)
                : "Your Program Manager will send you what you need to complete your background check. If you haven't heard, reach out to them."}
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
