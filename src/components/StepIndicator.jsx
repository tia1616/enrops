import React from 'react';

const STEP_LABELS = [
  'Student',
  'Parent',
  'Waivers',
  'Review',
  'Pay',
];

export default function StepIndicator({ current }) {
  return (
    <div className="border-b border-j2s-purple/10 bg-white">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <ol className="flex items-center gap-1 sm:gap-3">
          {STEP_LABELS.map((label, i) => {
            const isActive = i === current;
            const isDone = i < current;
            return (
              <li key={label} className="flex flex-1 items-center gap-2">
                <div className="flex flex-col items-center gap-1">
                  <div
                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold transition ${
                      isActive
                        ? 'bg-j2s-purple text-white shadow-pop ring-4 ring-j2s-purple/20'
                        : isDone
                        ? 'bg-j2s-purple text-white'
                        : 'bg-j2s-purple/10 text-j2s-purple'
                    }`}
                  >
                    {isDone ? '✓' : i + 1}
                  </div>
                  <span
                    className={`hidden text-xs font-semibold sm:block ${
                      isActive
                        ? 'text-j2s-purple-dark'
                        : isDone
                        ? 'text-j2s-ink/70'
                        : 'text-j2s-ink/40'
                    }`}
                  >
                    {label}
                  </span>
                </div>
                {i < STEP_LABELS.length - 1 && (
                  <div
                    className={`h-0.5 flex-1 rounded-full ${
                      isDone ? 'bg-j2s-purple' : 'bg-j2s-purple/10'
                    }`}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
