// Pins the dismissal vocabulary. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// These exist because the vocabulary was written SIX times with two different
// wordings, on the custody path. One definition is only worth anything if it
// stays the definition.
import {
  RELEASED_TO_ADULT, WALKS_OR_BIKES, BUS, AFTERCARE, OTHER,
  DISMISSAL_VALUES, DEFAULT_OFFERED,
  offeredChoices, allChoices,
  dismissalLabel, dismissalParentLabel,
  needsAftercareProvider, needsAuthorizedPickup,
  dismissalSummary,
} from './dismissal.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- the vocabulary must equal the DB constraint ---------------------------
// students_dismissal_method_check, read from prod 2026-08-07:
//   released_to_authorized_adult | walks_or_bikes_home | bus | aftercare | other
// If the UI ever offers a value outside this set, the parent hits a raw
// constraint error mid-checkout with no way past it.
const CHECK_VALUES = ['released_to_authorized_adult', 'walks_or_bikes_home', 'bus', 'aftercare', 'other'];
eq('values match the database CHECK exactly', DISMISSAL_VALUES.slice().sort(), CHECK_VALUES.slice().sort());
eq('every offered choice is a legal value',
  allChoices().every((c) => CHECK_VALUES.includes(c.value)), true);
eq('no duplicate values', new Set(DISMISSAL_VALUES).size, DISMISSAL_VALUES.length);

// --- what a provider gets before they choose -------------------------------
// The two that are already live on prod (35 real answers). Adding the other
// three silently would change a live registration form nobody asked to change.
eq('default is exactly the two already in use', DEFAULT_OFFERED, [RELEASED_TO_ADULT, WALKS_OR_BIKES]);
eq('null options -> the current two', offeredChoices(null).map((c) => c.value), DEFAULT_OFFERED);
eq('undefined options -> the current two', offeredChoices(undefined).map((c) => c.value), DEFAULT_OFFERED);
eq('options with no offered key -> the current two', offeredChoices({}).map((c) => c.value), DEFAULT_OFFERED);

// --- opting in -------------------------------------------------------------
eq('aftercare can be added',
  offeredChoices({ offered: [RELEASED_TO_ADULT, WALKS_OR_BIKES, AFTERCARE] }).map((c) => c.value),
  [RELEASED_TO_ADULT, WALKS_OR_BIKES, AFTERCARE]);
// Order follows the canonical list, not the stored array, so the form reads the
// same for every provider regardless of the order they switched things on.
eq('order is canonical, not stored order',
  offeredChoices({ offered: [AFTERCARE, RELEASED_TO_ADULT] }).map((c) => c.value),
  [RELEASED_TO_ADULT, AFTERCARE]);
// options is operator-editable data; a stale value must not render a radio the
// database will reject.
eq('unknown values are dropped',
  offeredChoices({ offered: [RELEASED_TO_ADULT, 'teleportation'] }).map((c) => c.value),
  [RELEASED_TO_ADULT]);
// A required question with no answers is a checkout that cannot be completed.
eq('all-off falls back rather than rendering nothing',
  offeredChoices({ offered: [] }).map((c) => c.value), DEFAULT_OFFERED);
eq('only-unknown falls back too',
  offeredChoices({ offered: ['nonsense'] }).map((c) => c.value), DEFAULT_OFFERED);

// --- labels ----------------------------------------------------------------
eq('staff label, released', dismissalLabel(RELEASED_TO_ADULT), 'Released to an authorized adult');
eq('staff label, walks', dismissalLabel(WALKS_OR_BIKES), 'Walks or bikes home');
eq('staff label, aftercare', dismissalLabel(AFTERCARE), 'Aftercare');
eq('staff label, bus', dismissalLabel(BUS), 'Bus');
eq('staff label, other', dismissalLabel(OTHER), 'Other');
eq('parent label is the fuller sentence', dismissalParentLabel(RELEASED_TO_ADULT), 'Released to a parent or authorized adult');
eq('parent label, aftercare', dismissalParentLabel(AFTERCARE), 'Goes to aftercare');
// Unset means omit the row, not print "None" at somebody.
eq('null is null, not a label', dismissalLabel(null), null);
eq('empty string is null', dismissalLabel(''), null);
eq('every legal value has a staff label',
  DISMISSAL_VALUES.every((v) => typeof dismissalLabel(v) === 'string' && dismissalLabel(v).length > 0), true);
eq('every legal value has a parent label',
  DISMISSAL_VALUES.every((v) => typeof dismissalParentLabel(v) === 'string' && dismissalParentLabel(v).length > 0), true);
// The bug this guards: four surfaces did `LABELS[v] || v`, so an unmapped value
// printed the raw database string on a custody document.
eq('no legal value renders as its raw database string',
  DISMISSAL_VALUES.every((v) => dismissalLabel(v) !== v), true);

// --- which answer triggers what -------------------------------------------
eq('only aftercare asks who', DISMISSAL_VALUES.filter(needsAftercareProvider), [AFTERCARE]);
eq('only released-to-adult needs the pickup list', DISMISSAL_VALUES.filter(needsAuthorizedPickup), [RELEASED_TO_ADULT]);
eq('walking home does not need a pickup list', needsAuthorizedPickup(WALKS_OR_BIKES), false);
eq('aftercare does not need a pickup list', needsAuthorizedPickup(AFTERCARE), false);

// --- the roster line -------------------------------------------------------
eq('summary is the plain label when no provider applies',
  dismissalSummary({ dismissal_method: RELEASED_TO_ADULT }), 'Released to an authorized adult');
eq('summary carries the aftercare provider',
  dismissalSummary({ dismissal_method: AFTERCARE, aftercare_provider: 'Champions' }), 'Aftercare — Champions');
// "Aftercare" alone tells an instructor nothing about where the child goes, and
// silence reads as "we know" rather than "nobody said".
eq('missing provider is stated, not silent',
  dismissalSummary({ dismissal_method: AFTERCARE }), 'Aftercare (provider not stated)');
eq('blank provider is stated, not silent',
  dismissalSummary({ dismissal_method: AFTERCARE, aftercare_provider: '   ' }), 'Aftercare (provider not stated)');
eq('provider name is trimmed',
  dismissalSummary({ dismissal_method: AFTERCARE, aftercare_provider: '  Champions  ' }), 'Aftercare — Champions');
// A provider name left over from a previous answer must not leak onto a line
// that is no longer about aftercare.
eq('provider is ignored when the answer is not aftercare',
  dismissalSummary({ dismissal_method: WALKS_OR_BIKES, aftercare_provider: 'Champions' }), 'Walks or bikes home');
eq('nothing stated -> null so the caller omits the field', dismissalSummary({}), null);
eq('undefined student -> null', dismissalSummary(undefined), null);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
