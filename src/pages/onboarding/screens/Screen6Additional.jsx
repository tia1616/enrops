import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { linkifyText } from '../../../lib/linkifyText.jsx';
import { isDocumentEnabled } from '../../../lib/instructorDocuments.js';
import { renderWaiverText } from '../../../lib/waiverText.js';
import { useOnboardingConfig } from '../OnboardingConfigContext.jsx';
import Chevron from '../../../components/Chevron.jsx';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 6 — Additional Acknowledgments. Up to four documents. contractor_status
// and mandatory_reporter_ack are short enough to render inline (not in an
// accordion) above a single checkbox each; photo_video_release and
// vehicle_driving_ack are accordions with multiple per-section acks.
//
// All required checkboxes must be checked before submit. The edge-function
// payload only needs document_id + document_version per doc — the granular
// ack booleans are tracked client-side for UI gating, not persisted
// per-checkbox (the legal record is "the contractor acknowledged this
// document at this version at this timestamp from this IP").
//
// PER-PROVIDER. This is the screen the toggle work exists for: a provider whose
// instructors never drive should not have to write a driving acknowledgment
// before anybody can finish onboarding. Each of the four is independently on or
// off, so a section that is off is not fetched, not rendered, and — the part
// that actually bites — not counted in `allLoaded` or `allAcksChecked` either.
// Its checkbox group cannot be checked because it is not on the page, so
// including it would leave Continue permanently disabled.
//
// With all four off the screen is dropped from the wizard entirely
// (WizardHost/effectiveStepOrder) and from the completion gate (gateCheck).
// contractor_status defaults OFF rather than on, so for every provider today
// this screen is exactly what it was — three documents, unchanged — until
// somebody turns it on.

const CONTRACTOR_STATUS_KEY = 'contractor_status';
const MANDATORY_KEY = 'mandatory_reporter_ack';
const PHOTO_KEY = 'photo_video_release';
const VEHICLE_KEY = 'vehicle_driving_ack';

const ALL_DOC_KEYS = [CONTRACTOR_STATUS_KEY, MANDATORY_KEY, PHOTO_KEY, VEHICLE_KEY];

// OFF unless the provider opts in — the only document that defaults off, and the
// reason it exists at all is that Screen 4's tick box used to cite an Oregon
// statute to instructors in every state. The rules are the provider's to state
// (and to link to), because they are the ones who know which state's test
// applies. The wording here stays deliberately general: what the instructor is
// confirming is described in THEIR provider's document, rendered right above it.
const CONTRACTOR_STATUS_ACK =
  'I have read this and I confirm I meet the requirements for working as an independent contractor';

const MANDATORY_ACK =
  'I have completed or will complete the mandatory reporting training and will comply with reporting requirements';

