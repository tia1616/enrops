// Pins the shared care-editing rules. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// THE FIRST TWO BLOCKS ARE THE POINT OF THIS FILE, and both are about data loss
// rather than about validation:
//
//   1. replace_student_pickup_dnr_guardian DELETEs every authorized_pickup,
//      do_not_release and guardian row for the child and re-INSERTs from the
//      payload. So a screen that fails to send a row DELETES it. "The parent
//      cannot remove a do-not-release name" is therefore not a hidden button -
//      it is a promise about the SAVE, and that is what these tests hold.
//   2. The same replace means any FIELD a screen fails to load is a field the
//      next save writes NULL over.
import {
  careProblem, careRpcArgs, careSaveMessage, doNotReleaseToSave,
  homeroomPatch, lockedDoNotRelease, isLockedContact, toRpcContact,
  CARE_CONTACT_COLUMNS,
} from './studentCare.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- a parent may add to the do-not-release list, never remove from it -------

const savedDnr = [
  { id: 'c1', role: 'do_not_release', first_name: 'Alex', last_name: 'Stone', phone: '555-0111' },
  { id: 'c2', role: 'do_not_release', first_name: 'Rene', last_name: 'Marsh' },
];
const locked = lockedDoNotRelease([...savedDnr, { id: 'p1', role: 'authorized_pickup', first_name: 'Gran', last_name: 'Byron' }]);

eq('only do-not-release rows are locked', locked.length, 2);
eq('a pickup row is NOT locked', locked.some((c) => c.first_name === 'Gran'), false);
eq('locked rows are marked', locked.every(isLockedContact), true);

// The save carries every locked row through. If this ever returns fewer rows
// than went in, the RPC's DELETE has silently removed a custody entry.
eq('a parent adding a name keeps both saved ones',
  doNotReleaseToSave([...locked, { first_name: 'Jo', last_name: 'Vance' }]).map((c) => c.first_name),
  ['Alex', 'Rene', 'Jo']);
eq('a parent saving with no additions still keeps both',
  doNotReleaseToSave(locked).map((c) => c.first_name), ['Alex', 'Rene']);
// THE FAILURE THIS FILE EXISTS FOR: a screen that drops the locked rows from its
// state deletes them. Proven rather than asserted in a comment.
eq('dropping the locked rows is what deletion LOOKS like',
  doNotReleaseToSave([{ first_name: 'Jo', last_name: 'Vance' }]).map((c) => c.first_name), ['Jo']);
// An operator CAN remove: they pass a list with the locked row absent, and
// nothing here resurrects it. Same function, different caller, no second rule.
eq('an operator removing one is honoured',
  doNotReleaseToSave([locked[1]]).map((c) => c.first_name), ['Rene']);
// The empty placeholder row every list renders must never be saved and must
// never count as an addition.
eq('an empty added row is not saved',
  doNotReleaseToSave([...locked, { first_name: '', last_name: '' }]).length, 2);
eq('a whitespace-only added row is not saved',
  doNotReleaseToSave([...locked, { first_name: '   ', last_name: '' }]).length, 2);
eq('a non-array is empty, not a crash', doNotReleaseToSave(null), []);

// THE PHANTOM "Name on file" (found by /code-review, 2026-08-31). The parent
// editor re-locks the list after a save so a name just added reads as on file.
// Re-locking the RAW ON-SCREEN state also locked the blank row that "+ Add a
// name" pushes, so it came back as an entry rendering "Name on file" - on a
// custody record - that the parent could not remove. The database was correct
// the whole time; only the screen lied. Re-baseline from doNotReleaseToSave(),
// which is the exact list the RPC received.
const rebaseline = (list) =>
  lockedDoNotRelease(doNotReleaseToSave(list).map((c) => ({ ...c, role: 'do_not_release' })));
eq('a blank added row does not come back as a locked ghost',
  rebaseline([...locked, { first_name: '', last_name: '' }]).map((c) => c.first_name),
  ['Alex', 'Rene']);
