import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { linkifyText } from '../../../lib/linkifyText.jsx';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 6 — Additional Acknowledgments. Three documents, but the
// mandatory_reporter_ack body is short enough that we render it inline
// (not in an accordion) above its checkbox. photo_video_release and
// vehicle_driving_ack are accordions with multiple per-section acks.
//
// All required checkboxes must be checked before submit. The edge-function
// payload only needs document_id + document_version per doc — the granular
// ack booleans are tracked client-side for UI gating, not persisted
// per-checkbox (the legal record is "the contractor acknowledged this
// document at this version at this timestamp from this IP").

const MANDATORY_KEY = 'mandatory_reporter_ack';
const PHOTO_KEY = 'photo_video_release';
const VEHICLE_KEY = 'vehicle_driving_ack';

const DOC_KEYS = [MANDATORY_KEY, PHOTO_KEY, VEHICLE_KEY];

const MANDATORY_ACK =
  'I have completed or will complete the mandatory reporting training and will comply with reporting requirements';

// "I understand I won't receive additional compensation" used to be the
// fourth checkbox here. Removed 2026-05-25 per Arielle — compensation
// terms belong in the agreement / pay schedule, not buried in a photo
// release ack.
const PHOTO_ACKS = [
  { key: 'photo_consent_record', label: 'I consent to J2S photographing/recording me at program sites' },
  { key: 'photo_consent_marketing', label: 'I consent to use of my likeness in marketing materials' },
  { key: 'photo_consent_revocable', label: 'I understand consent is ongoing and revocable in writing' },
];

const VEHICLE_ACKS = [
  { key: 'vehicle_own_transport', label: 'I am responsible for my own transportation' },
  { key: 'vehicle_insurance', label: 'I maintain valid auto insurance' },
  { key: 'vehicle_no_transport_students', label: 'I will not transport students in my vehicle' },
];

export default function Screen6Additional({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [docs, setDocs] = useState({});
  const [loadError, setLoadError] = useState('');
  const [mandatoryAck, setMandatoryAck] = useState(false);
  const [photoExpanded, setPhotoExpanded] = useState(false);
  const [vehicleExpanded, setVehicleExpanded] = useState(false);
  const [photoChecked, setPhotoChecked] = useState(() =>
    Object.fromEntries(PHOTO_ACKS.map((a) => [a.key, false]))
  );
  const [vehicleChecked, setVehicleChecked] = useState(() =>
    Object.fromEntries(VEHICLE_ACKS.map((a) => [a.key, false]))
  );
  const [submitError, setSubmitError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      try {
        const results = await Promise.all(
          DOC_KEYS.map((key) =>
            fetchLegalDocument(key, { navigate }).then((r) => ({ key, ...r }))
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
        if (!cancelled) setLoadError('Something went wrong loading the documents.');
      }
    }
    loadAll();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const allLoaded = DOC_KEYS.every((k) => docs[k]);
  const allPhotoChecked = PHOTO_ACKS.every((a) => photoChecked[a.key]);
  const allVehicleChecked = VEHICLE_ACKS.every((a) => vehicleChecked[a.key]);
  const allAcksChecked = mandatoryAck && allPhotoChecked && allVehicleChecked;
  const canSubmit = allLoaded && allAcksChecked;

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !allLoaded) return;
    if (!allAcksChecked) {
      setConfirmError('Acknowledge all required items to continue.');
      return;
    }
    setConfirmError('');
    setBusy(true);
    setSubmitError('');
    try {
      const { error } = await invokeOnboardingFn(
        'submit-acknowledgments',
        {
          step: 'additional',
          documents: DOC_KEYS.map((k) => ({
            document_id: k,
            document_version: docs[k].version,
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
      console.error('[Screen6] submit failed', err);
      setSubmitError("Something's wrong — please contact Jessica.");
      setBusy(false);
    }
  }

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.ADDITIONAL_ACKS}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Additional acknowledgments"
    >
      {loadError ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-900">{loadError}</div>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          {/* Mandatory reporter — inline body, no accordion */}
          <section className="rounded-md border border-neutral-200 p-4">
            <h2 className="text-sm font-semibold text-neutral-900">
              {docs[MANDATORY_KEY]?.title || 'Mandatory Reporting'}
            </h2>
            {docs[MANDATORY_KEY] ? (
              <div className="mt-2 text-sm leading-relaxed text-neutral-800">
                {(docs[MANDATORY_KEY].body_text || '').split(/\n\s*\n/).map((para, i) => (
                  <p key={i} className="mb-2 whitespace-pre-wrap">
                    {linkifyText(para)}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-neutral-500">Loading…</p>
            )}
            <label className="mt-3 flex items-start gap-3 text-sm text-neutral-800">
              <input
                type="checkbox"
                checked={mandatoryAck}
                onChange={(e) => setMandatoryAck(e.target.checked)}
                disabled={!docs[MANDATORY_KEY]}
                className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400 disabled:opacity-50"
              />
              <span>{MANDATORY_ACK}</span>
            </label>
          </section>

          <MultiAckAccordion
            title={docs[PHOTO_KEY]?.title || 'Photo / Video Release'}
            version={docs[PHOTO_KEY]?.version}
            bodyText={docs[PHOTO_KEY]?.body_text}
            isExpanded={photoExpanded}
            onToggle={() => setPhotoExpanded((v) => !v)}
            disabled={!docs[PHOTO_KEY]}
            acks={PHOTO_ACKS}
            checked={photoChecked}
            onCheck={(k, v) => setPhotoChecked((s) => ({ ...s, [k]: v }))}
            className="mt-3"
          />

          <MultiAckAccordion
            title={docs[VEHICLE_KEY]?.title || 'Vehicle and Driving'}
            version={docs[VEHICLE_KEY]?.version}
            bodyText={docs[VEHICLE_KEY]?.body_text}
            isExpanded={vehicleExpanded}
            onToggle={() => setVehicleExpanded((v) => !v)}
            disabled={!docs[VEHICLE_KEY]}
            acks={VEHICLE_ACKS}
            checked={vehicleChecked}
            onCheck={(k, v) => setVehicleChecked((s) => ({ ...s, [k]: v }))}
            className="mt-3"
          />

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

// Re-export so we don't have to import DocAccordion's twin shape; this
// component is structurally similar but holds multiple checkboxes per doc.
function MultiAckAccordion({
  title,
  version,
  bodyText,
  isExpanded,
  onToggle,
  disabled,
  acks,
  checked,
  onCheck,
  className = '',
}) {
  return (
    <div className={`rounded-md border border-neutral-200 ${className}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-neutral-900 hover:bg-neutral-50"
      >
        <span>{title}</span>
        <span className="text-neutral-500">{isExpanded ? '▾' : '▸'}</span>
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
      <div className="space-y-2 border-t border-neutral-200 px-4 py-3">
        {acks.map((a) => (
          <label key={a.key} className="flex items-start gap-3 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={checked[a.key]}
              onChange={(e) => onCheck(a.key, e.target.checked)}
              disabled={disabled}
              className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400 disabled:opacity-50"
            />
            <span>{a.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
