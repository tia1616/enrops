import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase.js';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { extensionFor } from '../../../lib/heicConvert.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import WizardLayout, { PrimaryButton, FieldError, ScreenError } from '../WizardLayout.jsx';

// Screen 8 — Emergency Contact + Shirt size + CPR cert. Always re-editable
// per spec. Sends an ordered emergency_contacts array to the edge function;
// the function assigns is_primary from position (index 0 = primary), so we
// never send is_primary from the client.
//
// Site/district preferences and day-of-week availability live in the
// separate per-cycle availability survey, NOT in onboarding -- onboarding
// is a one-time setup, availability changes term to term.

const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

const ALLOWED_CERT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const MAX_CERT_BYTES = 5 * 1024 * 1024;

function emptyContact() {
  return { contact_name: '', relationship: '', phone: '' };
}

function contactFilled(c) {
  return (
    c.contact_name.trim().length > 0 &&
    c.relationship.trim().length > 0 &&
    c.phone.trim().length > 0
  );
}

export default function Screen8EmergencyAndPrefs({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([emptyContact()]);
  const [cprFile, setCprFile] = useState(null);
  const [cprFileError, setCprFileError] = useState('');
  const [cprExpires, setCprExpires] = useState('');
  const [shirtSize, setShirtSize] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [contactsError, setContactsError] = useState('');
  const [cprExpiryError, setCprExpiryError] = useState('');
  const [busy, setBusy] = useState(false);

  // Initial load: existing emergency contacts + prefill CPR/shirt fields.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data: existingContacts } = await supabase
        .from('contractor_emergency_contacts')
        .select('contact_name, relationship, phone, is_primary')
        .eq('instructor_id', instructor.id)
        .order('is_primary', { ascending: false });
      if (cancelled) return;

      if (existingContacts && existingContacts.length > 0) {
        setContacts(
          existingContacts.map((c) => ({
            contact_name: c.contact_name || '',
            relationship: c.relationship || '',
            phone: c.phone || '',
          }))
        );
      }

      if (instructor.first_aid_cpr_expires_at) {
        setCprExpires(instructor.first_aid_cpr_expires_at);
      }
      if (instructor.shirt_size) {
        setShirtSize(instructor.shirt_size);
      }
    }
    load().catch((err) => console.error('[Screen8] load failed', err));
    return () => {
      cancelled = true;
    };
  }, [instructor.id, instructor.first_aid_cpr_expires_at, instructor.shirt_size]);

  function setContact(i, field, value) {
    setContacts((arr) => arr.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }
  function addContact() {
    if (contacts.length >= 2) return;
    setContacts((arr) => [...arr, emptyContact()]);
  }
  function removeContact(i) {
    setContacts((arr) => (arr.length <= 1 ? arr : arr.filter((_, idx) => idx !== i)));
  }

  function onCprChange(e) {
    const file = e.target.files?.[0];
    setCprFileError('');
    if (!file) {
      setCprFile(null);
      return;
    }
    if (!ALLOWED_CERT_TYPES.has((file.type || '').toLowerCase())) {
      setCprFileError('Certificate must be PDF, JPG, PNG, WebP, or HEIC.');
      setCprFile(null);
      return;
    }
    if (file.size > MAX_CERT_BYTES) {
      setCprFileError('Certificate must be 5MB or smaller.');
      setCprFile(null);
      return;
    }
    setCprFile(file);
  }

  async function uploadCpr(file) {
    const ext = extensionFor(file);
    const path = `${instructor.id}/cpr_cert_${Date.now()}.${ext}`;
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
    setContactsError('');
    setCprExpiryError('');

    const filled = contacts.filter(contactFilled);
    if (filled.length === 0) {
      // Distinguish "zero contacts at all" from "partial contact row".
      const anyPartial = contacts.some(
        (c) => c.contact_name.trim() || c.relationship.trim() || c.phone.trim()
      );
      if (anyPartial) {
        setContactsError('Name, relationship, and phone are all required.');
      } else {
        setContactsError('Add at least one emergency contact.');
      }
      valid = false;
    } else if (contacts.some((c, i) => i < filled.length && !contactFilled(c))) {
      // Partial in the middle.
      setContactsError('Name, relationship, and phone are all required.');
      valid = false;
    }

    if (cprFile && !cprExpires) {
      setCprExpiryError('Add the expiry date from the certificate.');
      valid = false;
    }
    if (!valid) return;

    setBusy(true);
    setSubmitError('');
    try {
      let first_aid_cpr_url = instructor.first_aid_cpr_url || null;
      if (cprFile) {
        first_aid_cpr_url = await uploadCpr(cprFile);
      }

      const { error } = await invokeOnboardingFn(
        'update-onboarding-step',
        {
          step_name: STEP_KEYS.EMERGENCY_AND_PREFS,
          step_data: {
            emergency_contacts: filled.map((c) => ({
              contact_name: c.contact_name.trim(),
              relationship: c.relationship.trim(),
              phone: c.phone.trim(),
            })),
            first_aid_cpr_url,
            first_aid_cpr_expires_at: cprExpires || null,
            shirt_size: shirtSize,
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
      console.error('[Screen8] submit failed', err);
      setSubmitError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  const expiryInPast =
    cprExpires && new Date(`${cprExpires}T00:00:00`) < new Date(new Date().toDateString());

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.EMERGENCY_AND_PREFS}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Almost done"
      subtitle="One last step. You can come back and update this anytime."
    >
      <form onSubmit={handleSubmit} noValidate>
        <section>
          <SectionLabel>Emergency contact (required)</SectionLabel>
          {contacts.map((c, i) => (
            <ContactRow
              key={i}
              index={i}
              contact={c}
              showRemove={contacts.length > 1}
              onChange={(field, value) => setContact(i, field, value)}
              onRemove={() => removeContact(i)}
            />
          ))}
          {contacts.length < 2 && (
            <button
              type="button"
              onClick={addContact}
              className="mt-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 hover:text-neutral-900"
            >
              + Add second contact
            </button>
          )}
          <FieldError>{contactsError}</FieldError>
        </section>

        <section className="mt-6">
          <SectionLabel>Unisex shirt size (optional)</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {SHIRT_SIZES.map((s) => (
              <label
                key={s}
                className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
                  shirtSize === s
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-300 bg-white text-neutral-700'
                }`}
              >
                <input
                  type="radio"
                  name="shirt-size"
                  value={s}
                  checked={shirtSize === s}
                  onChange={() => setShirtSize(s)}
                  className="sr-only"
                />
                {s}
              </label>
            ))}
            {shirtSize && (
              <button
                type="button"
                onClick={() => setShirtSize('')}
                className="text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-800"
              >
                Clear
              </button>
            )}
          </div>
        </section>

        <section className="mt-6">
          <SectionLabel>First Aid / CPR (optional)</SectionLabel>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf,.heic,.heif"
            onChange={onCprChange}
            className="mt-1 block w-full text-sm text-neutral-700 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-neutral-800 hover:file:bg-neutral-300"
          />
          {cprFile && (
            <p className="mt-1 text-xs text-neutral-500">
              {cprFile.name} · {(cprFile.size / 1024).toFixed(0)} KB
            </p>
          )}
          <FieldError>{cprFileError}</FieldError>

          <div className="mt-3">
            <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Expires
            </label>
            <input
              type="date"
              value={cprExpires}
              onChange={(e) => setCprExpires(e.target.value)}
              className="mt-1 block w-44 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
            />
            <FieldError>{cprExpiryError}</FieldError>
            {expiryInPast && (
              <p className="mt-1 text-xs text-amber-700">
                This certificate has already expired — you may want to upload a current one.
              </p>
            )}
          </div>
        </section>

        <ScreenError>{submitError}</ScreenError>

        <PrimaryButton disabled={busy}>
          {busy ? 'Saving…' : 'Complete onboarding →'}
        </PrimaryButton>
      </form>
    </WizardLayout>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="mb-2 border-b border-neutral-200 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </div>
  );
}

function ContactRow({ index, contact, showRemove, onChange, onRemove }) {
  return (
    <div className="mb-3 rounded-md border border-neutral-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {index === 0 ? 'Primary' : 'Secondary'}
        </span>
        {showRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs font-semibold uppercase tracking-wide text-red-700 hover:text-red-900"
          >
            Remove
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          value={contact.contact_name}
          onChange={(e) => onChange('contact_name', e.target.value)}
          placeholder="Name"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
        />
        <input
          value={contact.relationship}
          onChange={(e) => onChange('relationship', e.target.value)}
          placeholder="Relationship"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
        />
        <input
          type="tel"
          value={contact.phone}
          onChange={(e) => onChange('phone', e.target.value)}
          placeholder="Phone"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
        />
      </div>
    </div>
  );
}
