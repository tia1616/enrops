import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import WizardHost from './WizardHost.jsx';

// Top-level resolver for /:slug/onboarding. Runs on every visit and decides:
//
//   - magic link expired      → /error?reason=link_expired
//   - no session              → /j2s/instructor (existing instructor login)
//   - no instructor row       → / (landing — not an instructor)
//   - is_active=false         → /error?reason=deactivated
//   - org.slug missing        → /error?reason=org_misconfigured
//   - date_of_birth < 18 yrs  → /:slug/instructor (minors skip the wizard)
//   - overall_status declined → /:slug/onboarding/declined
//   - overall_status abandoned→ /:slug/onboarding/abandoned
//   - overall_status complete → /:slug/instructor
//   - otherwise               → render WizardHost (the actual wizard screens)
//
// Per chunk 3 spec lines 92-153. Hard-fails on missing slug instead of falling
// back to a hardcoded tenant — that would leak tenant identity across orgs.

function isMinorFromDob(dob, today = new Date()) {
  if (!dob) return false;
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const eighteenthBirthday = new Date(
    d.getFullYear() + 18,
    d.getMonth(),
    d.getDate()
  );
  return today < eighteenthBirthday;
}

// Supabase appends auth errors to the URL hash on failure (e.g. magic link
// expired). Detect otp_expired so we can route to the resend form.
function readAuthErrorFromUrl() {
  const hash = window.location.hash || '';
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const errorCode = params.get('error_code');
  if (errorCode === 'otp_expired' || errorCode === 'access_denied') {
    return errorCode;
  }
  return null;
}

export default function OnboardingRouter() {
  const navigate = useNavigate();
  const { slug: urlSlug } = useParams();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      // 1. Magic link expired? Bounce to the resend form before anything else.
      const authErr = readAuthErrorFromUrl();
      if (authErr === 'otp_expired') {
        navigate('/error?reason=link_expired', { replace: true });
        return;
      }

      // 2. Session.
      const { data: sessionRes } = await supabase.auth.getSession();
      const session = sessionRes?.session;
      if (!session?.user) {
        // No session — show the inline sign-in panel right here on the
        // onboarding URL. Google OAuth + magic-link-by-email options.
        // Keeps the user on /:slug/onboarding so the post-auth redirect
        // takes them straight into the wizard.
        if (!cancelled) {
          setState({ phase: 'signin', urlSlug: urlSlug ?? null });
        }
        return;
      }

      // 3. Instructor record.
      const { data: instructor, error: instErr } = await supabase
        .from('instructors')
        .select('id, organization_id, is_active, date_of_birth, first_name, last_name, preferred_name, email, phone, photo_url, site_preferences, availability, first_aid_cpr_url, first_aid_cpr_expires_at, shirt_size')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();

      if (instErr) {
        console.error('[OnboardingRouter] instructor lookup failed', instErr);
        navigate('/error?reason=org_misconfigured', { replace: true });
        return;
      }
      if (!instructor) {
        // Authenticated, but no instructor row — likely a parent who hit this
        // URL by mistake. Send them to the landing page.
        navigate('/', { replace: true });
        return;
      }

      // 4. Deactivated.
      if (!instructor.is_active) {
        navigate('/error?reason=deactivated', { replace: true });
        return;
      }

      // 5. Org slug — hard-fail on missing. Also pull the instructor-facing
      // background-check config (enabled flag + provider name/link/instructions)
      // from the public directory view so the wizard can show the right step
      // and copy. Instructors aren't org_members, so they can't read the
      // organizations row directly — the view exposes only this safe subset.
      const { data: org } = await supabase
        .from('public_org_directory')
        .select('slug, background_check_public, training_enabled')
        .eq('id', instructor.organization_id)
        .single();
      if (!org?.slug) {
        console.error('[OnboardingRouter] organization missing slug', {
          instructor_id: instructor.id,
          organization_id: instructor.organization_id,
        });
        navigate('/error?reason=org_misconfigured', { replace: true });
        return;
      }

      // 6. URL slug must match instructor's org. If a contractor for org A
      // hits /orgB/onboarding, redirect them to their own slug.
      if (urlSlug && urlSlug !== org.slug) {
        navigate(`/${org.slug}/onboarding`, { replace: true });
        return;
      }

      // 7. Minor → schedule view, skip wizard entirely.
      if (isMinorFromDob(instructor.date_of_birth)) {
        navigate(`/${org.slug}/instructor`, { replace: true });
        return;
      }

      // 8. Onboarding status.
      const { data: onboarding } = await supabase
        .from('contractor_onboarding_status')
        .select('overall_status, current_step, steps_completed, checkr_status, stripe_connect_status, stripe_payouts_enabled')
        .eq('instructor_id', instructor.id)
        .maybeSingle();

      if (cancelled) return;

      if (!onboarding) {
        // No onboarding row — they're a regular (already-onboarded or never-
        // invited) instructor. Send them to the schedule view.
        navigate(`/${org.slug}/instructor`, { replace: true });
        return;
      }

      if (onboarding.overall_status === 'complete') {
        navigate(`/${org.slug}/instructor`, { replace: true });
        return;
      }
      if (onboarding.overall_status === 'declined') {
        navigate(`/${org.slug}/onboarding/declined`, { replace: true });
        return;
      }
      if (onboarding.overall_status === 'abandoned') {
        navigate(`/${org.slug}/onboarding/abandoned`, { replace: true });
        return;
      }

      // Training videos: the step is live only when the org enabled training AND
      // has at least one active required video (enabled-but-empty drops the step,
      // matching the server gate). Instructors can read active videos of their
      // own org via RLS. Answers are never selected here — the player fetches a
      // signed URL + answer-stripped quiz per video from get-training-video-url.
      let trainingVideos = [];
      if (org.training_enabled) {
        const { data: vids } = await supabase
          .from('instructor_training_videos')
          .select('id, title, quiz, duration_seconds')
          .eq('organization_id', instructor.organization_id)
          .eq('active', true)
          .eq('is_required', true)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true });
        trainingVideos = (vids ?? []).map((v) => ({
          id: v.id,
          title: v.title,
          has_quiz: Array.isArray(v.quiz) && v.quiz.length > 0,
          duration_seconds: v.duration_seconds,
        }));
      }
      const trainingEnabled = Boolean(org.training_enabled) && trainingVideos.length > 0;

      // Wizard in progress.
      setState({
        phase: 'wizard',
        slug: org.slug,
        instructor,
        onboarding,
        backgroundCheck: org.background_check_public ?? { enabled: true },
        trainingEnabled,
        trainingVideos,
        initialStep: searchParams.get('step') || onboarding.current_step,
      });
    }

    resolve().catch((err) => {
      console.error('[OnboardingRouter] resolve failed', err);
      if (!cancelled) {
        navigate('/error?reason=org_misconfigured', { replace: true });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSlug]);

  if (state.phase === 'loading') {
    return (
      <div className="min-h-screen bg-neutral-50 px-4 py-16">
        <div className="mx-auto max-w-md text-sm text-neutral-500">Loading…</div>
      </div>
    );
  }

  if (state.phase === 'signin') {
    return <SignInPanel slug={state.urlSlug} />;
  }

  return (
    <WizardHost
      slug={state.slug}
      instructor={state.instructor}
      onboarding={state.onboarding}
      backgroundCheck={state.backgroundCheck}
      trainingEnabled={state.trainingEnabled}
      trainingVideos={state.trainingVideos}
      initialStep={state.initialStep}
    />
  );
}

