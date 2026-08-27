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

// Screen 6 — Additional Acknowledgments. Up to three documents.
// mandatory_reporter_ack is short enough to render inline (not in an accordion)
// above a single checkbox; photo_video_release and vehicle_driving_ack are
// accordions with multiple per-section acks.
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
// With all three off the screen is dropped from the wizard entirely
// (WizardHost/effectiveStepOrder) and from the completion gate (gateCheck).
//
// THIS LIST IS A SECOND COPY of the 'additional' group in
// src/lib/instructorDocuments.js, and keeping it in sync is not optional. A
// fourth document, `contractor_status`, was grouped here until 2026-08-21, when it
// was briefly deleted and then MOVED TO ITS OWN SCREEN (Screen3ORS) — so it is
// correctly absent from the list below, and the list below is the only place that
// says so. Removing it from the shared lib alone would have left this file listing
// a key the lib no longer knows, and isDocumentEnabled answers an unknown key with
// "absent means
// ON". So the section below would have rendered for EVERY provider, its document
// would have 404'd (nobody ever published one), the 404 branch in loadAll sets
// loadError and returns early — and every instructor reaching Screen 6 would get
// the red "your program hasn't published these documents" box instead of the
// form, with no way to continue onboarding. The build and the whole test suite
// were green with that bug in place. If you remove a document, remove it HERE
// too, and grep the wizard screens before believing you are done.

const MANDATORY_KEY = 'mandatory_reporter_ack';
const PHOTO_KEY = 'photo_video_release';
const VEHICLE_KEY = 'vehicle_driving_ack';

const ALL_DOC_KEYS = [MANDATORY_KEY, PHOTO_KEY, VEHICLE_KEY];

// SAYS WHAT THE TICK CAN ACTUALLY EVIDENCE, which the previous wording did not.
// It read "I have completed or will complete the mandatory reporting training and
// will comply with reporting requirements" — an assertion about training the
// platform cannot verify, has no record of, and never linked to anywhere on the
// screen. Jessica, 2026-08-24: "there's no link in it to a course."
//
// Now the same shape as every other acknowledgement in the wizard: they confirm
// they have READ the provider's policy. Where the training itself lives is the
// provider's to state inside that document — a bare URL in the body renders as a
// clickable link (linkifyText, applied below), and the starter draft now asks
// them for it.
const MANDATORY_ACK =
  'I acknowledge I have read the mandatory reporting policy and will comply with it';

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
// ONE OPTIONAL BOX, AND IT IS THE ONLY OPTIONAL BOX IN THE WIZARD.
//
// This was three REQUIRED boxes until 2026-08-24 — consent to being recorded,
// consent to marketing use, and an understanding that consent is revocable — all
// three of which had to be ticked before an instructor could finish onboarding.
// So agreeing to appear in a provider's marketing was a condition of being
// allowed to work. Jessica: "they have to be able to not accept it and deny that
// and still be able to continue. shouldn't be mandatory to work for a provider."
//
// EVERY OTHER TICK IN THIS WIZARD IS AN ACKNOWLEDGEMENT — "I have read it", "I
// will comply" — where no is not an available answer and the acknowledgement row
// is the whole record. This one is a CONSENT: it has a real no, and the answer is
// now stored on instructors.photo_release_consent, the same pair of column names
// families already answer this question into on registrations.
//
// UNTICKED MEANS DECLINED, and it is written as an explicit false rather than
// left null — null is reserved for "never asked". Jessica chose a single optional
// tick over a two-option choice; the cost is that someone who does not notice the
// box is recorded as declining, and that is the fail-safe direction. The failure
// mode is not using a photo we could have used.
//
// The revocable/optional wording moved OUT of a tick box and into the footnote
// below: it is information, not a decision, and asking someone to tick that they
// understand something is not evidence that they do.
const PHOTO_CONSENT_KEY = 'photo_consent';

