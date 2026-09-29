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
