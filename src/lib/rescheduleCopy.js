// The words for "Reschedule a session", in one place.
//
// Wording approved by Jessica on 2026-10-07 (the "reschedule" drafts in chat),
// with her standing rules: NEVER the word "cancel" in anything a person reads,
// no em dashes in an email she sends, proper capitals. rescheduleCopy.test.mjs
// enforces all three on every string this file can produce.
//
// Families get HTML for Message families, which resolves {{parent_first_name}},
// {{program_name}}, {{program_location}} and {{org_name}} per recipient on the
// server. Instructors get plain text for notify-instructor-removed, which sends
// exactly what it is given, so names are filled in here.

import { formatCalendarDate } from "./programSchedule.js";

// "Monday, October 19". formatCalendarDate is the one parser for calendar
// dates (local midnight, rejects rolled-over dates); anything it cannot read
// is returned as given rather than printed as a confident wrong day.
export function longDate(iso) {
  return formatCalendarDate(iso, { weekday: "long", month: "long", day: "numeric" }) ?? (iso ?? "");
}

// "Oct 19", for subjects.
export function shortDate(iso) {
  return formatCalendarDate(iso, { month: "short", day: "numeric" }) ?? (iso ?? "");
}

const p = (s) => `<p>${s}</p>`;

// What families read when a day comes off the schedule.
//   makeup  - true: a make-up week was added at the end; lastDate is the new last day.
//   nextDate - the next class after the skipped day (no make-up case).
export function familyRescheduledDraft({ date, makeup, lastDate, nextDate }) {
  if (makeup) {
    return {
      subject: `{{program_name}} on ${longDate(date)} is rescheduled`,
      bodyHtml: [
        p("Hi {{parent_first_name}},"),
        p(`We're rescheduling {{program_name}} at {{program_location}} on ${longDate(date)}. We've added a make-up session at the end, so your child still gets every class!`),
        lastDate ? p(`The last day is now ${longDate(lastDate)}.`) : "",
        p("If you added class dates to your calendar, please update those two days."),
        p("Thank you for understanding!<br>{{org_name}}"),
      ].join(""),
    };
  }
  return {
    subject: `No {{program_name}} on ${longDate(date)}`,
    bodyHtml: [
      p("Hi {{parent_first_name}},"),
      p(`Just a heads up: there's no {{program_name}} at {{program_location}} on ${longDate(date)}. We're sorry for the change!`),
      nextDate
        ? p(`Class picks back up on ${longDate(nextDate)}, and everything else stays the same.`)
        : p("Everything else stays the same."),
      p("If you added class dates to your calendar, please update that one day."),
      p("Thank you for understanding!<br>{{org_name}}"),
    ].join(""),
  };
}

// What families read when the day is put back.
//   previousLastDate - when a make-up had been added, the original last day it returns to.
export function familyBackOnDraft({ date, makeup, previousLastDate }) {
  return {
    subject: `{{program_name}} is back on for ${longDate(date)}`,
    bodyHtml: [
      p("Hi {{parent_first_name}},"),
      p(`Good news! {{program_name}} at {{program_location}} is back on for ${longDate(date)}. Please disregard our earlier note.`),
      makeup && previousLastDate ? p(`That means the last day goes back to ${longDate(previousLastDate)}.`) : "",
      p("See you there!<br>{{org_name}}"),
    ].join(""),
  };
}

// What the lead instructor reads. Plain text: notify-instructor-removed sends
// body_text as-is.
export function instructorRescheduledDraft({ firstName, className, school, date, makeup, lastDate, nextDate, senderName }) {
  const where = school ? ` at ${school}` : "";
  const lines = [
    `Hi ${firstName || "there"},`,
    "",
    `There's no ${className}${where} on ${longDate(date)}, so you're off that day. It's been taken off your schedule.`,
    "",
  ];
  if (makeup && lastDate) lines.push(`We've added a make-up session at the end, so your last day is now ${longDate(lastDate)}.`, "");
  else if (!makeup && nextDate) lines.push(`Your next class is ${longDate(nextDate)}.`, "");
  lines.push("Thanks!", senderName || "");
  // Date first: class names often carry their own colon ("Robotics Explorers:
  // Build and Mold"), so "{class}: schedule change" read as a chain of colons.
  return {
    subject: `Schedule change for ${shortDate(date)} - ${className}`,
    bodyText: lines.join("\n").trim(),
  };
}

export function instructorBackOnDraft({ firstName, className, school, date, makeup, previousLastDate, senderName }) {
  const where = school ? ` at ${school}` : "";
  const lines = [
    `Hi ${firstName || "there"},`,
    "",
    `Good news! ${className}${where} is back on for ${longDate(date)}, so please keep that day.`,
    "",
  ];
  if (makeup && previousLastDate) lines.push(`That means your last day goes back to ${longDate(previousLastDate)}.`, "");
  lines.push("Thanks!", senderName || "");
  return {
    subject: `${className}${where} is back on for ${shortDate(date)}`,
    bodyText: lines.join("\n").trim(),
  };
}
