// Pins the repeat-times rules for the after-school availability form.
//
// The button's label, whether it renders at all, what it writes and what the
// confirmation claims all read planTimeCopy. If it says three days and touches
// two, the instructor is told their week is set when it is not — and this form
// is how a term gets staffed.

import { planTimeCopy, applyTimeCopy, timeWindowLabel, listSentence } from './weekTimes.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
const eq = (name, a, b) =>
  ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
const eqJ = (name, a, b) =>
  ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
     JSON.stringify(a) === JSON.stringify(b));

const DAYS = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
];
const off = () => ({ available: false, from: '', until: '' });
const on = (from, until = '') => ({ available: true, from, until });
const wk = (o) => ({ mon: off(), tue: off(), wed: off(), thu: off(), fri: off(), ...o });

// --- source selection -----------------------------------------------------
{
  const { source, targets } = planTimeCopy(wk({ mon: on('14:00', '19:00'), tue: on(''), wed: on('') }), DAYS);
  eq('source is the first available day with a start time', source?.value, 'mon');
  eqJ('targets are the other available days', targets.map((d) => d.value), ['tue', 'wed']);
}
{
  // The exact shape from Jeff's team's video: Monday off, later days on.
  const { source, targets } = planTimeCopy(wk({ tue: on('14:00', '20:00'), thu: on('15:00') }), DAYS);
  eq('NOT hardcoded to Monday — skips a day marked unavailable', source?.value, 'tue');
  eqJ('and targets the later day', targets.map((d) => d.value), ['thu']);
}
{
  const { source } = planTimeCopy(wk({ mon: on(''), tue: on('14:00') }), DAYS);
  eq('an available day with NO start time cannot be the source', source?.value, 'tue');
}

// --- when the button must NOT appear --------------------------------------
{
  const { source, targets } = planTimeCopy(wk({}), DAYS);
  eq('no available days: no source', source, null);
  eq('no available days: no targets', targets.length, 0);
}
{
  const { source, targets } = planTimeCopy(wk({ mon: on('14:00', '19:00') }), DAYS);
  eq('exactly one available day: there is a source', source?.value, 'mon');
  eq('exactly one available day: nothing to copy TO', targets.length, 0);
}
{
  const all = wk({ mon: on('14:00', '19:00'), tue: on('14:00', '19:00'), wed: on('14:00', '19:00') });
  const { targets } = planTimeCopy(all, DAYS);
  eq('every day already matches: nothing to change (button hides)', targets.length, 0);
}
{
  // Differs ONLY by finish time — still a change, so still a target. An earlier
  // draft compared start times alone and would have left this day behind while
  // reporting success.
  const { targets } = planTimeCopy(wk({ mon: on('14:00', '19:00'), tue: on('14:00', '20:00') }), DAYS);
  eqJ('a day differing only in its finish time is a target', targets.map((d) => d.value), ['tue']);
}
{
  const { targets } = planTimeCopy(wk({ mon: on('14:00'), tue: on('14:00', '20:00') }), DAYS);
  eqJ('source with no finish, target with one: still a change', targets.map((d) => d.value), ['tue']);
}

// --- applying -------------------------------------------------------------
{
  const before = wk({ mon: on('14:00', '19:00'), tue: on('15:00', '17:00'), wed: on(''), fri: off() });
  const { source, targets } = planTimeCopy(before, DAYS);
  const after = applyTimeCopy(before, source, targets);
  eq('target picks up the start', after.tue.from, '14:00');
  eq('target picks up the finish', after.tue.until, '19:00');
  eq('a target that was blank is filled', after.wed.from, '14:00');
  eq('source is untouched', after.mon.from, '14:00');
  ok('a day that was never a target is not touched at all', after.fri.available === false);
  eq('a day that was never a target gets no times', after.fri.from, '');
  ok('does not mutate the input', before.tue.from === '15:00');
  ok('returns a new object', after !== before);
}
{
  // Copying times must never turn a day ON. Which days you work and what hours
  // you work are different answers, and this button only claims to set hours.
  //
  // Calls applyTimeCopy DIRECTLY with an unavailable day forced into the target
  // list, rather than with a plan from planTimeCopy. Going through the plan
  // cannot exercise this at all — planTimeCopy filters unavailable days out, so
  // the assertion lands on a day the function never touched and passes no matter
  // what applyTimeCopy does. Verified by breaking applyTimeCopy to force
  // `available: true` and watching the plan-based version stay green.
  const before = wk({ mon: on('14:00', '19:00'), tue: on('15:00'), fri: off() });
  const after = applyTimeCopy(before, DAYS[0], [DAYS[1], DAYS[4]]);
  eq('an available target keeps its times updated', after.tue.from, '14:00');
  eq('an available target stays available', after.tue.available, true);
  eq('an UNAVAILABLE day forced into the targets is NOT switched on', after.fri.available, false);
  eq('...and still receives the times, so turning the day on later is correct',
    after.fri.from, '14:00');
}
{
  const before = wk({ mon: on('14:00') });
  eq('applying an empty plan returns the same object', applyTimeCopy(before, null, []), before);
}

// --- the sentences the instructor actually reads --------------------------
eq('window with both ends', timeWindowLabel({ from: '14:00', until: '19:00' }), '2:00 PM to 7:00 PM');
eq('window with a start only reads as a sentence, not a broken range',
  timeWindowLabel({ from: '14:00', until: '' }), 'available from 2:00 PM');
eq('no start at all', timeWindowLabel({ from: '', until: '' }), 'not set yet');
eq('undefined day does not throw', timeWindowLabel(undefined), 'not set yet');
// "until" is optional on this form, so the start-only case is the common one —
// pinned because a broken "2:00 PM to" would reach every instructor who skips it.
ok('start-only never ends with a dangling connector',
  !/\bto\s*$/.test(timeWindowLabel({ from: '09:00', until: '' })));

eq('one day', listSentence(['Tuesday']), 'Tuesday');
eq('two days', listSentence(['Tuesday', 'Wednesday']), 'Tuesday and Wednesday');
eq('three days', listSentence(['Tuesday', 'Wednesday', 'Thursday']), 'Tuesday, Wednesday and Thursday');
eq('empty', listSentence([]), '');
eq('undefined', listSentence(undefined), '');
ok('never ends in a bare comma', !/,\s*$/.test(listSentence(['Tuesday', 'Wednesday'])));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