eq('a whitespace-only added row does not either',
  rebaseline([...locked, { first_name: '   ', last_name: '  ' }]).length, 2);
eq('a real addition DOES come back locked',
  rebaseline([...locked, { first_name: 'Jo', last_name: 'Vance' }]).map((c) => c.first_name),
  ['Alex', 'Rene', 'Jo']);
eq('everything the re-baseline returns is locked',
  rebaseline([...locked, { first_name: 'Jo', last_name: 'Vance' }]).every(isLockedContact), true);

// --- a carried-through row keeps every field the RPC inserts -----------------
// The RPC writes relationship and notes from the payload, so a row that loses
// them on the round trip has them NULLed. Nothing populates those columns today
// on either environment, which is exactly why dropping them would go unnoticed.

eq('the select list carries relationship and notes',
  ['relationship', 'notes', 'phone', 'email'].every((c) => CARE_CONTACT_COLUMNS.includes(c)), true);
eq('a carried row keeps relationship and notes',
  toRpcContact({ id: 'x', student_id: 's', sort_order: 3, first_name: 'Alex', last_name: 'Stone', phone: '555', email: 'a@b.c', relationship: 'uncle', notes: 'court order' }),
  { first_name: 'Alex', last_name: 'Stone', phone: '555', email: 'a@b.c', relationship: 'uncle', notes: 'court order' });
// id / student_id / sort_order are re-derived by the function. Echoing the id
// back would try to reuse a primary key the DELETE just removed.
eq('a carried row does NOT echo id, student_id or sort_order',
  Object.keys(toRpcContact({ id: 'x', student_id: 's', sort_order: 3, first_name: 'A' })), ['first_name']);
eq('blank fields are omitted rather than sent as empty strings',
  toRpcContact({ first_name: 'A', last_name: '', phone: null }), { first_name: 'A' });

// --- the RPC arguments -------------------------------------------------------

const baseData = { dismissal_method: 'walks_or_bikes_home', pickup: [], doNotRelease: [], guardian2: {} };
const args = careRpcArgs({ studentId: 'stu', organizationId: 'org', data: baseData });
// Migration 20260807b gave the 7th parameter NO default, so the 6-arg and 7-arg
// overloads coexist. Omitting it resolves to the OLD function and silently drops
// the aftercare destination - so it must be present even when null.
eq('p_aftercare_provider is always sent, even as null',
  Object.prototype.hasOwnProperty.call(args, 'p_aftercare_provider'), true);
eq('p_aftercare_provider is null when there is none', args.p_aftercare_provider, null);
eq('an empty guardian is an empty array, not [{}]', args.p_guardian, []);
eq('a named guardian is sent',
  careRpcArgs({ studentId: 's', organizationId: 'o', data: { ...baseData, guardian2: { first_name: 'Pat', last_name: 'Byron', email: 'p@b.c' } } }).p_guardian,
  [{ first_name: 'Pat', last_name: 'Byron', email: 'p@b.c' }]);
// Same wide rule the registration form saves by: prod holds "Club K Teachers"
// with no surname, and filtering the save strictly would delete it.
eq('a single-name pickup row is still saved',
  careRpcArgs({ studentId: 's', organizationId: 'o', data: { ...baseData, pickup: [{ first_name: 'Club K Teachers', last_name: '' }] } }).p_pickup,
  [{ first_name: 'Club K Teachers' }]);
eq('an empty dismissal answer is null, not ""',
  careRpcArgs({ studentId: 's', organizationId: 'o', data: { ...baseData, dismissal_method: '' } }).p_dismissal_method, null);

// A caller that never loaded the do-not-release rows would send [] and DELETE
// the child's custody entries with a success toast. undefined (never loaded) and
// [] (loaded, none) must not look alike.
function throws(name, fn) {
  try { fn(); fail++; console.error(`FAIL  ${name}\n  expected: a throw\n  actual:   returned`); }
  catch { pass++; console.log(`PASS  ${name}`); }
}
throws('an unloaded do-not-release list throws rather than deleting',
  () => careRpcArgs({ studentId: 's', organizationId: 'o', data: { dismissal_method: 'bus', pickup: [] } }));
