import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { phoneIsValid, looksLikeName } from '../../../lib/validation.js';
import { normalizePreferredName } from '../../../lib/instructorName.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 1 — Welcome + Identity. Phone is required; legal + preferred name
// are pre-filled and editable. Avatar selection lives on the My Profile
// view inside the portal -- intentionally not part of onboarding so the
// wizard stays focused on legal/identity setup.

export default function Screen1Welcome({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState(instructor.first_name || '');
  const [lastName, setLastName] = useState(instructor.last_name || '');
  const [preferredName, setPreferredName] = useState(instructor.preferred_name || '');
  const [phone, setPhone] = useState(instructor.phone || '');
  const [firstNameError, setFirstNameError] = useState('');
  const [lastNameError, setLastNameError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    let valid = true;
    if (!firstName.trim()) {
      setFirstNameError('Legal first name is required.');
      valid = false;
    } else if (!looksLikeName(firstName)) {
      setFirstNameError("That doesn't look like a name — please enter your legal first name.");
      valid = false;
    } else {
      setFirstNameError('');
    }
    if (!lastName.trim()) {
      setLastNameError('Legal last name is required.');
      valid = false;
    } else if (!looksLikeName(lastName)) {
      setLastNameError("That doesn't look like a name — please enter your legal last name.");
      valid = false;
    } else {
      setLastNameError('');
    }
    if (!phone.trim()) {
      setPhoneError('Phone is required.');
      valid = false;
    } else if (!phoneIsValid(phone)) {
      setPhoneError('Enter a valid phone number.');
      valid = false;
    } else {
      setPhoneError('');
    }
    if (!valid) return;

    setBusy(true);
    setSubmitError('');
    try {
      const { error } = await invokeOnboardingFn(
        'update-onboarding-step',
        {
          step_name: STEP_KEYS.WELCOME,
          step_data: {
            phone: phone.trim(),
            first_name: firstName.trim() || null,
            last_name: lastName.trim() || null,
            // Normalised, not raw: someone who types their own legal first name
            // here is saying nothing, and the column should hold nothing. The
            // edge function treats '' as "clear it". See normalizePreferredName.
            preferred_name: normalizePreferredName(preferredName, firstName),
          },
        },
        { navigate }
      );
      if (error) {
        setSubmitError(error.message || 'Something went wrong. Please try again.');
        setBusy(false);
        return;
      }
      onAdvance();
    } catch (err) {
      if (isHandledRedirect(err)) return;
      console.error('[Screen1] submit failed', err);
      setSubmitError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  // NO SUBTITLE, DELIBERATELY — WizardLayout renders it only when present.
  //
  // This screen carried one tenant's onboarding note: it named that provider as
  // "your client" and told the reader they would "no longer use Gusto". It was
  // shown to EVERY provider's instructors, most of whom have never had a payroll
  // system to leave, and none of whom work for that provider. Same class as the
  // abandoned-onboarding page naming one provider's owner to everyone.
  //
  // DELETED, not rewritten per-tenant (Jessica, 2026-08-12: "even j2s doesn't
  // need it anymore"). There is nothing a platform can say here that the page
  // does not already say better: the title names the platform, and each field
  // explains what it is for. Who an instructor works for is not something they
  // need telling. A per-org version would just be a config field every provider
  // has to fill in to say nothing — if one ever wants their own welcome note,
  // that is a deliberate authoring surface, not a default with a tenant baked in.
  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.WELCOME}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Welcome to enrops"
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label>Legal first name <span className="text-red-600">*</span></Label>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
            <FieldError>{firstNameError}</FieldError>
          </div>
          <div>
            <Label>Legal last name <span className="text-red-600">*</span></Label>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            <FieldError>{lastNameError}</FieldError>
          </div>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Legal name is used on your contractor agreement and tax forms.
        </p>

        <div className="mt-4">
          <Label>Preferred name (optional)</Label>
          {/* NO autoComplete. It asked for "nickname", which is a real contact
              field an autofill source can offer to complete — and when a contact
              card has no nickname, filling it from the given name is a plausible
              thing for a browser to do. Jeff's team reported this field becoming
              the legal name "automatically" (2026-08-26). Nothing in our code
              copies it, and this hint bought nothing even when it worked: a
              stored nickname is exactly the answer we DON'T want, because the
              value is only meaningful when the person types it deliberately. */}
          <Input
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
            autoComplete="off"
            placeholder="e.g. Bo"
          />
          {/* This helper has now been wrong in two different directions, and both
              were answered correctly by the instructor.
              1. "What you go by day-to-day" got "Jennifer or Jen" — a true answer
                 that is not a name, so her portal read "Hi Jennifer or Jen".
                 Hence "one name".
              2. The same wording got "Lana" from someone whose legal name is
                 Lana — also a true answer, and also not what the column is for.
                 Hence naming their own first name back at them as the case for
                 leaving it EMPTY. A blank box has to look like a real answer or
                 people will fill it in.
              The save normalises this anyway (normalizePreferredName), so a
              legal-name answer is harmless now; the wording is what stops the
              person wondering why their nickname says what it says. */}
          <p className="mt-1 text-xs text-neutral-500">
            Only if you go by something <em>different</em> &mdash; one name, not a list.
            {firstName.trim()
              ? <> Leave it blank if you go by {firstName.trim()}.</>
              : <> Leave it blank if you go by your legal first name.</>}
          </p>
        </div>

        <div className="mt-4">
          <Label>Email</Label>
          <Input value={instructor.email || ''} readOnly className="bg-neutral-50 text-neutral-500" />
        </div>

        <div className="mt-4">
          <Label>Phone <span className="text-red-600">*</span></Label>
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            placeholder="(503) 555-0123"
          />
          <FieldError>{phoneError}</FieldError>
        </div>

        <ScreenError>{submitError}</ScreenError>

        <PrimaryButton disabled={busy || !firstName.trim() || !lastName.trim() || !phone || !phoneIsValid(phone)}>
          {busy ? 'Saving…' : 'Continue →'}
        </PrimaryButton>
      </form>
    </WizardLayout>
  );
}

function Label({ children }) {
  return (
    <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </label>
  );
}

function Input(props) {
  return (
    <input
      className={`mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none ${props.className || ''}`}
      {...props}
    />
  );
}
