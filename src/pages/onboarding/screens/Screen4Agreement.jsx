import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase.js';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';
import { useOnboardingConfig } from '../OnboardingConfigContext.jsx';

// Screen 4 — Contractor Agreement. Fetches body text via get-legal-document
// (RLS blocks direct legal_documents reads from instructor JWT), renders
// scrollable, requires every confirm checkbox in CONFIRMS + a typed signature.
//
// Deliberately NOT "5 checkboxes": this comment and the validation message both
// said five after the list had dropped to four, so the screen told instructors
// to tick a box that no longer existed. The count now comes from CONFIRMS
// everywhere it is shown.
//
// On submit: POST to submit-agreement with version + signature + one boolean
// per entry in CONFIRMS.
// The edge function snapshots canonical body text server-side; we never send
// the agreement text. After server-side success, we best-effort-generate a
// presentation PDF client-side and upload it. PDF failure does not block —
// the legal record exists in the DB; the PDF is just a convenience copy.

// These five are written to contractor_agreements as affirmative legal
// attestations, so the wording matters and is Jessica's to approve.
//
// TWO TENANT-SPECIFIC STRINGS WERE HERE, and until this change they were
// UNREACHABLE for any other provider because the document fetch 404'd. Dropping
// the version pin made them live, so removing the dead end turned one of them
// into a false statement rather than a blocker.
//
//   FIXED: "My prior agreement with J2S is superseded" named one specific
//   company. Every other provider's instructor was being asked to attest that an
//   agreement with a business they have never contracted with is superseded.
//   Generalised to the clause's actual intent - superseding a prior agreement
//   with THIS provider - without weakening it.
//
//   LEFT ALONE, DELIBERATELY: the ORS 670.600 reference. Oregon statute, and
//   Jessica's explicit call on 2026-08-11 was to reuse the Oregon step as-is
//   because Jeff is in Oregon, with a per-state step recorded as debt (there is
//   no state column on organizations to branch on yet). Genericising it would
//   WEAKEN the attestation J2S's 24 signed agreements rely on, which is worse
//   than the narrower problem it solves. The first non-Oregon contractor is the
//   deadline for the state step, not this line.
const CONFIRMS = [
  { key: 'confirm_read', label: 'I have read this Agreement' },
  // confirm_pay_structure intentionally removed -- the Pay & Deductions
  // policy is on Screen 5 and the contractor explicitly acknowledges it
  // there. Asking on this screen put the agreement before the document.
  { key: 'confirm_contractor_status', label: 'I confirm my status as an independent contractor under ORS 670.600' },
  { key: 'confirm_confidentiality_ip', label: 'I reaffirm the confidentiality, IP, and non-solicitation obligations' },
  { key: 'confirm_supersedes_prior', label: 'Any prior agreement I have with this program is superseded' },
];

