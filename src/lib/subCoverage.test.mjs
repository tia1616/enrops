// subCoverage — one class-day's coverage, however many offers are out on it.
// The cases below are the ones the boards get wrong today: several offers on
// one day, and the day somebody WON (where the losing offers are recorded as
// declines and must not make the day look uncovered).
import {
  aggregateSubSlot, aggregateSubOffers, subSlotLabel, subSlotKey, SUB_ACTIVE_STATUSES,
} from './subCoverage.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL  ${name}`); }
}

const ann = { first_name: 'Ann', last_name: 'Diaz' };
const bo = { first_name: 'Bo', last_name: 'Ng' };
const cy = { first_name: 'Cy', last_name: 'Park' };
const row = (status, sub, id, over = {}) => ({
  parent_assignment_id: 'A1', date: '2026-10-05', status,
  sub, sub_instructor_id: id, ...over,
});

// --- a day with nothing on it ---
{
  ok('no rows -> no slot', aggregateSubSlot([]) === null);
  ok('null rows -> no slot', aggregateSubSlot(null) === null);
  ok('no rows -> no label', subSlotLabel(null) === null);
}

// --- one offer, which is every day that exists today ---
{
  const s = aggregateSubSlot([row('pending', ann, 'i-ann')]);
  ok('single pending -> pending', s.status === 'pending');
  ok('single pending names the person', s.sub === ann && s.sub_instructor_id === 'i-ann');
  ok('single pending counts one offer', s.offersOut === 1);
  ok('single pending label names them', subSlotLabel(s).text === 'Ann Diaz · pending');

  const c = aggregateSubSlot([row('confirmed', ann, 'i-ann')]);
  ok('single confirmed -> confirmed', c.status === 'confirmed' && c.offersOut === 0);
  ok('single confirmed label ticks', subSlotLabel(c).text === 'Ann Diaz ✓');
}

// --- several offers out on ONE day: the count, never a name ---
{
  const s = aggregateSubSlot([
    row('pending', ann, 'i-ann'), row('pending', bo, 'i-bo'), row('pending', cy, 'i-cy'),
  ]);
  ok('three offers -> one slot', s.status === 'pending');
  ok('three offers -> offersOut 3', s.offersOut === 3);
  ok('three offers name NOBODY', s.sub === null && s.sub_instructor_id === null);
  ok('three offers label is a count', subSlotLabel(s).text === '3 offers out');
  ok('three offers keep every row for the filter', s.rows.length === 3);
}

// --- somebody accepted: the losing offers must not speak for the day ---
{
  const s = aggregateSubSlot([
    row('declined', ann, 'i-ann', { decline_reason: 'covered_by_other' }),
    row('confirmed', bo, 'i-bo'),
    row('declined', cy, 'i-cy', { decline_reason: 'covered_by_other' }),
  ]);
  ok('a winner wins whatever order the rows arrive in', s.status === 'confirmed');
  ok('the winner is the person named', s.sub === bo && s.sub_instructor_id === 'i-bo');
  ok('a covered day has no offers out', s.offersOut === 0);
  ok('the card ticks the winner', subSlotLabel(s).text === 'Bo Ng ✓');
}

// --- taught counts as covered too ---
{
  const s = aggregateSubSlot([row('taught', ann, 'i-ann'), row('declined', bo, 'i-bo')]);
  ok('taught wins over a decline', s.status === 'taught' && subSlotLabel(s).text === 'Ann Diaz ✓');
}

// --- everybody declined: the lead still has the class, so the card says nothing ---
{
  const s = aggregateSubSlot([row('declined', ann, 'i-ann'), row('declined', bo, 'i-bo')]);
  ok('all declined -> declined', s.status === 'declined');
  ok('all declined draws no sub on the card', subSlotLabel(s) === null);
  ok('declined is not an active status', !SUB_ACTIVE_STATUSES.has('declined'));
}

// --- a missed day is not a coverage question ---
{
  const s = aggregateSubSlot([row('missed', ann, 'i-ann')]);
  ok('missed -> no label', subSlotLabel(s) === null);
}

// --- a pending offer alongside a decline still reads as pending ---
{
  const s = aggregateSubSlot([row('declined', ann, 'i-ann'), row('pending', bo, 'i-bo')]);
  ok('one live offer beats an old decline', s.status === 'pending' && s.offersOut === 1);
  ok('and it names the person still deciding', subSlotLabel(s).text === 'Bo Ng · pending');
}

// --- grouping across days and classes ---
{
  const map = aggregateSubOffers([
    row('pending', ann, 'i-ann'),
    row('pending', bo, 'i-bo'),
    { ...row('confirmed', cy, 'i-cy'), date: '2026-10-12' },
    { ...row('pending', ann, 'i-ann'), parent_assignment_id: 'A2' },
  ]);
  ok('three distinct class-days', map.size === 3);
  ok('same day, two offers, one entry', map.get(subSlotKey('A1', '2026-10-05')).offersOut === 2);
  ok('a different date is a different day', map.get(subSlotKey('A1', '2026-10-12')).status === 'confirmed');
  ok('a different class is a different day', map.get(subSlotKey('A2', '2026-10-05')).offersOut === 1);
}

// --- junk rows cannot poison the map ---
{
  const map = aggregateSubOffers([null, {}, { parent_assignment_id: 'A1' }, row('pending', ann, 'i-ann')]);
  ok('rows without a class-day are skipped', map.size === 1);
}

// --- a missing instructor record must not blank the card ---
{
  const s = aggregateSubSlot([row('confirmed', null, 'i-ann')]);
  ok('no instructor record still renders something', subSlotLabel(s).text === 'Sub ✓');
}

console.log(`\nsubCoverage: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
