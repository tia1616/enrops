// Should we send a school an updated roster today?
//
// WHY THIS EXISTS. Jessica, 2026-09-14: "we only need the automation that sends
// them after start date when sth changes". Until now a school got a roster at
// most twice - seven days before day one, and the morning of - and never again.
// A child who enrolled in week two or left in week four never reached the copy
// the school takes attendance from.
//
// MEMBERSHIP ONLY, BY HER INSTRUCTION: "only dropped or added students trigger
// sends". A corrected spelling, grade or homeroom does NOT re-send. So the thing
// we compare is the SET OF STUDENTS, not the printed rows.
//
// WHY A STORED SET RATHER THAN A TIMESTAMP. The obvious implementation - "did
// anything change since we last sent?" - cannot be written here, because neither
// `registrations` nor `students` carries an `updated_at`; there is only
// `registered_at` and `cancelled_at`. That breaks on the case Jeff hits most:
// a family who abandons checkout and pays two days later joins the roster with
// `registered_at` still stamped at the moment the pending row was created, which
// is BEFORE the last send. Comparing the membership set catches it, because
// membership is derived from payment state rather than from a clock.
//
// The comparison is order-independent: both sides are sorted before comparing,
// so a roster re-ordered by a name edit is not mistaken for a change.

/** A registration row as the roster query returns it. */
export interface RosterRegRow {
  student?: { id?: string | null } | null;
  status?: string | null;
  payment_status?: string | null;
  ach_payment_state?: string | null;
}

// The membership rule itself is NOT re-spelled here. `isOnRoster` in
// _shared/rosterOrder.ts already owns "is this child on the roster", and
// email-program-roster filters with it before printing the PDF. A second copy
// would be the divergence this codebase keeps paying for, so the caller passes
// it in and this module only decides what to do with the answer.
export type IsOnRoster = (reg: RosterRegRow) => boolean;

/**
 * The roster's membership, as a stable sorted list of student ids.
 * Duplicates are collapsed: two registrations for one child are one child on the
 * roster, and counting them twice would read as a change when a duplicate row is
 * cleaned up.
 */
export function rosterStudentIds(regs: RosterRegRow[] | null | undefined, isOnRoster: IsOnRoster): string[] {
  const ids = new Set<string>();
  for (const r of regs ?? []) {
    const id = r?.student?.id;
    if (!id) continue;          // a registration with no student cannot be printed
    if (!isOnRoster(r)) continue;
    ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Has the school's copy gone stale?
 *
 * `previous` is what we recorded on the last roster we actually sent them.
 * NULL means we have no record of what they were last told - every send before
 * 2026-09-14 is in that state - and in that case we say NO. "We do not know what
 * they have" is not the same as "what they have is wrong", and guessing would
 * email every school on the first morning this ships. Each class arms itself the
 * next time a roster is sent for it, by any route.
 */
export function rosterChanged(previous: string[] | null | undefined, current: string[]): boolean {
  if (!Array.isArray(previous)) return false;   // not armed yet
  if (previous.length !== current.length) return true;
  for (let i = 0; i < current.length; i++) {
    if (previous[i] !== current[i]) return true;
  }
  return false;
}

/**
 * Is the class still running today?
 *
 * Jessica: "end this cron at the last date of the program". A school should not
 * get a roster for a class that has finished. `programs.end_date` cannot answer
 * this - it is NULL on all 99 open after-school classes on prod - so the caller
 * resolves the session dates and passes the last one.
 *
 * A class with NO resolvable session dates returns false: we would rather go
 * quiet than mail a school about a class we cannot place in the calendar.
 */
export function isStillRunning(lastSessionDate: string | null | undefined, today: string): boolean {
  if (!lastSessionDate) return false;
  return lastSessionDate >= today;
}

/**
 * The whole decision for one class, so the cron reads as a sentence and the
 * reasons are testable. `alreadySentToday` reuses the automation's existing
 * per-day guard, which also covers rosters an operator sent by hand - so a
 * manual send and the automatic one can never double up on the same school.
 */
export function shouldResendRoster(input: {
  alreadySentToday: boolean;
  previousIds: string[] | null | undefined;
  currentIds: string[];
  lastSessionDate: string | null | undefined;
  today: string;
  hasRecipients: boolean;
}): { send: boolean; reason: string } {
  if (input.alreadySentToday) return { send: false, reason: "already sent today" };
  if (!input.hasRecipients) return { send: false, reason: "no contacts on this school" };
  if (!Array.isArray(input.previousIds)) return { send: false, reason: "no baseline yet" };
  if (!isStillRunning(input.lastSessionDate, input.today)) return { send: false, reason: "class has finished" };
  if (!rosterChanged(input.previousIds, input.currentIds)) return { send: false, reason: "roster unchanged" };
  return { send: true, reason: "roster changed since the school was last sent one" };
}