throws('an explicit undefined throws too',
  () => careRpcArgs({ studentId: 's', organizationId: 'o', data: { ...baseData, doNotRelease: undefined } }));
throws('null is not an empty list',
  () => careRpcArgs({ studentId: 's', organizationId: 'o', data: { ...baseData, doNotRelease: null } }));
eq('a loaded-but-empty list is a legitimate save',
  careRpcArgs({ studentId: 's', organizationId: 'o', data: { ...baseData, doNotRelease: [] } }).p_do_not_release, []);

// --- what blocks a save ------------------------------------------------------

const dismissalOn = { dismissal_method: { enabled: true, required: true } };
eq('no data at all is the loading sentinel', careProblem({}, null), 'loading');
eq('a complete answer is not blocked', careProblem(dismissalOn, baseData), null);
eq('an unanswered dismissal question blocks',
  careProblem(dismissalOn, { ...baseData, dismissal_method: '' }), 'Choose how this child leaves.');
// The database raises on this too, so an editor that skipped the check would
// turn a knowingly-incomplete save into a 500 instead of a sentence.
eq('aftercare with no program named blocks',
  careProblem(dismissalOn, { ...baseData, dismissal_method: 'aftercare', aftercare_provider: '' }),
  'Add which aftercare program they go to.');
eq('aftercare WITH a program named is fine',
  careProblem(dismissalOn, { ...baseData, dismissal_method: 'aftercare', aftercare_provider: 'A4L' }), null);
// A family whose only collectors are the parents has nobody to name. Demanding
// one here is the 24 Aug wall, on a screen with no way past.
eq('an empty pickup list never blocks',
  careProblem({ ...dismissalOn, authorized_pickup: { enabled: true, required: true } },
    { ...baseData, dismissal_method: 'released_to_authorized_adult', pickup: [] }), null);
eq('a required do-not-release question with no name blocks',
  careProblem({ ...dismissalOn, do_not_release: { enabled: true, required: true } }, baseData),
  'Add the name(s) we should not release this child to.');
// Strict rule for "is it answered": one word is not a person at a school door.
eq('a first name alone does not satisfy a required do-not-release question',
  careProblem({ ...dismissalOn, do_not_release: { enabled: true, required: true } },
    { ...baseData, doNotRelease: [{ first_name: 'Alex' }] }),
  'Add the name(s) we should not release this child to.');
eq('a full name does satisfy it',
  careProblem({ ...dismissalOn, do_not_release: { enabled: true, required: true } },
    { ...baseData, doNotRelease: [{ first_name: 'Alex', last_name: 'Stone' }] }), null);
// An org that does not ask the dismissal question cannot block on it.
eq('no dismissal question means no dismissal block',
  careProblem({}, { ...baseData, dismissal_method: '' }), null);

// --- the same person cannot be on both lists ---------------------------------
// The database enforces this with a constraint trigger, so every writer inherits
// it. Three screens used to write their own sentence for it, in two different
// wordings; the rule and the sentence now live here once. The NAMES are in the
// sentence because a roster row can carry four people.

const clash = (pickup, dnr) => careProblem(dismissalOn, { ...baseData, pickup, doNotRelease: dnr });
eq('one clashing name is named, singular',
  clash([{ first_name: 'Pat', last_name: 'Byron' }], [{ first_name: 'Pat', last_name: 'Byron' }]),
  'Pat Byron is on both the pickup and do-not-release lists. Remove that name from one.');
eq('two clashing names are named, plural',
  clash([{ first_name: 'Pat', last_name: 'Byron' }, { first_name: 'Jo', last_name: 'Vance' }],
        [{ first_name: 'Jo', last_name: 'Vance' }, { first_name: 'Pat', last_name: 'Byron' }]),
  'Jo Vance, Pat Byron are on both the pickup and do-not-release lists. Remove them from one.');
