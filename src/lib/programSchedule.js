// One canonical way to tell a family WHEN a class runs.
//
// Every public surface that describes a program to a parent reads this - the
// catalog cards and the pre-payment review line - so they can never drift into
// formatting the same date two different ways, or disagree about what a
// one-session workshop is called.
//
// Deliberately absent: an end date. A program's real last session is NOT
// first_session_date + 7 x (sessions - 1). School closures push sessions out, so
// J2S's 8-session FA26 classes actually run nine weeks (Sep 4 -> Nov 6). The one
// function that knows the truth, derive_program_session_dates(), reads
// program_locations.closure_dates, and anon holds column-level SELECT on that
// table for eight columns that do not include closure_dates - a public visitor
// calling it gets a 401. So the honest options on a public card are a true end
// date (needs a SECURITY DEFINER wrapper) or none. A computed one would print a
// date the class does not actually end on, which is worse than saying nothing.

const SEP = '·'; // middot, matching the separator the catalog cards already use

// A calendar date, parsed at LOCAL midnight and formatted however the caller
// asks. The one place that knows the trap, so nobody has to rediscover it:
// `new Date('2026-09-15')` is UTC midnight, which renders as Sep 14 anywhere
// west of Greenwich - including every family and every operator this platform
// currently serves.
//
// Returns null - never a half-formatted string - for anything it cannot parse,
// including a rolled-over date like '2027-13-05', so a caller can tell "no date"
// from "a date I made up". Callers render nothing on null.
export function formatCalendarDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (typeof iso !== 'string' || !iso) return null;
  const ymd = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject rollover: JS turns month 13 into January of the next year and day 30
  // of February into March, so a malformed date would otherwise print as a
  // confident, wrong day.
  const [y, m, day] = ymd.split('-').map(Number);
  if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null;
  return d.toLocaleDateString('en-US', opts);
}

// "Sep 15", or "Sep 15, 2027" when the date is not in the current year. A bare
// "Sep 15" on a card a parent reads in December is genuinely ambiguous; adding
// the year only when it differs keeps the common case short.
export function formatStartDate(iso, now = new Date()) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return formatCalendarDate(iso, opts);
}

// Reads `first_session_date` and `session_count` off a program row OR a pricing
// line (both carry those exact keys). Returns null when the operator has told us
// neither, so the caller renders nothing rather than an empty line or a
// placeholder - a blank is honest, "Starts TBD" is a promise we did not make.
export function programScheduleSummary(program, now = new Date()) {
  const start = formatStartDate(program?.first_session_date, now);

  // session_count is NOT NULL in count mode and materialized in range mode, but
  // a 0 or a stray string must never reach the card as "0 sessions".
  const raw = Number(program?.session_count);
  const count = Number.isInteger(raw) && raw > 0 ? raw : null;

  // A one-off workshop does not "start" - it happens. "Starts Aug 15 - 1 session"
  // reads to a skimming parent like the first of a series they are committing to.
  if (count === 1) return start ? `Meets ${start}` : null;

  const parts = [];
  if (start) parts.push(`Starts ${start}`);
  if (count) parts.push(`${count} sessions`);
  return parts.length ? parts.join(` ${SEP} `) : null;
}

// Short labels for a camp's day list, in calendar order. Lowercase keys because
// that is what programs.class_days stores (there is a CHECK constraint on it).
const CLASS_DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const CLASS_DAY_SHORT = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

// The weekday label for a program row OR a pricing line: "Mondays" for a normal
// recurring class, "Monday" (singular) for a one-off workshop that meets once,
// "Mon-Fri" for a CAMP, and null when the operator never set a day (so the caller
// renders nothing, not the literal string "nulls"). ONE definition so the day
// label and the schedule line can never disagree on the same card - the count
// test here uses the exact same Number() coercion programScheduleSummary uses, so
// a string "1" is treated as one session by both, never one/plural by one and the
// other.
//
// THE CAMP BRANCH IS NOT COSMETIC. A camp's day_of_week is NOT NULL and holds its
// FIRST day, so without this a Monday-to-Friday winter break camp advertised
// itself to families as "Mondays" - on the public catalog card, above a Register
// button, next to its price. A parent would read a weekly Monday class and buy a
// week of full-day camp. Caught on staging by selling one.
export function formatDayLabel(program) {
  const days = Array.isArray(program?.class_days) ? program.class_days : null;
  if (days && days.length > 0) {
    const ordered = CLASS_DAY_ORDER.filter((d) => days.includes(d));
    // Fall through to the weekday label if class_days held nothing recognisable,
    // rather than returning an empty string the card would render as a stray dot.
    if (ordered.length > 0) {
      const shorts = ordered.map((d) => CLASS_DAY_SHORT[d]);
      if (shorts.length === 1) return shorts[0];
      // Contiguous runs read as a range ("Mon-Fri"); a camp that skips a day in
      // the middle - a holiday week, the case this was built for - has to list
      // them, because "Mon-Fri" would promise a day it does not meet.
      const firstIdx = CLASS_DAY_ORDER.indexOf(ordered[0]);
      const lastIdx = CLASS_DAY_ORDER.indexOf(ordered[ordered.length - 1]);
      const contiguous = lastIdx - firstIdx === ordered.length - 1;
      return contiguous ? `${shorts[0]}-${shorts[shorts.length - 1]}` : shorts.join(', ');
    }
  }
  const day = program?.day_of_week;
  if (!day) return null;
  return Number(program?.session_count) === 1 ? day : `${day}s`;
}
