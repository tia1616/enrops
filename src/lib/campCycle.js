// Shared camp-weekday bits.
//
// This file used to be "making a camp from the Programs screen without the
// operator ever meeting a cycle": it derived a scheduling_cycles row and a week
// number so the builder could write camp_sessions, whose cycle_id and week_num
// are both NOT NULL.
//
// None of that is needed any more. A camp created from the Programs screen is a
// PROGRAM with class_days set (2026-09-25), so it has a TERM - the same one the
// weekly classes beside it have - and needs no cycle, no week number and no
// session type. ensureCampCycle, deriveSessionType and their mondayOf/fridayOf
// helpers went with the camp_sessions write that was their only caller.
//
// What is left is genuinely shared, and by two DIFFERENT eras on purpose: the
// weekday list and its toggle are used by the new builder AND by the SU26 camp
// board's editor, which still edits the historical camp_sessions rows.

// The weekdays a camp can run, LOWERCASE. That is what programs.class_days
// stores (there is a CHECK constraint) and what camp_sessions.class_days stored
// before it, and it is what the pay cron matches on. Shared so the two camp
// forms cannot drift - programs.day_of_week is Title-Case and the two columns
// genuinely disagree, which is exactly the kind of difference that gets "tidied
// up" into a bug.
export const CAMP_WEEKDAYS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
];

/**
 * HOW LONG A CAMP DAY IS - and therefore which tenant_pay_rates cell each of
 * its days pays at.
 *
 * TWO CHOICES, NOT THREE. Jessica, 2026-09-30: "should just be half day or full
 * day - doesn't matter if it's morning or afternoon." She is describing what
 * the product already does: Pay rates (PayRatesSettings.jsx) has ONE "Half day"
 * box per role and writes the same amount to the morning AND afternoon cells,
 * and every org that has camp rates configured has them equal. Asking which
 * half of the day it is buys nothing and costs an answer.
 *
 * SO "HALF DAY" IS STORED AS 'morning'. That is not a claim the camp runs in
 * the morning - it is the cell the Half day box drives, and the rates screen
 * keeps morning and afternoon in lockstep (it upserts and deletes them
 * together), so the rate resolves the same either way. Nothing may "tidy" an
 * afternoon camp into 'afternoon' on the strength of its start time: that is a
 * second spelling of one rule, and the next person to read the column would
 * have to know which forms mean it literally.
 *
 * Anything that SHOWS a session_type to an operator labels morning and
 * afternoon as "Half day" for the same reason - Payroll does, and so does the
 * rates screen.
 *
 * The SU26 camp editor (CampSessionForm) deliberately does NOT use this list.
 * It edits historical camp_sessions rows where morning and afternoon are real,
 * recorded data about camps that actually ran, and rewriting that history to
 * fit a simpler question would be a lie about 51 rows.
 *
 * 'after_school' is the fourth cell on the rate card and is deliberately not
 * here: it is what a weekly class pays, and a camp is never offered it.
 */
export const CAMP_DAY_LENGTHS = [
  { value: "morning", label: "Half day" },
  { value: "full_day", label: "Full day" },
];

/**
 * Turn a day on or off, keeping the canonical Mon-Fri order.
 *
 * Written out separately in two forms before this, and the two copies had already
 * diverged: one was fixed to stop the add branch DELETING days it has no button
 * for (a weekend camp storing 'saturday' lost it on the first click, and with it
 * that day's pay and its share of a refund), the other still rebuilt from the
 * weekday list. Both write the same column, read by the same cron.
 */
export function toggleCampDay(days, day) {
  const list = Array.isArray(days) ? days : [];
  if (list.includes(day)) return list.filter((d) => d !== day);
  const order = CAMP_WEEKDAYS.map((d) => d.value);
  const rank = (d) => (order.indexOf(d) === -1 ? order.length : order.indexOf(d));
  return [...list, day].sort((a, b) => rank(a) - rank(b));
}

// Mon-Fri weeks inside a date range. Still used by the schedule board's New Cycle
// modal (Schedule.jsx), which lays the historical SU26 camps out week by week -
// a cycle built there and a cycle built anywhere else must agree about what
// "week 3" means, or a camp lands in the wrong column.
export function computeWeeks(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  const cursor = new Date(start);
  const dow = cursor.getDay(); // 0=Sun, 1=Mon, ...
  const daysToMon = (1 - dow + 7) % 7;
  cursor.setDate(cursor.getDate() + daysToMon);

  const weeks = [];
  let num = 1;
  while (cursor <= end) {
    const wStart = new Date(cursor);
    const wEnd = new Date(cursor);
    wEnd.setDate(wEnd.getDate() + 4);
    if (wEnd > end) break;
    weeks.push({
      num,
      starts_on: wStart.toISOString().slice(0, 10),
      ends_on: wEnd.toISOString().slice(0, 10),
    });
    num++;
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

/**
 * Is `v` a day length a CAMP may legitimately be stored with?
 *
 * Wider than CAMP_DAY_LENGTHS on purpose. That list is what the builder OFFERS
 * for a new camp; this is what the database already HOLDS. 'afternoon' is a
 * valid session_type, pays exactly what 'morning' pays (Pay rates has one Half
 * day box per role that writes both cells), and prod has an OPEN camp using it.
 *
 * Validating an existing camp against the offer list instead of this made that
 * camp uneditable: the picker had no option matching 'afternoon', so it showed
 * blank, and the save guard then refused the only value the row had. An
 * operator could not change its price without first being made to re-answer a
 * question - and the obvious answer, "Half day", would have silently rewritten
 * recorded data about a camp that is already selling.
 *
 * 'after_school' is excluded deliberately: it is what a weekly class pays, and
 * a camp priced at it is the money bug this column was added to stop.
 */
export function isCampDayLength(v) {
  return v === "morning" || v === "afternoon" || v === "full_day";
}

/**
 * The options to render for a camp whose stored day length is `stored`.
 *
 * Normally the two the builder offers. When the row holds 'afternoon' - which
 * no longer has its own question - it gains an entry so the select SHOWS "Half
 * day" and round-trips unchanged if the operator does not touch it. Picking
 * "Half day" from the list still writes 'morning', because that is then a
 * deliberate answer rather than a silent migration, and the two pay the same.
 */
export function campDayLengthOptions(stored) {
  if (stored === "afternoon") {
    return [{ value: "afternoon", label: "Half day" }, ...CAMP_DAY_LENGTHS.filter((t) => t.value !== "morning")];
  }
  return CAMP_DAY_LENGTHS;
}
