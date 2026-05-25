// Shared edge-function fetch wrapper for the contractor onboarding wizard.
//
// 401 → instructor login for the current tenant (or /error?reason=link_expired upstream from auth callback)
// 403 → /error?reason=deactivated  (re-auth won't help; don't bounce to login)
// 410 → navigate to body.redirect verbatim (mid-session status flip)
// 5xx → bubbled to caller as { error } so the screen can show retry UI

import { supabase } from './supabase.js';
import { defaultTenantSlug } from './tenants.js';

// Derive the current tenant slug from the URL (e.g., /j2s/instructor → "j2s")
// so the 401 redirect lands on the right tenant's instructor portal in a
// future multi-tenant world. Falls back to the v1 single-tenant default
// if the URL doesn't include a slug (shouldn't happen from onboarding
// surfaces, but safe).
function currentInstructorLoginPath() {
  if (typeof window !== 'undefined') {
    const m = window.location.pathname.match(/^\/([^/]+)\/(?:instructor|onboarding)/);
    if (m) return `/${m[1]}/instructor`;
  }
  const slug = defaultTenantSlug();
  return slug ? `/${slug}/instructor` : '/admin/login';
}

class OnboardingNavigated extends Error {
  constructor(target) {
    super(`Onboarding wrapper navigated to ${target}`);
    this.name = 'OnboardingNavigated';
    this.target = target;
    this.handled = true;
  }
}

export function isHandledRedirect(err) {
  return err?.name === 'OnboardingNavigated' || err?.handled === true;
}

async function readError(invokeError) {
  if (!invokeError) return { status: null, body: null };
  const ctx = invokeError.context;
  if (!ctx) return { status: null, body: { error: invokeError.message } };
  const status = typeof ctx.status === 'number' ? ctx.status : null;
  let body = null;
  try {
    const clone = typeof ctx.clone === 'function' ? ctx.clone() : ctx;
    const text = await clone.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
  } catch {
    // ignore body-read errors; body stays null
  }
  return { status, body };
}

export async function invokeOnboardingFn(name, body, { navigate } = {}) {
  let data, invokeError;
  try {
    const res = await supabase.functions.invoke(name, { body });
    data = res.data;
    invokeError = res.error;
  } catch (err) {
    return { data: null, error: err, status: null };
  }

  if (!invokeError) {
    return { data, error: null, status: 200 };
  }

  const { status, body: errBody } = await readError(invokeError);

  if (status === 410 && errBody?.redirect && navigate) {
    navigate(errBody.redirect, { replace: true });
    throw new OnboardingNavigated(errBody.redirect);
  }

  if (status === 403 && navigate) {
    navigate('/error?reason=deactivated', { replace: true });
    throw new OnboardingNavigated('/error?reason=deactivated');
  }

  if (status === 401 && navigate) {
    const target = currentInstructorLoginPath();
    navigate(target, { replace: true });
    throw new OnboardingNavigated(target);
  }

  return {
    data: null,
    error: errBody?.error ? new Error(errBody.error) : invokeError,
    status,
    body: errBody,
  };
}
