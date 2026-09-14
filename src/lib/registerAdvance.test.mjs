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

// A lean org's step 0, complete. `regFields.std` is empty below, so no configured
// question is on - homeroom included.
//
// GRADE IS PART OF "COMPLETE" as of 2026-09-04. It was absent from this fixture
// while grade was full-nav-only, which quietly meant every `clear()` case in this
// file was asserting that a gradeless child advances. Adding it here rather than
// per-case is deliberate: the fixture is meant to be the child who should get
// through, and leaving it out would have turned two dozen unrelated assertions
// into grade tests that all fail for the same reason.
const goodStudent = {
  first_name: 'Ada', last_name: 'Lovelace', birthdate: '2017-05-04', grade: '2',
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

// --- step 0: grade is required of EVERY org ---------------------------------
// Jessica, 2026-09-04: "make grade required for lean orgs too and founders."
// Until then it was full-nav-only, and the lean half of the platform - which is
// every org except j2s, founding-plan tenants included - could check out without
// one. The pair that matters is the first two: the rule must not depend on
// `isLean`, so both values of it are asserted against the same blank.

const fullNav = { isLean: false, activeChild: { student: { ...goodStudent, grade: '2' } } };
clear('full-nav student with a grade advances', step0(fullNav));
blocked('full nav: empty grade blocks', step0({ isLean: false, activeChild: { student: { ...goodStudent, grade: '' } } }), 'grade');
blocked('LEAN: empty grade blocks too - the change of 2026-09-04', step0({ activeChild: { student: { ...goodStudent, grade: '' } } }), 'grade');
// THE CASE THAT WAS EXPLICITLY LET THROUGH BEFORE, and the one that describes
// Jeff's eleven: a child hydrated from a row saved before the field existed has
// no `grade` key at all, and the old `grade === ''` comparison could not see it.
// null is the same state arriving off the database rather than out of the form.
blocked('an absent grade key blocks', step0({ activeChild: { student: { ...goodStudent, grade: undefined } } }), 'grade');
blocked('a null grade blocks', step0({ activeChild: { student: { ...goodStudent, grade: null } } }), 'grade');
// KINDERGARTEN IS ZERO AND MUST NOT READ AS BLANK. A truthiness test passes the
// string "0" by luck and refuses the number 0, which is what a saved child
// carries - so the youngest cohort would have been the one group unable to
// register. Both spellings asserted, because both reach this guard.
clear('Kindergarten as the string "0" advances', step0({ activeChild: { student: { ...goodStudent, grade: '0' } } }));
clear('Kindergarten as the number 0 advances', step0({ activeChild: { student: { ...goodStudent, grade: 0 } } }));

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

// --- step 0: THE GRADE GATE ---------------------------------------------------
// Jessica, 2026-09-03: "we shouldn't allow people to register if they're not in
// the grade range. shouldn't be a warning should be a gate." It was a warning
// first, so these tests are what stop it quietly becoming one again.
//
// The measured cost of the rule, on prod the day it was decided: 29 of 414 live
// registrations were below the class range, every one paid, across 25 classes and
// both tenants. That is why the SILENT cases below matter as much as the blocking
// ones - each false block is a paid registration turned away.
const G25 = { id: 'p1', grade_min: 2, grade_max: 5, age_format: 'grade' };
const withClass = (grade, program = G25) => step0({
  isLean: false,
  orgName: 'Journey to STEAM',
  activeChild: { student: { ...goodStudent, grade }, items: [{ program }] },
});

blocked('a kindergartener is stopped from a Grades 2-5 class', withClass('0'), 'Grades 2–5');
blocked('a 6th grader is stopped from a Grades 2-5 class', withClass('6'), 'Grades 2–5');
focusOf('the gate points at the grade field', withClass('0'), 'student_grade');
// It must tell them what to do, not merely refuse.
blocked('the gate names the provider to ask', withClass('0'), 'Journey to STEAM');
blocked('the gate offers a class that fits', withClass('0'), 'Choose a class');

clear('inside the range advances', withClass('3'));
clear('the lower edge advances', withClass('2'));
clear('the upper edge advances', withClass('5'));

// THE FALSE-BLOCK CASES. Every one of these is a real registration that must
// still go through.
clear('an age-based class does not gate on grade',
  withClass('0', { id: 'p2', age_min: 5, age_max: 12, age_format: 'age', grade_min: null, grade_max: null }));
clear('a class stating no range does not gate', withClass('0', { id: 'p3' }));
clear('a backwards range is the operator typo, not the family\'s problem',
  withClass('3', { id: 'p4', grade_min: 5, grade_max: 2, age_format: 'grade' }));
clear('an open top does not invent an upper bound',
  withClass('11', { id: 'p5', grade_min: 2, grade_max: null, age_format: 'grade' }));
clear('an open bottom does not invent a lower bound',
  withClass('0', { id: 'p6', grade_min: null, grade_max: 6, age_format: 'grade' }));
// AN UNANSWERED GRADE IS REFUSED BY THE REQUIRED-CHECK, NOT BY THE FIT-CHECK, and
// the two say different sentences. Before 2026-09-04 a lean org could leave this
// blank and neither check fired. Now the first one does - and the assertion is on
// WHICH message comes back, because a family who has not answered yet must be
// told to answer, never told their child is the wrong age for the class.
blocked('a blank grade is refused as unanswered, not as a mismatch', step0({
  orgName: 'Cascade', activeChild: { student: { ...goodStudent, grade: '' }, items: [{ program: G25 }] },
}), "Choose your child's grade.");
// A cart with no items at all - the state before a program is chosen.
clear('no items means nothing to compare', step0({ isLean: false, activeChild: { student: { ...goodStudent, grade: '0' } } }));

// A VIP bundle is ONE item holding three term rows. Reading item.program alone
// would check only Fall, which is the bug self-review caught in the warning.
const bundleChild = (grade) => step0({
  isLean: false, orgName: 'Journey to STEAM',
  activeChild: {
    student: { ...goodStudent, grade },
    items: [{
      isVip: true,
      program: { id: 'f', grade_min: 0, grade_max: 8, age_format: 'grade' },
      vipBundle: {
        fall: { id: 'f', grade_min: 0, grade_max: 8, age_format: 'grade' },
        winter: { id: 'w', grade_min: 2, grade_max: 5, age_format: 'grade' },
        spring: { id: 's', grade_min: 0, grade_max: 8, age_format: 'grade' },
      },
    }],
  },
});
blocked('a VIP bundle is gated on its WINTER leg, not just Fall', bundleChild('6'), 'Grades 2–5');
clear('a VIP bundle whose every leg fits advances', bundleChild('3'));

// --- step 3: the last press before the card -----------------------------------
// Step 0 already refuses, so this only fires on a restored cart - which is
// exactly the case worth catching, because the next press takes money.
const review = (grade) => ({
  step: 3, isLean: false, orgName: 'Journey to STEAM', regFields: { std: {}, custom: [] }, conflicts: [],
  activeChild: { student: { ...goodStudent, grade }, items: [{ program: G25 }] },
});
blocked('review refuses an out-of-range grade', review('0'), 'Grades 2–5');
clear('review passes a grade that fits', review('3'));

// EVERY CHILD, not just the active one. One press pays for the whole cart, and
// checking only the active child let the button through while the review lines
// were already drawing a red box for the sibling - the server then refused the
// press in its own words, which is being told at the very end.
const twoKids = (activeGrade, otherGrade) => ({
  step: 3, isLean: false, orgName: 'Journey to STEAM',
  regFields: { std: {}, custom: [] }, conflicts: [],
  activeChild: { student: { ...goodStudent, grade: activeGrade }, items: [{ program: G25 }] },
  children: [
    { student: { ...goodStudent, grade: activeGrade }, items: [{ program: G25 }] },
    { student: { ...goodStudent, grade: otherGrade }, items: [{ program: G25 }] },
  ],
});
blocked('review refuses when a NON-active child is out of range', twoKids('3', '0'), 'Grades 2–5');
clear('review passes when every child fits', twoKids('3', '4'));
// The guard must never get weaker than it was when no cart is passed.
blocked('with no cart it still checks the active child', review('0'), 'Grades 2–5');
// Not 'student_grade': that field is three screens back and not in this DOM, so
// naming it would scroll to nothing.
focusOf('review names no field to scroll to', review('0'), '');

// A BLANK GRADE AT THE MONEY PRESS. This is not hypothetical: a cart started
// before 2026-09-04 saved a lean org's child with no grade legitimately, and a
// restored cart is the one way to reach this screen without step 0 running
// again. The sentence has to send them back rather than quote a class range,
// and it names the child because this screen shows the whole cart.
blocked('review refuses a blank grade on a restored cart', review(''), 'grade');
blocked('review names the child whose grade is missing', review(''), 'Ada');
blocked('review sends them back rather than quoting the range', review(''), 'Go back to the first step');
// A SIBLING'S BLANK GRADE GETS A DIFFERENT SENTENCE, because Back returns to the
// ACTIVE child's form and the wizard has no control that switches between
// children. Telling them to go back would be an instruction they cannot carry
// out. Asserted as an absence as well as a presence: the dead-end wording must
// not be what a sibling is shown.
blocked('review refuses a blank grade on a NON-active child', twoKids('3', ''), 'grade');
blocked('a sibling is named, not called "your child"', twoKids('3', ''), 'Ada');
blocked('a sibling is offered the provider as the way out', twoKids('3', ''), 'Journey to STEAM');
eq('a sibling is NOT told to go back to a screen that will not show them',
  advanceProblem(twoKids('3', ''))?.message.includes('Go back to the first step'), false);
// THE MIRROR, and the case that proves the branch is reading identity and not
// merely "is there more than one child". In the real cart `activeChild` IS
// `cart.children[active_child_index]` - the same object, not a copy - so the
// blank-graded ACTIVE child in a two-child cart still gets the instruction that
// works. Built with a shared reference on purpose; a spread copy here would pass
// the assertion for the wrong reason.
{
  const blankActive = { student: { ...goodStudent, grade: '' }, items: [{ program: G25 }] };
  const state = {
    step: 3, orgName: 'Journey to STEAM', regFields: { std: {}, custom: [] }, conflicts: [],
    activeChild: blankActive,
    children: [blankActive, { student: { ...goodStudent, grade: '4' }, items: [{ program: G25 }] }],
  };
  blocked('the ACTIVE child in a two-child cart is still told to go back', state, 'Go back to the first step');
}
// AND MUST NOT WALL THEM OVER A CHILD THEY ARE NOT PAYING FOR. A cart row with no
// items is a second child part-way through being added; it produces no
// registration, so a blank grade on it is not a roster gap - and refusing at the
// money press over it would be a wall with nothing on this screen to fix.
clear('review ignores a gradeless child with nothing in the cart', {
  step: 3, orgName: 'Journey to STEAM', regFields: { std: {}, custom: [] }, conflicts: [],
  activeChild: { student: { ...goodStudent, grade: '3' }, items: [{ program: G25 }] },
  children: [
    { student: { ...goodStudent, grade: '3' }, items: [{ program: G25 }] },
    { student: { first_name: 'Bram' }, items: [] },
  ],
});
// The blank check must not swallow the mismatch check: a child who HAS answered
// and does not fit still gets the class sentence.
blocked('an answered but out-of-range grade still gets the class message', review('0'), 'Grades 2–5');
focusOf('the blank-grade refusal also names no field to scroll to', review(''), '');

console.log(`\nregisterAdvance: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
