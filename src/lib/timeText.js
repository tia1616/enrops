// Program times are TEXT in the database, not a time type, and the corpus is
// genuinely mixed: rows written by the old forms hold "2:35 PM", rows written
// by an <input type="time"> hold "14:35". Anything that reads a program time
// has to cope with both, and anything that writes one has to pick a side.
//
// THE CANONICAL WRITE FORMAT IS 12-HOUR TEXT ("2:45 PM"). That is what
// ProgramsCalendar's editor already converts back to on save (to12hText), so a
// new writer that stored 24-hour would quietly split the corpus a third way.
//
// KNOWN DUPLICATION, deliberately not refactored here: three copies of a
// formatTime already exist -- ProgramsCalendar.jsx, EditProgramCurriculumModal
// .jsx and ProgramWizardNew.jsx -- and they are NOT identical. ProgramWizardNew's
// assumes 24-hour input and mangles a stored "2:35 PM". This module is the
// version that handles both; new code should import it rather than add a fourth.
// Migrating the existing three is its own change with its own testing, and one
// of those files is large and frequently touched.

// "2:35 PM" or "14:35" -> "2:35pm". Display only.
export function formatTimeText(t) {
  if (!t) return "";
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, "");
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

// "12:45pm-1:45pm", or just the start when no end is known.
//
// A PARENT NEEDS THE WHOLE WINDOW, not the start. Jessica, 14 Aug: "it can't
// just say 'early release 12:45'. it has to say class today is 12:45-1:45."
// A start time alone tells someone when to drop off and leaves them guessing
// the one thing they actually came to the page for -- when to collect.
export function formatTimeRange(startText, endText) {
  const s = formatTimeText(startText);
  if (!s) return "";
  const e = formatTimeText(endText);
  return e ? `${s}–${e}` : s;
}

// "12:45–1:45 PM", collapsing the meridiem when both ends share one, and
// keeping both when they don't ("11:45 AM–1:15 PM"). Upper-case AM/PM, because
// this reads as a real clock time to a parent rather than a code comment.
export function formatClockRange(startText, endText) {
  const s24 = to24h(startText);
  const e24 = to24h(endText);
  const say = (hhmm, withMeridiem) => {
    const [h, m] = hhmm.split(":").map(Number);
    const hr12 = ((h + 11) % 12) + 1;
    const mer = h >= 12 ? "PM" : "AM";
    return `${hr12}:${String(m).padStart(2, "0")}${withMeridiem ? ` ${mer}` : ""}`;
  };
  if (!s24) return "";
  if (!e24) return say(s24, true);
  const sameHalf = (Number(s24.split(":")[0]) >= 12) === (Number(e24.split(":")[0]) >= 12);
  return sameHalf ? `${say(s24, false)}–${say(e24, true)}` : `${say(s24, true)}–${say(e24, true)}`;
}

// THE one sentence every surface shows for a kept early-release date.
//
// Jessica's wording, 14 Aug: "it needs to say 'Early Release - Class is
// 12:45-1:45 on this date'." — and she asked for it on the PROVIDER and
// INSTRUCTOR screens too, not just the parent's. So it lives here and all three
// import it; three hand-written copies of a sentence is how they end up saying
// three different things, which is the bug she has already caught twice today.
//
// "on this date" is load-bearing: without it the line reads like the class's
// normal time, which is the exact confusion the whole feature exists to remove.
export function earlyReleaseLine(startText, endText) {
  const range = formatClockRange(startText, endText);
  if (!range) return "Early Release";
  const verb = to24h(endText) ? "Class is" : "Class starts";
  return `Early Release — ${verb} ${range} on this date`;
}

// Minutes between two stored times, or null when either is unparseable.
export function durationMinutes(startText, endText) {
  const s = to24h(startText);
  const e = to24h(endText);
  if (!s || !e) return null;
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  // A class never runs backwards or crosses midnight. Anything else is bad data
  // and must not silently become a negative or day-long duration.
  return mins > 0 && mins < 24 * 60 ? mins : null;
}

// "12:45" + 60 -> "13:45", as an <input type="time"> value. Clamps rather than
// wrapping past midnight: an after-school class that would run to 00:15 is bad
// input, and wrapping would put the end BEFORE the start.
export function addMinutes24h(hhmm, mins) {
  if (!hhmm || !Number.isFinite(mins)) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const total = h * 60 + m + mins;
  if (total >= 24 * 60 || total < 0) return "";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Stored text -> "HH:MM" for an <input type="time">. Returns "" for anything
// unparseable, which leaves the input empty rather than showing a broken value.
export function to24h(t) {
  if (!t || typeof t !== "string") return "";
  const ampm = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])[Mm]\s*$/.exec(t);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (ampm[3].toLowerCase() === "p") h += 12;
    return `${String(h).padStart(2, "0")}:${ampm[2]}`;
  }
  const hhmm = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
  if (hhmm) return `${String(parseInt(hhmm[1], 10)).padStart(2, "0")}:${hhmm[2]}`;
  return "";
}

// An <input type="time"> value -> the canonical stored format.
export function to12hText(t) {
  if (!t || typeof t !== "string") return t;
  if (/[ap]m/i.test(t)) return t;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
  if (!m) return t;
  const h = parseInt(m[1], 10);
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${m[2]} ${ampm}`;
}
