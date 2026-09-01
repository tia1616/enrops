// Where to send somebody AFTER they sign in, when they asked for a specific page
// first.
//
// WHY. The parent portal's deep links - the child's pickup-and-dismissal editor,
// and whatever the "please update your info in your parent portal" email points
// at - send a signed-out family to /:slug/login. Login then always went to the
// dashboard, so the page they actually asked for was lost and they had to find
// it again. Jessica, 2026-08-31, after the child link bounced her: "parent link
// asking me to sign in."
//
// THIS IS AN OPEN-REDIRECT GUARD, which is the only reason it is a module with a
// test rather than three lines inside Login.jsx. `next` arrives in the URL, so it
// is attacker-controlled: anybody can mail a family
// `enrops.com/j2s/login?next=https://evil.example/pay` and, without this, the
// sign-in they trust would hand them straight to it. Only a same-site absolute
// PATH is allowed through; everything else falls back to the caller's default.

// Control characters, as explicit escapes. Written this way on purpose: the
// first draft of this line held the RAW bytes, which are invisible in a diff and
// in most editors, and the obvious "fix" for that - a literal [ -] class - reads
// as "space or hyphen" and would reject every child link, because student ids
// are UUIDs. Neither mistake is visible; the escape is.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * A safe post-sign-in path, or `fallback` when the request is missing or unsafe.
 *
 * Accepts only a path that begins with a single "/" - never an absolute URL,
 * never a protocol-relative "//host", never a backslash (which some browsers
 * normalise to "/" and which is the classic way past a naive first-character
 * check).
 */
export function safeReturnPath(next, fallback = '/') {
  if (typeof next !== 'string') return fallback;
  const v = next.trim();
  if (v === '') return fallback;
  // Must be rooted at this site.
  if (!v.startsWith('/')) return fallback;
  // "//evil.example" is protocol-relative: the browser reads it as another host.
  if (v.startsWith('//')) return fallback;
  // A backslash is never legitimate in one of our paths, and it is the character
  // that makes the check above bypassable in browsers that normalise "\" to "/"
  // ("/\evil.example" becomes "//evil.example").
  if (v.includes('\\')) return fallback;
  if (CONTROL_CHARS.test(v)) return fallback;
  return v;
}

/** The absolute URL to hand an auth provider, from a validated path. */
export function returnUrl(origin, next, fallbackPath) {
  return `${origin}${safeReturnPath(next, fallbackPath)}`;
}
