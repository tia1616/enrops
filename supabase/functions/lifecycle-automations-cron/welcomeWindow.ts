// welcomeWindow.ts — who still counts as "about to start" for the Welcome email.
//
// There are two ways into the Welcome audience, kept deliberately separate:
//
//   ON TIME — the program starts between today and today + days_before. This is
//             the original rule, unchanged. Everything that used to qualify
//             still qualifies, and renders the same date it always did.
//
//   LATE    — the program ALREADY started but has not finished. A parent who
//             signs up the morning of day one (after the daily run), or joins
//             in week 6 of a term, still needs this email: it is the only
//             message carrying arrival, dismissal, session dates and what to
//             bring. Before this, first_session_date >= today excluded them
//             outright and they got nothing, ever.
//
// The late path is fenced so widening the window can never mail a family about
// something that is over or that they signed up for long ago:
//   - the program must still have a session on or after today (a program whose
//     end is UNKNOWN is refused, not guessed — see lastRunDay)
//   - the registration must post-date the day the automation was switched on,
//     so turning Welcome on cannot back-mail a previous term
//   - and be no older than LATE_JOIN_MAX_AGE_DAYS, so a stale import cannot
//     suddenly trigger months after the fact
//
// Dates here are plain YYYY-MM-DD in the ORG's timezone, never the server's.
// Chase Youth is Eastern; at 8pm there it is already tomorrow in UTC, so a
// UTC "today" would treat a class starting that evening as already past.

/** A registration older than this never qualifies as a late join. */
export const LATE_JOIN_MAX_AGE_DAYS = 30;

/** Sweep runs stay inside these org-local hours, so nobody is emailed at 3am. */
export const SEND_HOUR_START = 7;
export const SEND_HOUR_END = 21;

/** Today in an org's own timezone, as YYYY-MM-DD. Falls back to UTC. */
export function orgToday(timezone: string | null | undefined, now: Date): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape every date
    // column and comparison in this file uses.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Hour of day (0-23) in an org's own timezone. Falls back to UTC. */
export function orgHour(timezone: string | null | undefined, now: Date): number {
  try {
    // hourCycle h23 explicitly: with hour12:false some ICU builds render
    // midnight as "24", which would parse to an hour that does not exist.
    const h = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now);
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? n : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** Whether a sweep should send right now for this org. */
export function withinSendingHours(hour: number): boolean {
  return hour >= SEND_HOUR_START && hour < SEND_HOUR_END;
}

/** Calendar math on YYYY-MM-DD, timezone-free (the date is already org-local). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface WelcomeCandidate {
  /** programs.first_session_date, or camp_sessions.starts_on. */
  startsOn: string | null;
  /** Afterschool: derive_program_session_dates output (honors closures). */
  sessionDates?: string[] | null;
  /** Camps: camp_sessions.ends_on. */
  endsOn?: string | null;
  /** registrations.registered_at. */
  registeredAt?: string | null;
}

export interface WelcomeWindow {
  /** Org-local today, YYYY-MM-DD. */
  today: string;
  /** Org-local today + days_before, YYYY-MM-DD. */
  windowEnd: string;
  /** automations.enabled_at — the earliest a late join may have registered. */
  enabledAt?: string | null;
  now: Date;
}

export interface WelcomeVerdict {
  eligible: boolean;
  /** True when this one only qualifies because of the late-join path. */
  late: boolean;
  /**
   * The day THIS family should be told about: the program's start for an
   * on-time signup, or their next actual session for a late join. Never a date
   * in the past, so "starts {{program_start_date}}" cannot read as history.
   */
  firstDay: string | null;
  /** Why, for logs and tests. */
  reason: string;
}

/** The last day this program/camp runs, or null when we cannot know it. */
export function lastRunDay(c: WelcomeCandidate): string | null {
  const sessions = (c.sessionDates ?? []).filter(Boolean);
  if (sessions.length > 0) return sessions.reduce((a, b) => (a > b ? a : b));
  // programs.end_date is unpopulated on almost every real row, so camps' ends_on
  // is the only other honest source. No source => no answer (never a guess).
  return c.endsOn ?? null;
}

/** The family's next session on or after today, when we know the dates. */
export function nextSessionOnOrAfter(sessions: string[] | null | undefined, today: string): string | null {
  const upcoming = (sessions ?? []).filter((s) => !!s && s >= today);
  if (upcoming.length === 0) return null;
  return upcoming.reduce((a, b) => (a < b ? a : b));
}

/**
 * The floor a late join's registered_at must clear: whichever is LATER of the
 * day the automation was enabled and LATE_JOIN_MAX_AGE_DAYS ago.
 *
 * Returns null when enabled_at is unknown, and callers must then refuse the
 * late path entirely. Falling back to the 30-day cap here would quietly turn
 * "switching Welcome on cannot mail people who enrolled earlier" into "it can
 * mail anyone from the last 30 days" — and enabled_at is null on any row
 * enabled by SQL, a seed or a backfill rather than by the toggle. Same posture
 * as lastRunDay: no source, no answer.
 */
export function lateJoinFloor(enabledAt: string | null | undefined, now: Date): number | null {
  const enabled = enabledAt ? Date.parse(enabledAt) : NaN;
  if (!Number.isFinite(enabled)) return null;
  return Math.max(enabled, now.getTime() - LATE_JOIN_MAX_AGE_DAYS * 86400000);
}

/**
 * The sessions a family joining today still gets. For an on-time signup this
 * is every session (the program has not started), so the value is unchanged;
 * for a late join it drops the ones they were never enrolled for.
 */
export function sessionsOnOrAfter(sessions: string[] | null | undefined, today: string): string[] {
  return (sessions ?? []).filter((s) => !!s && s >= today);
}

/** Does this registration belong in the Welcome audience, and for which day? */
export function welcomeVerdict(c: WelcomeCandidate, w: WelcomeWindow): WelcomeVerdict {
  const no = (reason: string): WelcomeVerdict => ({ eligible: false, late: false, firstDay: null, reason });

  if (!c.startsOn) return no("no_start_date");
  if (c.startsOn > w.windowEnd) return no("starts_after_window");

  // ON TIME — untouched behavior, and the date shown stays the program's start.
  if (c.startsOn >= w.today) {
    return { eligible: true, late: false, firstDay: c.startsOn, reason: "on_time" };
  }

  // LATE — every gate below has to pass.
  const lastDay = lastRunDay(c);
  if (!lastDay) return no("end_unknown");
  if (lastDay < w.today) return no("already_over");

  const registered = c.registeredAt ? Date.parse(c.registeredAt) : NaN;
  if (!Number.isFinite(registered)) return no("no_registered_at");
  const floor = lateJoinFloor(w.enabledAt, w.now);
  if (floor === null) return no("enabled_at_unknown");
  if (registered < floor) return no("registered_before_floor");

  // Their next real session; for a camp with no session list, the soonest
  // honest answer is today (it is running now and has not ended).
  const firstDay = nextSessionOnOrAfter(c.sessionDates, w.today) ?? w.today;
  return { eligible: true, late: true, firstDay, reason: "late_join" };
}