// "I understand I won't receive additional compensation" used to be the
// fourth checkbox here. Removed 2026-05-25 per Arielle — compensation
// terms belong in the agreement / pay schedule, not buried in a photo
// release ack.
//
// TAKES THE PROVIDER'S NAME. It said "I consent to J2S photographing/recording
// me" — one company's name, in a consent every OTHER provider's instructors were
// asked to give, about photographs that provider would never take. Same class as
// the four tenant names removed from this wizard on 2026-08-12; this one survived
// because it is a label rather than body text.
//
// THROUGH renderWaiverText RATHER THAN A TERNARY, because the first version was a
// hand-rolled truthiness check and orgName is operator-supplied free text threaded
// here untrimmed. A name of "   " is truthy, so a consent checkbox rendered
// "I consent to     photographing/recording me at program sites" — on a legal
// attestation. renderWaiverText already trims, already falls back to wording that
// is true rather than to a placeholder or another tenant's name, and is already
// the convention every other org-name interpolation in this repo uses.
const photoAcks = (orgName) => [
  {
    key: 'photo_consent_record',
    label: renderWaiverText(
      'I consent to {{org}} photographing/recording me at program sites',
      orgName,
    ),
  },
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
  const { documentConfig, orgName } = useOnboardingConfig();
  const DOC_KEYS = useMemo(
    () => ALL_DOC_KEYS.filter((k) => isDocumentEnabled(documentConfig, k)),
    [documentConfig],
  );
  const PHOTO_ACKS = useMemo(() => photoAcks(orgName), [orgName]);
  const showContractorStatus = DOC_KEYS.includes(CONTRACTOR_STATUS_KEY);
  const showMandatory = DOC_KEYS.includes(MANDATORY_KEY);
  const showPhoto = DOC_KEYS.includes(PHOTO_KEY);
  const showVehicle = DOC_KEYS.includes(VEHICLE_KEY);
  const [docs, setDocs] = useState({});
  const [loadError, setLoadError] = useState('');
  const [contractorStatusAck, setContractorStatusAck] = useState(false);
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
          // AN EMPTY BODY IS TREATED AS UNPUBLISHED, and it is handled HERE rather
          // than at the checkbox. The first attempt at this disabled the checkbox
          // when the body was blank, which was strictly worse than the bug it
          // fixed: get-legal-document returns 200 for an empty body, so the
          // document loaded, the form rendered, the checkbox could never be
          // ticked, and Continue was disabled forever — a title, one blank
          // paragraph, and no explanation anywhere on the page. The comment ten
          // lines below has warned about exactly that shape the whole time
          // ("would disable Continue with nothing on screen to explain why").
          //
          // A document with no text is not something an instructor can
          // acknowledge, so it is not a weak checkbox — it is an unpublished
          // document, and the screen already has an actionable message for that,
          // naming the person who can fix it. Same branch, same words.
          if (r.error || !r.data?.body_text?.trim()) {
            // 404 = the provider hasn't published it, which retrying cannot fix
            // and which leaves this step permanently uncompletable. Distinguished
            // from a genuine transient failure, matching Screens 4 and 5. An empty
            // body is the same situation as a 404 from the instructor's side.
            const unpublished = !r.error || r.status === 404;
            setLoadError(
              unpublished
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
        if (!cancelled) setLoadError('Something went wrong loading the documents.');
      }
    }
    loadAll();
    return () => {
      cancelled = true;
    };
  }, [navigate, DOC_KEYS]);

  // Each group only counts when its document is actually on the page. A hidden
  // group's checkboxes can never be ticked, so requiring them would disable
  // Continue with nothing on screen to explain why.
  const allLoaded = DOC_KEYS.every((k) => docs[k]);
  const allPhotoChecked = !showPhoto || PHOTO_ACKS.every((a) => photoChecked[a.key]);
  const allVehicleChecked = !showVehicle || VEHICLE_ACKS.every((a) => vehicleChecked[a.key]);
  const allAcksChecked =
    (!showContractorStatus || contractorStatusAck) &&
    (!showMandatory || mandatoryAck) &&
    allPhotoChecked &&
    allVehicleChecked;
  // Not gated on DOC_KEYS.length — see the empty-set guard in handleSubmit.
  const canSubmit = allLoaded && allAcksChecked;

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !allLoaded) return;
    // submit-acknowledgments rejects an empty documents array (400). This screen
    // is dropped from the wizard before it can render with nothing on it, so
    // this is a backstop rather than the mechanism.
    if (DOC_KEYS.length === 0) {
      onAdvance();
      return;
    }
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
        setSubmitError(error.message || "Something's wrong — please reach out to your Program Manager.");
        setBusy(false);
        return;
      }
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen6] submit failed', err);
      setSubmitError("Something's wrong — please reach out to your Program Manager.");
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
          {/* Independent contractor status — inline body like the mandatory
              reporter one, and for the same reason: it is short, it is the
              provider's own words about their own state's rules, and folding it
              into an accordion would let someone tick "I confirm I meet the
              requirements" without the requirements ever being on screen. */}
          {showContractorStatus && (
          <section className="mb-3 rounded-md border border-neutral-200 p-4">
            <h2 className="text-sm font-semibold text-neutral-900">
              {docs[CONTRACTOR_STATUS_KEY]?.title || 'Independent contractor status'}
            </h2>
            {docs[CONTRACTOR_STATUS_KEY] ? (
              <div className="mt-2 text-sm leading-relaxed text-neutral-800">
                {(docs[CONTRACTOR_STATUS_KEY].body_text || '').split(/\n\s*\n/).map((para, i) => (
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
                checked={contractorStatusAck}
                onChange={(e) => setContractorStatusAck(e.target.checked)}
                disabled={!docs[CONTRACTOR_STATUS_KEY]}
                className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400 disabled:opacity-50"
              />
              <span>{CONTRACTOR_STATUS_ACK}</span>
            </label>
          </section>
          )}

          {/* Mandatory reporter — inline body, no accordion */}
          {showMandatory && (
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
          )}

          {showPhoto && (
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
          )}

          {showVehicle && (
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
          )}

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
