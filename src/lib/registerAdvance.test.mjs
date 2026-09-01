// Pins the registration wizard's advance guard. Repo convention: plain node
// script with a pass/fail counter, run by scripts/run-src-tests.mjs.
//
// TWO THINGS ARE UNDER TEST AND THE SECOND IS THE POINT.
//   1. WHO is blocked - identical to the boolean canAdvance() returned before,
//      because telling a family why they are stuck must not change who is stuck.
//   2. THAT A SENTENCE COMES BACK. The 24 Aug defect was a required pickup list
//      greying Continue out with nothing anywhere on the page saying so, so every
//      blocking condition here asserts a non-null message, and the three
//      list-shaped ones assert what it actually says.
import { advanceProblem, hasAnswer } from './registerAdvance.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }
// Asserts blocked AND that the parent is told something - the pairing the whole
// file exists to defend. A bare `!== null` would pass on an empty string.
function blocked(name, state, contains) {
  const r = advanceProblem(state);
  const msg = r?.message;
  if (typeof msg === 'string' && msg.length > 0 && (!contains || msg.includes(contains))) {
    pass++; console.log(`PASS  ${name}`);
  } else {
    fail++; console.error(`FAIL  ${name}\n  expected: a message${contains ? ` containing ${JSON.stringify(contains)}` : ''}\n  actual:   ${JSON.stringify(r)}`);
  }
}
// Every reason must also name the field it is about, or "Take me there" lands
// nowhere. Asserted separately so a missing focus key fails loudly rather than
// silently degrading to a warning with a dead button on it.
function focusOf(name, state, expected) { eq(name, advanceProblem(state)?.focus, expected); }
function clear(name, state) { eq(name, advanceProblem(state), null); }

// A lean org's step 0, complete. Lean makes grade optional, and `regFields.std`
// is empty below, so no configured question is on either - homeroom included.
const goodStudent = {
  first_name: 'Ada', last_name: 'Lovelace', birthdate: '2017-05-04',
  emergency_contact_name: 'Annabella Byron', emergency_contact_phone: '555-0100',
};
const step0 = (over = {}) => ({
  step: 0, isLean: true, regFields: { std: {}, custom: [] }, conflicts: [],
  activeChild: { student: { ...goodStudent }, ...over.activeChild },
  ...over,
});

// --- step 0: the base fields still block, and now they say which -----------

clear('a complete lean student advances', step0());
blocked('missing first name', step0({ activeChild: { student: { ...goodStudent, first_name: '' } } }), 'first name');
blocked('missing last name', step0({ activeChild: { student: { ...goodStudent, last_name: '' } } }), 'last name');
blocked('missing birthdate', step0({ activeChild: { student: { ...goodStudent, birthdate: '' } } }), 'date of birth');
blocked('missing emergency contact name', step0({ activeChild: { student: { ...goodStudent, emergency_contact_name: '' } } }), 'emergency contact name');
blocked('missing emergency contact phone', step0({ activeChild: { student: { ...goodStudent, emergency_contact_phone: '' } } }), 'phone');

// --- step 0: lean vs full nav -----------------------------------------------
// Grade is full-nav only. A lean org renders it optional, so requiring it there
// would be a wall with no field to fix it in.

const fullNav = { isLean: false, activeChild: { student: { ...goodStudent, grade: '2' } } };
clear('full-nav student with a grade advances', step0(fullNav));
blocked('full nav: empty grade blocks', step0({ isLean: false, activeChild: { student: { ...goodStudent, grade: '' } } }), 'grade');
// Preserved from the old boolean ON PURPOSE: `grade !== ''` lets undefined past.
// Tightening it would newly block families who can submit today.
clear('full nav: an absent grade key is not blocked (unchanged behaviour)', step0({ isLean: false, activeChild: { student: { ...goodStudent } } }));
clear('lean org ignores grade', step0({ activeChild: { student: { ...goodStudent, grade: '' } } }));

