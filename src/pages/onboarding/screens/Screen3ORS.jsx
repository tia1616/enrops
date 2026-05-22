import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 3 — Business Eligibility (ORS 670.600). Contractor must self-certify
// at least 3 of 5 criteria. Each checked box requires a free-text "describe
// how" answer. Anyone who can't meet 3 confirms via modal and the wizard
// calls submit-onboarding-declined (terminal — overall_status flips to
// 'declined' and they land on /:slug/onboarding/declined).

const CRITERIA = [
  {
    key: 'has_business_location',
    label:
      'I have a workspace at home (or elsewhere) where I prepare lessons and handle business-related work for my instructional services.',
  },
  {
    key: 'bears_risk_of_loss',
    label: 'I bear the risk of loss in providing services.',
  },
  {
    key: 'multiple_clients_or_marketing',
    label:
      'I provide services to 2+ clients in a 12-month period, or routinely market to obtain new contracts.',
  },
  {
    key: 'significant_investment',
    label: 'I have made a significant investment in my business.',
  },
  {
    key: 'authority_to_hire',
    label:
      'I have the authority to hire others to provide or assist in providing services.',
  },
];

export default function Screen3ORS({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [checked, setChecked] = useState(() =>
    Object.fromEntries(CRITERIA.map((c) => [c.key, false]))
  );
  const [descriptions, setDescriptions] = useState(() =>
    Object.fromEntries(CRITERIA.map((c) => [c.key, '']))
  );
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const allCheckedHaveText = CRITERIA.every(
    (c) => !checked[c.key] || descriptions[c.key].trim().length > 0
  );
  const meetsThreshold = checkedCount >= 3 && allCheckedHaveText;

  function setOne(key, value) {
    setChecked((s) => ({ ...s, [key]: value }));
    if (!value) {
      setDescriptions((d) => ({ ...d, [key]: '' }));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !meetsThreshold) return;
    setBusy(true);
    setSubmitError('');
    try {
      const payload = {};
      for (const c of CRITERIA) {
        payload[c.key] = checked[c.key];
        payload[`${c.key}_description`] = checked[c.key] ? descriptions[c.key].trim() : null;
      }
      const { error } = await invokeOnboardingFn('submit-ors-certification', payload, {
        navigate,
      });
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

  async function handleDecline() {
    if (busy) return;
    setBusy(true);
    setSubmitError('');
    try {
      const { error } = await invokeOnboardingFn(
        'submit-onboarding-declined',
        { reason: 'ors_670_600_not_met' },
        { navigate }
      );
      if (error) {
        setSubmitError(error.message || 'Something went wrong. Please try again.');
        setBusy(false);
        return;
      }
      navigate(`/${slug}/onboarding/declined`, { replace: true });
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen3] decline failed', err);
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
      title="Business eligibility"
      subtitle="Oregon law requires independent contractors to meet at least 3 of 5 criteria. Check each that applies and briefly describe how."
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {CRITERIA.map((c) => (
            <div key={c.key} className="rounded-md border border-neutral-200 p-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked[c.key]}
                  onChange={(e) => setOne(c.key, e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400"
                />
                <span className="text-sm text-neutral-800">{c.label}</span>
              </label>
              {checked[c.key] && (
                <div className="mt-2 pl-7">
                  <textarea
                    value={descriptions[c.key]}
                    onChange={(e) =>
                      setDescriptions((d) => ({ ...d, [c.key]: e.target.value }))
                    }
                    rows={2}
                    placeholder="Briefly describe how this applies to you."
                    className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
                  />
                  {checked[c.key] && descriptions[c.key].trim().length === 0 && (
                    <FieldError>Briefly describe how this applies to you.</FieldError>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 text-sm text-neutral-600">
          {checkedCount} of 5 selected {meetsThreshold && <span className="text-green-700">✓</span>}
        </div>

        {checkedCount < 3 && checkedCount > 0 && (
          <p className="mt-3 text-sm text-amber-800">You need at least 3 of 5 criteria.</p>
        )}

        <ScreenError>{submitError}</ScreenError>

        <PrimaryButton disabled={busy || !meetsThreshold}>
          {busy ? 'Saving…' : 'Continue →'}
        </PrimaryButton>

        <button
          type="button"
          onClick={() => setConfirmDecline(true)}
          className="mt-3 block w-full text-center text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-800"
          disabled={busy}
        >
          I don&rsquo;t meet 3 criteria
        </button>
      </form>

      {confirmDecline && (
        <ConfirmDeclineModal
          busy={busy}
          onCancel={() => setConfirmDecline(false)}
          onConfirm={handleDecline}
        />
      )}
    </WizardLayout>
  );
}

function ConfirmDeclineModal({ busy, onCancel, onConfirm }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-neutral-900">Are you sure?</h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600">
          This will end your onboarding and you won&rsquo;t be able to accept J2S
          engagements. Contact Arielle to discuss.
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:border-neutral-400 disabled:opacity-50"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
          >
            {busy ? 'Saving…' : "Yes, I don't qualify"}
          </button>
        </div>
      </div>
    </div>
  );
}