// A TICK BECAME A CHOICE on 2026-08-27. The consent itself is unchanged — it is
// still refusable, and refusing still does not affect the work offered. What
// changed is that "no" is now something you SAY rather than something you fail
// to do.
//
// The old shape was one optional tick, and an untick was written as an explicit
// `false`. That made two very different people identical in the record: the one
// who read it and declined, and the one who never noticed the box. The migration
// that introduced the column named this as its known cost and took it knowingly
// ("the cost is that someone who does not notice the box is recorded as
// declining, and that is the fail-safe direction").
//
// Jeff asked for the opposite fix — make consent mandatory — and that is the one
// thing this must never become. Checked on prod before building: 9 of 9 of his
// instructors who reached this screen agreed, and across 736 real registrations
// on both providers not one family has ever declined. Nobody is refusing. A
// mandatory yes would change no outcome and would cost the only evidence that
// the yeses are real, exactly as his "been in a class before?" question now
// holds 62 answers that all say yes because the form allowed nothing else.
//
// So: answering is required, agreeing is not. Both answers continue.
const PHOTO_QUESTION = (orgName) =>
  renderWaiverText(
    'May {{org}} photograph or record you at program sites, and use your likeness in their marketing?',
    orgName,
  );

// "No" is written first in neither position and given equal weight deliberately.
// A refusal offered as an afterthought is a refusal people do not take.
const PHOTO_OPTIONS = [
  { value: 'yes', label: 'Yes, that’s fine' },
  { value: 'no', label: 'No, please don’t' },
];

