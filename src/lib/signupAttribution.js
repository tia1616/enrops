// src/lib/signupAttribution.js
// Carries utm_content from the ad click through to the created organization.
//
// WHY THIS NEEDS TO EXIST AT ALL, rather than just reading the query string at
// the moment we provision: /signup authenticates by Google OAuth or a magic
// link, and BOTH round-trip away and come back to `${origin}/signup` with NO
// query string. By the time the operator types their business name,
// ?utm_content= is long gone. So it has to be stashed the moment they land and
// read back after they return.
//
// localStorage WITH AN EXPIRY, and the history matters:
//
// This was sessionStorage first, chosen so that an ad clicked last week could
// not be attributed to an unrelated signup today. That reasoning was right
// about the risk and wrong about the odds. sessionStorage is per TAB, and the
// ordinary path is: click the ad, get the sign-in email, open it wherever your
// mail lives - a different tab, often a different device. Two real signups on
// production recorded no attribution at all for exactly this reason before the
// behaviour was changed.
//
// So: localStorage, which survives the hop, plus a timestamp so a stale ad
// still cannot attach itself to a signup days later. That covers the common
// case AND the one sessionStorage was guarding against.
//
// KNOWN GAP that no client-side storage can close: opening the sign-in link on
// a DIFFERENT DEVICE is a different browser with different storage, so that
// signup records no attribution. Closing that needs the utm carried inside the
// magic-link URL itself, which is a server-side change to the auth email.

const KEY = 'enrops.signup.utm_content';

// The key sessionStorage used before this change. Cleared on read so a stale
// value from a session that started pre-deploy cannot linger.
const LEGACY_SESSION_KEY = 'enrops.signup.utm_content';

// Meta's utm_content values are short campaign tokens. Bound it here as well as
// in the RPC: the value comes from a URL anyone can craft.
const MAX_LEN = 200;

// How long a click stays attributable. Long enough to survive "I'll finish this
// tonight", short enough that a campaign from last month cannot claim credit
// for a signup that had nothing to do with it.
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read utm_content off the CURRENT url and remember it.
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
    window.localStorage.setItem(KEY, JSON.stringify({ v: trimmed, t: Date.now() }));
  } catch {
    // Private mode, storage disabled, or a malformed URL. Attribution is a
    // marketing nicety - it must never interfere with someone signing up.
  }
}

/**
 * The stashed value, or null if absent, expired, or unreadable.
 *
 * Expiry is enforced on READ rather than by a timer, so it holds even if the
 * tab was closed for a week between the click and the signup.
 */
export function getSignupUtm() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;

    // A bare string is either a value written by an older build or something
    // hand-set. Treat it as unattributable rather than guessing its age - an
    // attribution we cannot date is exactly what the expiry exists to prevent.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(KEY);
      return null;
    }
    if (!parsed || typeof parsed.v !== 'string' || typeof parsed.t !== 'number') {
      window.localStorage.removeItem(KEY);
      return null;
    }

    // Date.now() can move backwards (clock changes, timezone edits), so guard
    // the negative side too rather than trusting elapsed >= 0.
    const elapsed = Date.now() - parsed.t;
    if (elapsed < 0 || elapsed > TTL_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return parsed.v || null;
  } catch {
    return null;
  }
}

/** Forget it once it has been recorded against an org. */
export function clearSignupUtm() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
  try {
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
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
    // case the operator retries; the expiry above stops it lingering.
    if (!error) clearSignupUtm();
    else console.warn('[attribution] record_signup_attribution failed:', error.message);
  } catch (err) {
    console.warn('[attribution] record_signup_attribution threw:', err);
  }
}
