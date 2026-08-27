// Pure helpers for the weekday time grid on the after-school availability form.
//
// Extracted from the component so the selection rules can be tested. The
// formatting is the boring half; planTimeCopy is the half that can be wrong, and
// wrong here means a button that claims to have changed days it did not touch —
// or worse, one that sits there doing nothing.
//
// Why any of this exists: Jeff's team filled this form in on a phone on
// 2026-08-26 and asked for the first day's times to repeat, because five
// weekdays times two fields is up to ten passes through a native time wheel for
// an answer that is usually identical every day.

import { to12hText } from './timeText.js';

// Which day to copy FROM, and which days would actually CHANGE.
//
// Source is the FIRST available weekday that has a start time — not "Monday".
// Plenty of instructors do not work Mondays, and a button offering to copy a day
// they marked unavailable is nonsense. Everything is keyed off `days` rather
// than a hardcoded list so the caller stays the single source of weekday order.
//
// Targets EXCLUDE days that already match, so the confirmation can name what it
// did without overstating it, and so the button can hide itself when pressing it
// would be a no-op. A present-but-inert control is the defect class this
// codebase has already paid for on the registration form.
export function planTimeCopy(week, days) {
  const list = Array.isArray(days) ? days : [];
  const source = list.find((d) => week?.[d.value]?.available && week?.[d.value]?.from) ?? null;
  if (!source) return { source: null, targets: [] };
  const src = week[source.value];
  const targets = list.filter((d) => {
    if (d.value === source.value) return false;
    const w = week?.[d.value];
    if (!w?.available) return false;
    return w.from !== src.from || w.until !== src.until;
  });
  return { source, targets };
}

// Apply the plan. Returns a NEW week object; never mutates.
//
// Overwrites rather than filling only the blanks. "Repeat my times" is what was
// asked for, it is a deliberate press, every field stays editable afterwards —
// and a fill-blanks-only version would silently skip the day someone got wrong,
// which is the day they most wanted fixed.
//
// `available` is carried through untouched: copying times must never turn a day
// on. Which days someone works is a different answer from what hours they work.
export function applyTimeCopy(week, source, targets) {
  if (!source || !targets?.length) return week;
  const src = week[source.value];
  const next = { ...week };
  for (const d of targets) {
    next[d.value] = { ...week[d.value], from: src.from, until: src.until };
  }
  return next;
}

// "available from 2:00 PM" / "2:00 PM to 7:00 PM".
//
// Reads as a sentence because it is used inside two of them. A start with no
// finish is the NORMAL case on this form — "until" is explicitly optional — so
// it must not render as a broken range ("2:00 PM to").
export function timeWindowLabel(w) {
  const from = to12hText(w?.from || '');
  const until = to12hText(w?.until || '');
  if (!from) return 'not set yet';
  return until ? `${from} to ${until}` : `available from ${from}`;
}

// ["Tuesday"] -> "Tuesday"
// ["Tuesday","Wednesday"] -> "Tuesday and Wednesday"
// three or more -> "Tuesday, Wednesday and Thursday"
//
// The confirmation names the days it changed, and is read by someone checking
// whether it did what they meant. A trailing "Wednesday, Thursday" with no
// conjunction reads as truncated.
export function listSentence(items) {
  const xs = (items ?? []).filter(Boolean);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
