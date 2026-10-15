// emailAddress — does this look like a deliverable email address?
//
// The SAME rule as emailIsValid in src/lib/validation.js, which the browser forms use.
// Edge functions cannot import from src/, so it is restated here once, and
// src/lib/emailAddressParity.test.mjs fails if the two patterns ever differ.
//
// Not RFC 5322. It exists to catch the typos that cost families a place: on prod a
// parent joined a waiting list as "christine.wynne@yahoo" (no ".com"). The browser's
// own type="email" check accepts that, Resend refuses it, and every email we then
// tried to send her failed.

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailIsValid(s: unknown): boolean {
  if (!s) return false;
  return EMAIL_PATTERN.test(String(s).trim());
}
