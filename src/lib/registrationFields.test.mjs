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
  parseRegFields, contactFullyNamed, contactHalfNamed,
  namedContacts, firstHalfNamedContact, contactDisplayName,
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

// --- half-filled rows, the state that looks answered and is not -------------

eq('first name only is half named', contactHalfNamed({ first_name: 'Grandma' }), true);
eq('last name only is half named', contactHalfNamed({ last_name: 'Byron' }), true);
eq('both names is not half named', contactHalfNamed({ first_name: 'Pat', last_name: 'Byron' }), false);
// An untouched placeholder row must NOT nag - the pickup list renders one by
// default, so treating empty as half-filled would block every family that never
// went near the question.
eq('a wholly empty row is not half named', contactHalfNamed({ first_name: '', last_name: '', phone: '' }), false);
eq('a phone with no names is not half named', contactHalfNamed({ phone: '555-0100' }), false);

eq('namedContacts keeps only the complete ones',
  namedContacts([{ first_name: 'Pat', last_name: 'Byron' }, { first_name: 'Grandma' }, {}]).length, 1);
eq('namedContacts on a non-array is empty', namedContacts(null), []);
eq('firstHalfNamedContact finds the first offender',
  firstHalfNamedContact([{ first_name: 'Pat', last_name: 'Byron' }, { first_name: 'Grandma' }])?.first_name, 'Grandma');
eq('firstHalfNamedContact is null when all are complete',
  firstHalfNamedContact([{ first_name: 'Pat', last_name: 'Byron' }]), null);
eq('firstHalfNamedContact is null on an empty list', firstHalfNamedContact([]), null);

eq('display name uses whichever half was typed', contactDisplayName({ first_name: 'Grandma' }), 'Grandma');
eq('display name joins both', contactDisplayName({ first_name: 'Pat', last_name: 'Byron' }), 'Pat Byron');
eq('display name trims', contactDisplayName({ first_name: ' Pat ', last_name: ' Byron ' }), 'Pat Byron');

console.log(`\nregistrationFields: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
