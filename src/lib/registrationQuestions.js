// WHICH REGISTRATION QUESTIONS A PROVIDER IS ALLOWED TO MAKE MANDATORY.
//
// Some questions cannot be answered by every family, no matter how willing they
// are. "Besides the parent(s), who ELSE may collect your child?" has no answer
// for a family where the answer is nobody. Neither does "anyone we should NOT
// release to?" for a family with no such person, nor "second parent or guardian"
// for a single parent. Marking one of those mandatory does not collect better
// data - it asks a family to invent a person or give up.
//
// That is not hypothetical. On 24 Aug 2026 a parent rang twice because she could
// not finish registering: the pickup question was mandatory, she had nobody else
// to name, and the form would not let her past. Settings had authorized_pickup
// flagged alwaysRequired, so it could not even be switched off from the product -
// the only way out was editing the database by hand, and the next save from the
// Settings screen would have put it back.
//
// So the rule lives here, once, and is applied where the questions are PARSED
// (parseRegFields) rather than at each place that reads them. Everything
// downstream - the asterisk on the label, the wizard's advance guard, the
// parent-portal pickup gate - inherits it without knowing it exists, and a row
// still carrying is_required = true from before this change cannot trap anybody.
//
// Jessica, 25 Aug 2026: "just make it so parents don't have to add another name
// when they don't have another name."

// Questions whose answer is a PERSON the family may simply not have.
const NEVER_REQUIRED = new Set([
  'authorized_pickup',
  'do_not_release',
  'guardian_secondary',
]);

/**
 * May a provider mark this standard question mandatory?
 *
 * `dismissal_method` deliberately still can - and is. It is the safety-critical
 * one, it is a set of radio buttons, and every family can answer it, which is
 * exactly the property the three above lack. Keeping it mandatory is how an
 * instructor knows how a child leaves.
 */
export function canRequireStandardQuestion(standardKey) {
  return !NEVER_REQUIRED.has(standardKey);
}

/**
 * The effective mandatory-ness of a standard question, given what is stored.
 * Stored `true` on a never-required question is treated as `false` rather than
 * corrected in place - reading is where this has to hold, because the database
 * can always be edited by another route.
 */
export function standardQuestionRequired(standardKey, storedIsRequired) {
  return canRequireStandardQuestion(standardKey) && !!storedIsRequired;
}
