// How the class-roster list is ORDERED and FILTERED. Pure functions, so the
// edge cases have a test instead of a hope.
//
// WHY THIS EXISTS. The list sorted by enrolled-count first
// (`b.enrolled - a.enrolled`), which answers "which of my classes are fullest"
// - a question nobody was asking on this screen. Jessica, 2026-08-31: "it's hard
// to find the school i'm looking for." Measured on prod the same day: J2S has 34
// open FA26 classes across 31 schools and Jeff has 22 across 21, so the school is
// very nearly the identity of the row, and it was the one thing the order
// ignored. Now it is the primary key, and there is a search box.
//
// Not in Rosters.jsx because that file is 2,400 lines and this is the part with
// null schools, weekday order and case-folding in it. Same reason
// rosterParse.js sits beside it.
import { to24h } from "../../lib/timeText.js";

// THE WEEKDAY ORDER, ONCE. Key order IS the order - Monday first - so the
// display map and the sort cannot disagree about what comes after Friday.
// Alphabetical would put Friday before Monday, which reads as a bug on a
// timetable.
const DAY_SHORT = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};
const DAY_ORDER = Object.keys(DAY_SHORT);

export function dayShort(d) {
  return DAY_SHORT[(d ?? "").toLowerCase()] ?? (d ?? "");
}

// A day we do not recognise sorts AFTER the seven, rather than to the front.
// `indexOf` returning -1 would put an unknown value first, which is the loudest
// possible position for the least meaningful row.
function dayIndex(d) {
  const i = DAY_ORDER.indexOf((d ?? "").toLowerCase());
  return i === -1 ? DAY_ORDER.length : i;
}

// The school a class is at, as text. `program_location_id` is nullable and the
// quick builder can create a class without one (zero such rows on prod today,
// which is exactly when this goes unnoticed), so a class with no school must
// still sort somewhere honest and still be findable.
export function schoolNameOf(p) {
  return (p?.program_locations?.name ?? "").trim();
}

// Sorted for SCANNING: school, then class, then the day of the week, then the
// time. Classes with no school yet go LAST under their own heading rather than
// sorting as an empty string to the top, where they would push 31 real schools
// down the page.
//
// localeCompare with sensitivity 'base' so "Beverly Cleary" and "beverly
// cleary" land together instead of in two different places - operator-typed
// names, and prod already carries four spellings of "unknown" in another column.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// The last tiebreak: the clock. `programs.start_time` is TEXT, not a time type,
// and the corpus is genuinely mixed - "2:35 PM" from the old forms, "14:35" from
// an <input type="time"> (see the header of lib/timeText.js). Comparing that text
// directly is wrong in both formats and quietly so: "10:00 AM" sorts before
// "9:00 AM", and "3:00 PM" before "9:00 AM", because '1' < '9' < ':'.
//
// to24h() is the one parser that already handles both spellings, and its header
// asks new code to import it rather than add a fourth copy. It returns a
// zero-padded "HH:MM", which DOES sort correctly as text. "" for anything
// unparseable, which sorts first - so a row with a missing or broken time leads
// its group rather than landing at random.
function timeKey(t) {
  return to24h(t) || "";
}

export function sortRosterPrograms(programs) {
  return [...(programs ?? [])].sort((a, b) => {
    const sa = schoolNameOf(a), sb = schoolNameOf(b);
    if (!sa !== !sb) return sa ? -1 : 1;          // no school -> last
    const bySchool = collator.compare(sa, sb);
    if (bySchool !== 0) return bySchool;
    const byClass = collator.compare(a?.curriculum ?? "", b?.curriculum ?? "");
    if (byClass !== 0) return byClass;
    const byDay = dayIndex(a?.day_of_week) - dayIndex(b?.day_of_week);
    if (byDay !== 0) return byDay;
    return timeKey(a?.start_time).localeCompare(timeKey(b?.start_time));
  });
}

// Everything a person might type to find a row: the school, the class, the day
// (both "Wednesday" and "Wed", because the row SHOWS the short form), and the
// district - schools are often searched for by the district they belong to.
function haystack(p) {
  return [
    schoolNameOf(p),
    p?.curriculum ?? "",
    p?.day_of_week ?? "",
    dayShort(p?.day_of_week),
    p?.program_locations?.district ?? "",
  ].join(" ").toLowerCase();
}

// EVERY word must match, in any field and any order, so "cleary minecraft" and
// "minecraft cleary" both find the same row. A single substring match over the
// joined string would fail both, because the words come from different fields.
export function filterRosterPrograms(programs, query) {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return programs ?? [];
  return (programs ?? []).filter((p) => {
    const h = haystack(p);
    return words.every((w) => h.includes(w));
  });
}
