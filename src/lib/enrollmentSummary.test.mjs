// Pins the seat rule on the programs page.
//
// The number this guards drives the fill bar, the "full" state, and an operator's
// decision about whether to add a seat. A waiting family counted as enrolled would
// show a class as full when it is not; a waiting family counted as pending is the
// bug Jeff reported on the roster the same week.

import { enrolledSeats, enrollmentBreakdown } from './enrollmentSummary.js';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
};
const eq = (name, a, b) =>
  ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);

const E = (paid = 0, unpaid = 0, pending = 0, waiting = 0) => ({ paid, unpaid, pending, waiting });

// --- what counts as a seat --------------------------------------------------
eq('paid is a seat', enrolledSeats(E(12)), 12);
eq('installments are a seat', enrolledSeats(E(10, 2)), 12);
eq('PENDING is not a seat', enrolledSeats(E(10, 2, 5)), 12);
eq('WAITING is not a seat', enrolledSeats(E(10, 2, 0, 6)), 12);
eq('neither is', enrolledSeats(E(10, 2, 5, 6)), 12);
// The case that prompted this: a full class with a queue behind it must read as
// full, not as over-full. Woodstock is 14/14 with 3 waiting.
eq('a full class with a queue is still exactly full', enrolledSeats(E(14, 0, 0, 3)), 14);
// And the inverse: a class with ONLY waiting families has nobody enrolled, so it
// must not render as partly full. Jeff's Richmond had 6 waiting before it filled.
eq('a class with only waiting families has zero enrolled', enrolledSeats(E(0, 0, 0, 6)), 0);

// --- tolerant shape ---------------------------------------------------------
eq('undefined is zero', enrolledSeats(undefined), 0);
eq('empty object is zero', enrolledSeats({}), 0);
eq('a missing waiting key does not poison the sum', enrolledSeats({ paid: 3, unpaid: 1 }), 4);
ok('never returns NaN for a half-loaded shape',
  Number.isFinite(enrolledSeats({ paid: 3, unpaid: undefined, waiting: undefined })));

// --- the line an operator reads ---------------------------------------------
eq('all four, in order',
  enrollmentBreakdown(E(12, 2, 1, 6)),
  '12 paid · 2 on installments · +1 pending · 6 waiting');
eq('waiting appears with no pending',
  enrollmentBreakdown(E(14, 0, 0, 3)), '14 paid · 3 waiting');
eq('pending keeps its plus sign', enrollmentBreakdown(E(3, 0, 2)), '3 paid · +2 pending');
eq('a settled class says only what is true', enrollmentBreakdown(E(14)), '14 paid');
eq('zeros produce no line at all', enrollmentBreakdown(E()), '');
eq('undefined produces no line', enrollmentBreakdown(undefined), '');
// Waiting-only: the class has nobody in it and six families queued. It must still
// say so - this is the state a brand-new full-to-capacity class passes through.
eq('waiting on its own still shows', enrollmentBreakdown(E(0, 0, 0, 6)), '6 waiting');

// --- the two must agree ------------------------------------------------------
// If the breakdown ever mentions a number the count silently folded in, the page
// contradicts itself. Waiting is the one that must appear in the line and NOT in
// the count.
{
  const enr = E(14, 0, 0, 3);
  const line = enrollmentBreakdown(enr);
  ok('the line names the waiting families', /3 waiting/.test(line));
  ok('...while the count still excludes them', enrolledSeats(enr) === 14);
}
ok('no line ever ends with a separator', !/·\s*$/.test(enrollmentBreakdown(E(1, 1, 1, 1))));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
