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

// Started but not finished: exactly one of the two names. This is the state
// worth telling a parent about, because it looks answered and is not - and if
// nothing catches it, a one-word contact reaches a dismissal list.
export function contactHalfNamed(c) {
  const first = !!(c?.first_name || '').trim();
  const last = !!(c?.last_name || '').trim();
  return first !== last;
}

// Every fully-named person in a list, in order.
export function namedContacts(list) {
  return (Array.isArray(list) ? list : []).filter(contactFullyNamed);
}

// The first half-filled row in a list, or null. Returns the ROW so callers can
// name the person the parent already typed rather than saying "a row".
export function firstHalfNamedContact(list) {
  return (Array.isArray(list) ? list : []).find(contactHalfNamed) || null;
}

// Whichever name they did type, for use in a sentence.
export function contactDisplayName(c) {
  return `${(c?.first_name || '').trim()} ${(c?.last_name || '').trim()}`.trim();
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
