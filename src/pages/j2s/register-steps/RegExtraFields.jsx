// Customizable-registration (Chunk 2) — the new standard + custom question
// fields, as presentational components. Rendered inside the existing wizard
// steps (StepStudent / StepParent), and reusable later by the Settings builder
// preview so it's true WYSIWYG (one source of truth for how a question looks).
//
// Styling matches the existing register steps (label-field / input-field /
// help-text + j2s colors). Every field renders ONLY when the org has enabled
// the matching standard/custom question, so J2S's live form is unchanged until
// those are turned on in Settings.
import React from 'react';

const MAX_PICKUP = 4;

// Turn the get_active_registration_fields() rows into a convenient shape.
export function parseRegFields(rows) {
  const std = {};
  const custom = [];
  for (const r of rows || []) {
    if (r.standard_key) {
      std[r.standard_key] = { enabled: true, required: !!r.is_required, label: r.label };
    } else if (r.is_active !== false) {
      custom.push(r);
    }
  }
  return { std, custom };
}

// Is the "extra questions" content non-empty for a child? (drives whether we
// render the section header at all)
export function hasPickupSection(std) {
  return !!(std.dismissal_method || std.authorized_pickup || std.do_not_release);
}

function Req({ on }) {
  return on ? <span className="text-j2s-orange-dark"> *</span> : null;
}

