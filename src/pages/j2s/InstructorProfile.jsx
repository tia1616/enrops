// Instructor Portal v1 — My Profile screen.
//
// Edit fields: preferred_name, phone, avatar (8-grid picker), shirt_size,
// CPR cert (file + expiry), emergency contacts. Read-only display: legal
// first/last name, email, contractor_tier, CPR expiry warning.
//
// Calls update-instructor-profile edge function on submit. Form-dirty
// tracking so a clean save round-trips as a no-op. Matches the inline-style
// J2S branding pattern used in InstructorPortal.jsx.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AVATARS, DEFAULT_AVATAR, avatarUrl } from '../../lib/avatars';
import { ensureBrowserSafeImage, extensionFor } from '../../lib/heicConvert';

const PURPLE = '#1C004F';
const VIOLET = '#8C88FF';
const CREAM = '#FBFBFB';
const CORAL = '#D9694F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const OK = '#3a7c3a';
const RED = '#b53737';

const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const ALLOWED_CERT_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);
const MAX_CERT_BYTES = 5 * 1024 * 1024;

export default function InstructorProfile({ instructor, onBack, onSaved }) {
  // Initial values come from the instructor prop (already loaded by parent).
  const [firstName] = useState(instructor.first_name || '');
  const [lastName] = useState(instructor.last_name || '');
  const [email] = useState(instructor.email || '');
  const [preferredName, setPreferredName] = useState(instructor.preferred_name || '');
  const [phone, setPhone] = useState(instructor.phone || '');
  const [avatarKey, setAvatarKey] = useState(instructor.photo_url || '');
  const [shirtSize, setShirtSize] = useState(instructor.shirt_size || '');
  const [cprUrl, setCprUrl] = useState(instructor.first_aid_cpr_url || '');
  const [cprExpires, setCprExpires] = useState(instructor.first_aid_cpr_expires_at || '');
  const [cprFile, setCprFile] = useState(null);
  const [cprFileError, setCprFileError] = useState('');
  const [contacts, setContacts] = useState([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactsError, setContactsError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  // Snapshot the initial state so we can detect "dirty" cleanly.
  const initial = useMemo(() => ({
    preferred_name: instructor.preferred_name || '',
    phone: instructor.phone || '',
    photo_url: instructor.photo_url || '',
    shirt_size: instructor.shirt_size || '',
    first_aid_cpr_expires_at: instructor.first_aid_cpr_expires_at || '',
  }), [instructor.id]);

  // Load existing emergency contacts on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('contractor_emergency_contacts')
        .select('contact_name, relationship, phone, is_primary')
        .eq('instructor_id', instructor.id)
        .order('is_primary', { ascending: false });
      if (cancelled) return;
      if (data && data.length > 0) {
        setContacts(data.map((c) => ({
          contact_name: c.contact_name || '',
          relationship: c.relationship || '',
          phone: c.phone || '',
        })));
      } else {
        setContacts([{ contact_name: '', relationship: '', phone: '' }]);
      }
      setContactsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [instructor.id]);

  const initialContactsSig = useMemo(() => {
    // For dirty-detection on contacts. Just join after load; can't compute
    // until contacts loaded.
    if (!contactsLoaded) return null;
    return JSON.stringify(contacts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactsLoaded]);

  function setContact(i, field, value) {
    setContacts((arr) => arr.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }
  function addContact() {
    if (contacts.length >= 2) return;
    setContacts((arr) => [...arr, { contact_name: '', relationship: '', phone: '' }]);
  }
  function removeContact(i) {
    setContacts((arr) => (arr.length <= 1 ? arr : arr.filter((_, idx) => idx !== i)));
  }

  async function onCprChange(e) {
    const f = e.target.files?.[0];
    setCprFileError('');
    if (!f) { setCprFile(null); return; }
    if (!ALLOWED_CERT_MIME.has((f.type || '').toLowerCase())) {
      const name = (f.name || '').toLowerCase();
      if (!name.endsWith('.pdf') && !name.endsWith('.heic') && !name.endsWith('.heif')) {
        setCprFileError('Certificate must be PDF, JPG, PNG, WebP, or HEIC.');
        return;
      }
    }
    if (f.size > MAX_CERT_BYTES) {
      setCprFileError('Certificate must be 5MB or smaller.');
      return;
    }
    setCprFile(f);
  }

  async function uploadCprIfNeeded() {
    if (!cprFile) return cprUrl; // unchanged
    const safe = await ensureBrowserSafeImage(cprFile);
    const ext = extensionFor(safe);
    const path = `${instructor.id}/cpr_cert_${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('contractor-documents')
      .upload(path, safe, { contentType: safe.type, upsert: false });
    if (upErr) throw upErr;
    return path;
  }

  // Compute the partial body to send. Only include fields that changed.
  // empty-after-trim preferred_name → send empty string (clears).
  // empty-after-trim phone → omit (don't overwrite real number with '').
  function buildPayload(uploadedCprUrl) {
    const body = {};
    if (preferredName !== initial.preferred_name) {
      body.preferred_name = preferredName.trim();
    }
    if (phone.trim() !== initial.phone.trim()) {
      body.phone = phone.trim();
    }
    if (avatarKey !== initial.photo_url) {
      body.avatar_key = avatarKey || ''; // edge function rejects empty → handled by gating in submit
    }
    if (shirtSize !== initial.shirt_size) {
      body.shirt_size = shirtSize;
    }
    if (uploadedCprUrl !== (instructor.first_aid_cpr_url || '')) {
      body.first_aid_cpr_url = uploadedCprUrl;
    }
    if (cprExpires !== initial.first_aid_cpr_expires_at) {
      body.first_aid_cpr_expires_at = cprExpires;
    }
    if (contactsLoaded && JSON.stringify(contacts) !== initialContactsSig) {
      // Only send if at least one contact has any filled field; otherwise omit.
      const cleaned = contacts.filter((c) =>
        c.contact_name.trim() || c.relationship.trim() || c.phone.trim()
      ).map((c) => ({
        contact_name: c.contact_name.trim(),
        relationship: c.relationship.trim(),
        phone: c.phone.trim(),
      }));
      if (cleaned.length > 0) {
        body.emergency_contacts = cleaned;
      }
    }
    return body;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    // Inline validation
    setContactsError('');
    if (cprFile && !cprExpires) {
      setSubmitError('Add the expiry date from your certificate.');
      return;
    }
    // If contacts have been touched, every row must be complete or empty.
    const partial = contacts.find((c) => {
      const filled = [c.contact_name, c.relationship, c.phone].some((v) => v.trim());
      const complete = c.contact_name.trim() && c.relationship.trim() && c.phone.trim();
      return filled && !complete;
    });
    if (partial) {
      setContactsError('Name, relationship, and phone are all required for each contact.');
      return;
    }

    setBusy(true);
    setSubmitError('');
    setSuccess(false);

    try {
      let uploadedUrl = cprUrl;
      if (cprFile) {
        uploadedUrl = await uploadCprIfNeeded();
        setCprUrl(uploadedUrl);
        setCprFile(null);
      }

      const payload = buildPayload(uploadedUrl);

      if (Object.keys(payload).length === 0) {
        // Nothing changed — show a quick "no changes" hint, don't call the function.
        setSuccess(true);
        setBusy(false);
        setTimeout(() => setSuccess(false), 2000);
        return;
      }

      const { data, error: fnErr } = await supabase.functions.invoke('update-instructor-profile', {
        body: payload,
      });
      if (fnErr || data?.error) {
        // Distinguish the partial-success path (instructors updated, contacts failed)
        if (data?.error === 'contacts_save_failed') {
          setContactsError(
            "Your other changes saved, but emergency contacts didn't save. Please check and try again."
          );
        } else {
          setSubmitError(data?.error || fnErr?.message || 'Save failed.');
        }
        setBusy(false);
        return;
      }

      setSuccess(true);
      setBusy(false);
      if (onSaved) onSaved();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error('[InstructorProfile] submit failed', err);
      setSubmitError(err.message || 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  const cprExpired = cprExpires &&
    new Date(`${cprExpires}T00:00:00`) < new Date(new Date().toDateString());

  return (
    <div>
      <header style={{ marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: 0 }}>My Profile</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            Update what we show on your schedule and how to reach you.
          </div>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              background: 'transparent', border: `1px solid ${PURPLE}`, color: PURPLE,
              padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            ← Back to schedule
          </button>
        )}
      </header>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Read-only identity */}
        <Card>
          <SectionLabel>Your identity</SectionLabel>
          <Row label="Legal name (locked)">
            <span style={{ color: INK }}>{firstName} {lastName}</span>
            <div style={{ color: MUTED, fontSize: 11, marginTop: 2 }}>
              Need a legal-name change? Contact admin.
            </div>
          </Row>
          <Row label="Email (locked)">
            <span style={{ color: MUTED }}>{email}</span>
          </Row>
          <Row label="Preferred name (optional)">
            <input
              type="text"
              value={preferredName}
              onChange={(e) => setPreferredName(e.target.value)}
              placeholder="What people call you — e.g. Bo"
              style={input()}
            />
            <div style={{ color: MUTED, fontSize: 11, marginTop: 2 }}>
              We'll use this on your schedule and in messages.
            </div>
          </Row>
          <Row label="Phone">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={input()}
              autoComplete="tel"
            />
          </Row>
        </Card>

        {/* Avatar picker */}
        <Card>
          <SectionLabel>Avatar</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))', gap: 8, marginTop: 4 }}>
            {AVATARS.map((a) => {
              const selected = avatarKey === a.key;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setAvatarKey(a.key)}
                  title={a.label}
                  style={{
                    padding: 6,
                    background: selected ? `${PURPLE}14` : '#fff',
                    border: `2px solid ${selected ? PURPLE : RULE}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <img
                    src={avatarUrl(a.key)}
                    alt={a.label}
                    onError={(e) => { e.currentTarget.src = avatarUrl(DEFAULT_AVATAR.key); }}
                    style={{ width: '100%', height: 'auto', maxWidth: 60, display: 'block', margin: '0 auto' }}
                  />
                  <div style={{ fontSize: 10, color: MUTED, textAlign: 'center', marginTop: 4 }}>{a.label}</div>
                </button>
              );
            })}
          </div>
          {avatarKey && (
            <button
              type="button"
              onClick={() => setAvatarKey('')}
              style={{ marginTop: 8, background: 'transparent', border: 'none', color: MUTED, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Clear selection
            </button>
          )}
        </Card>

        {/* Unisex shirt size */}
        <Card>
          <SectionLabel>Unisex shirt size (optional)</SectionLabel>
          <div style={{ color: MUTED, fontSize: 12, marginBottom: 6 }}>For J2S camp apparel.</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SHIRT_SIZES.map((s) => (
              <label
                key={s}
                style={{
                  padding: '6px 12px',
                  border: `1px solid ${shirtSize === s ? PURPLE : RULE}`,
                  background: shirtSize === s ? PURPLE : '#fff',
                  color: shirtSize === s ? '#fff' : INK,
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <input type="radio" name="shirt" value={s} checked={shirtSize === s} onChange={() => setShirtSize(s)} style={{ display: 'none' }} />
                {s}
              </label>
            ))}
            {shirtSize && (
              <button
                type="button"
                onClick={() => setShirtSize('')}
                style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Clear
              </button>
            )}
          </div>
        </Card>

        {/* CPR cert */}
        <Card>
          <SectionLabel>First Aid / CPR certificate (optional)</SectionLabel>
          {cprUrl && (
            <div style={{ color: MUTED, fontSize: 12, marginBottom: 6 }}>
              Currently on file
              {cprExpires && (
                <> · expires <span style={{ color: cprExpired ? RED : MUTED }}>{cprExpires}{cprExpired && ' (expired)'}</span></>
              )}
            </div>
          )}
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf,.heic,.heif"
            onChange={onCprChange}
            style={{ fontSize: 12 }}
          />
          {cprFile && (
            <div style={{ color: MUTED, fontSize: 11, marginTop: 4 }}>
              {cprFile.name} · {(cprFile.size / 1024).toFixed(0)} KB
            </div>
          )}
          {cprFileError && <FieldError>{cprFileError}</FieldError>}
          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 11, color: MUTED, display: 'block', marginBottom: 4 }}>Expires</label>
            <input
              type="date"
              value={cprExpires}
              onChange={(e) => setCprExpires(e.target.value)}
              style={{ ...input(), width: 180 }}
            />
            {cprExpired && (
              <div style={{ color: '#b67e00', fontSize: 11, marginTop: 4 }}>
                This certificate has already expired — you may want to upload a current one.
              </div>
            )}
          </div>
        </Card>

        {/* Emergency contacts */}
        <Card>
          <SectionLabel>Emergency contacts</SectionLabel>
          {!contactsLoaded ? (
            <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
          ) : (
            <>
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
                  style={{ marginTop: 4, background: 'transparent', border: 'none', color: PURPLE, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  + Add second contact
                </button>
              )}
              {contactsError && <FieldError>{contactsError}</FieldError>}
            </>
          )}
        </Card>

        {submitError && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13 }}>
            {submitError}
          </div>
        )}
        {success && (
          <div style={{ background: `${OK}1A`, color: OK, padding: 10, borderRadius: 6, fontSize: 13 }}>
            Saved ✓
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: '10px 18px',
              background: PURPLE,
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Card({ children }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${RULE}`, borderRadius: 8, padding: 16 }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: MUTED, display: 'block', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  );
}

function ContactRow({ index, contact, showRemove, onChange, onRemove }) {
  return (
    <div style={{ marginBottom: 10, padding: 10, border: `1px solid ${RULE}`, borderRadius: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {index === 0 ? 'Primary' : 'Secondary'}
        </span>
        {showRemove && (
          <button
            type="button"
            onClick={onRemove}
            style={{ background: 'transparent', border: 'none', color: RED, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Remove
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <input
          type="text"
          value={contact.contact_name}
          onChange={(e) => onChange('contact_name', e.target.value)}
          placeholder="Name"
          style={input()}
        />
        <input
          type="text"
          value={contact.relationship}
          onChange={(e) => onChange('relationship', e.target.value)}
          placeholder="Relationship"
          style={input()}
        />
        <input
          type="tel"
          value={contact.phone}
          onChange={(e) => onChange('phone', e.target.value)}
          placeholder="Phone"
          style={input()}
        />
      </div>
    </div>
  );
}

function FieldError({ children }) {
  return <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>{children}</div>;
}

function input() {
  return {
    width: '100%',
    padding: '8px 12px',
    border: `1px solid ${RULE}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    color: INK,
    background: '#fff',
    boxSizing: 'border-box',
  };
}
