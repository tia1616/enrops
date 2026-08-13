import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, ScreenError } from '../WizardLayout.jsx';

// Screen 3 — Business Eligibility (FYI).
//
// **Previously** this screen asked instructors to self-attest 3 of 4
// Oregon-specific contractor criteria (ORS 670.600). Per Arielle (2026-05-25):
// classification is the operator's responsibility under federal + state law,
// not the instructor's. Citing Oregon statute also painted us into the
// "we provide legal advice" corner and didn't generalize for other states.
//
// New behavior: a single informational notice + an IRS link. The instructor
// reads, acknowledges, and continues. submit-ors-certification is still called,
// but ONLY to advance the onboarding step — it writes nothing.
//
// WHAT WAS HERE, AND WHY IT WENT. This screen used to post five hardcoded
// booleans so the old edge function would still write its row. The intent was
// "the operator vouches for these", but nothing in the record said so: the row
// landed under the CONTRACTOR's id, with certified_at and their own IP address,
// attesting to specifics they were never shown. On production that produced 23
// rows, every one identical, from 2026-05-27 onward — and the agreement those
// people signed promises the opposite in as many words: "which the Contractor
// will confirm by separate self-certification in enrops".
//
// A fabricated attestation is weaker than none: an identical machine-generated
// answer across every contractor is exactly what reads as pro-forma. So nothing
// is posted and nothing is stored.
//
// The contractor DOES still attest to their status — on Screen 4, where they
// read and sign, recorded as contractor_agreements.confirm_contractor_status
// beside their typed signature, IP and a snapshot of the exact text. That is the
// real record and it always was.

const IRS_CONTRACTOR_URL =
  'https://www.irs.gov/businesses/small-businesses-self-employed/independent-contractor-defined';

// No payload. The function ignores the body and only advances the step.
// Do NOT reintroduce one: any value posted here would be stored under the
// contractor's name against criteria this screen does not ask about.

export default function Screen3ORS({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !acknowledged) return;
    setBusy(true);
    setSubmitError('');
    try {
      const { error } = await invokeOnboardingFn(
        'submit-ors-certification',
        {},
        { navigate }
      );
      if (error) {
        setSubmitError(error.message || 'Something went wrong. Please try again.');
        setBusy(false);
        return;
      }
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen3] submit failed', err);
      setSubmitError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.ORS_CERTIFICATION}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Heads up: you're an independent contractor"
      subtitle="A quick note about how this works."
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-800">
          <p>
            Your engagement with this organization is as an{' '}
            <strong>independent contractor</strong> — not as an employee. That
            means:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>You're responsible for your own taxes (no withholding).</li>
            <li>
              You use your own transportation and carry your own car insurance.
            </li>
            <li>
              You may work with other clients alongside this engagement.
            </li>
          </ul>
          {/* Points at where the specifics actually live, now that this screen
              stores nothing.
              STATE-NEUTRAL: naming a statute here is what got the old version
              removed on 2026-05-25 and would not generalise past one state.
              SECTION-NEUTRAL too, which is less obvious. The draft of this line
              said "Section 3 — please read it before you sign", and Section 3 is
              a section of ONE provider's agreement. Every other provider writes
              their own from a starter whose parts are headed "The work",
              "Independent contractor status", "Pay" and so on — no numbers at
              all — so a section reference would point at nothing for everyone
              except the tenant it was written for. Same bug as every other
              hardcode removed from this path. */}
          <p className="mt-3">
            Your contractor agreement, on the next screen, sets out the specific
            criteria for independent-business status — please read it before you
            sign.
          </p>
          <p className="mt-3">
            The federal and state rules around contractor classification vary
            by jurisdiction. If you want the official IRS overview, here it is:
          </p>
          <p className="mt-2">
            <a
              href={IRS_CONTRACTOR_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-blue-700 underline hover:text-blue-900"
            >
              IRS: Independent Contractor Defined →
            </a>
          </p>
          <p className="mt-3 text-xs text-neutral-500">
            Your business operator is responsible for confirming your
            classification under their local, state, and federal employment
            laws. If you have questions about your specific situation, talk to
            a tax professional or your operator.
          </p>
        </div>

        <label className="mt-5 flex items-start gap-3 text-sm text-neutral-800">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400"
          />
          <span>
            I understand I'm working as an independent contractor.
          </span>
        </label>

        <ScreenError>{submitError}</ScreenError>

        <PrimaryButton disabled={busy || !acknowledged}>
          {busy ? 'Saving…' : 'Got it — continue →'}
        </PrimaryButton>
      </form>
    </WizardLayout>
  );
}
