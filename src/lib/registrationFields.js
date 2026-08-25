// The registration form's questions and its contact-name rule, as plain data
// functions.
//
// WHY THIS IS NOT IN RegExtraFields.jsx ANY MORE. parseRegFields is where the
// "which questions may be mandatory" rule is applied - the one line that stops
// the 24 Aug wall coming back - and it lived in a .jsx module, which the repo's
// test runner cannot import (scripts/run-src-tests.mjs runs plain node, no JSX
// loader). So the rule itself had a test, and the guard that consumes it had a
// test, and the line joining them had none: a refactor that dropped the
// standardQuestionRequired() call would have left every test green and put the
// wall back on the live form. Moving it here closes that gap.
//
// RegExtraFields.jsx re-exports parseRegFields, so no import site changed.
import { standardQuestionRequired } from './registrationQuestions.js';

// WHAT COUNTS AS A NAMED PERSON, in ONE place.
//
// A pickup or do-not-release contact needs BOTH names. One word is not enough to
// identify somebody at a school door, and it is what the database's own
// overlap check normalises on. The registration form and the parent-portal
// backfill gate used to disagree about this - the gate accepted a first name
// alone - so the same "Grandma" was a complete answer on one screen and an
// incomplete one on the other, on rows that land in the same table.
export function contactFullyNamed(c) {
  return !!(c?.first_name || '').trim() && !!(c?.last_name || '').trim();
}

// Every fully-named person in a list, in order.
export function namedContacts(list) {
  return (Array.isArray(list) ? list : []).filter(contactFullyNamed);
}

// TWO DIFFERENT QUESTIONS, AND THEY MUST NOT SHARE AN ANSWER.
//
// "Does this count as an answer to a mandatory question?" wants both names -
// that is namedContacts above. "What did the parent type, that we must not
// throw away?" is a different question, and answering it with the strict rule
// deletes real data.
//
// A first attempt at this made the strict rule universal and blocked checkout
// until every row had both names. Prod says that is wrong. All three
// single-name authorized_pickup rows on prod read "Club K Teachers",
// "Casey Negrieff" and "AINSWORTH AFTERCARE - MOST DAYS" - an after-school
// club, a full name typed into one box, and a standing instruction. Families
// use this field as free text, and demanding a surname would have told a parent
// to add a last name for a club, with deleting the row as the only way past.
//
// So anything with a name in either box is kept and saved as-is. It simply does
// not, on its own, satisfy a question marked mandatory.
export function contactsWithAnyName(list) {
  return (Array.isArray(list) ? list : []).filter(
    (c) => (c?.first_name || '').trim() || (c?.last_name || '').trim(),
  );
}

// Turn the get_active_registration_fields() rows into a convenient shape.
export function parseRegFields(rows) {
  const std = {};
  const custom = [];
  for (const r of rows || []) {
    if (r.standard_key) {
      // THE ONE PLACE the "can this question be mandatory at all" rule is
      // applied. Questions whose answer is a person a family may not have
      // (pickup, do-not-release, second guardian) come back optional however
      // they are stored - see registrationQuestions.js. Doing it here means the
      // asterisk, the wizard's advance guard and the parent-portal pickup gate
      // all agree without any of them repeating the rule.
      std[r.standard_key] = {
        enabled: true,
        required: standardQuestionRequired(r.standard_key, r.is_required),
        label: r.label,
        // `options` carried through, not dropped. It is a real column on
        // custom_reg_fields and get_active_registration_fields returns the whole
        // row, so the provider's per-question configuration was already arriving
        // here and being thrown away one line before it could be used. That is
        // what kept the dismissal answers hardcoded to two.
        options: r.options ?? null,
      };
    } else if (r.is_active !== false) {
      custom.push(r);
    }
  }
  return { std, custom };
}
