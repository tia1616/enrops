import React from 'react';

// Shown when overall_status = 'declined' (failed ORS 670.600 or contractor
// confirmed they don't qualify). Dead end — no resume affordance.
//
// This page used to name ONE provider's owner and her email address to EVERY
// provider's declined instructors. Identical to the five strings fixed on the
// abandoned-onboarding page on 2026-08-11 — that sweep found this page's sibling
// and missed this one, because the bug was an address here rather than a name.
// "Program Manager" is JESSICA'S WORD, chosen by her, and is deliberately a ROLE
// rather than a person or an address: it is true for every provider, needs no
// per-org config, and cannot go stale when someone changes job.
//
// Do NOT "improve" this by interpolating the org's own support address. There
// isn't a reliable one — organizations.email and alert_email are both nullable
// and an operator can clear them — so it would render a dangling "contact "
// exactly when someone is already stuck. A role always resolves.

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
            Please contact your Program Manager if you&rsquo;d like to discuss.
          </p>
        </div>
      </div>
    </div>
  );
}
