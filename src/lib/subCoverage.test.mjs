// subCoverage — one class-day's coverage, however many offers are out on it.
// The cases below are the ones the boards get wrong without it: several offers
// on one day, the day somebody WON (where the losing offers are recorded as
// declines and must not make the day look uncovered), and the day everybody
// said no (which used to draw nothing at all).
//
// Cases marked REVIEW were surviving mutants or real defects found by the
// 2026-09-23 max review; each one killed a wrong implementation that the first
// version of this file let pass.
import {
  aggregateSubSlot, aggregateSubOffers, subSlotLabel, subSlotLabelText,
  slotNeedsCover, subDisplayName, subSlotKey, SUB_ACTIVE_STATUSES,
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
  ok('no slot never needs cover', slotNeedsCover(null) === false);
}

// --- one offer, which is every day that exists before chunk 2 ---
{
  const s = aggregateSubSlot([row('pending', ann, 'i-ann')]);
  ok('single pending -> pending', s.status === 'pending');
  ok('single pending names the person', s.sub === ann && s.sub_instructor_id === 'i-ann');
  ok('single pending counts one offer', s.offersOut === 1);
  ok('single pending label names them', subSlotLabel(s).text === 'Ann Diaz');
  ok('single pending marker says pending', subSlotLabel(s).marker === '· pending');
  ok('single pending reads as one sentence', subSlotLabelText(s) === 'Ann Diaz · pending');
  ok('an offer out is not a day needing cover', slotNeedsCover(s) === false);

  const c = aggregateSubSlot([row('confirmed', ann, 'i-ann')]);
  ok('single confirmed -> confirmed', c.status === 'confirmed' && c.offersOut === 0);
  ok('single confirmed ticks', subSlotLabel(c).marker === '✓');
  ok('single confirmed names the winner', subSlotLabel(c).text === 'Ann Diaz');
  ok('a covered day never needs cover', slotNeedsCover(c) === false);
}

// --- the state marker is SEPARATE from the name (REVIEW: it used to be
//     concatenated, so a long name truncated the proof a day was covered) ---
{
  const c = aggregateSubSlot([row('confirmed', { first_name: 'Alexandra', last_name: 'Fernandez' }, 'i-a')]);
  const l = subSlotLabel(c);
  ok('REVIEW the name carries no marker of its own', !l.text.includes('✓'));
  ok('REVIEW the marker is its own field', l.marker === '✓');
}

// --- several offers out on ONE day: the count, never a name ---
{
  const s = aggregateSubSlot([
    row('pending', ann, 'i-ann'), row('pending', bo, 'i-bo'), row('pending', cy, 'i-cy'),
  ]);
  ok('three offers -> one slot', s.status === 'pending');
  ok('three offers -> offersOut 3', s.offersOut === 3);
  ok('three offers name NOBODY', s.sub === null && s.sub_instructor_id === null);
  ok('three offers label is a count', subSlotLabel(s).text === '3 people asked');
  ok('three offers keep every row for the filter', s.rows.length === 3);
}

// --- REVIEW: exactly TWO offers, the boundary a surviving mutant proved
//     untested. `> 1` vs `> 2` used to pass identically. ---
{
  const s = aggregateSubSlot([row('pending', ann, 'i-ann'), row('pending', bo, 'i-bo')]);
  ok('REVIEW two offers -> offersOut 2', s.offersOut === 2);
  ok('REVIEW two offers name NOBODY', s.sub === null);
  ok('REVIEW two offers label is a count', subSlotLabel(s).text === '2 people asked');
}

// --- REVIEW: counts are PEOPLE, not rows. Re-offering a day to somebody who
//     already declined leaves two rows for one human. ---
{
  const s = aggregateSubSlot([
    row('declined', ann, 'i-ann', { decline_reason: 'busy' }),
    row('declined', ann, 'i-ann', { decline_reason: 'still busy' }),
  ]);
  ok('REVIEW one person declining twice is ONE decline', s.declineCount === 1);

  const p = aggregateSubSlot([row('pending', ann, 'i-ann'), row('pending', ann, 'i-ann')]);
  ok('REVIEW one person offered twice is ONE offer', p.offersOut === 1);
  ok('REVIEW and is still named, not counted', subSlotLabel(p).text === 'Ann Diaz');

  const noId = aggregateSubSlot([
    row('declined', ann, null), row('declined', bo, null),
  ]);
  ok('REVIEW rows with no instructor id each count as a person', noId.declineCount === 2);
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
  ok('the card ticks the winner', subSlotLabel(s).marker === '✓');
  ok('a covered day needs no cover', slotNeedsCover(s) === false);
}

