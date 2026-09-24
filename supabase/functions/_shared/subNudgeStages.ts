// WHEN a sub class-day gets chased, and WHO gets chased.
//
// Jessica set these, 2026-09-24, after looking at how Frontline Absence
// Management escalates: it notifies substitutes passively, then switches to
// actively phoning them two days before the absence, and separately gives the
// administrator a standing report of what is still unfilled.
//
// Her ordering, and the reason it is right: chase the people who can actually
// SOLVE it first, and only interrupt the provider if that did not work. Each
// instructor nudge lands one day before the provider hears anything, so the
// people who can fix it get a chance to before it becomes somebody's problem.
//
//   T-8  instructors   "still looking for cover"
//   T-7  provider      "nobody has answered yet"
//   T-4  instructors   second ask
//   T-3  provider      "still nobody" - at this range it is a decision, not a
//                      reminder, and the copy says so
//
// ONE PLACE. The cron reads these and nothing else computes them, so the
// schedule cannot drift between the query that finds the days and the email
// that goes out.

export type NudgeStage = 'instructor_1' | 'provider_1' | 'instructor_2' | 'provider_2';

export interface StageSpec {
  stage: NudgeStage;
  /** Whole days between "today" and the class-day. */
  daysOut: number;
  /** Who receives it. */
  audience: 'instructors' | 'provider';
}

export const NUDGE_STAGES: StageSpec[] = [
  { stage: 'instructor_1', daysOut: 8, audience: 'instructors' },
  { stage: 'provider_1',   daysOut: 7, audience: 'provider' },
  { stage: 'instructor_2', daysOut: 4, audience: 'instructors' },
  { stage: 'provider_2',   daysOut: 3, audience: 'provider' },
];

/**
 * The stage due for a class-day that is `daysOut` days away, or null.
 *
 * EXACT match on purpose, not "<=". The cron runs daily, so every threshold is
 * hit exactly once; a "<=" rule would make every later run re-qualify the same
 * day for the same stage and rely entirely on the sent-log to stay quiet. The
 * log is the backstop, not the mechanism.
 *
 * A day in the past (negative) or today (0) never qualifies: chasing somebody
 * about a class that has already happened is noise, and the board is the right
 * surface for a day that arrived uncovered.
 */
export function stageForDaysOut(daysOut: number): StageSpec | null {
  if (!Number.isInteger(daysOut) || daysOut <= 0) return null;
  return NUDGE_STAGES.find((s) => s.daysOut === daysOut) ?? null;
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Calendar days, not hours. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

/** Every daysOut value the cron needs to look for, for one query. */
export function allNudgeDaysOut(): number[] {
  return NUDGE_STAGES.map((s) => s.daysOut);
}