export default function Screen4Agreement({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const { orgName } = useOnboardingConfig();
  const [docState, setDocState] = useState({ phase: 'loading' });
  const [confirms, setConfirms] = useState(() =>
    Object.fromEntries(CONFIRMS.map((c) => [c.key, false]))
  );
  const [signature, setSignature] = useState('');
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [signatureError, setSignatureError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [busy, setBusy] = useState(false);
  const signatureSectionRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    // NO document_version: fetch whatever this org has published most recently.
    //
    // This used to pin CONTRACTOR_AGREEMENT_VERSION — one provider's version
    // string, hardcoded in frontend code. It worked only because that provider
    // was the only one with any documents. For anyone else it 404s, and it kept
    // 404ing even after they wrote their own agreement, unless they happened to
    // name their version identically. The agreement is the one document an
    // instructor must sign, so the whole onboarding flow dead-ended there.
    //
    // get-legal-document already resolves "no version given" to the newest row
    // for (org, key) — the same rule the policy screens have always used and the
    // same rule the authoring screen shows as "live now". So this is now ONE
    // definition of which version is current instead of two that could disagree.
    // Safe for the existing provider: verified they have exactly one published
    // contractor agreement, so newest-wins resolves to the identical row.
    fetchLegalDocument('contractor_agreement', { navigate })
      .then(({ data, error, status }) => {
        if (cancelled) return;
        if (error) {
          setDocState({
            phase: 'error',
            // 404 now has a specific, likely cause: the provider has not
            // published an agreement yet. Saying "try again" would send an
            // instructor round a loop that cannot succeed, because nothing they
            // do fixes it — only their Program Manager can.
            message:
              status === 404
                ? "Your program hasn't published its contractor agreement yet. Your Program Manager needs to add it before you can sign — please reach out to them."
                : 'Something went wrong loading the agreement. Please try again.',
          });
          return;
        }
        setDocState({
          phase: 'ready',
          title: data.title,
          bodyText: data.body_text,
          version: data.document_version,
        });
      })
      .catch((err) => {
        if (isHandledRedirect(err)) return;
        if (!cancelled) {
          setDocState({ phase: 'error', message: 'Something went wrong loading the agreement.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    const timer = setTimeout(() => setShowJumpButton(true), 30000);
    return () => clearTimeout(timer);
  }, []);

  const allConfirmed = CONFIRMS.every((c) => confirms[c.key]);
  // Legal signature must match the instructor's registered legal name.
  // Whitespace-collapsed, case-insensitive — typos in capitalization or
  // spacing don't trip people up, but typing the wrong name does.
  const expectedName = `${instructor?.first_name ?? ''} ${instructor?.last_name ?? ''}`.trim();
  const normalize = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const signatureMatchesName = expectedName.length > 0 &&
    normalize(signature) === normalize(expectedName);
  const canSubmit = allConfirmed && signatureMatchesName && docState.phase === 'ready';

  async function generateAndUploadPdf(bodyText, typedSignature, signedAt) {
    // Best-effort. Failure must not block onboarding completion.
    try {
      const { renderAgreementPdfBlob } = await import('./agreementPdf.jsx');
      const blob = await renderAgreementPdfBlob({
        bodyText,
        typedSignature,
        signedAt,
        instructor,
        // The header used to be one provider's name and one provider's version
        // string, printed on every provider's archived contract. All three are
        // now the real thing: this org's name, the title THEY gave the document,
        // and the version actually signed — the same value the filename below
        // records, so the two cannot disagree.
        orgName,
        documentTitle: docState.title,
        documentVersion: docState.version,
      });
      // The filename records the version ACTUALLY signed. It used to interpolate
      // the hardcoded constant, so every provider's stored PDF would have been
      // named after one other provider's version regardless of what the
      // instructor read — a filename that lies about a signed document.
      const path = `${instructor.id}/agreement_${docState.version}_${Date.now()}.pdf`;
      const { error } = await supabase.storage
        .from('contractor-documents')
        .upload(path, blob, { contentType: 'application/pdf', upsert: false });
      if (error) throw error;
      return path;
    } catch (err) {
      console.warn('[Screen4] PDF generation/upload failed — non-blocking', err);
      return null;
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    let valid = true;
    if (!allConfirmed) {
      // COUNTED, never spelled out. This said "all five boxes" while CONFIRMS
      // held four — confirm_pay_structure moved to Screen 5 and the message did
      // not follow — so an instructor who missed one was told to find a box that
      // does not exist. Deriving it means the sentence cannot go stale again the
      // next time this list changes. Same rule already applied on Screen 5.
      setConfirmError(
        CONFIRMS.length === 1
          ? 'Check the box to continue.'
          : `Check all ${CONFIRMS.length} boxes to continue.`,
      );
      valid = false;
    } else {
      setConfirmError('');
    }
    if (!signature.trim()) {
      setSignatureError('Type your full legal name to sign.');
      valid = false;
    } else if (!signatureMatchesName) {
      setSignatureError(
        expectedName
          ? `Please type your full legal name exactly as registered: ${expectedName}`
          : 'We couldn’t verify your registered name — refresh the page and try again.'
      );
      valid = false;
    } else {
      setSignatureError('');
    }
    if (!valid) return;

    setBusy(true);
    setSubmitError('');
    try {
      const payload = {
        // The version they actually read. No fallback to a constant: canSubmit
        // requires phase === 'ready', which only happens after a real document
        // loaded and set this. A fallback here could only ever submit a version
        // the instructor did not read — and submit-agreement rightly rejects a
        // version that does not exist for the org, so the fallback's only
        // possible outcomes were "wrong text recorded" or "confusing error".
        agreement_version: docState.version,
        typed_signature: signature.trim(),
        ...Object.fromEntries(CONFIRMS.map((c) => [c.key, true])),
      };

      const { data, error } = await invokeOnboardingFn('submit-agreement', payload, {
        navigate,
      });
      if (error) {
        setSubmitError(error.message || 'Something went wrong. Please try again.');
        setBusy(false);
        return;
      }

      // Fire-and-forget PDF generation. We don't wait beyond a short window —
      // the agreement is legally signed regardless of PDF outcome.
      const signedAt = data?.signed_at || new Date().toISOString();
      generateAndUploadPdf(docState.bodyText, signature.trim(), signedAt).catch((err) => {
        console.warn('[Screen4] PDF post-submit failed', err);
      });

      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen4] submit failed', err);
      setSubmitError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  function jumpToSignature() {
    signatureSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.AGREEMENT_SIGNED}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Contractor agreement"
      subtitle="Please read carefully. You'll confirm and sign at the bottom."
    >
      {docState.phase === 'loading' && (
        <p className="text-sm text-neutral-500">Loading agreement…</p>
      )}
      {docState.phase === 'error' && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-900">{docState.message}</div>
      )}
      {docState.phase === 'ready' && (
        <form onSubmit={handleSubmit} noValidate>
          {showJumpButton && (
            <button
              type="button"
              onClick={jumpToSignature}
              className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-600 hover:text-neutral-900"
            >
              Jump to signature ↓
            </button>
          )}

          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-800">
            {docState.bodyText.split(/\n\s*\n/).map((para, i) => (
              <p key={i} className="mb-3 whitespace-pre-wrap">
                {para}
              </p>
            ))}
          </div>

          <div ref={signatureSectionRef} className="mt-6 border-t border-neutral-200 pt-5">
            <h2 className="text-base font-semibold text-neutral-900">Signature</h2>
            <p className="mt-1 text-sm text-neutral-600">By signing below, you confirm:</p>

            <div className="mt-3 space-y-2">
              {CONFIRMS.map((c) => (
                <label key={c.key} className="flex items-start gap-3 text-sm text-neutral-800">
                  <input
                    type="checkbox"
                    checked={confirms[c.key]}
                    onChange={(e) =>
                      setConfirms((s) => ({ ...s, [c.key]: e.target.checked }))
                    }
                    className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-400"
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
            <FieldError>{confirmError}</FieldError>

            <div className="mt-4">
              <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Type your full legal name
              </label>
              {expectedName && (
                <p className="mt-1 text-xs text-neutral-500">
                  Sign as registered: <span className="font-semibold text-neutral-700">{expectedName}</span>
                </p>
              )}
              <input
                type="text"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder={expectedName || ''}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
              />
              <FieldError>{signatureError}</FieldError>
            </div>

            <p className="mt-3 text-xs text-neutral-500">
              Your electronic signature, the date and time, and your IP address will be
              recorded for legal purposes.
            </p>
          </div>

          <ScreenError>{submitError}</ScreenError>

          <PrimaryButton disabled={busy || !canSubmit}>
            {busy ? 'Signing…' : 'Sign and continue →'}
          </PrimaryButton>
        </form>
      )}
    </WizardLayout>
  );
}