// --- step 0: homeroom teacher is CONFIGURED, not lean-vs-legacy -------------
// Until 2026-08-31 this was `!isLean`, i.e. gated on instructor_pay_model - a
// BILLING column - so j2s was the only org of seven whose families were ever
// asked. It is now the fifth standard question and the guard reads the same
// `required` flag the label's asterisk reads.
//
// THE PAIR THAT MATTERS IS THE SECOND AND THIRD. A provider who has the question
// on but optional must NOT be blocked (that is the new default), and a provider
// who has it on and mandatory must still be blocked exactly as j2s was on
// 2026-08-24 - whatever pay model either of them is on. Testing only the lean
// case would have let the required half rot silently.

const homeroomReq = { std: { homeroom_teacher: { enabled: true, required: true } }, custom: [] };
const homeroomOptional = { std: { homeroom_teacher: { enabled: true, required: false } }, custom: [] };

clear('homeroom off: a blank homeroom does not block', step0({ activeChild: { student: { ...goodStudent, homeroom_teacher: '' } } }));
clear('homeroom on but optional: a blank homeroom does not block', step0({ regFields: homeroomOptional, activeChild: { student: { ...goodStudent, homeroom_teacher: '' } } }));
blocked('homeroom required: an empty homeroom blocks', step0({ regFields: homeroomReq, activeChild: { student: { ...goodStudent, homeroom_teacher: '' } } }), 'homeroom');
blocked('homeroom required: whitespace only blocks', step0({ regFields: homeroomReq, activeChild: { student: { ...goodStudent, homeroom_teacher: '   ' } } }), 'homeroom');
blocked('homeroom required: an absent key blocks', step0({ regFields: homeroomReq }), 'homeroom');
clear('homeroom required and answered advances', step0({ regFields: homeroomReq, activeChild: { student: { ...goodStudent, homeroom_teacher: 'Ms. Frizzle' } } }));
// A LEAN org can now require it, which the old gate made impossible. This is the
// whole point of the change: the question follows the provider's configuration,
// never their pay model.
blocked('a LEAN org that requires homeroom blocks too', step0({ isLean: true, regFields: homeroomReq, activeChild: { student: { ...goodStudent, homeroom_teacher: '' } } }), 'homeroom');
// And a full-nav org that has NOT enabled it is not blocked - the mirror image,
// and the case that proves the guard stopped reading isLean at all.
clear('a full-nav org with the question off is not blocked', step0({ isLean: false, activeChild: { student: { ...goodStudent, grade: '2', homeroom_teacher: '' } } }));

// --- step 0: the birth date reason is the SAME string shown inline ----------

blocked('an implausible birth date blocks and explains', step0({ activeChild: { student: { ...goodStudent, birthdate: '1980-12-18' } } }), 'years old');

// --- step 0: dismissal -----------------------------------------------------

const dismissalReq = { std: { dismissal_method: { required: true } }, custom: [] };
blocked('required dismissal method, unanswered', step0({ regFields: dismissalReq }), 'how your child leaves');
clear('required dismissal method, answered', step0({
  regFields: dismissalReq,
  activeChild: { student: { ...goodStudent, dismissal_method: 'walks_or_bikes_home' } },
}));
blocked('aftercare chosen with no program named', step0({
  regFields: dismissalReq,
  activeChild: { student: { ...goodStudent, dismissal_method: 'aftercare' } },
}), 'aftercare program');
clear('aftercare with the program named', step0({
  regFields: dismissalReq,
  activeChild: { student: { ...goodStudent, dismissal_method: 'aftercare', aftercare_provider: 'Champions' } },
}));

// --- step 0: THE 24 AUG WALL - required authorized pickup ------------------
// Jasmine Conn's shape: released to an adult, required pickup list, nothing
// named. Before this file, Continue simply went grey.
//
// READ THIS BEFORE CHANGING THE BLOCK BELOW. As of 25 Aug 2026 these inputs can
// no longer arise on a real form: parseRegFields() runs every standard question
// through standardQuestionRequired(), and pickup / do-not-release / second
// guardian always come back optional (src/lib/registrationQuestions.js, pinned by
// registrationQuestions.test.mjs). These stay as CONTRACT tests of the guard
// itself - given a required question, it blocks and says why - because the guard
// must not silently ignore a `required` it is handed. They are not a claim that a
// provider can still arm these three.