// ── Pickup & dismissal ──────────────────────────────────────────────────────
// dismissal_method choice + (conditionally) the authorized-pickup list +
// (optionally) the do-not-release list. All three are separate standard
// questions; we render whichever are enabled.
export function PickupDismissalSection({ std, dismissalMethod, onDismissalChange, pickup, onPickupChange, doNotRelease, onDoNotReleaseChange }) {
  const releasedToAdult = dismissalMethod === 'released_to_authorized_adult';
  const list = Array.isArray(pickup) ? pickup : [];
  const dnr = Array.isArray(doNotRelease) ? doNotRelease : [];

  function setPickupAt(i, patch) {
    // Use the same fallback base the render uses, so typing in the first
    // (placeholder) row when the list is still empty actually persists.
    const base = list.length ? list : [{ first_name: '', last_name: '', phone: '' }];
    const next = base.map((row, idx) => (idx === i ? { ...row, ...patch } : row));
    onPickupChange(next);
  }
  function addPickup() {
    if (list.length >= MAX_PICKUP) return;
    onPickupChange([...list, { first_name: '', last_name: '', phone: '' }]);
  }
  function removePickup(i) {
    onPickupChange(list.filter((_, idx) => idx !== i));
  }
  function setDnrAt(i, patch) {
    onDoNotReleaseChange(dnr.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function addDnr() {
    onDoNotReleaseChange([...dnr, { first_name: '', last_name: '' }]);
  }
  function removeDnr(i) {
    onDoNotReleaseChange(dnr.filter((_, idx) => idx !== i));
  }

  return (
    <div className="mt-4 grid gap-5">
      {std.dismissal_method && (
        <div>
          <label className="label-field">
            {std.dismissal_method.label || 'How does your child leave?'}<Req on={std.dismissal_method.required} />
          </label>
          <div className="mt-2 grid gap-2">
            {[
              { value: 'released_to_authorized_adult', label: 'Released to a parent or authorized adult' },
              { value: 'walks_or_bikes_home', label: 'Walks or bikes home on their own' },
            ].map((opt) => (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 px-4 py-3 transition ${
                  dismissalMethod === opt.value ? 'border-j2s-purple bg-j2s-purple-soft' : 'border-j2s-purple/15 hover:border-j2s-purple/40'
                }`}
              >
                <input
                  type="radio"
                  name="dismissal_method"
                  className="accent-j2s-purple"
                  checked={dismissalMethod === opt.value}
                  onChange={() => onDismissalChange(opt.value)}
                />
                <span className="text-sm text-j2s-ink">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {std.authorized_pickup && (releasedToAdult || !std.dismissal_method) && (
        <div>
          <label className="label-field">
            {std.authorized_pickup.label || 'Who can pick up your child?'}<Req on={std.authorized_pickup.required} />
          </label>
          <p className="help-text">Up to {MAX_PICKUP} people we're allowed to release your child to.</p>
          <div className="mt-2 grid gap-3">
            {(list.length ? list : [{ first_name: '', last_name: '', phone: '' }]).map((row, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <input className="input-field" placeholder="First name" value={row.first_name || ''}
                  onChange={(e) => setPickupAt(i, { first_name: e.target.value })} />
                <input className="input-field" placeholder="Last name" value={row.last_name || ''}
                  onChange={(e) => setPickupAt(i, { last_name: e.target.value })} />
                <input className="input-field" type="tel" placeholder="Phone (optional)" value={row.phone || ''}
                  onChange={(e) => setPickupAt(i, { phone: e.target.value })} />
                {list.length > 1 ? (
                  <button type="button" onClick={() => removePickup(i)}
                    className="rounded-lg px-3 text-sm font-semibold text-j2s-ink/50 hover:text-j2s-orange-dark" aria-label="Remove person">Remove</button>
                ) : <span />}
              </div>
            ))}
          </div>
          {list.length < MAX_PICKUP && (
            <button type="button" onClick={addPickup} className="mt-2 text-sm font-semibold text-j2s-purple hover:underline">
              + Add another person
            </button>
          )}
        </div>
      )}

      {std.do_not_release && (
        <div>
          <label className="label-field">
            {std.do_not_release.label || 'Anyone we should NOT release your child to?'}<Req on={std.do_not_release.required} />
          </label>
          <p className="help-text">Optional. Only your staff see this, never other families.</p>
          <div className="mt-2 grid gap-3">
            {dnr.map((row, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input className="input-field" placeholder="First name" value={row.first_name || ''}
                  onChange={(e) => setDnrAt(i, { first_name: e.target.value })} />
                <input className="input-field" placeholder="Last name" value={row.last_name || ''}
                  onChange={(e) => setDnrAt(i, { last_name: e.target.value })} />
                <button type="button" onClick={() => removeDnr(i)}
                  className="rounded-lg px-3 text-sm font-semibold text-j2s-ink/50 hover:text-j2s-orange-dark" aria-label="Remove person">Remove</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addDnr} className="mt-2 text-sm font-semibold text-j2s-purple hover:underline">
            + Add a name
          </button>
        </div>
      )}
    </div>
  );
}

// ── Second guardian ─────────────────────────────────────────────────────────
export function GuardianSecondarySection({ config, value, onChange }) {
  if (!config) return null;
  const g = value || {};
  const set = (patch) => onChange({ ...g, ...patch });
  return (
    <div>
      <h2 className="mt-10 font-titan text-xl text-j2s-ink">
        {config.label || 'Second parent or guardian'}
        {!config.required && <span className="ml-2 text-sm font-normal text-j2s-ink/50">(optional)</span>}
      </h2>
      <p className="mt-1 text-sm text-j2s-ink/60">Another adult who can receive updates about your child.</p>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <label className="label-field">First name<Req on={config.required} /></label>
          <input className="input-field" value={g.first_name || ''} onChange={(e) => set({ first_name: e.target.value })} />
        </div>
        <div>
          <label className="label-field">Last name<Req on={config.required} /></label>
          <input className="input-field" value={g.last_name || ''} onChange={(e) => set({ last_name: e.target.value })} />
        </div>
        <div>
          <label className="label-field">Email</label>
          <input type="email" className="input-field" value={g.email || ''} onChange={(e) => set({ email: e.target.value.trim() })} />
        </div>
        <div>
          <label className="label-field">Phone</label>
          <input type="tel" className="input-field" value={g.phone || ''} onChange={(e) => set({ phone: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

// ── Custom questions ────────────────────────────────────────────────────────
export function CustomQuestionsSection({ fields, answers, onAnswer }) {
  if (!fields || fields.length === 0) return null;
  const a = answers || {};
  return (
    <div className="mt-4 grid gap-5">
      {fields.map((f) => (
        <CustomQuestion key={f.id} field={f} value={a[f.field_key]} onChange={(v) => onAnswer(f.field_key, v)} />
      ))}
    </div>
  );
}

function CustomQuestion({ field, value, onChange }) {
  const label = (
    <label className="label-field">{field.label}<Req on={field.is_required} /></label>
  );
  const opts = Array.isArray(field.options) ? field.options : [];
  return (
    <div>
      {field.field_type !== 'checkbox' && label}
      {field.field_type === 'text' && (
        <input className="input-field" value={value || ''} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.field_type === 'textarea' && (
        <textarea className="input-field min-h-[70px]" value={value || ''} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.field_type === 'number' && (
        <input type="number" className="input-field" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.field_type === 'date' && (
        <input type="date" className="input-field" value={value || ''} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.field_type === 'select' && (
        <select className="input-field" value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select&hellip;</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {field.field_type === 'multiselect' && (
        <div className="mt-1 grid gap-2">
          {opts.map((o) => {
            const arr = Array.isArray(value) ? value : [];
            const on = arr.includes(o);
            return (
              <label key={o} className="flex cursor-pointer items-center gap-2 text-sm text-j2s-ink">
                <input type="checkbox" className="accent-j2s-purple" checked={on}
                  onChange={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])} />
                {o}
              </label>
            );
          })}
        </div>
      )}
      {field.field_type === 'checkbox' && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-j2s-ink">
          <input type="checkbox" className="accent-j2s-purple" checked={value === true || value === 'true'}
            onChange={(e) => onChange(e.target.checked)} />
          {field.label}{field.is_required ? <Req on /> : null}
        </label>
      )}
      {field.help_text && field.field_type !== 'checkbox' && <p className="help-text">{field.help_text}</p>}
    </div>
  );
}
