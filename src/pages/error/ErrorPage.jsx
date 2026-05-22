import React, { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import MagicLinkResend from '../onboarding/MagicLinkResend.jsx';

// Generic, intentionally-untenanted error page. The wizard's routing and
// fetch wrapper navigate here when we can't determine which tenant the user
// belongs to (or when re-authentication won't help).
//
// Known reasons:
//   org_misconfigured — instructor's org has no slug
//   deactivated       — instructor.is_active = false
//   link_expired      — magic link rejected at auth (renders resend form)
// Unknown reasons fall through to the generic default.

const COPY = {
  deactivated: {
    title: 'Your account has been deactivated.',
    body: 'Please contact Jessica to discuss.',
  },
  link_expired: {
    // Title + body rendered by MagicLinkResend below; nothing here.
    title: null,
    body: null,
  },
  org_misconfigured: {
    title: "Something's wrong with your account setup.",
    body: 'Please contact Jessica.',
  },
};

const DEFAULT_COPY = COPY.org_misconfigured;

export default function ErrorPage() {
  const [params] = useSearchParams();
  const reason = params.get('reason') || 'unknown';

  useEffect(() => {
    // Surface every visit so we catch misconfigured orgs and expired-link
    // bursts in the browser console + any future monitoring hook.
    console.warn('[onboarding/error] reason=', reason);
  }, [reason]);

  if (reason === 'link_expired') {
    return (
      <Shell>
        <MagicLinkResend />
      </Shell>
    );
  }

  const copy = COPY[reason] || DEFAULT_COPY;
  return (
    <Shell>
      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-neutral-900">{copy.title}</h1>
        <p className="mt-2 text-sm text-neutral-600">{copy.body}</p>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-16">
      <div className="mx-auto max-w-md">
        <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          enrops
        </div>
        {children}
      </div>
    </div>
  );
}