const PHOTO_FOOTNOTE =
  'Either answer lets you carry on — it does not affect the work you are offered, '
  + 'and you can change your mind later by telling your program manager in writing.';

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
  const photoQuestion = useMemo(() => PHOTO_QUESTION(orgName), [orgName]);
  const showMandatory = DOC_KEYS.includes(MANDATORY_KEY);
  const showPhoto = DOC_KEYS.includes(PHOTO_KEY);
  const showVehicle = DOC_KEYS.includes(VEHICLE_KEY);
  const [docs, setDocs] = useState({});
  const [loadError, setLoadError] = useState('');
  const [mandatoryAck, setMandatoryAck] = useState(false);
  const [photoExpanded, setPhotoExpanded] = useState(false);
  const [vehicleExpanded, setVehicleExpanded] = useState(false);
  // SEEDED FROM WHAT THEY ALREADY ANSWERED, unlike every other group on this
  // screen. The others are acknowledgements: re-ticking one you have already
  // ticked costs nothing, because the answer can only ever be yes. This one is a
  // consent with a real no, and it is the ONLY box here whose blank state is a
  // meaningful answer that gets written.
  //
  // Starting it unticked meant a resubmission silently overwrote an agreement
  // with a refusal: press Back from Screen 7, re-tick the mandatory-reporter and
  // driving boxes to re-enable Continue, miss the optional photo box, and the
  // consent you gave is now recorded as declined with today's date. One
  // direction only, and invisible to everyone.
  //
  // Strictly `=== true`: null means never asked, and an instructor who has not
  // answered must see an empty box, not a ticked one.
  // THREE STATES, and the third one is the whole reason this is not a boolean.
  //   'yes'  -> agreed          (column true)
  //   'no'   -> declined        (column false)
  //   null   -> not answered yet (column null: never asked)
  //
  // Mapping the nullable column onto two radios via a plain boolean would
  // pre-select "No" for every instructor who has never been asked — 17 of them on
  // production right now — and the first thing they would see is the form
  // claiming they had already refused. Strictly === true and === false, so null
  // lands on neither option.
  const [photoConsent, setPhotoConsent] = useState(() =>
    instructor?.photo_release_consent === true ? 'yes'
      : instructor?.photo_release_consent === false ? 'no'
        : null
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
  const allVehicleChecked = !showVehicle || VEHICLE_ACKS.every((a) => vehicleChecked[a.key]);
  // THE PHOTO CONSENT IS DELIBERATELY ABSENT FROM THIS EXPRESSION. It is the one
  // box on this screen an instructor may decline, so it can never gate Continue —
  // that was the bug. Its answer is carried in the payload instead of the gate.
  const allAcksChecked =
    (!showMandatory || mandatoryAck) &&
    allVehicleChecked;
  // THE ANSWER IS REQUIRED. THE CONSENT IS NOT. Kept as its own named boolean,
  // separate from allAcksChecked, so the difference is visible in one line and
  // cannot be blurred by a later edit: this compares against null, never against
  // 'yes'. `photoConsent === 'no'` satisfies it exactly as `'yes'` does, and
  // there is deliberately no expression anywhere in this component that requires
  // the value to be 'yes' in order to proceed.
  //
  // Pinned by instructorDocuments.test.mjs, which parses this file: the gate may
  // test that an answer EXISTS and must never test WHICH answer it is.
  //
  // DELIBERATELY UI-ONLY, against the usual rule that an invariant belongs in the
  // write path as well. submit-acknowledgments treats an ABSENT key as "this
  // caller did not ask the question" and leaves the column untouched — which is
  // what protects a real answer from being overwritten by an older bundle, and
  // what makes "provider switched the release off" storable as null. Making the
  // server reject an `additional` submit that carries the photo document without
  // a boolean would turn every stale cached bundle into a hard onboarding failure
  // during a deploy, and this app is a PWA that serves stale assets by design.
  // A null answer is a gap in a record; a rejected submit is an instructor who
  // cannot start work. The fail-safe direction is the one taken here.
  const photoAnswered = !showPhoto || photoConsent !== null;
  // Not gated on DOC_KEYS.length — see the empty-set guard in handleSubmit.
  // photoAnswered is DELIBERATELY NOT HERE, and that is the whole point.
  //
  // Adding it disabled Continue whenever the question was unanswered, which made
  // the requirement invisible: a grey button explains nothing, the submit handler
  // is never reached, and the message written for exactly this case could never
  // render. Caught on staging 2026-08-27 by ticking every other box and watching
  // the button stay dead with nothing on screen.
  //
  // That is the same defect fixed on the registration form on 25 Aug, where the
  // answer was: the button stays live and the reason arrives BECAUSE they pressed
  // it. Same answer here. The unanswered-photo case is caught in handleSubmit and
  // says what is missing.
  //
  // The acknowledgements keep gating the button as they always have — that
  // behaviour is untouched by this change and is not mine to widen here.
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
    // NAMES THE THING THAT IS MISSING, and the photo case gets its own sentence.
    // "Acknowledge all required items" is useless to someone whose only gap is a
    // question they are allowed to answer either way — it reads as "you must
    // agree", which is the exact misunderstanding this change exists to remove.
    // Same lesson as the Continue button that shipped on 25 Aug: say what is
    // missing, do not just refuse.
    if (!photoAnswered) {
      setConfirmError('Choose Yes or No for the photo and video question — either answer lets you continue.');
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
          // Sent ONLY when the release is actually on this provider's screen. If
          // they have switched the document off, the instructor was never asked,
          // and posting `false` would record a refusal nobody made — the server
          // leaves the column untouched when the key is absent, which is what
          // "never asked" has to look like.
          ...(showPhoto ? { photo_release_consent: photoConsent === 'yes' } : {}),
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
          {/* The "Independent contractor status" section stood here. Deleted
              2026-08-21 with the document itself; the mandatory reporter section
              below carries no top margin because it has always been the first
              thing on this screen in practice — that document defaulted off, so
              no provider ever had this section rendered. */}

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
            choice={{
              name: PHOTO_CONSENT_KEY,
              question: photoQuestion,
              options: PHOTO_OPTIONS,
              value: photoConsent,
              // Clearing the confirm error here, not only on submit: the message
              // names this control, so it has to stop being true the moment the
              // control is satisfied. A refusal notice that outlives the refusal
              // is the stale-feedback bug.
              onChange: (v) => { setPhotoConsent(v); setConfirmError(''); },
            }}
            footnote={PHOTO_FOOTNOTE}
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
  // Optional. When present this section asks ONE question with mutually
  // exclusive answers instead of listing tick boxes. Added rather than forked so
  // the document body, the accordion and the footnote placement stay in one
  // place — the photo release and the driving acknowledgements are the same kind
  // of section wrapping different kinds of answer.
  //
  // `value` may be null, which selects NEITHER radio. That is load-bearing: null
  // means the question has not been answered, and rendering it as one of the two
  // options would put words in someone's mouth.
  choice,
  footnote,
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
        {choice ? (
          <fieldset disabled={disabled} className="disabled:opacity-50">
            <legend className="text-sm text-neutral-800">{choice.question}</legend>
            <div className="mt-2 space-y-2">
              {choice.options.map((o) => (
                <label key={o.value} className="flex items-start gap-3 text-sm text-neutral-800">
                  <input
                    type="radio"
                    name={choice.name}
                    value={o.value}
                    checked={choice.value === o.value}
                    onChange={() => choice.onChange(o.value)}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 border-neutral-400 disabled:opacity-50"
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          acks.map((a) => (
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
          ))
        )}
        {/* Sits WITH the box, not at the bottom of the screen. An instructor
            deciding whether to tick needs to know it is optional at the moment
            they are deciding — guidance they have to scroll to find is guidance
            they do not read. */}
        {footnote && (
          <p className="pl-7 text-xs leading-relaxed text-neutral-500">{footnote}</p>
        )}
      </div>
    </div>
  );
}
