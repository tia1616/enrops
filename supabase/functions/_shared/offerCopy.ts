// Shared instructor-facing offer copy.
//
// One sentence, one place. This note was written into six spots at once (three
// after-school offer emails x HTML + plain text) and Jessica owns the wording, so
// it WILL be reworded. Six copies would drift on the first edit, and the halves
// that drift most are the plain-text ones nobody looks at.
//
// There is a seventh copy in the browser bundle, at
// src/pages/portal/InstructorPortal.jsx (the card where the instructor actually
// accepts or requests a change). Deno and Vite cannot share a module here, so
// that one is a deliberate twin -- the same arrangement as _shared/waiverText.ts
// and src/lib/waiverText.js. If you reword this, reword that too.

// Shown when the operator assigned someone against the availability they gave us:
// a weekday they marked off, hours that don't cover the class, or no survey at all.
// Deliberately not part of the bonus line: an override is worth explaining even
// when no gas money is attached.
const BASE = "We know this falls outside the availability you gave us. No problem if it doesn't work, just request a change";

// The HTML emails put a response button underneath, so "below" points at it.
export const AVAILABILITY_OVERRIDE_NOTE_HTML = `${BASE} below.`;
// Plain text has a URL rather than a button, so "below" would be pointing at nothing.
export const AVAILABILITY_OVERRIDE_NOTE_TEXT = `${BASE}.`;

// program_assignments.flags is text[] and can be null on older rows.
export function hasAvailabilityOverride(flags: unknown): boolean {
  return Array.isArray(flags) && (flags as string[]).includes("availability_override");
}
