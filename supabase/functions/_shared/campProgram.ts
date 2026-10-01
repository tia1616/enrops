// What a CAMP is, and how to describe when it runs, for Deno edge functions.
//
// WHY THIS EXISTS. Since 2026-09-25 a camp is a row in `programs` with
// class_days set, and its day_of_week holds only its FIRST day. Every surface
// that reads day_of_week and stops there calls a Monday-to-Thursday winter camp
// "Mondays". That has now been fixed in seven browser surfaces, all of which
// call formatDayLabel() in src/lib/programSchedule.js - and it was still wrong
// in the three instructor-offer emails, which are Deno and cannot import that
// module. They each had their own hand-written dayLabel(), so they each had the
// bug. This is the Deno end of that one rule.
//
// THE BROWSER TWIN IS src/lib/programSchedule.js. Deno and Vite cannot share a
// module here, so campDayLabel() below is a deliberate twin of the CAMP BRANCH
// of formatDayLabel() there - the same arrangement, and the same reason, as
// _shared/waiverText.ts / src/lib/waiverText.js and _shared/offerCopy.ts /
// InstructorPortal.jsx. If you change the camp label in one, change it in the
// other: an instructor reads this email and then opens the portal card, and the
// two describing the same camp differently is the confusion this replaces.
// campProgram.test.ts asserts the pairs this twin has to get right.
//
// The WEEKLY branch is deliberately NOT here. Each calling function keeps its
// own dayLabel()/dayName() for a weekly class, so a class's line comes out of
// this change byte-for-byte as it went in. That is the safety property: only a
// camp reads differently afterwards.

// A program with a non-empty class_days is a CAMP.
//
// NOT `class_days IS NULL` - the CHECK constraint permits an empty array, and an
// empty array means CLASS. Reading it as "not null therefore camp" is the bug
// this predicate exists to stop, and it has been made twice.
//
// Twin of isCampProgram() in noSchoolDates.ts, which imports this rather than
// keeping its own copy - one definition for the whole Deno side.
export function isCampProgram(
  program: { class_days?: unknown } | null | undefined,
): boolean {
  const days = program?.class_days;
  return Array.isArray(days) && days.length > 0;
}

// Lowercase, because that is what programs.class_days stores (there is a CHECK
// constraint on it). Calendar order, so the label reads Mon-Fri and never
// Fri-Mon whatever order the array happens to hold.
const CLASS_DAY_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const CLASS_DAY_SHORT: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/**
 * The days a CAMP meets: "Mon-Fri", or "Mon, Wed, Fri" when it skips a day.
 *
 * Contiguous runs read as a range; a camp with a gap in the middle - a holiday
 * week, which is exactly the shape of a winter break camp - has to list its
 * days, because "Mon-Fri" would promise a day it does not meet. Same rule as
 * the browser twin.
 *
 * Returns '' for anything that is not a camp, or whose class_days holds nothing
 * recognisable, so the caller falls back to its own weekly label instead of
 * printing an empty segment.
 */
export function campDayLabel(
  program: { class_days?: unknown } | null | undefined,
): string {
  if (!isCampProgram(program)) return "";
  const days = (program?.class_days as unknown[]).map((d) =>
    String(d).trim().toLowerCase()
  );
  const ordered = CLASS_DAY_ORDER.filter((d) => days.includes(d));
  if (ordered.length === 0) return "";
  const shorts = ordered.map((d) => CLASS_DAY_SHORT[d]);
  if (shorts.length === 1) return shorts[0];
  const firstIdx = CLASS_DAY_ORDER.indexOf(ordered[0]);
  const lastIdx = CLASS_DAY_ORDER.indexOf(ordered[ordered.length - 1]);
  const contiguous = lastIdx - firstIdx === ordered.length - 1;
  return contiguous
    ? `${shorts[0]}-${shorts[shorts.length - 1]}`
    : shorts.join(", ");
}

/**
 * WHICH WEEKDAYS A PROGRAM OCCUPIES, lowercase, in calendar order.
 *
 * For a weekly class that is the single day it repeats on. For a CAMP it is
 * EVERY day of its run, and that difference is the whole point: a camp's
 * day_of_week holds only its FIRST day, so anything that asks "which day is
 * this on" and reads that column gets Monday for a Mon-Thu camp - and then
 * believes the instructor is free Tuesday, Wednesday and Thursday.
 *
 * Twin of programWeekdays() in src/lib/programSchedule.js, asserted against it
 * by campProgram.test.ts. The browser one has been the scheduling board's
 * answer since the camp build; this is the Deno end so the auto-matcher can ask
 * the same question the board already asks.
 *
 * Returns [] when neither is known, so a caller can skip rather than guess.
 */
export function programWeekdays(
  program: { class_days?: unknown; day_of_week?: unknown } | null | undefined,
): string[] {
  const days = Array.isArray(program?.class_days) ? program!.class_days as unknown[] : null;
  if (days && days.length > 0) {
    const lower = days.map((d) => String(d).toLowerCase());
    return CLASS_DAY_ORDER.filter((d) => lower.includes(d));
  }
  const single = String(program?.day_of_week ?? "").trim().toLowerCase();
  return CLASS_DAY_ORDER.includes(single) ? [single] : [];
}

// "2026-12-21" -> "December 21". Local parse via T00:00:00, not Date(iso),
// which is UTC and lands a date on the day before for anyone behind it. Same
// spelling as fmt() in these functions already, so a camp's dates and a
// response deadline are formatted the same way in the same email.
function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

