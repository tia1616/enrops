// Pins the time helpers behind the early-release window.
//
// Jessica, 14 Aug: "it can't just say 'early release 12:45'. it has to say class
// today is 12:45-1:45." So the END time has to be right, and it is DERIVED from
// the class's usual length rather than typed — which means an arithmetic bug
// here puts a wrong collection time in front of a parent.
//
// The corpus is mixed on purpose: program times are TEXT and real rows hold both
// "2:35 PM" and "14:35". Every helper is tested against both.

import { formatTimeText, formatTimeRange, to24h, to12hText, durationMinutes, addMinutes24h } from './timeText.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name} — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`); }
}

// --- duration, both stored formats ------------------------------------------
eq('12-hour pair', durationMinutes('2:35 PM', '3:35 PM'), 60);
eq('24-hour pair', durationMinutes('14:35', '15:35'), 60);
eq('mixed pair', durationMinutes('2:35 PM', '15:35'), 60);
eq('45-minute class', durationMinutes('3:20 PM', '4:05 PM'), 45);
eq('90-minute class', durationMinutes('2:05 PM', '3:35 PM'), 90);

// A backwards or absent pair must yield null, NOT a negative number that would
// then be added to a start time and produce an end before the beginning.
eq('backwards is null', durationMinutes('3:35 PM', '2:35 PM'), null);
eq('same time is null', durationMinutes('2:35 PM', '2:35 PM'), null);
eq('missing end is null', durationMinutes('2:35 PM', null), null);
eq('missing start is null', durationMinutes('', '3:35 PM'), null);
eq('junk is null', durationMinutes('afternoon', '3:35 PM'), null);

// --- adding minutes ---------------------------------------------------------
eq('the case Jessica named', addMinutes24h('12:45', 60), '13:45');
eq('crosses the hour', addMinutes24h('12:45', 45), '13:30');
eq('lands on the hour', addMinutes24h('13:15', 45), '14:00');
// Refuses to wrap past midnight: wrapping would put the end BEFORE the start.
eq('does not wrap midnight', addMinutes24h('23:30', 60), '');
eq('no time in, nothing out', addMinutes24h('', 60), '');
eq('no minutes in, nothing out', addMinutes24h('12:45', null), '');

// --- the end-to-end derivation the screens actually do ----------------------
{
  const mins = durationMinutes('2:35 PM', '3:35 PM'); // the class's usual length
  eq('12:45 start on a 60-minute class ends 1:45', addMinutes24h('12:45', mins), '13:45');
  eq('and reads back as a window', formatTimeRange('12:45 PM', to12hText('13:45')), '12:45pm–1:45pm');
}

// --- the range string -------------------------------------------------------
eq('both ends', formatTimeRange('12:45 PM', '1:45 PM'), '12:45pm–1:45pm');
eq('24-hour in, 12-hour out', formatTimeRange('12:45', '13:45'), '12:45pm–1:45pm');
// KNOWN INCONSISTENCY, pinned rather than fixed: formatTimeText passes 12-hour
// input through verbatim and only trims ":00" when it parses a 24-hour value.
// So the same o'clock reads "1:00pm" from a "1:00 PM" row and "1pm" from a
// "13:00" one. Cosmetic, and the function is shared with three other screens, so
// changing it is its own change with its own blast radius.
eq('12-hour on the hour keeps :00', formatTimeRange('1:00 PM', '2:00 PM'), '1:00pm–2:00pm');
eq('24-hour on the hour drops :00', formatTimeRange('13:00', '14:00'), '1pm–2pm');
// No end -> the start alone, never a dangling dash.
eq('start only', formatTimeRange('12:45 PM', null), '12:45pm');
eq('start only, empty end', formatTimeRange('12:45 PM', ''), '12:45pm');
eq('nothing at all', formatTimeRange(null, null), '');

// --- the round trip a save performs -----------------------------------------
eq('input value -> stored text', to12hText('13:45'), '1:45 PM');
eq('stored text -> input value', to24h('1:45 PM'), '13:45');
eq('round trip is stable', to24h(to12hText('12:45')), '12:45');
eq('already-12h passes through', to12hText('2:35 PM'), '2:35 PM');
eq('midnight reads as 12 AM', to12hText('00:15'), '12:15 AM');
eq('noon reads as 12 PM', to12hText('12:15'), '12:15 PM');
eq('formatTimeText handles noon', formatTimeText('12:15'), '12:15pm');
eq('formatTimeText handles midnight', formatTimeText('00:15'), '12:15am');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
