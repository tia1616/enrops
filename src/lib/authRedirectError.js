// Supabase auth redirect errors — read them, say them, then clear them.
//
// WHY THIS EXISTS
// When a magic link fails, Supabase does NOT throw and does NOT put anything in
// the query string. It redirects to the landing page with the reason in the URL
// FRAGMENT:
//
//   /reproof-co/instructor#error=access_denied&error_code=otp_expired
//     &error_description=Email+link+is+invalid+or+has+expired
//
// A page that only calls getSession() sees "no session" (or, worse, a stale
// session from an earlier sign-in) and renders whatever it renders for that
// state. The actual reason is sitting in the URL, unread. Observed 2026-08-01:
// an hours-old contractor invite landed on the instructor portal and was told
// "Your account isn't fully set up as an instructor yet - ask your operator to
// send you an onboarding invite." The operator had done nothing wrong and a new
// invite would not have helped; the link had simply expired.
//
// A searchParams read will MISS these. The fragment is never sent to the server
// and is not part of `location.search`.
//
// Kept as one module rather than a copy per page for the usual reason: three
// surfaces showing three different sentences for the same failure is how the
// copy drifts.

/**
 * Read an auth error out of the current URL fragment.
 *
 * Returns null when the hash holds no auth error, so callers can treat the
 * common case as a plain falsy check.
 *
 * @returns {{ code: string, description: string, isExpiredLink: boolean } | null}
 */
export function readAuthRedirectError(hash = window.location.hash) {
  const raw = hash || '';
  // '#' alone, or no hash at all.
  if (raw.length < 2) return null;

  let params;
  try {
    params = new URLSearchParams(raw.slice(1));
  } catch {
    return null; // a malformed fragment must never break the page it is on
  }

  const error = params.get('error');
  const code = params.get('error_code');
  // Not every failure carries error_code (older Supabase versions send only
  // `error`), so treat EITHER as evidence rather than requiring error_code -
  // requiring it would silently drop exactly the cases this exists to catch.
  if (!error && !code) return null;

  const description = (params.get('error_description') || '').replace(/\+/g, ' ');

  return {
    code: code || error || 'unknown',
    description,
    // otp_expired is the specific "this link is too old" code. access_denied is
    // what Supabase sends when the link was already used or is otherwise
    // rejected; from the person's point of view both mean "the link I clicked
    // did not work, send me another", which is the only action either one
    // supports.
    isExpiredLink: code === 'otp_expired' || error === 'access_denied' || code === 'access_denied',
  };
}

/**
 * Strip the auth error from the address bar without adding a history entry.
 *
 * Call this AFTER reading, so a refresh (or a later render that re-reads the
 * hash) doesn't resurrect an error the person has already been told about and
 * already acted on.
 *
 * PASS `navigate` INSIDE A REACT ROUTER TREE, so the router's own location is
 * updated rather than only the browser's. Verified in the browser: after
 * `navigate(clean, { replace: true })` the fragment is gone from
 * `location.href` and the message still renders from state.
 *
 * (Honest note on why this takes a `navigate` at all: the raw-history version
 * was written first and appeared not to work, but that test never reloaded the
 * page, so it was measuring the old bundle - not a real defect in
 * replaceState. `navigate` is used because it is the correct call inside a
 * router, not because replaceState was proven broken.)
 *
 * The raw-history fallback is kept for any caller outside a router.
 *
 * @param {(to: string, opts: { replace: boolean }) => void} [navigate]
 */
export function clearAuthRedirectError(navigate) {
  const { pathname, search } = window.location;
  const clean = `${pathname}${search}`;
  try {
    if (typeof navigate === 'function') {
      navigate(clean, { replace: true });
      return;
    }
    window.history.replaceState(null, '', clean);
  } catch {
    // Never let tidying the URL break the page it is on. The message has
    // already been shown by this point; a lingering fragment is cosmetic.
  }
}

/**
 * The one sentence shown for a failed sign-in link, so the instructor portal,
 * the admin area and the onboarding router cannot describe the same failure
 * three different ways.
 *
 * Two things it deliberately does NOT say:
 *  - "ask your operator" — the wrong advice, and the whole point of the bug
 *    this fixes. An expired link needs a new link, not a new invite.
 *  - "below" / "above" / any other pointer at a control. These surfaces put
 *    their action in different places (the instructor portal has the sign-in
 *    form inline; the admin area has a Sign in link; the error card has a
 *    button). A shared sentence that names a location is false on whichever
 *    surface doesn't match. Each caller supplies its own action next to this
 *    message.
 */
export const EXPIRED_LINK_MESSAGE =
  "That sign-in link has expired. Links are single-use and time-limited, so you'll need a fresh one.";

/**
 * Copy for an auth redirect failure that is NOT a stale link. Kept separate
 * because "expired" and "something else went wrong" are different facts and
 * must not share a string. Same no-pointing-at-controls rule as above.
 */
export function genericAuthErrorMessage(err) {
  const detail = (err?.description || '').trim();
  return detail
    ? `We couldn't sign you in: ${detail.replace(/\.$/, '')}. You'll need a new sign-in link.`
    : "We couldn't sign you in with that link. You'll need a new one.";
}
