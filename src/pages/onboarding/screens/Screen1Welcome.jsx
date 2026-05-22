import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase.js';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { ensureBrowserSafeImage, extensionFor } from '../../../lib/heicConvert.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 1 — Welcome + Identity. Phone is required, photo is optional.
// Photo: HEIC -> JPEG client-side via heic2any, then max 2MB post-conversion,
// uploaded to private contractor-documents bucket before edge-function POST.

const ALLOWED_PHOTO_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

function phoneIsValid(s) {
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  // US phone numbers: 10 digits, or 11 with leading 1.
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

export default function Screen1Welcome({ slug, instructor, onboarding, onAdvance }) {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState(instructor.first_name || '');
  const [lastName, setLastName] = useState(instructor.last_name || '');
  const [phone, setPhone] = useState(instructor.phone || '');
  const [photoFile, setPhotoFile] = useState(null);
  const [photoError, setPhotoError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onPhotoChange(e) {
    const file = e.target.files?.[0];
    setPhotoError('');
    if (!file) {
      setPhotoFile(null);
      return;
    }
    if (!ALLOWED_PHOTO_TYPES.has((file.type || '').toLowerCase())) {
      // Some browsers don't tag .heic — fall back to extension.
      const name = (file.name || '').toLowerCase();
      if (!name.endsWith('.heic') && !name.endsWith('.heif')) {
        setPhotoError('Photo must be JPG, PNG, WebP, or HEIC.');
        setPhotoFile(null);
        return;
      }
    }
    try {
      const safe = await ensureBrowserSafeImage(file);
      if (safe.size > MAX_PHOTO_BYTES) {
        setPhotoError('Photo must be 2MB or smaller.');
        setPhotoFile(null);
        return;
      }
      setPhotoFile(safe);
    } catch (err) {
      console.error('[Screen1] HEIC conversion failed', err);
      setPhotoError("Couldn't process that image. Please try a different photo.");
      setPhotoFile(null);
    }
  }

  async function uploadPhoto(file) {
    const ext = extensionFor(file);
    const path = `${instructor.id}/photo_${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('contractor-documents')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;
    return path;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    let valid = true;

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
      let photo_url = instructor.photo_url || null;
      if (photoFile) {
        photo_url = await uploadPhoto(photoFile);
      }

      const { error } = await invokeOnboardingFn(
        'update-onboarding-step',
        {
          step_name: STEP_KEYS.WELCOME,
          step_data: {
            phone: phone.trim(),
            photo_url,
            first_name: firstName.trim() || null,
            last_name: lastName.trim() || null,
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
      title="Welcome to enrops"
      subtitle="Journey to STEAM is your client. enrops is the platform we use for paperwork, scheduling, communication, and payments. You will no longer use Gusto."
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label>First name</Label>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
          </div>
          <div>
            <Label>Last name</Label>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
          </div>
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

        <div className="mt-4">
          <Label>Photo (optional)</Label>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
            onChange={onPhotoChange}
            className="mt-1 block w-full text-sm text-neutral-700 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-neutral-800 hover:file:bg-neutral-300"
          />
          {photoFile && (
            <p className="mt-1 text-xs text-neutral-500">
              {photoFile.name} · {(photoFile.size / 1024).toFixed(0)} KB
            </p>
          )}
          <FieldError>{photoError}</FieldError>
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
