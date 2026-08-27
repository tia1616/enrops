// Pins normalizePreferredName, and the display rule it has to agree with.
//
// This exists because of a real report: Jeff's team onboarded eight instructors
// on 2026-08-26 and came back saying the nickname had "automatically" become the
// legal name. Nothing copies it — the question simply reads as "what is your
// name?", so someone called Lana answers "Lana". The rule now is that such an
// answer stores nothing, and the invariant that makes it safe is the last group
// below: normalising NEVER changes what anybody sees.

import { normalizePreferredName, displayFirstName, displayFullName } from './instructorName.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
const eq = (name, actual, expected) =>
  ok(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);

// --- a real preference is kept -------------------------------------------
eq('Rebecca -> Bo is a real preference', normalizePreferredName('Bo', 'Rebecca'), 'Bo');
eq('Liberty -> Quin is a real preference', normalizePreferredName('Quin', 'Liberty'), 'Quin');
eq('Liam -> Sky is a real preference', normalizePreferredName('Sky', 'Liam'), 'Sky');
eq('trims a kept value', normalizePreferredName('  Bo  ', 'Rebecca'), 'Bo');
// A middle name, a shortened surname, anything that is not the first name: kept.
eq('a different name that contains the first name is kept',
  normalizePreferredName('Lana-Rose', 'Lana'), 'Lana-Rose');

// --- the legal first name is not a preference ----------------------------
// The three prod rows that prompted this, by name, so a regression names itself.
eq('Lana / Lana stores nothing', normalizePreferredName('Lana', 'Lana'), '');
eq('Zach / Zach stores nothing', normalizePreferredName('Zach', 'Zach'), '');
eq('Chelsea / Chelsea stores nothing', normalizePreferredName('Chelsea', 'Chelsea'), '');
eq('surrounding space does not rescue it', normalizePreferredName('  Lana ', 'Lana'), '');
eq('space on the legal side does not rescue it', normalizePreferredName('Lana', ' Lana '), '');

// --- a DIFFERENT case is a different name, and is kept -------------------
// Deliberately not normalised away. Clearing it would make displayFirstName
// return 'Zach' where it used to return 'zach' — a rename dressed up as a
// clean-up. The invariant group at the bottom is what enforces this.
eq('lower case is kept', normalizePreferredName('zach', 'Zach'), 'zach');
eq('upper case is kept', normalizePreferredName('LANA', 'Lana'), 'LANA');

// --- blank in, blank out --------------------------------------------------
eq('empty stays empty', normalizePreferredName('', 'Lana'), '');
eq('whitespace only is empty', normalizePreferredName('   ', 'Lana'), '');
eq('null is empty', normalizePreferredName(null, 'Lana'), '');
eq('undefined is empty', normalizePreferredName(undefined, 'Lana'), '');

// --- a missing legal name must not swallow the preference ----------------
// The admin form can be mid-edit with the legal name cleared. Losing the
// nickname because the other box is momentarily blank would be a silent delete.
eq('no first name: the preference survives', normalizePreferredName('Bo', ''), 'Bo');
eq('null first name: the preference survives', normalizePreferredName('Bo', null), 'Bo');
eq('undefined first name: the preference survives', normalizePreferredName('Bo', undefined), 'Bo');

// --- "Jennifer or Jen" ----------------------------------------------------
// Still stored, deliberately. It is not the legal first name, so this function
// has no opinion on it — the wording change is what stops it being typed, and
// an operator cleans up the ones already there. Pinned so nobody "fixes" it
// here later and starts guessing at which half of an answer someone meant.
eq('a conversational answer is NOT silently rewritten',
  normalizePreferredName('Jennifer or Jen', 'Jennifer'), 'Jennifer or Jen');

// --- the invariant that makes all of the above safe ----------------------
// Normalising must never change what a human reads. If this group ever fails,
// clearing the column stopped being a no-op and the fix became a rename.
for (const [first, typed] of [
  ['Lana', 'Lana'], ['Zach', 'zach'], ['Chelsea', ' Chelsea '], ['Rose', 'ROSE'],
]) {
  const before = displayFirstName({ first_name: first, preferred_name: typed });
  const after = displayFirstName({
    first_name: first,
    preferred_name: normalizePreferredName(typed, first) || null,
  });
  eq(`display is unchanged by normalising ${JSON.stringify(typed)}`, after, before);
}
eq('full name is unchanged by normalising',
  displayFullName({ first_name: 'Lana', last_name: 'Chong', preferred_name: null }),
  displayFullName({ first_name: 'Lana', last_name: 'Chong', preferred_name: 'Lana' }));

// A kept preference still wins the display, which is the whole point of the column.
eq('a kept preference still drives the display',
  displayFirstName({ first_name: 'Rebecca', preferred_name: normalizePreferredName('Bo', 'Rebecca') }),
  'Bo');
eq('a cleared one falls back to the legal first name',
  displayFirstName({ first_name: 'Lana', preferred_name: normalizePreferredName('Lana', 'Lana') || null }),
  'Lana');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
