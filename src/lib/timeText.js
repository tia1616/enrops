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
