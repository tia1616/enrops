import React, { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/supabase.js';

// The light waitlist join form.
//
// ONE component, used by BOTH registration trees in portal/Home.jsx (the lean catalog and
// J2S's own). The two trees draw their own buttons because they are styled differently and
// sell different things, but they open THIS - so the fields collected, the request shape
// and the confirmation wording exist once.
//
// DELIBERATELY NOT THE 5-STEP WIZARD. Jessica's call, 2026-08-19: child name + grade and
// parent contact, nothing else. No waivers, no custom questions, no dismissal answers, no
// payment. Those get collected properly when an invited family goes through real
// registration later, which is the only moment they are actually needed - and asking for
// them now would make joining a list feel heavier than buying a seat.

const FIELD = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1.5px solid rgba(0,0,0,0.15)',
  fontSize: 15,
  boxSizing: 'border-box',
};
const LABEL = { display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 4 };

export default function WaitlistModal({ program, orgSlug, onClose, onJoined }) {
  const [childFirst, setChildFirst] = useState('');
  const [childLast, setChildLast] = useState('');
  const [grade, setGrade] = useState('');
  const [parentFirst, setParentFirst] = useState('');
  const [parentLast, setParentLast] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null); // { position }

  // The error and the confirmation both render at the TOP of a form that can be taller
  // than the viewport on a phone, and the submit button is at the BOTTOM. That is exactly
  // how the capacity gate's 409 ended up 705px above the fold, invisible, with the button
  // looking dead. So both states scroll themselves into view.
  //
  // behavior:'instant', NOT 'smooth' — a smooth scrollIntoView measurably did nothing on
  // the running app (scrollY unchanged after two seconds) while 'instant' moved it, so
  // 'smooth' would silently reproduce the bug this exists to prevent.
  const noticeRef = useRef(null);
  useEffect(() => {
    if (error || placed) noticeRef.current?.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, [error, placed]);

  const firstFieldRef = useRef(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);

  // Did the current press begin on the dim backdrop? See the handlers below.
  const backdropPressRef = useRef(false);

  // Escape closes, which a dialog owes the keyboard.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Last names are required because the DATABASE requires them - parents.last_name and
  // students.last_name are both NOT NULL. They were marked optional here at first, which
  // made the join 500 for anyone who took the label at its word, with a retry that could
  // never succeed. Phone and grade stay genuinely optional; nothing downstream needs them.
  const canSubmit = childFirst.trim() && childLast.trim()
    && parentFirst.trim() && parentLast.trim() && email.trim() && !submitting;

  async function submit(e) {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const resp = await fetch(`${API_BASE}/join-waitlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          organization_slug: orgSlug,
          program_id: program?.id,
          parent: {
            first_name: parentFirst.trim(),
            last_name: parentLast.trim(),
            email: email.trim(),
            phone: phone.trim(),
          },
          // Grade is optional, and '' must stay '' rather than becoming 0 —
          // 0 is Kindergarten, a real answer, so it cannot double as "blank".
          student: {
            first_name: childFirst.trim(),
            last_name: childLast.trim(),
            grade: grade === '' ? null : Number(grade),
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        // has_room is the one error worth wording differently: the class emptied while
        // they were typing, so the useful thing is to send them to register, not to
        // apologise for a list they no longer need.
        throw new Error(data.error || 'We could not add you to the list. Please try again.');
      }
      setPlaced({ position: data.waitlist_position });
      onJoined?.(program?.id, data.waitlist_position);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const title = program?.curriculum || 'this class';
  const site = program?.program_locations?.name || program?.school_name || '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Join the waitlist for ${title}`}
      // CLOSE ONLY IF THE PRESS *STARTED* ON THE BACKDROP.
      //
      // A plain onClick={e.target === e.currentTarget && close} is the usual shortcut and
      // it has a real failure mode: the click that OPENS this modal is still in flight
      // when the modal mounts, so its mouseup/click can land on the freshly-rendered
      // backdrop now under the cursor and close it again in the same gesture. Requiring
      // mousedown AND click to both be the backdrop makes that impossible, while a genuine
      // click on the dim area still closes.
      //
      // HONESTY NOTE: I first wrote that I had observed this happening here. I had not -
      // the modal was failing to open for an unrelated reason (a synthetic click in the
      // test harness that did not produce the pointer events React listens for; a real
      // pointerdown/mousedown/mouseup/click sequence opens it fine). This guard is kept
      // because it is correct, not because it was the diagnosis.
      onMouseDown={(e) => { backdropPressRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropPressRef.current) onClose?.();
        backdropPressRef.current = false;
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '24px 12px', overflowY: 'auto',
      }}
    >
      <div style={{
        background: '#fff', borderRadius: 16, maxWidth: 460, width: '100%',
        padding: 20, boxShadow: '0 18px 50px rgba(0,0,0,0.25)',
      }}>
        <div ref={noticeRef} />

        {placed ? (
          <>
            <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 800 }}>
              You&rsquo;re on the list
            </h2>
            <p style={{ margin: '0 0 14px', fontSize: 15, lineHeight: 1.5 }}>
              {childFirst.trim()} is <strong>number {placed.position}</strong> on the waitlist for{' '}
              {title}{site ? ` at ${site}` : ''}.
            </p>
            <p style={{ margin: '0 0 18px', fontSize: 14, lineHeight: 1.5, color: 'rgba(0,0,0,0.7)' }}>
              If a place opens up we will email you at {email.trim()} with a link to register.
              You do not need to do anything else, and nothing has been charged.
            </p>
            <button type="button" onClick={onClose} className="btn-enrops-primary" style={{
              width: '100%', padding: '12px 16px', borderRadius: 10, fontWeight: 800, fontSize: 15,
            }}>Done</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800 }}>Join the waitlist</h2>
            <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: 'rgba(0,0,0,0.7)' }}>
              {title}{site ? ` at ${site}` : ''} is full. Tell us who to contact and we will
              email you if a place opens up. There is nothing to pay.
            </p>

            {error && (
              <div style={{
                marginBottom: 14, padding: 12, borderRadius: 10,
                border: '1.5px solid #b45309', background: 'rgba(180,83,9,0.08)',
              }}>
                <p style={{ margin: 0, fontWeight: 800, color: '#b45309' }}>Heads up</p>
                <p style={{ margin: '4px 0 0', fontSize: 14 }}>{error}</p>
              </div>
            )}

            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={LABEL} htmlFor="wl-child-first">Child&rsquo;s first name *</label>
                <input id="wl-child-first" ref={firstFieldRef} style={FIELD} value={childFirst}
                  onChange={(e) => setChildFirst(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label style={LABEL} htmlFor="wl-child-last">Child&rsquo;s last name *</label>
                <input id="wl-child-last" style={FIELD} value={childLast}
                  onChange={(e) => setChildLast(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label style={LABEL} htmlFor="wl-grade">Grade (optional)</label>
                <select id="wl-grade" style={FIELD} value={grade} onChange={(e) => setGrade(e.target.value)}>
                  <option value="">Select&hellip;</option>
                  <option value="0">Kindergarten</option>
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map((g) => (
                    <option key={g} value={String(g)}>{g}</option>
                  ))}
                </select>
              </div>
              <hr style={{ border: 0, borderTop: '1px solid rgba(0,0,0,0.08)', margin: '2px 0' }} />
              <div>
                <label style={LABEL} htmlFor="wl-parent-first">Your first name *</label>
                <input id="wl-parent-first" style={FIELD} value={parentFirst}
                  onChange={(e) => setParentFirst(e.target.value)} />
              </div>
              <div>
                <label style={LABEL} htmlFor="wl-parent-last">Your last name *</label>
                <input id="wl-parent-last" style={FIELD} value={parentLast}
                  onChange={(e) => setParentLast(e.target.value)} />
              </div>
              <div>
                <label style={LABEL} htmlFor="wl-email">Your email *</label>
                <input id="wl-email" type="email" style={FIELD} value={email}
                  onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div>
                <label style={LABEL} htmlFor="wl-phone">Your phone</label>
                <input id="wl-phone" type="tel" style={FIELD} value={phone}
                  onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button type="button" onClick={onClose} disabled={submitting} style={{
                flex: '0 0 auto', padding: '12px 16px', borderRadius: 10,
                border: '1.5px solid rgba(0,0,0,0.2)', background: '#fff',
                fontWeight: 700, fontSize: 15, cursor: 'pointer',
              }}>Not now</button>
              <button type="submit" disabled={!canSubmit} className="btn-enrops-primary" style={{
                flex: 1, padding: '12px 16px', borderRadius: 10, fontWeight: 800, fontSize: 15,
              }}>
                {submitting ? 'Adding you…' : 'Join the waitlist'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
