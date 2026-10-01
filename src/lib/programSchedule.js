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

// A camp is a program that runs on CONSECUTIVE DAYS: programs.class_days lists
// the days it meets, and is NULL on a weekly class. Same test as the SQL, where
// the consecutive branch of derive_program_session_dates needs array_length > 0,
// so an empty array is a weekly class in both places.
//
// ONE definition, because "is this a camp?" now decides school-binding on the
// public catalog, the day label on its card, and which list it lands in - and
// three spellings of it would drift the first time one was fixed.
export function isCampProgram(program) {
  return Array.isArray(program?.class_days) && program.class_days.length > 0;
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

// WHEN A CAMP RUNS: "December 21-24", or "December 28-January 2" across a month.
//
// Twin of campRunLabel() in supabase/functions/_shared/campProgram.ts, and
// asserted against it by campProgram.test.ts, which runs both over the same
// rows. Deno and Vite cannot share a module, so the rule is written twice and
// pinned once - the same arrangement as formatDayLabel above.
//
// It exists on this side because the availability survey asks an instructor
// which camps they can work, and "Mon-Thu" alone does not tell them WHICH
// Mon-Thu. The dates are the question.
//
// Returns null when the dates are not both known, so a caller drops the segment
// rather than printing a range to nowhere. A one-day camp reads as one date,
// not as a range from a day to itself.
export function campRunLabel(program) {
  if (!isCampProgram(program)) return null;
  const startsOn = typeof program?.first_session_date === 'string' ? program.first_session_date : '';
  const endsOn = typeof program?.end_date === 'string' ? program.end_date : '';
  const long = { month: 'long', day: 'numeric' };
  const start = formatCalendarDate(startsOn, long);
  if (!start) return null;
  const end = formatCalendarDate(endsOn, long);
  if (!end || startsOn.slice(0, 10) === endsOn.slice(0, 10)) return start;
  // Same month: "December 21-24" rather than repeating the month.
  if (startsOn.slice(0, 7) === endsOn.slice(0, 7)) {
    const endDay = formatCalendarDate(endsOn, { day: 'numeric' });
    return endDay ? `${start}-${endDay}` : start;
  }
  return `${start}-${end}`;
}

// Which weekdays a program OCCUPIES, lowercase, in calendar order.
//
// For a weekly class that is the single day it repeats on. For a CAMP it is
// every day of its run - and that difference is the whole point. A camp's
// day_of_week holds only its FIRST day, so anything that asks "which day is
// this on" and reads day_of_week gets Monday for a Mon-Thu camp, and then
// believes the instructor is free Tue, Wed and Thu.
//
// That is not cosmetic: the scheduling board uses the answer for "already
// teaches that day", for counting days against an instructor's max, and for
// checking their stated weekday availability. Under-reporting a camp by three
// days silently double-books an instructor and under-counts their workload.
//
// Returns [] when neither is known, so a caller can skip rather than guess.
export function programWeekdays(program) {
  const days = Array.isArray(program?.class_days) ? program.class_days : null;
  if (days && days.length > 0) {
    const lower = days.map((d) => String(d).toLowerCase());
    return CLASS_DAY_ORDER.filter((d) => lower.includes(d));
  }
  const single = String(program?.day_of_week ?? '').trim().toLowerCase();
  return CLASS_DAY_ORDER.includes(single) ? [single] : [];
}

// The first day on or after `iso` that the camp actually MEETS.
//
// An operator can legitimately type a start that is not a meeting day - "the
// camp runs the week of the 30th", Tuesday to Friday - and the saved
// first_session_date is then the Tuesday, not the Monday they typed. Anything
// deriving from the start date has to walk to that day first, or it is
// describing a day the camp does not run.
//
// Closures are NOT applied here, deliberately. This answers "which day does
// this camp intend to start", which is what the season and the operator-facing
// readback are about; the authoritative session list still comes from
// derive_program_session_dates, which knows the site's closures. Keeping the two
// separate is why this is safe to use for display: it cannot contradict the
// saved dates, because it is not claiming to be them.
//
// Returns null when there is no date or no days, so a caller renders nothing.
export function firstMeetingDayOnOrAfter(iso, classDays) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return null;
  const days = Array.isArray(classDays)
    ? classDays.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
    : [];
  if (days.length === 0) return null;
  const d = new Date(`${iso.trim()}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  // Seven steps is the whole week, so a day that is in the list is always found.
  for (let i = 0; i < 7; i += 1) {
    if (days.includes(CLASS_DAY_ORDER[(d.getDay() + 6) % 7])) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

// THE SEASON A CAMP BELONGS TO, FROM ITS OWN FIRST DAY. "2026-12-21" -> "WI27".
//
// programs.term is NOT NULL, so every camp needs one - but a camp should never
// be ASKED for it. Jessica, 2026-09-28: "why does it still ask which term?
// aren't dates enough? and summer won't have a term." Both true: the dates
// already say which season it is, and she runs no summer after-school term to
// pick from.
//
// Nothing breaks by deriving a term she has never configured, because the term
// list is not configuration: org_terms() builds it by grouping the org's own
// programs, so the first July camp simply makes "Summer 2027" exist.
//
// THE SEASONS HERE ARE CAMP SEASONS, NOT TERM SEASONS, and that is deliberate.
// December sits inside the FALL after-school term (J2S's FA26 runs sessions into
// January), but a camp on 21 December is a WINTER BREAK camp and belongs on the
// winter schedule - which is exactly what Jessica asked for: "i want them as
// part of the winter schedule". The same rule puts a late-March camp in Spring,
// where spring break actually falls, and June through August in Summer. Mapping
// by the school term instead would file winter break under Fall and spring break
// under Winter, which is nobody's idea of either.
//
//   Dec, Jan, Feb -> WI    (December takes the FOLLOWING year: Dec 2026 = WI27)
//   Mar, Apr, May -> SP
//   Jun, Jul, Aug -> SU
//   Sep, Oct, Nov -> FA
//
// Returns null for anything that is not a YYYY-MM-DD date, so a caller can fall
// back rather than write a bad term.
export function campTermForDate(iso) {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) return null;

  let season;
  let termYear = year;
  if (month === 12) { season = "WI"; termYear = year + 1; }
  else if (month <= 2) season = "WI";
  else if (month <= 5) season = "SP";
  else if (month <= 8) season = "SU";
  else season = "FA";

  return `${season}${String(termYear % 100).padStart(2, "0")}`;
}