// --- REVIEW: taught AND confirmed on one day. The single-winner index only
//     guards 'confirmed', and neither board query orders its rows, so the
//     answer must not depend on arrival order. ---
{
  const a = aggregateSubSlot([row('taught', ann, 'i-ann'), row('confirmed', bo, 'i-bo')]);
  const b = aggregateSubSlot([row('confirmed', bo, 'i-bo'), row('taught', ann, 'i-ann')]);
  ok('REVIEW confirmed beats taught, rows in either order', a.sub === bo && b.sub === bo);
  ok('REVIEW and the status follows the winner', a.status === 'confirmed' && b.status === 'confirmed');
}

// --- taught alone still counts as covered ---
{
  const s = aggregateSubSlot([row('taught', ann, 'i-ann'), row('declined', bo, 'i-bo')]);
  ok('taught wins over a decline', s.status === 'taught' && subSlotLabel(s).marker === '✓');
}

// --- REVIEW: a winner AND an offer still live. The accept path skips siblings
//     it cannot lock, so somebody can still be holding an unanswered email. ---
{
  const s = aggregateSubSlot([row('confirmed', bo, 'i-bo'), row('pending', ann, 'i-ann')]);
  ok('REVIEW the day is covered', s.status === 'confirmed');
  ok('REVIEW but the live offer is still counted', s.offersOut === 1);
  ok('REVIEW the marker stays short so it can be pinned', subSlotLabel(s).marker === '✓');
  ok('REVIEW and the live offer is carried as a note', subSlotLabel(s).note === '1 still to answer');
}

// --- everybody declined: the lead still has the class, and the day NEEDS someone ---
{
  const s = aggregateSubSlot([row('declined', ann, 'i-ann'), row('declined', bo, 'i-bo')]);
  ok('all declined -> declined', s.status === 'declined');
  ok('all declined counts both people', s.declineCount === 2);
  ok('all declined draws no sub on the card', subSlotLabel(s) === null);
  ok('REVIEW but the day is flagged as needing cover', slotNeedsCover(s) === true);
  ok('declined is not an active status', !SUB_ACTIVE_STATUSES.has('declined'));
}

// --- a missed day is not a coverage question ---
{
  const s = aggregateSubSlot([row('missed', ann, 'i-ann')]);
  ok('missed -> no label', subSlotLabel(s) === null);
  ok('REVIEW missed keeps its own status, it is not a decline', s.status === 'missed');
  ok('REVIEW missed alone does not need cover', slotNeedsCover(s) === false);
}

// --- REVIEW: a status nobody has heard of must not crash or claim anything ---
{
  const s = aggregateSubSlot([row('expired', ann, 'i-ann')]);
  ok('REVIEW unknown status draws nothing', subSlotLabel(s) === null);
  ok('REVIEW unknown status claims no cover need', slotNeedsCover(s) === false);
}

// --- a pending offer alongside a decline still reads as pending, and the
//     decline is not forgotten ---
{
  const s = aggregateSubSlot([row('declined', ann, 'i-ann'), row('pending', bo, 'i-bo')]);
  ok('one live offer beats an old decline', s.status === 'pending' && s.offersOut === 1);
  ok('and it names the person still deciding', subSlotLabel(s).text === 'Bo Ng');
  ok('REVIEW the decline is still carried', s.declineCount === 1);
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
  ok('same day, two offers, one entry', map.get('A1:2026-10-05').offersOut === 2);
  ok('a different date is a different day', map.get('A1:2026-10-12').status === 'confirmed');
  ok('a different class is a different day', map.get('A2:2026-10-05').offersOut === 1);
  ok('REVIEW the key is exactly id:date', subSlotKey('A1', '2026-10-05') === 'A1:2026-10-05');
}

