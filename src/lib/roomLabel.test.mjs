// Pins roomDisplay, the one rule every after-school surface now uses to show a
// room. Two behaviours are load-bearing and both were real bugs on 2026-08-25:
// the CLASS room must beat the SITE room (or an after-school instructor at Happy
// Valley Library is sent to the summer camp room), and the word "Room" must not
// be printed in front of a value that already names a place (the portal shipped
// "Room Room 104" to staging before this existed).
//
// Every literal below is a value that is actually in the live J2S data.

import { roomDisplay } from './roomLabel.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`); }
}

// --- precedence: the class wins -------------------------------------------
eq('class room beats site room', roomDisplay('Community Room A', 'Community Room B'), 'Community Room A');
eq('site room is the fallback', roomDisplay(null, 'Community Room B'), 'Community Room B');
eq('site room used when class room is empty string', roomDisplay('', 'Kindergarten room'), 'Kindergarten room');
eq('site room used when class room is whitespace', roomDisplay('   ', 'Kindergarten room'), 'Kindergarten room');
eq('nothing anywhere is null, not a stray label', roomDisplay(null, null), null);
eq('both blank is null', roomDisplay('', '  '), null);

// --- wording: say "Room" once, or not at all ------------------------------
eq('bare number gets the word', roomDisplay('9', null), 'Room 9');
eq('multi-digit number gets the word', roomDisplay('203', null), 'Room 203');
eq('value that already says Room is left alone', roomDisplay('Room 111', null), 'Room 111');
eq('a named place is left alone', roomDisplay('Makerspace', null), 'Makerspace');
eq('Stage is not "Room Stage"', roomDisplay('Stage', null), 'Stage');
eq('Kindy Tables is left alone', roomDisplay('Kindy Tables', null), 'Kindy Tables');
eq('letter-led room code is left alone', roomDisplay('C102', null), 'C102');
eq('Computer Lab from a site row is left alone', roomDisplay(null, 'Computer Lab'), 'Computer Lab');

// --- trimming and non-string input ----------------------------------------
eq('trims a padded class room', roomDisplay('  9  ', null), 'Room 9');
eq('trims a padded site room', roomDisplay(null, '  Makerspace '), 'Makerspace');
eq('undefined behaves like null', roomDisplay(undefined, undefined), null);
// A number out of a jsonb payload must not crash the label.
eq('numeric input is coerced, not thrown', roomDisplay(4, null), 'Room 4');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exitCode = 1;
