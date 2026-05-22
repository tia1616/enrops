import React from 'react';
import { Link } from 'react-router-dom';

// Renders one of four variants based on contractor_onboarding_status.overall_status:
//   - complete:                 fully onboarded ✓
//   - pending_background_check: Checkr hasn't returned 'clear' yet
//   - pending_stripe:           Stripe payouts not enabled yet
//   - payouts_disabled:         Stripe disabled payouts (regression — admin needed)
//
// Other statuses (in_progress, declined, abandoned) are handled by the router
// and never land here.

export default function CompletionScreen({ slug, onboarding }) {
  const status = onboarding?.overall_status;
  const portalHref = `/${slug}/instructor`;

  const variant = pickVariant(status);

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

          <Link
            to={portalHref}
            className="mt-6 inline-block w-full rounded-md bg-neutral-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-neutral-800"
          >
            {variant.cta}
          </Link>
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
        "Your payment setup is still being verified by Stripe. We'll email you when it's ready.",
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
        "Your background check is still processing. We'll email you when it clears.",
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
