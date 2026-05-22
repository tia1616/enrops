import React from 'react';
import { STEP_ORDER, STEP_LABELS, TOTAL_STEPS, stepNumber } from '../../lib/onboardingSteps.js';

// Phase B-2 placeholder. Phase B-3 will fill this in with the real Screen 1-8
// components (Welcome, BackgroundCheck, ORS, Agreement, Policies, Additional,
// Stripe, EmergencyAndPrefs) and the completion screen.
//
// The shape (slug + instructor + onboarding + initialStep props) is the
// public contract OnboardingRouter relies on; that won't change in B-3.

export default function WizardHost({ slug, instructor, onboarding, initialStep }) {
  const step = initialStep || STEP_ORDER[0];
  const num = stepNumber(step);

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8">
      <div className="mx-auto max-w-xl">
        <div className="mb-4 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          {slug} · onboarding
        </div>
        <ProgressBar currentStep={step} stepsCompleted={onboarding?.steps_completed || {}} />
        <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Step {num} of {TOTAL_STEPS}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-neutral-900">
            {STEP_LABELS[step] || 'Onboarding'}
          </h1>
          <p className="mt-4 text-sm text-neutral-600">
            Hi {instructor?.first_name || 'there'} — this screen will be built in
            Phase B-3. Routing, slug resolution, deactivation handling, and
            minor detection are working.
          </p>
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ currentStep, stepsCompleted }) {
  return (
    <div className="flex gap-1">
      {STEP_ORDER.map((key, i) => {
        const done = Boolean(stepsCompleted[key]);
        const current = key === currentStep;
        return (
          <div
            key={key}
            className={`h-1.5 flex-1 rounded-full ${
              done ? 'bg-neutral-900' : current ? 'bg-neutral-400' : 'bg-neutral-200'
            }`}
            aria-label={`Step ${i + 1} ${done ? 'complete' : current ? 'current' : 'upcoming'}`}
          />
        );
      })}
    </div>
  );
}
