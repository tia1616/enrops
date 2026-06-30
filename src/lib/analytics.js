// src/lib/analytics.js
// Thin, privacy-first wrapper around posthog-js for Enrops.
//
// - Session replay records the OPERATOR app (/admin/*) ONLY. Every other route
//   (parent registration/checkout, parent dashboard, instructor portal,
//   contractor onboarding, marketing) is never recorded.
// - All inputs are masked, and admin page DATA (the <main data-admin-main>
//   container) is text-masked so student/parent/payment data never appears in a
//   replay. Card entry is Stripe-hosted (off-domain) so it never reaches replay.
// - Autocapture masks element text + attributes (they can contain PII).
// - Person profiles only for identified (logged-in) operators, not anon parents.
//
// No-ops cleanly when VITE_POSTHOG_KEY is unset (local dev / envs without a key).

import posthog from 'posthog-js';

const KEY = import.meta.env.VITE_POSTHOG_KEY;
const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

let enabled = false;

export function initAnalytics() {
  if (enabled || !KEY) return;
  posthog.init(KEY, {
    api_host: HOST,
    person_profiles: 'identified_only',
    capture_pageview: false,            // SPA: we send $pageview on route change
    mask_all_text: true,                // autocapture: never capture element text
    mask_all_element_attributes: true,  // autocapture: never capture attributes
    disable_session_recording: true,    // off by default; started only on /admin
    session_recording: {
      maskAllInputs: true,
      // Mask all text inside the admin content container (student/parent/$ data).
      maskTextSelector: '[data-admin-main]',
    },
  });
  enabled = true;
}

export function identifyUser(user) {
  if (!enabled || !user?.id) return;
  posthog.identify(user.id, { email: user.email ?? undefined });
}

// Tag the session with the tenant so replays/events filter by org (multi-tenant).
export function setOrgGroup(org, role) {
  if (!enabled || !org?.id) return;
  posthog.group('organization', org.id, {
    name: org.name ?? org.slug ?? undefined,
    slug: org.slug ?? undefined,
    ...(role ? { role } : {}),
  });
}

export function resetAnalytics() {
  if (!enabled) return;
  posthog.reset();
}

// Record replay ONLY on the operator app; stop everywhere else.
export function syncRecording(pathname) {
  if (!enabled) return;
  if (pathname.startsWith('/admin')) posthog.startSessionRecording();
  else posthog.stopSessionRecording();
}

export function capturePageview(pathname) {
  if (!enabled) return;
  posthog.capture('$pageview', { path: pathname });
}

export function capture(event, props) {
  if (!enabled) return;
  posthog.capture(event, props);
}
