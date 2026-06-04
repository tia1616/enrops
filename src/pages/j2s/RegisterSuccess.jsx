import React, { useEffect, useState } from 'react';
import { useSearchParams, Link, useOutletContext } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCart } from '../../context/CartContext.jsx';

export default function RegisterSuccess() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const { user, signInWithGoogle, signInWithMagicLink, signUpWithPassword } = useAuth();
  const { clearCart, cart } = useCart();

  const [email, setEmail] = useState(cart?.parent?.email || '');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Clear cart once we're on success
    setTimeout(() => clearCart(), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMagicLink() {
    if (!email) return;
    setLoading(true);
    setError('');
    const { error: err } = await signInWithMagicLink(
      email,
      `${window.location.origin}/${ORG_SLUG}/dashboard`,
    );
    setLoading(false);
    if (err) setError(err.message);
    else setMsg(`Check ${email} for a sign-in link.`);
  }

  async function handlePasswordSignup() {
    if (!email || !password) return;
    setLoading(true);
    setError('');
    const { error: err } = await signUpWithPassword(email, password);
    setLoading(false);
    if (err) setError(err.message);
    else setMsg('Account created. Check your email to confirm.');
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
          Thanks for signing up. We just sent your receipt and class details to
          your email.
        </p>
        {sessionId && (
          <p className="mt-3 text-xs text-white/60">
            Confirmation ID: {sessionId.slice(0, 16)}&hellip;
          </p>
        )}
      </div>

      {/* Account access — auto-account is created by stripe-webhook v15 + magic link sent */}
      {!user ? (
        <div className="mt-8 rounded-3xl border border-j2s-purple/10 bg-white p-8 shadow-card">
          <h2 className="font-titan text-2xl text-j2s-ink">
            Check your email
          </h2>
          <p className="mt-2 text-j2s-ink/70">
            We sent a sign-in link to <span className="font-semibold text-j2s-ink">{email || 'your inbox'}</span>.
            Click the link to access your dashboard, view your child's schedule,
            and get session recaps.
          </p>

          <div className="mt-6 space-y-4">
            <p className="text-sm text-j2s-ink/60">
              Didn't get the email? Check your spam folder, or have us send another.
            </p>
            <button
              onClick={handleMagicLink}
              disabled={loading || !email}
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

      <p className="mt-8 text-center text-sm text-j2s-ink/60">
        Questions? Reach us at{' '}
        <a
          href="mailto:info@journeytosteam.com"
          className="font-semibold text-j2s-purple hover:underline"
        >
          info@journeytosteam.com
        </a>
      </p>
    </div>
  );
}
