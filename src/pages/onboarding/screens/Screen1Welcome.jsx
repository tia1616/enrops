import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { phoneIsValid, looksLikeName } from '../../../lib/validation.js';
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
            preferred_name: preferredName.trim(),
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

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.WELCOME}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Welcome to enrops"
      subtitle="Journey to STEAM is your client. enrops is the platform we use for paperwork, scheduling, communication, and payments. You will no longer use Gusto."
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
          <Input
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
            autoComplete="nickname"
            placeholder="What you go by — e.g. Bo"
          />
          <p className="mt-1 text-xs text-neutral-500">
            What you go by day-to-day. We&rsquo;ll use this on your schedule and in messages.
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
