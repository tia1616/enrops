// tel: link for a stored phone number. Returns null when nothing dialable is left.
// Anything after the first letter or "#" (an extension, "x2", "ext 4", "(cell)") is
// dropped, so its digits are never glued onto the number that gets dialed.
// Older copies of this rule still live inline in Rosters.jsx, ProgramRoster.jsx and
// InstructorPortal.jsx; new code calls this one.
export function telHref(phone) {
  if (!phone) return null;
  // A leading label ("Cell: 503...") is skipped; the cut starts after the first digit or "+".
  const s = String(phone);
  const start = s.search(/[0-9+]/);
  if (start < 0) return null;
  const main = s.slice(start).split(/[a-z#]/i)[0];
  const digits = main.replace(/[^0-9+]/g, "");
  return /\d/.test(digits) ? `tel:${digits}` : null;
}
