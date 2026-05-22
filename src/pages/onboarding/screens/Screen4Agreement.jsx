import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase.js';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { fetchLegalDocument } from '../../../lib/legalDoc.js';
import {
  STEP_KEYS,
  CONTRACTOR_AGREEMENT_VERSION,
} from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 4 — Contractor Agreement. Fetches body text via get-legal-document
// (RLS blocks direct legal_documents reads from instructor JWT), renders
// scrollable, requires 5 confirm checkboxes + typed signature.
//
// On submit: POST to submit-agreement with version + signature + 5 booleans.
// The edge function snapshots canonical body text server-side; we never send
// the agreement text. After server-side success, we best-effort-generate a
// presentation PDF client-side and upload it. PDF failure does not block —
// the legal record exists in the DB; the PDF is just a convenience copy.

const CONFIRMS = [
  { key: 'confirm_read', label: 'I have read this Agreement and the documents it incorporates' },
  { key: 'confirm_pay_structure', label: 'I agree to the compensation and deduction structure' },
  { key: 'confirm_contractor_status', label: 'I confirm my status as an independent contractor under ORS 670.600' },
  { key: 'confirm_confidentiality_ip', label: 'I reaffirm the confidentiality, IP, and non-solicitation obligations' },
  { key: 'confirm_supersedes_prior', label: 'My prior agreement with J2S is superseded' },
];

export default function Screen4Agreement({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
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
    fetchLegalDocument('contractor_agreement', {
      document_version: CONTRACTOR_AGREEMENT_VERSION,
      navigate,
    })
      .then(({ data, error, status }) => {
        if (cancelled) return;
        if (error) {
          setDocState({
            phase: 'error',
            message:
              status === 404
                ? "We can't load this document right now. Please try again or contact Jessica."
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
  const canSubmit = allConfirmed && signature.trim().length > 0 && docState.phase === 'ready';

  async function generateAndUploadPdf(bodyText, typedSignature, signedAt) {
    // Best-effort. Failure must not block onboarding completion.
    try {
      const { renderAgreementPdfBlob } = await import('./agreementPdf.jsx');
      const blob = await renderAgreementPdfBlob({
        bodyText,
        typedSignature,
        signedAt,
        instructor,
      });
      const path = `${instructor.id}/agreement_${CONTRACTOR_AGREEMENT_VERSION}_${Date.now()}.pdf`;
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
      setConfirmError('Check all five boxes to continue.');
      valid = false;
    } else {
      setConfirmError('');
    }
    if (!signature.trim()) {
      setSignatureError('Type your full legal name to sign.');
      valid = false;
    } else {
      setSignatureError('');
    }
    if (!valid) return;

    setBusy(true);
    setSubmitError('');
    try {
      const payload = {
        agreement_version: docState.version || CONTRACTOR_AGREEMENT_VERSION,
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
              <input
                type="text"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
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
