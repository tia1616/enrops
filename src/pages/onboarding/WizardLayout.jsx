import React from 'react';
import { STEP_ORDER, TOTAL_STEPS, stepNumber } from '../../lib/onboardingSteps.js';

// Shared shell for every wizard screen: progress bar, step number/title, and
// the body slot. Screens render their own primary submit button inside the
// body so they can disable it based on per-screen validation.

export default function WizardLayout({
  currentStep,
  stepsCompleted,
  title,
  subtitle,
  children,
  slug,
  onBack,
}) {
  const num = stepNumber(currentStep);

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="mx-auto max-w-xl px-4 py-8">
        <div className="mb-4 flex items-baseline justify-between">
          <div className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
            {slug ? `${slug} · onboarding` : 'onboarding'}
          </div>
          <div className="text-xs font-semibold text-neutral-500">
            Step {num} of {TOTAL_STEPS}
          </div>
        </div>
        <ProgressBar currentStep={currentStep} stepsCompleted={stepsCompleted} />
        <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mb-3 inline-flex items-center text-xs font-semibold text-neutral-500 hover:text-neutral-900"
            >
              ← Back
            </button>
          )}
          <h1 className="text-xl font-semibold text-neutral-900">{title}</h1>
          {subtitle && (
            <p className="mt-2 text-sm leading-relaxed text-neutral-600">{subtitle}</p>
          )}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ currentStep, stepsCompleted }) {
  return (
    <div className="flex gap-1" role="list" aria-label="Onboarding progress">
      {STEP_ORDER.map((key, i) => {
        const done = Boolean(stepsCompleted?.[key]);
        const current = key === currentStep;
        return (
          <div
            key={key}
            role="listitem"
            aria-label={`Step ${i + 1} ${done ? 'complete' : current ? 'current' : 'upcoming'}`}
            className={`h-1.5 flex-1 rounded-full ${
              done ? 'bg-neutral-900' : current ? 'bg-neutral-400' : 'bg-neutral-200'
            }`}
          />
        );
      })}
    </div>
  );
}

// Shared error banner styling for top-of-screen errors that aren't bound to
// a specific field. Per-field errors render inline below their input.
export function ScreenError({ children }) {
  if (!children) return null;
  return (
    <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-900">
      {children}
    </div>
  );
}

export function FieldError({ children }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-red-700">{children}</p>;
}

export function PrimaryButton({ children, disabled, ...rest }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="mt-6 w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
      {...rest}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ children, ...rest }) {
  return (
    <button
      type="button"
      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 transition hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-50"
      {...rest}
    >
      {children}
    </button>
  );
}
