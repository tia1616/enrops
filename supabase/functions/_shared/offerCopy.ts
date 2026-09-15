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
//
// BOTH exports below have that browser twin, in the SAME component
// (AfterschoolAssignmentCard). distanceBonusNote() was added 2026-09-14 and is
// twinned there too; search "paid with your last class".

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

// The gas money line. Same six-spots-at-once problem as the note above, and it
// had ALREADY drifted before landing here: send-afterschool-offers and
// offer-reminders-cron said "a $50 bonus" while send-afterschool-patch-offer
// said "a $50 distance bonus".
//
// IT SAYS WHEN, and that is the point (2026-09-14). The gas bonus now pays on
// the LAST class the instructor teaches for that program rather than the first
// payout (v_effective_pay_lines.is_final_session, read by pay-instructor). An
// instructor told "includes a $50 distance bonus" who then sees week one's pay
// arrive without it has been told something true in a way that misleads, so the
// timing is part of the sentence.
//
// CAMPS ARE NOT THIS. A camp's gas rides its single payout, which has always
// been end-of-camp; send-offers and send-patch-offer keep their own wording.
// Do not point them here without first deciding what "last class" means for a
// camp week.
//
// @param amount already formatted, e.g. "$50" -- each function has its own
// dollars() and unifying those is a separate job from unifying this sentence.
export function distanceBonusNote(amount: string): string {
  return `Includes a ${amount} distance bonus, paid with your last class.`;
}
