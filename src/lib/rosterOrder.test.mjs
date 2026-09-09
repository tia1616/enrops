// Pins the one roster order every surface now shares. Every literal below is a
// value that is actually in the live prod or staging data, because the four
// things that break a name sort are all data, not logic: a trailing space, a
// lowercase first letter, two children with the same first name, and a row that
// does not carry registered_at at all.
//
// The load-bearing case is TRAILING_SPACE_TIEBREAK. "Benjamin " and "Benjamin"
// both exist on prod (six rows carry the space). Compared untrimmed they are
// UNEQUAL, so the last-name tiebreak never runs and two Benjamins are ordered by
// an invisible character - which reads as a random order to the instructor
// holding the sheet.

import { sortRosterRows, compareRosterRows, isOnRoster } from './rosterOrder.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n        got    ${a}\n        wanted ${e}`); }
}

// Rows in the shape every roster surface holds. `at` is registered_at.
let seq = 0;
const row = (first, last, at) => ({
  id: `id-${String(++seq).padStart(3, '0')}`,
  registered_at: at ?? null,
  student: { first_name: first, last_name: last },
});
// Whitespace is COLLAPSED here, not just trimmed, because these assertions are
// about the ORDER and some fixtures carry prod's trailing spaces: "Benjamin " +
// " " + "Zimmerman" is a double space that would otherwise fail a test that had
// sorted perfectly. (That double space is real in the rendered name too - it
// collapses to one in HTML but survives into the roster PDF and the CSV. It
// predates this module and is not its job to fix.)
const names = (rows) =>
  rows.map((r) => `${r.student?.first_name ?? ''} ${r.student?.last_name ?? ''}`.replace(/\s+/g, ' ').trim());

// --- the real staging class an instructor will actually look at -------------
// Soccer Skills Academy at Maple Grove (sideline-sports-club, 12 enrolled), in
// the REGISTRATION order the portal showed until 2026-09-01.
const SOCCER = [
  row('Ava', 'Nguyen', '2026-08-03T17:00:00+00:00'),
  row('Finn', 'Brennan', '2026-08-03T17:00:00+00:00'),
  row('Mia', 'Chen', '2026-08-04T17:00:00+00:00'),
  row('Diego', 'Silva', '2026-08-04T17:00:00+00:00'),
  row('Nora', 'Abbott', '2026-08-05T17:00:00+00:00'),
  row('Ruby', 'Ellison', '2026-08-06T17:00:00+00:00'),
  row('Kai', 'Tran', '2026-08-07T17:00:00+00:00'),
  row('Amara', 'Osei', '2026-08-09T17:00:00+00:00'),
  row('Elsa', 'Lindqvist', '2026-08-10T17:00:00+00:00'),
  row('Noah', 'Baptiste', '2026-08-12T17:00:00+00:00'),
  row('Wyatt', 'Sorenson', '2026-08-13T17:00:00+00:00'),
  row('Piper', 'Sorenson', '2026-08-13T17:00:00+00:00'),
];
eq('a real 12-child class comes out by first name',
  names(sortRosterRows(SOCCER)),
  ['Amara Osei', 'Ava Nguyen', 'Diego Silva', 'Elsa Lindqvist', 'Finn Brennan',
   'Kai Tran', 'Mia Chen', 'Noah Baptiste', 'Nora Abbott', 'Piper Sorenson',
   'Ruby Ellison', 'Wyatt Sorenson']);

// Super Mario Game Makers on staging: three Vorsters, one of them shouting.
const MARIO = [
  row('Jessica', 'Vorster', '2026-07-12T18:44:05.992264+00:00'),
  row('James', 'Vorster', '2026-07-12T18:46:54.349491+00:00'),
  row('JACK', 'Vorster', '2026-07-12T19:20:46.845893+00:00'),
  row('Milo', 'Latejoin', '2026-08-10T16:29:57.975479+00:00'),
  row('Otis', 'Secondlate', '2026-08-10T16:51:10.724791+00:00'),
];
eq('same last name three times still orders by first name',
  names(sortRosterRows(MARIO)),
  ['JACK Vorster', 'James Vorster', 'Jessica Vorster', 'Milo Latejoin', 'Otis Secondlate']);

