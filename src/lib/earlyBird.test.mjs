// Pins the operator-facing half of the early-bird rule: the sentences, the short
// labels, and which reasons a toggle can undo.
//
// What is NOT tested here is the price arithmetic, because there isn't any --
// every early-bird price on every screen comes back from SQL. That is deliberate
// and `earlyBird.js` says why at length; the short version is that the JS and SQL
// spellings of a percentage disagree by a cent on the halves, so a form that
// previewed one and saved the other would be lying in a way nothing would catch.
// If a price calculation ever reappears in this file, this comment is the warning.

import {
  formatDeadlineShort,
  formatDollars,
  skipReasonSentence,
  skipReasonLabel,
  isReasonReversible,
} from './earlyBird.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
     actual === expected);
}

// --- the deadline an operator reads ---------------------------------------
// Fixed to UTC: a Portland operator must not see Nov 1 for a Nov 2 `date` column.
// The WI27 deadline is a real one, and "Nov 2" is what the brief asks the row to
// say, so the off-by-a-day version of this would be visible in the feature itself.
eq('short deadline',        formatDeadlineShort('2026-11-02'), 'Nov 2');
eq('reads a timestamp too', formatDeadlineShort('2026-11-02T00:00:00Z'), 'Nov 2');
eq('first of the month',    formatDeadlineShort('2026-01-01'), 'Jan 1');
eq('end of the year',       formatDeadlineShort('2026-12-31'), 'Dec 31');
eq('no deadline',           formatDeadlineShort(null), '');
eq('empty deadline',        formatDeadlineShort(''), '');
eq('unparseable deadline',  formatDeadlineShort('not-a-date'), '');

eq('whole dollars drop the cents', formatDollars(26000), '$260');
eq('part dollars keep them',       formatDollars(26050), '$260.50');
eq('odd cents keep both places',   formatDollars(26005), '$260.05');
eq('zero is a price',              formatDollars(0), '$0');
eq('no price is no text',          formatDollars(null), '');

// --- every reason the SQL can return has a sentence ------------------------
// This list must match the CASE in early_bird_skip_reason (migration 20261006b).
// A reason added there without being added here renders the generic fallback,
// which is survivable; a reason added there and rendered as "undefined" is not,
// and that is what the fallback and this test exist to prevent.
const CODES = ['cancelled', 'closed', 'partner_run', 'preschool', 'free',
               'discount_exceeds_price', 'opted_out'];
for (const c of CODES) {
  ok(`${c} has its own sentence`,
     skipReasonSentence(c) !== '' &&
     skipReasonSentence(c) !== skipReasonSentence('__unknown__'));
  ok(`${c} has its own short label`,
     skipReasonLabel(c) !== '' && skipReasonLabel(c) !== skipReasonLabel('__unknown__'));
}
ok('every sentence is distinct',
   new Set(CODES.map(skipReasonSentence)).size === CODES.length);
ok('every label is distinct',
   new Set(CODES.map(skipReasonLabel)).size === CODES.length);
eq('no reason means no sentence', skipReasonSentence(null), '');
eq('no reason means no label',    skipReasonLabel(null), '');
ok('an unknown code still reads as English', skipReasonSentence('what_is_this').length > 10);
ok('an unknown code still gets a label',     skipReasonLabel('what_is_this').length > 2);

// Each sentence is read by an operator asking "why not this one?", so it has to
// name the thing that is true of THIS class, not recite the rule.
ok('the preschool line names the pricing rule',
   /preschool/i.test(skipReasonSentence('preschool')));
ok('the free line explains there is nothing to take off',
   /free/i.test(skipReasonSentence('free')));
ok('the partner line says who runs registration',
   /partner/i.test(skipReasonSentence('partner_run')));

// --- only the operator's own choice is undoable from the form -------------
// The toggle is live for 'opted_out' and disabled for everything else. Getting
// this backwards would offer a control that cannot work, which reads as a bug.
ok('opted_out is reversible', isReasonReversible('opted_out'));
for (const c of CODES.filter((c) => c !== 'opted_out')) {
  ok(`${c} is not reversible from the toggle`, !isReasonReversible(c));
}
ok('eligible is not "reversible"', !isReasonReversible(null));
ok('an unknown reason is not reversible', !isReasonReversible('what_is_this'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
