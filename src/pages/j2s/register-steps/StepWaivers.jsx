import React from 'react';

export default function StepWaivers({
  waivers,
  signatures,
  onUpdateSignature,
  parentName,
}) {
  // Sort so required first
  const sorted = [...waivers].sort(
    (a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0),
  );

  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        Waivers &amp; agreements
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        Please read and agree to each.
      </p>

      <div className="mt-8 space-y-6">
        {sorted.map((w) => {
          const sig = signatures[w.id] || {};
          const agreed = sig.agreed === true;
          const isProgFit = /program fit|inclusivity/i.test(w.name);
          return (
            <div
              key={w.id}
              className={`rounded-2xl border-2 p-6 transition ${
                agreed
                  ? 'border-j2s-purple bg-j2s-purple-soft/40'
                  : 'border-j2s-purple/10 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <h2 className="font-titan text-xl text-j2s-ink">{w.name}</h2>
                {w.required ? (
                  <span className="flex-shrink-0 rounded-full bg-j2s-orange/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-j2s-orange-dark">
                    Required
                  </span>
                ) : (
                  <span className="flex-shrink-0 rounded-full bg-j2s-purple/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-j2s-purple">
                    Optional
                  </span>
                )}
              </div>
              <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-j2s-purple/10 bg-white p-4 text-sm leading-relaxed text-j2s-ink/80 whitespace-pre-wrap">
                {w.content}
              </div>

              <div className="mt-5">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 rounded border-2 border-j2s-purple/30 text-j2s-purple focus:ring-j2s-purple"
                    checked={agreed}
                    onChange={(e) =>
                      onUpdateSignature(w.id, {
                        agreed: e.target.checked,
                        signature_text: e.target.checked
                          ? `I agree — ${parentName}`
                          : null,
                      })
                    }
                  />
                  <span className="font-semibold text-j2s-ink">
                    I, <span className="text-j2s-purple">{parentName || '(enter your name in step 4)'}</span>, have read and agree to this {w.name.toLowerCase()}.
                  </span>
                </label>
              </div>

              {isProgFit && agreed && (
                <div className="mt-4">
                  <label className="label-field">
                    Anything you'd like us to know? (optional)
                  </label>
                  <textarea
                    className="input-field min-h-[70px]"
                    value={sig.comments || ''}
                    onChange={(e) =>
                      onUpdateSignature(w.id, { comments: e.target.value })
                    }
                    placeholder="Program fit notes, learning styles, anything helpful."
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