// --- 1. trailing spaces: 47 first names on prod carry one ------------------
// These cases are built so that trimmed and untrimmed give DIFFERENT answers.
// That is fiddlier than it looks: a trailing space sorts low, so "Ada " still
// lands next to "Adam" whether you trim or not, and a test built on that pair
// would pass against a comparator that never trimmed at all. The only case that
// genuinely discriminates is the one prod actually has - the SAME first name
// with and without the space - because untrimmed makes the two UNEQUAL and the
// last-name tiebreak never runs. The spaced row therefore gets the EARLIER last
// name here, so a comparator that skipped the trim returns the reverse.
eq('TRAILING_SPACE_TIEBREAK: a trailing space does not stop the last-name tiebreak',
  names(sortRosterRows([row('Benjamin ', 'Adams'), row('Benjamin', 'Zimmerman')])),
  ['Benjamin Adams', 'Benjamin Zimmerman']);
eq('a trailing space does not push a name away from its neighbours',
  names(sortRosterRows([row('Molly', 'Reyes'), row('Ada ', 'Fitch'), row('Adam', 'Boyle')])),
  ['Ada Fitch', 'Adam Boyle', 'Molly Reyes']);
// Same trick on the last name: trimmed these two tie and the ID decides, so the
// spaced row is given the EARLIER id. Untrimmed, "Tran" beats "Tran " and the
// order flips.
const spacedLast = { id: 'aaa', student: { first_name: 'Kai', last_name: 'Tran ' } };
const cleanLast = { id: 'zzz', student: { first_name: 'Kai', last_name: 'Tran' } };
eq('a trailing space on the LAST name does not stop the tiebreak either',
  sortRosterRows([cleanLast, spacedLast]).map((r) => r.id), ['aaa', 'zzz']);

// --- 2. case: 7 prod first names are not capitalised; staging has "j dog" --
eq('a lowercase name sorts among the letters, not after Z',
  names(sortRosterRows([row('Zoe', 'Park'), row('aiden', 'Ng'), row('Maya', 'Cole')])),
  ['aiden Ng', 'Maya Cole', 'Zoe Park']);
eq('"j dog" lands in the Js',
  names(sortRosterRows([row('Kai', 'Tran'), row('j dog', 'vorster'), row('Ivy', 'Blum')])),
  ['Ivy Blum', 'j dog vorster', 'Kai Tran']);

// --- 3. same first name: real prod camp rows -------------------------------
eq('two Julians order by last name (prod camp 2b1e6aff)',
  names(sortRosterRows([row('Julian', 'Toms'), row('Julian', 'Eustaquio')])),
  ['Julian Eustaquio', 'Julian Toms']);
eq('Aiden Gillis before Aiden Ng (prod camp 38e13931)',
  names(sortRosterRows([row('Aiden', 'Ng'), row('Aiden', 'Gillis')])),
  ['Aiden Gillis', 'Aiden Ng']);

// --- 4. the stable tiebreaks ----------------------------------------------
// Two "Jessica Vorster" rows sit on a staging class today. Identical name,
// identical everything the eye can see - the order must still be fixed.
const twinA = { id: 'zzz', registered_at: '2026-01-02T00:00:00+00:00', student: { first_name: 'Jessica', last_name: 'Vorster' } };
const twinB = { id: 'aaa', registered_at: '2026-01-01T00:00:00+00:00', student: { first_name: 'Jessica', last_name: 'Vorster' } };
eq('identical names fall back to registration order', sortRosterRows([twinA, twinB]).map((r) => r.id), ['aaa', 'zzz']);
const noDateA = { id: 'zzz', student: { first_name: 'Jessica', last_name: 'Vorster' } };
const noDateB = { id: 'aaa', student: { first_name: 'Jessica', last_name: 'Vorster' } };
eq('with no registered_at selected (Rosters.jsx), the id decides',
  sortRosterRows([noDateA, noDateB]).map((r) => r.id), ['aaa', 'zzz']);
eq('the comparator is symmetric on a tie', compareRosterRows(noDateA, noDateA), 0);

// --- blanks and junk: must not crash, must not hide ------------------------
eq('a blank first name sorts LAST, where it can be seen',
  names(sortRosterRows([row('', 'Nolastname'), row('Zoe', 'Park'), row('Amara', 'Osei')])),
  ['Amara Osei', 'Zoe Park', 'Nolastname']);
eq('a whitespace-only first name counts as blank',
  names(sortRosterRows([row('   ', 'Spaces'), row('Zoe', 'Park')])),
  ['Zoe Park', 'Spaces']);
eq('two blanks still order by last name',
  names(sortRosterRows([row(null, 'Younger'), row(null, 'Adams')])),
  ['Adams', 'Younger']);
eq('a row with no student at all does not crash the roster',
  sortRosterRows([{ id: 'b', student: null }, row('Amara', 'Osei')]).length, 2);
