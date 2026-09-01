// Pins parseRegFields and the contact-name rule. Repo convention: plain node
// script with a pass/fail counter, run by scripts/run-src-tests.mjs.
//
// THE FIRST BLOCK IS THE POINT OF THIS FILE. parseRegFields is where the "which
// questions may be mandatory" rule is actually applied. While it lived in a .jsx
// module the test runner could not reach it, so the rule had a test and the
// guard that consumes it had a test and the line joining them had none - a
// refactor dropping the standardQuestionRequired() call would have left every
// test green and put the 24 Aug wall back on the live form.
import {
  parseRegFields, contactFullyNamed, namedContacts, contactsWithAnyName,
} from './registrationFields.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

const row = (over) => ({ standard_key: null, is_required: false, is_active: true, label: 'L', options: null, ...over });

// --- the rule is APPLIED, not merely available -----------------------------
// Each of these rows says is_required: true, exactly as staging's j2s and
// riverbend rows did before 25 Aug 2026.

for (const key of ['authorized_pickup', 'do_not_release', 'guardian_secondary']) {
  const { std } = parseRegFields([row({ standard_key: key, is_required: true })]);
  eq(`${key} is enabled`, std[key].enabled, true);
  eq(`${key} comes back OPTIONAL despite is_required: true`, std[key].required, false);
}

// --- and the safety question is NOT declawed --------------------------------

eq('dismissal_method keeps its required flag',
  parseRegFields([row({ standard_key: 'dismissal_method', is_required: true })]).std.dismissal_method.required, true);
eq('dismissal_method optional stays optional',
  parseRegFields([row({ standard_key: 'dismissal_method', is_required: false })]).std.dismissal_method.required, false);

// homeroom_teacher joined the standard keys on 2026-08-31. It belongs with
// dismissal_method rather than with the three above: every enrolled child has a
// homeroom teacher, so a provider may mark it mandatory and j2s's seeded row
// does. Pinned here because the whole point of the change was that the question
// stops depending on instructor_pay_model - if this ever came back optional, the
// asterisk on the live form would keep promising "required" while the button let
// an empty answer through.
eq('homeroom_teacher parses as a standard question, not a custom one',
  parseRegFields([row({ standard_key: 'homeroom_teacher' })]).custom.length, 0);
eq('homeroom_teacher keeps its required flag',
  parseRegFields([row({ standard_key: 'homeroom_teacher', is_required: true })]).std.homeroom_teacher.required, true);
eq('homeroom_teacher optional stays optional',
  parseRegFields([row({ standard_key: 'homeroom_teacher', is_required: false })]).std.homeroom_teacher.required, false);
eq('homeroom_teacher carries the operator label',
  parseRegFields([row({ standard_key: 'homeroom_teacher', label: 'Which classroom?' })]).std.homeroom_teacher.label, 'Which classroom?');

// --- the rest of the shape survived the move --------------------------------

const mixed = parseRegFields([
  row({ standard_key: 'dismissal_method', is_required: true, label: 'How do they go home?', options: { offered: ['bus'] } }),
  row({ field_key: 'allergies', label: 'Allergies?', is_required: true }),
  row({ field_key: 'retired', label: 'Old question', is_active: false }),
]);
eq('the operator label is carried through', mixed.std.dismissal_method.label, 'How do they go home?');
eq('options are carried through, not dropped', mixed.std.dismissal_method.options, { offered: ['bus'] });
eq('custom questions land in custom', mixed.custom.map((c) => c.field_key), ['allergies']);
eq('an inactive custom question is dropped', mixed.custom.length, 1);
eq('a custom question keeps its own is_required', mixed.custom[0].is_required, true);
eq('no rows at all is not a crash', parseRegFields(null), { std: {}, custom: [] });
eq('an undefined row list is not a crash', parseRegFields(undefined), { std: {}, custom: [] });

// --- ONE definition of a named person ---------------------------------------
// The registration form and the parent-portal pickup gate now share this. The
// gate used to accept a first name on its own.

eq('both names is a named person', contactFullyNamed({ first_name: 'Pat', last_name: 'Byron' }), true);
eq('first name alone is NOT', contactFullyNamed({ first_name: 'Grandma', last_name: '' }), false);
eq('last name alone is NOT', contactFullyNamed({ first_name: '', last_name: 'Byron' }), false);
eq('whitespace is not a name', contactFullyNamed({ first_name: 'Pat', last_name: '   ' }), false);
eq('an empty row is not a named person', contactFullyNamed({}), false);
eq('null is not a named person', contactFullyNamed(null), false);

eq('namedContacts keeps only the complete ones',
  namedContacts([{ first_name: 'Pat', last_name: 'Byron' }, { first_name: 'Grandma' }, {}]).length, 1);
eq('namedContacts on a non-array is empty', namedContacts(null), []);

// --- what we SAVE is a different question from what COUNTS ------------------
// These three are verbatim from prod's authorized_pickup table. An earlier draft
// made the strict rule universal and would have told a parent to add a last name
// for an after-school club, with deleting the row as the only way past.

for (const real of ['Club K Teachers', 'Casey Negrieff', 'AINSWORTH AFTERCARE - MOST DAYS']) {
  const row = { first_name: real, last_name: '' };
  eq(`"${real}" is KEPT for saving`, contactsWithAnyName([row]).length, 1);
  eq(`"${real}" does not satisfy a mandatory question`, namedContacts([row]).length, 0);
}

// A row carrying only a surname is kept too - the old first_name-only test threw
// it away, losing what the parent typed.
eq('a surname-only row is kept', contactsWithAnyName([{ first_name: '', last_name: 'Byron' }]).length, 1);
// The pickup list renders one empty placeholder row for every family; it must
// never be saved and must never count.
eq('the empty placeholder row is not saved',
  contactsWithAnyName([{ first_name: '', last_name: '', phone: '' }]).length, 0);
eq('a phone with no name is not saved', contactsWithAnyName([{ phone: '555-0100' }]).length, 0);
eq('whitespace is not a name for saving', contactsWithAnyName([{ first_name: '   ' }]).length, 0);
eq('contactsWithAnyName on a non-array is empty', contactsWithAnyName(null), []);
eq('a complete row is both saved and counted',
  [contactsWithAnyName([{ first_name: 'Pat', last_name: 'Byron' }]).length,
   namedContacts([{ first_name: 'Pat', last_name: 'Byron' }]).length], [1, 1]);

console.log(`\nregistrationFields: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
