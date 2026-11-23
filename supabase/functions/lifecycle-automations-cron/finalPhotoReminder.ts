// "Final class photo" reminder: tells whoever teaches a class's LAST session to
// take a group photo and share it in enrops (class photos, 20261009b).
//
// Two sends per class, both from the daily run:
//   - week_before: the first daily run 2 to 7 days before the last class. A
//     window, not one exact day, so a missed daily run (or this automation being
//     switched on 3 days out) still gets one reminder in. The send ledger keys it
//     per class + last day + fire, so it goes once, not every day of the window.
//     1 day out is left to the morning-of send: two emails on consecutive days
//     is nagging.
//   - day_of: the morning of the last class.
//
// Pure, so the window and who-teaches rules are unit-tested without a database.

export type FinalPhotoFire = "week_before" | "day_of";

export const WEEK_BEFORE_MAX_DAYS = 7;
export const WEEK_BEFORE_MIN_DAYS = 2;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Which send (if any) is due today for a class whose last session is lastDay. */
export function finalPhotoFire(lastDay: string | null | undefined, today: string): FinalPhotoFire | null {
  if (!lastDay) return null;
  const daysUntil = dayNumber(lastDay) - dayNumber(today);
  if (daysUntil === 0) return "day_of";
  if (daysUntil >= WEEK_BEFORE_MIN_DAYS && daysUntil <= WEEK_BEFORE_MAX_DAYS) return "week_before";
  return null;
}

export interface LeadAssignment {
  assignmentId: string;
  instructorId: string;
}

export interface SettledSub {
  /** assignment_substitutions.parent_assignment_id (a program_assignments.id). */
  assignmentId: string;
  subInstructorId: string;
}

/**
 * The instructor ids teaching the last session: each confirmed assignment's
 * instructor, unless a settled substitute (confirmed or taught) covers that
 * assignment on that day, in which case the sub teaches it and the lead is off.
 * Deduped, order kept.
 */
export function teachersOnDay(leads: readonly LeadAssignment[], subs: readonly SettledSub[]): string[] {
  const subByAssignment = new Map<string, string>();
  for (const s of subs) subByAssignment.set(s.assignmentId, s.subInstructorId);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of leads) {
    const who = subByAssignment.get(l.assignmentId) ?? l.instructorId;
    if (seen.has(who)) continue;
    seen.add(who);
    out.push(who);
  }
  return out;
}
