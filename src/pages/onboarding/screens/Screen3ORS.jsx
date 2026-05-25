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
// reads, acknowledges, and continues. The submit-ors-certification edge
// function is still called so the step persists in steps_completed; we
// send authority_to_hire: false and all four criteria as true (the
// operator vouches for these — the instructor is just being informed).
//
// When the operator-facing contractor-classification config lands, the
// vouching becomes explicit on the admin side. This screen stays as a
// quick FYI on the contractor side.

const IRS_CONTRACTOR_URL =
  'https://www.irs.gov/businesses/small-businesses-self-employed/independent-contractor-defined';

// What gets sent to the existing edge function. Hardcoded "true" for the
// four criteria keys because the operator has already vouched for them by
// onboarding this contractor. The legal record is now "operator-asserted +
// contractor-acknowledged" rather than "contractor self-attested".
const VOUCHED_PAYLOAD = {
  authority_to_hire: false,
  separate_business_location: true,
  bears_risk_of_loss: true,
  multiple_clients: true,
  significant_investment: true,
};

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
        VOUCHED_PAYLOAD,
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
