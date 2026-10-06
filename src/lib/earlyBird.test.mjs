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
  earlyBirdPatch,
  describeOffer,
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

// --- how the term's offer reads back --------------------------------------
// discount_value arrives from PostgREST as a numeric STRING. Printing it raw
// would put "$25.0000000000000000 off" on the program form.
eq('a dollar offer', describeOffer({ discount_type: 'fixed', discount_value: '25.0000000000000000' }), '$25 off');
eq('a percent offer', describeOffer({ discount_type: 'percent', discount_value: '10.00' }), '10% off');
eq('a part-dollar offer', describeOffer({ discount_type: 'fixed', discount_value: '12.50' }), '$12.50 off');
eq('no offer to describe', describeOffer({ discount_type: null, discount_value: null }), '');
eq('nothing at all', describeOffer(undefined), '');

// --- WHAT A SAVE WRITES ----------------------------------------------------
// This is the function that touches a money column, so each case says what it
// is protecting. The three nulls matter more than the two writes: null means
// "leave the stored price alone", and getting any of them wrong wipes a
// discount families may already have registered under.
const OFFER = { deadline: '2026-11-02', discount_type: 'fixed', discount_value: '25',
                term_program_count: 28, early_bird_cents: 26000, skip_reason: null };

// EVERY call below pins `today`. earlyBirdPatch now refuses an offer whose
// deadline has passed, so leaving it on the real clock would turn this whole
// block green today and red on 2026-11-03 for a reason that has nothing to do
// with the code -- a suite that fails on a date nobody changed is a suite people
// learn to ignore.
const NOW = new Date('2026-10-06T12:00:00Z');

ok('switch ON writes the price, the deadline and clears the opt-out',
   JSON.stringify(earlyBirdPatch(OFFER, true, NOW)) ===
   JSON.stringify({ early_bird_price_cents: 26000, early_bird_deadline: '2026-11-02', early_bird_opt_out: false }));
ok('switch OFF clears the price and RECORDS the opt-out',
   JSON.stringify(earlyBirdPatch(OFFER, false, NOW)) ===
   JSON.stringify({ early_bird_price_cents: null, early_bird_deadline: null, early_bird_opt_out: true }));

// A failed lookup must not look like "no early bird". If this returns columns,
// an error on a slow day silently strips a live discount.
eq('lookup failed -> touch nothing', earlyBirdPatch(null, true, NOW), null);
eq('lookup failed, switch off -> still touch nothing', earlyBirdPatch(null, false, NOW), null);
eq('still loading -> touch nothing', earlyBirdPatch(undefined, true, NOW), null);
eq('no price typed yet -> touch nothing', earlyBirdPatch({ needs_price: true }, true, NOW), null);
eq('no price typed, switch off -> touch nothing', earlyBirdPatch({ needs_price: true }, false, NOW), null);

// A term with no single discount has no price this form could honestly write.
eq('term has no early bird -> touch nothing',
   earlyBirdPatch({ ...OFFER, term_program_count: 0, discount_type: null, discount_value: null, early_bird_cents: null }, true, NOW),
   null);
eq('term’s programs are on different deals -> touch nothing',
   earlyBirdPatch({ ...OFFER, discount_type: null, discount_value: null, early_bird_cents: null }, true, NOW),
   null);

// Ineligible: CLEAR the price, but never record an opt-out the operator did not
// choose -- an opt-out would outlive the cancellation and keep the class out of
// the term discount after it is reinstated.
for (const reason of CODES.filter((c) => c !== 'opted_out')) {
  const p = earlyBirdPatch({ ...OFFER, skip_reason: reason }, true, NOW);
  ok(`${reason} clears the price`, p && p.early_bird_price_cents === null && p.early_bird_deadline === null);
  ok(`${reason} does NOT record an opt-out`, p && !('early_bird_opt_out' in p));
}
// Even with the switch on, an ineligible class is cleared: the switch is
// disabled in that state, and a stale `true` must not win.
ok('ineligible + switch on still clears',
   earlyBirdPatch({ ...OFFER, skip_reason: 'cancelled' }, true, NOW)?.early_bird_price_cents === null);

// A zero-cent early bird is a REAL value, not "no offer" -- this pins the
// `== null` check against being "simplified" to a falsiness check.
// Optional-chained on purpose: under that mutation the call returns null, and a
// bare property read would CRASH the runner mid-file, taking every later
// assertion with it and reporting a stack trace instead of a named failure.
ok('an early bird of 0 is still written',
   earlyBirdPatch({ ...OFFER, early_bird_cents: 0 }, true, NOW)?.early_bird_price_cents === 0);

// An offer whose deadline has gone is not one to join a class to.
const DAY_BEFORE = new Date('2026-11-01T12:00:00Z');
const DAY_AFTER  = new Date('2026-11-03T12:00:00Z');
ok('before the deadline, the offer is written',
   earlyBirdPatch(OFFER, true, DAY_BEFORE)?.early_bird_price_cents === 26000);
eq('after the deadline, touch nothing', earlyBirdPatch(OFFER, true, DAY_AFTER), null);
// The deadline DAY itself counts, to its last second, UTC. An off-by-one here
// takes a day off every early bird the platform runs.
ok('the deadline day itself still counts',
   earlyBirdPatch(OFFER, true, new Date('2026-11-02T23:59:00Z'))?.early_bird_price_cents === 26000);
// Past the deadline nothing is written in EITHER switch position: there is no
// live offer to join, and none to opt out of.
eq('after the deadline, switching off writes nothing either',
   earlyBirdPatch(OFFER, false, DAY_AFTER), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
