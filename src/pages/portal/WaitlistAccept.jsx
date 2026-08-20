// /:slug/waitlist/:token — where the invite email's link lands.
//
// This page does ONE job: prove the invite is still good, tell the family whose place it
// is and how long they have, and hand them into normal registration with the token
// attached. It takes no money and collects nothing - the real registration flow already
// collects waivers, custom questions and payment, and duplicating any of that here would
// be a second checkout to keep in step with the first.
//
// IT DOES NOT SPEND THE INVITE. Opening the link, reading it and closing the tab must
// leave the place exactly where it was. The token is spent by create-registration, after
// a real registration exists.

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE } from '../../lib/supabase.js';

const WRAP = { maxWidth: 560, margin: '0 auto', padding: '40px 20px', fontSize: 16, lineHeight: 1.55 };

function formatDeadline(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    // The VIEWER's own zone here, not the org's. On the page they are looking at, "today
    // at 4:12 PM" should mean their clock. (The email uses the org's zone, because it is
    // written once and read anywhere.)
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(d);
  } catch {
    return null;
  }
}

export default function WaitlistAccept() {
  // The route is `/:slug/waitlist/:token` (App.jsx), so the param is `slug`, NOT
  // `orgSlug`. Destructuring `orgSlug` here read undefined, and every link/redirect built
  // from it pointed at `/undefined/...` - which PublicLayout renders as "We couldn't find
  // that page." That is what a family saw the moment they clicked Register on a good invite.
  const { slug, token } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/waitlist-accept`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ token }),
        });
        const data = await resp.json();
        if (!alive) return;
        // A 503 is OUR problem, not a dead invite. Telling a family with a good link
        // that it expired is how they stop trying and lose the place.
        if (!resp.ok) { setState({ phase: 'error', message: data?.error }); return; }
        if (!data.valid) { setState({ phase: 'invalid' }); return; }
        setState({ phase: 'valid', invite: data });
      } catch {
        if (alive) setState({ phase: 'error' });
      }
    })();
    return () => { alive = false; };
  }, [token]);

  function continueToRegistration() {
    // Straight into the ordinary registration flow, with the token riding along so the
    // capacity gate credits the one seat this family already holds.
    const params = new URLSearchParams({
      program: state.invite.program_id,
      waitlist: token,
    });
    // The org_slug the ENDPOINT returned is authoritative - the accept function resolves it
    // from the invite server-side and returns it for exactly this. Fall back to the URL
    // slug only if it is somehow absent.
    const targetSlug = state.invite?.org_slug || slug;
    navigate(`/${targetSlug}/register?${params.toString()}`);
  }

  if (state.phase === 'loading') {
    return <div style={{ ...WRAP, color: '#666' }}>Checking your invitation…</div>;
  }

  if (state.phase === 'error') {
    return (
      <div style={WRAP}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 12px' }}>
          We could not check your invitation
        </h1>
        <p style={{ margin: '0 0 16px' }}>
          {state.message || 'Something went wrong at our end. Your place has not been affected.'}
        </p>
        <p style={{ margin: 0 }}>
          Please try the link again in a few minutes. If it still does not work, reply to
          the email we sent you and we will sort it out.
        </p>
      </div>
    );
  }

  if (state.phase === 'invalid') {
    return (
      <div style={WRAP}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 12px' }}>
          This invitation is no longer valid
        </h1>
        {/* ONE message for expired, already-used and never-existed. The page genuinely
            cannot tell them apart - the lookup returns the same silence for all three -
            and saying "expired" for a guessed token would confirm it had once been real.
            It is also the honest thing to say: in every one of those cases the next step
            is the same. */}
        <p style={{ margin: '0 0 16px' }}>
          The place may have already been taken, or the time to claim it may have passed.
          If you have already registered, you are all set and nothing more is needed.
        </p>
        <p style={{ margin: 0 }}>
          <a href={`/${slug}`} style={{ color: '#6857E1', fontWeight: 700 }}>
            See what else is open
          </a>
        </p>
      </div>
    );
  }

  const { invite } = state;
  const childName = (invite.child?.first_name || '').trim() || 'your child';
  const classLine = invite.site_name
    ? `${invite.program_name} at ${invite.site_name}`
    : invite.program_name;
  const deadline = formatDeadline(invite.expires_at);

  return (
    <div style={WRAP}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 12px' }}>
        A place is held for {childName}
      </h1>
      <p style={{ margin: '0 0 14px' }}>
        A place has opened up in <strong>{classLine}</strong>, and it is being held for{' '}
        {childName} because they were next on the waitlist.
      </p>
      {deadline && (
        <p style={{ margin: '0 0 18px' }}>
          <strong>The place is held until {deadline}.</strong> After that it goes to the
          next family on the list.
        </p>
      )}
      {/* Says what the button DOES. "Continue" or "Accept" would imply the place is
          already theirs; it is not theirs until registration is finished and paid. */}
      <button
        type="button"
        onClick={continueToRegistration}
        className="btn-enrops-primary"
        style={{
          width: '100%', padding: '14px 18px', borderRadius: 10, fontWeight: 800, fontSize: 16,
        }}
      >
        Register {childName}
      </button>
      <p style={{ margin: '14px 0 0', fontSize: 14, color: 'rgba(0,0,0,0.65)' }}>
        You will be asked for the usual registration details and payment. The place is
        yours once that is done.
      </p>
    </div>
  );
}
