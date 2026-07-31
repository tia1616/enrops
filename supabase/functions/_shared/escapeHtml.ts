// esc - HTML-escape for interpolating operator-supplied text into an email.
//
// Lives in _shared because more than one function needs it, and an edge function
// reaching into a SIBLING function's lib/ for a utility is a dependency nobody
// expects: deleting or moving founder-notify would silently break operator-welcome.
//
// Quotes and apostrophes are escaped too, not just the angle brackets. This is used
// inside ATTRIBUTES (href="..."), where an unescaped double quote closes the attribute
// early and lets the rest of the value inject new ones. organizations.slug has no
// CHECK constraint enforcing a url-safe format, so "the slug is always safe" is an
// app-layer convention this function must not rely on.
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
