import React, { useEffect, useState } from 'react';
import { useSearchParams, Link, useOutletContext } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCart } from '../../context/CartContext.jsx';
import { supabase } from '../../lib/supabase.js';

export default function RegisterSuccess() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const comp = searchParams.get('comp') === '1'; // $0 scholarship — no payment
  const { user, signInWithGoogle, signInWithMagicLink } = useAuth();
  const { clearCart, cart } = useCart();

  const [email, setEmail] = useState(cart?.parent?.email || '');
  // Did we LEARN the address, or are we guessing? The cart is cleared 500ms after
  // this page mounts and does not survive a reload, so on any refresh, back-button
  // or reopened link `email` is "" - and the Resend button was gated on `!email`.
  // The page then said "have us send another" above a permanently disabled button,
  // to a family who has just paid and cannot get into their account. Captured once
  // at mount rather than derived from `email`, so typing an address does not make
  // the page start claiming it already sent one there.
  const [emailKnownFromCart] = useState(() => !!cart?.parent?.email);
  // Deliberately loose: this only decides whether the button is clickable, and the
  // real validation is Supabase rejecting the address. A strict regex here would
  // reject valid addresses and reintroduce the dead button it exists to prevent.
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  // SHOW THE FIELD WHENEVER THE BUTTON WOULD OTHERWISE BE DEAD, not just when the
  // cart is missing. The first version of this fix gated the button on
  // emailLooksValid but rendered the input only when the cart was empty - so a cart
  // address this regex happens to reject (no dot in the domain, a quoted local part)
  // produced a disabled button in the ONE branch with nothing to type into. That is
  // the bug being fixed here, moved one branch over. Tying the field to the same
  // condition as the button makes "we offered a resend you cannot perform"
  // unreachable by construction.
  const needsEmailInput = !emailKnownFromCart || !emailLooksValid;
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // ACH/bank transfer settles over 1-3 business days. Ask Stripe whether this
  // session is still processing so we can tell the family accurately instead of
  // implying the payment is done (card settles instantly → processing=false).
  const [processing, setProcessing] = useState(false);
  // Tenant-neutral calendar invite (real, closure-aware session dates) built by
  // checkout-session-status. Lets the family add every class in one tap.
  const [calendar, setCalendar] = useState(null);

  useEffect(() => {
    // Clear cart once we're on success
    setTimeout(() => clearCart(), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.functions.invoke('checkout-session-status', {
        body: { session_id: sessionId },
      });
      if (cancelled) return;
      if (data?.processing) setProcessing(true);
      if (data?.calendar?.ics) setCalendar(data.calendar);
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  function downloadIcs() {
    if (!calendar?.ics) return;
    const blob = new Blob([calendar.ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'your-classes.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleMagicLink() {
    // Trimmed: a typed address arrives with whatever the keyboard or a paste left
    // on it, and a trailing space is an invisible reason for a link never to come.
    const addr = email.trim();
    if (!addr) return;
    setLoading(true);
    setError('');
    const { error: err } = await signInWithMagicLink(
      addr,
      `${window.location.origin}/${ORG_SLUG}/dashboard`,
    );
    setLoading(false);
    if (err) setError(err.message);
    else setMsg(`Check ${addr} for a sign-in link.`);
  }

  async function handleGoogle() {
    setLoading(true);
    const { error: err } = await signInWithGoogle(
      `${window.location.origin}/${ORG_SLUG}/dashboard`,
    );
    if (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      {/* Success hero */}
      <div className="rounded-3xl bg-gradient-to-br from-j2s-purple to-j2s-purple-dark p-8 text-center text-white shadow-pop sm:p-12">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-j2s-orange text-4xl">
          ✓
        </div>
        <h1 className="mt-6 font-titan text-4xl sm:text-5xl">
          You're registered!
        </h1>
        <p className="mt-4 text-lg text-white/90">
          {comp
            ? 'Your spot is confirmed — no payment needed. Sign in below to see your schedule and class details.'
            : 'Thanks for signing up. We just sent your receipt and class details to your email.'}
        </p>
        {sessionId && (
          <p className="mt-3 text-xs text-white/60">
            Confirmation ID: {sessionId.slice(0, 16)}&hellip;
          </p>
        )}
      </div>

      {processing && (
        <div
          className="mt-6 rounded-2xl border p-5"
          style={{ borderColor: '#F8A638', background: '#FFF7ED', color: '#7c4a03' }}
        >
          <p className="font-bold">🏦 Your bank transfer is processing.</p>
          <p className="mt-1 text-sm leading-relaxed">
            Bank transfers take 1–3 business days to clear. Your spot is held the whole time —
            we'll email you once your payment confirms. Nothing else to do right now.
          </p>
        </div>
      )}

      {/* Add-to-calendar — real, closure-aware sessions from the program. The
          .ics adds every session across all apps; Google links add the first. */}
      {calendar?.ics && (
        <div className="mt-6 rounded-3xl border border-j2s-purple/10 bg-white p-6 shadow-card sm:p-8">
          <h2 className="font-titan text-xl text-j2s-ink">Add your classes to your calendar</h2>
          <p className="mt-2 text-sm text-j2s-ink/70">
            Save {calendar.totalSessions === 1 ? 'your session' : `all ${calendar.totalSessions} sessions`} so you never miss a class.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={downloadIcs} className="btn-j2s-primary">
              Download calendar file (.ics)
            </button>
            {(calendar.events || [])
              .filter((e) => e.googleUrl)
              .map((e, i) => (
                <a
                  key={i}
                  href={e.googleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-xl border-2 border-j2s-ink/15 bg-white px-5 py-3 font-semibold text-j2s-ink transition hover:border-j2s-ink/30 hover:bg-j2s-ink/5"
                >
                  {(calendar.events || []).filter((x) => x.googleUrl).length > 1
                    ? `${e.programName} → Google`
                    : 'Add to Google Calendar'}
                </a>
              ))}
          </div>
          <p className="mt-3 text-xs text-j2s-ink/50">
            The .ics file adds every session and works with Apple Calendar, Google Calendar, and Outlook. Google links add your first session.
          </p>
        </div>
      )}

      {/* Account access — auto-account is created by stripe-webhook v15 + magic link sent */}
      {!user ? (
        <div className="mt-8 rounded-3xl border border-j2s-purple/10 bg-white p-8 shadow-card">
          <h2 className="font-titan text-2xl text-j2s-ink">
            Check your email
          </h2>
          {/* Only name the address when we actually know it. On a reload we do
              not, and "We sent a sign-in link to your inbox" reads like a fact we
              are sure of while the button underneath refuses to act on it. */}
          <p className="mt-2 text-j2s-ink/70">
            {emailKnownFromCart ? (
              <>
                We sent a sign-in link to <span className="font-semibold text-j2s-ink">{email}</span>.
                Click the link to access your dashboard, view your child's schedule,
                and get session recaps.
              </>
            ) : (
              <>
                {/* "was sent", not "is on its way". This branch exists BECAUSE the
                    page was reloaded or reopened, so the send already happened,
                    possibly a while ago - "on its way" implies imminent and would
                    have a family waiting for something that already arrived. */}
                A sign-in link was sent to the email address you registered with.
                Click it to access your dashboard, view your child's schedule, and get
                session recaps.
              </>
            )}
          </p>

          <div className="mt-6 space-y-4">
            <p className="text-sm text-j2s-ink/60">
              Didn't get the email? Check your spam folder, or have us send another.
            </p>
            {/* THE FIELD IS THE FIX. Without it "have us send another" was an offer
                the page could not honour once the cart was gone - which is every
                refresh, every back-button, every time the link is opened later or on
                another device. Asking for the address costs one line of typing and
                works in all of those cases; the alternative was returning the email
                from checkout-session-status, and that endpoint documents twice that
                it deliberately exposes no extra PII, since anyone holding the
                session-id URL can call it. */}
            {needsEmailInput && (
              <div>
                <label htmlFor="resend-email" className="block text-sm font-semibold text-j2s-ink">
                  Your email address
                </label>
                <input
                  id="resend-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-xl border-2 border-j2s-ink/15 px-4 py-3 text-j2s-ink focus:border-j2s-purple focus:outline-none"
                />
              </div>
            )}
            <button
              onClick={handleMagicLink}
              disabled={loading || !emailLooksValid}
              className="btn-j2s-primary w-full"
            >
              {loading ? 'Sending…' : 'Resend sign-in link'}
            </button>

            {/* Google OAuth re-enabled 5/8/26 after Google verification approved. */}
            <div className="relative py-2 text-center">
              <span className="relative z-10 bg-white px-3 text-xs font-semibold uppercase tracking-widest text-j2s-ink/50">
                or
              </span>
              <span className="absolute left-0 right-0 top-1/2 z-0 h-px bg-j2s-purple/10" />
            </div>
            <button
              onClick={handleGoogle}
              disabled={loading}
              className="flex w-full items-center justify-center gap-3 rounded-xl border-2 border-j2s-ink/15 bg-white px-6 py-4 font-semibold text-j2s-ink transition hover:border-j2s-ink/30 hover:bg-j2s-ink/5"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>
          </div>

          {msg && (
            <p className="mt-4 rounded-lg bg-j2s-purple-soft p-3 text-sm text-j2s-purple-dark">
              {msg}
            </p>
          )}
          {error && <p className="error-text mt-4">{error}</p>}
        </div>
      ) : (
        <div className="mt-8 rounded-3xl bg-j2s-purple-soft p-8 text-center">
          <p className="font-titan text-xl text-j2s-ink">Welcome back!</p>
          <Link to={`/${ORG_SLUG}/dashboard`} className="btn-j2s-primary mt-4 inline-block">
            Go to your dashboard →
          </Link>
        </div>
      )}

      {/* Points at the PROVIDER, not at us. A family with a question about their
          child's class should reach the person teaching it - and "reach us at
          support@enrops.com" sent them to the platform instead, contradicting
          the confirmation email, whose reply-to is already the provider's own
          address.
          Deliberately not a mailto: the public org record doesn't carry the
          provider's email, and inventing one risks a bounce. Replying to the
          confirmation lands with them either way, which is the outcome that
          matters. */}
      <p className="mt-8 text-center text-sm text-j2s-ink/60">
        Questions? Just reply to your confirmation email
        {org?.name ? <> and it goes straight to {org.name}</> : <> and it goes straight to your program provider</>}.
      </p>

      {/* The platform attribution line used to live here as well, which meant
          this page rendered it twice - once here and once in PublicLayout's
          footer, which wraps this route. The checklist allows exactly one, so
          it now lives only in PublicLayout. */}
    </div>
  );
}
