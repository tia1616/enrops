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
        // WHO this question is for, carried through for the same reason `options`
        // is below: the row already knows, and dropping it here is what forces
        // the rule to be re-invented in code. 'all' asks everyone; the
        // 'enrollment_type' pair says after-school families or camp families,
        // and only the form knows a child's cart, so the form resolves it.
        appliesTo: r.applies_to ?? 'all',
        appliesToValue: r.applies_to_value ?? null,
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

// ── Who a question is for ────────────────────────────────────────────────────

/**
 * The enrolment kinds a question can be aimed at, with the words the operator
 * reads. ONE list: the picker renders from it and questionAppliesToCart below
 * answers for the same values, so the control cannot offer a scope the rule does
 * not understand — which would silently fall through to "ask everyone".
 */
export const ENROLLMENT_SCOPES = [
  { value: 'afterschool', label: 'After-school only' },
  { value: 'camp', label: 'Camps only' },
];

/**
 * Does a question scoped by enrolment type apply to THIS child's cart?
 *
 * `scope` is the pair carried on the row: applies_to and applies_to_value.
 * Anything not scoped by enrolment type is left alone and returns true — 'all'
 * asks everyone, and a 'program'-scoped row was already resolved by the database
 * against the program the family arrived on.
 *
 * THE CART IS THE SUBJECT, NOT A PROGRAM. A child can hold a camp and a weekly
 * class at once, and the answer differs:
 *   afterschool  asked unless EVERY item is a camp. A mixed cart still asks,
 *                because the class still needs it — under-collecting there puts
 *                the instructor back where the question was added to rescue them.
 *   camp         asked as soon as ANY item is a camp, for the mirror reason: a
 *                question a camp needs must not vanish because a class is beside
 *                it in the cart.
 * An EMPTY cart asks everything: nothing has been chosen to rule a question out,
 * and silently dropping a required question there would block a family with no
 * way to see why.
 */
export function questionAppliesToCart(scope, items, isCamp) {
  if (scope?.appliesTo !== 'enrollment_type') return true;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return true;
  const anyCamp = list.some((it) => isCamp(it));
  const everyCamp = list.every((it) => isCamp(it));
  if (scope.appliesToValue === 'camp') return anyCamp;
  if (scope.appliesToValue === 'afterschool') return !everyCamp;
  // An enrolment type nobody recognises must not silently hide a question the
  // operator believes is on. Fail towards asking.
  return true;
}
