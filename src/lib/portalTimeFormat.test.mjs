// src/lib/portalTimeFormat.test.mjs
//
// THE INVARIANT: a stored class time never reaches an instructor as "NaN".
//
// WHY THIS EXISTS. Program times are TEXT and the corpus is mixed -- old forms
// wrote "2:35 PM", an <input type="time"> writes "14:35". A formatter that only
// splits on ":" turns "2:35 PM" into Number("35 PM") = NaN and prints "2:NaNam".
// On prod, 127 of 127 programs store the 12-hour form, so such a formatter is
// wrong for every after-school class there is.
//
// This has now been found THREE times, each time in a different copy of the same
// four-line function:
//
//   2026-08-25  the sub-assignment card in InstructorPortal.jsx -- a sub covering
//               a class could not see what time to turn up. Fixed by adding
//               fmtTimePretty NEXT TO the broken fmtTime, leaving both.
//   (earlier)   admin/AfterschoolSchedule.jsx, which has always handled both
//               because it is the screen that displays programs.
//   2026-09-15  the after-school rows on the instructor's own PAY screen, which
//               still called the old fmtTime. Found while fixing something else.
//
// The fix each time was to teach one more copy about 12-hour text. The reason it
// keeps coming back is that there are copies to teach: src/lib/timeText.js says
// so in its own header, and asks new code to import formatTimeText instead.
//
// WHAT THIS CHECKS
//   1. formatTimeText never yields NaN for anything the database can hold
//   2. InstructorPortal.jsx defines NO local time formatter -- it must import the
//      shared one, so there is no copy left to feed a program time into
//
//   3. the three camp screens that used to hold 24-hour-only copies still hold
//      none: admin/Schedule.jsx (board + the schedule EMAIL) and
//      admin/SchedulePrint.jsx
//
// WHAT THIS DOES NOT CHECK. Two local copies remain, both with their own 12-hour
// branches and therefore not of this bug class: admin/ProgramRoster.jsx and
// portal/Dashboard.jsx. InstructorPortal's own fmtTimePretty also stays, because
// its two call sites render a ":00" time as "2pm" where formatTimeText renders
// "2:00pm"; collapsing it is a display change nobody asked for. None of the three
// can produce NaN, which is what this file is about.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimeText } from './timeText.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// 1 — behavioural. Both stored shapes, every hour and minute, plus the junk a
// text column can legitimately contain.
ok('formatTimeText never produces NaN for any storable time', () => {
  const bad = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const h12 = ((h + 11) % 12) + 1;
      const mer = h >= 12 ? 'PM' : 'AM';
      for (const v of [`${hh}:${mm}`, `${hh}:${mm}:00`, `${h12}:${mm} ${mer}`, `${h12}:${mm}${mer}`]) {
        const out = formatTimeText(v);
        if (String(out).includes('NaN')) bad.push(`${v} -> ${out}`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} inputs produced NaN`);
});

ok('the exact prod value that was breaking now formats', () => {
  // "2:35 PM" is what every J2S after-school program stores.
  assert.equal(formatTimeText('2:35 PM'), '2:35pm');
  assert.equal(formatTimeText('14:35:00'), '2:35pm', 'camp times must be unchanged');
});

ok('unparseable text is returned as typed, never as NaN', () => {
  // An unreadable time is bad; an invented one is worse.
  assert.equal(formatTimeText('sometime after lunch'), 'sometime after lunch');
  assert.equal(formatTimeText(''), '');
  assert.equal(formatTimeText(null), '');
});

// 2 — structural. The portal must have no copy of its own to get this wrong in.
ok('InstructorPortal.jsx defines no local time formatter', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '..', 'pages', 'portal', 'InstructorPortal.jsx'), 'utf8');

  // Strip comments first: this file DISCUSSES fmtTime in prose, and a naive grep
  // would match its own explanation -- the "grep that lies" mistake.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  assert.ok(/import \{[^}]*\bformatTimeText\b[^}]*\} from ["']\.\.\/\.\.\/lib\/timeText\.js["']/.test(code),
    'must import formatTimeText from the shared module');
  assert.ok(!/function\s+fmtTime\s*\(/.test(code),
    'the 24-hour-only fmtTime is back; use formatTimeText');

  // Any surviving local formatter must at least have a 12-hour branch. fmtTimePretty
  // does; it is left in place because its two call sites render ":00" times as "2pm"
  // where formatTimeText renders "2:00pm", and changing that is not this fix.
  const locals = [...code.matchAll(/function\s+(fmt\w*Time\w*)\s*\(([\s\S]*?)\n\}/g)];
  for (const [, name, body] of locals) {
    assert.ok(/[ap]\s*\\?s?\*?m/i.test(body) || /Number\.isNaN/.test(body),
      `${name} splits a time with no 12-hour branch and no NaN guard`);
  }
});

// 3 — the camp screens. These read camp_sessions, whose start_time is a Postgres
// `time`, so their old 24-hour-only formatters were correct for today's data and
// wrong only in waiting. Each is pinned so the copy cannot come back.
for (const rel of [
  ['pages', 'admin', 'Schedule.jsx'],
  ['pages', 'admin', 'SchedulePrint.jsx'],
]) {
  const name = rel[rel.length - 1];
  ok(`${name} defines no local time formatter`, () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const code = readFileSync(join(here, '..', ...rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    assert.ok(/\bformatTimeText\b/.test(code), 'must use formatTimeText');
    // Any function whose body splits a time on ":" and maps Number is the shape
    // that NaNs on "2:35 PM". Named generously so a rename does not dodge it.
    const locals = [...code.matchAll(/function\s+(\w*[Ff]mt\w*[Tt]ime\w*)\s*\(([\s\S]*?)\n\}/g)];
    for (const [, fn, body] of locals) {
      assert.ok(!/split\(["']:["']\)/.test(body) || /Number\.isNaN/.test(body) || /[ap]m/i.test(body),
        `${fn} splits a time with no 12-hour branch and no NaN guard - import formatTimeText instead`);
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
