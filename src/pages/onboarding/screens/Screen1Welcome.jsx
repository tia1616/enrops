import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { AVATARS, avatarUrl, DEFAULT_AVATAR } from '../../../lib/avatars.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 1 — Welcome + Identity. Phone is required; legal + preferred name
// are pre-filled and editable. Avatar picker is optional but encouraged so
// the contractor leaves onboarding with a populated profile. The DB column
// is photo_url (misnomer post-v1; stores an avatar KEY, not a URL — see
// lib/avatars.js).

function phoneIsValid(s) {
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

export default function Screen1Welcome({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState(instructor.first_name || '');
  const [lastName, setLastName] = useState(instructor.last_name || '');
  const [preferredName, setPreferredName] = useState(instructor.preferred_name || '');
  const [phone, setPhone] = useState(instructor.phone || '');
  const [avatarKey, setAvatarKey] = useState(instructor.photo_url || '');
  const [phoneError, setPhoneError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    if (!phone.trim()) {
      setPhoneError('Phone is required.');
      return;
    }
    if (!phoneIsValid(phone)) {
      setPhoneError('Enter a valid phone number.');
      return;
    }
    setPhoneError('');

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
            photo_url: avatarKey || null,
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
            <Label>Legal first name</Label>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
          </div>
          <div>
            <Label>Legal last name</Label>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
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

        <div className="mt-6">
          <Label>Pick an avatar (optional)</Label>
          <p className="mt-1 text-xs text-neutral-500">
            Shown next to your name on the schedule and in messages.
          </p>
          <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-8">
            {AVATARS.map((a) => {
              const selected = avatarKey === a.key;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setAvatarKey(selected ? '' : a.key)}
                  title={a.label}
                  className={`flex flex-col items-center rounded-md border-2 bg-white p-1.5 transition ${
                    selected ? 'border-neutral-900 bg-neutral-100' : 'border-neutral-200 hover:border-neutral-400'
                  }`}
                >
                  <img
                    src={avatarUrl(a.key)}
                    alt={a.label}
                    onError={(e) => { e.currentTarget.src = avatarUrl(DEFAULT_AVATAR.key); }}
                    className="block h-12 w-12"
                  />
                </button>
              );
            })}
          </div>
        </div>

        <ScreenError>{submitError}</ScreenError>

        <PrimaryButton disabled={busy || !phone || !phoneIsValid(phone)}>
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
