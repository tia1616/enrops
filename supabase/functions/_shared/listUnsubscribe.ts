// listUnsubscribe — the one place that builds RFC 2369 / RFC 8058 unsubscribe
// headers for an outgoing email.
//
// WHY THIS EXISTS
// Every J2S bulk email carried a footer unsubscribe link and nothing else. A
// footer link is CAN-SPAM compliance; it is NOT the signal mailbox providers
// grade you on. Gmail and Microsoft both weight the List-Unsubscribe header
// (and one-click support) when deciding inbox vs junk, because a header
// unsubscribe is the cheap alternative to a user hitting "report spam" — which
// is the single most damaging thing that can happen to a sending domain.
//
// Investigated 2026-07-30: Microsoft inboxes (hotmail/outlook/live/msn) opened
// 12.4% of J2S campaign email vs 49.3% for gmail, with ZERO bounces — the
// signature of silent junk-foldering, not rejection. Missing List-Unsubscribe
// is one of the two structural gaps found (the other being that marketing and
// transactional share one sending domain, which is a bigger, separate change).
//
// THE ONE-CLICK PROMISE
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is a PROMISE that the URL
// accepts an unauthenticated POST and unsubscribes without any further
// interaction. Advertising it against an endpoint that only handles GET is
// worse than omitting the header: providers POST, get a 405, and read the
// sender as non-compliant. This is only safe here because
// `marketing-unsubscribe` already implements the RFC 8058 POST branch
// (verifies the same HMAC, inserts the suppression, returns 200 JSON).
// If that POST branch is ever removed, DELETE the List-Unsubscribe-Post line
// in this file at the same time.
//
// SCOPE — bulk only, never transactional.
// Callers pass "" for informational/service email (camp welcome, recaps,
// birthday) so those sends stay byte-for-byte unchanged. That is deliberate:
// a family must not be able to one-click their way out of the email that tells
// them where to drop their kid off. Only mailing_type='marketing' sends and
// campaign touchpoints get a URL, and those are exactly the sends that already
// carry a footer unsubscribe link and already honor marketing_suppressions.

/**
 * Build the List-Unsubscribe headers for a send.
 *
 * @param unsubscribeUrl The per-recipient HMAC-signed marketing-unsubscribe URL.
 *                       Pass "" (or null/undefined) for transactional email —
 *                       returns {} so the caller's payload is unchanged.
 * @returns A header object to spread into the Resend payload, or {} when there
 *          is no usable URL.
 */
export function listUnsubscribeHeaders(
  unsubscribeUrl: string | null | undefined,
): Record<string, string> {
  const url = (unsubscribeUrl ?? "").trim();
  if (!url) return {};

  // Header-injection guard. The URL is built by computeUnsubscribeUrl from an
  // HMAC token + URLSearchParams, so it is already percent-encoded and cannot
  // contain a raw CR/LF today. This check means a future caller that hands us a
  // hand-built or operator-supplied string still cannot split the header block
  // and forge headers. Anything with a control character is refused outright
  // rather than sanitized — a mangled unsubscribe URL is not worth sending.
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(url)) return {};

  // https only. The endpoint is our own Supabase function; an http:// or
  // javascript: value here would mean something upstream is badly wrong, and
  // advertising it to every mailbox provider is not the way to find out.
  if (!/^https:\/\//i.test(url)) return {};

  // RFC 2369 requires the URI in angle brackets. A URL containing '>' would
  // terminate it early — reject rather than emit a malformed header.
  if (url.includes(">") || url.includes("<")) return {};

  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