const pickupReq = {
  std: { dismissal_method: { required: true }, authorized_pickup: { required: true } },
  custom: [],
};
const releasedToAdult = { ...goodStudent, dismissal_method: 'released_to_authorized_adult' };

blocked('required pickup list, nobody named', step0({ regFields: pickupReq, activeChild: { student: releasedToAdult } }),
  'first and last name');
blocked('required pickup list, empty placeholder row', step0({
  regFields: pickupReq,
  activeChild: { student: releasedToAdult, authorized_pickup: [{ first_name: '', last_name: '', phone: '' }] },
}), 'first and last name');
// Half a name looks like an answered form and is not one. The message says
// "first and last name" precisely so this case is not a second silent wall.
blocked('required pickup list, first name only', step0({
  regFields: pickupReq,
  activeChild: { student: releasedToAdult, authorized_pickup: [{ first_name: 'Pat', last_name: '' }] },
}), 'first and last name');
blocked('required pickup list, whitespace last name', step0({
  regFields: pickupReq,
  activeChild: { student: releasedToAdult, authorized_pickup: [{ first_name: 'Pat', last_name: '  ' }] },
}), 'first and last name');
clear('required pickup list, one fully named person', step0({
  regFields: pickupReq,
  activeChild: { student: releasedToAdult, authorized_pickup: [{ first_name: 'Pat', last_name: 'Byron' }] },
}));
// Only the released-to-adult answer pulls the list in. A child who walks home
// must not be asked who collects them.
clear('pickup list not required when the child walks home', step0({
  regFields: pickupReq,
  activeChild: { student: { ...goodStudent, dismissal_method: 'walks_or_bikes_home' } },
}));
// An org that enabled pickup WITHOUT the dismissal question always needs it.
blocked('pickup required with no dismissal question at all', step0({
  regFields: { std: { authorized_pickup: { required: true } }, custom: [] },
  activeChild: { student: { ...goodStudent } },
}), 'first and last name');
// Optional means optional - the prod settings change of 24 Aug must keep working.
clear('optional pickup list, nobody named', step0({
  regFields: { std: { dismissal_method: { required: true }, authorized_pickup: { required: false } }, custom: [] },
  activeChild: { student: releasedToAdult },
}));

// --- step 0: a one-name row must NOT block checkout -------------------------
// A draft of this demanded both names on every row. Prod says that is wrong:
// its three single-name pickup entries read "Club K Teachers", "Casey Negrieff"
// and "AINSWORTH AFTERCARE - MOST DAYS". Families use the box as free text, so
// asking for a surname would tell a parent to add a last name for a club and
// leave deleting a real instruction as the only way past. These pin that the
// blocker is gone and stays gone.

for (const real of ['Club K Teachers', 'Casey Negrieff', 'AINSWORTH AFTERCARE - MOST DAYS']) {
  clear(`a real prod entry "${real}" does not block checkout`, step0({
    activeChild: { student: { ...goodStudent }, authorized_pickup: [{ first_name: real, last_name: '' }] },
  }));
}
clear('a surname-only row does not block', step0({
  activeChild: { student: { ...goodStudent }, authorized_pickup: [{ first_name: '', last_name: 'Byron' }] },
}));
clear('a one-name do-not-release row does not block', step0({
  activeChild: { student: { ...goodStudent }, do_not_release: [{ first_name: 'Uncle' }] },
}));
clear('the untouched placeholder row does not block', step0({
  activeChild: { student: { ...goodStudent }, authorized_pickup: [{ first_name: '', last_name: '', phone: '' }] },
}));
// It still does not COUNT, though - that is the half the strict rule keeps. With
// pickup mandatory, a one-name row is not an answer.
blocked('a one-name row does not satisfy a MANDATORY pickup question', step0({
  regFields: pickupReq,
  activeChild: { student: releasedToAdult, authorized_pickup: [{ first_name: 'Club K Teachers', last_name: '' }] },
}), 'first and last name');

