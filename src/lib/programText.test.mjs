// Pins the description counter's copy. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// This exists because the counter shipped to prod reading "4 characters." and the
// three call sites rendered it INLINE at the end of the help sentence, so Jessica
// read "...so you can write more than one paragraph. 4 characters." - an
// unfinished sentence rather than a count. The wording is now load-bearing: every
// non-silent state has to open with "Character count:".
import { PROGRAM_DESCRIPTION_MAX, describeDescriptionLength } from './programText.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

const MAX = PROGRAM_DESCRIPTION_MAX;
const str = (n) => 'x'.repeat(n);

// --- the limit itself ------------------------------------------------------
// Not a DB limit - short_description is `text`. This number is the only thing
// enforcing it, in three inputs, so a silent change here is a silent change there.
eq('limit is 2000', MAX, 2000);

// --- silence on an empty field --------------------------------------------
// "0 / 2,000" on an untouched field reads as a demand for 2,000 characters.
eq('empty string says nothing', describeDescriptionLength(''), null);
eq('null says nothing', describeDescriptionLength(null), null);
eq('undefined says nothing', describeDescriptionLength(undefined), null);

// --- every state names itself as a count ----------------------------------
// The actual regression: a state that does not start with "Character count:"
// reads as the tail of whatever sentence precedes it.
for (const [label, len] of [['1 char', 1], ['mid', 800], ['near limit', 1900], ['at limit', MAX]]) {
  const r = describeDescriptionLength(str(len));
  eq(`${label} opens with "Character count:"`, r.text.startsWith('Character count:'), true);
}

// --- the three states ------------------------------------------------------
eq('short count', describeDescriptionLength(str(4)).text, 'Character count: 4.');
eq('short count is not at limit', describeDescriptionLength(str(4)).atLimit, false);
// Thousands separator, because 1540 in a sentence reads as a year.
eq('counts are grouped', describeDescriptionLength(str(1200)).text, 'Character count: 1,200.');

// Below 75% the ceiling is noise; at or above it, "of 2,000" IS the warning.
eq('just below 75% hides the ceiling',
  describeDescriptionLength(str(1499)).text, 'Character count: 1,499.');
eq('exactly 75% names the ceiling',
  describeDescriptionLength(str(1500)).text, 'Character count: 1,500 of 2,000.');
eq('near the limit is still not atLimit',
  describeDescriptionLength(str(1999)).atLimit, false);

eq('at the limit says so',
  describeDescriptionLength(str(MAX)).text, "Character count: 2,000 of 2,000. That's the limit.");
eq('at the limit sets atLimit', describeDescriptionLength(str(MAX)).atLimit, true);
// maxLength stops the browser at MAX, but a paste handled elsewhere or a future
// caller without the attribute must not fall through to the "under" branch.
eq('over the limit still reports at-limit',
  describeDescriptionLength(str(MAX + 50)).atLimit, true);

// --- a caller-supplied max keeps all three states --------------------------
eq('custom max, under', describeDescriptionLength(str(10), 100).text, 'Character count: 10.');
eq('custom max, near', describeDescriptionLength(str(80), 100).text, 'Character count: 80 of 100.');
eq('custom max, at', describeDescriptionLength(str(100), 100).atLimit, true);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
