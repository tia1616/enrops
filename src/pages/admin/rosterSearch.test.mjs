// Pins the class-roster list's order and its search. Repo convention: plain node
// script with a pass/fail counter, run by scripts/run-src-tests.mjs.
//
// The order used to be enrolled-count-first, which answered a question nobody
// asks on this screen. These tests hold the two things that make the new order
// worth having: the SCHOOL decides, and a class with no school yet is still
// somewhere honest instead of at the top.
import {
  sortRosterPrograms, filterRosterPrograms, schoolNameOf, dayShort,
} from './rosterSearch.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

const prog = (school, curriculum, day, extra = {}) => ({
  curriculum,
  day_of_week: day,
  program_locations: school === null ? null : { name: school, district: extra.district ?? null },
  ...extra,
});
const names = (list) => list.map((p) => `${schoolNameOf(p) || '-'}/${p.curriculum}${p.day_of_week ? `/${p.day_of_week}` : ''}`);

// --- the school decides ------------------------------------------------------

eq('sorted by school name, not by enrolled count',
  names(sortRosterPrograms([
    { ...prog('Wilson', 'Robotics', 'Monday'), enrolled: 40 },
    { ...prog('Ainsworth', 'Minecraft', 'Monday'), enrolled: 1 },
    { ...prog('Beverly Cleary', 'LEGO', 'Monday'), enrolled: 12 },
  ])),
  ['Ainsworth/Minecraft/Monday', 'Beverly Cleary/LEGO/Monday', 'Wilson/Robotics/Monday']);

// Operator-typed names. Two spellings of one school must land together, not in
// two different parts of a 31-row list. They compare EQUAL (sensitivity 'base'),
// so they tie on school and fall through to class name - which is why 'Wilson/A'
// precedes 'wilson/B' here rather than the capitalised one winning.
eq('case does not split one school in two',
  names(sortRosterPrograms([
    prog('wilson', 'B', 'Monday'), prog('Ainsworth', 'A', 'Monday'), prog('Wilson', 'A', 'Monday'),
  ])),
  ['Ainsworth/A/Monday', 'Wilson/A/Monday', 'wilson/B/Monday']);

// --- within one school: class, then the WEEK, then the clock -----------------

eq('same school sorts by class name next',
  names(sortRosterPrograms([prog('Wilson', 'Robotics', 'Monday'), prog('Wilson', 'LEGO', 'Monday')])),
  ['Wilson/LEGO/Monday', 'Wilson/Robotics/Monday']);

// Alphabetical would read Friday, Monday, Thursday, Tuesday, Wednesday - which
// looks like a bug on a timetable.
eq('days run Monday to Friday, NOT alphabetically',
  names(sortRosterPrograms([
    prog('W', 'A', 'Wednesday'), prog('W', 'A', 'Friday'), prog('W', 'A', 'Monday'), prog('W', 'A', 'Tuesday'),
  ])),
  ['W/A/Monday', 'W/A/Tuesday', 'W/A/Wednesday', 'W/A/Friday']);

eq('a day we do not recognise sorts last, not first',
  names(sortRosterPrograms([prog('W', 'A', 'Someday'), prog('W', 'A', 'Monday')])),
  ['W/A/Monday', 'W/A/Someday']);

// THE CLOCK, and it is not a text compare. start_time is TEXT and the corpus is
// mixed - "2:35 PM" from the old forms, "14:35" from an <input type="time"> - so
// comparing the stored strings is wrong in both formats: '1' < '9' < ':' puts
// 10:00 AM before 9:00 AM and 3:00 PM before 9:00 AM. Parsed through to24h(),
// the one helper that reads both.
eq('same school, class and day falls back to start time',
  sortRosterPrograms([
    { ...prog('W', 'A', 'Monday'), start_time: '15:30' },
    { ...prog('W', 'A', 'Monday'), start_time: '08:00' },
  ]).map((p) => p.start_time),
  ['08:00', '15:30']);
eq('9 AM comes before 10 AM (a text compare gets this backwards)',
  sortRosterPrograms([
    { ...prog('W', 'A', 'Monday'), start_time: '10:00 AM' },
    { ...prog('W', 'A', 'Monday'), start_time: '9:00 AM' },
  ]).map((p) => p.start_time),
  ['9:00 AM', '10:00 AM']);
eq('AM comes before PM (a text compare ignores the meridiem)',
  sortRosterPrograms([
    { ...prog('W', 'A', 'Monday'), start_time: '3:00 PM' },
    { ...prog('W', 'A', 'Monday'), start_time: '9:00 AM' },
  ]).map((p) => p.start_time),
  ['9:00 AM', '3:00 PM']);