eq('a numeric first name from an import does not crash',
  names(sortRosterRows([row(7, 'Seven'), row('Amara', 'Osei')])),
  ['7 Seven', 'Amara Osei']);
eq('empty and nullish inputs', [sortRosterRows([]), sortRosterRows(null), sortRosterRows(undefined)], [[], [], []]);

// --- it must not mutate React state ---------------------------------------
const original = [row('Zoe', 'Park'), row('Amara', 'Osei')];
const before = original.map((r) => r.id);
const sorted = sortRosterRows(original);
eq('sortRosterRows returns a new array and leaves the input alone',
  [original.map((r) => r.id), sorted !== original], [before, true]);

// --- NOT this module's job -------------------------------------------------
// The waitlist (waitlist_position) and contacts (sort_order) keep their own
// meaningful sequences. Nothing to assert here beyond the note: if a future
// change routes either of those through this comparator, that is the bug.

// --- WHO IS ON THE ROSTER AT ALL ------------------------------------------
// Every shape below is a real prod or staging row shape, counted 2026-09-09.
// The two that decide whether this is right or catastrophic are the 354-row
// confirmed-and-unpaid case (hand-added / imported / comped / school pays
// off-platform - these are MOST of the roster and must stay) and the ACH case
// (zero rows on either environment today, so nothing but a test defends it).

const reg = (status, payment_status, ach_payment_state = null) => ({ status, payment_status, ach_payment_state });

eq('paid and confirmed - the ordinary case, 530 non-cancelled prod rows',
  isOnRoster(reg('confirmed', 'paid')), true);
eq('CONFIRMED BUT UNPAID STAYS - 354 prod rows: hand-added, imported, comped, school pays',
  isOnRoster(reg('confirmed', 'unpaid')), true);
eq('paid but not yet confirmed still has a place - ZERO prod rows today, so only this test defends it',
  isOnRoster(reg('pending', 'paid')), true);
eq('ABANDONED CHECKOUT IS NOT ON THE ROSTER - the 16 prod rows this change hides',
  isOnRoster(reg('pending', 'unpaid')), false);
eq('a bank transfer still clearing keeps its place (zero rows today; this test is the only thing holding it)',
  isOnRoster(reg('pending', 'unpaid', 'processing')), true);
eq('an ACH transfer that FAILED does not keep a place',
  isOnRoster(reg('pending', 'unpaid', 'failed')), false);
eq('refunded but still confirmed stays - the operator decides who is in the room, not the money',
  isOnRoster(reg('confirmed', 'refunded')), true);
eq('partially refunded and confirmed stays',
  isOnRoster(reg('confirmed', 'partial')), true);

// NOT this function's job: cancelled and waitlist are filtered by each caller's
// own query. Pinned so nobody "fixes" isOnRoster by folding them in and quietly
// changes what those four callers already exclude for their own reasons.
eq('a cancelled-but-paid row is still ON by this rule (callers drop it themselves)',
  isOnRoster(reg('cancelled', 'paid')), true);

eq('null and undefined are not on any roster',
  [isOnRoster(null), isOnRoster(undefined)], [false, false]);
eq('a row missing the payment fields entirely is not on the roster (fails closed)',
  isOnRoster({ id: 'x' }), false);

// THE SELECT-MISMATCH TRAP (recurring finding vi): if a caller forgets
// ach_payment_state in its .select(), the column arrives undefined and the ACH
// clause silently never fires. Pinned here so the failure is at least
// documented and fails CLOSED; the real defence is the four selects.
eq('an ACH row whose caller forgot to select the column reads as not-on-roster',
  isOnRoster({ status: 'pending', payment_status: 'unpaid' }), false);

// CANCELLED IS NOT THIS FUNCTION'S QUESTION, and a caller that forgets so ships a
// bug. isOnRoster answers MONEY only, so every cancelled-and-unpaid row fails it -
// 87 on prod, 39 of them on camp rosters, which render cancelled registrations on
// purpose with their own badge. Rosters.jsx therefore keeps a cancelled row on the
// list explicitly (isCancelledReg) instead of trusting this predicate to do it.
// Pinned so the contract stays written down rather than remembered.
eq('a cancelled unpaid row is NOT on the roster by this rule - the caller re-admits it',
  isOnRoster(reg('cancelled', 'unpaid')), false);
eq('a cancelled row that was PAID still passes - which is why the caller cannot rely on this alone',
  isOnRoster(reg('cancelled', 'paid')), true);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
