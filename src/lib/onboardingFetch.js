// Shared edge-function fetch wrapper for the contractor onboarding wizard.
//
// 401 → instructor login for the current tenant (or /error?reason=link_expired upstream from auth callback)
// 403 → /error?reason=deactivated  (re-auth won't help; don't bounce to login)
// 410 → navigate to body.redirect verbatim (mid-session status flip)
// 5xx → bubbled to caller as { error } so the screen can show retry UI

import { supabase } from './supabase.js';
// defaultTenantSlug import removed 2026-08-12 — it was only used for the 401
// fallback below, which no longer resolves to a specific tenant.

// Where a 401 sends someone: back to the sign-in for the portal they were
// actually using.
//
// Derive the tenant slug from the URL when there is one (/acme/onboarding →
// /acme/instructor). When there ISN'T one — /instructor and /instructors, the
// tenant-less shortcuts — send them back to the same tenant-less portal, which
// resolves the right org from their own instructor record.
//
// THE FALLBACK USED TO BE A TENANT. defaultTenantSlug() returns the first (and
// only) key in the TENANTS map, i.e. one specific provider, so any path this
// regex failed to match bounced that provider's portal at everyone. That was
// invisible while /instructor redirected there anyway; now that it does not, the
// fallback would have been the last place the hardcode survived. /instructor is
// strictly better as the fallback: it is tenant-neutral and self-resolving.
function currentInstructorLoginPath() {
  if (typeof window !== 'undefined') {
    const m = window.location.pathname.match(/^\/([^/]+)\/(?:instructor|onboarding)/);
    if (m) return `/${m[1]}/instructor`;
  }
  // Everything else — including the tenant-less /instructor and /instructors —
  // lands here. An explicit branch for those two used to sit above, returning
  // exactly what this line returns, which invited the reader to believe the
  // cases differed.
  return '/instructor';
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

// Exported because the instructor portal's link-instructor call needs the same
// thing this wrapper needs — the edge function's real status + JSON body — but
// none of the navigation side-effects invokeOnboardingFn performs. Kept as one
// implementation so a fix to the body-reading (clone-before-read, non-JSON
// fallback) lands in both places at once.
export async function readInvokeError(invokeError) {
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

  const { status, body: errBody } = await readInvokeError(invokeError);

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