// The two stored formats have to sort against EACH OTHER, because one class can
// have been written by the old form and its neighbour by the new one.
eq('the two stored time formats sort against each other',
  sortRosterPrograms([
    { ...prog('W', 'A', 'Monday'), start_time: '2:35 PM' },
    { ...prog('W', 'A', 'Monday'), start_time: '08:00' },
  ]).map((p) => p.start_time),
  ['08:00', '2:35 PM']);
// A missing or unparseable time leads its group rather than sorting at random.
eq('a missing time does not shuffle the group',
  sortRosterPrograms([
    { ...prog('W', 'A', 'Monday'), start_time: '9:00 AM' },
    { ...prog('W', 'A', 'Monday'), start_time: null },
  ]).map((p) => p.start_time),
  [null, '9:00 AM']);

// --- a class with no school yet ----------------------------------------------
// program_location_id is nullable and the quick builder can create one without
// it. Zero such rows on prod today, which is exactly when this goes unnoticed:
// an empty school name sorts to the TOP of an alphabetical list and pushes 31
// real schools down the page.

eq('a class with no school sorts LAST, not first',
  names(sortRosterPrograms([prog(null, 'Orphan', 'Monday'), prog('Ainsworth', 'A', 'Monday')])),
  ['Ainsworth/A/Monday', '-/Orphan/Monday']);
eq('a blank school name counts as no school',
  names(sortRosterPrograms([prog('   ', 'Orphan', 'Monday'), prog('Wilson', 'A', 'Monday')])),
  ['Wilson/A/Monday', '-/Orphan/Monday']);
eq('two schoolless classes still sort by class name',
  names(sortRosterPrograms([prog(null, 'Robotics', 'Monday'), prog(null, 'LEGO', 'Monday')])),
  ['-/LEGO/Monday', '-/Robotics/Monday']);

// --- sorting does not mutate or lose rows ------------------------------------

const original = [prog('W', 'B', 'Monday'), prog('A', 'A', 'Monday')];
const sorted = sortRosterPrograms(original);
eq('the caller\'s array is not reordered in place', schoolNameOf(original[0]), 'W');
eq('no row is dropped', sorted.length, original.length);
eq('an empty list is not a crash', sortRosterPrograms([]), []);
eq('null is not a crash', sortRosterPrograms(null), []);

// --- search ------------------------------------------------------------------

const list = [
  prog('Beverly Cleary', 'Minecraft Coders', 'Wednesday', { district: 'Portland Public' }),
  prog('Ainsworth', 'Robotics Explorers', 'Monday', { district: 'Portland Public' }),
  prog('Catlin Gabel', 'Minecraft Coders', 'Friday', { district: 'Private' }),
];
const found = (q) => filterRosterPrograms(list, q).map((p) => schoolNameOf(p));

eq('an empty query returns everything', filterRosterPrograms(list, '').length, 3);
eq('a whitespace-only query returns everything', filterRosterPrograms(list, '   ').length, 3);
eq('undefined query returns everything', filterRosterPrograms(list, undefined).length, 3);
eq('finds by school', found('cleary'), ['Beverly Cleary']);
eq('finds by class', found('robotics'), ['Ainsworth']);
eq('finds by district', found('private'), ['Catlin Gabel']);
eq('search is case-insensitive', found('CLEARY'), ['Beverly Cleary']);
eq('a partial word matches', found('minecr'), ['Beverly Cleary', 'Catlin Gabel']);
// The row DISPLAYS "Weds", so typing what is on screen has to work.
eq('finds by the full day name', found('wednesday'), ['Beverly Cleary']);
eq('finds by the short day shown on the row', found('fri'), ['Catlin Gabel']);
// THE POINT OF WORD-BY-WORD MATCHING: the words come from DIFFERENT fields, so a
// single substring test over the joined text would find neither order.
eq('two words from different fields match', found('cleary minecraft'), ['Beverly Cleary']);
eq('the same two words in the other order match too', found('minecraft cleary'), ['Beverly Cleary']);
eq('extra spaces between words are ignored', found('minecraft    cleary'), ['Beverly Cleary']);
eq('a word that matches nothing excludes the row', found('cleary robotics'), []);
eq('no match is an empty list, not everything', found('zzzz'), []);
eq('a null list is not a crash', filterRosterPrograms(null, 'x'), []);
// A class with no school must stay FINDABLE by its class name - it is the row
// most likely to need attention.
eq('a schoolless class is still findable by class name',
  filterRosterPrograms([prog(null, 'Orphan Class', 'Monday')], 'orphan').length, 1);

eq('dayShort renders the short form', dayShort('wednesday'), 'Wed');
eq('dayShort passes through something unknown', dayShort('Someday'), 'Someday');
eq('dayShort on null is empty, not "undefined"', dayShort(null), '');

console.log(`\nrosterSearch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
