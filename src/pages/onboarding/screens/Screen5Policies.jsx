import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { linkifyText } from '../../../lib/linkifyText.jsx';
import Chevron from '../../../components/Chevron.jsx';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 5 — Policy Acknowledgments. Three documents acknowledged together:
// pay_schedule, attendance_policy, code_of_conduct. Each in its own
// accordion; each requires a single ack box. All three must be checked.

const DOCS = [
  { key: 'pay_schedule', ack: 'I acknowledge I have received and read the Pay Schedule' },
  { key: 'attendance_policy', ack: 'I acknowledge I have received and read the Attendance Policy' },
  { key: 'code_of_conduct', ack: 'I acknowledge I have received and read the Code of Conduct' },
];

export default function Screen5Policies({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [docs, setDocs] = useState({}); // { key: { title, body_text, version } }
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState(() => Object.fromEntries(DOCS.map((d) => [d.key, false])));
  const [checked, setChecked] = useState(() => Object.fromEntries(DOCS.map((d) => [d.key, false])));
  const [submitError, setSubmitError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      try {
        const results = await Promise.all(
          DOCS.map((d) =>
            fetchLegalDocument(d.key, { navigate }).then((r) => ({ key: d.key, ...r }))
          )
        );
        if (cancelled) return;
        const map = {};
        for (const r of results) {
          if (r.error) {
            setLoadError(
              "We can't load this document right now. Please try again or contact Jessica."
            );
            return;
          }
          map[r.key] = {
            title: r.data.title,
            body_text: r.data.body_text,
            version: r.data.document_version,
          };
        }
        setDocs(map);
      } catch (err) {
        if (isHandledRedirect(err)) return;
        console.error('[Screen5] load failed', err);
        if (!cancelled) setLoadError('Something went wrong loading the policies.');
      }
    }
    loadAll();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const allChecked = DOCS.every((d) => checked[d.key]);
  const allLoaded = DOCS.every((d) => docs[d.key]);
  const canSubmit = allChecked && allLoaded;

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !allLoaded) return;
    if (!allChecked) {
      setConfirmError('Acknowledge all three policies to continue.');
      return;
    }
    setConfirmError('');
    setBusy(true);
    setSubmitError('');
    try {
      const { error } = await invokeOnboardingFn(
        'submit-acknowledgments',
        {
          step: 'policies',
          documents: DOCS.map((d) => ({
            document_id: d.key,
            document_version: docs[d.key].version,
          })),
        },
        { navigate }
      );
      if (error) {
        setSubmitError(error.message || "Something's wrong — please contact Jessica.");
        setBusy(false);
        return;
      }
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen5] submit failed', err);
      setSubmitError("Something's wrong — please contact Jessica.");
      setBusy(false);
    }
  }

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.POLICIES_ACKNOWLEDGED}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Review policies"
      subtitle="Tap each to read, then check the box."
    >
      {loadError ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-900">{loadError}</div>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <div className="space-y-3">
            {DOCS.map((d) => (
              <DocAccordion
                key={d.key}
                docKey={d.key}
                title={docs[d.key]?.title || 'Loading…'}
                version={docs[d.key]?.version}
                bodyText={docs[d.key]?.body_text}
                isExpanded={expanded[d.key]}
                onToggle={() => setExpanded((s) => ({ ...s, [d.key]: !s[d.key] }))}
                ackLabel={d.ack}
                checked={checked[d.key]}
                onCheck={(v) => setChecked((s) => ({ ...s, [d.key]: v }))}
                disabled={!docs[d.key]}
              />
            ))}
          </div>

          <FieldError>{confirmError}</FieldError>
          <ScreenError>{submitError}</ScreenError>

          <PrimaryButton disabled={busy || !canSubmit}>
            {busy ? 'Saving…' : 'Continue →'}
          </PrimaryButton>
        </form>
      )}
    </WizardLayout>
  );
}

export function DocAccordion({
  title,
  version,
  bodyText,
  isExpanded,
  onToggle,
  ackLabel,
  checked,
  onCheck,
  disabled,
}) {
  return (
    <div className="rounded-md border border-neutral-200">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-neutral-900 hover:bg-neutral-50"
      >
        <span>{title}</span>
        <Chevron open={isExpanded} className="text-neutral-500" />
      </button>
      {isExpanded && (
        <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-3">
          <div className="max-h-[40vh] overflow-y-auto text-sm leading-relaxed text-neutral-800">
            {(bodyText || '').split(/\n\s*\n/).map((para, i) => (
              <p key={i} className="mb-2 whitespace-pre-wrap">
                {linkifyText(para)}
              </p>
            ))}
          </div>
        </div>
      )}
      <label className="flex items-start gap-3 border-t border-neutral-200 px-4 py-3 text-sm text-neutral-800">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400 disabled:opacity-50"
        />
        <span>{ackLabel}</span>
      </label>
    </div>
  );
}
