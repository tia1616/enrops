// Which tenant_pay_rates cell a PROGRAM's day pays at. One rule, one place.
//
// WHY THIS EXISTS. Instructor pay is resolved by
// resolvePayAmount(org, role, session_type) against tenant_pay_rates, and the
// session_type that goes in is also what gets stored on the
// session_delivery_confirmations row - so it is read again later by
// admin-confirm-session and confirm-session-delivery when a day is approved.
// Get it wrong once at the write and every downstream reader is wrong too.
//
// THREE writers each derived it for themselves, and all three hard-coded
// 'after_school' for a program with the same comment: "programs carry no
// session_type". That was true until 2026-09-25, when a camp became a row in
// `programs` with class_days set. From that day a four-day full-day camp paid a
// J2S lead $240 instead of $640 (after_school $60 vs full_day $160), silently,
// with a plausible-looking number on the Payroll screen.
//
//   confirm-session-taught      instructor marks a day taught
//   confirm-sub-delivery        a sub is paid for covering a day
//   session-confirmation-cron   seeds today's placeholder rows (Job C)
//
// confirm-session-delivery and admin-confirm-session deliberately do NOT call
// this: they flip an EXISTING row and re-resolve from row.session_type, so they
// inherit whatever the three writers above stored. That is the whole reason the
// rule has to be right at the write.
//
// A WEEKLY CLASS IS UNCHANGED, byte for byte. programSessionType() answers
// 'after_school' for a non-camp without reading programs.session_type at all,
// so this change cannot move a single existing pay line.

import { isCampProgram } from './campProgram.ts';
import type { PaySessionType } from './payRates.ts';

/** The columns this rule needs. Both are on `programs`. */
export type ProgramPayShape = {
  class_days?: unknown;
  session_type?: unknown;
};

const CAMP_SESSION_TYPES: readonly string[] = [
  'morning',
  'afternoon',
  'full_day',
  // A camp typed 'after_school' is legal in the CHECK (the column shares
  // tenant_pay_rates' vocabulary) and priced like one. Nothing offers it in the
  // builder, but it is not an error if it arrives.
  'after_school',
];

/**
 * The session_type a program's day pays at.
 *
 *   weekly class   'after_school', always, without reading session_type.
 *   camp           its declared session_type.
 *   camp with none `null`.
 *
 * NULL IS THE POINT, and it is not a fallback to after-school. There is no
 * honest answer for a camp nobody told us the shape of, and 'after_school' is a
 * specific WRONG answer that pays a full-day camp a third of its rate. Callers
 * refuse to price the day instead and say why; the admin then sets the amount on
 * Payroll, which is the same graceful path an unconfigured rate already takes.
 *
 * Uses isCampProgram(), never `class_days IS NULL`: the CHECK constraint permits
 * an empty array and an empty array means CLASS.
 */
export function programSessionType(
  program: ProgramPayShape | null | undefined,
): PaySessionType | null {
  if (!isCampProgram(program)) return 'after_school';
  const declared = program?.session_type;
  if (typeof declared !== 'string') return null;
  const trimmed = declared.trim();
  return CAMP_SESSION_TYPES.includes(trimmed) ? (trimmed as PaySessionType) : null;
}

/**
 * Does this program need a session_type before its days can be priced?
 *
 * True only for a camp that has not declared one. The two interactive writers
 * turn this into a refusal with a message an operator can act on; the unattended
 * cron uses it to skip the camp and record the surprise rather than seed a row
 * it would have to type a lie onto (session_delivery_confirmations.session_type
 * is NOT NULL, so "leave it blank" is not available there).
 */
export function campNeedsSessionType(
  program: ProgramPayShape | null | undefined,
): boolean {
  return isCampProgram(program) && programSessionType(program) === null;
}
