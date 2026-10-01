// What a camp's day length may BE, versus what the builder OFFERS.
//
// These two were conflated, and an independent review caught it against real
// data: prod has an OPEN camp stored as 'afternoon', a value the picker does
// not offer. Validating it against the offer list made that camp uneditable -
// the select showed blank and the save then refused the only value the row had.
// Run: `node src/lib/campDayLength.test.mjs`
import { CAMP_DAY_LENGTHS, isCampDayLength, campDayLengthOptions } from './campCycle.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// --- isCampDayLength: what the DB may already hold ---
eq('valid: morning', isCampDayLength('morning'), true);
eq('valid: full_day', isCampDayLength('full_day'), true);
// The one the picker does not offer. Pays exactly what morning pays, and a
// live prod camp uses it.
eq('valid: afternoon (stored, not offered)', isCampDayLength('afternoon'), true);
// after_school is the WEEKLY class rate. A camp priced at it is the money bug
// programs.session_type was added to stop, so it must never validate here.
eq('invalid: after_school is never a camp day', isCampDayLength('after_school'), false);
eq('invalid: null', isCampDayLength(null), false);
eq('invalid: undefined', isCampDayLength(undefined), false);
eq('invalid: empty string (the "Choose one..." option)', isCampDayLength(''), false);
eq('invalid: junk', isCampDayLength('half'), false);

// --- campDayLengthOptions: what the select renders ---
eq('options: a normal camp gets the two offered choices',
  campDayLengthOptions('full_day'), CAMP_DAY_LENGTHS);
eq('options: an unset camp gets the two offered choices',
  campDayLengthOptions(null), CAMP_DAY_LENGTHS);
// An afternoon camp must SHOW "Half day" rather than blank, and keep its own
// value so saving an untouched field does not rewrite recorded data.
eq('options: an afternoon camp can render its own value as Half day',
  campDayLengthOptions('afternoon'),
  [{ value: 'afternoon', label: 'Half day' }, { value: 'full_day', label: 'Full day' }]);
// Exactly one "Half day" - two would let the operator pick a value that looks
// identical to the one already selected.
eq('options: afternoon does not produce two Half day choices',
  campDayLengthOptions('afternoon').filter((t) => t.label === 'Half day').length, 1);
// Every rendered option must itself be storable, or the select offers a value
// the save guard would refuse.
eq('options: every offered value is a valid stored value',
  campDayLengthOptions('afternoon').every((t) => isCampDayLength(t.value)), true);
eq('options: every default value is a valid stored value',
  CAMP_DAY_LENGTHS.every((t) => isCampDayLength(t.value)), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