// --- step 0: required do-not-release ---------------------------------------

const dnrReq = { std: { do_not_release: { required: true } }, custom: [] };
blocked('required do-not-release, nobody named', step0({ regFields: dnrReq }), 'not release');
blocked('required do-not-release, last name only', step0({
  regFields: dnrReq, activeChild: { student: { ...goodStudent }, do_not_release: [{ first_name: '', last_name: 'Byron' }] },
}), 'not release');
clear('required do-not-release, one fully named person', step0({
  regFields: dnrReq, activeChild: { student: { ...goodStudent }, do_not_release: [{ first_name: 'Pat', last_name: 'Byron' }] },
}));
clear('optional do-not-release, nobody named', step0({ regFields: { std: { do_not_release: { required: false } }, custom: [] } }));

// --- step 0: custom questions name themselves ------------------------------

const customReq = { std: {}, custom: [{ id: 1, field_key: 'allergies', field_type: 'text', is_required: true, label: 'Any allergies?' }] };
blocked('required custom question, unanswered', step0({ regFields: customReq }), 'Any allergies?');
blocked('required custom question, whitespace answer', step0({
  regFields: customReq, activeChild: { student: { ...goodStudent }, custom_answers: { allergies: '   ' } },
}), 'Any allergies?');
clear('required custom question, answered', step0({
  regFields: customReq, activeChild: { student: { ...goodStudent }, custom_answers: { allergies: 'Peanuts' } },
}));
clear('optional custom question, unanswered', step0({
  regFields: { std: {}, custom: [{ id: 1, field_key: 'allergies', field_type: 'text', is_required: false, label: 'Any allergies?' }] },
}));

// --- step 0: the pickup / do-not-release overlap ---------------------------

blocked('a name on both lists blocks', step0({ conflicts: ['Pat Byron'] }), 'both');

// --- step 1: parent, and the second guardian -------------------------------

const goodParent = { first_name: 'Anne', last_name: 'Byron', email: 'anne@example.com', phone: '555-0111' };
const step1 = (over = {}) => ({
  step: 1, regFields: { std: {}, custom: [] }, activeChild: {}, parent: { ...goodParent }, ...over,
});

clear('a complete parent advances', step1());
blocked('missing parent first name', step1({ parent: { ...goodParent, first_name: '' } }), 'first name');
blocked('missing parent email', step1({ parent: { ...goodParent, email: '' } }), 'email');
blocked('missing parent phone', step1({ parent: { ...goodParent, phone: '' } }), 'phone');

const g2Req = { std: { guardian_secondary: { required: true, label: 'Second Adult Contact' } }, custom: [] };
blocked('required second guardian, absent', step1({ regFields: g2Req }), 'second adult contact');
blocked('required second guardian, first name only', step1({
  regFields: g2Req, parent: { ...goodParent, guardian2: { first_name: 'Ada', last_name: '' } },
}), 'second adult contact');
clear('required second guardian, fully named', step1({
  regFields: g2Req, parent: { ...goodParent, guardian2: { first_name: 'Ada', last_name: 'Byron' } },
}));
clear('optional second guardian, absent', step1({ regFields: { std: { guardian_secondary: { required: false } }, custom: [] } }));

// --- step 2: waivers name themselves ---------------------------------------

const waivers = [
  { id: 'w1', name: 'Photo Release', required: false },
  { id: 'w2', name: 'Liability Waiver', required: true },
  { id: 'w3', name: 'Program Fit Policy', required: true },
];
const step2 = (agreed) => ({ step: 2, regFields: { std: {}, custom: [] }, waivers, activeChild: { waivers: agreed } });

blocked('two required waivers unsigned says how many', step2({}), '2 still need');
blocked('one required waiver left names it', step2({ w2: { agreed: true } }), 'program fit policy');
clear('both required waivers agreed', step2({ w2: { agreed: true }, w3: { agreed: true } }));
clear('an optional waiver left unsigned does not block', step2({ w2: { agreed: true }, w3: { agreed: true }, w1: { agreed: false } }));
// Only `true` counts - the checkbox writes a boolean and a stale string must not
// buy a signature on a legal document.
blocked('a truthy-but-not-true agreement does not count', step2({ w2: { agreed: 'yes' }, w3: { agreed: true } }), 'liability waiver');

