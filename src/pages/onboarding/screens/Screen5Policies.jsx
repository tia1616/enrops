import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { linkifyText } from '../../../lib/linkifyText.jsx';
import { isDocumentEnabled } from '../../../lib/instructorDocuments.js';
import { useOnboardingConfig } from '../OnboardingConfigContext.jsx';
import Chevron from '../../../components/Chevron.jsx';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 5 — Policy Acknowledgments. Up to three documents acknowledged
// together: pay_schedule, attendance_policy, code_of_conduct. Each in its own
// accordion; each requires a single ack box. Every one still ON must be checked.
//
// PER-PROVIDER. Not every provider uses all three, so ALL_DOCS is the catalogue
// and `docsToShow` is what this provider actually asks for. A document that is
// off is not fetched, not rendered, and not acknowledged — and critically not
// WAITED FOR either: `allLoaded` used to require all three, so leaving a
// disabled document in the list would have left Continue permanently dead.
//
// If a provider turns all three off this screen is dropped from the wizard
// entirely (WizardHost/effectiveStepOrder) and from the completion gate
// (gateCheck), so it is never rendered empty. The guard in handleSubmit is a
// belt-and-braces backstop for that, not the mechanism.

const ALL_DOCS = [
  { key: 'pay_schedule', ack: 'I acknowledge I have received and read the Pay Schedule' },
  { key: 'attendance_policy', ack: 'I acknowledge I have received and read the Attendance Policy' },
  { key: 'code_of_conduct', ack: 'I acknowledge I have received and read the Code of Conduct' },
];

export default function Screen5Policies({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const { documentConfig } = useOnboardingConfig();
  const DOCS = useMemo(
    () => ALL_DOCS.filter((d) => isDocumentEnabled(documentConfig, d.key)),
    [documentConfig],
  );
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
            // A 404 here is NOT transient: it means the provider has not
            // published that document yet, and no amount of retrying fixes it.
            // The old copy said "please try again" for both causes, which sent an
            // instructor round a loop that could never succeed — `allLoaded`
            // stays false, so the step can never be completed. Same fix already
            // applied to the agreement on Screen 4.
            setLoadError(
              r.status === 404
                ? "Your program hasn't published these documents yet. Your Program Manager needs to add them before you can continue — please reach out to them."
                : "We can't load this document right now. Please try again, or reach out to your Program Manager."
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
  }, [navigate, DOCS]);

  // Every check below is over DOCS, the ENABLED set — never the catalogue. A
  // disabled document has no checkbox and is never fetched, so counting it would
  // leave Continue disabled with nothing on screen to fix it.
  const allChecked = DOCS.every((d) => checked[d.key]);
  const allLoaded = DOCS.every((d) => docs[d.key]);
  // Deliberately NOT gated on DOCS.length: with an empty set both checks above
  // are vacuously true, so Continue stays live and the guard in handleSubmit
  // advances rather than posting an empty array. A dead button on a screen with
  // nothing to read would be the worse failure.
  const canSubmit = allChecked && allLoaded;

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !allLoaded) return;
    // submit-acknowledgments rejects an empty documents array (400), so an empty
    // submit would read to the instructor as an unexplained failure. This screen
    // should already have been dropped from the wizard before it could render —
    // see the header note.
    if (DOCS.length === 0) {
      onAdvance();
      return;
    }
    if (!allChecked) {
      // Counted, not the literal "all three" this used to say — a provider who
      // uses two would have been told to check three boxes that do not exist.
      setConfirmError(
        DOCS.length === 1
          ? 'Acknowledge the policy to continue.'
          : `Acknowledge all ${DOCS.length} policies to continue.`,
      );
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
        setSubmitError(error.message || "Something's wrong — please reach out to your Program Manager.");
        setBusy(false);
        return;
      }
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen5] submit failed', err);
      setSubmitError("Something's wrong — please reach out to your Program Manager.");
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
