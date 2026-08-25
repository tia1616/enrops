// Pins which registration questions a provider may make mandatory. Repo
// convention: plain node script with a pass/fail counter, run by
// scripts/run-src-tests.mjs.
//
// The case that created this file: on 24 Aug 2026 a parent could not finish
// registering because the pickup question was mandatory and she had nobody else
// to name. The rule that stops that recurring is one line of data, so it gets a
// test that fails loudly if someone adds the key back.
import { canRequireStandardQuestion, standardQuestionRequired } from './registrationQuestions.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- the three questions whose answer is a person you may not have ----------

for (const key of ['authorized_pickup', 'do_not_release', 'guardian_secondary']) {
  eq(`${key} can never be required`, canRequireStandardQuestion(key), false);
  // The point of enforcing this on READ: rows predating 25 Aug 2026 still carry
  // is_required = true (staging j2s and riverbend both did), and editing the
  // database is not the only way a row can get one.
  eq(`${key} ignores a stored true`, standardQuestionRequired(key, true), false);
  eq(`${key} is not required when stored false`, standardQuestionRequired(key, false), false);
}

// --- the safety question that CAN be required, and is -----------------------
// dismissal_method is radio buttons. Every family can answer it, which is
// exactly what the three above cannot promise, so it keeps its asterisk.

eq('dismissal_method can still be required', canRequireStandardQuestion('dismissal_method'), true);
eq('dismissal_method honours a stored true', standardQuestionRequired('dismissal_method', true), true);
eq('dismissal_method honours a stored false', standardQuestionRequired('dismissal_method', false), false);

// --- anything unrecognised is left alone ------------------------------------
// A provider's own custom questions do not come through here at all, and a
// standard key added later must not be silently declawed by this rule.

eq('an unknown key can be required', canRequireStandardQuestion('some_future_question'), true);
eq('undefined is not special-cased into never-required', canRequireStandardQuestion(undefined), true);

// --- truthiness, not just booleans ------------------------------------------
eq('a stored null reads as not required', standardQuestionRequired('dismissal_method', null), false);
eq('a stored undefined reads as not required', standardQuestionRequired('dismissal_method', undefined), false);

console.log(`\nregistrationQuestions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
