import React, { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { supabase } from '../../lib/supabase.js';
import { returnUrl } from '../../lib/returnPath.js';

export default function Login() {
  const { org } = useOutletContext();
  const { signInWithGoogle } = useAuth();
  const [searchParams] = useSearchParams();
  // BACK TO THE PAGE THEY ASKED FOR, not always the dashboard. The portal has
  // deep links now - the per-child pickup-and-dismissal editor, and whatever the
  // "update your info in your parent portal" email points at - and sending a
  // family to the dashboard after they signed in meant the page they came for
  // was simply lost. Jessica hit exactly that, 2026-08-31.
  //
  // `next` is attacker-controlled (it is in the URL), so it goes through
  // safeReturnPath, which allows only a same-site absolute path. The dashboard
  // remains the fallback for no/!safe values, so behaviour is unchanged for
  // everyone arriving at /login normally. Land the parent in THEIR org's portal,
  // never a hardcoded tenant.
  const dashboardPath = `/${org?.slug || ''}/dashboard`;
  const dashboardUrl = returnUrl(window.location.origin, searchParams.get('next'), dashboardPath);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  // Shown after a send attempt so someone with no account isn't left waiting
  // for an email that will never arrive. See the note in the submit handler.
  const [showSignupHint, setShowSignupHint] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleGoogle() {
    setLoading(true);
    const { error: err } = await signInWithGoogle(
      dashboardUrl,
    );
    if (err) {
      setError(err.message);
      setLoading(false);
    }
  }
  async function handleMagic() {
    if (!email) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('auth-send-magic-link', {
        body: {
          email,
          redirect_to: dashboardUrl,
          context: 'parent',
          org_id: org?.id,
        },
      });
      if (fnErr) throw fnErr;
      if (data?.error) throw new Error(data.error);
      // Deliberately conditional wording. This function NO-OPS on an email that
      // has no account - anti-enumeration, so a stranger can't probe which
      // addresses are registered - but it returns success either way. Saying
      // "check your email" flatly meant anyone without an account was told a
      // link was coming when none was, with nothing to do but wait. That is how
      // a new operator who taps Sign in instead of Get started hits a dead end
      // that claims to have worked.
      //
      // This phrasing still reveals nothing about whether the account exists,
      // and gives the person with no account somewhere to go.
      setMsg(`If ${email} has an account, the sign-in link is on its way.`);
      setShowSignupHint(true);
    } catch (err) {
      setError(err.message || 'Could not send sign-in link. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
      <div className="rounded-3xl bg-white p-8 shadow-card sm:p-10">
        <h1 className="font-titan text-3xl text-j2s-ink">Sign in to {org?.name || 'your account'}</h1>
        <p className="mt-2 text-j2s-ink/70">
          Access your registrations and your child's schedule.
        </p>

        <div className="mt-8 space-y-4">
          <input
            type="email"
            className="input-field"
            placeholder="Your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            onClick={handleMagic}
            disabled={loading || !email}
            className="btn-j2s-primary w-full"
          >
            Email me a sign-in link
          </button>

          {/* Google OAuth re-enabled 5/8/26 after Google verification approved. */}
          <div className="relative py-2 text-center text-xs font-semibold uppercase tracking-widest text-j2s-ink/50">
            or
          </div>
          <button
            onClick={handleGoogle}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-xl border-2 border-j2s-ink/15 bg-white px-6 py-4 font-semibold text-j2s-ink transition hover:border-j2s-ink/30"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </button>

          {msg && <p className="rounded-lg bg-j2s-purple-soft p-3 text-sm">{msg}</p>}
          {/* The existing "No account yet?" below sends people to the parent
              catalog, which is right for a family and a dead end for someone
              trying to set up a business. Surfaced only after a send attempt,
              so it answers the question actually being asked: "I typed my
              email and nothing came." */}
          {showSignupHint && (
            <p className="text-sm text-j2s-ink/70">
              Setting up your own programs?{' '}
              <Link to="/signup" className="font-semibold text-j2s-purple hover:underline">
                Create your registration page →
              </Link>
            </p>
          )}
          {error && <p className="error-text">{error}</p>}
        </div>

        <p className="mt-6 text-center text-sm text-j2s-ink/60">
          No account yet?{' '}
          <Link to={`/${org?.slug || ''}`} className="font-semibold text-j2s-purple hover:underline">
            Register for a program →
          </Link>
        </p>
      </div>
    </div>
  );
}
