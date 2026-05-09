import React from 'react';

export default function StepParent({ parent, onUpdate }) {
  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        Your contact info
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        This is where your receipt and class updates will go.
      </p>

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <div>
          <label className="label-field">First name *</label>
          <input
            className="input-field"
            value={parent.first_name}
            onChange={(e) => onUpdate({ first_name: e.target.value })}
            autoComplete="given-name"
          />
        </div>
        <div>
          <label className="label-field">Last name *</label>
          <input
            className="input-field"
            value={parent.last_name}
            onChange={(e) => onUpdate({ last_name: e.target.value })}
            autoComplete="family-name"
          />
        </div>
        <div>
          <label className="label-field">Email *</label>
          <input
            type="email"
            className="input-field"
            value={parent.email}
            onChange={(e) => onUpdate({ email: e.target.value.trim() })}
            autoComplete="email"
          />
          <p className="help-text">
            We'll send your receipt and updates here.
          </p>
        </div>
        <div>
          <label className="label-field">Phone *</label>
          <input
            type="tel"
            className="input-field"
            value={parent.phone}
            onChange={(e) => onUpdate({ phone: e.target.value })}
            autoComplete="tel"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label-field">Mailing address</label>
          <input
            className="input-field"
            value={parent.address}
            onChange={(e) => onUpdate({ address: e.target.value })}
            placeholder="Street, city, zip"
            autoComplete="street-address"
          />
          <p className="help-text">Optional, but helpful for future mailers.</p>
        </div>
      </div>
    </div>
  );
}
