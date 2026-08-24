import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { useOnboardingConfig } from '../OnboardingConfigContext.jsx';
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

const DOC_KEY = 'contractor_status';

export default function Screen3ORS({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  // FROM CONTEXT, NOT FROM PROPS, and this is the whole of a real bug. WizardHost
  // renders every screen with a fixed `common` bundle — slug, instructor,
  // onboarding, onAdvance, onBack — and nothing else. This screen originally took
  // `orgName` as a prop with a default of '', so it silently resolved to '' on
  // every render and the "not published yet" message below could never name the
  // provider, which is the one thing that message exists to do. Screens 4 and 6
  // read it off the context; so does this one now.
  const { orgName } = useOnboardingConfig();
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  // THE PROVIDER'S HALF OF THIS SCREEN. Until 2026-08-21 the whole page was
  // hardcoded, so no provider could see it in Settings or change a word of it.
  // It is now backed by the `contractor_status` document, fetched exactly the way
  // Screens 4, 5 and 6 fetch theirs.
  const [doc, setDoc] = useState({ phase: 'loading', title: '', body: '', retryable: false });

  useEffect(() => {
    let cancelled = false;
    fetchLegalDocument(DOC_KEY, { navigate })
      .then(({ data, error, status }) => {
        if (cancelled) return;
        // AN EMPTY BODY IS UNPUBLISHED, and it is handled here rather than at the
        // checkbox — the same call the sibling screens make, for the same reason.
        // get-legal-document returns 200 for a blank body, so disabling the
        // checkbox instead would leave an instructor on a page with a heading, no
        // text, and a Continue that can never enable.
        if (error || !data?.body_text?.trim()) {
          setDoc({
            phase: 'unavailable',
            title: '',
            body: '',
            // 404 or blank means the provider has not written it; retrying cannot
            // fix that. Anything else may be transient.
            retryable: !!error && status !== 404,
          });
          return;
        }
        // VERSION CARRIED THROUGH, because what gets recorded is that this
        // instructor read THIS version — the same (key, version) pair Screens 5
        // and 6 acknowledge. Without it the record could not say which wording
        // they were shown, which is the only thing that makes the record worth
        // keeping.
        setDoc({
          phase: 'ready',
          title: data.title || '',
          body: data.body_text,
          version: data.document_version,
          retryable: false,
        });
      })
      .catch((err) => {
        if (isHandledRedirect(err)) return;
        if (!cancelled) setDoc({ phase: 'unavailable', title: '', body: '', retryable: true });
      });
    return () => { cancelled = true; };
  }, [navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    // Mirrors the button's own condition rather than restating a subset of it.
    // The button is disabled in this state, but the form can still be submitted
    // by other routes, and advancing the step for someone who was never shown
    // the provider's note is the one outcome this screen must not allow.
    if (busy || doc.phase !== 'ready') return;
    setBusy(true);
    setSubmitError('');
    try {
      // POSTS TO submit-acknowledgments, NOT submit-ors-certification.
      //
      // That function only ever advanced the step — it stored nothing, by design,
      // after the fabricated ORS attestation was stripped out of it. The
      // consequence nobody noticed until 2026-08-24: there was no record anywhere
      // that an instructor had ever been shown the provider's contractor note.
      // Every other document in this wizard leaves a row saying who read which
      // version, when, and from where; this one left nothing.
      //
      // Rather than copy that insert into a second function, Screen 3 now uses the
      // one that already does it properly: it validates the (key, version) against
      // this org's own legal_documents, upserts idempotently against the unique
      // constraint, and advances the step. One write path for every document an
      // instructor reads.
      const { error } = await invokeOnboardingFn(
        'submit-acknowledgments',
        {
          step: 'contractor_status',
          documents: [{ document_id: DOC_KEY, document_version: doc.version }],
        },
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
        {/* THE PROVIDER'S TEXT. Whitespace preserved because the document is
            authored as plain prose in Settings, exactly as Screens 5 and 6
            render theirs. */}
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-800">
          {doc.phase === 'loading' && (
            <p className="text-neutral-500">Loading…</p>
          )}
          {doc.phase === 'unavailable' && (
            // NAMES SOMEONE WHO CAN FIX IT, matching the sibling screens. An
            // instructor cannot publish a document, so "try again" alone would be
            // a dead end — this is the state Jeff's own instructors would hit
            // while his document is unwritten.
            <p>
              {doc.retryable
                ? 'We could not load this right now. Please refresh the page.'
                : `${orgName || 'Your business operator'} has not published this note yet. You can carry on once they do — contact them if you are waiting.`}
            </p>
          )}
          {doc.phase === 'ready' && (
            <div className="whitespace-pre-wrap">{doc.body}</div>
          )}

          {/* FIXED PLATFORM GUIDANCE, below the provider's text and deliberately
              NOT part of the editable document. A provider should not have to
              write an IRS reference, and must not be able to reword or delete a
              statement about their own responsibility for classifying the people
              who work for them.
              STATE-NEUTRAL: naming a statute here is what got the old version
              removed on 2026-05-25 and would not generalise past one state. */}
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

        {/* NO TICK BOX HERE, DELIBERATELY — removed 2026-08-24 after Jessica
            walked the flow: "they shouldn't confirm their status as an
            independent contractor twice."
            She was right, and the asymmetry is what made it safe to remove THIS
            one rather than the other. This screen's box recorded NOTHING:
            submit-ors-certification ignores its body entirely ("whatever
            arrives, nothing is stored") and exists only to advance the step. The
            real attestation is on Screen 4 — `confirm_contractor_status`, a NOT
            NULL boolean stored beside the typed signature, timestamp, IP and a
            snapshot of the exact text signed. So an instructor was ASKED twice
            and only ever ANSWERED once.
            Her 2026-08-21 rule that "the box agreeing that they're independent
            contractors must remain" is still honoured — it remains on the screen
            where it is actually recorded.
            This screen is now what it always really was: a plain-English
            heads-up the provider owns and can edit. */}

        <ScreenError>{submitError}</ScreenError>

        {/* STILL GATED ON A PUBLISHED DOCUMENT. Dropping the tick must not turn
            this into a screen an instructor can click past while the provider's
            note is missing — the point is that they READ it. An unpublished
            document keeps the actionable message above and a disabled button,
            exactly as before. */}
        <PrimaryButton disabled={busy || doc.phase !== 'ready'}>
          {busy ? 'Saving…' : 'Got it — continue →'}
        </PrimaryButton>
      </form>
    </WizardLayout>
  );
}
