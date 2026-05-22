import React, { useState } from 'react';
import { invokeOnboardingFn, isHandledRedirect } from '../../lib/onboardingFetch.js';
import { useNavigate } from 'react-router-dom';

// Shown when overall_status = 'abandoned' (admin-marked). Contractor can
// request to resume via Function 15 (request-resume-onboarding), which emails
// the org's alert_email with their name + optional note. The function
// rate-limits at 24h via resume_requested_at.

export default function AbandonedPage() {
  const navigate = useNavigate();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // 'sent' | 'rate_limited' | 'error'

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { error, status } = await invokeOnboardingFn(
        'request-resume-onboarding',
        { note: note.trim() || null },
        { navigate }
      );
      if (error) {
        if (status === 429) setOutcome('rate_limited');
        else setOutcome('error');
      } else {
        setOutcome('sent');
      }
    } catch (err) {
      if (isHandledRedirect(err)) return;
      setOutcome('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-16">
      <div className="mx-auto max-w-md">
        <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          enrops
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-neutral-900">
            Your onboarding was marked inactive.
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600">
            If you&rsquo;d like to resume, contact Jessica.
          </p>

          {outcome === 'sent' && (
            <div className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-900">
              Sent ✓ — Jessica will email you.
            </div>
          )}
          {outcome === 'rate_limited' && (
            <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              We&rsquo;ve already sent your request. Please wait — Jessica will be in touch.
            </div>
          )}
          {outcome === 'error' && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-900">
              Something went wrong — please email Jessica directly.
            </div>
          )}

          {outcome !== 'sent' && outcome !== 'rate_limited' && (
            <form onSubmit={handleSubmit} className="mt-5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Optional message
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
                placeholder="Anything you want Jessica to know."
              />
              <button
                type="submit"
                disabled={busy}
                className="mt-3 w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Request to resume →'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
