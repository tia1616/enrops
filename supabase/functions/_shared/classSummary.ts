// How a family email describes a class in one line: "Jackson Elementary, Room 12 ·
// Monday · 3:25pm".
//
// Moved here from notify-program-families on 2026-11-25 so the move-a-child email
// (admin-move-registration) describes a class in exactly the words Message families
// does. A family who gets both reads the class the same way twice. Behaviour is
// byte-for-byte what notify-program-families had inline.
//
// NOT YET the only copy: email-program-roster, email-camp-roster and
// create-assignment-substitution each keep their own fmtTime / day labels. Folding
// them in is a separate pass, because each of those sends to a different audience
// and their output is pinned by their own tests.

import { venueLabel } from './roomLabel.ts';

export const DAY_LABELS: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

// programs.start_time is stored either as "15:25" or as human text ("3:25 PM").
export function fmtTime(t: string | null | undefined): string {
  if (!t) return '';
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, '');
  const [hh, mm] = t.split(':').map(Number);
  if (Number.isNaN(hh)) return t;
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh >= 12 ? 'pm' : 'am';
  return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
}

// deno-lint-ignore no-explicit-any
export function describeProgram(p: Record<string, any>): string {
  const parts: string[] = [];
  // Site and room together, so a family reading "where and when" here gets the
  // same answer as the portal and the payment confirmation.
  const where = venueLabel(p?.program_locations?.name, p?.room, p?.program_locations?.room_number);
  if (where) parts.push(where);
  if (p?.day_of_week) parts.push(DAY_LABELS[String(p.day_of_week).toLowerCase()] ?? p.day_of_week);
  if (p?.start_time) parts.push(fmtTime(p.start_time));
  return parts.join(' · ');
}