// Inline sign-in surface shown when someone hits /:slug/onboarding without
// an active session. Mirrors the InstructorPortal login UI: Google OAuth as
// the primary CTA, magic-link-by-email as the fallback. After successful
// auth the redirect lands back at the same /:slug/onboarding URL and
// OnboardingRouter resolves into the wizard.
function SignInPanel({ slug }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [error, setError] = useState('');

  const redirectTo = slug
    ? `${window.location.origin}/${slug}/onboarding`
    : `${window.location.origin}${window.location.pathname}`;

  async function handleGoogle() {
    setError('');
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    if (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function handleMagic(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setBusy(true);
    // Route through auth-send-magic-link (not signInWithOtp) so the email gets
    // the "Continue your onboarding" subject + body instead of the generic
    // instructor "view your schedule" copy. Function auto-creates the auth.users
    // row when an instructor row exists but the user hasn't signed in yet.
    const { data, error: fnErr } = await supabase.functions.invoke('auth-send-magic-link', {
      body: {
        email: email.trim(),
        redirect_to: redirectTo,
        context: 'onboarding',
      },
    });
    setBusy(false);
    if (fnErr) {
      setError(fnErr.message);
      return;
    }
    if (data?.error) {
      setError(data.error);
      return;
    }
    setLinkSent(true);
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-16">
      <div className="mx-auto max-w-md rounded-lg border border-neutral-200 bg-white p-7 shadow-sm">
        <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          {slug ? `${slug} · onboarding` : 'onboarding'}
        </div>
        <h1 className="text-xl font-semibold text-neutral-900">Sign in to continue</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600">
          Use the same email your invite was sent to. Google sign-in is fastest if your work email is a Google account.
        </p>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={busy}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-60"
        >
          <span aria-hidden="true">G</span>
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-neutral-400">
          <span className="h-px flex-1 bg-neutral-200" />
          OR
          <span className="h-px flex-1 bg-neutral-200" />
        </div>

        {linkSent ? (
          <div className="rounded-md bg-green-50 p-3 text-sm text-green-900">
            Check your inbox — we sent a sign-in link to <strong>{email}</strong>.
          </div>
        ) : (
          <form onSubmit={handleMagic}>
            <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !email}
              className="mt-3 w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </form>
        )}

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-900">{error}</div>
        )}
      </div>
    </div>
  );
}
