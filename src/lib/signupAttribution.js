// src/lib/signupAttribution.js
// Carries utm_content from the ad click through to the created organization.
//
// WHY THIS NEEDS TO EXIST AT ALL, rather than just reading the query string at
// the moment we provision: /signup authenticates by Google OAuth or a magic
// link, and BOTH round-trip through an external URL and come back to
// `${origin}/signup` with NO query string. By the time the operator types their
// business name, ?utm_content= is long gone. So it has to be stashed the moment
// they land and read back after they return.
//
// sessionStorage, deliberately, not localStorage:
//   - it survives the OAuth redirect, which is the whole requirement;
//   - it dies with the tab, so a utm from an ad clicked last week cannot be
//     attached to an unrelated signup today. localStorage would silently
//     mis-attribute exactly that case, and a wrong attribution is worse than a
//     missing one because nothing about it looks wrong.
//
// KNOWN GAP, and it is not fixable from the client: a magic link opened on a
// different device or browser starts a new session, so the utm is lost and that
// signup records no attribution. Ads that land on /signup and use Google
// sign-in keep it; ads whose visitor switches to their phone for the email do
// not.

const KEY = 'enrops.signup.utm_content';

// Meta's utm_content values are short campaign tokens. Bound it here as well as
// in the RPC: the value comes from a URL anyone can craft, and there is no
// reason to carry a large string around in storage.
const MAX_LEN = 200;

/**
 * Read utm_content off the CURRENT url and remember it for this tab.
 *
 * Called once on app start, before any redirect. Writing only when the param is
 * actually present matters: a later navigation with no utm must not clear a
 * value captured on landing, which is what a naive "always write" would do.
 */
export function captureSignupUtm() {
  try {
    const value = new URLSearchParams(window.location.search).get('utm_content');
    if (!value) return;
    const trimmed = value.trim().slice(0, MAX_LEN);
    if (!trimmed) return;
    window.sessionStorage.setItem(KEY, trimmed);
  } catch {
    // Private mode, storage disabled, or a malformed URL. Attribution is a
    // marketing nicety - it must never interfere with someone signing up.
  }
}

/** The stashed value, or null. */
export function getSignupUtm() {
  try {
    return window.sessionStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Forget it once it has been recorded against an org. */
export function clearSignupUtm() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Record the stashed utm against the org the caller just created.
 *
 * Fire-and-forget by contract: it NEVER throws and never blocks the operator.
 * They have just created their business; an advertising bookkeeping failure is
 * not their problem and must not surface as an error on that screen.
 *
 * The RPC takes only the utm string and resolves the organization from
 * auth.uid() server-side, so nothing here can attribute a signup to an org the
 * caller does not own.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function recordSignupAttribution(supabase) {
  const utm = getSignupUtm();
  if (!utm) return;
  try {
    const { error } = await supabase.rpc('record_signup_attribution', {
      p_utm_content: utm,
    });
    // Only forget it on a clean call. If the write failed we keep the value in
    // case the operator retries in this tab; sessionStorage clears itself when
    // the tab closes, so nothing leaks.
    if (!error) clearSignupUtm();
    else console.warn('[attribution] record_signup_attribution failed:', error.message);
  } catch (err) {
    console.warn('[attribution] record_signup_attribution threw:', err);
  }
}