// --- step 3 and the guard's own edges --------------------------------------

clear('review step always advances', { step: 3, regFields: { std: {}, custom: [] }, activeChild: {} });
blocked('an unknown step blocks with a sentence', { step: 9, regFields: { std: {}, custom: [] }, activeChild: {} });
// Called with nothing at all during an early render must not throw.
blocked('no arguments at all does not throw', undefined);
ok('a bare call still returns a reason object', typeof advanceProblem()?.message === 'string');

// --- hasAnswer, by field type ----------------------------------------------

eq('text: whitespace is not an answer', hasAnswer('   ', 'text'), false);
eq('text: a value is an answer', hasAnswer('Peanuts', 'text'), true);
eq('checkbox: false is not an answer', hasAnswer(false, 'checkbox'), false);
eq('checkbox: true is an answer', hasAnswer(true, 'checkbox'), true);
eq('checkbox: the string "true" is an answer', hasAnswer('true', 'checkbox'), true);
eq('multiselect: an empty array is not an answer', hasAnswer([], 'multiselect'), false);
eq('multiselect: one choice is an answer', hasAnswer(['a'], 'multiselect'), true);
eq('number: zero IS an answer', hasAnswer(0, 'number'), true);
eq('number: empty string is not', hasAnswer('', 'number'), false);
eq('number: null is not', hasAnswer(null, 'number'), false);

// --- every reason names a field, and it is the RIGHT field -----------------
// "Take me there" queries [data-reg-field="<focus>"]. A wrong or missing key is
// invisible in the message, so it is pinned here rather than trusted.

focusOf('first name points at the first-name field', step0({ activeChild: { student: { ...goodStudent, first_name: '' } } }), 'student_first_name');
focusOf('grade points at the grade field', step0({ isLean: false, activeChild: { student: { ...goodStudent, grade: '' } } }), 'student_grade');
focusOf('homeroom points at the homeroom field', step0({ regFields: homeroomReq, activeChild: { student: { ...goodStudent, homeroom_teacher: '  ' } } }), 'student_homeroom');
focusOf('emergency name points at its own field', step0({ activeChild: { student: { ...goodStudent, emergency_contact_name: '' } } }), 'emergency_name');
focusOf('an implausible birth date points at the birth date', step0({ activeChild: { student: { ...goodStudent, birthdate: '1980-12-18' } } }), 'student_birthdate');
focusOf('dismissal points at the dismissal question', step0({ regFields: dismissalReq }), 'dismissal_method');
focusOf('aftercare points at the provider box, NOT the radios', step0({
  regFields: dismissalReq,
  activeChild: { student: { ...goodStudent, dismissal_method: 'aftercare' } },
}), 'aftercare_provider');
focusOf('the pickup wall points at the pickup list', step0({ regFields: pickupReq, activeChild: { student: releasedToAdult } }), 'authorized_pickup');
focusOf('do-not-release points at its own list', step0({ regFields: dnrReq }), 'do_not_release');
// The conflict is BETWEEN two lists; it points at the do-not-release one because
// that is where the named warning already renders.
focusOf('a both-lists conflict points at do-not-release', step0({ conflicts: ['Pat Byron'] }), 'do_not_release');
focusOf('a custom question points at itself by key', step0({ regFields: customReq }), 'custom:allergies');
focusOf('parent email points at the parent email', step1({ parent: { ...goodParent, email: '' } }), 'parent_email');
focusOf('the second guardian points at its section', step1({ regFields: g2Req }), 'guardian_secondary');
// With several unsigned, it points at the FIRST one so the jump is deterministic.
focusOf('waivers point at the first unsigned form', step2({}), 'waiver:w2');
focusOf('waivers skip one already agreed', step2({ w2: { agreed: true } }), 'waiver:w3');

console.log(`\nregisterAdvance: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
