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

// "Sep 15", or "Sep 15, 2027" when the date is not in the current year. A bare
// "Sep 15" on a card a parent reads in December is genuinely ambiguous; adding
// the year only when it differs keeps the common case short.
export function formatStartDate(iso, now = new Date()) {
  if (typeof iso !== 'string' || !iso) return null;
  // Parse at local midnight, not UTC: `new Date('2026-09-15')` is UTC midnight,
  // which renders as Sep 14 anywhere west of Greenwich - including every family
  // this platform currently serves.
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
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