// "2026-12-21" -> 21.
function dayOfMonth(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

/**
 * When a CAMP runs: "December 21-24", or "December 28-January 2" when it
 * crosses a month. This is what replaces "all term" on a camp's line.
 *
 * "all term" is not merely imprecise for a camp, it is false, and it is false in
 * the email that asks an instructor to commit: someone accepting what reads as a
 * weekly Monday class for a whole term has agreed to something that does not
 * exist. The camp's own dates are the only honest answer.
 *
 * Returns '' when the dates are not both known. The caller then drops the
 * segment rather than printing "all term", because saying nothing about a
 * camp's run is recoverable - the instructor asks - and saying "all term" is
 * not.
 */
export function campRunLabel(
  program:
    | { class_days?: unknown; first_session_date?: unknown; end_date?: unknown }
    | null
    | undefined,
): string {
  if (!isCampProgram(program)) return "";
  const startsOn = typeof program?.first_session_date === "string"
    ? program.first_session_date
    : "";
  const endsOn = typeof program?.end_date === "string" ? program.end_date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return longDate(startsOn);
  // A one-day camp reads as one date, not as a range from a day to itself.
  if (startsOn === endsOn) return longDate(startsOn);
  const sameMonth = startsOn.slice(0, 7) === endsOn.slice(0, 7);
  return sameMonth
    ? `${longDate(startsOn)}-${dayOfMonth(endsOn)}`
    : `${longDate(startsOn)}-${longDate(endsOn)}`;
}

/**
 * WHEN THIS RUNS, for a FAMILY: "Mondays" for a weekly class, "Mon-Thu,
 * December 21-24" for a camp.
 *
 * This is the line on the Stripe checkout page and on the receipt the family
 * keeps, so it answers a different question from programRunLabel below, which
 * tells an INSTRUCTOR how long an engagement lasts. A family is not committing
 * to a term, they are buying specific days.
 *
 * It exists because create-checkout built that line as `${day_of_week}s` from
 * the posted cart, and a camp's day_of_week holds only its FIRST day - so a
 * Mon-Thu winter camp was charged for "Mondays". Composed HERE rather than
 * inline in the function so the composition has a test and there is one Deno
 * spelling of it.
 *
 * A camp carries its dates as well as its days: the dates are what a family
 * arranges childcare around, and what makes a break camp legible on a receipt
 * read months later. When the dates are not both known campRunLabel returns '',
 * and the days alone are still true, so the empty half is dropped.
 *
 * Returns '' when there is nothing true to say - the caller drops the segment
 * rather than printing an empty one.
 */
export function programScheduleLabel(
  program:
    | { day_of_week?: unknown; class_days?: unknown; first_session_date?: unknown; end_date?: unknown }
    | null
    | undefined,
): string {
  if (isCampProgram(program)) {
    return [campDayLabel(program), campRunLabel(program)].filter(Boolean).join(", ");
  }
  const day = program?.day_of_week;
  return typeof day === "string" && day.trim() ? `${day.trim()}s` : "";
}

/**
 * The phrase that says how long an engagement lasts, for one program row:
 * "all term" for a weekly class, the camp's dates for a camp.
 *
 * ONE place, because the three offer emails each said "all term" twice (HTML
 * and plain text) and the plain-text halves are the ones nobody reads back.
 */
export function programRunLabel(
  program:
    | { class_days?: unknown; first_session_date?: unknown; end_date?: unknown }
    | null
    | undefined,
): string {
  if (!isCampProgram(program)) return "all term";
  return campRunLabel(program);
}

/**
 * Does this list of programs contain a camp?
 *
 * The offer and reminder emails open with "each one runs weekly all term". With
 * a camp in the list that sentence is false about part of what it introduces,
 * so it has to change - but ONLY then, so an all-classes email is unchanged.
 */
export function anyCampProgram(
  programs: Array<{ class_days?: unknown } | null | undefined> | null | undefined,
): boolean {
  return (programs ?? []).some((p) => isCampProgram(p));
}

/**
 * What to CALL the things in an offer email: "class"/"classes", "camp"/"camps",
 * or "classes and camps" when the list holds both.
 *
 * Same vocabulary as unitLabel() in offer-reminders-cron, which picks the noun
 * from a cycle's type. A program-term email has no cycle type to ask - the list
 * itself is the only thing that knows - so it asks the list.
 */
export function programsUnitLabel(
  programs: Array<{ class_days?: unknown } | null | undefined> | null | undefined,
): string {
  const list = (programs ?? []).filter(Boolean);
  const camps = list.filter((p) => isCampProgram(p)).length;
  const plural = list.length !== 1;
  if (camps === 0) return plural ? "classes" : "class";
  if (camps === list.length) return plural ? "camps" : "camp";
  // Mixed is plural by definition: it takes at least one of each.
  return "classes and camps";
}

/**
 * The clause that says what SHAPE the engagements are: returned lowercase, so
 * a sentence can continue into it ("... on each of the 3 classes - each one
 * runs weekly all term, and ...") and a sentence that starts with it can
 * capitalize.
 *
 * A camp does not run weekly and does not run all term, so with one in the list
 * the sentence stops claiming it and points at the dates on each row instead.
 * With no camp the wording is exactly what it has always been, which is the
 * point: an all-classes email is not touched by this at all.
 */
export function runsClause(
  programs: Array<{ class_days?: unknown } | null | undefined> | null | undefined,
): string {
  return anyCampProgram(programs)
    ? "the days and dates for each are below"
    : "each one runs weekly all term";
}
