// Pins the instructor header's summary line.
//
// The expression this replaced read:
//   You have {camps + classes} {classes > 0 && camps === 0 ? "class(es)" : "camp(s)"}
// which is two branches covering four cases. Three of the four were wrong for a
// provider who does not run camps:
//   - nothing assigned        -> "You have 0 camps on your schedule"
//   - camps and classes       -> everything counted as camps
//   - camps only              -> correct, by luck
// Reported 2026-08-26 by Jeff's tester, whose org runs after-school classes and
// had just been told she had "0 camps".
//
// These assertions are what stop it being folded back into one clever ternary.

import { scheduleCountLine } from './scheduleCountLine.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`PASS  ${name} (got ${JSON.stringify(actual)})`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
}

// --- the case that was reported -------------------------------------------
eq('empty schedule says nothing at all', scheduleCountLine(0, 0, 0), '');
eq('empty schedule is empty even with a stray awaiting count',
  scheduleCountLine(0, 0, 3), '');

// --- one kind only ---------------------------------------------------------
eq('classes only', scheduleCountLine(3, 0, 0),
  'You have 3 classes on your schedule.');
eq('one class is singular', scheduleCountLine(1, 0, 0),
  'You have 1 class on your schedule.');
eq('camps only', scheduleCountLine(0, 4, 0),
  'You have 4 camps on your schedule.');
eq('one camp is singular', scheduleCountLine(0, 1, 0),
  'You have 1 camp on your schedule.');

// --- both kinds: the case the old code called "camps" ----------------------
eq('both kinds are named separately', scheduleCountLine(2, 3, 0),
  'You have 2 classes and 3 camps on your schedule.');
eq('both kinds, both singular', scheduleCountLine(1, 1, 0),
  'You have 1 class and 1 camp on your schedule.');

// --- awaiting tail ---------------------------------------------------------
eq('awaiting is appended', scheduleCountLine(3, 0, 2),
  'You have 3 classes on your schedule · 2 awaiting your response.');
eq('awaiting rides along with both kinds', scheduleCountLine(1, 2, 1),
  'You have 1 class and 2 camps on your schedule · 1 awaiting your response.');

// --- defensive: the counts arrive from .length, but be explicit ------------
eq('undefined counts are treated as zero', scheduleCountLine(undefined, undefined, undefined), '');
eq('null counts are treated as zero', scheduleCountLine(null, null, null), '');

console.log(fail === 0 ? `\nALL PASS  (${pass} passed, 0 failed)` : `\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