// --- junk rows cannot poison the map ---
{
  const map = aggregateSubOffers([null, {}, { parent_assignment_id: 'A1' }, row('pending', ann, 'i-ann')]);
  ok('rows without a class-day are skipped', map.size === 1);
  ok('and the surviving entry is the real one', map.get('A1:2026-10-05').offersOut === 1);

  const noParent = aggregateSubOffers([
    { date: '2026-10-05', status: 'pending', sub: ann, sub_instructor_id: 'i-ann' },
    row('pending', bo, 'i-bo'),
  ]);
  ok('REVIEW a row with no class collapses nothing into the real day', noParent.size === 1);
  ok('REVIEW and does not inflate its count', noParent.get('A1:2026-10-05').offersOut === 1);
}

// --- names: ONE spelling, and it honours the preferred name ---
{
  ok('REVIEW preferred name wins', subDisplayName({ first_name: 'Robert', preferred_name: 'Bob', last_name: 'Smith' }) === 'Bob Smith');
  ok('REVIEW falls back to the legal first name', subDisplayName({ first_name: 'Robert', last_name: 'Smith' }) === 'Robert Smith');
  ok('REVIEW an empty preferred name does not blank the row', subDisplayName({ first_name: 'Robert', preferred_name: '', last_name: 'Smith' }) === 'Robert Smith');
  ok('REVIEW a missing last name does not print undefined', subDisplayName({ first_name: 'Ann' }) === 'Ann');
  ok('no instructor record still renders something', subDisplayName(null) === 'Sub');
  ok('REVIEW an empty record renders something', subDisplayName({}) === 'Sub');
}

// --- a missing instructor record must not blank the card ---
{
  const s = aggregateSubSlot([row('confirmed', null, 'i-ann')]);
  ok('no instructor record still ticks', subSlotLabelText(s) === 'Sub ✓');
}

// --- REVIEW round 2: a day somebody already refused, with an offer still out,
//     is AT RISK. It must not read like a healthy first offer, and it must
//     agree with the RPC's 'at_risk' state. ---
{
  const s = aggregateSubSlot([
    row('declined', ann, 'i-ann', { decline_reason: 'busy' }),
    row('declined', bo, 'i-bo', { decline_reason: 'away' }),
    row('pending', cy, 'i-cy'),
  ]);
  ok('REVIEW2 an unanswered offer does not erase the declines', s.declineCount === 2);
  ok('REVIEW2 the day still reads as needing cover', slotNeedsCover(s) === true);
  const l = subSlotLabel(s);
  ok('REVIEW2 the marker says needs cover, not pending', l.marker === '· needs cover');
  ok('REVIEW2 and its tone is uncovered, not the calm pending', l.tone === 'uncovered');
  ok('REVIEW2 the note counts who said no', l.note === '2 said no');
  ok('REVIEW2 a clean first offer is still calm',
    subSlotLabel(aggregateSubSlot([row('pending', ann, 'i-ann')])).tone === 'pending');
}

// --- REVIEW round 2: losing a first-come race is NOT declining. The JS half
//     must filter covered_by_other exactly as the RPC does, or the card and the
//     banner above it contradict each other about the same day. ---
{
  const s = aggregateSubSlot([
    row('declined', ann, 'i-ann', { decline_reason: 'covered_by_other' }),
    row('declined', bo, 'i-bo', { decline_reason: 'covered_by_other' }),
    row('pending', cy, 'i-cy'),
  ]);
  ok('REVIEW2 auto-declines are not people who said no', s.declineCount === 0);
  ok('REVIEW2 so the day is not flagged as refused', slotNeedsCover(s) === false);
  ok('REVIEW2 and it reads as an ordinary live offer', subSlotLabel(s).marker === '· pending');

  const mixed = aggregateSubSlot([
    row('declined', ann, 'i-ann', { decline_reason: 'covered_by_other' }),
    row('declined', bo, 'i-bo', { decline_reason: 'cannot make it' }),
  ]);
  ok('REVIEW2 a real refusal alongside an auto-decline counts once', mixed.declineCount === 1);
  ok('REVIEW2 and still needs cover', slotNeedsCover(mixed) === true);
}

console.log(`\nsubCoverage: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
