import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../lib/onboardingFetch.js';

// Renders one of four variants based on contractor_onboarding_status.overall_status:
//   - complete:                 fully onboarded ✓ — CTA: Go to my portal
//   - pending_background_check: Checkr hasn't returned 'clear' yet — gated; only CTA is "Check current status"
//   - pending_stripe:           Stripe payouts not enabled yet — gated; CTA refresh actively pings Stripe
//   - payouts_disabled:         Stripe disabled payouts (regression — admin needed)
//
// Other statuses (in_progress, declined, abandoned) are handled by the router
// and never land here.
//
// Pending states are GATED: no "Go to my portal" exit. The contractor stays
// here until clearance lands (webhook flips overall_status to 'complete') —
// at which point the next refresh reveals the success variant + portal CTA.
// This prevents dropping them into an empty schedule view before they're
// cleared, which would read as "where are my classes?" confusion.
//
// Props:
//   onDismiss: parent-controlled exit (used by InstructorPortal to flip its
//     phase out of 'onboarding'). Only invoked for the 'complete' variant.
//   onRefresh: parent re-fetches onboarding row. Provided by WizardHost as
//     its onAdvance. Required for pending states; ignored otherwise.

export default function CompletionScreen({ slug, onboarding, onDismiss, onRefresh }) {
  const navigate = useNavigate();
  const status = onboarding?.overall_status;
  const portalHref = `/${slug}/instructor`;
  const variant = pickVariant(status);
  const isPending = status === 'pending_background_check' || status === 'pending_stripe';

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError('');
    try {
      // For pending_stripe, actively poll Stripe via the edge function — the
      // webhook may be delayed and the contractor often hits Refresh right
      // after finishing on Stripe's side, before the webhook arrives.
      if (status === 'pending_stripe') {
        const { error, status: respStatus } = await invokeOnboardingFn(
          'refresh-stripe-status',
          {},
          { navigate }
        );
        if (error) {
          if (respStatus === 502) {
            setRefreshError("Couldn't reach Stripe right now. Try again in a minute.");
          } else {
            setRefreshError(error.message || "Couldn't refresh status.");
          }
          setRefreshing(false);
          return;
        }
      }
      // Re-fetch the onboarding row in the parent so this screen re-renders
      // with the new state (or routes away if status flipped to 'complete').
      if (onRefresh) await onRefresh();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[CompletionScreen] refresh failed', err);
      setRefreshError("Couldn't check status — try again.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-16">
      <div className="mx-auto max-w-md">
        <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          {slug ? `${slug} · onboarding` : 'onboarding'}
        </div>
        <div className={`rounded-lg border bg-white p-6 shadow-sm ${variant.borderClass}`}>
          <div className="text-3xl">{variant.emoji}</div>
          <h1 className="mt-2 text-xl font-semibold text-neutral-900">{variant.title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">{variant.body}</p>

          {variant.stripeDashboardLink && (
            <a
              href="https://dashboard.stripe.com/express"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-neutral-900 hover:underline"
            >
              Check status on Stripe →
            </a>
          )}

          {isPending ? (
            <>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="mt-6 inline-block w-full rounded-md bg-neutral-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {refreshing ? 'Checking…' : 'Check current status'}
              </button>
              {refreshError && (
                <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                  {refreshError}
                </div>
              )}
            </>
          ) : onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="mt-6 inline-block w-full rounded-md bg-neutral-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-neutral-800"
            >
              {variant.cta}
            </button>
          ) : (
            <Link
              to={portalHref}
              className="mt-6 inline-block w-full rounded-md bg-neutral-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-neutral-800"
            >
              {variant.cta}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function pickVariant(status) {
  if (status === 'payouts_disabled') {
    return {
      emoji: '⚠️',
      title: 'Action needed — payment setup',
      body:
        "Stripe disabled your account's payout capability. This usually means they need updated verification info.",
      borderClass: 'border-amber-400',
      cta: 'Update on Stripe →',
      stripeDashboardLink: true,
    };
  }
  if (status === 'pending_stripe') {
    return {
      emoji: '⏳',
      title: 'Paperwork complete ✓',
      body:
        "Your background check cleared. We're waiting on Stripe to finish verifying your payment account so you can be paid. We'll email you when it's ready, or check below.",
      borderClass: 'border-neutral-200',
      cta: 'Go to my portal →',
      stripeDashboardLink: true,
    };
  }
  if (status === 'pending_background_check') {
    return {
      emoji: '⏳',
      title: 'Paperwork complete ✓',
      body:
        "Your background check is still processing (usually 1–3 business days). We'll email you the moment it clears.",
      borderClass: 'border-neutral-200',
      cta: 'Go to my portal →',
    };
  }
  // 'complete' (or unknown — render the success variant as a safe fallback)
  return {
    emoji: '🎉',
    title: "You're fully onboarded ✓",
    body: 'Your summer camp assignments are waiting for you in enrops.',
    borderClass: 'border-green-300',
    cta: 'Go to my portal →',
  };
}
