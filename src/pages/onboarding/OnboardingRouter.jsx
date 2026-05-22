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
        // No session — back to the instructor login. Preserve where they
        // were headed so post-login redirect can return them.
        navigate('/j2s/instructor', { replace: true });
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

      // 5. Org slug — hard-fail on missing.
      const { data: org } = await supabase
        .from('organizations')
        .select('slug')
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

      // Wizard in progress.
      setState({
        phase: 'wizard',
        slug: org.slug,
        instructor,
        onboarding,
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

  return (
    <WizardHost
      slug={state.slug}
      instructor={state.instructor}
      onboarding={state.onboarding}
      initialStep={state.initialStep}
    />
  );
}