// Matched the way the trigger matches: lower + trim on first AND last. If these
// disagreed, the screen would pass something the database then rejected.
eq('case and whitespace do not hide a clash',
  clash([{ first_name: ' PAT ', last_name: 'byron' }], [{ first_name: 'Pat', last_name: 'Byron ' }]),
  'PAT byron is on both the pickup and do-not-release lists. Remove that name from one.');
eq('different people do not clash',
  clash([{ first_name: 'Pat', last_name: 'Byron' }], [{ first_name: 'Alex', last_name: 'Stone' }]), null);
// The empty placeholder row every list renders is not a person, so two empty
// rows must not read as the same person on both lists.
eq('two empty rows are not a clash', clash([{ first_name: '', last_name: '' }], [{ first_name: '', last_name: '' }]), null);
// A basic unanswered question comes FIRST: a family that has not said how their
// child leaves does not need to hear about a list clash instead.
eq('an unanswered dismissal question outranks a clash',
  careProblem(dismissalOn, { ...baseData, dismissal_method: '', pickup: [{ first_name: 'Pat', last_name: 'Byron' }], doNotRelease: [{ first_name: 'Pat', last_name: 'Byron' }] }),
  'Choose how this child leaves.');

// --- homeroom writes only when it changed ------------------------------------
// It is NOT part of the RPC (Jessica, 2026-08-28: an 8th argument would make a
// third spelling of one write path). Sending nothing when nothing changed is
// what stops this becoming a whole-row write that reverts another screen.

eq('an unchanged homeroom sends nothing', homeroomPatch('Ms. Smith', 'Ms. Smith'), null);
eq('whitespace-only difference sends nothing', homeroomPatch('Ms. Smith', '  Ms. Smith  '), null);
eq('null and empty are the same absence', homeroomPatch(null, ''), null);
eq('undefined and empty are the same absence', homeroomPatch(undefined, '   '), null);
eq('a new value is sent trimmed', homeroomPatch('', ' Ms. Frizzle '), { homeroom_teacher: 'Ms. Frizzle' });
eq('a changed value is sent', homeroomPatch('Ms. Smith', 'Mr. Jones'), { homeroom_teacher: 'Mr. Jones' });
// Clearing it must write NULL, not "". The column is free text and "" would sort
// and display differently from every other empty row - prod already carries four
// spellings of "unknown" without adding a fifth kind of blank.
eq('clearing it writes NULL, not an empty string', homeroomPatch('Ms. Smith', ''), { homeroom_teacher: null });

// --- error sentences ---------------------------------------------------------
// The two the database already wrote to a person are passed through; the two
// carrying raw uuids are not.

const overlap = 'Contact "Pat Byron" cannot be on both the approved pickup list and the do-not-release list for the same student.';
eq('the pickup conflict keeps the contact NAME', careSaveMessage({ message: overlap }), overlap);
eq('the aftercare raise is passed through',
  careSaveMessage({ message: 'Please tell us which aftercare program this child goes to.' }),
  'Please tell us which aftercare program this child goes to.');
eq('an authorization failure never shows the student id',
  careSaveMessage({ message: 'not authorized to edit contacts for student 9445a268-0000-0000-0000-000000000000' }),
  "You don't have permission to change this child's details.");
eq('an org mismatch never shows the ids',
  careSaveMessage({ message: 'student 9445a268-... not in organization 1adf10ad-...' }),
  "Sorry, that didn't save. Please try again.");
// The proxy-predicate guard: an unrelated failure that merely contains a common
// word must NOT be relabelled as a pickup conflict. An earlier draft matched
// `includes('both')` and would have.
eq('an unrelated error mentioning "both" is not called a pickup conflict',
  careSaveMessage({ message: 'could not save both records' }),
  "Sorry, that didn't save. Please try again.");
eq('no error object at all still yields a sentence',
  careSaveMessage(null), "Sorry, that didn't save. Please try again.");

console.log(`\nstudentCare: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
