import React from 'react';

// Shown when overall_status = 'declined' (failed ORS 670.600 or contractor
// confirmed they don't qualify). Dead end — no resume affordance, only the
// admin email for follow-up. No tenant branding here for v1 — spec leaves
// that open; we can wire in org_branding later if Jessica wants.

export default function DeclinedPage() {
  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-16">
      <div className="mx-auto max-w-md">
        <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          enrops
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-neutral-900">
            Your onboarding could not be completed.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            Please contact{' '}
            <a
              href="mailto:arielle@journeytosteam.com"
              className="font-semibold text-neutral-900 hover:underline"
            >
              arielle@journeytosteam.com
            </a>{' '}
            if you&rsquo;d like to discuss.
          </p>
        </div>
      </div>
    </div>
  );
}
